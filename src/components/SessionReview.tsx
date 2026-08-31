import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

interface ReviewMessage {
  ts: number;
  role: string;
  text: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

interface Props {
  childId: string;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 方案B 阶段①：家长「对话回顾」——从服务端读取孩子与 agent 的完整逐字稿（历史回顾）。
 * 数据源 = 客户端每轮增量同步上云的 session_messages；剔除 thinking，assistant 附工具调用。
 */
export default function SessionReview({ childId }: Props) {
  const [dates, setDates] = useState<Array<{ date: string; count: number }>>([]);
  const [selected, setSelected] = useState("");
  const [messages, setMessages] = useState<ReviewMessage[]>([]);
  const [loadingDates, setLoadingDates] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadDates = useCallback(() => {
    setLoadingDates(true);
    setError("");
    window.api
      .sessionReviewDates(childId)
      .then((r: any) => {
        if (r?.success) {
          const ds: Array<{ date: string; count: number }> = r.dates ?? [];
          setDates(ds);
          if (ds.length > 0 && !ds.some((d) => d.date === selected)) {
            setSelected(ds[0].date);
          }
        } else {
          setError(r?.error || "加载失败");
        }
      })
      .catch((e: any) => setError(e.message || "加载失败"))
      .finally(() => setLoadingDates(false));
  }, [childId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadDates();
  }, [loadDates]);

  const loadMessages = useCallback(
    (date: string) => {
      if (!date) return;
      setLoadingMsgs(true);
      setError("");
      window.api
        .sessionReviewMessages(childId, date)
        .then((r: any) => {
          if (r?.success) {
            setMessages(r.messages ?? []);
          } else {
            setError(r?.error || "加载失败");
          }
        })
        .catch((e: any) => setError(e.message || "加载失败"))
        .finally(() => setLoadingMsgs(false));
    },
    [childId]
  );

  useEffect(() => {
    if (selected) loadMessages(selected);
  }, [selected, loadMessages]);

  function toggleTool(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "#666" }}>选择日期：</span>
        {loadingDates ? (
          <span style={{ fontSize: 12, color: "#999" }}>加载中…</span>
        ) : dates.length === 0 ? (
          <span style={{ fontSize: 12, color: "#999" }}>（还没有同步上云的对话记录）</span>
        ) : (
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            style={{ padding: "6px 10px", fontSize: 13, borderRadius: 6, border: "1px solid #ddd" }}
          >
            {dates.map((d) => (
              <option key={d.date} value={d.date}>
                {d.date}（{d.count} 条）
              </option>
            ))}
          </select>
        )}
        <button
          onClick={loadDates}
          title="刷新"
          style={{
            display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 10px",
            borderRadius: 6, border: "1px solid #ddd", background: "#fff", fontSize: 12, cursor: "pointer",
          }}
        >
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      {error && <div style={{ color: "#b33", fontSize: 12, marginBottom: 10 }}>{error}</div>}

      {loadingMsgs ? (
        <div className="placeholder" style={{ padding: 24, textAlign: "center", color: "#999", fontSize: 13 }}>
          ⏳ 加载对话…
        </div>
      ) : messages.length === 0 ? (
        <div className="placeholder" style={{ padding: 24, textAlign: "center", color: "#999", fontSize: 13 }}>
          该日期暂无对话内容
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 560, overflowY: "auto", paddingRight: 4 }}>
          {messages.map((m, i) => {
            const isUser = m.role === "user";
            const key = `${m.ts}-${i}`;
            return (
              <div
                key={key}
                style={{
                  alignSelf: isUser ? "flex-end" : "flex-start",
                  maxWidth: "82%",
                  background: isUser ? "#667eea" : "#f4f4f8",
                  color: isUser ? "#fff" : "#333",
                  borderRadius: 12,
                  padding: "8px 12px",
                  fontSize: 13,
                  lineHeight: 1.6,
                  wordBreak: "break-word",
                }}
              >
                <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 2 }}>
                  {isUser ? "孩子" : "AI"} · {fmtTime(m.ts)}
                </div>
                {m.text ? <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div> : null}
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <button
                      onClick={() => toggleTool(key)}
                      style={{
                        fontSize: 11, color: isUser ? "#e8e8ff" : "#5a67d8",
                        background: "transparent", border: "none", cursor: "pointer", padding: 0,
                      }}
                    >
                      {expanded.has(key) ? "收起工具调用 ▾" : `工具调用 ${m.toolCalls.length} 项 ▸`}
                    </button>
                    {expanded.has(key) && (
                      <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 4 }}>
                        {m.toolCalls.map((tc) => (
                          <div
                            key={tc.id}
                            style={{
                              fontSize: 11,
                              fontFamily: "monospace",
                              background: isUser ? "rgba(255,255,255,0.15)" : "#fff",
                              border: "1px solid #e0e0e8",
                              borderRadius: 6,
                              padding: "4px 8px",
                              color: isUser ? "#eee" : "#555",
                              wordBreak: "break-all",
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>{tc.name}</span>
                            {tc.arguments ? ` ${tc.arguments.slice(0, 200)}${tc.arguments.length > 200 ? "…" : ""}` : ""}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
