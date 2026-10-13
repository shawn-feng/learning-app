import { useCallback, useEffect, useRef, useState } from "react";

/** 连接快照（server:connectionState / server:connection-changed 的载荷，Electron 与 web shim 同形） */
export interface ServerConnSnap {
  configured?: boolean;
  url?: string;
  connected?: boolean;
  lastErrorAt?: string | null;
  recoveredAt?: string | null;
  lastServerChildCount?: number | null;
}

/**
 * 服务端连接状态订阅（ISSUE-167 引入、ISSUE-179 阻断式 UX 复用并强化）：
 * - 挂载读一次快照 + 订阅断连/恢复推送（Electron 主进程推送；web shim 为 no-op）；
 * - 推送监听可能被 piRemoveListeners 误清（ISSUE-167 实施踩坑）——降级期间每 30s
 *   轮询 serverConnectionState 自兜底（web 端该方法处于断连态时会顺手探活 /health）；
 * - 断连→恢复翻转时回调 onRecovered（调用方重拉服务端数据，自动退出阻断态）。
 *
 * 返回 degraded=true 时页面应渲染 ConnectionBlocking 阻断层（ISSUE-179：app 不可用，
 * 本地孩子永不渲染），而不是静默降级横幅。
 */
export function useServerConnection(onRecovered?: () => void) {
  const [conn, setConn] = useState<ServerConnSnap | null>(null);
  const degraded = conn?.connected === false;
  // 上一时刻是否处于断连态：只在 applySnap 内同步推进，防渲染间隙重复触发 onRecovered
  const degradedRef = useRef(false);
  const recoveredCbRef = useRef(onRecovered);
  recoveredCbRef.current = onRecovered;

  const applySnap = useCallback((s: ServerConnSnap | null | undefined) => {
    if (!s) return;
    const wasDegraded = degradedRef.current;
    const nowDegraded = s.connected === false;
    degradedRef.current = nowDegraded;
    setConn(s);
    if (wasDegraded && !nowDegraded) recoveredCbRef.current?.();
  }, []);

  useEffect(() => {
    let mounted = true;
    window.api
      .serverConnectionState?.()
      .then((s: any) => {
        if (mounted) applySnap(s);
      })
      .catch(() => {});
    window.api.onServerConnectionChanged?.((s: any) => {
      if (!mounted) return;
      applySnap(s);
    });
    const poll = setInterval(async () => {
      if (!degradedRef.current) return; // 健康时不轮询（无常驻流量）
      try {
        const s = await window.api.serverConnectionState?.();
        if (mounted) applySnap(s);
      } catch {
        /* ignore */
      }
    }, 30_000);
    return () => {
      mounted = false;
      clearInterval(poll);
    };
  }, [applySnap]);

  const retryConnection = useCallback(async () => {
    try {
      const s = await window.api.serverRetryConnection?.();
      applySnap(s);
    } catch {
      /* ignore */
    }
  }, [applySnap]);

  return { conn, degraded, retryConnection };
}
