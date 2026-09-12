/**
 * 服务端 agent 客户端（P4 薄客户端核心）：把「孩子/家长/考核」的 agent 调用从本地 SDK
 * 换成对服务端 agent 路由的 HTTP + SSE。渲染层 `window.api` 契约**完全不变**——本模块把服务端
 * SSE 事件翻译回渲染层早已监听的那些 `pi:*` 通道，主进程成为纯粹的转发层。
 *
 * 为什么单独成模块而不是塞进 ipc-handlers：
 * 1. SSE 解析（fetch + ReadableStream，Node 主进程没有 EventSource）有独立且易错的生命周期
 *    （建连 / Last-Event-ID 重放 / 心跳 / 断开重连 / 进程退出清理），需要集中维护；
 * 2. 事件到 `pi:*` 通道的映射是一份需要单测的纯逻辑，不应散在 handler 里；
 * 3. 后续手机端（web 版 window.api）可复用同一份 SSE 客户端，只是把「发到 webContents」换成「发到 DOM Event」。
 */
import { serverBase, serverFetch, ServerError } from "./server-client";
import { getCachedLicense } from "./auth-manager";

/** 会话 token（登录后缓存的 license.token）。未登录返回空串（此时服务端会 401，走错误提示）。 */
export function sessionToken(): string {
  return getCachedLicense()?.token ?? "";
}

export type AgentKind = "main" | "scene" | `course:${string}`;
export type ParentKind = "parent" | "parent-content";

export interface AgentEvent {
  id: number;
  type: string;
  data: any;
}

/** 服务端 SSE 事件 → 渲染层 pi:* 通道的翻译结果（纯数据，由 ipc-handlers 负责 webContents.send）。 */
export interface RendererEvent {
  channel: string;
  payload: any;
}

/**
 * 把一条服务端 agent 事件翻译成渲染层通道消息（纯函数，便于单测）。
 * 通道名与载荷保持与旧本地实现一致，渲染层零改动。
 */
export function translateAgentEvent(e: AgentEvent, childId: string, kind: AgentKind | ParentKind): RendererEvent | null {
  switch (e.type) {
    case "text_delta":
      return { channel: "pi:streaming", payload: { childId, delta: String(e.data?.delta ?? "") } };
    case "thinking_delta":
      return { channel: "pi:thinking", payload: { childId, delta: String(e.data?.delta ?? "") } };
    case "tool_start":
      return {
        channel: "pi:tool_start",
        payload: {
          childId,
          toolCallId: e.data?.toolCallId,
          toolName: e.data?.toolName,
          argsPreview: String(e.data?.args ?? "").slice(0, 120),
        },
      };
    case "tool_end":
      return {
        channel: "pi:tool_end",
        payload: {
          childId,
          toolCallId: e.data?.toolCallId,
          toolName: e.data?.toolName,
          result: e.data?.result,
          isError: e.data?.isError === true,
        },
      };
    case "message_end":
      if (e.data?.message?.role === "assistant") {
        return { channel: "pi:message_end", payload: { childId, message: e.data.message } };
      }
      return null;
    case "agent_end":
    case "turn_end":
      return { channel: "pi:agent_end", payload: { childId } };
    case "display_content":
      // 资料推送：渲染层 MaterialsPanel 订阅此通道后自动打开（P4 渲染层新增，见联调点）
      return { channel: "pi:display_content", payload: { childId, ...(e.data ?? {}) } };
    case "error":
      return { channel: "pi:error", payload: { childId, error: String(e.data?.message ?? "未知错误") } };
    default:
      return null;
  }
}

/** 极简 SSE 解析器：把 fetch 的字节流切成 `id:/event:/data:` 事件（NDJSON 心形不在此）。 */
export function parseSseChunk(buffer: string): { events: AgentEvent[]; rest: string } {
  const events: AgentEvent[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const block of parts) {
    let id = 0;
    let type = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) id = Number(line.slice(3).trim()) || 0;
      else if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      // 以 ":" 开头的是注释/心跳，忽略
    }
    if (!dataLines.length) continue;
    let data: any = dataLines.join("\n");
    try {
      data = JSON.parse(data);
    } catch {
      /* 非 JSON 数据原样保留 */
    }
    events.push({ id, type, data });
  }
  return { events, rest };
}

export interface StreamHandle {
  /** 停止订阅（关闭连接与读循环）。 */
  close: () => void;
}

/**
 * 订阅某孩子的服务端 agent 事件流（SSE），把事件经 onEvent 回调交出。
 * - `caps`：设备能力串（material-panel,mic,electron），服务端据此装配工具；
 * - 自动 Last-Event-ID 重放由服务端在事件流内完成（断线重连时服务端按 `?lastEventId=` 回放，本层暂用 0）。
 */
export function streamChildAgent(
  opts: { childId: string; caps?: string; onEvent: (e: AgentEvent) => void; onError?: (err: string) => void },
  token = sessionToken()
): StreamHandle {
  const base = serverBase();
  const caps = opts.caps ?? "material-panel";
  const url = `${base}/api/v1/agent/${encodeURIComponent(opts.childId)}/stream?caps=${encodeURIComponent(caps)}&token=${encodeURIComponent(token)}`;
  return openSse(url, opts.onEvent, opts.onError);
}

export function streamParentAgent(
  opts: { kind: ParentKind; onEvent: (e: AgentEvent) => void; onError?: (err: string) => void },
  token = sessionToken()
): StreamHandle {
  const base = serverBase();
  const url = `${base}/api/v1/parent-agent/stream?kind=${encodeURIComponent(opts.kind)}&token=${encodeURIComponent(token)}`;
  return openSse(url, opts.onEvent, opts.onError);
}

function openSse(url: string, onEvent: (e: AgentEvent) => void, onError?: (err: string) => void): StreamHandle {
  const ac = new AbortController();
  let closed = false;

  (async () => {
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream" } });
      if (!res.ok || !res.body) {
        onError?.(`流连接失败（HTTP ${res.status}）`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunk(buf);
        buf = rest;
        for (const e of events) {
          if (e.type === "hello" || e.type === "ping") continue;
          onEvent(e);
        }
      }
    } catch (err) {
      if (!closed) onError?.((err as Error).message ?? "流连接中断");
    }
  })();

  return { close: () => { closed = true; ac.abort(); } };
}

/** 提交孩子一轮输入（等待本轮结束；流式增量走 streamChildAgent）。 */
export async function promptChild(
  childId: string,
  text: string,
  opts: { session?: AgentKind; images?: Array<{ type: "image"; mimeType: string; data: string }>; pageEvents?: string } = {},
  token = sessionToken()
): Promise<void> {
  await serverFetch(`/agent/${encodeURIComponent(childId)}/prompt`, {
    method: "POST",
    token,
    body: { text, session: opts.session ?? "main", pageEvents: opts.pageEvents, images: opts.images },
    timeoutMs: 120000,
  });
}

/** 提交家长一轮输入。 */
export async function promptParent(
  text: string,
  opts: { kind?: ParentKind } = {},
  token = sessionToken()
): Promise<void> {
  await serverFetch(`/parent-agent/prompt`, {
    method: "POST",
    token,
    body: { text, kind: opts.kind ?? "parent" },
    timeoutMs: 120000,
  });
}

/** 页面事件上行（PiBridge 信封 → 服务端桥，累积到下一轮消息前）。 */
export async function postPageEvent(
  childId: string,
  events: Array<{ kind: string; title?: string; detail?: Record<string, unknown> }>,
  token = sessionToken()
): Promise<void> {
  await serverFetch(`/agent/${encodeURIComponent(childId)}/events`, { method: "POST", token, body: { events } });
}

/** 资料页受控操作回执上行。 */
export async function postPageResult(
  childId: string,
  requestId: string,
  result: { ok: boolean; error?: string; data?: unknown },
  token = sessionToken()
): Promise<void> {
  await serverFetch(`/agent/${encodeURIComponent(childId)}/page-result`, {
    method: "POST",
    token,
    body: { requestId, ok: result.ok, error: result.error, data: result.data },
  });
}

/** 非结构化课程出题（服务端）。 */
export async function examGenerateCourse(
  childId: string,
  body: { topicName: string; courseTitle: string; childName?: string },
  token = sessionToken()
): Promise<{ questions: Array<Record<string, unknown>> }> {
  return serverFetch(`/exam/agent/generate`, { method: "POST", token, body: { childId, ...body }, timeoutMs: 120000 });
}

/** 判分（服务端，判分口径不接受客户端传入）。 */
export async function examGrade(
  childId: string,
  answers: Array<Record<string, unknown>>,
  token = sessionToken()
): Promise<{ perQuestion: Array<Record<string, unknown>>; overall: string }> {
  return serverFetch(`/exam/agent/grade`, { method: "POST", token, body: { childId, answers }, timeoutMs: 120000 });
}

export { ServerError };
