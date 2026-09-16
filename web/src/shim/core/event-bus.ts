/**
 * 极简事件总线（设计方案 §4 core/event-bus.ts）：
 * 供 shim 内部分发 pi:* / scene:* / class:reminder / window:* 等事件，
 * 承接 preload 的 onXxx(callback) → ipcRenderer.on(channel, wrapper) 语义
 * （后续 Phase 4 的 SSE 翻译层 emit，渲染层 onXxx 订阅）。
 *
 * 语义对齐 preload.registerListener：
 *   - 同一 channel 可多次注册，回调按注册顺序触发；
 *   - piRemoveListeners 等价物 = 收集 on() 返回的退订函数统一调用（各域自行管理）。
 */

export type EventHandler = (data?: any) => void;

const handlers = new Map<string, Set<EventHandler>>();

export const eventBus = {
  /** 订阅；返回退订函数（同时用于对齐 onPiDefaultModelChanged 等「返回 unsubscribe」的 preload 签名）。 */
  on(event: string, handler: EventHandler): () => void {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) handlers.delete(event);
    };
  },

  off(event: string, handler: EventHandler): void {
    handlers.get(event)?.delete(handler);
  },

  /** 触发；回调内退订不影响本轮后续回调（快照遍历）。 */
  emit(event: string, data?: any): void {
    const set = handlers.get(event);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        handler(data);
      } catch (err) {
        // 单个回调异常不阻断其它回调（对齐 ipc 事件派发行为）
        console.error(`[web-shim] event '${event}' handler error:`, err);
      }
    }
  },
};
