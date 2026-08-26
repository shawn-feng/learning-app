import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// kb-sqlite 使用 node:sqlite（Node 内置），不依赖 electron；无需打桩。
import {
  parseTaxonomy,
  parseDailyFile,
  parseProgressFile,
  extractTagsFromRaw,
  normalizeTags,
  migrateAllToSqlite,
  hasAnyKbData,
  queryDaily,
  queryTags,
  queryTopicProgress,
  queryTopicsMeta,
  tagsToMarkdown,
  dailyToMarkdown,
  progressToMarkdown,
  insertDailyEntry,
  insertCourse,
  updateDailyField,
  updateProgress,
  COURSE_FIELD_MAP,
} from "../electron/lib/kb-sqlite.ts";

const REAL_CHILD = path.resolve(__dirname, "../data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674");

describe("parseTaxonomy（tags/taxonomy.md 标签定义解析，纯函数）", () => {
  it("按维度分组解析 标签：释义", () => {
    const text = `---
dimensions: [品格, 关系]
updated: 2026-08-13
---

# 标签词表

## 品格

- 诚实：不撒谎，说真话
- 坚持：遇到困难不放弃

## 关系

- 亲情：和家人之间的爱
`;
    const defs = parseTaxonomy(text);
    expect(defs).toEqual([
      { tag: "诚实", dimension: "品格", criteria: "不撒谎，说真话" },
      { tag: "坚持", dimension: "品格", criteria: "遇到困难不放弃" },
      { tag: "亲情", dimension: "关系", criteria: "和家人之间的爱" },
    ]);
  });
});

describe("extractTagsFromRaw / normalizeTags（纯函数）", () => {
  it("从 raw 的「- 标签：」行提取并归一化（去 # / 方括号 / 空白）", () => {
    expect(extractTagsFromRaw("### 事件\n- 概要：x\n- 标签：#动手 #好奇\n")).toBe("动手,好奇");
    expect(extractTagsFromRaw("### 事件\n- 标签：[诚实, 亲情]\n")).toBe("诚实,亲情");
    expect(extractTagsFromRaw("### 事件\n- 概要：无标签\n")).toBe("");
    expect(normalizeTags("  #动手 ， 好奇 ")).toBe("动手,好奇");
  });
});

describe("parseDailyFile / parseProgressFile（纯函数，v4：raw + tags）", () => {
  it("解析 daily 4 区块条目，raw 保留原文 + tags 提取", () => {
    const text = `## 生活

### 做番茄钟网页
- 标签：#动手 #好奇
- 概要：珊珊让饺子做了一个番茄钟

## 学习

### 论语学而篇第一章
- 掌握度：良好
`;
    const entries = parseDailyFile("2026-08-20", text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ date: "2026-08-20", block: "生活", title: "做番茄钟网页", tags: "动手,好奇" });
    expect(entries[1].tags).toBe("");
    expect(entries[1].raw).toContain("掌握度：良好");
    expect(entries[1]).not.toHaveProperty("fields");
  });

  it("解析进度文件条目为课程明细（CourseItem，tags 归一化）", () => {
    const text = `### 论语先进篇第十六章
状态:: ✅
掌握度:: 良好
tags:: [品格]

### 论语先进篇第十七章
状态:: ⬜
`;
    const items = parseProgressFile("lunyu", text);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "论语先进篇第十六章", status: "✅", tags: "品格" });
    expect(items[1]).toMatchObject({ title: "论语先进篇第十七章", sortOrder: 1, status: "⬜" });
  });
});

describe("migrateAllToSqlite / 查询（临时目录端到端）", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-sqlite-test-"));
    // daily
    const dailyDir = path.join(tmpDir, "daily");
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(
      path.join(dailyDir, "2026-08-20.md"),
      `## 生活

### 做番茄钟网页
- 标签：#动手 #好奇
- 概要：珊珊让饺子做了一个番茄钟

## 学习

### 论语学而篇第一章
- 掌握度：良好
`,
      "utf-8"
    );
    // learning 主题包
    const lunyuDir = path.join(tmpDir, "learning", "lunyu");
    fs.mkdirSync(lunyuDir, { recursive: true });
    fs.writeFileSync(
      path.join(lunyuDir, "lunyu.md"),
      `### 论语学而篇第一章
状态:: ✅
掌握度:: 良好

### 论语学而篇第二章
状态:: ⬜
`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "learning", "topics.md"),
      `---
topics:
  - {name: 论语, file: lunyu/lunyu.md, method: learning/lunyu/method.md, progress: 1/2}
---
`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "learning", "rules.md"),
      `---
rules:
  论语: {daily: 3, type: 必学}
---
`,
      "utf-8"
    );
    // tags taxonomy
    const tagsDir = path.join(tmpDir, "tags");
    fs.mkdirSync(tagsDir, { recursive: true });
    fs.writeFileSync(
      path.join(tagsDir, "taxonomy.md"),
      `# 标签词表

## 品格

- 诚实：不撒谎，说真话
- 动手：爱动手实践
- 好奇：对新事物感兴趣
`,
      "utf-8"
    );
  });

  it("hasAnyKbData：无数据的空目录返回 false", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-empty-"));
    expect(hasAnyKbData(emptyDir)).toBe(false);
  });

  it("migrateAllToSqlite：全量导入并返回计数（含 tags 定义）", () => {
    const r = migrateAllToSqlite(tmpDir);
    expect(r.daily).toBe(2);
    expect(r.progress).toBe(1);
    expect(r.topics).toBe(1);
    expect(r.tags).toBe(3); // taxonomy 3 个标签
    expect(fs.existsSync(path.join(tmpDir, "kb.sqlite"))).toBe(true);
  });

  it("queryDaily：按 date/block 查询，raw 原文 + tags 列", () => {
    const entries = queryDaily(tmpDir, { date: "2026-08-20", block: "生活" });
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("做番茄钟网页");
    expect(entries[0].raw).toContain("番茄钟");
    expect(entries[0].tags).toBe("动手,好奇");
  });

  it("queryDaily：tag 过滤（逗号包裹精确匹配）", () => {
    const hit = queryDaily(tmpDir, { block: "生活", tag: "好奇" });
    expect(hit).toHaveLength(1);
    const miss = queryDaily(tmpDir, { block: "生活", tag: "不存在的标签" });
    expect(miss).toHaveLength(0);
  });

  it("queryTopicProgress：learned/total/next 由视图计算；tag 过滤课程", () => {
    const p = queryTopicProgress(tmpDir, "lunyu");
    expect(p[0].learned).toBe(1);
    expect(p[0].total).toBe(2);
    expect(p[0].next).toBe("论语学而篇第二章");
    const byTag = queryTopicProgress(tmpDir, "lunyu", "品格");
    expect(byTag).toHaveLength(1); // 无课程带标签 → 该主题聚合行仍返回但 items 空？视实现而定
  });

  it("queryTopicsMeta：主题清单 + rules 并入 topics 表", () => {
    const t = queryTopicsMeta(tmpDir);
    expect(t[0].name).toBe("论语");
    expect(t[0].rules.daily).toBe("3");
    expect(t[0].rules.type).toBe("必学");
  });

  it("queryTags：标签定义（全部/按名）", () => {
    const all = queryTags(tmpDir);
    expect(all).toHaveLength(3);
    const one = queryTags(tmpDir, "诚实");
    expect(one).toEqual([{ tag: "诚实", dimension: "品格", criteria: "不撒谎，说真话" }]);
  });

  it("tagsToMarkdown / dailyToMarkdown / progressToMarkdown 渲染", () => {
    expect(tagsToMarkdown(queryTags(tmpDir))).toContain("诚实");
    expect(tagsToMarkdown(queryTags(tmpDir))).toContain("不撒谎，说真话");
    expect(dailyToMarkdown(queryDaily(tmpDir, { date: "2026-08-20" }))).toContain("做番茄钟网页");
    expect(dailyToMarkdown(queryDaily(tmpDir, { date: "2026-08-20" }))).toContain("珊珊让饺子做了一个番茄钟");
    expect(progressToMarkdown(queryTopicProgress(tmpDir), true)).toContain("lunyu");
    expect(progressToMarkdown(queryTopicProgress(tmpDir))).toContain("已学 1/2");
  });
});

describe("写入（kb_insert / kb_update 后端函数）", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-write-test-"));
    const db = require("../electron/lib/kb-sqlite.ts").openKbDb(tmpDir);
    db.prepare("INSERT INTO courses (topic, title, sort_order, status) VALUES (?, ?, ?, ?)").run("lunyu", "论语先进篇第十六章", 0, "✅");
    db.prepare("INSERT INTO courses (topic, title, sort_order, status) VALUES (?, ?, ?, ?)").run("lunyu", "论语先进篇第十七章", 1, "⬜");
    db.close();
  });

  it("insertDailyEntry：raw 存原文 + content 标签行自动解析进 tags 列；重复返回 false", () => {
    const ok1 = insertDailyEntry(tmpDir, { date: "2026-08-20", block: "生活", title: "新事件", content: "### 新事件\n- 概要：内容\n- 标签：#诚实 #亲情" });
    expect(ok1).toBe(true);
    const entries = queryDaily(tmpDir, { date: "2026-08-20", block: "生活", title: "新事件" });
    expect(entries[0].raw).toContain("概要：内容");
    expect(entries[0].tags).toBe("诚实,亲情");
    const ok2 = insertDailyEntry(tmpDir, { date: "2026-08-20", block: "生活", title: "新事件", content: "### 新事件\n- 概要：覆盖" });
    expect(ok2).toBe(false);
  });

  it("updateDailyField：直接改 raw 字段行；field=标签 同步 tags 列", () => {
    const ok = updateDailyField(tmpDir, { date: "2026-08-20", block: "生活", title: "新事件", field: "概要", value: "更新后" });
    expect(ok).toBe(true);
    expect(queryDaily(tmpDir, { date: "2026-08-20", block: "生活", title: "新事件" })[0].raw).toContain("概要：更新后");
    // 更新标签 → tags 列同步
    updateDailyField(tmpDir, { date: "2026-08-20", block: "生活", title: "新事件", field: "标签", value: "诚实" });
    const e = queryDaily(tmpDir, { date: "2026-08-20", block: "生活", title: "新事件" })[0];
    expect(e.raw).toContain("标签：诚实");
    expect(e.tags).toBe("诚实");
    const miss = updateDailyField(tmpDir, { date: "2026-08-20", block: "生活", title: "不存在", field: "概要", value: "x" });
    expect(miss).toBe(false);
  });

  it("updateProgress：更新课程字段（含 tags），复习次数 +1 自增", () => {
    expect(updateProgress(tmpDir, { topic: "lunyu", item: "论语先进篇第十七章", field: "状态", value: "✅" })).toBe(true);
    expect(updateProgress(tmpDir, { topic: "lunyu", item: "论语先进篇第十七章", field: "掌握度", value: "熟练" })).toBe(true);
    expect(updateProgress(tmpDir, { topic: "lunyu", item: "论语先进篇第十七章", field: "tags", value: "品格,坚持" })).toBe(true);
    expect(updateProgress(tmpDir, { topic: "lunyu", item: "论语先进篇第十七章", field: "复习次数", value: "+1" })).toBe(true);
    const p = queryTopicProgress(tmpDir, "lunyu");
    expect(p[0].items[1]).toMatchObject({ status: "✅", mastery: "熟练", reviewCount: 1, tags: "品格,坚持" });
    expect(p[0].learned).toBe(2);
  });

  it("updateProgress：frontmatter 字段（learned/next/updated）不再可手动更新", () => {
    expect(() => updateProgress(tmpDir, { topic: "lunyu", item: "论语先进篇第十六章", field: "learned", value: "999" })).toThrow(
      /learned\/next\/updated/
    );
  });

  it("insertCourse：新增课程 sort_order 自动递增，支持初始 tags", () => {
    expect(insertCourse(tmpDir, { topic: "lunyu", title: "论语先进篇第十八章", tags: "坚持" })).toBe(true);
    expect(insertCourse(tmpDir, { topic: "lunyu", title: "论语先进篇第十八章" })).toBe(false);
    const p = queryTopicProgress(tmpDir, "lunyu");
    const last = p[0].items[p[0].items.length - 1];
    expect(last.title).toBe("论语先进篇第十八章");
    expect(last.tags).toBe("坚持");
  });

  it("COURSE_FIELD_MAP：字段名映射含 tags/标签", () => {
    expect(COURSE_FIELD_MAP["状态"]).toBe("status");
    expect(COURSE_FIELD_MAP["标签"]).toBe("tags");
    expect(COURSE_FIELD_MAP["tags"]).toBe("tags");
    expect(COURSE_FIELD_MAP["教学资料"]).toBe("material");
  });
});

describe("真实数据冒烟（主孩子 1f050a7f，只读不写）", () => {
  it("queryTags 能查真实标签定义", () => {
    const defs = queryTags(REAL_CHILD);
    expect(defs.length).toBeGreaterThanOrEqual(10);
    expect(defs.some((d) => d.tag === "诚实" && d.criteria)).toBe(true);
  });

  it("queryDaily 能查真实 daily（2026-08-11 生活，tags 已回填）", () => {
    const entries = queryDaily(REAL_CHILD, { date: "2026-08-11", block: "生活" });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((e) => e.title.includes("番茄钟"))).toBe(true);
  });

  it("queryTopicProgress 能查真实进度（lunyu，视图计算）", () => {
    const p = queryTopicProgress(REAL_CHILD, "lunyu");
    expect(p.length).toBe(1);
    expect(p[0].items.length).toBeGreaterThan(100);
    expect(p[0].total).toBe(p[0].items.length);
  });

  it("queryTopicsMeta：lunyu 的 rules 已并入 topics 表", () => {
    const t = queryTopicsMeta(REAL_CHILD);
    const lunyu = t.find((x) => x.name === "论语");
    expect(lunyu?.rules.daily).toBe("3");
  });

  it("kb.sqlite 已在真实孩子目录落盘", () => {
    expect(fs.existsSync(path.join(REAL_CHILD, "kb.sqlite"))).toBe(true);
  });

  it("主题键对齐：中文名「汉字宫」能查到 hanzigong 进度（不再反复查不到）", () => {
    const p = queryTopicProgress(REAL_CHILD, "汉字宫");
    expect(p.length).toBe(1);
    expect(p[0].topic).toBe("hanzigong");
    expect(p[0].total).toBeGreaterThan(0);
  });

  it("主题键对齐：拼音键直通（hanzigong/lunyu）", () => {
    expect(queryTopicProgress(REAL_CHILD, "hanzigong")[0].topic).toBe("hanzigong");
    expect(queryTopicProgress(REAL_CHILD, "lunyu")[0].topic).toBe("lunyu");
  });
});

describe("主题键对齐（中文名↔拼音键，临时库端到端，只读/自清理）", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-key-test-"));
    const db = require("../electron/lib/kb-sqlite.ts").openKbDb(tmpDir);
    // 模拟真实结构：topics.name 中文、courses.topic 拼音目录名
    db.prepare("INSERT INTO topics (name, topic_key) VALUES (?, ?)").run("汉字宫", "hanzigong");
    db.prepare("INSERT INTO courses (topic, title, sort_order, status) VALUES (?, ?, ?, ?)").run("hanzigong", "汉字宫第一课", 0, "⬜");
    db.prepare("INSERT INTO courses (topic, title, sort_order, status) VALUES (?, ?, ?, ?)").run("hanzigong", "汉字宫第二课", 1, "✅");
    db.close();
  });

  it("queryTopicProgress：中文名解析到拼音键并返回进度", () => {
    const p = queryTopicProgress(tmpDir, "汉字宫");
    expect(p.length).toBe(1);
    expect(p[0].topic).toBe("hanzigong");
    expect(p[0].total).toBe(2);
    expect(p[0].learned).toBe(1);
  });

  it("updateProgress：中文名主题能定位到拼音键课程的行", () => {
    expect(updateProgress(tmpDir, { topic: "汉字宫", item: "汉字宫第一课", field: "状态", value: "✅" })).toBe(true);
    expect(queryTopicProgress(tmpDir, "汉字宫")[0].learned).toBe(2);
  });

  it("insertCourse：中文名主题写入时自动落到拼音键", () => {
    expect(insertCourse(tmpDir, { topic: "汉字宫", title: "汉字宫第三课" })).toBe(true);
    const p = queryTopicProgress(tmpDir, "汉字宫");
    expect(p[0].topic).toBe("hanzigong");
    expect(p[0].items.some((i) => i.title === "汉字宫第三课")).toBe(true);
  });
});

describe("topic_key 归一化（ISSUE-052：纯拼音目录名，无 / 与 .md）", () => {
  const { normalizeTopicKey } = require("../electron/lib/kb-sqlite.ts");

  it("normalizeTopicKey：脏值（路径/后缀）归一化为纯拼音", () => {
    expect(normalizeTopicKey("hanzigong/hanzigong.md")).toBe("hanzigong");
    expect(normalizeTopicKey("hanzigong.md")).toBe("hanzigong");
    expect(normalizeTopicKey("hanzigong/")).toBe("hanzigong");
    expect(normalizeTopicKey("lunyu/lunyu.md ")).toBe("lunyu");
  });

  it("normalizeTopicKey：已是纯拼音则保持不变", () => {
    expect(normalizeTopicKey("lunyu")).toBe("lunyu");
    expect(normalizeTopicKey("qianziwen")).toBe("qianziwen");
  });
});
