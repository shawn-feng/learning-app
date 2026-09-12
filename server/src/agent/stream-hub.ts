/**
 * agent 事件流中枢（SSE 用）：
 * - 服务端持久会话产生的每个事件（token 增量 / thinking / 工具调用 / 结束 / 错误）都经 publish 进入本中枢；
 * - 多个客户端可同时订阅同一 (parentId, childId)：SSE 连接即订阅者，断开即退订（多端观看天然成立）；
 * - 环形缓冲 + 事件 id 支持 Last-Event-ID 重放——手机切后台/网络抖动重连后不丢事件，
 *   这是「多设备 + 弱网」场景必需的，否则重连即丢半句回复。
 *
 * 键一律用 parentId:childId 前缀，避免跨家长/跨孩子串流（隔离红线）。
 */

export interface AgentStreamEvent {
  /** 单调递增的事件 id（同一 key 内唯一），用作 SSE 的 id: 字段 */
  id: number;
  key: string;
  type: string;
  data: unknown;
  ts: number;
}

const REPLAY_BUFFER_SIZE = 500;

export class AgentStreamHub {
  private buffers = new Map<string, AgentStreamEvent[]>();
  private subscribers = new Map<string, Set<(e: AgentStreamEvent) => void>>();
  private seq = new Map<string, number>();

  static key(parentId: string, childId: string): string {
    return `${parentId}:${childId}`;
  }

  /** 发布事件：先入环形缓冲，再广播给订阅者（订阅者异常不影响其它订阅者）。 */
  publish(key: string, type: string, data: unknown): AgentStreamEvent {
    const id = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, id);
    const evt: AgentStreamEvent = { id, key, type, data, ts: Date.now() };

    let buf = this.buffers.get(key);
    if (!buf) {
      buf = [];
      this.buffers.set(key, buf);
    }
    buf.push(evt);
    if (buf.length > REPLAY_BUFFER_SIZE) buf.splice(0, buf.length - REPLAY_BUFFER_SIZE);

    for (const fn of this.subscribers.get(key) ?? []) {
      try {
        fn(evt);
      } catch (err) {
        console.error("[agent-stream] subscriber error:", (err as Error).message);
      }
    }
    return evt;
  }

  /** 订阅；返回退订函数。 */
  subscribe(key: string, fn: (e: AgentStreamEvent) => void): () => void {
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.subscribers.delete(key);
    };
  }

  /** Last-Event-ID 重放：返回 id 大于 lastEventId 的缓冲事件（无则空数组）。 */
  replayAfter(key: string, lastEventId: number): AgentStreamEvent[] {
    const buf = this.buffers.get(key) ?? [];
    return buf.filter((e) => e.id > lastEventId);
  }

  /** 当前订阅者数量（用于「是否有设备在看」判断与调试） */
  subscriberCount(key: string): number {
    return this.subscribers.get(key)?.size ?? 0;
  }

  /** 当前事件游标（供客户端请求「我错过了多少」） */
  lastEventId(key: string): number {
    return this.seq.get(key) ?? 0;
  }
}

/** 进程内单例：worker 与交互会话共用同一个事件面。 */
export const agentStreamHub = new AgentStreamHub();
