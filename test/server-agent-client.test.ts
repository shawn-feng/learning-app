import { describe, it, expect } from "vitest";
import { translateAgentEvent, parseSseChunk, messageText, bridgeChildAgentEvents, previewArgs, previewToolResult } from "../electron/lib/server-agent-client";

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
  it("tool_start 的 args 对象序列化（避免 [object Object]）", () => {
    const s = translateAgentEvent({ id: 3, type: "tool_start", data: { toolCallId: "t1", toolName: "read", args: { path: "a.txt" } } }, childId, "main");
    expect(s).toMatchObject({ channel: "pi:tool_start", payload: { toolCallId: "t1", toolName: "read" } });
    expect(s!.payload.argsPreview).toBe('{"path":"a.txt"}');
  });
  it("tool_end 提取 resultPreview（文本正文，而非裸 result 对象）", () => {
    const e = translateAgentEvent({ id: 4, type: "tool_end", data: { toolCallId: "t1", toolName: "read", isError: false, result: { content: [{ type: "text", text: "读到了内容" }], details: {} } } }, childId, "main");
    expect(e).toMatchObject({ channel: "pi:tool_end", payload: { toolCallId: "t1", isError: false, resultPreview: "读到了内容" } });
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
  it("display_content → pi:display_content（P4 渲染层新增通道，正文随事件传播）", () => {
    const r = translateAgentEvent({ id: 9, type: "display_content", data: { path: "lunyu/x.html", source: "materials", title: "论语", content: "<html>正文</html>" } }, childId, "main");
    expect(r!.channel).toBe("pi:display_content");
    expect(r!.payload.path).toBe("lunyu/x.html");
    expect(r!.payload.content).toBe("<html>正文</html>");
  });
  it("未知类型 → null（不打扰渲染层）", () => {
    expect(translateAgentEvent({ id: 10, type: "hello", data: {} }, childId, "main")).toBeNull();
  });
});

describe("桥：最终回复气泡语义（pi:reply / pi:reply_end）", () => {
  const childId = "c1";
  function collect(events: Array<{ id: number; type: string; data: any }>) {
    const sent: Array<{ channel: string; payload: any }> = [];
    for (const e of events) bridgeChildAgentEvents(e, childId, (channel, payload) => sent.push({ channel, payload }));
    return sent;
  }
  it("messageText 提取 assistant 文本", () => {
    expect(messageText({ content: [{ type: "text", text: "你好" }, { type: "text", text: "呀" }] })).toBe("你好呀");
    expect(messageText({ content: [{ type: "image", data: "x" }] })).toBe("");
    expect(messageText(null)).toBe("");
  });
  it("message_end 不立即发 pi:reply（工作气泡不被提前转正）", () => {
    const sent = collect([
      { id: 0, type: "user_message", data: {} },
      { id: 1, type: "message_end", data: { message: { role: "assistant", content: [{ type: "text", text: "中间话" }] } } },
    ]);
    expect(sent.some((s) => s.channel === "pi:reply")).toBe(false);
  });
  it("turn_end 时逐条回发累积文本 + reply_end（多段文本成多气泡）", () => {
    const sent = collect([
      { id: 0, type: "user_message", data: {} },
      { id: 1, type: "text_delta", data: { delta: "你好" } },
      { id: 2, type: "message_end", data: { message: { role: "assistant", content: [{ type: "text", text: "第一段" }] } } },
      { id: 3, type: "message_end", data: { message: { role: "assistant", content: [{ type: "text", text: "第二段" }] } } },
      { id: 4, type: "turn_end", data: {} },
    ]);
    const replies = sent.filter((s) => s.channel === "pi:reply");
    expect(replies.map((r) => r.payload.text)).toEqual(["第一段", "第二段"]);
    expect(sent[sent.length - 1]!.channel).toBe("pi:reply_end");
  });
  it("工具轮回归：tool_start/tool_end 在 reply 之前到达（2026-09-13 实测踩坑）", () => {
    const sent = collect([
      { id: 0, type: "user_message", data: {} },
      { id: 1, type: "message_end", data: { message: { role: "assistant", content: [{ type: "text", text: "我先查一下" }, { type: "toolCall", id: "t1", name: "kb_query", arguments: {} }] } } },
      { id: 2, type: "tool_start", data: { toolCallId: "t1", toolName: "kb_query", args: { query: "daily" } } },
      { id: 3, type: "tool_end", data: { toolCallId: "t1", toolName: "kb_query", isError: false, result: { content: [{ type: "text", text: "查询结果" }] } } },
      { id: 4, type: "message_end", data: { message: { role: "assistant", content: [{ type: "text", text: "查到了" }] } } },
      { id: 5, type: "turn_end", data: {} },
    ]);
    const idx = (ch: string) => sent.findIndex((s) => s.channel === ch);
    // 工具事件必须先于第一条 reply ——否则渲染层工作气泡已转正、工具调用被丢弃
    expect(idx("pi:tool_start")).toBeGreaterThan(-1);
    expect(idx("pi:tool_start")).toBeLessThan(idx("pi:reply"));
    expect(idx("pi:tool_end")).toBeLessThan(idx("pi:reply"));
    const replies = sent.filter((s) => s.channel === "pi:reply");
    expect(replies.map((r) => r.payload.text)).toEqual(["我先查一下", "查到了"]);
  });
  it("user_message 重置轮缓冲（上一轮异常残留不串轮）", () => {
    const sent = collect([
      { id: 1, type: "message_end", data: { message: { role: "assistant", content: [{ type: "text", text: "残留" }] } } },
      { id: 2, type: "user_message", data: {} },
      { id: 3, type: "turn_end", data: {} },
    ]);
    expect(sent.some((s) => s.channel === "pi:reply")).toBe(false);
  });
  it("error → pi:reply_error + pi:reply_end（聊天框显式报错）", () => {
    const sent = collect([{ id: 1, type: "error", data: { message: "No API key" } }]);
    expect(sent.some((s) => s.channel === "pi:reply_error" && s.payload.error === "No API key")).toBe(true);
    expect(sent.some((s) => s.channel === "pi:reply_end")).toBe(true);
  });
  it("message_end 兜底补发完整思考（complete=true 覆盖式）", () => {
    const sent = collect([
      { id: 1, type: "message_end", data: { message: { role: "assistant", content: [{ type: "thinking", thinking: "先想一下" }, { type: "text", text: "答案" }] } } },
    ]);
    const t = sent.find((s) => s.channel === "pi:thinking");
    expect(t).toBeTruthy();
    expect(t!.payload).toEqual({ childId, delta: "先想一下", complete: true });
  });
  it("message_end 无 thinking 块则不补发", () => {
    const sent = collect([
      { id: 1, type: "message_end", data: { message: { role: "assistant", content: [{ type: "text", text: "纯答案" }] } } },
    ]);
    expect(sent.some((s) => s.channel === "pi:thinking")).toBe(false);
  });
});

describe("previewArgs / previewToolResult（工具入参/结果预览）", () => {
  it("对象入参 → JSON 序列化（不是 [object Object]）", () => {
    expect(previewArgs({ path: "a", mode: "fast" })).toBe('{"path":"a","mode":"fast"}');
  });
  it("字符串入参直接取，空对象/空串返回 undefined", () => {
    expect(previewArgs("read a file")).toBe("read a file");
    expect(previewArgs({})).toBeUndefined();
    expect(previewArgs(null)).toBeUndefined();
  });
  it("结果从 content 文本提取，兜底 JSON", () => {
    expect(previewToolResult({ content: [{ type: "text", text: "ok" }], details: {} })).toBe("ok");
    expect(previewToolResult({ text: "直接文本" })).toBe("直接文本");
    expect(previewToolResult({ code: 0, msg: "success" })).toBe('{"code":0,"msg":"success"}');
    expect(previewToolResult(null)).toBeUndefined();
  });
});
