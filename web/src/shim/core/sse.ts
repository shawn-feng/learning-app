/**
 * Web 版 agent SSE 客户端（设计方案 §2 #3，Phase 4）：
 * 把 electron/lib/server-agent-client.ts 的「SSE 建连 / 事件解析 / pi:* 翻译 / 轮末缓冲 /
 * 断线重连」逐段移植到浏览器，唯一替换点是把「webContents.send(channel, payload)」换成
 * 「eventBus.emit(channel, payload)」——渲染层经 window.api.onXxx（domains/agents.ts）订阅，
 * 回调收到的数据结构与 Electron 版完全一致。
 *
 * 机制要点（与 Electron 1:1，出处 server-agent-client.ts / ipc-handlers.ts）：
 *  - token 走 URL query（浏览器 EventSource 不能带自定义头；本实现用 fetch 流式读取，
 *    与 Electron 主进程同一套解析器 parseSseChunk，重连策略也逐行移植——不用原生
 *    EventSource，因为它无法区分 401 终止与网络闪断，退避节奏也不可控）；
 *  - 断线 → 指数退避重连（2s 起步、+2s 递增、上限 15s），重连带 lastEventId（query），
 *    服务端按 id 回放缺失事件（routes/agent.ts:100-107），UI 自动恢复、静默不打扰；
 *  - 仅 401/403（登录态失效）终止并回调 onError → 上层发 pi:reply_error/pi:reply_end；
 *  - 轮末缓冲：assistant 的 message_end 只累积文本，turn_end/agent_end 才逐条发 pi:reply
 *    （保证工具调用轮的工具卡片不被渲染层 workingIdRef 转正丢弃，2026-09-13 修复语义）；
 *  - 场景台词收集器：scene 会话与主会话共用同一条孩子流，scene:reply* 由收集器在本轮
 *    结束时回发（ipc-handlers.ts sceneCollectors/routeSceneEvent 语义）。
 *
 * 与 Electron 的差异（如实声明）：
 *  - caps 传 "material-panel,mic"（Electron 传 "material-panel"；Web 同样有资料面板与麦克风，
 *    只是无 electron 能位）；
 *  - 会话历史/资料由服务端 /open 与 display_content 事件驱动，本模块不做任何落盘改写。
 */
import { apiUrl, getStoredToken } from "./server-fetch";
import { eventBus } from "./event-bus";

export type AgentKind = "main" | "scene" | `course:${string}`;
export type ParentKind = "parent" | "parent-content";

/** 服务端 SSE 事件（id 用于 Last-Event-ID 重放配对）。 */
export interface AgentEvent {
  id: number;
  type: string;
  data: any;
}

/** 服务端事件 → 渲染层通道 的翻译结果（纯数据；send = eventBus.emit）。 */
export interface RendererEvent {
  channel: string;
  payload: any;
}

/** 场景台词收集器（ipc-handlers.ts sceneCollectors 元素签名）。 */
export interface SceneCollector {
  onSay: (speaker: string, text: string) => void;
  onText: (text: string) => void;
  onEnd: () => void;
  onError: (err: string) => void;
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
 * 把一条服务端 agent 事件翻译成渲染层通道消息（纯函数；server-agent-client.ts 逐行移植）。
 * 通道名与载荷保持与 Electron 客户端一致，渲染层零改动。
 */
export function translateAgentEvent(
  e: AgentEvent,
  childId: string,
  kind: AgentKind | ParentKind
): RendererEvent | null {
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
    case "tool_progress":
      // ISSUE-146 P0-b：长工具（编程 agent 生成 HTML 资料）执行期间的**进度文案**。
      // 与 text_delta 严格区分：它只用于工作气泡/工具卡片的提示文案，不参与正文累积。
      return {
        channel: "pi:tool_progress",
        payload: {
          childId,
          toolCallId: e.data?.toolCallId,
          toolName: e.data?.toolName,
          progress: String(e.data?.progress ?? ""),
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
      // 资料推送：渲染层 MaterialsPanel 订阅后自动打开。
      // 服务端事件载荷 { path, source, title, content, ts } 直接透传——ipc 侧（translateAgentEvent）
      // 同样不做路径改写/落盘（正文 content 已内联），Web 无需等价处理。
      return { channel: "pi:display_content", payload: { childId, ...(e.data ?? {}) } };
    case "page_cmd":
      // 服务端受控下行指令（scene_command / page_action / page_inspect 的统一通道）：
      // 翻译回渲染层既有 pi:page:exec 通道（Learn.handlePageExec 据此执行并回执）。
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

/** 极简 SSE 解析器：把 fetch 的字节流切成 `id:/event:/data:` 事件（server-agent-client.ts 原样移植）。 */
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
      // 以 ":" 开头的是注释/心跳（15s keepalive），忽略
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

// ---------------------------------------------------------------------------
// 消息文本提取（服务端 assistant 消息 content 块 → 纯文本 / 思考 / 场景台词）
// ---------------------------------------------------------------------------

/** 从服务端下发的 assistant 消息里提取纯文本（content 里的 text 块拼接）。 */
export function messageText(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  let t = "";
  for (const c of message.content) {
    if (c && c.type === "text" && typeof c.text === "string") t += c.text;
  }
  return t;
}

/** 提取思考文本（content 里的 thinking 块；thinking 字段优先、text 兜底）。 */
export function contentThinking(content: unknown[]): string {
  let t = "";
  for (const c of content ?? []) {
    const b = c as { type?: string; text?: string; thinking?: string };
    if (b?.type === "thinking" && typeof (b.thinking ?? b.text) === "string") t += (b.thinking ?? b.text) as string;
  }
  return t.trim();
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
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

// ---------------------------------------------------------------------------
// 轮末缓冲（bridgeAgentEventCore 核心，server-agent-client.ts:571-637 移植）
// ---------------------------------------------------------------------------

/**
 * 轮内文本缓冲（按会话键）：assistant 的 message_end **不再立即**发 pi:reply。
 * 为什么：SDK 事件顺序是「assistant 消息 message_end（可能带 toolCall）→ tool_start/end → 下一条」，
 * 一个 agent 轮有多条 assistant 消息；若第一条到达就发 pi:reply，渲染层会把工作气泡转正
 * （workingIdRef 清空），后续 tool_start/tool_end 被 patchWorking 全部丢弃——实测表现即
 * 「看不到任何工具调用，记录就完成了」（2026-09-13）。
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

/** 渲染层发送函数：ipc-handlers 的 webContents.send 在 Web 侧的等价物。 */
const send = (channel: string, payload: any): void => {
  eventBus.emit(channel, payload);
};

function bridgeAgentEventCore(e: AgentEvent, childId: string, bufferKey: string): void {
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

/** 孩子侧桥（bufferKey 与 Electron 一致用 `child:<childId>`）。 */
function bridgeChildAgentEvents(e: AgentEvent, childId: string): void {
  bridgeAgentEventCore(e, childId, `child:${childId}`);
}

/** 家长侧桥（childId 语义用 "parent" / "parent-content" 表示会话，供前端路由）。 */
function bridgeParentAgentEvents(e: AgentEvent, kind: ParentKind): void {
  bridgeAgentEventCore(e, kind, `parent:${kind}`);
}

// ---------------------------------------------------------------------------
// 场景台词收集器（ipc-handlers.ts:114-127 + scene:prompt 的挂载/摘除，语义移植）
// ---------------------------------------------------------------------------

const sceneCollectors = new Map<string, SceneCollector[]>();

function routeSceneEvent(childId: string, e: { type: string; data: any }): void {
  const collectors = sceneCollectors.get(childId);
  if (!collectors?.length) return;
  if (e.type === "message_end") {
    const { lines, texts } = extractSceneLines(e.data?.message);
    for (const l of lines) for (const c of collectors) c.onSay(l.speaker, l.text);
    if (!lines.length) for (const t of texts) for (const c of collectors) c.onText(t);
  } else if (e.type === "turn_end" || e.type === "agent_end") {
    for (const c of collectors) c.onEnd();
  } else if (e.type === "error") {
    for (const c of collectors) c.onError(String(e.data?.message ?? "未知错误"));
  }
}

/** 挂载场景收集器（scenePrompt 期间；流上的 message_end/turn_end/error 会派发进来）。 */
export function addSceneCollector(childId: string, collector: SceneCollector): void {
  const arr = sceneCollectors.get(childId) ?? [];
  arr.push(collector);
  sceneCollectors.set(childId, arr);
}

/** 摘除场景收集器（scenePrompt 的 finally；ipc-handlers.ts:1375-1381 同款防漏逻辑）。 */
export function removeSceneCollector(childId: string, collector: SceneCollector): void {
  const a2 = sceneCollectors.get(childId) ?? [];
  const i = a2.indexOf(collector);
  if (i >= 0) a2.splice(i, 1);
  if (a2.length) sceneCollectors.set(childId, a2);
  else sceneCollectors.delete(childId);
}

// ---------------------------------------------------------------------------
// SSE 连接（openSse 移植：fetch 流式读取 + 指数退避重连 + lastEventId 续传）
// ---------------------------------------------------------------------------

export interface StreamHandle {
  /** 停止订阅（中断连接与读循环，取消未决重连）。 */
  close: () => void;
  /** 是否已终止（永久失败 / 手动 close 后 true；ensure* 据此决定是否重建）。 */
  closed: boolean;
}

/** 会话 token（登录后缓存的 localStorage web.token；未登录为空串，服务端将 401）。 */
function sessionToken(): string {
  return getStoredToken();
}

/**
 * 静默停摆阈值：连续多久没收到**任何字节**就判定这条流已经死了。
 * 服务端每 15s 写一次 `: ping` 心跳（routes/parent-agent.ts / agent.ts 的 setInterval），
 * 因此 45s = 连续丢 3 次心跳，足够保守又能在 1 分钟内自愈。
 */
const SSE_STALL_TIMEOUT_MS = 45_000;

/**
 * SSE 连接（带自动重连）——server-agent-client.ts openSse 逐行移植。
 * - 每次（重）连接都重新构建 URL（取最新 serverBase / sessionToken / lastEventId）；
 * - 断线/读尽 → 指数退避重连（2s 起步、逐次 +2s、上限 15s），**静默重连不报错**——
 *   服务端会按 lastEventId 回放缺失事件，UI 自动恢复，无需打扰用户；
 * - 仅 401/403（登录态失效，重连无意义）才回调 onError 终止（handle 置 closed）。
 *
 * 2026-09-24（ISSUE-145）**心跳存活判据 + 静默停摆看门狗**：
 * 症状是「服务端早就跑完并 publish 了事件、心跳也照写，连接 TCP 层全 ACK，但浏览器 JS 一条都收不到」，
 * 而旧实现只在 `reader.read()` 返回 `done` 或抛异常时才重连——静默停摆两种情况都不发生，于是永不重连、
 * UI 永久停在「等待模型返回」。修法（三层）：
 *  ① **任何字节到达（含 `: ping` 注释行）都刷新 `lastByteAt`** —— 心跳由此有了判据（parseSseChunk 把注释行
 *    丢弃是**事件**层面的正确行为，但"收到过字节"这个事实不能丢）；
 *  ② `SSE_STALL_TIMEOUT_MS` 无字节 → 判定流死 → `ac.abort()` 强制走既有重连（带 `lastEventId` 续传补齐）；
 *  ③ **每次 connect 新建 AbortController**（旧实现复用同一个 ac：一旦 abort，之后所有重连的 fetch 都会
 *    立即以 AbortError 失败 → 退化成死循环重连）。
 */
function openSse(
  buildUrl: () => string,
  onEvent: (e: AgentEvent) => void,
  onError?: (err: string) => void
): StreamHandle {
  const handle: StreamHandle = { closed: false, close: () => {} };
  let lastEventId = 0;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setInterval> | null = null;
  let currentAc: AbortController | null = null;
  /** 最后一次收到任何字节的时刻（含心跳注释行）；看门狗据此判活。 */
  let lastByteAt = 0;

  const clearStall = () => {
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
  };

  const scheduleReconnect = (reason: string) => {
    if (handle.closed) return;
    clearStall();
    attempt++;
    const delay = Math.min(15000, 2000 * attempt);
    console.warn(`[web-sse] 连接中断（${reason}），${delay / 1000}s 后第 ${attempt} 次重连`);
    // 断连状态反馈到渲染层（pi:sse_state 仅 Web 发出；渲染层可选订阅显示重连横条）
    send("pi:sse_state", { state: "reconnecting", reason, attempt });
    retryTimer = setTimeout(connect, delay);
  };

  const connect = () => {
    if (handle.closed) return;
    const ac = new AbortController(); // 每次（重）连独立：上一轮的 abort 不该污染这一轮
    currentAc = ac;
    lastByteAt = Date.now();
    clearStall();
    // 看门狗：每 5s 检查一次「距上次收到字节是否已超阈值」；超时即 abort 交给既有重连路径
    stallTimer = setInterval(() => {
      if (handle.closed) {
        clearStall();
        return;
      }
      if (Date.now() - lastByteAt <= SSE_STALL_TIMEOUT_MS) return;
      console.warn(
        `[web-sse] ${SSE_STALL_TIMEOUT_MS / 1000}s 未收到任何数据（含心跳），判定流已静默停摆，强制重连`
      );
      clearStall(); // 先停表，避免 abort 报错前又触发一次
      ac.abort(); // → reader.read() 抛 AbortError → catch 分支 scheduleReconnect（带 lastEventId 续传）
    }, 5000);
    (async () => {
      try {
        let url = buildUrl();
        if (lastEventId > 0) url += `${url.includes("?") ? "&" : "?"}lastEventId=${lastEventId}`;
        const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream" } });
        if (!res.ok || !res.body) {
          if (res.status === 401 || res.status === 403) {
            // 登录态失效：重连无意义，交由上层提示（渲染层会弹错误气泡），流终止
            onError?.(`流连接失败（HTTP ${res.status}）：登录态可能已失效，请重新登录`);
            clearStall();
            handle.closed = true;
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        attempt = 0; // 连接成功，重置退避
        send("pi:sse_state", { state: "connected" }); // 重连恢复后通知渲染层撤横条（首次建连也发，UI 幂等）
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!handle.closed) {
          const { value, done } = await reader.read();
          if (done) break;
          // ① 任何字节（含 15s `: ping` 心跳注释行）都算「连接活着」——静默停摆由此可被判出
          lastByteAt = Date.now();
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
        if (handle.closed) return; // 手动 close 触发的 abort，不重连
        scheduleReconnect((err as Error).message ?? "未知错误");
      }
    })();
  };

  connect();

  handle.close = () => {
    handle.closed = true;
    clearStall();
    if (retryTimer) clearTimeout(retryTimer);
    currentAc?.abort();
  };
  return handle;
}

// ---------------------------------------------------------------------------
// 流管理（ipc-handlers.ts agentStreams / ensureChildStream / ensureParentStream 移植）
// ---------------------------------------------------------------------------

const agentStreams = new Map<string, StreamHandle>();

/** Web 版孩子流 caps：无 electron 能位（Electron 客户端只传 material-panel；Web 麦克风可用）。 */
const CHILD_STREAM_CAPS = "material-panel,mic";

/**
 * 订阅某孩子的服务端 agent 事件流（懒建；同一 childId 复用，永久失败/关闭后重建）。
 * 事件经 bridgeChildAgentEvents（pi:* 通道 + 轮末缓冲）与 routeSceneEvent（场景收集器）派发。
 * 永久失败（401/403）时发 pi:reply_error + pi:reply_end（渲染层弹错误气泡并解禁忙碌态）。
 */
export function ensureChildStream(childId: string): void {
  const key = `child:${childId}`;
  const existing = agentStreams.get(key);
  if (existing && !existing.closed) return;
  if (existing) agentStreams.delete(key);
  agentStreams.set(
    key,
    openSse(
      () =>
        `${apiUrl(`/agent/${encodeURIComponent(childId)}/stream`)}?caps=${encodeURIComponent(
          CHILD_STREAM_CAPS
        )}&token=${encodeURIComponent(sessionToken())}`,
      (e) => {
        bridgeChildAgentEvents(e, childId);
        routeSceneEvent(childId, e);
      },
      (err) => {
        send("pi:reply_error", { childId, error: err });
        send("pi:reply_end", { childId });
        for (const c of sceneCollectors.get(childId) ?? []) c.onError(err);
      }
    )
  );
}

/** 订阅家长 agent 事件流（kind = "parent" | "parent-content"；家长流无 page/display 事件）。 */
export function ensureParentStream(kind: ParentKind): void {
  const key = `parent:${kind}`;
  const existing = agentStreams.get(key);
  if (existing && !existing.closed) return;
  if (existing) agentStreams.delete(key);
  agentStreams.set(
    key,
    openSse(
      () =>
        `${apiUrl("/parent-agent/stream")}?kind=${encodeURIComponent(kind)}&token=${encodeURIComponent(
          sessionToken()
        )}`,
      (e) => bridgeParentAgentEvents(e, kind),
      (err) => {
        send("pi:reply_error", { childId: kind, error: err });
        send("pi:reply_end", { childId: kind });
      }
    )
  );
}

/** 关闭某孩子的流（页面切走/登出时可显式释放；服务端会话持久，重进会自动重建）。 */
export function disposeChild(childId: string): void {
  const key = `child:${childId}`;
  const h = agentStreams.get(key);
  if (h) {
    h.close();
    agentStreams.delete(key);
  }
}

/** 关闭某 kind 的家长流。 */
export function disposeParent(kind: ParentKind): void {
  const key = `parent:${kind}`;
  const h = agentStreams.get(key);
  if (h) {
    h.close();
    agentStreams.delete(key);
  }
}

/** 关闭全部流（页面卸载/登出时调用；install.ts 接线 beforeunload）。 */
export function closeAllSseStreams(): void {
  for (const h of agentStreams.values()) h.close();
  agentStreams.clear();
  turnTextBuffers.clear();
  sceneCollectors.clear();
}
