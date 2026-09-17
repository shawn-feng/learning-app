/**
 * agents 域（Phase 4 实现）：pi 与 scene 事件订阅、agent 会话控制
 * （start/prompt/abort/reset/dispose）、page bridge 三件套、token 统计、
 * 孩子/家长 AGENTS.md 编辑。签名逐条摘自 electron/preload.ts。
 *
 * 实现口径（对齐 ipc-handlers.ts 的同名 IPC 通道 + server-agent-client.ts 的服务端调用）：
 *  - SSE 流：core/sse.ts（ensureChildStream/ensureParentStream，事件翻译 + 轮末缓冲）；
 *  - pi:prompt 等动作：POST /api/v1/agent|parent-agent/*（http()，Bearer 鉴权）；
 *  - 订阅：eventBus.on(<ipc 通道名>)，回调收到的 payload 与 Electron webContents.send 一致；
 *    piRemoveListeners 统一退订本域注册的全部监听（对齐 preload.registerListener + listenerWrappers，
 *    含 class:reminder——Electron 的 piRemoveListeners 同样退订该通道，见 preload.ts:65-72）。
 *  - 聊天附件（saveUpload 等 6 方法）：Web 走服务端 /files/upload + /files/:id（详见下方块注释）。
 *    domains/files.ts 里的同名 stub 由本域按 install.ts 展开顺序覆盖（agents 展开在后）。
 */
import { eventBus } from "../core/event-bus";
import { http, httpBinary, uploadMultipart, apiUrl, getStoredParentId, getStoredToken } from "../core/server-fetch";
import {
  ensureChildStream,
  ensureParentStream,
  addSceneCollector,
  removeSceneCollector,
  type ParentKind,
} from "../core/sse";
import { queuePageEvent, takePendingPageEvents } from "../core/page-events";

// ---------------------------------------------------------------------------
// 事件订阅（main -> renderer）：preload.registerListener 的 Web 等价物
// ---------------------------------------------------------------------------

/** 本域注册的全部退订函数（piRemoveListeners 一次性清除，对齐 preload.listenerWrappers）。 */
const listenerOffs = new Set<() => void>();

function subscribe(channel: string, callback: (data?: any) => void): () => void {
  const off = eventBus.on(channel, callback);
  listenerOffs.add(off);
  // 返回退订函数：preload 的 onXxx 返回 void，多返回一个函数是超集兼容（Learn 不消费返回值）
  return off;
}

// ---------------------------------------------------------------------------
// 会话历史映射（server-agent-client.ts mapHistoryMessages 移植）
// ---------------------------------------------------------------------------

export interface HistoryMessage {
  role: "user" | "ai";
  text: string;
  time?: string;
  thinking?: string;
  tools?: Array<{
    id: string;
    name: string;
    argsPreview?: string;
    status: "running" | "done" | "error";
    resultPreview?: string;
  }>;
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
 * 会话消息 timestamp（服务端为 ISO 字符串 / ms 数字）→「MM-DD HH:mm」展示标签。
 * 与渲染层 nowLabel() 同格式；取不出有效时间返回 undefined（渲染层自行兜底 now）。
 */
function historyTimeLabel(ts: unknown): string | undefined {
  const ms = typeof ts === "string" ? Date.parse(ts) : typeof ts === "number" ? ts : NaN;
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 把服务端会话原始消息映射成前端气泡恢复用的 HistoryMessage（user/assistant 正文与思考；工具气泡不恢复）。 */
function mapHistoryMessages(raw: Array<{ role: string; content: unknown[]; timestamp?: number | string }>): HistoryMessage[] {
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

// ---------------------------------------------------------------------------
// 服务端 agent 调用（server-agent-client.ts 的 prompt/abort/open/reset/pageResult 移植）
// ---------------------------------------------------------------------------

/** 提交孩子一轮输入（服务端受理即返回，增量走 SSE；session: main / scene / course:<key>）。 */
async function promptChild(
  childId: string,
  text: string,
  opts: { session?: string; images?: Array<{ type: "image"; mimeType: string; data: string }>; pageEvents?: string } = {}
): Promise<void> {
  await http(`/agent/${encodeURIComponent(childId)}/prompt`, {
    method: "POST",
    // ipc pi:prompt 不传 pageEvents（渲染层已把页面操作拼进正文），此处保持一致
    body: { text, session: opts.session ?? "main", pageEvents: opts.pageEvents, images: opts.images },
    timeoutMs: 120000,
  });
}

/** 提交家长一轮输入（kind = parent | parent-content；ipc 不随 prompt 上送图片——家长识图走服务端 parent_read_image 工具）。 */
async function promptParent(text: string, opts: { kind?: ParentKind } = {}): Promise<void> {
  await http("/parent-agent/prompt", {
    method: "POST",
    body: { text, kind: opts.kind ?? "parent" },
    timeoutMs: 120000,
  });
}

/** 中止孩子 agent 当前一轮（session 省略 = 该孩子全部会话；结束经 SSE turn_end 推送）。 */
async function abortChildAgent(childId: string): Promise<void> {
  await http(`/agent/${encodeURIComponent(childId)}/abort`, { method: "POST", body: { session: undefined }, timeoutMs: 30000 });
}

/** 中止家长 agent 当前一轮。 */
async function abortParentAgent(kind: ParentKind = "parent"): Promise<void> {
  await http("/parent-agent/abort", { method: "POST", body: { kind }, timeoutMs: 30000 });
}

/** 打开孩子会话（服务端按落盘会话最后一条消息日期裁决跨天自动新建，返回裁决后的当天历史）。 */
async function openChildSession(childId: string, session?: string): Promise<HistoryMessage[]> {
  const r = await http<{ messages: Array<{ role: string; content: unknown[]; timestamp?: number | string }> }>(
    `/agent/${encodeURIComponent(childId)}/open`,
    { method: "POST", body: { session: session ?? "main" } }
  );
  return mapHistoryMessages(r.messages ?? []);
}

/** 重置孩子会话（服务端 newSession）。 */
async function resetChildSession(childId: string): Promise<void> {
  await http(`/agent/${encodeURIComponent(childId)}/reset`, { method: "POST", body: { session: undefined } });
}

/** 重置家长会话。 */
async function resetParentSession(kind: ParentKind): Promise<void> {
  await http("/parent-agent/reset", { method: "POST", body: { kind } });
}

/** 资料页受控操作回执上行（page_cmd 的 requestId 配对；否则服务端工具等到 10s 超时）。 */
async function postPageResult(
  childId: string,
  requestId: string,
  result: { ok: boolean; error?: string; data?: unknown }
): Promise<void> {
  await http(`/agent/${encodeURIComponent(childId)}/page-result`, {
    method: "POST",
    body: { requestId, ok: result.ok, error: result.error, data: result.data },
  });
}

/** ipc-handlers.ts friendlyError 逐行移植：网络类错误归一为友好提示。 */
function friendlyError(msg: string): string {
  const m = (msg || "").toLowerCase();
  if (/(connection|fetch|network|timeout|econnrefused|enotfound|econnreset|abort|socket|unreachable)/.test(m)) {
    return "网络连接失败，请检查网络后重试";
  }
  return msg || "模型调用失败";
}

// ---------------------------------------------------------------------------
// 聊天附件上传（ISSUE-008/036/044/078 的 Web 实现）
// ---------------------------------------------------------------------------
// Electron：落客户端本地盘 data/children|parents/<id>/uploads/<时间戳>-<名>，返回相对 data/ 的 path。
// Web：无本地盘，改走服务端大文件通道 POST /files/upload（multipart，可带 child_id 关联）
// + GET /files/:id（阶段 0 已支持 ?token= 认证）。服务端把文件存到
// <dataDir>/files/<登录家长>/<fileId><ext>（routes/files.ts），因此：
//  - saveUpload/saveParentUpload 返回 path = files/<登录家长>/<fileId><ext>（服务端 dataDir 相对路径，
//    即真实落盘位置）。家长 agent 的 parent_read_image 明确支持 files/ 前缀（server parent-tools.ts:721），
//    附件标记【附件图片：名|path】服务端可直接读到——比 Electron 落本地盘（服务端 agent 读不到
//    客户端路径，家长识图链路本就断）更完整；孩子/场景会话在两个客户端里都读不到聊天附件
//    （服务端工作区是 workspaces/<pid>/<cid>），无差异。
//  - readUpload/readParentUpload：从 path 末段解出 fileId 回读（base64），供历史消息播放语音录音。
//  - openUpload/openParentUpload：Web 无「本地默认程序」，等价动作为新标签页打开
//    /files/:id?token=（浏览器按 Content-Type 渲染/下载）。

/** 服务端 safeExt 同款扩展名白名单（routes/files.ts），保证返回 path 的扩展名与真实落盘一致。 */
function uploadExt(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0) return ""; // 无扩展名；".webm" 这类 leading-dot 文件 path.extname 也返回 ""
  const ext = name.slice(i).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

/** 从 files/<pid>/<fileId><ext> 形态的 path 解出 /files/:id 的 fileId（末段去扩展名）。 */
function fileIdFromPath(relPath: string): string {
  const base = String(relPath ?? "").split("/").pop() ?? "";
  return base.replace(/\.[a-z0-9]{1,10}$/i, "");
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000; // 分块拼接，避免超长实参超限
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** 附件落服务端：multipart 上传 → 返回 {success, path, size}（对齐 file:save_upload 的返回形状）。 */
async function saveChatUpload(
  childId: string | null,
  name: string,
  mime: string,
  data: ArrayBuffer
): Promise<{ success: boolean; path?: string; size?: number; error?: string }> {
  try {
    const file = new File([data], name || "file", { type: mime || "application/octet-stream" });
    const r = await uploadMultipart<{ file: { id: string } }>(
      "/files/upload",
      file,
      childId ? { child_id: childId } : {}
    );
    return {
      success: true,
      path: `files/${getStoredParentId()}/${r.file?.id ?? ""}${uploadExt(name || "file")}`,
      size: data.byteLength,
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 附件回读（对齐 file:read_upload 的返回形状 {success, data(base64)}）。 */
async function readChatUpload(relPath: string): Promise<{ success: boolean; data?: string; error?: string }> {
  try {
    const id = fileIdFromPath(relPath);
    if (!id) return { success: false, error: "非法路径" };
    const buf = await httpBinary(`/files/${encodeURIComponent(id)}`);
    return { success: true, data: arrayBufferToBase64(buf) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 附件打开（对齐 file:open_upload 的语义：Web 用新标签页替代本地默认程序）。 */
function openChatUpload(relPath: string): { success: boolean; error?: string } {
  const id = fileIdFromPath(relPath);
  if (!id) return { success: false, error: "非法路径" };
  const token = getStoredToken();
  window.open(`${apiUrl(`/files/${encodeURIComponent(id)}`)}?token=${encodeURIComponent(token)}`, "_blank");
  return { success: true };
}

// ---------------------------------------------------------------------------
// 在途守卫（ipc-handlers.ts：只防「上一轮未结束时重复发送」，与 abort 解耦）
// ---------------------------------------------------------------------------

let childBusy = false;
let parentBusy = false;
let parentContentBusy = false;

// ---------------------------------------------------------------------------
// materialsLimit（Electron 读本地 app-settings.json，默认 20，真源在服务端 app_settings；
// Web 无本地文件，best-effort 拉一次服务端 /models/settings，失败回退 20）
// ---------------------------------------------------------------------------

const DEFAULT_MATERIALS_LIMIT = 20;
let materialsLimitCache: number | null = null;

async function fetchMaterialsLimit(): Promise<number> {
  if (materialsLimitCache != null) return materialsLimitCache;
  try {
    const r = await http<{ appSettings?: Record<string, unknown> }>("/models/settings");
    const n = Number(r?.appSettings?.materialsLimit);
    materialsLimitCache = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MATERIALS_LIMIT;
  } catch {
    materialsLimitCache = DEFAULT_MATERIALS_LIMIT;
  }
  return materialsLimitCache;
}

// ---------------------------------------------------------------------------
// AGENTS.md 用户可编辑版本（db RPC：agents.get/save/history/restore，同 ipc agent-prompts.ts）
// ---------------------------------------------------------------------------

async function dbQuery<T>(op: string, args: Record<string, unknown>): Promise<T> {
  const r = await http<{ result: T }>("/db/query", { method: "POST", body: { op, args } });
  return r.result;
}

async function dbExec<T>(op: string, args: Record<string, unknown>): Promise<T> {
  const r = await http<{ result: T }>("/db/exec", { method: "POST", body: { op, args } });
  return r.result;
}

export const agentsDomain = {
  // ---- pi 事件（main -> renderer；core/sse.ts 翻译层 emit → 这里订阅） ----

  /** onPiStreaming: (callback: (data: { childId: string; delta?: string; thinkingDelta?: string }) => void) => void */
  onPiStreaming: (callback: (data: { childId: string; delta?: string; thinkingDelta?: string }) => void) =>
    subscribe("pi:streaming", callback),

  /** onPiThinking: (callback: (data: { childId: string; delta: string; complete?: boolean }) => void) => void（message_end 思考补发带 complete=true） */
  onPiThinking: (callback: (data: { childId: string; delta: string }) => void) => subscribe("pi:thinking", callback),

  /** onPiToolStart: (callback: (data: { childId, toolCallId, toolName, argsPreview }) => void) => void */
  onPiToolStart: (callback: (data: any) => void) => subscribe("pi:tool_start", callback),

  /** onPiToolEnd: (callback: (data: any) => void) => void */
  onPiToolEnd: (callback: (data: any) => void) => subscribe("pi:tool_end", callback),

  /** onPiAgentEnd: (callback: (data: { childId: string }) => void) => void */
  onPiAgentEnd: (callback: (data: { childId: string }) => void) => subscribe("pi:agent_end", callback),

  /** onPiMessageEnd: (callback: (data: any) => void) => void */
  onPiMessageEnd: (callback: (data: any) => void) => subscribe("pi:message_end", callback),

  /** onPiError: (callback: (error: string) => void) => void —— 运行时回调实收 { childId, error }（与 ipc webContents.send 载荷一致，preload 类型注解如此） */
  onPiError: (callback: (error: string) => void) => subscribe("pi:error", callback),

  /** onPiReply: (callback: (data: { childId: string; text: string }) => void) => void */
  onPiReply: (callback: (data: { childId: string; text: string }) => void) => subscribe("pi:reply", callback),

  /** onPiReplyEnd: (callback: (data: { childId: string }) => void) => void */
  onPiReplyEnd: (callback: (data: { childId: string }) => void) => subscribe("pi:reply_end", callback),

  /** onPiReplyError: (callback: (data: { childId: string; error: string }) => void) => void */
  onPiReplyError: (callback: (data: { childId: string; error: string }) => void) => subscribe("pi:reply_error", callback),

  /** onPiSseState: (callback: (data: { state: "connected" | "reconnecting"; reason?: string; attempt?: number }) => void) => void
   *  —— Web 专属扩展（Electron preload 无此方法，渲染层用可选调用 + __web 守卫）：
   *  agent SSE 流断连/恢复的状态播报，供聊天界面显示「连接已断开，正在重连」横条。 */
  onPiSseState: (callback: (data: { state: "connected" | "reconnecting"; reason?: string; attempt?: number }) => void) =>
    subscribe("pi:sse_state", callback),

  /** onPiDisplayContent: (callback: (data: { childId: string; path: string; title?: string; source?: string; content?: string }) => void) => void —— 服务端 agent 的 display_content 推送（正文 content 已内联，透传无落盘改写） */
  onPiDisplayContent: (callback: (data: {
    childId: string;
    path: string;
    title?: string;
    source?: string;
    content?: string;
  }) => void) => subscribe("pi:display_content", callback),

  // ---- 场景对话（scene agent）事件（ISSUE-061；scene 会话与主会话共用孩子流，scenePrompt 期间由收集器回发） ----

  /** onSceneReply: (callback: (data: { childId: string; courseKey: string; text: string }) => void) => void */
  onSceneReply: (callback: (data: { childId: string; courseKey: string; text: string }) => void) =>
    subscribe("scene:reply", callback),

  /** onSceneReplyEnd: (callback: (data: { childId: string; courseKey: string }) => void) => void */
  onSceneReplyEnd: (callback: (data: { childId: string; courseKey: string }) => void) =>
    subscribe("scene:reply_end", callback),

  /** onSceneReplyError: (callback: (data: { childId: string; courseKey: string; error: string }) => void) => void */
  onSceneReplyError: (callback: (data: { childId: string; courseKey: string; error: string }) => void) =>
    subscribe("scene:reply_error", callback),

  /** onPiSessionReset: (callback: (data: { childId: string }) => void) => void（Electron 由 scheduler 定时重置后广播；Web 由 scheduler 域提醒轮询 emit） */
  onPiSessionReset: (callback: (data: { childId: string }) => void) => subscribe("pi:session_reset", callback),

  /**
   * onClassReminder: (callback: (data: { childId; type: "start"|"end"|"custom"; label; mode? }) => void) => void
   * （ISSUE-019/047 课程时间段提醒 + 孩子自建提醒。Electron 里本通道由 preload.registerListener 注册、
   * piRemoveListeners 一并退订，故订阅归入本域 listenerOffs——Learn 每次挂载都重新注册、卸载时
   * piRemoveListeners 清场，若无人退订会重复回调。事件源是 scheduler 域的提醒轮询 emit，
   * scheduler 域虽有同名订阅入口，但未纳入任何退订清单；本域展开于其后按序覆盖，保证退订语义与 preload 一致。）
   */
  onClassReminder: (callback: (data: {
    childId: string;
    type: "start" | "end" | "custom";
    label: string;
    mode?: "both" | "chime" | "voice";
  }) => void) => subscribe("class:reminder", callback),

  /** onPiVisionModelSwitched: (callback: (data: { childId: string; modelId: string }) => void) => void（Electron 主进程当前亦无发射点，预留订阅） */
  onPiVisionModelSwitched: (callback: (data: { childId: string; modelId: string }) => void) =>
    subscribe("pi:vision_model_switched", callback),

  // ---- page bridge（iframe 学习资料感知与操作） ----

  /** pageEvent: (childId: string, event: any) => Promise<{ok} | {ok:false,error}> —— 上行事件入本地环形缓冲（对齐 ipc pi:page:event：不转发服务端） */
  pageEvent: async (childId: string, event: any) => {
    try {
      queuePageEvent(childId ?? "", event ?? {});
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  /** pageTakePending: (childId: string) => Promise<{ text: string }> —— 取走待随下一轮消息附带的页面操作（发送后即清空，ISSUE-015；渲染层拼「[页面操作] …」前缀） */
  pageTakePending: async (childId: string) => {
    return { text: takePendingPageEvents(childId ?? "") };
  },

  /** pageExecResult: (childId: string, requestId: string, result: any) => Promise<{ok:true}> —— page_cmd 回执 POST /page-result（服务端按 requestId 配对） */
  pageExecResult: async (childId: string, requestId: string, result: any) => {
    // Electron 侧另有本地 resolvePageAction 配对（主进程自发指令）；Web 无本地工具场景，
    // 服务端下发的受控操作回执是唯一路径——失败静默（渲染层注释：主进程/服务端侧有超时兜底）。
    if (requestId) {
      void postPageResult(childId ?? "", requestId, result ?? { ok: true }).catch(() => {});
    }
    return { ok: true };
  },

  /** onPageExec: (callback: (data: { childId: string; requestId: string; action: string; params: any }) => void) => void —— 下行指令监听（Learn.handlePageExec → panel.exec → pageExecResult 闭环） */
  onPageExec: (callback: (data: {
    childId: string;
    requestId: string;
    action: string;
    params: any;
  }) => void) => subscribe("pi:page:exec", callback),

  /** piRemoveListeners: () => void —— 退订本域注册的全部 pi/scene/page 监听（对齐 preload.listenerWrappers 清空；window 与 scheduler 域各自管理自己的订阅） */
  piRemoveListeners: () => {
    for (const off of listenerOffs) off();
    listenerOffs.clear();
  },

  // ---- pi actions（renderer -> main） ----

  /** piStartChild: (childId: string, courseKey?: string) => Promise<{success, history, materials, materialsLimit}> —— 建流 + POST /open 跨天裁决回填当天历史；courseKey → course:<key> 子会话 */
  piStartChild: async (childId: string, courseKey?: string) => {
    try {
      // 薄客户端：建立服务端 agent 事件流（SSE → pi:* 通道），会话由服务端持久管理
      ensureChildStream(childId);
      // 会话历史回填（ISSUE-100 F1 冷路径：走 /open，服务端跨天自动新建裁决后返回当天历史）
      const session = courseKey ? `course:${courseKey}` : "main";
      const history = await openChildSession(childId, session === "main" ? undefined : session).catch(
        () => [] as HistoryMessage[]
      );
      // ISSUE-041 云端收件箱（handleCloudInbox）是 Electron 主进程本地投递层，Web 无此层，跳过（差异声明见文件头）
      // 历史与资料由服务端会话/display_content 推送驱动；materials 返回空（与 ipc 一致）
      return { success: true, history, materials: [], materialsLimit: await fetchMaterialsLimit() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** piStartParent: () => Promise<{success, history}> */
  piStartParent: async () => {
    try {
      ensureParentStream("parent");
      return { success: true, history: [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** piPrompt: (childId, text, images?, courseKey?) => Promise<{success}> —— images 为内联 base64（dataURL 剥前缀后），courseKey → course:<key> 会话 */
  piPrompt: async (
    childId: string,
    text: string,
    images?: Array<{ type: "image"; mimeType: string; data: string }> | null,
    courseKey?: string
  ) => {
    // 在途守卫：上一轮未结束时拒绝（服务端也会 409 busy，这里给友好提示）
    if (childBusy) {
      return { success: false, error: "上一条消息还在收尾或停止中，请稍候再发。" };
    }
    childBusy = true;
    try {
      ensureChildStream(childId);
      const session = courseKey ? `course:${courseKey}` : "main";
      await promptChild(childId, text, { session, images: images ?? undefined });
      return { success: true };
    } catch (err) {
      eventBus.emit("pi:reply_error", { childId, error: friendlyError((err as Error).message) });
      eventBus.emit("pi:reply_end", { childId });
      return { success: false, error: (err as Error).message };
    } finally {
      childBusy = false;
    }
  },

  // ---- 聊天附件上传（preload 与 piPrompt/piPromptParent 同段；实现方案见上方块注释）----

  /** saveUpload: (childId, name, mime, data) => Promise<{success, path, size}> —— 落服务端 files 通道（对齐 file:save_upload 返回形状；path 为服务端 dataDir 相对路径） */
  saveUpload: (childId: string, name: string, mime: string, data: ArrayBuffer) => saveChatUpload(childId, name, mime, data),

  /** openUpload: (childId, relPath) => Promise<{success}> —— Web 无本地默认程序，等价动作为新标签页打开 /files/:id?token= */
  openUpload: async (childId: string, relPath: string) => {
    void childId; // Electron 用 childId 定位本地 uploads 目录；Web path 自带归属，无需区分
    return openChatUpload(relPath);
  },

  /** readUpload: (childId, relPath) => Promise<{success, data}> —— base64 回读（历史消息播放语音录音） */
  readUpload: async (childId: string, relPath: string) => {
    void childId;
    return readChatUpload(relPath);
  },

  /** saveParentUpload: (parentId, name, mime, data) => Promise<{success, path, size}>（ISSUE-044；Web 统一落服务端 files 通道，归属=登录家长） */
  saveParentUpload: (parentId: string, name: string, mime: string, data: ArrayBuffer) => {
    void parentId; // 服务端按 token 里的 parentId 落盘（<dataDir>/files/<parentId>/），渲染层传参仅展示用
    return saveChatUpload(null, name, mime, data);
  },

  /** openParentUpload: (parentId, relPath) => Promise<{success}> */
  openParentUpload: async (parentId: string, relPath: string) => {
    void parentId;
    return openChatUpload(relPath);
  },

  /** readParentUpload: (parentId, relPath) => Promise<{success, data}> */
  readParentUpload: async (parentId: string, relPath: string) => {
    void parentId;
    return readChatUpload(relPath);
  },

  /** piPromptParent: (text: string, images?) => Promise<{success}>（ISSUE-037；ipc 不随 prompt 上送图片——家长识图走服务端工具，此处同样忽略 images） */
  piPromptParent: async (text: string, images?: Array<{ type: "image"; mimeType: string; data: string }>) => {
    void images;
    if (parentBusy) {
      return { success: false, error: "上一条消息还在收尾或停止中，请稍候再发。" };
    }
    parentBusy = true;
    try {
      ensureParentStream("parent");
      await promptParent(text, { kind: "parent" });
      return { success: true };
    } catch (err) {
      eventBus.emit("pi:reply_error", { childId: "parent", error: friendlyError((err as Error).message) });
      eventBus.emit("pi:reply_end", { childId: "parent" });
      return { success: false, error: (err as Error).message };
    } finally {
      parentBusy = false;
    }
  },

  /** piStartParentContent: () => Promise<{success, history}>（教学内容生成专用会话，ISSUE-026） */
  piStartParentContent: async () => {
    try {
      ensureParentStream("parent-content");
      return { success: true, history: [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** piPromptParentContent: (text: string) => Promise<{success}> */
  piPromptParentContent: async (text: string) => {
    if (parentContentBusy) {
      return { success: false, error: "上一条消息还在收尾或停止中，请稍候再发。" };
    }
    parentContentBusy = true;
    try {
      ensureParentStream("parent-content");
      await promptParent(text, { kind: "parent-content" });
      return { success: true };
    } catch (err) {
      eventBus.emit("pi:reply_error", { childId: "parent-content", error: friendlyError((err as Error).message) });
      eventBus.emit("pi:reply_end", { childId: "parent-content" });
      return { success: false, error: (err as Error).message };
    } finally {
      parentContentBusy = false;
    }
  },

  /** piAbort: (childId: string) => Promise<{success}> —— childId 为 "parent"/"parent-content" 时中止家长会话，否则全量中止该孩子会话 */
  piAbort: async (childId: string) => {
    try {
      if (childId === "parent" || childId === "parent-content") {
        await abortParentAgent(childId);
      } else {
        await abortChildAgent(childId);
      }
      return { success: true };
    } catch (err) {
      // 中止失败仅记录：前端已有「已停止」UI + 5s 兜底解禁，不阻塞渲染层
      console.error(`[web-shim piAbort] 中止失败（${childId}）:`, (err as Error).message);
      return { success: false, error: (err as Error).message };
    }
  },

  /** piDispose: (childId: string) => Promise<{success}> —— 薄客户端：服务端会话持久、由服务端管理生命周期，无需显式释放（SSE 流保留复用，与 ipc 行为一致） */
  piDispose: async (_childId: string) => {
    return { success: true };
  },

  /** piReset: (childId: string) => Promise<{success, history, materials}>（/reset 命令用；服务端 newSession） */
  piReset: async (childId: string) => {
    try {
      await resetChildSession(childId);
      return { success: true, history: [], materials: [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** piResetParent: () => Promise<{success, history}>（ISSUE-042） */
  piResetParent: async () => {
    try {
      await resetParentSession("parent");
      return { success: true, history: [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  // ---- 场景对话（scene agent）调用（ISSUE-061；scene 子会话 session="scene"，与课程会话解耦） ----

  /** scenePrompt: (childId, courseKey, text) => Promise<{success}> —— 挂收集器 → POST prompt(session=scene)；本轮结束把 say 台词/兜底正文回发 scene:reply* */
  scenePrompt: async (childId: string, courseKey: string, text: string) => {
    ensureChildStream(childId);
    // Electron 此处另有 sceneTryPrewarm（edge-tts 台词后台预热）——Web 语音属 Phase 5，此处跳过
    // 场景台词收集器：挂到孩子流上，本轮结束时把「say 台词 / 兜底正文」一次性回发 scene:reply。
    const lines: Array<{ speaker: string; text: string }> = [];
    const texts: string[] = [];
    const collector = {
      onSay: (speaker: string, t: string) => lines.push({ speaker, text: t }),
      onText: (t: string) => texts.push(t),
      onEnd: () => {
        if (lines.length) {
          eventBus.emit("scene:reply", {
            childId,
            courseKey,
            text: lines.map((l) => `${l.speaker} ${l.text}`.trim()).join("\n"),
          });
        } else if (texts.length) {
          for (const t of texts) eventBus.emit("scene:reply", { childId, courseKey, text: t });
        }
        eventBus.emit("scene:reply_end", { childId, courseKey });
      },
      onError: (err: string) => {
        eventBus.emit("scene:reply_error", { childId, courseKey, error: err });
        eventBus.emit("scene:reply_end", { childId, courseKey });
      },
    };
    addSceneCollector(childId, collector);
    try {
      await promptChild(childId, text, { session: "scene" });
      return { success: true };
    } catch (err) {
      eventBus.emit("scene:reply_error", { childId, courseKey, error: friendlyError((err as Error).message) });
      eventBus.emit("scene:reply_end", { childId, courseKey });
      return { success: false, error: (err as Error).message };
    } finally {
      removeSceneCollector(childId, collector);
    }
  },

  /** sceneHistory: (childId, courseKey) => Promise<{success, history}> —— 走 /open（scene 会话当天历史，取末 80 条） */
  sceneHistory: async (childId: string, _courseKey: string) => {
    try {
      const history = await openChildSession(childId, "scene").catch(() => [] as HistoryMessage[]);
      return { success: true, history: history.slice(-80) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** scenePrepare: (childId, courseKey) => Promise<{success}> —— 场景页就绪后预建流（会话在服务端；TTS 预热属 Phase 5） */
  scenePrepare: async (childId: string, _courseKey: string) => {
    try {
      ensureChildStream(childId);
      return { success: true };
    } catch (err) {
      console.error("[web-shim scenePrepare] 失败:", (err as Error).message);
      return { success: false, error: String((err as Error).message) };
    }
  },

  /** sceneStop: (childId, courseKey) => Promise<{success}> —— 服务端会话持久，无需显式释放 */
  sceneStop: async (_childId: string, _courseKey: string) => {
    return { success: true };
  },

  /** sceneTransfer: (childId, courseKey) => Promise<{success}> —— 孩子离开场景时向课程会话注入收尾指令（与 ipc 同款文案；逐字摘要待服务端场景摘要能力） */
  sceneTransfer: async (childId: string, courseKey: string) => {
    try {
      const inject =
        `[系统] 孩子刚刚结束了场景英语的场景互动。请你用在场景里陪伴孩子的角色口吻，` +
        `给孩子一句简短收尾（英文为主、可带一句中文，不要总结式说教）。`;
      await promptChild(childId, inject, { session: `course:${courseKey}` });
      return { success: true };
    } catch (err) {
      console.error(`[web-shim sceneTransfer] error:`, (err as Error).message);
      eventBus.emit("pi:reply_error", { childId, error: friendlyError((err as Error).message) });
      eventBus.emit("pi:reply_end", { childId });
      return { success: false, error: (err as Error).message };
    }
  },

  /** sceneVoiceSave: (childId, data) => Promise<{success, path, rel}>（voice:scene_save）—— Electron 落本地
   *  children/<id>/voice/scene/<日期>/<HHMMSS>-<ts36>.webm（path 相对 data/、rel 相对孩子 cwd）；
   *  Web 走 /files/upload（child_id 关联），path/rel 同为服务端 files 通道相对路径。rel 仅供场景页的
   *  【附件音频】标记（Learn.handleSceneVoice）——与 Electron 相同，服务端场景会话读不到该路径，
   *  场景语音回放 v1 也不做（遗留差异如实声明）。 */
  sceneVoiceSave: async (childId: string, data: ArrayBuffer) => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    // 文件名对齐 ipc voice:scene_save：<时分秒>-<ts36>.webm（目录结构无法复刻，仅保留可读命名）
    const name = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Date.now().toString(36)}.webm`;
    const r = await saveChatUpload(childId, name, "audio/webm", data);
    return r.success ? { success: true, path: r.path, rel: r.path } : r;
  },

  // ---- token 统计（ISSUE-010）----
  // 数据源是 Electron 本地 data/children/<childId>/token-log.jsonl（token-stats.ts）；
  // Web 无本地文件且服务端未暴露统计端点 → 返回空结构（通道形状对齐 ipc token:summary / token:list）。

  /** getTokenSummary: (childId?: string) => Promise<{success, summary}>（childId 缺省为家长全局；Web 返回空汇总） */
  getTokenSummary: async (_childId?: string) => {
    return {
      success: true,
      summary: {
        rounds: 0,
        totalInput: 0,
        totalOutput: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        totalCost: 0,
        totalTokens: 0,
        lastTs: null,
        byModel: {} as Record<string, { rounds: number; input: number; output: number; cost: number }>,
      },
    };
  },

  /** getTokenList: (childId?: string, limit?: number) => Promise<{success, entries}>（Web 返回空列表） */
  getTokenList: async (_childId?: string, _limit?: number) => {
    return { success: true, entries: [] as unknown[] };
  },

  // ---- agent 会话历史 ----

  /** piListSessions: (childId: string) => Promise<{success, sessions}>（服务端历史会话列表未提供，ipc 亦返回空——联调点） */
  piListSessions: async (_childId: string) => {
    return { success: true, sessions: [] as unknown[] };
  },

  /** piGetSessionMessages: (childId: string, file: string) => Promise<{success, messages}>（服务端历史逐字稿未提供，ipc 亦返回空——联调点） */
  piGetSessionMessages: async (_childId: string, _file: string) => {
    return { success: true, messages: [] as unknown[] };
  },

  // ---- AGENTS.md 编辑（服务端 agents 库 db RPC；ipc 侧经 agent-prompts.ts 同一 op） ----

  /** childGetAgentsMd: (childId: string) => Promise<{content, network}> —— 无用户版本时 ipc 回退主进程代码默认稿（getDefaultPrompt），Web 无法重建默认稿返回空串（渲染层当前未消费；遗留差异） */
  childGetAgentsMd: async (childId: string) => {
    try {
      const r = await dbQuery<{ content: string | null }>("agents.get", { scope: "child", ref: childId });
      return { content: r.content !== null ? r.content : "", network: false };
    } catch {
      return { content: "", network: true };
    }
  },

  /** childSaveAgentsMd: (childId: string, content: string) => Promise<{success}>（空内容=恢复默认） */
  childSaveAgentsMd: async (childId: string, content: string) => {
    try {
      await dbExec("agents.save", { scope: "child", ref: childId, content });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** agentsGet: (scope: string, ref: string) => Promise<{content, customized, network}> —— parent scope 的 ref 统一为当前登录家长 id */
  agentsGet: async (scope: string, ref: string) => {
    if (scope === "parent") ref = getStoredParentId();
    try {
      const r = await dbQuery<{ content: string | null }>("agents.get", { scope, ref });
      if (r.content !== null) return { content: r.content, customized: true, network: false };
      // 无用户版本：ipc 孩子侧回 getDefaultPrompt（代码默认稿）、家长侧返回空——Web 均返回空（无本地默认稿，遗留差异）
      return { content: "", customized: false, network: false };
    } catch {
      return { content: "", customized: false, network: true };
    }
  },

  /** agentsSave: (scope: string, ref: string, content: string) => Promise<{success}> */
  agentsSave: async (scope: string, ref: string, content: string) => {
    if (scope === "parent") ref = getStoredParentId();
    try {
      await dbExec("agents.save", { scope, ref, content });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** agentsHistory: (scope: string, ref: string) => Promise<{success, data}>（服务端按时间倒序，最新在前，最多 50 条） */
  agentsHistory: async (scope: string, ref: string) => {
    if (scope === "parent") ref = getStoredParentId();
    try {
      const data = await dbQuery<Array<{ content: string; updated: string }>>("agents.history", { scope, ref });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** agentsRestore: (scope: string, ref: string, updated: string) => Promise<{success, data:boolean}>（按 updated 定位历史版本回退） */
  agentsRestore: async (scope: string, ref: string, updated: string) => {
    if (scope === "parent") ref = getStoredParentId();
    try {
      const r = await dbExec<{ ok: boolean }>("agents.restore", { scope, ref, updated });
      return { success: true, data: r.ok === true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};
