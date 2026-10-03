/**
 * 服务端连接状态记账（ISSUE-167：失联静默降级可见化）。
 *
 * 记账点在 server-client.ts 的 fetch 家族：**任意 HTTP 响应**（含 4xx/5xx）= 服务端可达；
 * 只有 fetch 抛错（网络不可达/超时）= 断连。getServerUrl 永不返回空（未配置时默认本机
 * 8788），所以默认本机服务端没起也是「断连」，横幅如实展示。
 *
 * 消费方：
 *   - connection-monitor.ts：断连时周期探活 /health，恢复即止；
 *   - ipc-handlers「server:connectionState / server:retryConnection」+ 变更推送渲染层；
 *   - child-auth.ts listChildren：成功拉取后记 lastServerChildCount（横幅数量差异用）、
 *     自动上云 PATCH 加 recentlyDegraded 守卫（刚断连恢复过不自动同步本地数据）。
 */
import { getServerUrl } from "./config";

export interface ConnectionSnapshot {
  /** 是否配置了服务端地址（false = 纯本地模式，无横幅） */
  configured: boolean;
  /** 当前服务端地址（未配置为空串） */
  url: string;
  /** 最近一次网络结论：true = 可达（任意 HTTP 响应），false = 不可达/超时 */
  connected: boolean;
  /** 最近一次确认可达的时刻（ISO） */
  lastOkAt: string | null;
  /** 最近一次断连的时刻（ISO） */
  lastErrorAt: string | null;
  /** 最近一次从断连恢复的时刻（ISO） */
  recoveredAt: string | null;
  /** 最近一次成功从服务端拉到的孩子列表数量（null = 从未成功拉取过） */
  lastServerChildCount: number | null;
}

interface InternalState {
  connected: boolean;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  recoveredAt: string | null;
  lastServerChildCount: number | null;
}

// 初始乐观（无断连证据）：首次请求即失败会立刻翻转为 false
const state: InternalState = {
  connected: true,
  lastOkAt: null,
  lastErrorAt: null,
  recoveredAt: null,
  lastServerChildCount: null,
};

type Listener = (snap: ConnectionSnapshot) => void;
const listeners = new Set<Listener>();

function snapshot(): ConnectionSnapshot {
  const url = getServerUrl();
  return {
    configured: !!url,
    url,
    connected: state.connected,
    lastOkAt: state.lastOkAt,
    lastErrorAt: state.lastErrorAt,
    recoveredAt: state.recoveredAt,
    lastServerChildCount: state.lastServerChildCount,
  };
}

function emit(): void {
  const snap = snapshot();
  for (const l of listeners) {
    try {
      l(snap);
    } catch {
      /* 单个监听者异常不影响其他 */
    }
  }
}

/** 服务端可达（fetch 家族拿到任意 HTTP 响应时调用）。断连→恢复翻转时通知监听者。 */
export function noteServerReachable(): void {
  const now = new Date().toISOString();
  state.lastOkAt = now;
  if (!state.connected) {
    state.connected = true;
    state.recoveredAt = now;
    emit();
  }
}

/** 服务端不可达（fetch 家族网络抛错时调用）。
 *  注：getServerUrl 永不返回空（未配置时默认本机 8788），故这里无条件记账——
 *  默认本机服务端没起也一样是「断连」，横幅如实展示。 */
export function noteServerUnreachable(): void {
  const now = new Date().toISOString();
  state.lastErrorAt = now;
  if (state.connected) {
    state.connected = false;
    emit();
  }
}

/** 记录最近一次成功从服务端拉到的孩子数量（listChildren 服务端分支成功时调用）。 */
export function noteServerChildren(count: number): void {
  state.lastServerChildCount = count;
}

/**
 * 近期是否发生过断连（含尚未恢复）：withinMs 窗口内出现过断连或刚恢复即 true。
 * 用于「刚断连恢复不自动上云本地数据」守卫（ISSUE-167 修复方向 #4）。
 */
export function recentlyDegraded(withinMs: number): boolean {
  const stamps = [state.lastErrorAt, state.recoveredAt].filter(Boolean) as string[];
  if (stamps.length === 0) return false;
  const latest = Math.max(...stamps.map((s) => Date.parse(s)));
  return Date.now() - latest < withinMs;
}

export function getConnectionSnapshot(): ConnectionSnapshot {
  return snapshot();
}

export function onConnectionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
