import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 纯 node 环境没有 electron；config.ts 顶部 `import { app } from "electron"` 需打桩。
vi.mock("electron", () => ({ app: undefined }));

// 把 config 的 getDataDir/getChildDir 打桩到临时目录，避免污染真实 data/。
const { tmpRootRef } = vi.hoisted(() => ({ tmpRootRef: { dir: "" as string } }));
vi.mock("../electron/lib/config", () => ({
  getDataDir: () => path.join(tmpRootRef.dir, "data"),
  getChildDir: (childId: string) => path.join(tmpRootRef.dir, "data", "children", childId),
}));

import {
  estimateTokens,
  computeRoundStats,
  logRound,
  appendTokenLog,
  readTokenLog,
  getTokenSummary,
  modelLabelOf,
  type TokenLogEntry,
} from "../electron/lib/token-stats";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "token-stats-test-"));
}

function fakeUsage(input: number, output: number, overrides?: Partial<any>) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0.001 * input, output: 0.002 * output, cacheRead: 0, cacheWrite: 0, total: 0.001 * input + 0.002 * output },
    ...overrides,
  };
}

function fakeSession(messages: any[], model?: any) {
  return {
    messages,
    model: model || { provider: "deepseek", id: "deepseek-v4-flash" },
    sessionManager: { getSessionFile: () => undefined },
  };
}

beforeEach(() => {
  tmpRootRef.dir = makeTmpDir();
});

afterEach(() => {
  try {
    fs.rmSync(tmpRootRef.dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
});

describe("estimateTokens：本地近似分词", () => {
  it("空串返回 0，纯空白按其它字符比例", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   ")).toBe(1); // 3 空格 / 4 = 0.75 → ceil 1
  });

  it("纯英文约 4 字符/token", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("hello world how are you today?")).toBe(8); // 31 chars / 4 = 7.75 → 8
  });

  it("纯中文约 1.5 字符/token", () => {
    expect(estimateTokens("你好")).toBe(2); // 2 / 1.5 = 1.33 → 2
    // "论语是中国古代经典" = 9 个汉字，9 / 1.5 = 6 → 6
    expect(estimateTokens("论语是中国古代经典")).toBe(6);
  });

  it("中英混合分别按各自比例", () => {
    // "你好world"：cjk=2 → ceil(2/1.5)=2；其它=5 → ceil(5/4)=2 → 合计 4
    expect(estimateTokens("你好world")).toBe(4);
  });
});

describe("computeRoundStats：一轮 prompt 的用量统计", () => {
  it("累加 beforeCount 之后新增 assistant 消息的真实 usage，已有/新增按消息切片估算", () => {
    const messages: any[] = [
      { role: "user", content: "第一轮问题", timestamp: 1 }, // 已有
      { role: "assistant", content: "第一轮回答", usage: fakeUsage(100, 20), stopReason: "stop", timestamp: 2 }, // 已有
      { role: "user", content: "本轮新问题 hello world", timestamp: 3 }, // 新增
      { role: "assistant", content: "工具调用准备", usage: fakeUsage(150, 10), stopReason: "toolUse", timestamp: 4 }, // 新增
      { role: "assistant", content: "本轮最终回答", usage: fakeUsage(160, 30), stopReason: "stop", timestamp: 5 }, // 新增
    ];
    const stats = computeRoundStats(fakeSession(messages), 2);

    expect(stats.input).toBe(150 + 160);
    expect(stats.output).toBe(10 + 30);
    expect(stats.cacheRead).toBe(0);
    expect(stats.cost).toBeCloseTo(0.001 * 310 + 0.002 * 40, 5);
    expect(stats.assistantCalls).toBe(2);
    // 已有 = 前 2 条
    expect(stats.existingTokens).toBe(estimateTokens("第一轮问题") + estimateTokens("第一轮回答"));
    // 新增 = 后 3 条
    expect(stats.newTokens).toBe(
      estimateTokens("本轮新问题 hello world") +
        estimateTokens("工具调用准备") +
        estimateTokens("本轮最终回答")
    );
  });

  it("stopReason=error 的 assistant 不计入真实用量，但计入新增估算", () => {
    const messages: any[] = [
      { role: "user", content: "问题", timestamp: 1 },
      { role: "assistant", content: "", usage: fakeUsage(500, 0), stopReason: "error", timestamp: 2 },
    ];
    const stats = computeRoundStats(fakeSession(messages), 1);
    expect(stats.input).toBe(0);
    expect(stats.output).toBe(0);
    expect(stats.assistantCalls).toBe(0);
    expect(stats.newTokens).toBe(0); // content 为空串
  });

  it("usage 缺失/字段为 0 时防御不崩溃", () => {
    const messages: any[] = [
      { role: "user", content: "q", timestamp: 1 },
      { role: "assistant", content: "a", usage: undefined, stopReason: "stop", timestamp: 2 },
      { role: "user", content: "q2", timestamp: 3 },
    ];
    const stats = computeRoundStats(fakeSession(messages), 1);
    expect(stats.input).toBe(0);
    expect(stats.existingTokens).toBe(estimateTokens("q"));
    expect(stats.newTokens).toBe(estimateTokens("a") + estimateTokens("q2"));
  });

  it("content 为数组时只统计 text 块", () => {
    const messages: any[] = [
      { role: "user", content: "旧", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "回答一" },
          { type: "thinking", text: "思考内容" },
        ],
        usage: fakeUsage(10, 5),
        stopReason: "stop",
        timestamp: 2,
      },
    ];
    const stats = computeRoundStats(fakeSession(messages), 1);
    expect(stats.newTokens).toBe(estimateTokens("回答一")); // thinking 不计
  });
});

describe("modelLabelOf", () => {
  it("返回 provider/modelId", () => {
    expect(modelLabelOf(fakeSession([], { provider: "qwen", id: "qwen3-vl-flash" }))).toBe("qwen/qwen3-vl-flash");
  });
  it("无 model 时返回 unknown", () => {
    expect(modelLabelOf({ messages: [] })).toBe("unknown");
  });
});

describe("token-log 持久化（按 childId 隔离 + append-only）", () => {
  function makeEntry(overrides?: Partial<TokenLogEntry>): TokenLogEntry {
    return {
      seq: 0,
      ts: "2026-08-19T12:00:00.000Z",
      channel: "child",
      childId: "child-a",
      sessionFile: "session.jsonl",
      model: "deepseek/deepseek-v4-flash",
      ok: true,
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.001,
      totalTokens: 120,
      existingTokens: 300,
      newTokens: 80,
      assistantCalls: 1,
      ...overrides,
    };
  }

  it("appendTokenLog 追加写文件，seq 从 1 递增", () => {
    appendTokenLog(makeEntry({ input: 10 }), "child-a");
    appendTokenLog(makeEntry({ input: 20 }), "child-a");
    const entries = readTokenLog("child-a", 100);
    expect(entries).toHaveLength(2);
    expect(entries[0].seq).toBe(1);
    expect(entries[1].seq).toBe(2);
    expect(entries[1].input).toBe(20);
  });

  it("childId 隔离：不同孩子写不同文件、互不可见", () => {
    appendTokenLog(makeEntry({ childId: "child-a", input: 1 }), "child-a");
    appendTokenLog(makeEntry({ childId: "child-b", input: 2 }), "child-b");
    expect(readTokenLog("child-a", 100)).toHaveLength(1);
    expect(readTokenLog("child-a", 100)[0].input).toBe(1);
    expect(readTokenLog("child-b", 100)[0].input).toBe(2);
  });

  it("无 childId（家长/全局）落到 data 根目录", () => {
    appendTokenLog(makeEntry({ childId: undefined, input: 7 }), undefined);
    const entries = readTokenLog(undefined, 100);
    expect(entries).toHaveLength(1);
    expect(entries[0].input).toBe(7);
    expect(fs.existsSync(path.join(tmpRootRef.dir, "data", "token-log.jsonl"))).toBe(true);
  });

  it("getTokenSummary 累计总量与按模型分组", () => {
    appendTokenLog(makeEntry({ input: 100, output: 20, cost: 0.01, totalTokens: 120 }), "child-a");
    appendTokenLog(
      makeEntry({ model: "qwen/qwen3-vl-flash", input: 50, output: 10, cost: 0.02, totalTokens: 60 }),
      "child-a"
    );
    const s = getTokenSummary("child-a");
    expect(s.rounds).toBe(2);
    expect(s.totalInput).toBe(150);
    expect(s.totalOutput).toBe(30);
    expect(s.totalCost).toBeCloseTo(0.03, 5);
    expect(s.totalTokens).toBe(180);
    expect(s.byModel["deepseek/deepseek-v4-flash"].input).toBe(100);
    expect(s.byModel["qwen/qwen3-vl-flash"].rounds).toBe(1);
  });

  it("logRound 一站式：真实 session 收集 + 落盘", () => {
    const session = fakeSession([
      { role: "user", content: "旧问题", timestamp: 1 },
      { role: "assistant", content: "旧回答", usage: fakeUsage(50, 10), stopReason: "stop", timestamp: 2 },
      { role: "user", content: "新问题", timestamp: 3 },
      { role: "assistant", content: "新回答", usage: fakeUsage(80, 15), stopReason: "stop", timestamp: 4 },
    ]);
    logRound({ session, beforeCount: 2, channel: "child", childId: "child-a", ok: true });
    const entries = readTokenLog("child-a", 100);
    expect(entries).toHaveLength(1);
    expect(entries[0].input).toBe(80);
    expect(entries[0].output).toBe(15);
    expect(entries[0].existingTokens).toBe(estimateTokens("旧问题") + estimateTokens("旧回答"));
    expect(entries[0].newTokens).toBe(estimateTokens("新问题") + estimateTokens("新回答"));
    expect(entries[0].replyLength).toBe("新回答".length);
    expect(entries[0].model).toBe("deepseek/deepseek-v4-flash");
    expect(entries[0].channel).toBe("child");
    expect(entries[0].ok).toBe(true);
  });

  it("logRound 对 session 异常不抛错（静默降级，仍落一条全 0 记录）", () => {
    expect(() => logRound({ session: null as any, beforeCount: 0, channel: "parent", ok: true })).not.toThrow();
    const entries = readTokenLog(undefined, 100);
    expect(entries).toHaveLength(1);
    expect(entries[0].input).toBe(0);
    expect(entries[0].output).toBe(0);
  });
});
