/**
 * KB P2（2026-09-27）：**陪学线路的推送通道**回归。
 *
 * P1 的两条路是「孩子问了才查」（`kb_lookup`，拉取）。P2 加的是第二条：**一进课条目就在手里**
 * （`courseContextBlock` 注入，推送）。推送比拉取更硬——模型会把它当成"家长已经定了的事"直接讲，
 * 所以这份测试的重心不是"能不能绑上"，而是**门是不是和拉取那条一样严**。
 *
 * 钉住四条性质：
 * 1. **三条绑定不变式**：课程真实存在 / 只能绑 `published` / 只能绑 `visibility='child'`；
 * 2. **读取时再门控一次**：绑上之后家长撤回或改回草稿，注入必须**立刻**跟着停
 *    （只看"绑定时校验过"等于只挡了第一秒）；
 * 3. R-1 引用检查认识 `kb_entry_assets.path`，且**不套门控**（草稿条目的引用也算引用）；
 * 4. PDF 已进 `display_content` 白名单（P1 曾以"自定义 scheme 不保证渲染"为由拒绝，P2 实测推翻）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { materialsRoot } from "../server/src/db/materials";
import {
  KB_COURSE_LIMIT,
  bindEntryToCourse,
  listEntryBriefsForCourse,
  listKbEntries,
  publishKbEntries,
  saveKbEntries,
} from "../server/src/db/kb-entries";
import { createParentKbTools, PARENT_KB_TOOL_NAMES } from "../server/src/agent/parent-kb-tools";
import { buildCourseKbLines } from "../server/src/agent/session-registry";
import { displayKindOf } from "../server/src/agent/display-tool";
import { findMaterialReferences, type FsCtx } from "../server/src/routes/fs";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-p2-"));
const parentId = "p-kb-p2";
const childId = "c-kb-p2";
const otherChildId = "c-kb-p2-other";

const main = openDb(dataDir);
const nowIso = new Date().toISOString();
main
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "kbp2@test", nowIso, nowIso);
for (const [id, name] of [
  [childId, "小满"],
  [otherChildId, "小弟"],
] as const) {
  main
    .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(id, parentId, name, nowIso, nowIso);
}

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

// 真实材料（R-1 要 stat、注入要列"可展示"）
const root = materialsRoot(dataDir, parentId);
fs.mkdirSync(path.join(root, "preqin", "media"), { recursive: true });
fs.writeFileSync(path.join(root, "preqin", "media", "甲骨文-卜辞拓片.jpg"), "fake-jpg");
fs.writeFileSync(path.join(root, "preqin", "media", "商朝青铜器.mp4"), "fake-mp4");

// 课程真源（家长库 courses PK = (topic, title)）
lib.prepare("INSERT INTO topics (name, topic_key) VALUES (?, ?)").run("先秦", "preqin");
lib.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 1)").run("preqin", "第一课 夏商周");
lib.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 2)").run("preqin", "第二课 秦汉");
// 顺序用例独占一节干净课，才能断言绝对 seq（别的用例也在往 T1 上挂东西）
lib.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 3)").run("preqin", "第三课 盛唐");

const T1 = "第一课 夏商周";
const text = (r: any) => (r?.content ?? []).map((c: any) => c.text).join("");
const linkRows = (entryId: string) =>
  lib.prepare("SELECT topic, course, seq FROM kb_entry_links WHERE entry_id = ?").all(entryId) as Array<{
    topic: string;
    course: string;
    seq: number;
  }>;

/** 造一条条目并直接推到指定状态（省掉每个用例重复的 save+publish 噪音） */
function makeEntry(title: string, opts?: { summary?: string; share?: string; assets?: string[] }): string {
  const [saved] = saveKbEntries(
    lib,
    dataDir,
    parentId,
    [{ title, summary: opts?.summary ?? `${title} 的说法`, share: opts?.share }],
    (opts?.assets ?? []).map((p) => ({ entry_title: title, path: p }))
  );
  return saved.id;
}
function publishToChild(title: string): void {
  publishKbEntries(lib, [title], "child");
}

describe("KB P2：绑定三条不变式（bindEntryToCourse）", () => {
  it("课程不存在 → 拒绝，并把该主题下真实存在的课程名回给模型（不让它猜第二遍）", () => {
    const id = makeEntry("课程不存在用例");
    expect(() =>
      bindEntryToCourse(lib, [id], { topic: "preqin", course: "第九课 不存在的课" })
    ).toThrow(/课程不存在/);
    expect(() => bindEntryToCourse(lib, [id], { topic: "preqin", course: "第九课 不存在的课" })).toThrow(
      /第一课 夏商周/
    );
    expect(linkRows(id)).toHaveLength(0);
  });

  it("不变式 2：草稿条目**挂不上**（没确认过的话不许进课堂）", () => {
    const id = makeEntry("草稿条目");
    const r = bindEntryToCourse(lib, [id], { topic: "preqin", course: T1 });
    expect(r.bound).toHaveLength(0);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0].why).toMatch(/草稿/);
    expect(linkRows(id)).toHaveLength(0);
  });

  it("不变式 3：已发布但「先不给她看」的条目**挂不上**（挂上去等于绕过这道门）", () => {
    const id = makeEntry("撤回过的条目");
    publishToChild("撤回过的条目");
    publishKbEntries(lib, ["撤回过的条目"], "parent"); // 只收 visibility，status 仍是 published
    const r = bindEntryToCourse(lib, [id], { topic: "preqin", course: T1 });
    expect(r.bound).toHaveLength(0);
    expect(r.refused[0].why).toMatch(/先不给她看/);
    expect(linkRows(id)).toHaveLength(0);
  });

  it("已发布 + 给她看 → 挂上，落链接行，seq 从 1 开始", () => {
    const id = makeEntry("甲骨文");
    publishToChild("甲骨文");
    const r = bindEntryToCourse(lib, [id], { topic: "preqin", course: T1 });
    expect(r.bound).toEqual(["甲骨文"]);
    expect(linkRows(id)).toEqual([{ topic: "preqin", course: T1, seq: 1 }]);
  });

  it("**上架顺序即上课顺序**：第一条 seq=1、第二条接在最后 seq=2", () => {
    const C = "第三课 盛唐"; // 独占一节干净课，别的用例不会往这上面挂
    const a = makeEntry("顺序-先挂的");
    const b = makeEntry("顺序-后挂的");
    publishToChild("顺序-先挂的");
    publishToChild("顺序-后挂的");
    bindEntryToCourse(lib, [a], { topic: "preqin", course: C });
    bindEntryToCourse(lib, [b], { topic: "preqin", course: C });
    expect(linkRows(a)[0].seq).toBe(1);
    expect(linkRows(b)[0].seq).toBe(2);
  });

  it("显式 seq 覆盖默认追加", () => {
    const id = makeEntry("显式顺序");
    publishToChild("显式顺序");
    bindEntryToCourse(lib, [id], { topic: "preqin", course: "第二课 秦汉", seq: 7 });
    expect(linkRows(id)[0].seq).toBe(7);
  });

  it("seq 非法 → 报错（不静默写成 0）", () => {
    const id = makeEntry("坏 seq");
    publishToChild("坏 seq");
    expect(() => bindEntryToCourse(lib, [id], { topic: "preqin", course: T1, seq: NaN })).toThrow(/seq 必须是数字/);
  });

  it("重挂同一条 → 幂等（不产生第二行，也不报错）", () => {
    const id = makeEntry("幂等条目");
    publishToChild("幂等条目");
    bindEntryToCourse(lib, [id], { topic: "preqin", course: T1 });
    bindEntryToCourse(lib, [id], { topic: "preqin", course: T1 });
    expect(linkRows(id)).toHaveLength(1);
  });

  it("同一条能同时挂在两节课上（多对多）", () => {
    const id = makeEntry("跨课条目");
    publishToChild("跨课条目");
    bindEntryToCourse(lib, [id], { topic: "preqin", course: T1 });
    bindEntryToCourse(lib, [id], { topic: "preqin", course: "第二课 秦汉" });
    expect(linkRows(id)).toHaveLength(2);
  });

  it("unbind → 行删掉（绑错了要能摘，否则错挂是永久的）", () => {
    const id = makeEntry("摘下来的条目");
    publishToChild("摘下来的条目");
    bindEntryToCourse(lib, [id], { topic: "preqin", course: T1 });
    const r = bindEntryToCourse(lib, [id], { topic: "preqin", course: T1, unbind: true });
    expect(r.unbound).toEqual(["摘下来的条目"]);
    expect(linkRows(id)).toHaveLength(0);
  });

  it("找不到的 key 如实报 missing，不静默跳过", () => {
    const r = bindEntryToCourse(lib, ["根本不存在的标题"], { topic: "preqin", course: T1 });
    expect(r.missing).toEqual(["根本不存在的标题"]);
    expect(r.bound).toHaveLength(0);
  });
});

describe("KB P2：注入读取（listEntryBriefsForCourse）——读取时**再门控一次**", () => {
  it("绑上就能读到：带 title/summary/usage/资料与类型", () => {
    const title = "注入-带资料";
    const id = makeEntry(title, {
      summary: "商朝人把占卜结果刻在龟甲上",
      assets: ["preqin/media/甲骨文-卜辞拓片.jpg"],
    });
    lib.prepare("UPDATE kb_entries SET usage = ? WHERE id = ?").run("先给她看拓片，再讲占卜", id);
    publishToChild(title);
    bindEntryToCourse(lib, [id], { topic: "preqin", course: T1 });

    const briefs = listEntryBriefsForCourse(lib, "preqin", T1, childId);
    const hit = briefs.find((b) => b.id === id)!;
    expect(hit.summary).toMatch(/龟甲/);
    expect(hit.usage).toMatch(/拓片/);
    expect(hit.assets.map((a) => a.path)).toEqual(["preqin/media/甲骨文-卜辞拓片.jpg"]);
    expect(hit.assets[0].kind).toBe("图片");
  });

  it("资料类型从扩展名现算：视频（**不落库、不查字段**）", () => {
    const title = "注入-视频";
    const id = makeEntry(title, { assets: ["preqin/media/商朝青铜器.mp4"] });
    publishToChild(title);
    bindEntryToCourse(lib, [id], { topic: "preqin", course: T1 });
    const hit = listEntryBriefsForCourse(lib, "preqin", T1, childId).find((b) => b.id === id)!;
    expect(hit.assets[0].kind).toBe("视频");
  });

  it("**绑上之后家长撤回 → 注入立刻停**（这是「读时再门控」的核心用例）", () => {
    const title = "注入-会被撤回";
    const id = makeEntry(title);
    publishToChild(title);
    bindEntryToCourse(lib, [id], { topic: "preqin", course: T1 });
    expect(listEntryBriefsForCourse(lib, "preqin", T1, childId).map((b) => b.id)).toContain(id);

    publishKbEntries(lib, [title], "parent"); // 撤回：链接行不动
    expect(linkRows(id)).toHaveLength(1); // 行还在——证明拦住它的**不是**行没了
    expect(listEntryBriefsForCourse(lib, "preqin", T1, childId).map((b) => b.id)).not.toContain(id);
  });

  it("**绑上之后改说法 → 退回草稿 → 注入立刻停**（改 summary 的安全属性在推送这条路上同样生效）", () => {
    const title = "注入-会被改写";
    const id = makeEntry(title, { summary: "原来的说法" });
    publishToChild(title);
    bindEntryToCourse(lib, [id], { topic: "preqin", course: T1 });
    expect(listEntryBriefsForCourse(lib, "preqin", T1, childId).map((b) => b.id)).toContain(id);

    saveKbEntries(lib, dataDir, parentId, [{ id, title, summary: "被人悄悄改过的说法" }]);
    expect(listEntryBriefsForCourse(lib, "preqin", T1, childId).map((b) => b.id)).not.toContain(id);
  });

  it("share 门控与 kb_lookup 同源：只给别的孩子看的条目，这个孩子注入不到", () => {
    const title = "注入-share 限定";
    const id = makeEntry(title, { share: otherChildId });
    publishToChild(title);
    bindEntryToCourse(lib, [id], { topic: "preqin", course: T1 });
    expect(listEntryBriefsForCourse(lib, "preqin", T1, childId).map((b) => b.id)).not.toContain(id);
    expect(listEntryBriefsForCourse(lib, "preqin", T1, otherChildId).map((b) => b.id)).toContain(id);
  });

  it("没绑过 / 课不存在 → 空数组（**绝不编造课程条目**）", () => {
    expect(listEntryBriefsForCourse(lib, "preqin", "第九课 不存在", childId)).toEqual([]);
    expect(listEntryBriefsForCourse(lib, "", T1, childId)).toEqual([]);
  });

  it(`一节课最多注入 ${KB_COURSE_LIMIT} 条（防御性上限，家长真挂 50 条也别把 prompt 撑爆）`, () => {
    // 独占一节课，避免污染上面的用例
    for (let i = 0; i < KB_COURSE_LIMIT + 3; i++) {
      const title = `上限-${i}`;
      const id = makeEntry(title);
      publishToChild(title);
      bindEntryToCourse(lib, [id], { topic: "preqin", course: "第二课 秦汉" });
    }
    const briefs = listEntryBriefsForCourse(lib, "preqin", "第二课 秦汉", childId);
    expect(briefs.length).toBe(KB_COURSE_LIMIT);
  });
});

describe("KB P2：家长工具 parent_kb_bind", () => {
  const tools: any[] = createParentKbTools({ dataDir, parentId });
  const byName = (n: string) => tools.find((t) => t.name === n)!;

  it("四把工具都在（save / list / publish / bind）", () => {
    expect(PARENT_KB_TOOL_NAMES).toEqual(["parent_kb_save", "parent_kb_list", "parent_kb_publish", "parent_kb_bind"]);
    expect(tools.map((t) => t.name).sort()).toEqual([...PARENT_KB_TOOL_NAMES].sort());
  });

  it("topic 可以给中文名（resolveTopicKey 归一为目录名）", async () => {
    const title = "中文主题名";
    await byName("parent_kb_save").execute("s1", { entries: [{ title, summary: "说法" }] });
    await byName("parent_kb_publish").execute("p1", { entry_ids: [title], visibility: "child" });
    const out = text(await byName("parent_kb_bind").execute("b1", { entry_ids: [title], topic: "先秦", course: T1 }));
    expect(out).toMatch(/已挂到/);
    const row = lib.prepare("SELECT topic FROM kb_entry_links WHERE course = ? AND topic = ?").get(T1, "preqin");
    expect(row).toBeTruthy();
  });

  it("被拒时必须说清原因与下一步（不许糊成「挂好了」）", async () => {
    const title = "拒绝要说清";
    await byName("parent_kb_save").execute("s2", { entries: [{ title, summary: "说法" }] });
    const out = text(await byName("parent_kb_bind").execute("b2", { entry_ids: [title], topic: "preqin", course: T1 }));
    expect(out).toMatch(/没挂上/);
    expect(out).toMatch(/草稿/);
    expect(out).toMatch(/parent_kb_publish/);
  });

  it("缺 topic / course / entry_ids → 报错，不做静默空调用", async () => {
    await expect(byName("parent_kb_bind").execute("b3", { entry_ids: ["x"], course: T1 })).rejects.toThrow(/topic/);
    await expect(byName("parent_kb_bind").execute("b4", { entry_ids: ["x"], topic: "preqin" })).rejects.toThrow(/course/);
    await expect(byName("parent_kb_bind").execute("b5", { topic: "preqin", course: T1 })).rejects.toThrow(/entry_ids/);
  });

  it("action=unbind 摘下来", async () => {
    const title = "工具摘下来";
    await byName("parent_kb_save").execute("s3", { entries: [{ title, summary: "说法" }] });
    await byName("parent_kb_publish").execute("p3", { entry_ids: [title], visibility: "child" });
    await byName("parent_kb_bind").execute("b6", { entry_ids: [title], topic: "preqin", course: T1 });
    const out = text(
      await byName("parent_kb_bind").execute("b7", { entry_ids: [title], topic: "preqin", course: T1, action: "unbind" })
    );
    expect(out).toMatch(/摘下来/);
  });

  it("parent_kb_list 会显示「已挂课」——绑定不是只写的，家长和助手都要能核对", async () => {
    const title = "清单要显示挂课";
    await byName("parent_kb_save").execute("s4", { entries: [{ title, summary: "说法" }] });
    await byName("parent_kb_publish").execute("p4", { entry_ids: [title], visibility: "child" });
    await byName("parent_kb_bind").execute("b8", { entry_ids: [title], topic: "preqin", course: T1 });
    const out = text(await byName("parent_kb_list").execute("l1", { query: title }));
    expect(out).toMatch(/已挂课/);
    expect(out).toMatch(new RegExp(`preqin/${T1}`));
    // 数据面同源
    expect(listKbEntries(lib, { query: title })[0].links).toContain(`preqin/${T1}`);
  });
});

describe("KB P2：R-1 引用检查认识知识条目的资料", () => {
  const ctx: FsCtx = { dataDir, db: main, parentId, childId: null };

  it("kb_entry_assets.path 命中 → source=kb（**草稿条目也算引用**）", () => {
    // 独占文件：证明"命中"来自这条**草稿**，而不是别的已发布条目
    fs.writeFileSync(path.join(root, "preqin", "media", "只有草稿要的.jpg"), "fake-jpg");
    const title = "R1-草稿条目";
    makeEntry(title, { assets: ["preqin/media/只有草稿要的.jpg"] }); // 恒为 draft
    const refs = findMaterialReferences(ctx, "preqin/media/只有草稿要的.jpg");
    const kbHits = refs.filter((r) => r.source === "kb");
    expect(kbHits).toHaveLength(1);
    expect(kbHits[0].detail).toContain(title);
    expect(kbHits[0].detail).toContain("草稿");
  });

  it("目录级删除按前缀命中（父目录被知识条目引用时也拦得住）", () => {
    const refs = findMaterialReferences(ctx, "preqin/media");
    expect(refs.map((r) => r.source)).toContain("kb");
  });

  it("没被任何条目引用的文件 → 不产生 kb 命中（不误报）", () => {
    fs.writeFileSync(path.join(root, "preqin", "没人要的.txt"), "x");
    const refs = findMaterialReferences(ctx, "preqin/没人要的.txt");
    expect(refs.filter((r) => r.source === "kb")).toHaveLength(0);
  });
});

describe("KB P2：PDF 进展示白名单（P1 偏差② 撤回）", () => {
  it("displayKindOf 认得 .pdf，且大小写不敏感", () => {
    expect(displayKindOf("preqin/资料/甲骨文.pdf")).toBe("pdf");
    expect(displayKindOf("preqin/资料/甲骨文.PDF")).toBe("pdf");
  });

  it("其它格式仍然拒绝（白名单没有被顺手放宽）", () => {
    expect(displayKindOf("preqin/资料/讲义.docx")).toBeNull();
    expect(displayKindOf("preqin/资料/压缩包.zip")).toBeNull();
  });
});

describe("KB P2：进课注入的实际文本（buildCourseKbLines）", () => {
  it("有绑定 → 段落标题带「回答以这些为准」+ 编号 + 说法 + 可展示路径 + 什么时候给她看", () => {
    const C = "注入文本课";
    lib.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 9)").run("preqin", C);
    const title = "注入文本-甲骨文";
    const id = makeEntry(title, { summary: "商朝人把占卜结果刻在龟甲上", assets: ["preqin/media/甲骨文-卜辞拓片.jpg"] });
    lib.prepare("UPDATE kb_entries SET usage = ? WHERE id = ?").run("先看拓片", id);
    publishToChild(title);
    bindEntryToCourse(lib, [id], { topic: "preqin", course: C });

    const lines = buildCourseKbLines(lib, "preqin", C, childId);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("本课知识条目");
    // P2.1 措辞：原来写「回答以这些为准」，实测里模型会理解成"被问到才引用"——
    // 改成「讲到相关话题时以这些为准」并显式说明"不必主动一条条念"，把两种误读一次堵掉。
    expect(lines[0]).toContain("讲到相关话题时以这些为准");
    expect(lines[0]).toContain("不必主动一条条念");
    expect(lines[0]).toContain("不许自己补");
    const body = lines[1];
    expect(body).toMatch(/^ {2}1\. /); // 编号 + 缩进（进 prompt 后与其它 "- 字段" 区分开）
    expect(body).toContain(title);
    expect(body).toContain("龟甲");
    expect(body).toContain("什么时候给她看：先看拓片");
    expect(body).toContain("可展示：preqin/media/甲骨文-卜辞拓片.jpg（图片）");
  });

  it("没绑过 → 空数组（**不产生一个空段落**污染 prompt）", () => {
    lib.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 10)").run("preqin", "没有条目的课");
    expect(buildCourseKbLines(lib, "preqin", "没有条目的课", childId)).toEqual([]);
  });

  it("说法过长 → 截到 300 字带省略号（预算纪律，长内容留在条目里让 kb_lookup 取）", () => {
    const C = "超长说法课";
    lib.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 11)").run("preqin", C);
    const title = "注入文本-超长";
    const id = makeEntry(title, { summary: "甲".repeat(500) });
    publishToChild(title);
    bindEntryToCourse(lib, [id], { topic: "preqin", course: C });
    const body = buildCourseKbLines(lib, "preqin", C, childId)[1];
    expect(body).toContain("…");
    expect(body.length).toBeLessThan(360);
    expect(body).not.toContain("甲".repeat(301));
  });

  it("只有资料没有说法的条目也能注入（材料类条目的 value 全在资产上）", () => {
    const C = "只有资料的课";
    lib.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 12)").run("preqin", C);
    const title = "注入文本-只有资料";
    const id = makeEntry(title, { summary: "", assets: ["preqin/media/商朝青铜器.mp4"] });
    publishToChild(title);
    bindEntryToCourse(lib, [id], { topic: "preqin", course: C });
    const lines = buildCourseKbLines(lib, "preqin", C, childId);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(title);
    expect(lines[1]).toContain("商朝青铜器.mp4（视频）");
    expect(lines[1]).not.toContain(" — "); // 没说法就不留一个空破折号
  });
});

describe("KB P2：孩子库一行都没动", () => {
  it("kb_entry_links 等五张表只在家长库（孩子库不该出现它们）", () => {
    const kb = openKb(dataDir, parentId, childId);
    try {
      const names = (
        kb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
      ).map((r) => r.name);
      for (const t of ["kb_entries", "kb_entry_assets", "kb_entry_links", "kb_gaps", "kb_risk_terms"]) {
        expect(names).not.toContain(t);
      }
    } finally {
      kb.close();
    }
  });
});
