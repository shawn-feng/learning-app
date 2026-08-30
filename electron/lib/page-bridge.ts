/**
 * iframe 学习资料 ↔ AI agent 双向通讯 —— 主进程桥接模块。
 *
 * 职责（上行感知 + 下行操作）：
 * - queuePageEvent：接收渲染层上报的互动事件 → 环形缓冲 + 600ms 批处理 →
 *   自然语言文本经 session.steer（运行中排队）/ followUp（空闲投递）注入 agent，不打断当前回答；
 * - executePageAction / resolvePageAction：agent 工具（page_action / page_inspect）调用时，
 *   经 transport 下发指令到渲染层 → iframe，requestId 配对等待回执（10s 超时）；
 * - recentInteractions：给 page_inspect 返回最近互动摘要。
 *
 * 本模块刻意不 import electron / pi-session（避免 custom-tools → page-bridge → pi-session
 * → custom-tools 循环依赖），依赖由 ipc-handlers 通过 setter 注入。
 */

export interface PageBridgeEvent {
  kind: string;
  ts?: number;
  title?: string;
  detail?: Record<string, unknown>;
}

export interface PageExecParams {
  action: "click" | "scroll" | "input" | "read";
  index?: number;
  text?: string;
  pct?: number;
  value?: string;
  maxDepth?: number;
  maxNodes?: number;
}

export interface PageExecResult {
  ok: boolean;
  error?: string;
  data?: unknown;
}

// —— setter 注入点（由 ipc-handlers 调用）——
type TransportFn = (
  childId: string,
  requestId: string,
  action: string,
  params: Record<string, unknown>
) => void | Promise<void>;
let pageExecTransport: TransportFn = () => {
  console.warn("[page-bridge] transport 未注入，下行指令被丢弃");
};

export function setPageExecTransport(fn: TransportFn): void {
  pageExecTransport = fn;
}

// —— 事件文本格式化（纯函数，便于单测）——
function shortText(v: unknown, max = 40): string {
  const s = String(v ?? "").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function formatPageEvent(evt: PageBridgeEvent): string {
  const d = (evt.detail || {}) as Record<string, any>;
  switch (evt.kind) {
    case "open":
      return evt.title ? `打开了资料「${shortText(evt.title, 30)}」` : "打开了学习资料页";
    case "click": {
      const label = d.text ? `「${shortText(d.text)}」` : "";
      const idx = typeof d.index === "number" ? `(索引 ${d.index})` : "";
      return `点击了元素${label}${idx}`;
    }
    case "scroll":
      return typeof d.pct === "number" ? `页面滚动至 ${Math.max(0, Math.min(100, d.pct))}%` : "滚动了页面";
    case "input": {
      const name = d.name ? `「${shortText(d.name)}」` : "";
      const val = d.value ? `，填入「${shortText(d.value, 30)}」` : "";
      return `在输入框${name}输入了内容${val}`;
    }
    case "submit":
      return "提交了表单";
    case "pagehide":
      return "离开了资料页面";
    default:
      return `有互动事件（${evt.kind}）`;
  }
}

/** 单条事件文本（缓冲与注入共用；注入时带 [页面事件] 前缀） */
export function eventText(evt: PageBridgeEvent): string {
  return formatPageEvent(evt);
}

// —— 每 childId 环形缓冲（容量 50，供 recentInteractions 与历史感知）——
export class PageEventBuffer {
  private items: Array<{ ts: number; text: string }> = [];
  constructor(private capacity: number = 50) {}

  push(text: string): void {
    this.items.push({ ts: Date.now(), text });
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }

  /** 最近 n 条合并文本（无则 null） */
  recent(n = 10): string | null {
    if (this.items.length === 0) return null;
    return this.items.slice(-n).map((it) => it.text).join("；");
  }

  get size(): number {
    return this.items.length;
  }
}

const buffers = new Map<string, PageEventBuffer>();
/** ISSUE-015：待随孩子下一轮消息附带的页面操作（按 childId；取走即清空） */
const pendingByChild = new Map<string, string[]>();
const RECENT_LIMIT = 50;

function bufferFor(childId: string): PageEventBuffer {
  let b = buffers.get(childId);
  if (!b) {
    b = new PageEventBuffer(RECENT_LIMIT);
    buffers.set(childId, b);
  }
  return b;
}

/**
 * 上行事件入口（渲染层 pi:page:event → 主进程）。
 * ISSUE-015：事件只入环形缓冲（供 page_inspect / recentInteractions 读）并累积到
 * pending 列表，**不再自动注入 agent**——随孩子下一轮消息（takePendingPageEvents）附带。
 */
export function queuePageEvent(childId: string, evt: PageBridgeEvent): void {
  const buf = bufferFor(childId);
  const text = eventText(evt);
  buf.push(text);

  let pending = pendingByChild.get(childId);
  if (!pending) {
    pending = [];
    pendingByChild.set(childId, pending);
  }
  pending.push(text);
}

/**
 * 取走并清空某孩子待附带的页面操作（孩子发消息时调用，附到下一轮消息开头；
 * 无 pending 返回空串）。环形缓冲不受影响（page_inspect 仍能看最近互动）。
 */
export function takePendingPageEvents(childId: string): string {
  const pending = pendingByChild.get(childId);
  if (!pending || pending.length === 0) return "";
  pendingByChild.delete(childId);
  return pending.join("；");
}

// —— 下行操作：requestId 配对等待回执（10s 超时）——
const pendingExecs = new Map<string, { resolve: (r: PageExecResult) => void; timer: NodeJS.Timeout }>();
const EXEC_TIMEOUT_MS = 10000;

export function executePageAction(childId: string, params: PageExecParams): Promise<PageExecResult> {
  return new Promise((resolve) => {
    const requestId = genRequestId();
    const timer = setTimeout(() => {
      pendingExecs.delete(requestId);
      resolve({ ok: false, error: "页面无响应（10 秒超时）" });
    }, EXEC_TIMEOUT_MS);
    pendingExecs.set(requestId, { resolve, timer });

    const { action, ...rest } = params;
    // ⚠️ transport 可能返回 undefined（未注入默认 / 主窗口 null 时注入实现不返回值）：
    // 直接 .catch 会 TypeError（ISSUE-014 实测报错原文 "Cannot read properties of undefined"）。
    // Promise.resolve 包装兜底——undefined 视为「已下发」，等 10s 超时兜底「页面无响应」
    // （窗口不存在本就无响应，语义正确）。
    Promise.resolve(pageExecTransport(childId, requestId, action, rest)).catch(() => {
      clearTimeout(timer);
      pendingExecs.delete(requestId);
      resolve({ ok: false, error: "指令下发失败" });
    });
  });
}

/** 渲染层回执（pi:page:exec:result → 主进程） */
export function resolvePageAction(requestId: string, result: PageExecResult): void {
  const pending = pendingExecs.get(requestId);
  if (!pending) return; // 已超时或已消费（防重放）
  clearTimeout(pending.timer);
  pendingExecs.delete(requestId);
  pending.resolve({
    ok: result?.ok === true,
    error: result?.error,
    data: result?.data,
  });
}

/** page_inspect 用：最近互动摘要 */
export function recentInteractions(childId: string, n = 10): string | null {
  return bufferFor(childId).recent(n);
}

// 供测试/内部复用
export function genRequestId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
