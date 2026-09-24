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

const TOOL_PREVIEW_LIMIT = 200;
const TOOL_RESULT_LIMIT = 300;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * 工具入参预览：对象 JSON 序列化、字符串直取，再截断。
 * 为什么不能直接 String(args)：对象会得到 "[object Object]"（用户实踩），必须 JSON.stringify。
 */
export function previewArgs(args: unknown): string | undefined {
  if (args == null) return undefined;
  let s = "";
  if (typeof args === "string") s = args;
  else {
    try {
      s = JSON.stringify(args);
    } catch {
      s = String(args);
    }
  }
  if (!s || s === "{}" || s === "[object Object]") return undefined;
  return truncate(s, TOOL_PREVIEW_LIMIT);
}

/**
 * 工具结果预览：从 { content:[{type:text}] } 或 { text } 里提取文本，兜底 JSON 序列化。
 * 服务端工具 execute 返回 { content:[{type:"text",text}], details }，这里取正文做气泡预览。
 */
export function previewToolResult(result: unknown): string | undefined {
  if (result == null) return undefined;
  const r = result as { content?: unknown[]; text?: unknown };
  if (Array.isArray(r.content)) {
    let t = "";
    for (const c of r.content) {
      const b = c as { type?: string; text?: string };
      if (b && b.type === "text" && typeof b.text === "string") t += b.text;
    }
    if (t.trim()) return truncate(t, TOOL_RESULT_LIMIT);
  }
  if (typeof r.text === "string" && r.text.trim()) return truncate(r.text, TOOL_RESULT_LIMIT);
  let s = "";
  try {
    s = JSON.stringify(result);
  } catch {
    s = String(result);
  }
  if (!s || s === "[object Object]" || s === "{}") return undefined;
  return truncate(s, TOOL_RESULT_LIMIT);
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
          argsPreview: previewArgs(e.data?.args),
        },
      };
    case "tool_end":
      return {
        channel: "pi:tool_end",
        payload: {
          childId,
          toolCallId: e.data?.toolCallId,
          toolName: e.data?.toolName,
          resultPreview: previewToolResult(e.data?.result),
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
    case "page_cmd":
      // 服务端受控下行指令（scene_command / page_action / page_inspect 的统一通道）：
      // 翻译回渲染层既有 pi:page:exec 通道（MaterialsPanel.appCmd 据此执行；执行结果经
      // pi:page:exec:result 回传，再由 ipc-handlers 调 postPageResult 送回服务端配对 requestId）。
      return {
        channel: "pi:page:exec",
        payload: {
          childId,
          requestId: e.data?.requestId,
          action: e.data?.action,
          params: e.data?.params ?? {},
        },
      };
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
 * - 自动重连 + Last-Event-ID 续传（ISSUE-095 排查发现：流只建一次、断后永不重连，
 *   服务端重启后事件全部丢失 → 前端永远「思考中」。现断线后自动重建连接并带
 *   lastEventId 让服务端回放缺失事件，「思考中」的那一轮也能自动恢复显示）。
 */
export function streamChildAgent(
  opts: { childId: string; caps?: string; onEvent: (e: AgentEvent) => void; onError?: (err: string) => void }
): StreamHandle {
  const caps = opts.caps ?? "material-panel";
  const buildUrl = () => {
    const base = serverBase();
    return `${base}/api/v1/agent/${encodeURIComponent(opts.childId)}/stream?caps=${encodeURIComponent(caps)}&token=${encodeURIComponent(sessionToken())}`;
  };
  return openSse(buildUrl, opts.onEvent, opts.onError);
}

export function streamParentAgent(
  opts: { kind: ParentKind; onEvent: (e: AgentEvent) => void; onError?: (err: string) => void }
): StreamHandle {
  const buildUrl = () => {
    const base = serverBase();
    return `${base}/api/v1/parent-agent/stream?kind=${encodeURIComponent(opts.kind)}&token=${encodeURIComponent(sessionToken())}`;
  };
  return openSse(buildUrl, opts.onEvent, opts.onError);
}

/**
 * SSE 连接（带自动重连）。
 * - 每次（重）连接都重新构建 URL（取最新 serverBase / sessionToken / lastEventId）；
 * - 断线/读尽 → 指数退避重连（2s 起步、逐次 +2s、上限 15s），**静默重连不报错**——
 *   服务端会按 lastEventId 回放缺失事件，UI 自动恢复，无需打扰用户；
 * - 仅 401/403（登录态失效，重连无意义）才回调 onError 终止。
 */
function openSse(buildUrl: () => string, onEvent: (e: AgentEvent) => void, onError?: (err: string) => void): StreamHandle {
  const ac = new AbortController();
  let closed = false;
  let lastEventId = 0;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = (reason: string) => {
    if (closed) return;
    attempt++;
    const delay = Math.min(15000, 2000 * attempt);
    console.log(`[sse] 连接中断（${reason}），${delay / 1000}s 后第 ${attempt} 次重连`);
    retryTimer = setTimeout(connect, delay);
  };

  const connect = () => {
    if (closed) return;
    (async () => {
      try {
        let url = buildUrl();
        if (lastEventId > 0) url += `${url.includes("?") ? "&" : "?"}lastEventId=${lastEventId}`;
        const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream" } });
        if (!res.ok || !res.body) {
          if (res.status === 401 || res.status === 403) {
            // 登录态失效：重连无意义，交由上层提示（渲染层会弹错误气泡）
            onError?.(`流连接失败（HTTP ${res.status}）：登录态可能已失效，请重新登录`);
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        attempt = 0; // 连接成功，重置退避
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
            if (e.id > 0) lastEventId = e.id; // 记录进度，断线重连后服务端从此之后回放
            if (e.type === "hello" || e.type === "ping") continue;
            onEvent(e);
          }
        }
        // 服务端正常关闭连接（如重启）→ 重连
        scheduleReconnect("服务端关闭连接");
      } catch (err) {
        if (closed) return; // 手动 close 触发的 abort，不重连
        scheduleReconnect((err as Error).message ?? "未知错误");
      }
    })();
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ac.abort();
    },
  };
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

/** 中止孩子 agent 当前一轮（ISSUE-095；session 省略=该孩子全部会话）。 */
export async function abortChildAgent(childId: string, session?: string, token = sessionToken()): Promise<void> {
  await serverFetch(`/agent/${encodeURIComponent(childId)}/abort`, {
    method: "POST",
    token,
    body: { session },
    timeoutMs: 30000,
  });
}

/** 中止家长 agent 当前一轮（ISSUE-095）。 */
export async function abortParentAgent(kind: ParentKind = "parent", token = sessionToken()): Promise<void> {
  await serverFetch("/parent-agent/abort", {
    method: "POST",
    token,
    body: { kind },
    timeoutMs: 30000,
  });
}

/** ISSUE-108：取最近一次家长报表（parent_display_report 落 settings；无则 null）。 */
export async function getParentReport(
  token = sessionToken()
): Promise<{ report: { title: string; content: string; ts: number } | null }> {
  return serverFetch("/parent-agent/report", { method: "GET", token, timeoutMs: 15000 });
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
 * 会话消息 timestamp（SDK 落盘为 ISO 字符串 / 内存消息可能为 ms 数字）→「MM-DD HH:mm」展示标签。
 * 与渲染层 nowLabel() 同格式；取不出有效时间返回 undefined（渲染层自行兜底 now）。
 */
function historyTimeLabel(ts: unknown): string | undefined {
  const ms = typeof ts === "string" ? Date.parse(ts) : typeof ts === "number" ? ts : NaN;
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 把服务端会话原始消息映射成前端气泡恢复用的 HistoryMessage。
 * 覆盖 user/assistant 的正文与思考；工具调用气泡的恢复（toolCall 块 + toolResult 匹配）暂不做——
 * 联调点：退出重进时工具调用记录不恢复为气泡，仅正文/思考恢复。
 * time（2026-09-14 修复）：透传服务端消息时间戳格式化为展示标签——此前所有恢复消息都显示
 * 「进会话时刻」（m.time 缺失 → 渲染层 nowLabel() 兜底），并非真实发生时间。
 */
export function mapHistoryMessages(raw: Array<{ role: string; content: unknown[]; timestamp?: number | string }>): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of raw ?? []) {
    const time = historyTimeLabel(m.timestamp);
    const content = Array.isArray(m.content) ? m.content : [];
    if (m.role === "user") {
      const text = contentText(content);
      if (text) out.push({ role: "user", text, ...(time ? { time } : {}) });
    } else if (m.role === "assistant") {
      const text = contentText(content);
      const thinking = contentThinking(content);
      if (text || thinking) {
        out.push({ role: "ai", text, thinking: thinking || undefined, ...(time ? { time } : {}) });
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

/**
 * 打开孩子会话（ISSUE-100 F1 冷路径）：服务端按「落盘会话最后一条消息的日期」裁决，
 * 跨天自动新建会话后返回裁决后的历史——进会话加载历史一律走本入口（替代 getChildHistory），
 * 保证用户一进来看到的就是当天会话（不会先见旧消息、发消息时突然清空）。
 * getChildHistory（/history）保留给「回顾历史」类只读场景。
 */
export async function openChildSession(childId: string, session?: string, token = sessionToken()): Promise<HistoryMessage[]> {
  const r = await serverFetch<{ messages: Array<{ role: string; content: unknown[]; timestamp?: number }> }>(
    `/agent/${encodeURIComponent(childId)}/open`,
    { method: "POST", token, body: { session: session ?? "main" } }
  );
  return mapHistoryMessages(r.messages ?? []);
}

/**
 * 打开家长会话（ISSUE-107 冷路径）：服务端 ensureEntry 后返回现会话全部历史（不做跨天裁决，
 * 家长会话长期持续累积）。与 openChildSession 对应；进家长聊天/建课引导回填历史走本入口。
 */
export async function openParentSession(kind: "parent" | "parent-content", token = sessionToken()): Promise<HistoryMessage[]> {
  const r = await serverFetch<{ messages: Array<{ role: string; content: unknown[]; timestamp?: number | string }> }>(
    "/parent-agent/open",
    { method: "POST", token, body: { kind } }
  );
  return mapHistoryMessages(r.messages ?? []);
}

/** 重置家长会话。 */
export async function resetParentSession(kind: ParentKind, token = sessionToken()): Promise<void> {
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
/**
 * 轮内文本缓冲（按会话键）：assistant 的 message_end **不再立即**发 pi:reply。
 * 为什么：SDK 事件顺序是「assistant 消息 message_end（可能带 toolCall）→ tool_start/end → 下一条」，
 * 一个 agent 轮有多条 assistant 消息；若第一条到达就发 pi:reply，渲染层会把工作气泡转正
 * （workingIdRef 清空），**后续 tool_start/tool_end 被 patchWorking 全部丢弃**——
 * 实测表现即「看不到任何工具调用，记录就完成了」（2026-09-13）。
 * 修复：message_end 只累积文本，turn_end/agent_end（轮真正结束）时逐条回发——
 * 与旧同步实现「prompt() 返回后逐条回发 assistant 文本」的顺序语义完全一致。
 */
const turnTextBuffers = new Map<string, string[]>();

function bufferTurnText(key: string, text: string): void {
  if (!text.trim()) return;
  const buf = turnTextBuffers.get(key) ?? [];
  buf.push(text);
  turnTextBuffers.set(key, buf);
}

function flushTurnTexts(key: string, childId: string, send: (channel: string, payload: any) => void): void {
  const buf = turnTextBuffers.get(key);
  turnTextBuffers.delete(key);
  if (!buf) return;
  for (const t of buf) {
    if (t.trim()) send("pi:reply", { childId, text: t });
  }
}

function bridgeAgentEventCore(
  e: AgentEvent,
  childId: string,
  bufferKey: string,
  send: (channel: string, payload: any) => void
): void {
  // 新轮开始：清空残留缓冲（上轮异常中断未 flush 的内容不带入本轮）
  if (e.type === "user_message") turnTextBuffers.delete(bufferKey);

  const base = translateAgentEvent(e, childId, "main");
  // 注意：message_end 的翻译结果（pi:message_end）也要发——但 pi:reply 的回发已推迟到
  // turn_end（见 turnTextBuffers），这里其余事件照常转发。
  if (base && e.type !== "message_end") send(base.channel, base.payload);
  if (e.type === "message_end") send("pi:message_end", { childId, message: e.data?.message });

  switch (e.type) {
    case "message_end": {
      const msg = e.data?.message;
      // 思考补发：流式 thinking_delta 可能因模型/竞态未到达，message_end 时用消息里的
      // thinking 块兜底补一次完整思考（complete=true 让前端覆盖而非追加，避免重复）。
      // 此刻工作气泡仍在（reply 尚未回发），思考能正确落到气泡上。
      const thinking = contentThinking(msg?.content);
      if (thinking) send("pi:thinking", { childId, delta: thinking, complete: true });
      bufferTurnText(bufferKey, messageText(msg));
      break;
    }
    case "turn_end":
    case "agent_end":
      flushTurnTexts(bufferKey, childId, send);
      send("pi:reply_end", { childId });
      break;
    case "error":
      turnTextBuffers.delete(bufferKey);
      send("pi:reply_error", { childId, error: String(e.data?.message ?? "未知错误") });
      send("pi:reply_end", { childId });
      break;
    default:
      break;
  }
}

/**
 * 把服务端 agent 事件流桥接到渲染层（孩子侧）——除 translateAgentEvent 的 pi:* 通道外，
 * 额外补「最终回复气泡」语义：
 *   message_end(assistant) → 累积文本（见 turnTextBuffers 注释）
 *   turn_end / agent_end  → 逐条 pi:reply + pi:reply_end（本轮收束）
 *   error                  → pi:reply_error + pi:reply_end（聊天框显式报错，而非静默转圈）
 * @param send 渲染层通道发送函数（ipc-handlers 传入 webContents.send）
 */
export function bridgeChildAgentEvents(
  e: AgentEvent,
  childId: string,
  send: (channel: string, payload: any) => void
): void {
  bridgeAgentEventCore(e, childId, `child:${childId}`, send);
}

/**
 * 家长侧桥（childId 语义用 "parent" / "parent-content" 表示会话，供前端路由）。
 */
export function bridgeParentAgentEvents(
  e: AgentEvent,
  childId: "parent" | "parent-content",
  send: (channel: string, payload: any) => void
): void {
  bridgeAgentEventCore(e, childId, `parent:${childId}`, send);
}

export { ServerError };
