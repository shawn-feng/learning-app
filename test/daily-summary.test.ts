import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 纯 node 环境没有 electron；custom-tools → config 顶部 `import { app } from "electron"`
// 会在模块加载时触发 electron 解析。打桩成 { app: undefined }，与 learning-summary.test.ts 一致。
vi.mock("electron", () => ({ app: undefined }));

// SPLIT：buildProvidedContext 走服务端 kb RPC（dbQuery）。mock config 让数据目录
// 落到临时目录，并写 license.json（helper 签发有效 token）走真实本地服务端验证全链路。
const mockTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daily-summary-"));
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

import {
  readDailyConversation,
  findLastConversationDate,
  findLatestConversationDate,
  summarizeDailyConversation,
  formatDailyExistingList,
  buildProvidedContext,
} from "../electron/lib/daily-summary.ts";
import { writeTestLicense, TEST_PARENT_ID } from "./helpers/server-token";

// daily-summary 核心逻辑：jsonl 按天过滤（排除 think/toolCall/toolResult）、最近会话日期查找、
// 无会话时跳过（不建 ephemeral session、不调 AI）。
// 会话读写用临时目录隔离；buildProvidedContext 走服务端 kb（测试家长名下的真实孩子）。

// 测试家长名下的真实孩子（lunyu 512 课、93 标签，服务端数据）。
const CHILD = "1f050a7f-df8a-45b0-925a-1ffe2aa35674";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-summary-test-"));
  // 该孩子属于测试家长 86a84278：签它的 token 才能读其服务端 kb
  fs.mkdirSync(mockTmpRoot, { recursive: true });
  writeTestLicense(mockTmpRoot, TEST_PARENT_ID);
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 沙箱 safe-delete 可能拦截 rmSync（已知环境问题），残留临时目录不影响结果
  }
  try {
    fs.rmSync(mockTmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function sessionsDir(): string {
  const dir = path.join(tmpDir, ".pi", "agent", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 造一个跨天 jsonl：8/21 有 user/assistant 文本 + thinking/toolCall/toolResult，8/22 有一条 user。 */
function seedJsonl() {
  const dir = sessionsDir();
  const lines = [
    JSON.stringify({ type: "message", timestamp: "2026-08-21T08:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "今天学论语吗？" }] } }),
    JSON.stringify({ type: "message", timestamp: "2026-08-21T08:00:05.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "内部思考" }, { type: "text", text: "好，我们开始" }] } }),
    JSON.stringify({ type: "message", timestamp: "2026-08-21T08:00:10.000Z", message: { role: "toolResult", content: [{ type: "text", text: "工具结果不应出现" }] } }),
    JSON.stringify({ type: "message", timestamp: "2026-08-21T08:00:15.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "kb_query" }] } }),
    JSON.stringify({ type: "message", timestamp: "2026-08-22T09:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "昨天学了什么" }] } }),
  ];
  fs.writeFileSync(path.join(dir, "test.jsonl"), lines.join("\n"), "utf-8");
}

describe("readDailyConversation（按天过滤 jsonl）", () => {
  it("只取指定日期的 user/assistant 文本，排除 thinking/toolCall/toolResult", () => {
    seedJsonl();
    const text = readDailyConversation(tmpDir, "2026-08-21");
    expect(text).toContain("今天学论语吗？");
    expect(text).toContain("好，我们开始");
    expect(text).not.toContain("工具结果不应出现");
    expect(text).not.toContain("内部思考");
    expect(text).not.toContain("昨天学了什么"); // 8/22 的消息不混入
    expect(text).not.toContain("toolCall");
  });

  it("没有会话的日期返回空串", () => {
    expect(readDailyConversation(tmpDir, "2026-08-20")).toBe("");
  });
});

describe("findLastConversationDate / findLatestConversationDate", () => {
  it("找 today 之前最后有会话的日期", () => {
    expect(findLastConversationDate(tmpDir, "2026-08-22")).toBe("2026-08-21");
  });

  it("无会话时返回 null", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "daily-summary-empty-"));
    try {
      expect(findLastConversationDate(empty, "2026-08-22")).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("findLatestConversationDate 返回所有会话日期中的最大值", () => {
    expect(findLatestConversationDate(tmpDir)).toBe("2026-08-22");
  });
});

describe("summarizeDailyConversation（无会话跳过，不调 AI）", () => {
  it("目标日期无会话 → skipped=true，不建 session", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "daily-summary-nosession-"));
    try {
      const r = await summarizeDailyConversation(empty, "2026-08-21");
      expect(r.skipped).toBe(true);
      expect(r.summarized).toBe(false);
      expect(r.note).toContain("没有会话");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("formatDailyExistingList（同天多次汇总的去重清单）", () => {
  it("按区块分组列出已存在条目（raw 截断）", () => {
    const list = formatDailyExistingList([
      {
        date: "2026-08-23",
        block: "学习",
        title: "论语先进篇第二十一章",
        raw: "### 论语先进篇第二十一章\n- 考核：吟诵✓\n- 孩子表现：很认真",
        tags: "",
      },
      {
        date: "2026-08-23",
        block: "生活",
        title: "准备去奶奶家",
        raw: "### 准备去奶奶家\n- 标签：独立\n- 概要：自己列了行李清单",
        tags: "独立",
      },
    ]);
    expect(list).toContain("【学习】");
    expect(list).toContain("论语先进篇第二十一章");
    expect(list).toContain("【生活】");
    expect(list).toContain("准备去奶奶家");
  });

  it("raw 超过截断长度时省略号截断（省 token）", () => {
    const longRaw = "### 标题\n- 字段：" + "很长的内容".repeat(100);
    const list = formatDailyExistingList([
      { date: "2026-08-23", block: "问答", title: "恐龙为什么灭绝", raw: longRaw, tags: "" },
    ]);
    expect(list).toContain("恐龙为什么灭绝");
    expect(list.length).toBeLessThan(200);
  });

  it("无条目返回空串", () => {
    expect(formatDailyExistingList([])).toBe("");
  });
});

describe("buildProvidedContext（首轮注入：主题进度 + 标签定义表 + 已有条目）", () => {
  it("无数据孩子返回标题 + 暂无主题/无标签定义 + 保留已有条目清单", async () => {
    // SPLIT：buildProvidedContext 走服务端 kb RPC，child_id = 目录名；
    // 随机临时目录在服务端查不到任何数据 → 空态文案
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "daily-summary-ctx-"));
    try {
      const ctx = await buildProvidedContext(empty, "【学习】\n- 论语先进篇第九章");
      expect(ctx).toContain("已提供的上下文");
      expect(ctx).toContain("（暂无学习主题）");
      expect(ctx).toContain("无标签定义");
      expect(ctx).toContain("论语先进篇第九章");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("真实孩子（服务端 kb）返回主题进度摘要 + 标签定义表，且不含逐课清单", async () => {
    // 用真实孩子目录名做 child_id → 服务端 kb 返回其真实进度聚合行（lunyu 512 课）与标签表
    const childDir = path.join(mockTmpRoot, "children", CHILD);
    const ctx = await buildProvidedContext(childDir, "");
    expect(ctx).toContain("已提供的上下文");
    expect(ctx).toContain("论语（lunyu）");
    expect(ctx).toContain("已学");
    expect(ctx).toContain("下一课「");
    expect(ctx).toContain("诚实");
    // 绝不注入逐课清单（论语几百课全量塞上下文是灾难）
    expect(ctx).not.toContain("### 论语");
  });
});
