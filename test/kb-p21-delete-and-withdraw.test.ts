/**
 * KB P2.1（2026-09-25）：两个实测缺陷的回归。
 *
 * ## 缺陷 1：条目删不掉
 * 全仓唯一的 `DELETE FROM` 是解绑链接用的，`kb_entries` **没有任何删除路径**——
 * 家长说「这条建错了，删掉」，助手只能撤回，永远清不掉。
 *
 * ## 缺陷 2：撤回对"正在进行的会话"无效
 * `kb_lookup` 的门控是**读时**判的，所以撤回对下一次查询立刻生效；
 * 但孩子的会话**带着历史**——实测撤回后同一个会话里再问，孩子仍然说得出原话
 * （那一轮**没有任何 kb_lookup 调用**，答案是模型从历史里复述的）。
 * **门控管得住"查得到查不到"，管不住"还记得不记得"。**
 *
 * 钉住：删除的不变式与连带清理、缺口重新打开、撤回计数的窗口，以及注入扩展的**两个条件**
 * （只在真有撤回时注入 / **不注入被撤回条目的标题**）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openParentLib } from "../server/src/db/parent-lib";
import { materialsRoot } from "../server/src/db/materials";
import {
  countWithdrawn,
  deleteKbEntries,
  getKbEntry,
  listKbAssets,
  listKbGaps,
  publishKbEntries,
  recordKbGap,
  saveKbEntries,
  withdrawStamp,
} from "../server/src/db/kb-entries";
import { createKbWithdrawNoticeExtension } from "../server/src/agent/kb-withdraw-notice";
import { createParentKbTools } from "../server/src/agent/parent-kb-tools";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-p21-"));
const parentId = "p-kb-p21";
const childId = "c-kb-p21";

const main = openDb(dataDir);
const now = new Date().toISOString();
main.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(parentId, "p21@test", now, now);
main.prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(childId, parentId, "娃", now, now);

const lib = openParentLib(dataDir, parentId);

afterAll(() => {
  for (const close of [() => main.close(), () => lib.close()]) {
    try {
      close();
    } catch {
      /* 忽略 */
    }
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

const root = materialsRoot(dataDir, parentId);
fs.mkdirSync(path.join(root, "preqin", "media"), { recursive: true });
fs.writeFileSync(path.join(root, "preqin", "media", "图.jpg"), "fake-jpg");

lib.prepare("INSERT INTO topics (name, topic_key) VALUES (?, ?)").run("先秦", "preqin");
lib.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 1)").run("preqin", "第一课");

const text = (r: any) => (r?.content ?? []).map((c: any) => c.text).join("");

function makeDraft(title: string, assets: string[] = []): string {
  const [saved] = saveKbEntries(
    lib,
    dataDir,
    parentId,
    [{ title, summary: `${title} 的说法` }],
    assets.map((p) => ({ entry_title: title, path: p }))
  );
  return saved.id;
}

describe("KB P2.1：deleteKbEntries —— 删得掉、但不可逆的动作排在可逆的后面", () => {
  it("草稿能删，行真的没了", () => {
    const id = makeDraft("删我-草稿");
    const r = deleteKbEntries(lib, [id]);
    expect(r.deleted).toEqual(["删我-草稿"]);
    expect(getKbEntry(lib, id)).toBeUndefined();
  });

  it("已撤回（published + parent）的也能删", () => {
    makeDraft("删我-已撤回");
    publishKbEntries(lib, ["删我-已撤回"], "child");
    publishKbEntries(lib, ["删我-已撤回"], "parent");
    const r = deleteKbEntries(lib, ["删我-已撤回"]);
    expect(r.deleted).toEqual(["删我-已撤回"]);
  });

  it("**还给孩子看着的不许删**（这是本功能的唯一不变式）——而且行必须还在", () => {
    const id = makeDraft("删我-孩子看着");
    publishKbEntries(lib, [id], "child");
    const r = deleteKbEntries(lib, [id]);
    expect(r.deleted).toHaveLength(0);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0].why).toMatch(/先撤回/);
    expect(getKbEntry(lib, id)).toBeTruthy(); // 被拒就是没动
  });

  it("**这一条证明了「先撤回再删」是可行的两步**：撤回后同一个 id 就能删掉", () => {
    const id = makeDraft("删我-两步");
    publishKbEntries(lib, [id], "child");
    expect(deleteKbEntries(lib, [id]).refused).toHaveLength(1);
    publishKbEntries(lib, [id], "parent"); // 第一步：撤回（可逆）
    expect(deleteKbEntries(lib, [id]).deleted).toEqual(["删我-两步"]); // 第二步：删（不可逆）
  });

  it("精确标题也能删（模型更容易拿到标题）", () => {
    makeDraft("删我-按标题");
    expect(deleteKbEntries(lib, ["删我-按标题"]).deleted).toEqual(["删我-按标题"]);
  });

  it("找不到的如实报 missing，不静默跳过", () => {
    const r = deleteKbEntries(lib, ["根本没有这条"]);
    expect(r.missing).toEqual(["根本没有这条"]);
    expect(r.deleted).toHaveLength(0);
  });

  it("空数组/空字符串 → 报错（不做静默空调用）", () => {
    expect(() => deleteKbEntries(lib, [])).toThrow(/需要条目 id 或精确标题/);
    expect(() => deleteKbEntries(lib, ["  "])).toThrow(/需要条目 id 或精确标题/);
  });

  it("**连带清理**：kb_entry_assets 与 kb_entry_links 的行一起走（表间没有外键）", () => {
    const id = makeDraft("删我-带资料", ["preqin/media/图.jpg"]);
    expect(listKbAssets(lib, id)).toHaveLength(1);
    lib.prepare("INSERT INTO kb_entry_links (entry_id, topic, course, seq) VALUES (?, 'preqin', '第一课', 1)").run(id);
    deleteKbEntries(lib, [id]);
    expect(listKbAssets(lib, id)).toHaveLength(0);
    expect(lib.prepare("SELECT COUNT(*) n FROM kb_entry_links WHERE entry_id = ?").get(id)).toEqual({ n: 0 });
  });

  it("**缺口重新打开**：答案被销毁 → 那个问题重新是「没人回答的问题」，不留「已闭环」的假象", () => {
    const id = makeDraft("删我-闭环过的");
    publishKbEntries(lib, [id], "parent");
    recordKbGap(lib, childId, "贝壳为什么会响？", false, []);
    // 模拟家长补完口径后回填 entry_id（闭环）
    lib.prepare("UPDATE kb_gaps SET entry_id = ?, status = 'resolved' WHERE question = ?").run(id, "贝壳为什么会响？");
    expect(listKbGaps(lib, { status: "open" }).some((g) => g.question === "贝壳为什么会响？")).toBe(false);

    deleteKbEntries(lib, [id]);
    const gap = listKbGaps(lib, { status: "open" }).find((g) => g.question === "贝壳为什么会响？");
    expect(gap, "删掉条目后缺口必须回到 open").toBeTruthy();
    expect(gap!.entry_id).toBe("");
  });
});

describe("KB P2.1：countWithdrawn —— 只用来判断「要不要注入复核纪律」", () => {
  it("没有任何撤回 → 0", () => {
    // 用一个干净的家长库，避免受上面用例影响
    expect(countWithdrawn(lib, 14)).toBe(0);
  });

  it("撤回一条 → 计数 +1（published + visibility=parent 才算）", () => {
    const id = makeDraft("计数-撤回一条");
    publishKbEntries(lib, [id], "child");
    expect(countWithdrawn(lib, 14)).toBe(0); // 还给孩子看着，不算撤回
    publishKbEntries(lib, [id], "parent");
    expect(countWithdrawn(lib, 14)).toBe(1);
  });

  it("**草稿不算撤回**（孩子从没见过，没有「收回来」这回事）", () => {
    const before = countWithdrawn(lib, 14);
    makeDraft("计数-只是草稿");
    expect(countWithdrawn(lib, 14)).toBe(before);
  });

  it("窗口之外的老撤回不算（防噪音：三个月前的事孩子不会还在当前会话里提）", () => {
    const id = makeDraft("计数-很久以前");
    publishKbEntries(lib, [id], "child");
    publishKbEntries(lib, [id], "parent");
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    lib.prepare("UPDATE kb_entries SET updated_at = ? WHERE id = ?").run(old, id);
    expect(countWithdrawn(lib, 14)).toBe(1); // 上一条 14 天内的仍在
    const fresh = countWithdrawn(lib, 1);
    expect(fresh).toBeLessThanOrEqual(1);
    // 90 天前那条在任何窗口 ≥ 1 天里都不该被它自己贡献
    expect(countWithdrawn(lib, 30)).toBe(1);
  });
});

describe("KB P2.1：每轮注入的复核纪律（kb-withdraw-notice）", () => {
  /** 假 pi：把 handler 抓出来直接调 */
  function grab(deps: { dataDir: string; parentId: string; sinceDays?: number }) {
    const handlers: Record<string, (e: any) => Promise<any>> = {};
    const pi = { on: (ev: string, fn: any) => (handlers[ev] = fn) };
    createKbWithdrawNoticeExtension(deps)(pi);
    return handlers["before_agent_start"]!;
  }

  it("**没有撤回时不注入**（每轮都变的 system prompt 会让前缀缓存全失效——这是 learning-guard 记下的教训）", async () => {
    // 用一个全新的家长库来测"没有撤回"：本文件上面的用例已经造过撤回，同一个库测不出来
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-p21-fresh-"));
    try {
      const run = grab({ dataDir: freshDir, parentId: "p-fresh", sinceDays: 14 });
      const r = await run({ systemPrompt: "原始提示词" });
      expect(r).toBeUndefined();
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("有撤回时注入，且**追加**在原文之后（`systemPrompt` 是整段替换，不是 append）", async () => {
    const run = grab({ dataDir, parentId, sinceDays: 14 });
    const r = await run({ systemPrompt: "原始提示词" });
    expect(r?.systemPrompt).toMatch(/^原始提示词/);
    expect(r?.systemPrompt).toMatch(/撤回过说法/);
    expect(r?.systemPrompt).toMatch(/kb_lookup/);
    expect(r?.systemPrompt).toMatch(/从现在起不要再讲/);
    expect(r?.systemPrompt).toMatch(/不许再重复/);
  });

  it("**同时插一条消息**（位置在用户提问之后 = 注意力最近；实测只靠 system prompt 后缀压不住）", async () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-p21-msg-"));
    try {
      const lib2 = openParentLib(freshDir, "p-msg");
      // 造一条"审过但收回"的条目 → 指纹有值
      saveKbEntries(lib2, freshDir, "p-msg", [{ title: "讲过的说法", summary: "家长原话在这里" }]);
      publishKbEntries(lib2, ["讲过的说法"], "child");
      publishKbEntries(lib2, ["讲过的说法"], "parent");
      lib2.close();

      const handlers: Record<string, (e: any) => Promise<any>> = {};
      createKbWithdrawNoticeExtension({ dataDir: freshDir, parentId: "p-msg", sinceDays: 14 })({
        on: (ev: string, fn: any) => (handlers[ev] = fn),
      });
      const run = handlers["before_agent_start"]!;

      const first = await run({ systemPrompt: "S" });
      expect(first?.message?.customType).toBe("kb-withdraw-notice");
      expect(first?.message?.content).toMatch(/不要再重复/);
      expect(first?.message?.content).toMatch(/kb_lookup/);
      expect(first?.message?.display).toBe(false); // 不给孩子看到这条系统提醒

      // 指纹没变 → **不再重复插**（否则每轮都塞一条，把会话撑满）
      const second = await run({ systemPrompt: "S" });
      expect(second?.message).toBeUndefined();
      expect(second?.systemPrompt).toMatch(/撤回过说法/); // 但 system prompt 那条纪律每轮都在
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("**指纹变了要再插一条**（会话开着时家长又撤了一条）", async () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-p21-stamp-"));
    try {
      const lib2 = openParentLib(freshDir, "p-stamp");
      saveKbEntries(lib2, freshDir, "p-stamp", [{ title: "第一条", summary: "说法一" }]);
      publishKbEntries(lib2, ["第一条"], "child");
      publishKbEntries(lib2, ["第一条"], "parent");

      const handlers: Record<string, (e: any) => Promise<any>> = {};
      createKbWithdrawNoticeExtension({ dataDir: freshDir, parentId: "p-stamp", sinceDays: 14 })({
        on: (ev: string, fn: any) => (handlers[ev] = fn),
      });
      const run = handlers["before_agent_start"]!;

      expect((await run({ systemPrompt: "S" }))?.message).toBeTruthy();
      expect((await run({ systemPrompt: "S" }))?.message).toBeUndefined(); // 指纹没变

      // 又撤一条（updated_at 必须与上一条不同 → 指纹才变）
      saveKbEntries(lib2, freshDir, "p-stamp", [{ title: "第二条", summary: "说法二" }]);
      publishKbEntries(lib2, ["第二条"], "child");
      await new Promise((r) => setTimeout(r, 5));
      publishKbEntries(lib2, ["第二条"], "parent");
      lib2.close();

      expect((await run({ systemPrompt: "S" }))?.message).toBeTruthy(); // 指纹变了 → 再插
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("**注入文本里不许出现被撤回条目的标题**（system prompt 与消息都要干净）", async () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-p21-leak-"));
    try {
      const lib2 = openParentLib(freshDir, "p-leak");
      saveKbEntries(lib2, freshDir, "p-leak", [{ title: "教师用书上怎么说的", summary: "家长口径" }]);
      publishKbEntries(lib2, ["教师用书上怎么说的"], "child");
      publishKbEntries(lib2, ["教师用书上怎么说的"], "parent");
      lib2.close();

      const handlers: Record<string, (e: any) => Promise<any>> = {};
      createKbWithdrawNoticeExtension({ dataDir: freshDir, parentId: "p-leak", sinceDays: 14 })({
        on: (ev: string, fn: any) => (handlers[ev] = fn),
      });
      const r = await handlers["before_agent_start"]!({ systemPrompt: "" });
      expect(r?.systemPrompt ?? "").not.toContain("教师用书上怎么说的");
      expect(JSON.stringify(r?.message ?? {})).not.toContain("教师用书上怎么说的");
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("读库出问题也不抛（这条纪律是加分项，不能挡住一轮对话）", async () => {
    const run = grab({ dataDir: path.join(dataDir, "no-such-dir"), parentId: "nobody", sinceDays: 14 });
    await expect(run({ systemPrompt: "x" })).resolves.toBeUndefined();
  });
});

describe("KB P2.1：家长工具上的删除出口", () => {
  const tools: any[] = createParentKbTools({ dataDir, parentId });
  const byName = (n: string) => tools.find((t) => t.name === n)!;

  it("parent_kb_save 的 delete 参数能删掉草稿，并说明「没法恢复」", async () => {
    await byName("parent_kb_save").execute("s1", { entries: [{ title: "工具删我", summary: "说法" }] });
    const out = text(await byName("parent_kb_save").execute("s2", { delete: ["工具删我"] }));
    expect(out).toMatch(/已删掉/);
    expect(out).toMatch(/没法恢复/);
    expect(getKbEntry(lib, "工具删我")).toBeUndefined();
  });

  it("还给孩子看着的 → 回话必须给出「先撤回再删」这条下一步，不许说成删了", async () => {
    await byName("parent_kb_save").execute("s3", { entries: [{ title: "工具删我-在给孩子看", summary: "说法" }] });
    await byName("parent_kb_publish").execute("p1", { entry_ids: ["工具删我-在给孩子看"], visibility: "child" });
    const out = text(await byName("parent_kb_save").execute("s4", { delete: ["工具删我-在给孩子看"] }));
    expect(out).toMatch(/没删/);
    expect(out).toMatch(/先撤回/);
    expect(out).toMatch(/parent_kb_publish/);
    expect(getKbEntry(lib, "工具删我-在给孩子看")).toBeTruthy();
  });

  it("四个参数一个都不给 → 报错（报错文案要把 delete 也列上）", async () => {
    await expect(byName("parent_kb_save").execute("s5", {})).rejects.toThrow(/delete/);
  });
});
