/**
 * 微信桥（ISSUE-106 前置）：/wechat/turn 的回复聚合器 runTurn 回归用例。
 * 用真实 agentStreamHub 单例 + 假 submit 驱动事件序列。
 */
import { describe, expect, it } from "vitest";
import { agentStreamHub } from "../server/src/agent/stream-hub";
import { runTurn } from "../server/src/routes/wechat";

describe("wechat runTurn", () => {
  it("聚合 text_delta 并在 turn_end 收口", async () => {
    const key = `t-${Math.random()}`;
    const r = await runTurn(async () => {
      agentStreamHub.publish(key, "text_delta", { delta: "你好" });
      agentStreamHub.publish(key, "text_delta", { delta: "，家长" });
      agentStreamHub.publish(key, "turn_end", {});
      return { ok: true };
    }, key);
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("你好，家长");
  });

  it("busy：submit 失败原样透传错误", async () => {
    const key = `t-${Math.random()}`;
    const r = await runTurn(async () => ({ ok: false, error: "busy：上一轮还在回答，请稍候" }), key);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("busy");
  });

  it("error 事件且无文本 → ok:false；有部分文本则附带说明", async () => {
    const key = `t-${Math.random()}`;
    const err = await runTurn(async () => {
      agentStreamHub.publish(key, "error", { message: "模型超时" });
      return { ok: true };
    }, key);
    expect(err.ok).toBe(false);
    expect(err.error).toContain("模型超时");

    const key2 = `t-${Math.random()}`;
    const partial = await runTurn(async () => {
      agentStreamHub.publish(key2, "text_delta", { delta: "部分回答" });
      agentStreamHub.publish(key2, "error", { message: "工具挂了" });
      return { ok: true };
    }, key2);
    expect(partial.ok).toBe(true);
    expect(partial.reply).toContain("部分回答");
    expect(partial.reply).toContain("工具挂了");
  });

  it("onProgress 逐步回调思考/工具/作答快照", async () => {
    const key = `t-${Math.random()}`;
    const snaps: Array<{ thinking: string; tools: Array<{ name: string; done: boolean }>; text: string }> = [];
    const r = await runTurn(async () => {
      agentStreamHub.publish(key, "thinking_delta", { delta: "先查计划" });
      agentStreamHub.publish(key, "tool_start", { toolCallId: "c1", toolName: "parent_exam_plan_list" });
      agentStreamHub.publish(key, "tool_end", { toolCallId: "c1", toolName: "parent_exam_plan_list" });
      agentStreamHub.publish(key, "text_delta", { delta: "闻闻今天82分" });
      agentStreamHub.publish(key, "turn_end", {});
      return { ok: true };
    }, key, undefined, (p) => snaps.push({ ...p, tools: p.tools.map((t) => ({ ...t })) }));
    expect(r.ok).toBe(true);
    expect(snaps.length).toBeGreaterThanOrEqual(4);
    expect(snaps.some((s) => s.thinking.includes("先查计划"))).toBe(true);
    const toolSnap = snaps.find((s) => s.tools.length && s.tools[0].done);
    expect(toolSnap?.tools[0].name).toBe("parent_exam_plan_list");
    const last = snaps[snaps.length - 1];
    expect(last.text).toBe("闻闻今天82分");
  });

  it("超时返回已聚合的部分回复", async () => {
    const key = `t-${Math.random()}`;
    const r = await runTurn(async () => {
      agentStreamHub.publish(key, "text_delta", { delta: "才说一半" });
      return { ok: true }; // 之后不再发 turn_end
    }, key, 40);
    expect(r.ok).toBe(true);
    expect(r.reply).toContain("才说一半");
    expect(r.reply).toContain("超时");
  }, 5000);
});
