/**
 * 服务端连接监视器（ISSUE-167：把「退出家长重登才能恢复」自动化）。
 *
 * - serverFetch 家族断连记账后（connection-state.ts），本监视器按指数退避探活：
 *   30s → 1m → 2m → 5m 封顶；连接正常时**不轮询**（无常驻流量），只有断连状态才探测。
 * - 探活用 GET /health（无鉴权、轻量）；任意 HTTP 响应即视为可达
 *   （serverFetch 内部统一记账 noteServerReachable，断连→恢复翻转时通知监听者）。
 * - 渲染层的恢复联动（重拉孩子列表、撤横幅）由 ipc-handlers 注册的
 *   onConnectionChange 监听推送 server:connection-changed 事件完成。
 */
import { serverFetch } from "./server-client";
import { getConnectionSnapshot, type ConnectionSnapshot } from "./connection-state";

const BASE_MS = 30_000;
const MAX_MS = 5 * 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = BASE_MS;
let started = false;

function schedule(): void {
  if (timer) clearTimeout(timer);
  // Electron 主进程 app.quit() 不等事件循环排空，无需 unref
  timer = setTimeout(() => void tick(), backoffMs);
}

async function tick(): Promise<void> {
  try {
    const snap = getConnectionSnapshot();
    if (!snap.configured) {
      backoffMs = BASE_MS; // 纯本地模式：不探测，慢速空转等配置变化
      return;
    }
    if (snap.connected) {
      backoffMs = BASE_MS; // 健康：不探测，等下次断连再从基速起步
      return;
    }
    try {
      await serverFetch("/health", { timeoutMs: 5000 });
      backoffMs = BASE_MS; // 恢复（serverFetch 已记账并广播）
    } catch {
      backoffMs = Math.min(backoffMs * 2, MAX_MS); // 仍不可达：退避
    }
  } finally {
    schedule();
  }
}

/** app 启动时调用一次（幂等）。 */
export function startConnectionMonitor(): void {
  if (started) return;
  started = true;
  schedule();
}

/** 立即探活一次（主页「重试连接」按钮），返回最新快照（无论成败）。 */
export async function retryConnectionNow(): Promise<ConnectionSnapshot> {
  try {
    await serverFetch("/health", { timeoutMs: 5000 });
  } catch {
    /* 不可达：快照里 connected=false */
  }
  return getConnectionSnapshot();
}
