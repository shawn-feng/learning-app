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
type SessionProviderFn = (childId: string) => any | null;

let pageExecTransport: TransportFn = () => {
  console.warn("[page-bridge] transport 未注入，下行指令被丢弃");
};
let sessionProvider: SessionProviderFn = () => null;

export function setPageExecTransport(fn: TransportFn): void {
  pageExecTransport = fn;
}
export function setSessionProvider(fn: SessionProviderFn): void {
  sessionProvider = fn;
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
const batchTexts = new Map<string, string[]>();
const BATCH_WINDOW_MS = 600;
const RECENT_LIMIT = 50;

function bufferFor(childId: string): PageEventBuffer {
  let b = buffers.get(childId);
  if (!b) {
    b = new PageEventBuffer(RECENT_LIMIT);
    buffers.set(childId, b);
  }
  return b;
}

function buildInjectionText(texts: string[]): string {
  return `[页面事件] ${texts.join("；")}。（如需查看当前页面或进行操作，可用 page_inspect / page_action 工具。）`;
}

async function injectToSession(childId: string, text: string): Promise<void> {
  let session: any = null;
  try {
    session = sessionProvider(childId);
  } catch (err) {
    console.error(`[page-bridge] sessionProvider 异常:`, (err as Error).message);
    return;
  }
  if (!session) {
    // 会话未加载：事件只入缓冲，留待 page_inspect 读取
    console.log(`[page-bridge] child=${childId} 会话未加载，事件仅入缓冲`);
    return;
  }
  const streaming = (session as any).isStreaming === true;
  console.log(`[page-bridge] inject child=${childId} isStreaming=${streaming} text="${text.slice(0, 60)}..."`);
  try {
    // 运行中 steer（排队等下一次 LLM 调用，不打断当前轮）；空闲 followUp（结束后立即投递）
    if (streaming) {
      if (typeof session.steer === "function") await session.steer(text);
      else console.warn("[page-bridge] session.steer 不可用");
    } else {
      if (typeof session.followUp === "function") await session.followUp(text);
      else if (typeof session.steer === "function") await session.steer(text);
      else console.warn("[page-bridge] session.followUp/steer 均不可用");
    }
  } catch (err) {
    console.error(`[page-bridge] 事件注入失败:`, (err as Error).message);
  }
}

/**
 * 上行事件入口（渲染层 pi:page:event → 主进程）。
 * 事件入环形缓冲，600ms 批处理窗口内合并成一段文本注入 agent（避免逐条刷屏/打断）。
 */
export function queuePageEvent(childId: string, evt: PageBridgeEvent): void {
  const buf = bufferFor(childId);
  const text = eventText(evt);
  buf.push(text);

  const existing = batchTexts.get(childId);
  if (existing) {
    existing.push(text); // 批处理窗口已开启，累积
    return;
  }
  const texts: string[] = [text];
  batchTexts.set(childId, texts);
  setTimeout(() => {
    batchTexts.delete(childId);
    if (texts.length > 0) void injectToSession(childId, buildInjectionText(texts));
  }, BATCH_WINDOW_MS);
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
    pageExecTransport(childId, requestId, action, rest).catch(() => {
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
