/**
 * ISSUE-126 回归（2026-09-21）：模型错误全程不可见 + 会话模型绑定焊死。
 *
 * 守住：
 * ① syncSessionModel：默认模型变更 → session.setModel 原地热切换；未变更不动；
 *    setModel 抛错（新 provider 没配 key）→ ok:false + 可读原因，绝不静默；
 * ② friendlyModelError：SDK 记在 assistant 消息上的原始模型错误（429 额度 JSON /
 *    401 key / 429 限流 / 未知）→ 用户能看懂的一句话。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../server/src/worker/scheduler.js", () => ({
  readParentSettings: vi.fn(),
}));
vi.mock("@pi/agent-core", () => ({
  getWorkerRuntime: vi.fn(),
  pickWorkerModel: vi.fn(),
}));

import { readParentSettings } from "../server/src/worker/scheduler.js";
import { getWorkerRuntime, pickWorkerModel } from "@pi/agent-core";
import { friendlyModelError, syncSessionModel } from "../server/src/agent/model-sync";

const deps = { db: {} as any, dataDir: "/tmp/x" };

function stubRuntime(model: { provider: string; id: string } | undefined) {
  (readParentSettings as any).mockReturnValue({ auth: {}, appSettings: {} });
  (getWorkerRuntime as any).mockResolvedValue({ __runtime: true });
  (pickWorkerModel as any).mockReturnValue(model);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncSessionModel（ISSUE-126 热切换）", () => {
  it("默认模型与会话绑定一致 → 不调用 setModel", async () => {
    stubRuntime({ provider: "mimo-tokenplan", id: "mimo-v2.5" });
    const session = {
      model: { provider: "mimo-tokenplan", id: "mimo-v2.5" },
      setModel: vi.fn().mockResolvedValue(undefined),
    };
    const r = await syncSessionModel(deps, "p1", session, "test");
    expect(r.ok).toBe(true);
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it("默认模型变更 → setModel 原地热切换（历史保留）", async () => {
    stubRuntime({ provider: "mimo-tokenplan", id: "mimo-v2.5" });
    const session = {
      model: { provider: "qwen-tokenplan", id: "deepseek-v4-flash-0731" },
      setModel: vi.fn().mockResolvedValue(undefined),
    };
    const r = await syncSessionModel(deps, "p1", session, "test");
    expect(r.ok).toBe(true);
    expect(session.setModel).toHaveBeenCalledTimes(1);
    expect(session.setModel.mock.calls[0][0]).toMatchObject({
      provider: "mimo-tokenplan",
      id: "mimo-v2.5",
    });
  });

  it("setModel 抛错（新 provider 没配 key）→ ok:false + 明确原因，不静默", async () => {
    stubRuntime({ provider: "mimo-tokenplan", id: "mimo-v2.5" });
    const session = {
      model: { provider: "qwen-tokenplan", id: "deepseek-v4-flash-0731" },
      setModel: vi.fn().mockRejectedValue(new Error("No API key for mimo-tokenplan/mimo-v2.5")),
    };
    const r = await syncSessionModel(deps, "p1", session, "test");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("默认模型切换失败");
    expect(r.error).toContain("No API key");
  });

  it("解析不出模型 / 会话无绑定模型 → 安全跳过", async () => {
    stubRuntime(undefined);
    const session = { model: { provider: "qwen", id: "qwen-max" }, setModel: vi.fn() };
    const r = await syncSessionModel(deps, "p1", session, "test");
    expect(r.ok).toBe(true);
    expect(session.setModel).not.toHaveBeenCalled();
  });
});

describe("friendlyModelError（ISSUE-126 错误可见化）", () => {
  it("429 额度用尽（token-plan 真实报文形态）→ 额度提示 + 重置日期", () => {
    const raw =
      '429: {"message":"Your token-plan 1-week quota has been exhausted. The quota will reset at 09-27 04:32:00 UTC.","code":"insufficient_quota"}';
    const msg = friendlyModelError(raw);
    expect(msg).toContain("额度已用完");
    expect(msg).toContain("09-27");
    expect(msg).toContain("切换模型");
  });

  it("401 key 无效 → 指向设置检查 Key", () => {
    expect(friendlyModelError("401: invalid api key")).toContain("API Key");
  });

  it("429 限流（非额度）→ 限流提示", () => {
    expect(friendlyModelError("429: too many requests")).toContain("限流");
  });

  it("未知错误 → 原文透传（带前缀），不吞信息", () => {
    expect(friendlyModelError("boom detail")).toBe("模型调用失败：boom detail");
  });
});
