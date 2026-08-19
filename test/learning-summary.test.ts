import { describe, it, expect, vi } from "vitest";

// 纯 node 环境没有 electron；config.ts 顶部 `import { app } from "electron"` 会在模块加载时
// 触发 electron 解析。这里把 electron 打桩成 { app: undefined }，使 getDataDir() 退化为
// process.cwd()/data（vitest 在仓库根目录运行，正好命中真实 data/children）。
vi.mock("electron", () => ({ app: undefined }));

import { getLearningSummary, progressSummaryToMarkdown } from "../electron/lib/learning-summary";

// 真实存在的孩子（含 lunyu 主题，514 课）。ISSUE-006 的痛点就是 lunyu 正文几百行被整篇读入只为取 next。
const CHILD = "1f050a7f-df8a-45b0-925a-1ffe2aa35674";

describe("ISSUE-006 进度摘要（frontmatter-only，不泄露正文）", () => {
  it("getLearningSummary 只解析 frontmatter，能拿到下一课", () => {
    const s = getLearningSummary(CHILD);
    const lunyu = s.topics.find((t) => t.name === "论语");
    expect(lunyu, "应解析到 lunyu 主题").toBeDefined();
    expect(lunyu!.learned).toBe(280);
    expect(lunyu!.total).toBe(514);
    // 关键：注入上下文用的 next 字段解析正确
    expect(lunyu!.next).toBe("论语先进篇第十五章");
    // 总体进度也应聚合
    expect(s.totals.topicCount).toBeGreaterThan(0);
  });

  it("progressSummaryToMarkdown 紧凑且含下一课，不含逐课正文", () => {
    const s = getLearningSummary(CHILD);
    const md = progressSummaryToMarkdown(s);
    // 应包含下一课（这是注入系统提示、让 agent 免读全文的核心信息）
    expect(md).toContain("论语先进篇第十五章");
    expect(md).toMatch(/已学 280\/514/);
    // 不应包含逐课正文噪声：论语正文里有「论语学而篇第一章」「掌握度」等
    expect(md, "不该泄露逐课标题").not.toContain("论语学而篇第一章");
    expect(md, "不该泄露逐课状态字段").not.toContain("掌握度");
  });

  it("孩子无主题时不抛错，progressContext 退化为总体进度行", () => {
    // 用一个不存在的 childId，topics 应为空，但不应抛异常
    const s = getLearningSummary("__no_such_child__");
    expect(s.topics).toEqual([]);
    expect(() => progressSummaryToMarkdown(s)).not.toThrow();
    expect(progressSummaryToMarkdown(s)).toContain("总体进度 0/0");
  });
});
