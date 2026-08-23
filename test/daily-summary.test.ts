import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  readDailyConversation,
  findLastConversationDate,
  findLatestConversationDate,
  summarizeDailyConversation,
} from "../electron/lib/daily-summary.ts";

// daily-summary 核心逻辑：jsonl 按天过滤（排除 think/toolCall/toolResult）、最近会话日期查找、
// 无会话时跳过（不建 ephemeral session、不调 AI）。
// 用临时目录隔离，不碰真实孩子库。

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-summary-test-"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 沙箱 safe-delete 可能拦截 rmSync（已知环境问题），残留临时目录不影响结果
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
