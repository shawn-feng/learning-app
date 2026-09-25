/**
 * KB P1（2026-09-27）：家长侧落库 / 发布 / 风险词表的**校验与不可逆性质**回归。
 *
 * 钉住的是几条"代码强制、不靠模型自觉"的性质：
 * 1. 新建条目**恒为** `draft` + `visibility='parent'`（草稿门 + 默认不给这个孩子看）；
 * 2. `summary` 与资产**至少有一个**（存空条目没有意义，只会在清单里制造噪音）；
 * 3. 挂资产前**必须**校验文件真实存在（不查任何索引表，走 `resolveMaterialFile`）；
 * 4. 改写**已发布**条目的 `summary` → **退回草稿**（不许悄悄换掉正在生效的家长口径）；
 * 5. `summary` 是谁拟的：缺省按"助手整理"（**危险方向不能反**）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openParentLib } from "../server/src/db/parent-lib";
import { materialsRoot } from "../server/src/db/materials";
import {
  getKbEntry,
  listKbAssets,
  listKbEntries,
  listKbGaps,
  listKbSuggestions,
  publishKbEntries,
  saveKbEntries,
  updateRiskTerms,
  KB_RISK_FLOOR,
} from "../server/src/db/kb-entries";
import { createParentKbTools } from "../server/src/agent/parent-kb-tools";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-save-"));
const parentId = "p-kb-save";

const main = openDb(dataDir);
main.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(
  parentId,
  "kb@test",
  new Date().toISOString(),
  new Date().toISOString()
);

const lib = openParentLib(dataDir, parentId);

afterAll(() => {
  try {
    main.close();
  } catch {
    /* 忽略 */
  }
  try {
    lib.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

/** 造两份真实材料（校验"文件必须真实存在"用） */
const root = materialsRoot(dataDir, parentId);
fs.mkdirSync(path.join(root, "preqin", "media"), { recursive: true });
fs.writeFileSync(path.join(root, "preqin", "media", "甲骨文-卜辞拓片.jpg"), "fake-jpg");
fs.writeFileSync(path.join(root, "preqin", "甲骨文.mp4"), "fake-mp4");

const text = (r: any) => (r?.content ?? []).map((c: any) => c.text).join("");

describe("KB P1：落库校验（saveKbEntries）", () => {
  it("没有 summary 也没有资料 → 拒绝（空条目只制造噪音）", () => {
    expect(() => saveKbEntries(lib, dataDir, parentId, [{ title: "空条目", summary: "" }])).toThrow(/至少要有一样/);
  });

  it("没有 title → 拒绝", () => {
    expect(() => saveKbEntries(lib, dataDir, parentId, [{ title: "   " }])).toThrow(/title/);
  });

  it("新建恒为 draft + visibility=parent（两道门都得家长自己开）", () => {
    const [s] = saveKbEntries(lib, dataDir, parentId, [
      { title: "甲骨文", aliases: "卜辞,商朝文字", summary: "商朝人把占卜结果刻在龟甲和兽骨上。", usage: "给她看拓片时展示。" },
    ]);
    expect(s!.created).toBe(true);
    expect(s!.status).toBe("draft");
    expect(s!.visibility).toBe("parent");
    const row = getKbEntry(lib, "甲骨文")!;
    expect(row.status).toBe("draft");
    expect(row.visibility).toBe("parent");
  });

  it("summary 是谁拟的：缺省按「助手整理」，家长原话要显式声明", () => {
    expect(getKbEntry(lib, "甲骨文")!.origin).toBe("generated");
    saveKbEntries(lib, dataDir, parentId, [
      { title: "为什么不能吃太多糖", summary: "糖吃多了牙会疼。", drafted_by: "parent" },
    ]);
    expect(getKbEntry(lib, "为什么不能吃太多糖")!.origin).toBe("manual");
  });

  it("`origin` 描述的是「当前这段 summary 谁写的」：只改 usage 不降级别", () => {
    const base = getKbEntry(lib, "为什么不能吃太多糖")!;
    expect(base.origin).toBe("manual");
    // 说法一字未改、只加了一条 usage → 仍是「家长原话」
    saveKbEntries(lib, dataDir, parentId, [
      { title: "为什么不能吃太多糖", summary: base.summary, usage: "等她换牙之后再说。" },
    ]);
    expect(getKbEntry(lib, "为什么不能吃太多糖")!.origin).toBe("manual");
    // 改了说法、这次没声明作者 → 按缺省算「助手整理」
    saveKbEntries(lib, dataDir, parentId, [
      { title: "为什么不能吃太多糖", summary: `${base.summary}少吃一点牙就不疼。` },
    ]);
    expect(getKbEntry(lib, "为什么不能吃太多糖")!.origin).toBe("generated");
  });

  it("同 title 再存 = 更新那一条，不会新建重复行", () => {
    const before = listKbEntries(lib).length;
    const [s] = saveKbEntries(lib, dataDir, parentId, [{ title: "甲骨文", summary: "商朝人把占卜结果刻在龟甲和兽骨上。" }]);
    expect(s!.created).toBe(false);
    expect(listKbEntries(lib).length).toBe(before);
  });

  it("挂不存在的文件 → 当场报错（防挂空路径）", () => {
    expect(() =>
      saveKbEntries(lib, dataDir, parentId, [{ title: "夏朝到底有没有", summary: "别让她以为夏朝一定是有的。" }], [
        { entry_title: "夏朝到底有没有", path: "preqin/media/根本不存在.jpg" },
      ])
    ).toThrow(/资产文件不存在/);
  });

  it("path 不许绝对、不许 ..（越权与穿越都在这一层拦）", () => {
    for (const bad of ["C:/windows/system32/cmd.exe", "../secrets.txt", "/etc/passwd"]) {
      expect(() =>
        saveKbEntries(lib, dataDir, parentId, [{ title: "越权测试", summary: "x" }], [{ entry_title: "越权测试", path: bad }])
      ).toThrow(/相对路径|不能含/);
    }
  });

  it("文件真实存在 → 挂上；多对多（一条条目多份资料，一份资料可被多条引用）", () => {
    const saved = saveKbEntries(
      lib,
      dataDir,
      parentId,
      [{ title: "甲骨文", summary: "商朝人把占卜结果刻在龟甲和兽骨上。" }],
      [
        { entry_title: "甲骨文", path: "preqin/media/甲骨文-卜辞拓片.jpg", title: "卜辞拓片", seq: 1 },
        { entry_title: "甲骨文", path: "preqin/甲骨文.mp4", seq: 2 },
      ]
    );
    const row = getKbEntry(lib, saved[0]!.id)!;
    expect(row.assetCount).toBe(2);
    expect(listKbAssets(lib, row.id).map((a) => a.path)).toEqual([
      "preqin/media/甲骨文-卜辞拓片.jpg",
      "preqin/甲骨文.mp4",
    ]);
    // 同一份文件挂到另一条条目上（多对多的另一半）
    saveKbEntries(lib, dataDir, parentId, [{ title: "商朝青铜器", summary: "商人会铸很大的鼎。" }], [
      { entry_title: "商朝青铜器", path: "preqin/media/甲骨文-卜辞拓片.jpg" },
    ]);
    expect(getKbEntry(lib, "商朝青铜器")!.assetCount).toBe(1);
  });

  it("`materials/` 前缀与反斜杠会被归一（外部引用语法与 courses.html_path 同语义）", () => {
    saveKbEntries(lib, dataDir, parentId, [{ title: "青铜鼎", summary: "x" }], [
      { entry_title: "青铜鼎", path: "materials\\preqin\\甲骨文.mp4" },
    ]);
    expect(listKbAssets(lib, getKbEntry(lib, "青铜鼎")!.id)[0]!.path).toBe("preqin/甲骨文.mp4");
  });
});

describe("KB P1：发布与撤回（两道门分别开）", () => {
  it("发布 = published + child；撤回只收 visibility，不改 status", () => {
    const id = getKbEntry(lib, "甲骨文")!.id;
    const r = publishKbEntries(lib, [id], "child");
    expect(r.published).toContain("甲骨文");
    expect(getKbEntry(lib, id)!.status).toBe("published");
    expect(getKbEntry(lib, id)!.visibility).toBe("child");

    const w = publishKbEntries(lib, ["甲骨文"], "parent");
    expect(w.withdrawn).toContain("甲骨文");
    const row = getKbEntry(lib, id)!;
    expect(row.visibility).toBe("parent");
    expect(row.status).toBe("published"); // 「审过了，只是不给这个孩子看」是合法状态
  });

  it("没找到的条目如实回报，不静默跳过", () => {
    const r = publishKbEntries(lib, ["根本没这条"], "child");
    expect(r.missing).toEqual(["根本没这条"]);
  });

  it("空 entry_ids → 报错", () => {
    expect(() => publishKbEntries(lib, [], "child")).toThrow(/entry_ids/);
    expect(() => publishKbEntries(lib, ["甲骨文"], "everyone" as any)).toThrow(/visibility/);
  });
});

describe("KB P1：改说法必须重新确认（最重要的一条安全属性）", () => {
  it("已发布条目被改写 summary → 自动退回草稿并标 requalified", () => {
    const id = getKbEntry(lib, "甲骨文")!.id;
    publishKbEntries(lib, [id], "child");
    expect(getKbEntry(lib, id)!.visibility).toBe("child");

    const [s] = saveKbEntries(lib, dataDir, parentId, [
      { title: "甲骨文", summary: "商朝人把占卜结果刻在龟甲和兽骨上，**这种字我们叫甲骨文**。" },
    ]);
    expect(s!.requalified).toBe(true);
    expect(s!.status).toBe("draft");
    const row = getKbEntry(lib, id)!;
    expect(row.status).toBe("draft");
    // visibility 不收：家长再审一次就该照旧给孩子看
    expect(row.visibility).toBe("child");
  });

  it("只改 aliases / usage / tags 不动 summary → 不退回草稿", () => {
    const id = getKbEntry(lib, "甲骨文")!.id;
    publishKbEntries(lib, [id], "child");
    const [s] = saveKbEntries(lib, dataDir, parentId, [
      { title: "甲骨文", summary: "商朝人把占卜结果刻在龟甲和兽骨上，**这种字我们叫甲骨文**。", aliases: "卜辞,商朝文字,龟甲文", usage: "她问「古人怎么写字」时用。" },
    ]);
    expect(s!.requalified).toBe(false);
    expect(getKbEntry(lib, id)!.status).toBe("published");
  });
});

describe("KB P1：家长工具（parent_kb_save / list / publish）", () => {
  const tools: any[] = createParentKbTools({ dataDir, parentId });
  const byName = (n: string) => tools.find((t) => t.name === n)!;

  it("save 落草稿并**明确要求**问家长哪几条可以发布", async () => {
    const out = text(
      await byName("parent_kb_save").execute("s1", {
        entries: [{ title: "她怕黑", aliases: "黑,怕黑", summary: "她怕黑是因为三岁那次停电，别笑她。" }],
      })
    );
    expect(out).toContain("都是草稿，还没给孩子看");
    expect(out).toContain("哪几条现在就可以给她看");
    expect(getKbEntry(lib, "她怕黑")!.status).toBe("draft");
  });

  it("save 支持「字符串化 JSON」参数（ISSUE-133 的兼容层仍然生效）", async () => {
    const out = text(
      await byName("parent_kb_save").execute("s2", {
        entries: JSON.stringify([{ title: "恐龙为什么灭绝", summary: "小行星撞地球。" }]),
      })
    );
    expect(out).toContain("恐龙为什么灭绝");
  });

  it("save 空参数 → 报错（三样至少给一样）", async () => {
    await expect(byName("parent_kb_save").execute("s3", {})).rejects.toThrow(/至少要给/);
  });

  it("save 改动已发布条目时，回话里必须出现「退回草稿」的提醒", async () => {
    publishKbEntries(lib, ["她怕黑"], "child");
    const out = text(
      await byName("parent_kb_save").execute("s4", {
        entries: [{ title: "她怕黑", summary: "她怕黑是因为三岁那次停电——**别再提那件事**。" }],
      })
    );
    expect(out).toContain("退回草稿");
    expect(out).toContain("parent_kb_publish");
  });

  it("list：四个 view 都能用，且条目清单说清「什么样的孩子才查得到」", async () => {
    const entries = text(await byName("parent_kb_list").execute("l1", {}));
    expect(entries).toContain("知识库条目");
    expect(entries).toContain("只有「已发布 + 可以给她看」的条目孩子才查得到");

    const gaps = text(await byName("parent_kb_list").execute("l2", { view: "gaps" }));
    // 先造一条缺口（真实来源是孩子侧 kb_lookup 未命中，这里直接落一行等价数据）
    expect(gaps).toContain("没有待补充的问题");
    lib
      .prepare(
        `INSERT INTO kb_gaps (id, child_id, question, hits_json, high_risk, count, asked_at, status, entry_id)
         VALUES ('g-list', 'c1', '人为什么会死', '[]', 1, 2, ?, 'open', '')`
      )
      .run(new Date().toISOString());
    const gaps2 = text(await byName("parent_kb_list").execute("l2b", { view: "gaps" }));
    expect(gaps2).toContain("孩子问了、库里没接住的问题");
    expect(gaps2).toContain("高风险");
    expect(gaps2).toContain("问了 2 次");

    const sug = text(await byName("parent_kb_list").execute("l3", { view: "suggestions" }));
    expect(sug).toContain("家庭口径域");
    expect(sug).toContain("别一次全建");
    // 条数钉死：文档 §5.4.3 与技能文案都引用了这个总量，改种子清单必须同步改文档。
    // （2026-09-27 拿真实老库副本跑建表验证时才发现文档写的是 44、实际是 42——就是这条断言要防的事。）
    const seed = listKbSuggestions(lib);
    expect(new Set(seed.map((s) => s.domain)).size).toBe(11);
    expect(seed.length).toBe(42);

    const risk = text(await byName("parent_kb_list").execute("l4", { view: "risk" }));
    expect(risk).toContain("底线词（关不掉）");
    expect(risk).toContain("自杀");
  });

  it("publish：可传精确标题；发布回话要点明「孩子以后听到的是家长的说法」", async () => {
    const out = text(await byName("parent_kb_publish").execute("p1", { entry_ids: ["她怕黑"], visibility: "child" }));
    expect(out).toContain("已发布");
    expect(out).toContain("孩子现在问到时就会按这些说");
  });

  it("publish：撤回不需要确认，回话简短", async () => {
    const out = text(await byName("parent_kb_publish").execute("p2", { entry_ids: ["她怕黑"], visibility: "parent" }));
    expect(out).toContain("已撤回");
    expect(getKbEntry(lib, "她怕黑")!.visibility).toBe("parent");
  });

  it("save 的 risk_terms：加词生效；关底线词被拒并如实说明", async () => {
    const out = text(
      await byName("parent_kb_save").execute("r1", { risk_terms: { add: [{ term: "星座", note: "家里不谈这个" }], remove: ["自杀"] } })
    );
    expect(out).toContain("已加入：星座");
    expect(out).toContain("没关掉（底线词）");
    expect(out).toContain("自伤风险");
    const rows = listKbEntries(lib);
    expect(rows.length).toBeGreaterThan(0); // 条目没被这次调用影响
  });
});

describe("KB P1：缺口队列（孩子问了没接住的）", () => {
  it("高危在前、反复问的在前，并区分「完全没建」与「建了没匹配上」", () => {
    const now = new Date().toISOString();
    lib
      .prepare(
        `INSERT INTO kb_gaps (id, child_id, question, hits_json, high_risk, count, asked_at, status, entry_id)
         VALUES ('g1', 'c1', '人为什么会死', '[]', 1, 3, ?, 'open', ''),
                ('g2', 'c1', '恐龙有多少种', '[{"id":"e1","title":"恐龙"}]', 0, 9, ?, 'open', '')`
      )
      .run(now, now);
    const rows = listKbGaps(lib, { status: "open" });
    expect(rows[0]!.high_risk).toBe(1); // 高危优先，即使次数少
    const g2 = rows.find((r) => r.id === "g2")!;
    expect(JSON.parse(g2.hits_json)[0].title).toBe("恐龙"); // 「建了但没匹配上」= aliases 没写全
  });
});

describe("KB P1：风险词表底线与家长层的边界", () => {
  it("底线词是固定集合，且都在词表里显示为不可关", () => {
    expect(KB_RISK_FLOOR.map((f) => f.term)).toEqual(["自杀", "自残", "死", "去世", "身体", "亲嘴", "打我", "欺负"]);
  });

  it("家长自己加的词的 note 不会被 seed 覆盖；关掉再打开能恢复", () => {
    updateRiskTerms(lib, { add: [{ term: "零花钱", note: "只讲怎么花，不讲数目" }] });
    updateRiskTerms(lib, { remove: ["零花钱"] });
    updateRiskTerms(lib, { add: [{ term: "零花钱" }] });
    const row = (lib.prepare("SELECT note, enabled FROM kb_risk_terms WHERE term = ?").get("零花钱") as {
      note: string;
      enabled: number;
    })!;
    expect(row.enabled).toBe(1);
    expect(row.note).toBe("只讲怎么花，不讲数目");
  });
});
