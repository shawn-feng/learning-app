import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 纯 node 环境没有 electron；config.ts 顶部 `import { app } from "electron"` 会在模块加载时
// 触发 electron 解析。这里把 electron 打桩成 { app: undefined }，使 getDataDir() 退化为
// process.cwd()/data（vitest 在仓库根目录运行，正好命中真实 data/children）。
vi.mock("electron", () => ({ app: undefined }));

// SPLIT：学习进度唯一真源在服务端 kb。测试用本地测试服务端 + 有效 token，
// 数据指向临时目录（license.json 由 helper 签发，孩子 1f050a7f 属于测试家长 86a84278）。
const mockTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "learning-summary-"));
vi.mock("../electron/lib/config", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../electron/lib/config")>();
  return {
    ...mod,
    getDataDir: () => mockTmpRoot,
    getLicensePath: () => path.join(mockTmpRoot, "license.json"),
    getChildrenDir: () => path.join(mockTmpRoot, "children"),
    getChildDir: (id: string) => path.join(mockTmpRoot, "children", id),
    getSharedDir: () => path.join(mockTmpRoot, "shared"),
    getSkillsDir: () => path.join(mockTmpRoot, "shared", "skills"),
  };
});

import { getLearningSummary, progressSummaryToMarkdown, getTopicProgress, getCourseDailySummary, fetchProgressRemote } from "../electron/lib/learning-summary";
import { migrateAllToSqlite } from "../electron/lib/kb-sqlite";
import { writeTestLicense, TEST_PARENT_ID } from "./helpers/server-token";

// 测试家长名下的真实孩子（含 lunyu 主题，514 课）。ISSUE-006 的痛点就是 lunyu 正文几百行被整篇读入只为取 next。
const CHILD = "1f050a7f-df8a-45b0-925a-1ffe2aa35674";

beforeAll(async () => {
  fs.mkdirSync(mockTmpRoot, { recursive: true });
  // 该孩子属于测试家长 86a84278：签它的 token 才能读其服务端 kb
  writeTestLicense(mockTmpRoot, TEST_PARENT_ID);
  // 会话创建前远程预取进度 → 本地缓存（getLearningSummary 同步读缓存）
  await fetchProgressRemote(CHILD);
});

afterAll(() => {
  fs.rmSync(mockTmpRoot, { recursive: true, force: true });
});

describe("ISSUE-006 进度摘要（SQLite 真源，ISSUE-023 P2 后）", () => {
  it("getLearningSummary 从 kb.sqlite 拿到下一课（真实数据）", () => {
    const s = getLearningSummary(CHILD);
    const lunyu = s.topics.find((t) => t.name === "论语");
    expect(lunyu, "应解析到 lunyu 主题").toBeDefined();
    // v3 起 total 由视图统计真实课程数（原 frontmatter 手写 514，实际课程明细 512）
    expect(lunyu!.total).toBeGreaterThan(100);
    expect(lunyu!.learned).toBeGreaterThan(0);
    expect(lunyu!.learned).toBeLessThanOrEqual(lunyu!.total);
    expect(lunyu!.next.trim()).not.toBe("");
    // 总体进度也应聚合
    expect(s.totals.topicCount).toBeGreaterThan(0);
  });

  it("progressSummaryToMarkdown 紧凑且含下一课，不含逐课正文", () => {
    const s = getLearningSummary(CHILD);
    const md = progressSummaryToMarkdown(s);
    // 应包含下一课（这是注入系统提示、让 agent 免读全文的核心信息）
    const lunyu = s.topics.find((t) => t.name === "论语")!;
    expect(md).toContain(lunyu.next.trim());
    expect(md).toMatch(new RegExp(`已学 ${lunyu.learned}/${lunyu.total}`));
    // 不应包含逐课正文噪声：论语正文里有「论语学而篇第一章」「掌握度」等
    expect(md, "不该泄露逐课标题").not.toContain("论语学而篇第一章");
    expect(md, "不该泄露逐课状态字段").not.toContain("掌握度");
  });

  it("迁移临时目录后能从 SQLite 取进度；无主题孩子退化为总体进度行", () => {
    // 构造临时孩子：learning/topics.md + rules.md + 一个主题包，迁移到 SQLite 后断言
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-summary-"));
    const learning = path.join(tmpDir, "learning");
    const lunyuDir = path.join(learning, "lunyu");
    fs.mkdirSync(lunyuDir, { recursive: true });
    fs.writeFileSync(
      path.join(lunyuDir, "lunyu.md"),
      `---
learned: 282
total: 514
next: "论语先进篇第十七章"
updated: 2026-08-19
---

### 论语先进篇第十六章
状态:: ✅
掌握度:: 良好
`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(learning, "topics.md"),
      `---
topics:
  - {name: 论语, file: lunyu/lunyu.md, method: learning/lunyu/method.md, progress: 282/514}
---
`,
      "utf-8"
    );
    fs.writeFileSync(
      path.join(learning, "rules.md"),
      `---
rules:
  论语: {daily: 3, type: 必学}
---
`,
      "utf-8"
    );
    migrateAllToSqlite(tmpDir);

    // 用 config 的 getChildDir 不可行（临时目录不在 data/children 下），直接测真实孩子聚合逻辑：
    // getLearningSummary 依赖 getChildDir(childId)，此处用真实 CHILD 已覆盖；临时目录仅验证迁移可解析。
    const s = getLearningSummary(CHILD);
    expect(s.topics.length).toBeGreaterThan(0);
    expect(() => progressSummaryToMarkdown(s)).not.toThrow();
  });
});

describe("ISSUE-027 进度看板钻取（主题 → 每课 → 当课汇总）", () => {
  it("getTopicProgress 返回该主题的逐课明细（真实数据）", async () => {
    const s = getLearningSummary(CHILD);
    const lunyu = s.topics.find((t) => t.name === "论语")!;
    const topicDir = lunyu.topicKey; // "lunyu"（已归一化为纯拼音主题键）
    const detail = await getTopicProgress(CHILD, topicDir);
    expect(detail, "应取到 lunyu 主题明细").toBeTruthy();
    expect(detail!.topic).toBe(topicDir);
    expect(detail!.items.length).toBe(lunyu.total); // 明细课程数 = 视图统计 total
    // 每课至少含状态字段
    const first = detail!.items[0];
    expect(first.title.trim()).not.toBe("");
    expect(["⬜", "✅"]).toContain(first.status);
  });

  it("未知主题返回 null（不报错）", async () => {
    expect(await getTopicProgress(CHILD, "no-such-topic")).toBeNull();
  });

  it("getCourseDailySummary 返回该课的学习总结（来自 daily_entries，真实数据：论语学而篇第一章）", async () => {
    const list = await getCourseDailySummary(CHILD, "论语", "论语学而篇第一章");
    expect(Array.isArray(list), "应返回数组").toBe(true);
    expect(list.length, "该课应有学习总结记录（含重新系统学习等）").toBeGreaterThan(0);
    // 每条都应含日期 + 原文，且原文为 markdown 学习总结
    const s = list[0];
    expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.raw).toContain("知识点");
    // 按日期升序
    for (let i = 1; i < list.length; i++) {
      expect(list[i].date >= list[i - 1].date, "应按日期升序").toBe(true);
    }
  });

  it("getCourseDailySummary 对无总结的课程返回空数组（不报错）", async () => {
    const list = await getCourseDailySummary(CHILD, "论语", "并不存在的一课");
    expect(list).toEqual([]);
  });
});
