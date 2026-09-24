import { useState, useEffect, useCallback } from "react";

/**
 * Token 用量面板（ISSUE-129 重写，取代 ISSUE-010 客户端旧统计）。
 *
 * 数据来源：window.api.tokenUsageDays / tokenUsageSessions → 服务端
 * GET /api/v1/token-usage/days|sessions（家长 JWT）。服务端在查询前对
 * data/agent-sessions/<pid>/<slot>/*.jsonl 做增量扫描（游标幂等，可回填历史）。
 *
 * 口径（用户 2026-09-21 拍板）：**模型返回字段原样直传**（input / cacheRead /
 * cacheWrite / output / reasoning / totalTokens / cost），每行带模型名；
 * 不做本地 system/工具归因；token-plan 包月 cost=0 → 显示「-」。
 *
 * 展示：两级视图 —— 按日期×渠道聚合（默认）→ 点某天看会话明细（会话 ID/模型/字段）。
 */

interface Props {
  childrenList: any[];
}

// 服务端聚合行（snake_case 直传）
interface DayRow {
  date: string;
  scope: string;
  child_id: string;
  rounds: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  total_tokens: number;
  cost: number;
}

interface SessionRow {
  session_file: string;
  scope: string;
  child_id: string;
  slot: string;
  models: string;
  rounds: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
  total_tokens: number;
  cost: number;
  first_ts: number;
  last_ts: number;
}

const SCOPE_ZH: Record<string, string> = {
  parent: "家长助手",
  child: "孩子主会话",
  scene: "场景课",
  course: "课程会话",
};

const th: React.CSSProperties = { padding: "6px 8px", textAlign: "right", fontWeight: 600 };
const td: React.CSSProperties = { padding: "6px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const thL: React.CSSProperties = { ...th, textAlign: "left" };
const tdL: React.CSSProperties = { ...td, textAlign: "left" };

function formatNum(n: number | undefined): string {
  if (!n) return "0";
  return n >= 100000 ? `${(n / 1000).toFixed(0)}k` : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
}

function formatCost(cost: number | undefined): string {
  if (!cost) return "-";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 会话文件名 → 短 ID（uuid 段前 8 位），如 01a0c407 */
function sessionShortId(sessionFile: string): string {
  const base = sessionFile.split("/").pop() || sessionFile;
  const m = /_([0-9a-f-]{36})\.jsonl$/.exec(base);
  return m ? m[1].slice(0, 8) : base.replace(/\.jsonl$/, "").slice(-12);
}

export default function TokenStatsPanel({ childrenList }: Props) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [days, setDays] = useState<DayRow[]>([]);
  const [scopeFilter, setScopeFilter] = useState("");
  // 点开的日期 → 该天会话明细（懒加载）
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  const childName = useCallback(
    (childId: string) => {
      if (!childId) return "";
      const c = childrenList.find((c: any) => c.childId === childId || c.id === childId);
      return c ? c.name : childId.slice(0, 8);
    },
    [childrenList]
  );

  const scopeLabel = useCallback(
    (r: { scope: string; child_id: string; slot: string }) => {
      if (r.scope === "parent") {
        if (r.slot === "parent-content") return "家长·资料助手";
        return "家长助手";
      }
      const base = SCOPE_ZH[r.scope] || r.scope;
      const name = childName(r.child_id);
      return name ? `${name}·${base}` : base;
    },
    [childName]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await (window.api as any).tokenUsageDays(
        scopeFilter ? { scope: scopeFilter } : {}
      );
      if (!res?.success) throw new Error(res?.error || "加载失败");
      setDays(res.days || []);
    } catch (e: any) {
      setErr(e?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [scopeFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const openSessions = useCallback(async (date: string) => {
    if (openDate === date) {
      setOpenDate(null);
      setSessions([]);
      return;
    }
    setOpenDate(date);
    setSessionsLoading(true);
    try {
      const res = await (window.api as any).tokenUsageSessions(
        date,
        scopeFilter || undefined
      );
      setSessions(res?.sessions || []);
    } catch {
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, [openDate, scopeFilter]);

  // 按日期分组（服务端已按 date DESC 排序）
  const byDate: Array<{ date: string; rows: DayRow[] }> = [];
  for (const r of days) {
    const last = byDate[byDate.length - 1];
    if (last && last.date === r.date) last.rows.push(r);
    else byDate.push({ date: r.date, rows: [r] });
  }
  const dayTotals = (rows: DayRow[]) => ({
    rounds: rows.reduce((a, r) => a + r.rounds, 0),
    input: rows.reduce((a, r) => a + r.input, 0),
    cache_read: rows.reduce((a, r) => a + r.cache_read, 0),
    output: rows.reduce((a, r) => a + r.output, 0),
    total_tokens: rows.reduce((a, r) => a + r.total_tokens, 0),
    cost: rows.reduce((a, r) => a + r.cost, 0),
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0 }}>Token 用量</h3>
          <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
            数值为模型返回字段原样汇总；输入/缓存/输出为每轮实际发送的真实计费口径（含系统提示词与工具定义）。
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value)}
            style={{ padding: "6px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
          >
            <option value="">全部渠道</option>
            <option value="parent">家长助手</option>
            <option value="child">孩子主会话</option>
            <option value="scene">场景课</option>
            <option value="course">课程会话</option>
          </select>
          <button
            onClick={load}
            disabled={loading}
            style={{
              padding: "8px 16px",
              background: "#667eea",
              color: "white",
              border: "none",
              borderRadius: 8,
              cursor: loading ? "default" : "pointer",
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "加载中..." : "刷新"}
          </button>
        </div>
      </div>

      {err && <div style={{ color: "red", marginBottom: 12 }}>{err}</div>}
      {!loading && days.length === 0 && !err && (
        <div style={{ color: "#999", padding: 24, textAlign: "center" }}>
          暂无数据——聊天产生消耗后这里会出现按日期的统计
        </div>
      )}

      {byDate.map(({ date, rows }) => {
        const t = dayTotals(rows);
        const expanded = openDate === date;
        return (
          <div key={date} style={{ marginBottom: 14, border: "1px solid #e8eaf6", borderRadius: 10, overflow: "hidden" }}>
            {/* 日期头（点击展开该天会话明细） */}
            <div
              onClick={() => openSessions(date)}
              style={{ background: "#f8f9ff", padding: "10px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}
            >
              <div style={{ fontWeight: 700, fontSize: 14 }}>
                {expanded ? "▾" : "▸"} {date}
                <span style={{ fontSize: 12, color: "#888", marginLeft: 8, fontWeight: 400 }}>
                  共 {t.rounds} 轮 · 点击{expanded ? "收起" : "看会话明细"}
                </span>
              </div>
              <div style={{ fontSize: 13, color: "#555", fontVariantNumeric: "tabular-nums" }}>
                输入 {formatNum(t.input)} · 缓存读 {formatNum(t.cache_read)} · 输出 {formatNum(t.output)} · 合计{" "}
                <b>{formatNum(t.total_tokens)}</b> tok · {formatCost(t.cost)}
              </div>
            </div>
            {/* 渠道行 */}
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: "#888", background: "#fcfcfe" }}>
                  <th style={{ ...thL, paddingLeft: 14 }}>渠道</th>
                  <th style={th}>轮次</th>
                  <th style={th}>输入</th>
                  <th style={th}>缓存读</th>
                  <th style={th}>输出</th>
                  <th style={th}>合计 tok</th>
                  <th style={th}>费用</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.scope}-${r.child_id}-${i}`} style={{ borderTop: "1px solid #f0f0f0" }}>
                    <td style={{ ...tdL, paddingLeft: 14 }}>{scopeLabel(r)}</td>
                    <td style={td}>{r.rounds}</td>
                    <td style={td}>{formatNum(r.input)}</td>
                    <td style={td}>{formatNum(r.cache_read)}</td>
                    <td style={td}>
                      {formatNum(r.output)}
                      {r.reasoning > 0 && (
                        <span style={{ fontSize: 11, color: "#999" }}>（含思考 {formatNum(r.reasoning)}）</span>
                      )}
                    </td>
                    <td style={{ ...td, fontWeight: 600 }}>{formatNum(r.total_tokens)}</td>
                    <td style={td}>{formatCost(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* 会话明细（点开某天） */}
            {expanded && (
              <div style={{ borderTop: "1px solid #e8eaf6", background: "#fffdf5", padding: "8px 10px" }}>
                {sessionsLoading ? (
                  <div style={{ color: "#888", padding: 8, fontSize: 13 }}>加载会话明细...</div>
                ) : sessions.length === 0 ? (
                  <div style={{ color: "#999", padding: 8, fontSize: 13 }}>该天无会话明细</div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                    <thead>
                      <tr style={{ color: "#888" }}>
                        <th style={{ ...thL }}>会话</th>
                        <th style={thL}>模型</th>
                        <th style={thL}>时段</th>
                        <th style={th}>轮次</th>
                        <th style={th}>输入</th>
                        <th style={th}>缓存读</th>
                        <th style={th}>缓存写</th>
                        <th style={th}>输出</th>
                        <th style={th}>合计 tok</th>
                        <th style={th}>费用</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((s) => (
                        <tr key={s.session_file} style={{ borderTop: "1px solid #f5f2e8" }}>
                          <td style={tdL}>
                            <span title={s.session_file} style={{ fontFamily: "monospace" }}>
                              {sessionShortId(s.session_file)}
                            </span>
                            <span style={{ fontSize: 11, color: "#888", marginLeft: 6 }}>{scopeLabel(s)}</span>
                          </td>
                          <td style={{ ...tdL, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.models}>
                            {s.models || "-"}
                          </td>
                          <td style={tdL}>
                            {fmtTime(s.first_ts)}–{fmtTime(s.last_ts)}
                          </td>
                          <td style={td}>{s.rounds}</td>
                          <td style={td}>{formatNum(s.input)}</td>
                          <td style={td}>{formatNum(s.cache_read)}</td>
                          <td style={td}>{formatNum(s.cache_write)}</td>
                          <td style={td}>{formatNum(s.output)}</td>
                          <td style={{ ...td, fontWeight: 600 }}>{formatNum(s.total_tokens)}</td>
                          <td style={td}>{formatCost(s.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
