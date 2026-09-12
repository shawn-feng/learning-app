/**
 * iframe 学习资料 ↔ agent 通讯桥（共享内核，唯一真源）。
 *
 * 与 `MATERIAL-BRIDGE-PROTOCOL.md` 对齐。本模块刻意 **不 import electron、不 import SDK**：
 * 上行（页面事件）与下行（受控操作）都只依赖一个注入的 transport 函数，因此同一份实现可跑在
 * 客户端主进程（transport = IPC 到渲染层）与服务端（transport = SSE 下发给客户端执行端点）。
 *
 * 职责：
 * - queuePageEvent / takePendingPageEvents：互动事件入环形缓冲 + 累积到「随下一轮消息附带」；
 * - executePageAction / resolvePageAction：agent 工具调用时下发指令并按 requestId 配对等回执；
 * - recentInteractions：供 page_inspect 返回最近互动摘要。
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

/** 下行指令的传输函数：客户端=IPC，服务端=SSE。返回 Promise 仅表示「已下发」。 */
export type PageExecTransportFn = (
  childId: string,
  requestId: string,
  action: string,
  params: Record<string, unknown>
) => void | Promise<void>;

export const PAGE_EXEC_TIMEOUT_MS = 10000;
export const PAGE_EVENT_RECENT_LIMIT = 50;

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
    case "scene-ready": {
      // ISSUE-061：场景页就绪时上报的属性清单（渲染层已拼好中文摘要）
      const text = d.text ? shortText(d.text, 500) : "场景已就绪";
      return text;
    }
    case "app": {
      // MATERIAL-BRIDGE-PROTOCOL：作者自定义语义事件（PiBridge.emit）——动作名 + 载荷
      const title = evt.title ? `「${shortText(evt.title, 30)}」` : "";
      const payload =
        d.payload === undefined || d.payload === null ? "" : `，数据：${JSON.stringify(d.payload).slice(0, 600)}`;
      return `${title}触发了动作「${shortText(String(d.action || ""), 60)}」${payload}`;
    }
    default:
      return `有互动事件（${evt.kind}）`;
  }
}

/** 单条事件文本（缓冲与注入共用；注入时带 [页面事件] 前缀） */
export function eventText(evt: PageBridgeEvent): string {
  return formatPageEvent(evt);
}

/** 每 childId 环形缓冲（容量默认 50，供 recentInteractions 与历史感知） */
export class PageEventBuffer {
  private items: Array<{ ts: number; text: string }> = [];
  constructor(private capacity: number = PAGE_EVENT_RECENT_LIMIT) {}

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

/**
 * 一个「宿主 ↔ agent」桥实例：环形缓冲 + 待附带事件 + 下行 requestId 配对。
 * 客户端用默认单例（见文件末尾兼容导出）；服务端按需 per-child 建实例，天然隔离。
 */
export class PageBridgeHub {
  private buffers = new Map<string, PageEventBuffer>();
  /** ISSUE-015：待随下一轮消息附带的页面操作（按 childId；取走即清空） */
  private pendingByChild = new Map<string, string[]>();
  private pendingExecs = new Map<string, { resolve: (r: PageExecResult) => void; timer: NodeJS.Timeout }>();

  constructor(
    private transport: PageExecTransportFn = () => {
      console.warn("[page-bridge] transport 未注入，下行指令被丢弃");
    },
    private recentLimit: number = PAGE_EVENT_RECENT_LIMIT
  ) {}

  setTransport(fn: PageExecTransportFn): void {
    this.transport = fn;
  }

  private bufferFor(childId: string): PageEventBuffer {
    let b = this.buffers.get(childId);
    if (!b) {
      b = new PageEventBuffer(this.recentLimit);
      this.buffers.set(childId, b);
    }
    return b;
  }

  /**
   * 上行事件入口。ISSUE-015：事件只入环形缓冲（供 page_inspect 读）并累积到 pending，
   * **不自动注入 agent**——随下一轮消息（takePendingPageEvents）附带。
   */
  queueEvent(childId: string, evt: PageBridgeEvent): void {
    const buf = this.bufferFor(childId);
    const text = eventText(evt);
    buf.push(text);
    let pending = this.pendingByChild.get(childId);
    if (!pending) {
      pending = [];
      this.pendingByChild.set(childId, pending);
    }
    pending.push(text);
  }

  /** 取走并清空某孩子待附带的事件（无则空串）；环形缓冲不受影响 */
  takePending(childId: string): string {
    const pending = this.pendingByChild.get(childId);
    if (!pending || pending.length === 0) return "";
    this.pendingByChild.delete(childId);
    return pending.join("；");
  }

  /** 下行受控操作：下发 + requestId 配对等回执（10s 超时） */
  executeAction(childId: string, params: PageExecParams): Promise<PageExecResult> {
    return new Promise((resolve) => {
      const requestId = genRequestId();
      const timer = setTimeout(() => {
        this.pendingExecs.delete(requestId);
        resolve({ ok: false, error: "页面无响应（10 秒超时）" });
      }, PAGE_EXEC_TIMEOUT_MS);
      this.pendingExecs.set(requestId, { resolve, timer });

      const { action, ...rest } = params;
      // transport 可能返回 undefined（未注入默认 / 主窗口 null 时注入实现不返回值）：
      // 直接 .catch 会 TypeError（ISSUE-014 实测报错原文 "Cannot read properties of undefined"）。
      // Promise.resolve 包装兜底——undefined 视为「已下发」，等超时兜底「页面无响应」。
      Promise.resolve(this.transport(childId, requestId, action, rest)).catch(() => {
        clearTimeout(timer);
        this.pendingExecs.delete(requestId);
        resolve({ ok: false, error: "指令下发失败" });
      });
    });
  }

  /** 回执入口（防重放：已超时/已消费的 requestId 直接忽略） */
  resolveAction(requestId: string, result: PageExecResult): void {
    const pending = this.pendingExecs.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingExecs.delete(requestId);
    pending.resolve({
      ok: result?.ok === true,
      error: result?.error,
      data: result?.data,
    });
  }

  recentInteractions(childId: string, n = 10): string | null {
    return this.bufferFor(childId).recent(n);
  }
}

// —— 客户端兼容层：默认单例 + 原函数名（客户端既有调用点无需改动）——
export const defaultPageBridge = new PageBridgeHub();

export function setPageExecTransport(fn: PageExecTransportFn): void {
  defaultPageBridge.setTransport(fn);
}

export function queuePageEvent(childId: string, evt: PageBridgeEvent): void {
  defaultPageBridge.queueEvent(childId, evt);
}

export function takePendingPageEvents(childId: string): string {
  return defaultPageBridge.takePending(childId);
}

export function executePageAction(childId: string, params: PageExecParams): Promise<PageExecResult> {
  return defaultPageBridge.executeAction(childId, params);
}

export function resolvePageAction(requestId: string, result: PageExecResult): void {
  defaultPageBridge.resolveAction(requestId, result);
}

export function recentInteractions(childId: string, n = 10): string | null {
  return defaultPageBridge.recentInteractions(childId, n);
}

// 供测试/内部复用
export function genRequestId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
