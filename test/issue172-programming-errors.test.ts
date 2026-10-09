/**
 * ISSUE-172 P0 回归：嵌套编程会话的错误收集器。
 * 头号事故盲区：模型调用失败（stopReason=error + errorMessage）被 SDK 当正常结束，
 * 外层只见「未能成功写入」——收集器必须捕获并汇总真实底层错误。
 */
import { describe, expect, it } from "vitest";
import { createProgrammingIssueCollector } from "../server/src/agent/programming-agent";

const modelErrorEvent = (over: Record<string, unknown> = {}) => ({
  type: "message_end",
  message: {
    role: "assistant",
    stopReason: "error",
    errorMessage: `HTTP 400: {"error":{"message":"Invalid thinking format"}}`,
    provider: "moyu",
    model: "DeepSeek-V4.1-flash",
    timestamp: 1728100000000,
    ...over,
  },
});

describe("ISSUE-172 编程会话错误收集器", () => {
  it("模型错误（stopReason=error）→ 捕获 provider/model/errorMessage，message_end 与 turn_end 去重", () => {
    const c = createProgrammingIssueCollector();
    c.observe(modelErrorEvent());
    c.observe({ type: "turn_end", message: modelErrorEvent().message, toolResults: [] });
    expect(c.issues).toHaveLength(1);
    expect(c.issues[0]!.kind).toBe("model");
    expect(c.issues[0]!.label).toContain("moyu/DeepSeek-V4.1-flash");
    expect(c.issues[0]!.label).toContain("HTTP 400");
    expect(c.summarize()).toContain("模型调用失败");
  });

  it("工具执行失败（isError=true）→ 捕获工具名与结果摘要", () => {
    const c = createProgrammingIssueCollector();
    c.observe({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "write",
      isError: true,
      result: { content: [{ type: "text", text: "path outside sandbox: /etc/x.html" }] },
    });
    expect(c.issues).toHaveLength(1);
    expect(c.issues[0]!.kind).toBe("tool");
    expect(c.issues[0]!.label).toContain("write");
    expect(c.issues[0]!.label).toContain("path outside sandbox");
  });

  it("aborted → 记为中止（非模型错误）；正常消息不捕获", () => {
    const c = createProgrammingIssueCollector();
    c.observe({ type: "message_end", message: { role: "assistant", stopReason: "aborted", timestamp: 1 } });
    expect(c.issues).toHaveLength(1);
    expect(c.issues[0]!.kind).toBe("abort");
    c.observe({ type: "message_end", message: { role: "assistant", stopReason: "stop", timestamp: 2 } });
    c.observe({ type: "tool_execution_end", toolCallId: "t2", toolName: "read", isError: false, result: {} });
    expect(c.issues).toHaveLength(1);
  });

  it("summarize 多条拼接；超长 errorMessage 截断到 300 字符内", () => {
    const c = createProgrammingIssueCollector();
    const long = "x".repeat(500);
    c.observe(modelErrorEvent({ timestamp: 10, errorMessage: `HTTP 401: ${long}` }));
    c.observe({
      type: "tool_execution_end",
      toolCallId: "t3",
      toolName: "write",
      isError: true,
      result: { content: [{ type: "text", text: "denied" }] },
    });
    const s = c.summarize();
    expect(s).toContain("；");
    expect(s).toContain("401");
    expect(s).toContain("denied");
    for (const label of c.issues.map((i) => i.label)) {
      expect(label.length).toBeLessThan(420);
    }
  });
});
