import { describe, it, expect } from "vitest";
import { translateAgentEvent, parseSseChunk } from "../electron/lib/server-agent-client";

describe("parseSseChunk", () => {
  it("解析单条事件（id/event/data）", () => {
    const { events, rest } = parseSseChunk('id: 3\nevent: text_delta\ndata: {"delta":"你"}\n\n');
    expect(events).toEqual([{ id: 3, type: "text_delta", data: { delta: "你" } }]);
    expect(rest).toBe("");
  });

  it("多条事件与半截缓冲区", () => {
    const { events, rest } = parseSseChunk('id: 1\nevent: text_delta\ndata: {"delta":"a"}\n\nid: 2\nevent: text_delta\ndata: {"del');
    expect(events.length).toBe(1);
    expect(events[0]!.id).toBe(1);
    expect(rest).toContain("id: 2");
  });

  it("心跳/注释行被忽略", () => {
    const { events } = parseSseChunk(': ping\n\nid: 5\nevent: agent_end\ndata: {}\n\n');
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("agent_end");
  });

  it("非 JSON data 原样保留", () => {
    const { events } = parseSseChunk('event: hello\ndata: just-text\n\n');
    expect(events[0]!.data).toBe("just-text");
  });
});

describe("translateAgentEvent（服务端 SSE → 渲染层 pi:* 通道，契约不变）", () => {
  const childId = "c1";
  it("text_delta → pi:streaming", () => {
    const r = translateAgentEvent({ id: 1, type: "text_delta", data: { delta: "好" } }, childId, "main");
    expect(r).toEqual({ channel: "pi:streaming", payload: { childId, delta: "好" } });
  });
  it("thinking_delta → pi:thinking", () => {
    const r = translateAgentEvent({ id: 2, type: "thinking_delta", data: { delta: "想" } }, childId, "main");
    expect(r!.channel).toBe("pi:thinking");
  });
  it("tool_start / tool_end 载荷对齐", () => {
    const s = translateAgentEvent({ id: 3, type: "tool_start", data: { toolCallId: "t1", toolName: "read", args: { path: "a" } } }, childId, "main");
    expect(s).toMatchObject({ channel: "pi:tool_start", payload: { toolCallId: "t1", toolName: "read" } });
    const e = translateAgentEvent({ id: 4, type: "tool_end", data: { toolCallId: "t1", toolName: "read", isError: false, result: { x: 1 } } }, childId, "main");
    expect(e).toMatchObject({ channel: "pi:tool_end", payload: { isError: false } });
  });
  it("assistant 的 message_end → pi:message_end；非 assistant 丢弃", () => {
    const ok = translateAgentEvent({ id: 5, type: "message_end", data: { message: { role: "assistant", content: [] } } }, childId, "main");
    expect(ok!.channel).toBe("pi:message_end");
    expect(translateAgentEvent({ id: 6, type: "message_end", data: { message: { role: "user" } } }, childId, "main")).toBeNull();
  });
  it("agent_end / turn_end → pi:agent_end", () => {
    expect(translateAgentEvent({ id: 7, type: "turn_end", data: {} }, childId, "main")!.channel).toBe("pi:agent_end");
  });
  it("error → pi:error", () => {
    const r = translateAgentEvent({ id: 8, type: "error", data: { message: "网络失败" } }, childId, "main");
    expect(r).toEqual({ channel: "pi:error", payload: { childId, error: "网络失败" } });
  });
  it("display_content → pi:display_content（P4 渲染层新增通道）", () => {
    const r = translateAgentEvent({ id: 9, type: "display_content", data: { path: "lunyu/x.html", source: "materials" } }, childId, "main");
    expect(r!.channel).toBe("pi:display_content");
    expect(r!.payload.path).toBe("lunyu/x.html");
  });
  it("未知类型 → null（不打扰渲染层）", () => {
    expect(translateAgentEvent({ id: 10, type: "hello", data: {} }, childId, "main")).toBeNull();
  });
});
