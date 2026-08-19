import { useState, useEffect, useCallback } from "react";

/**
 * Token 消耗面板（ISSUE-010）
 *
 * 数据来源：window.api.getTokenSummary(childId?) / getTokenList(childId?, limit)
 *  - 每个孩子一份隔离日志（data/children/<childId>/token-log.jsonl）
 *  - 家长会话一份全局日志（data/token-log.jsonl）
 * 面板聚合展示：汇总卡（全部孩子+家长合计）、按孩子、按模型、最近明细（可过滤孩子）。
 */

interface Props {
  childrenList: any[];
}

interface Summary {
  rounds: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  totalTokens: number;
  lastTs: string | null;
  byModel: Record<string, { rounds: number; input: number; output: number; cost: number }>;
}

interface Entry {
  seq: number;
  ts: string;
  channel: "child" | "parent" | "scheduler";
  childId?: string;
  sessionFile?: string;
  model: string;
  ok: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  totalTokens: number;
  existingTokens: number;
  newTokens: number;
  assistantCalls: number;
  replyLength?: number;
}

const EMPTY_SUMMARY: Summary = {
  rounds: 0,
  totalInput: 0,
  totalOutput: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  totalCost: 0,
  totalTokens: 0,
  lastTs: null,
  byModel: {},
};

function formatTs(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatCost(cost: number): string {
  if (!cost) return "0";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

function formatNum(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
}

function shortModel(model: string): string {
  const [provider, id] = model.split("/");
  return id ? `${provider}·${id}` : model;
}

export default function TokenStatsPanel({ childrenList }: Props) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  // "__parent__" 表示家长会话（全局日志）；key 为 childId 表示孩子
  const [summaries, setSummaries] = useState<Record<string, Summary>>({});
  const [entries, setEntries] = useState<Entry[]>([]);
  const [filterChild, setFilterChild] = useState<string>("all");

  const childName = useCallback(
    (childId?: string) => {
      if (!childId) return "家长会话";
      const c = childrenList.find((c) => c.childId === childId);
      return c ? `${c.avatar || "🧒"} ${c.name}` : childId.slice(0, 8);
    },
    [childrenList]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const childIds = childrenList.map((c: any) => c.childId);
      const summaryResults = await Promise.all([
        window.api.getTokenSummary(null),
        ...childIds.map((id) => window.api.getTokenSummary(id)),
      ]);
      const newSummaries: Record<string, Summary> = {};
      newSummaries.__parent__ = summaryResults[0]?.summary || EMPTY_SUMMARY;
      childIds.forEach((id, i) => {
        newSummaries[id] = summaryResults[i + 1]?.summary || EMPTY_SUMMARY;
      });
      setSummaries(newSummaries);

      const listResults = await Promise.all([
        window.api.getTokenList(null, 200),
        ...childIds.map((id) => window.api.getTokenList(id, 200)),
      ]);
      const merged: Entry[] = listResults.flatMap((r) => r?.entries || []);
      merged.sort((a, b) => (a.ts < b.ts ? 1 : -1));
      setEntries(merged.slice(0, 100));
    } catch (e: any) {
      setErr(e?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [childrenList]);

  useEffect(() => {
    load();
  }, [load]);

  // ---- 聚合 ----
  const allSummaries = Object.values(summaries);
  const total: Summary = allSummaries.reduce((acc, s) => {
    acc.rounds += s.rounds;
    acc.totalInput += s.totalInput;
    acc.totalOutput += s.totalOutput;
    acc.totalCacheRead += s.totalCacheRead;
    acc.totalCacheWrite += s.totalCacheWrite;
    acc.totalCost += s.totalCost;
    acc.totalTokens += s.totalTokens;
    if (!acc.lastTs || (s.lastTs && s.lastTs > acc.lastTs)) acc.lastTs = s.lastTs;
    for (const [model, m] of Object.entries(s.byModel)) {
      const t = (acc.byModel[model] ||= { rounds: 0, input: 0, output: 0, cost: 0 });
      t.rounds += m.rounds;
      t.input += m.input;
      t.output += m.output;
      t.cost += m.cost;
    }
    return acc;
  }, JSON.parse(JSON.stringify(EMPTY_SUMMARY)) as Summary);

  const byModelList = Object.entries(total.byModel).sort((a, b) => b[1].cost - a[1].cost);

  const filteredEntries =
    filterChild === "all"
      ? entries
      : entries.filter((e) => (e.childId || "__parent__") === filterChild);

  const cardStyle: React.CSSProperties = {
    background: "#f8f9ff",
    border: "1px solid #e8eaf6",
    borderRadius: 12,
    padding: "14px 16px",
    flex: 1,
    minWidth: 140,
  };
  const cardLabel: React.CSSProperties = { fontSize: 12, color: "#888", marginBottom: 6 };
  const cardValue: React.CSSProperties = { fontSize: 20, fontWeight: 700, color: "#333" };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h3 style={{ margin: 0 }}>Token 消耗</h3>
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

      {err && <div style={{ color: "red", marginBottom: 12 }}>{err}</div>}

      {/* 汇总卡 */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
        <div style={cardStyle}>
          <div style={cardLabel}>总轮次</div>
          <div style={cardValue}>{total.rounds.toLocaleString()}</div>
        </div>
        <div style={cardStyle}>
          <div style={cardLabel}>总输入 tokens</div>
          <div style={cardValue}>{formatNum(total.totalInput)}</div>
        </div>
        <div style={cardStyle}>
          <div style={cardLabel}>总输出 tokens</div>
          <div style={cardValue}>{formatNum(total.totalOutput)}</div>
        </div>
        <div style={cardStyle}>
          <div style={cardLabel}>缓存命中</div>
          <div style={cardValue}>{formatNum(total.totalCacheRead)}</div>
        </div>
        <div style={cardStyle}>
          <div style={cardLabel}>估算总费用</div>
          <div style={cardValue}>{formatCost(total.totalCost)}</div>
        </div>
        <div style={cardStyle}>
          <div style={cardLabel}>最近使用</div>
          <div style={{ ...cardValue, fontSize: 16 }}>{formatTs(total.lastTs)}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {/* 按孩子 / 渠道 */}
        <div style={{ flex: 1, minWidth: 320 }}>
          <h4 style={{ fontSize: 15, marginBottom: 12 }}>按孩子 / 渠道</h4>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: "#888", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>来源</th>
                <th style={{ padding: "6px 8px" }}>轮次</th>
                <th style={{ padding: "6px 8px" }}>输入</th>
                <th style={{ padding: "6px 8px" }}>输出</th>
                <th style={{ padding: "6px 8px" }}>费用</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(summaries).map(([key, s]) => (
                <tr key={key} style={{ borderTop: "1px solid #f0f0f0" }}>
                  <td style={{ padding: "8px" }}>{key === "__parent__" ? childName(undefined) : childName(key)}</td>
                  <td style={{ padding: "8px" }}>{s.rounds.toLocaleString()}</td>
                  <td style={{ padding: "8px" }}>{formatNum(s.totalInput)}</td>
                  <td style={{ padding: "8px" }}>{formatNum(s.totalOutput)}</td>
                  <td style={{ padding: "8px" }}>{formatCost(s.totalCost)}</td>
                </tr>
              ))}
              {Object.keys(summaries).length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 12, color: "#999" }}>暂无数据</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 按模型 */}
        <div style={{ flex: 1, minWidth: 320 }}>
          <h4 style={{ fontSize: 15, marginBottom: 12 }}>按模型</h4>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: "#888", textAlign: "left" }}>
                <th style={{ padding: "6px 8px" }}>模型</th>
                <th style={{ padding: "6px 8px" }}>轮次</th>
                <th style={{ padding: "6px 8px" }}>输入</th>
                <th style={{ padding: "6px 8px" }}>输出</th>
                <th style={{ padding: "6px 8px" }}>费用</th>
              </tr>
            </thead>
            <tbody>
              {byModelList.map(([model, m]) => (
                <tr key={model} style={{ borderTop: "1px solid #f0f0f0" }}>
                  <td style={{ padding: "8px" }}>{shortModel(model)}</td>
                  <td style={{ padding: "8px" }}>{m.rounds.toLocaleString()}</td>
                  <td style={{ padding: "8px" }}>{formatNum(m.input)}</td>
                  <td style={{ padding: "8px" }}>{formatNum(m.output)}</td>
                  <td style={{ padding: "8px" }}>{formatCost(m.cost)}</td>
                </tr>
              ))}
              {byModelList.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 12, color: "#999" }}>暂无数据</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 最近明细 */}
      <div style={{ marginTop: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h4 style={{ fontSize: 15, margin: 0 }}>最近明细</h4>
          <select
            value={filterChild}
            onChange={(e) => setFilterChild(e.target.value)}
            style={{ padding: "6px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
          >
            <option value="all">全部</option>
            {childrenList.map((c: any) => (
              <option key={c.childId} value={c.childId}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ maxHeight: 380, overflowY: "auto", border: "1px solid #f0f0f0", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead style={{ position: "sticky", top: 0, background: "#fafafa" }}>
              <tr style={{ color: "#888", textAlign: "left" }}>
                <th style={{ padding: "8px" }}>时间</th>
                <th style={{ padding: "8px" }}>来源</th>
                <th style={{ padding: "8px" }}>模型</th>
                <th style={{ padding: "8px" }}>输入</th>
                <th style={{ padding: "8px" }}>输出</th>
                <th style={{ padding: "8px" }}>缓存读</th>
                <th style={{ padding: "8px" }}>已有/新增</th>
                <th style={{ padding: "8px" }}>费用</th>
                <th style={{ padding: "8px" }}>结果</th>
              </tr>
            </thead>
            <tbody>
              {filteredEntries.map((e, i) => (
                <tr key={`${e.ts}-${i}`} style={{ borderTop: "1px solid #f5f5f5" }}>
                  <td style={{ padding: "8px", whiteSpace: "nowrap" }}>{formatTs(e.ts)}</td>
                  <td style={{ padding: "8px" }}>
                    {childName(e.childId)}
                    {e.channel === "scheduler" && (
                      <span style={{ fontSize: 11, color: "#667eea", marginLeft: 4 }}>⏰</span>
                    )}
                  </td>
                  <td style={{ padding: "8px", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.model}>
                    {shortModel(e.model)}
                  </td>
                  <td style={{ padding: "8px" }}>{formatNum(e.input)}</td>
                  <td style={{ padding: "8px" }}>{formatNum(e.output)}</td>
                  <td style={{ padding: "8px" }}>{formatNum(e.cacheRead)}</td>
                  <td style={{ padding: "8px", color: "#888" }}>
                    {formatNum(e.existingTokens)}/{formatNum(e.newTokens)}
                  </td>
                  <td style={{ padding: "8px" }}>{formatCost(e.cost)}</td>
                  <td style={{ padding: "8px" }}>
                    <span style={{ color: e.ok ? "#38a169" : "#e53e3e" }}>{e.ok ? "✓" : "✗"}</span>
                  </td>
                </tr>
              ))}
              {filteredEntries.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ padding: 16, color: "#999", textAlign: "center" }}>
                    暂无明细（聊天或定时任务产生消耗后出现）
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
