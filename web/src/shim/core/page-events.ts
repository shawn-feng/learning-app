/**
 * Web 版页面操作缓冲（设计方案 §2 #11，Phase 4）：
 * 移植 packages/agent-core/src/bridge.ts 的「环形缓冲 + 待附带事件 + 中文格式化」到浏览器内存，
 * 承接 Electron 主进程 pi:page:event / pi:page:pending 两个 IPC 的语义：
 *   - pageEvent(childId, event)：格式化后入环形缓冲（容量 50）并累积到 pending；
 *   - pageTakePending(childId)：取走并清空 pending（渲染层 Learn.handleSend 发送前拼
 *     「\n[页面操作] 这部分是孩子在页面上的操作：…」前缀，发送即清空，ISSUE-015 语义）。
 *
 * 是否转发 POST /agent/:childId/events？——以 ipc-handlers 的 pi:page:event 实现为准：
 * Electron 客户端**只入本地缓冲、不转发服务端**（渲染层自己把 pending 拼进 prompt 正文，
 * 服务端 prompt 路由的 hub.takePending 兜底只服务于「直连服务端的其它客户端」）。
 * Web 与渲染层共享同一份 Learn.tsx，故同样不转发——转发反而会造成页面操作在 prompt 里重复出现。
 *
 * executePageAction/resolvePageAction（本地 requestId 配对）不移植：Web 端没有本地 agent 工具，
 * 下行指令全部由服务端下发（page_cmd）、由服务端配对回执（POST /page-result，见 domains/agents.ts）。
 */

/** PiBridge 上行事件信封（page-bridge.ts PageBridgeEvent）。 */
export interface PageBridgeEvent {
  kind: string;
  ts?: number;
  title?: string;
  detail?: Record<string, unknown>;
}

/** 环形缓冲容量（对齐 PAGE_EVENT_RECENT_LIMIT = 50）。 */
export const PAGE_EVENT_RECENT_LIMIT = 50;

// —— 事件文本格式化（bridge.ts formatPageEvent 逐行移植，纯函数） ——

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

/** 单条事件文本（缓冲与注入共用）。 */
export function eventText(evt: PageBridgeEvent): string {
  return formatPageEvent(evt);
}

// ---------------------------------------------------------------------------
// 每 childId 环形缓冲 + pending（PageBridgeHub 子集）
// ---------------------------------------------------------------------------

interface RingBuffer {
  items: Array<{ ts: number; text: string }>;
}

const buffers = new Map<string, RingBuffer>();
/** ISSUE-015：待随下一轮消息附带的页面操作（按 childId；取走即清空）。 */
const pendingByChild = new Map<string, string[]>();

function bufferFor(childId: string): RingBuffer {
  let b = buffers.get(childId);
  if (!b) {
    b = { items: [] };
    buffers.set(childId, b);
  }
  return b;
}

/**
 * 上行事件入口。ISSUE-015：事件只入环形缓冲（供追溯）并累积到 pending，
 * **不自动注入 agent**——随下一轮消息（takePendingPageEvents）附带。
 */
export function queuePageEvent(childId: string, evt: PageBridgeEvent): void {
  const buf = bufferFor(childId);
  const text = eventText(evt);
  buf.items.push({ ts: Date.now(), text });
  if (buf.items.length > PAGE_EVENT_RECENT_LIMIT) {
    buf.items.splice(0, buf.items.length - PAGE_EVENT_RECENT_LIMIT);
  }
  let pending = pendingByChild.get(childId);
  if (!pending) {
    pending = [];
    pendingByChild.set(childId, pending);
  }
  pending.push(text);
}

/** 取走并清空某孩子待附带的事件（无则空串，多条以「；」连接）；环形缓冲不受影响。 */
export function takePendingPageEvents(childId: string): string {
  const pending = pendingByChild.get(childId);
  if (!pending || pending.length === 0) return "";
  pendingByChild.delete(childId);
  return pending.join("；");
}

/** 最近 n 条互动摘要（对齐 PageBridgeHub.recentInteractions；Web 端暂无消费方，保留以对齐机制面）。 */
export function recentInteractions(childId: string, n = 10): string | null {
  const items = bufferFor(childId).items;
  if (items.length === 0) return null;
  return items.slice(-n).map((it) => it.text).join("；");
}

/** 清空某孩子（或全部）缓冲（登出/切孩子时可调用）。 */
export function clearPageEvents(childId?: string): void {
  if (childId) {
    buffers.delete(childId);
    pendingByChild.delete(childId);
  } else {
    buffers.clear();
    pendingByChild.clear();
  }
}
