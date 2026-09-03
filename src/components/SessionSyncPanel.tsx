import { useState, useEffect, useCallback } from "react";

/**
 * 会话同步状态面板（ISSUE-043 完善）
 *
 * 数据来源：window.api.sessionSyncStatus() / sessionSyncLog(limit) / sessionForceSync() / sessionExportLog()
 *  - 每个孩子一份状态快照（最近同步时间 / 成败 / 连续失败数 / 当前连的 server / 待同步字节）
 *  - 失败不再静默：面板直接展示「上次同步失败 ×N、连的 server、错误类型」，并支持「立即同步」重试 + 「导出同步日志」
 *
 * 用途：家长可一眼看到「回看空白是不是因为没连上家里的 201 服务器」，并能主动补传 / 取日志排查。
 */

interface Props {
  childrenList: any[];
}

interface ChildSyncStatus {
  childId: string;
  lastSyncAt: string | null;
  lastResult: "ok" | "fail" | "skip" | "pending";
  consecutiveFails: number;
  lastError: string | null;
  connectedServer: string;
  pendingBytes: number;
  lastTrigger: "prompt" | "timer" | "quit" | "manual" | null;
}

interface SyncLogEntry {
  ts: string;
  childId: string;
  trigger: string;
  serverUrl: string;
  ok: boolean;
  errType?: string;
  errMsg?: string;
  bytes?: number;
}

const TRIGGER_LABEL: Record<string, string> = {
  prompt: "对话后",
  timer: "定时(5min)",
  quit: "退出前",
  manual: "手动",
};

function formatTs(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function SessionSyncPanel({ childrenList }: Props) {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const [status, setStatus] = useState<ChildSyncStatus[]>([]);
  const [log, setLog] = useState<SyncLogEntry[]>([]);

  const childName = useCallback(
    (childId?: string) => {
      if (!childId) return "—";
      const c = childrenList.find((c) => c.childId === childId);
      return c ? `${c.avatar || "🧒"} ${c.name}` : childId.slice(0, 8);
    },
    [childrenList]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, l] = await Promise.all([
        window.api.sessionSyncStatus(),
        window.api.sessionSyncLog(80),
      ]);
      setStatus(s?.status || []);
      setLog(l?.entries || []);
    } catch (e: any) {
      console.error("加载同步状态失败:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // 每 5s 自动刷新一次状态（同步可能在后台进行）
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function onForceSync() {
    setSyncing(true);
    setExportMsg("");
    try {
      await window.api.sessionForceSync();
      // 立即同步是后台异步，稍等再刷新看结果
      setTimeout(load, 1800);
    } catch (e: any) {
      setExportMsg("立即同步触发失败：" + (e?.message || e));
    } finally {
      setTimeout(() => setSyncing(false), 1800);
    }
  }

  async function onExport() {
    setExportMsg("");
    try {
      const r = await window.api.sessionExportLog();
      if (r?.canceled) return;
      if (r?.success) setExportMsg(`已导出到：${r.filePath}`);
      else setExportMsg("导出失败：" + (r?.error || "未知错误"));
    } catch (e: any) {
      setExportMsg("导出失败：" + (e?.message || e));
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ margin: 0 }}>会话同步</h3>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onForceSync}
            disabled={syncing}
            style={{
              padding: "8px 16px",
              background: "#667eea",
              color: "white",
              border: "none",
              borderRadius: 8,
              cursor: syncing ? "default" : "pointer",
              opacity: syncing ? 0.6 : 1,
            }}
          >
            {syncing ? "同步中…" : "立即同步"}
          </button>
          <button
            onClick={onExport}
            style={{
              padding: "8px 16px",
              background: "#fff",
              color: "#667eea",
              border: "1px solid #667eea",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            导出同步日志
          </button>
        </div>
      </div>

      {exportMsg && (
        <div style={{ color: exportMsg.includes("失败") ? "#e53e3e" : "#38a169", marginBottom: 12, fontSize: 13 }}>
          {exportMsg}
        </div>
      )}

      <p style={{ color: "#888", fontSize: 13, marginTop: 0, marginBottom: 16 }}>
        回看空白通常是「孩子设备没连上家里的 201 服务器」导致对话暂未上云。下方显示每孩子的同步状态；失败会标红并提示连的服务器，可点「立即同步」补传。
      </p>

      {/* 每孩子状态卡 */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
        {(status.length === 0 ? childrenList : status).map((s: any) => {
          const childId = s.childId;
          const fails = s.consecutiveFails || 0;
          const badge =
            s.lastResult === "fail" || fails > 0
              ? { text: `失败 ×${fails}`, color: "#e53e3e" }
              : s.lastResult === "pending"
              ? { text: "待同步", color: "#a0aec0" }
              : { text: "已同步", color: "#38a169" };
          return (
            <div
              key={childId}
              style={{
                background: "#f8f9ff",
                border: "1px solid #e8eaf6",
                borderRadius: 12,
                padding: "14px 16px",
                flex: 1,
                minWidth: 260,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <strong style={{ fontSize: 15 }}>{childName(childId)}</strong>
                <span style={{ color: badge.color, fontSize: 13, fontWeight: 600 }}>{badge.text}</span>
              </div>
              <div style={{ fontSize: 13, color: "#555", lineHeight: 1.9 }}>
                <div>上次同步：{formatTs(s.lastSyncAt)}</div>
                <div>当前服务器：<code style={{ fontSize: 12 }}>{s.connectedServer || "—"}</code></div>
                <div>待同步：{formatBytes(s.pendingBytes || 0)}</div>
                {s.lastError && (
                  <div style={{ color: "#e53e3e", marginTop: 4, wordBreak: "break-all" }}>错误：{s.lastError}</div>
                )}
              </div>
            </div>
          );
        })}
        {status.length === 0 && childrenList.length === 0 && (
          <div style={{ color: "#999" }}>暂无孩子</div>
        )}
      </div>

      {/* 最近日志 */}
      <div>
        <h4 style={{ fontSize: 15, margin: "0 0 12px" }}>最近同步日志</h4>
        <div style={{ maxHeight: 360, overflowY: "auto", border: "1px solid #f0f0f0", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead style={{ position: "sticky", top: 0, background: "#fafafa" }}>
              <tr style={{ color: "#888", textAlign: "left" }}>
                <th style={{ padding: "8px" }}>时间</th>
                <th style={{ padding: "8px" }}>孩子</th>
                <th style={{ padding: "8px" }}>触发</th>
                <th style={{ padding: "8px" }}>服务器</th>
                <th style={{ padding: "8px" }}>结果</th>
                <th style={{ padding: "8px" }}>错误</th>
              </tr>
            </thead>
            <tbody>
              {log.map((e, i) => (
                <tr key={`${e.ts}-${i}`} style={{ borderTop: "1px solid #f5f5f5" }}>
                  <td style={{ padding: "8px", whiteSpace: "nowrap" }}>{formatTs(e.ts)}</td>
                  <td style={{ padding: "8px" }}>{childName(e.childId)}</td>
                  <td style={{ padding: "8px" }}>{TRIGGER_LABEL[e.trigger] || e.trigger}</td>
                  <td style={{ padding: "8px", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.serverUrl}>
                    <code style={{ fontSize: 11 }}>{e.serverUrl}</code>
                  </td>
                  <td style={{ padding: "8px" }}>
                    <span style={{ color: e.ok ? "#38a169" : "#e53e3e" }}>{e.ok ? "✓ 成功" : "✗ 失败"}</span>
                  </td>
                  <td style={{ padding: "8px", color: e.ok ? "#888" : "#e53e3e", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.errMsg}>
                    {e.ok ? (e.bytes ? formatBytes(e.bytes) : "—") : `${e.errType || ""} ${e.errMsg || ""}`}
                  </td>
                </tr>
              ))}
              {log.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: 16, color: "#999", textAlign: "center" }}>
                    暂无日志（发生会话同步后出现）
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
