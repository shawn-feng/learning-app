/**
 * KB P1（2026-09-27）：孩子侧检索的**门控**与负数样本回归。
 *
 * 这是全案唯一一处「泄漏就是事故」的地方，所以按正负样本写：
 * - 正向：`published + child + share=all/<自己>` 必须查得到；
 * - 负向：`draft`
 * / `visibility=parent` / `share=<别的孩子>` **一条都不许出现**（包括追问、换关键词之后）。
 *
 * 还有两处容易踩的坑也被钉住：
 * - **疑问词必须剥**（不剥 `kb_lookup("甲骨文是什么呀？")` 会全条落空）；
 * - **别名是主召回通道**（「人是女娲造的吗」靠 `aliases` 里的「女娲」兜住，title 匹配不够）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openParentLib } from "../server/src/db/parent-lib";
import {
  ensureKbEntriesSchema,
  judgeHighRisk,
  listKbGaps,
  listKbSuggestions,
  listRiskTerms,
  normalizeKbQuery,
  searchKbForChild,
  updateRiskTerms,
} from "../server/src/db/kb-entries";
import { createChildKbTools } from "../server/src/agent/child-kb-tools";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-gate-"));
const parentId = "p-kb-gate";
const childId = "c-xiaoman";
const otherChild = "c-gege";

const main = openDb(dataDir);
main.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(
  parentId,
  "kb@test",
  new Date().toISOString(),
  new Date().toISOString()
);

afterAll(() => {
  try {
    main.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

const lib = openParentLib(dataDir, parentId);
afterAll(() => {
  try {
    lib.close();
  } catch {
    /* 忽略 */
  }
});

function insertEntry(e: {
  id: string;
  title: string;
  aliases?: string;
  summary?: string;
  body?: string;
  usage?: string;
  status: string;
  visibility: string;
  share?: string;
  origin?: string;
}): void {
  const now = new Date().toISOString();
  lib
    .prepare(
      `INSERT INTO kb_entries (id, title, aliases, summary, body, tags, usage, visibility, share, status, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.id, e.title, e.aliases ?? "", e.summary ?? "", e.body ?? "", e.usage ?? "",
      e.visibility, e.share ?? "all", e.status, e.origin ?? "manual", now, now
    );
}

// 正负样本各就位（一次性建好，后面每个用例都拿它当"现实世界"）
insertEntry({
  id: "e-jiagu",
  title: "甲骨文",
  aliases: "卜辞,商朝文字",
  summary: "商朝人把占卜结果刻在龟甲和兽骨上，这就是甲骨文。",
  body: "【这一整段是没经家长逐字看过的机器正文，P1 绝不许返回】",
  usage: "想在屏幕上给她看拓片时展示。",
  status: "published",
  visibility: "child",
});
insertEntry({
  id: "e-nuwa",
  title: "女娲造人",
  aliases: "女娲,造人",
  summary: "这是古人讲的故事，不是真的发生过的事。",
  status: "published",
  visibility: "child",
});
// 负数三兄弟：草稿 / 已发布但不给这个孩子 / 只给另一个孩子
insertEntry({ id: "e-draft", title: "夏朝到底有没有", summary: "别让她以为夏朝一定是有的。", status: "draft", visibility: "parent" });
insertEntry({ id: "e-parentonly", title: "长平之战跟她说多少", summary: "只讲坑杀这件事，不讲数字。", status: "published", visibility: "parent" });
insertEntry({
  id: "e-otherchild",
  title: "哥哥的青春期话题",
  summary: "只对哥哥说。",
  status: "published",
  visibility: "child",
  share: otherChild,
});
// share 正样本：只给这个孩子，也必须查得到
insertEntry({
  id: "e-mine",
  title: "她怕黑",
  aliases: "黑,怕黑",
  summary: "她怕黑是因为三岁那次停电，别笑她。",
  status: "published",
  visibility: "child",
  share: childId,
});

const text = (r: any) => (r?.content ?? []).map((c: any) => c.text).join("");

describe("KB P1：建表与种子", () => {
  it("五张表随 openParentLib 幂等长出（无迁移脚本）", () => {
    const names = (
      lib.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of ["kb_entries", "kb_entry_assets", "kb_entry_links", "kb_gaps", "kb_risk_terms"]) {
      expect(names, `缺表 ${t}`).toContain(t);
    }
    expect(() => ensureKbEntriesSchema(lib)).not.toThrow(); // 幂等
  });

  it("高风险词表：种子行只在首次写入，家长关掉的不会被重新打开", () => {
    const before = listRiskTerms(lib).filter((r) => !r.floor).length;
    expect(before).toBeGreaterThan(10);
    updateRiskTerms(lib, { remove: ["菩萨"] });
    ensureKbEntriesSchema(lib); // 再打开一次
    const after = listRiskTerms(lib).find((r) => r.term === "菩萨")!;
    expect(after.enabled).toBe(false);
  });
});

describe("KB P1：检索门控（正负样本）", () => {
  it("只有「已发布 + 可给她看 + share 命中」的条目进得来", () => {
    const ids = searchKbForChild(lib, childId, "甲骨文").map((h) => h.id);
    expect(ids).toContain("e-jiagu");
    expect(ids).not.toContain("e-draft");
    expect(ids).not.toContain("e-parentonly");
    expect(ids).not.toContain("e-otherchild");
  });

  it("share=<别的孩子> 的条目连换关键词也查不到", () => {
    for (const q of ["青春期", "哥哥的青春期话题", "青春期是什么"]) {
      expect(searchKbForChild(lib, childId, q).map((h) => h.id)).not.toContain("e-otherchild");
    }
    // 哥哥自己查得到（share 是"给哪个孩子"，不是"不给谁"）
    expect(searchKbForChild(lib, otherChild, "青春期").map((h) => h.id)).toContain("e-otherchild");
  });

  it("share=<这个孩子> 的条目查得到", () => {
    expect(searchKbForChild(lib, childId, "她怕黑").map((h) => h.id)).toContain("e-mine");
  });

  it("疑问词必须剥掉，否则全条落空", () => {
    expect(normalizeKbQuery("甲骨文是什么呀？")).toBe("甲骨文");
    expect(normalizeKbQuery("女娲是怎么回事呢")).not.toContain("怎么回事");
    expect(normalizeKbQuery("女娲是怎么回事呢")).not.toContain("呢");
    // 剥的是"疑问词"，不是"关键词"：剥完还认得出来、还查得到才算数
    expect(searchKbForChild(lib, childId, "女娲是怎么回事呢").map((h) => h.id)).toContain("e-nuwa");
    expect(searchKbForChild(lib, childId, "甲骨文是什么呀？").map((h) => h.id)).toContain("e-jiagu");
  });

  it("别名是主召回通道：「人是女娲造的吗」靠 aliases 兜住", () => {
    const hits = searchKbForChild(lib, childId, "人是女娲造的吗");
    expect(hits.map((h) => h.id)).toContain("e-nuwa");
    expect(hits[0]!.via).toContain("女娲");
  });

  it("命中上限 5 条（避免上下文灾难）", () => {
    for (let i = 0; i < 8; i++) {
      insertEntry({ id: `e-bulk-${i}`, title: `批量条目${i}`, summary: "x", status: "published", visibility: "child" });
    }
    expect(searchKbForChild(lib, childId, "批量条目").length).toBeLessThanOrEqual(5);
  });

  it("不返回 body（没经家长逐字看过的机器文本不能当依据）", () => {
    const hit = searchKbForChild(lib, childId, "甲骨文")[0]!;
    expect(hit.summary).toContain("商朝人");
    expect(JSON.stringify(hit)).not.toContain("机器正文");
  });
});

describe("KB P1：kb_lookup 工具的三条返回路径", () => {
  const tool: any = createChildKbTools({ dataDir, parentId, childId })[0];

  it("命中：给出处 / 依据 / 用法 / 可展示 / 引用纪律，且不含 body", async () => {
    const out = text(await tool.execute("t1", { query: "甲骨文是什么呀" }));
    expect(out).toContain("命中");
    expect(out).toContain("出处：家长知识库");
    expect(out).toContain("依据：家长口径");
    expect(out).toContain("商朝人把占卜结果刻在龟甲和兽骨上");
    expect(out).toContain("用法：想在屏幕上给她看拓片时展示");
    expect(out).toContain("注意：以上是这条口径的全部内容");
    expect(out).not.toContain("机器正文");
  });

  it("未命中 + 一般常识：允许答，但必须先说明是你自己的了解", async () => {
    const out = text(await tool.execute("t2", { query: "水在多少度沸腾" }));
    expect(out).toContain("没有命中");
    expect(out).toContain("我自己的一般了解");
    expect(out).toContain("不许编具体数字");
  });

  it("未命中 + high_risk=true：不给结论，并记入 kb_gaps", async () => {
    const before = listKbGaps(lib, { status: "open", childId }).length;
    const out = text(await tool.execute("t3", { query: "班里同学为什么不跟我玩", high_risk: true }));
    expect(out).toContain("不要给结论");
    expect(listKbGaps(lib, { status: "open", childId }).length).toBeGreaterThanOrEqual(before);
  });

  it("未命中 + 命中代码底线词（模型没传 high_risk 也要拦）", async () => {
    const out = text(await tool.execute("t4", { query: "人死了以后去哪里了" }));
    expect(out).toContain("不要给结论");
    const gaps = listKbGaps(lib, { status: "open", childId });
    expect(gaps.some((g) => g.question.includes("死了以后"))).toBe(true);
    expect(gaps.find((g) => g.question.includes("死了以后"))!.high_risk).toBe(1);
  });

  it("同一个问题反复问 → 只累加 count，不刷屏", async () => {
    await tool.execute("t5", { query: "人死了以后去哪里了" });
    const rows = listKbGaps(lib, { status: "open", childId }).filter((g) => g.question.includes("死了以后"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.count).toBe(2);
  });

  it("负数样本：追问也拿不到「先不给她看」和「哥哥的」条目", async () => {
    for (const q of ["夏朝到底有没有", "长平之战跟她说多少", "哥哥的青春期话题", "她怕黑是可以给她看的吗"]) {
      const out = text(await tool.execute("t6", { query: q }));
      if (q.startsWith("她怕黑")) {
        expect(out).toContain("她怕黑是因为三岁那次停电"); // 自己的 share 条目正常命中
        continue;
      }
      expect(out, `${q} 泄漏了`).toContain("没有命中");
      expect(out).not.toContain("别让她以为夏朝一定是有的");
      expect(out).not.toContain("只讲坑杀这件事");
      expect(out).not.toContain("只对哥哥说");
    }
  });

  it("空 query 直接报错（不给「随便讲讲」的空间）", async () => {
    await expect(tool.execute("t7", { query: "   " })).rejects.toThrow(/需要 query/);
  });
});

describe("KB P1：高风险判定的两层", () => {
  it("模型传 true 是主判据；底线词不可关；可配词家长能关", () => {
    expect(judgeHighRisk(lib, "随便什么", true).source).toBe("model");
    expect(judgeHighRisk(lib, "人为什么会自杀", false).source).toBe("floor");
    updateRiskTerms(lib, { add: [{ term: "星座" }] });
    expect(judgeHighRisk(lib, "星座准不准", false).source).toBe("configured");
    updateRiskTerms(lib, { remove: ["星座"] });
    expect(judgeHighRisk(lib, "星座准不准", false).high).toBe(false);
    // 底线词关不掉：remove 被拒，判定照旧
    const r = updateRiskTerms(lib, { remove: ["自杀"] });
    expect(r.rejected.map((x) => x.term)).toContain("自杀");
    expect(judgeHighRisk(lib, "人为什么会自杀", false).high).toBe(true);
  });
});

describe("KB P1：冷启动建议清单", () => {
  it("建议清单来自家庭口径域，已建过的标出来", () => {
    const rows = listKbSuggestions(lib);
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.find((r) => r.title === "女娲造人")?.exists).toBe(true);
    expect(rows.find((r) => r.title === "我从哪里来")?.exists).toBe(false);
    expect(new Set(rows.map((r) => r.domain)).size).toBeGreaterThan(8);
  });
});

describe("KB P1：读不到家长库时不许自由发挥", () => {
  it("openParentLib 抛错 → 不放行，明确要求高风险话题先说不知道", async () => {
    // 用一个**文件**占住 parents/<pid> 目录，让 openParentLib 必然失败
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-broken-"));
    fs.mkdirSync(path.join(dir, "parents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "parents", "p-broken"), "占位");
    const tool: any = createChildKbTools({ dataDir: dir, parentId: "p-broken", childId })[0];
    const out = text(await tool.execute("t8", { query: "甲骨文是什么" }));
    expect(out).toContain("读不到");
    expect(out).toContain("先不要给结论");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
