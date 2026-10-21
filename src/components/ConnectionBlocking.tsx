import { useEffect, useState } from "react";

interface Props {
  /** 服务端地址（阻断层里如实展示，便于用户判断是哪台服务端断了） */
  url?: string;
  /** 断连起始时刻（epoch ms，一般取快照 lastErrorAt；缺省用组件挂载时刻起算） */
  startedAt?: number;
  /** 立即重试（探活一次，恢复即退出阻断态） */
  onRetry: () => void;
}

/**
 * ISSUE-179：断连「阻断等待重连」全屏层（Electron / Web 双端共用）。
 *
 * 服务端已配置的客户端断连期间 app 不可用：不渲染任何孩子入口（本地孩子永不出现），
 * 只显示「与服务端断开连接，正在等待重新链接…（已等待 Ns）」+ spinner + 立即重试。
 * 退出阻断态唯一的路是连接恢复（探活成功由 useServerConnection 自动感知并重拉列表），
 * 注销重登不再也不需要成为恢复手段（推翻 ISSUE-167 的离线兜底决策）。
 */
export default function ConnectionBlocking({ url, startedAt, onRetry }: Props) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const base = startedAt && startedAt > 0 ? startedAt : Date.now();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - base) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "#f4f6fb" }}>
      <div
        style={{
          textAlign: "center",
          padding: "36px 52px",
          background: "#fff",
          border: "1px solid #e5e5e5",
          borderRadius: 16,
          boxShadow: "0 8px 30px rgba(30,40,70,.08)",
          maxWidth: 540,
        }}
      >
        <div style={{ fontSize: 40, marginBottom: 6 }} aria-hidden>📡</div>
        <h2 style={{ margin: "0 0 10px", fontSize: 18, color: "#2c3e50" }}>与服务端断开连接</h2>
        <p style={{ margin: "0 0 14px", color: "#5a6478", fontSize: 14, lineHeight: 1.8 }}>
          正在等待重新链接…（已等待 {elapsed} 秒）
          <br />
          <span style={{ fontSize: 12, color: "#afafaf" }}>
            {url ? `服务端地址：${url}。` : ""}恢复连接后会自动回到最新数据，无需注销重登。
          </span>
        </p>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <span className="working-spinner working-spinner-lg" />
          <button
            onClick={onRetry}
            style={{
              padding: "8px 22px",
              background: "#58cc02",
              color: "white",
              border: "none",
              borderRadius: 8,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            立即重试
          </button>
        </div>
      </div>
    </div>
  );
}
