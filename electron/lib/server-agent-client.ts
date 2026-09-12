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

// ==================== 模型配置（薄客户端：设置页改服务端 app_settings / 密钥） ====================

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  input: string[];
}

/** 可用模型列表（服务端静态 provider 表）。 */
export async function listModels(token = sessionToken()): Promise<ModelInfo[]> {
  const r = await serverFetch<{ models: ModelInfo[] }>("/models", { token });
  return r.models ?? [];
}

/** 设置某 provider 的 API key（合并进服务端 auth 封套，加密落盘）。 */
export async function setModelApiKey(provider: string, apiKey: string, token = sessionToken()): Promise<void> {
  await serverFetch("/models/apikey", { method: "POST", token, body: { provider, apiKey } });
}

/** 合并 app_settings（defaultModel / visionModel / programmingModel / tts…）。 */
export async function setAppSettings(patch: Record<string, unknown>, token = sessionToken()): Promise<void> {
  await serverFetch("/models/app_settings", { method: "POST", token, body: patch });
}

/** 读取当前 app_settings 与脱敏后的 provider 密钥态。 */
export async function getModelSettings(
  token = sessionToken()
): Promise<{ appSettings: Record<string, unknown>; providers: Array<{ provider: string; hasKey: boolean }> }> {
  return serverFetch("/models/settings", { token });
}

/** 校验某 provider 密钥是否可用（服务端真实探测）。 */
export async function checkProviderAuth(provider: string, token = sessionToken()): Promise<boolean> {
  const r = await serverFetch<{ ok: boolean; status: boolean }>("/models/check", {
    method: "POST",
    token,
    body: { provider },
    timeoutMs: 30000,
  });
  return r.status === true;
}

// ==================== 会话历史 / 重置（薄客户端） ====================

export interface HistoryMessage {
  role: "user" | "ai";
  text: string;
  time?: string;
  thinking?: string;
  tools?: Array<{ id: string; name: string; argsPreview?: string; status: "running" | "done" | "error"; resultPreview?: string }>;
}

function contentText(content: unknown[]): string {
  let t = "";
  for (const c of content ?? []) {
    const b = c as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") t += b.text;
  }
  return t.trim();
}

function contentThinking(content: unknown[]): string {
  let t = "";
  for (const c of content ?? []) {
    const b = c as { type?: string; text?: string; thinking?: string };
    if (b?.type === "thinking" && typeof (b.thinking ?? b.text) === "string") t += (b.thinking ?? b.text) as string;
  }
  return t.trim();
}

/**
 * 把服务端会话原始消息映射成前端气泡恢复用的 HistoryMessage。
 * 覆盖 user/assistant 的正文与思考；工具调用气泡的恢复（toolCall 块 + toolResult 匹配）暂不做——
 * 联调点：退出重进时工具调用记录不恢复为气泡，仅正文/思考恢复。
 */
export function mapHistoryMessages(raw: Array<{ role: string; content: unknown[]; timestamp?: number }>): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of raw ?? []) {
    const content = Array.isArray(m.content) ? m.content : [];
    if (m.role === "user") {
      const text = contentText(content);
      if (text) out.push({ role: "user", text });
    } else if (m.role === "assistant") {
      const text = contentText(content);
      const thinking = contentThinking(content);
      if (text || thinking) {
        out.push({ role: "ai", text, thinking: thinking || undefined });
      }
    }
    // toolResult / 其它角色不恢复为气泡（前端只展示 user/ai）
  }
  return out;
}

/** 读取某孩子会话历史（映射为前端气泡）。 */
export async function getChildHistory(childId: string, session?: string, token = sessionToken()): Promise<HistoryMessage[]> {
  const q = session ? `?session=${encodeURIComponent(session)}` : "";
  const r = await serverFetch<{ messages: Array<{ role: string; content: unknown[]; timestamp?: number }> }>(
    `/agent/${encodeURIComponent(childId)}/history${q}`,
    { token }
  );
  return mapHistoryMessages(r.messages ?? []);
}

/** 重置孩子会话（服务端 newSession）。 */
export async function resetChildSession(childId: string, session?: string, token = sessionToken()): Promise<void> {
  await serverFetch(`/agent/${encodeURIComponent(childId)}/reset`, { method: "POST", token, body: { session } });
}

/** 重置家长会话。 */
export async function resetParentSession(kind: "parent" | "parent-content", token = sessionToken()): Promise<void> {
  await serverFetch("/parent-agent/reset", { method: "POST", token, body: { kind } });
}

// ==================== 对话流桥（服务端 SSE → 渲染层 pi:* + pi:reply 语义） ====================

/** 从服务端下发的 assistant 消息里提取纯文本（content 里的 text 块拼接）。 */
export function messageText(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  let t = "";
  for (const c of message.content) {
    if (c && c.type === "text" && typeof c.text === "string") t += c.text;
  }
  return t;
}

/**
 * 从场景会话的 assistant 消息里提取「角色台词」（scene_command say）+ 兜底正文。
 * 与本地 scene:prompt 的台词清洗规则一致：本轮有 say 台词 → 聊天只显示台词（与 HTML 字幕同文，
 * 前缀角色名首字母大写）；无 say → 才显示 assistant 正文。
 */
export function extractSceneLines(message: any): { lines: Array<{ speaker: string; text: string }>; texts: string[] } {
  const lines: Array<{ speaker: string; text: string }> = [];
  const texts: string[] = [];
  if (!message || !Array.isArray(message.content)) return { lines, texts };
  for (const c of message.content) {
    if (!c) continue;
    if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
      texts.push(c.text.trim());
    } else if (c.type === "toolCall" && c.name === "scene_command") {
      const args = typeof c.arguments === "string" ? safeJson(c.arguments) : c.arguments;
      const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      if (a.command === "say" && typeof a.text === "string" && a.text.trim()) {
        const cid = String(a.character || "").trim();
        const speaker = cid ? cid.charAt(0).toUpperCase() + cid.slice(1) + ":" : "";
        lines.push({ speaker, text: a.text.trim() });
      }
    }
  }
  return { lines, texts };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * 把服务端 agent 事件流桥接到渲染层（孩子侧）——除 translateAgentEvent 的 pi:* 通道外，
 * 额外补「最终回复气泡」语义：
 *   message_end(assistant) → pi:reply（整段文本，前端用它替换工作气泡）+ pi:message_end
 *   turn_end / agent_end  → pi:reply_end（本轮收束）
 *   error                  → pi:reply_error + pi:reply_end（聊天框显式报错，而非静默转圈）
 * 这是本地实现里 session.prompt 返回后「逐条回发 assistant 文本」的等价物。
 * @param send 渲染层通道发送函数（ipc-handlers 传入 webContents.send）
 */
export function bridgeChildAgentEvents(
  e: AgentEvent,
  childId: string,
  send: (channel: string, payload: any) => void
): void {
  const base = translateAgentEvent(e, childId, "main");
  if (base) send(base.channel, base.payload);

  switch (e.type) {
    case "message_end": {
      const text = messageText(e.data?.message);
      if (text.trim()) send("pi:reply", { childId, text });
      break;
    }
    case "turn_end":
    case "agent_end":
      send("pi:reply_end", { childId });
      break;
    case "error":
      send("pi:reply_error", { childId, error: String(e.data?.message ?? "未知错误") });
      send("pi:reply_end", { childId });
      break;
    default:
      break;
  }
}

/**
 * 家长侧桥（childId 语义用 "parent" / "parent-content" 表示会话，供前端路由）。
 */
export function bridgeParentAgentEvents(
  e: AgentEvent,
  childId: "parent" | "parent-content",
  send: (channel: string, payload: any) => void
): void {
  const base = translateAgentEvent(e, childId, "parent");
  if (base) send(base.channel, base.payload);

  switch (e.type) {
    case "message_end": {
      const text = messageText(e.data?.message);
      if (text.trim()) send("pi:reply", { childId, text });
      break;
    }
    case "turn_end":
    case "agent_end":
      send("pi:reply_end", { childId });
      break;
    case "error":
      send("pi:reply_error", { childId, error: String(e.data?.message ?? "未知错误") });
      send("pi:reply_end", { childId });
      break;
    default:
      break;
  }
}

export { ServerError };
