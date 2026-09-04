import { useEffect, useState } from "react";
import { ListTodo, TrendingUp, X } from "lucide-react";

/**
 * ISSUE-025 重构（2026-09-04）：孩子端「今日计划」弹框。
 * - 「今日计划」标签：只读展示当天 todolist（一事一条）。来源=家长（parent，来自学习计划）项带「家长安排」
 *   标签；来源=孩子（child）为孩子自规划项。列表只读，不提供手动勾选（完成判定由系统/agent 自动核对）。
 * - 「我的执行力」标签：近 N 天完成率趋势（柱状）+ 连续达标天数 + 家长项 vs 自规划项对比。
 *   数据源服务端 child_todo_stats（kb.todo.stats.list，经 todo:stats:list IPC 读取）。
 */
interface TodoStatsRow {
  date: string;
  total: number;
  done: number;
  parent_total: number;
  parent_done: number;
  self_total: number;
  self_done: number;
  rate: number;
  streak: number;
}

interface TodoRow {
  id: string;
  title: string;
  source: string;
  status: string;
  note: string;
  due_time: string;   // 约定截止 HH:MM（孩子自规划可带）
  done_time: string;  // 真实完成时刻 ISO（打勾时写）
  done_at: string;    // 完成日期 YYYY-MM-DD
}

interface TodoItem {
  done: boolean;
  isParent: boolean;
  text: string;
  note: string;
  dueTime: string;    // HH:MM 或 ""
  doneTime: string;   // ISO 或 ""
}

/** 约定 HH:MM 前完成 + 已完成后 → 判定按时/超时。dueTime 空或未完成不算。 */
function isOnTime(it: { dueTime: string; doneTime: string }): boolean | undefined {
  const due = it.dueTime || "";
  const doneIso = it.doneTime || "";
  if (!/^\d{2}:\d{2}$/.test(due)) return undefined;
  if (!doneIso) return undefined; // 未完成
  // doneIso 是 UTC ISO；取它的本地时分
  const d = new Date(doneIso);
  if (isNaN(d.getTime())) return undefined;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}` <= due;
}

function fmtDate(date: string): string {
  // YYYY-MM-DD → M月D日
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return `${m}月${d}日`;
}

const BAR_MIN = 4; // 极低完成率也保留可见高度
const RATE_OK = 0.8; // 对齐主进程 DONE_RATE_OK

export default function TodoModal({
  childId,
  onClose,
}: {
  childId: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"today" | "stats">("today");
  const [todoRows, setTodoRows] = useState<TodoRow[]>([]);
  const [today, setToday] = useState("");
  const [rows, setRows] = useState<TodoStatsRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [t, s] = await Promise.all([
          window.api.todoGet(childId),
          window.api.todoStatsList(childId, 30),
        ]);
        if (!alive) return;
        if (t?.success) {
          setToday(t.date || "");
          setTodoRows(Array.isArray(t.rows) ? (t.rows as TodoRow[]) : []);
        }
        if (s?.success && Array.isArray(s.rows)) {
          setRows(s.rows as TodoStatsRow[]);
        }
      } catch {
        /* 读取失败保持空态 */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [childId]);

  const items: TodoItem[] = todoRows.map((r) => ({
    done: r.status === "done",
    isParent: r.source === "parent",
    text: r.title || "",
    note: r.note || "",
    dueTime: r.due_time || "",
    doneTime: r.done_time || "",
  }));
  const doneCount = items.filter((i) => i.done).length;
  const rate = items.length > 0 ? doneCount / items.length : 0;
  // 「时间规划」汇总：设了 due 的自规划项里，按时完成的数量
  const timedItems = items.filter((i) => /^\d{2}:\d{2}$/.test(i.dueTime));
  const timedOnTime = timedItems.filter((i) => isOnTime(i) === true).length;
  const timedLate = timedItems.filter((i) => isOnTime(i) === false).length;
  // 连续达标天数取最近一条（今天的统计若已生成，即今天；否则沿用昨天）
  const streak = rows.length > 0 ? rows[0].streak : 0;
  const lastOk = rows.find((r) => r.rate >= RATE_OK);
  const bestStreak = rows.reduce((mx, r) => Math.max(mx, r.streak), 0);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal todo-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 520, maxWidth: "92vw" }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 4,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18 }}>📋 今日计划</h2>
          <button
            onClick={onClose}
            title="关闭"
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: "#888",
              padding: 4,
            }}
          >
            <X size={20} />
          </button>
        </div>

        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 12,
            borderBottom: "1px solid #eee",
            paddingBottom: 8,
          }}
        >
          <button
            onClick={() => setTab("today")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              border: "none",
              background: tab === "today" ? "#667eea" : "transparent",
              color: tab === "today" ? "white" : "#666",
              padding: "6px 14px",
              borderRadius: 8,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <ListTodo size={16} /> 今日计划
          </button>
          <button
            onClick={() => setTab("stats")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              border: "none",
              background: tab === "stats" ? "#667eea" : "transparent",
              color: tab === "stats" ? "white" : "#666",
              padding: "6px 14px",
              borderRadius: 8,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <TrendingUp size={16} /> 我的执行力
          </button>
        </div>

        {loading ? (
          <p style={{ color: "#888", fontSize: 13 }}>加载中…</p>
        ) : tab === "today" ? (
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {today && (
              <div style={{ fontSize: 12, color: "#999", marginBottom: 8 }}>
                {fmtDate(today)} 的计划
              </div>
            )}
            {items.length === 0 ? (
              <p style={{ color: "#999", fontSize: 13, lineHeight: 1.8 }}>
                今天还没有计划。
                <br />
                可以让 AI 老师帮你写一份今日计划，或等家长开启定时生成（每天自动安排）。
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {items.map((it, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: it.isParent ? "#fff7ed" : "#f5f7ff",
                      border: it.isParent ? "1px solid #fed7aa" : "1px solid #e2e8ff",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 16,
                        lineHeight: "22px",
                        color: it.done ? "#48bb78" : "#ccc",
                        flexShrink: 0,
                      }}
                    >
                      {it.done ? "✅" : "⬜"}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {it.isParent && (
                        <span
                          style={{
                            display: "inline-block",
                            fontSize: 11,
                            color: "#b45309",
                            background: "#ffedd5",
                            borderRadius: 4,
                            padding: "1px 6px",
                            marginRight: 6,
                            marginBottom: 2,
                          }}
                        >
                          家长安排
                        </span>
                      )}
                      <span
                        style={{
                          fontSize: 14,
                          lineHeight: 1.5,
                          color: it.done ? "#aaa" : "#333",
                          textDecoration: it.done ? "line-through" : "none",
                          wordBreak: "break-word",
                        }}
                      >
                        {it.text}
                      </span>
                      {/^\d{2}:\d{2}$/.test(it.dueTime) && (
                        <span
                          style={{
                            display: "inline-block",
                            fontSize: 11,
                            marginLeft: 6,
                            padding: "0 5px",
                            borderRadius: 4,
                            background: it.done ? (isOnTime(it) ? "#eaf3de" : "#fcebeb") : "#faeeda",
                            color: it.done ? (isOnTime(it) ? "#3b6d11" : "#a32d2d") : "#854f0b",
                          }}
                        >
                          {it.done
                            ? isOnTime(it)
                              ? `⏰ ${it.dueTime}前 · 按时✓`
                              : `⏰ ${it.dueTime}前 · 超时`
                            : `⏰ ${it.dueTime}前`}
                        </span>
                      )}
                      {it.note && (
                        <span style={{ fontSize: 11, color: "#999", marginLeft: 6 }}>（{it.note}）</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {items.length > 0 && (
              <div style={{ fontSize: 12, color: "#999", marginTop: 12, lineHeight: 1.6 }}>
                {doneCount}/{items.length} 已完成（{Math.round(rate * 100)}%）
                {streak > 0 && <> · 🔥 已连续达标 {streak} 天</>}
                {timedItems.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    {timedItems.length} 项设了时间 · {timedOnTime} 项按时
                    {timedLate > 0 ? <> · {timedLate} 项超时</> : ""}
                  </div>
                )}
                <br />
                完成情况由 AI 老师每天自动核对，不用手动打勾～
              </div>
            )}
          </div>
        ) : (
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {/* 概览卡片 */}
            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <div
                style={{
                  flex: 1,
                  background: "#f5f7ff",
                  border: "1px solid #e2e8ff",
                  borderRadius: 10,
                  padding: "10px 12px",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 22, fontWeight: 700, color: "#667eea" }}>
                  {streak > 0 ? `🔥 ${streak}` : "—"}
                </div>
                <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>连续达标天数</div>
              </div>
              <div
                style={{
                  flex: 1,
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  borderRadius: 10,
                  padding: "10px 12px",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 22, fontWeight: 700, color: "#22c55e" }}>
                  {bestStreak > 0 ? bestStreak : "—"}
                </div>
                <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>历史最高连续</div>
              </div>
              <div
                style={{
                  flex: 1,
                  background: "#fff7ed",
                  border: "1px solid #fed7aa",
                  borderRadius: 10,
                  padding: "10px 12px",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 22, fontWeight: 700, color: "#f59e0b" }}>
                  {lastOk ? `${Math.round(lastOk.rate * 100)}%` : "—"}
                </div>
                <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>最近完成率</div>
              </div>
            </div>

            {/* 近 30 天完成率柱状 */}
            <div style={{ fontSize: 13, fontWeight: 600, color: "#444", marginBottom: 6 }}>
              近 30 天完成率
            </div>
            {rows.length === 0 ? (
              <p style={{ color: "#999", fontSize: 13, lineHeight: 1.8 }}>
                还没有执行力数据。
                <br />
                开启今日计划并运行几天后，这里会显示每天的完成情况。
              </p>
            ) : (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 120 }}>
                {rows.map((r, i) => {
                  const pct = Math.max(0, Math.min(1, r.rate));
                  const h = Math.max(BAR_MIN, Math.round(pct * 100));
                  const ok = pct >= RATE_OK;
                  return (
                    <div
                      key={r.date}
                      title={`${fmtDate(r.date)}：${r.done}/${r.total}（${Math.round(pct * 100)}%）${ok ? " ✅达标" : ""}`}
                      style={{
                        flex: 1,
                        minWidth: 4,
                        background: ok ? "#667eea" : "#cbd5e1",
                        height: `${h}px`,
                        borderRadius: "3px 3px 0 0",
                        opacity: i === rows.length - 1 ? 1 : 0.75,
                      }}
                    />
                  );
                })}
              </div>
            )}

            {/* 家长项 vs 自规划项 */}
            <div style={{ fontSize: 13, fontWeight: 600, color: "#444", margin: "14px 0 6px" }}>
              家长安排 vs 自己计划
            </div>
            {(() => {
              const pp = rows[rows.length - 1];
              const showRows = rows.filter((r) => r.total > 0).slice(-7);
              if (!pp && showRows.length === 0) {
                return <p style={{ color: "#999", fontSize: 13 }}>暂无对比数据。</p>;
              }
              const cur = pp && pp.total > 0 ? pp : showRows[showRows.length - 1];
              if (!cur) return <p style={{ color: "#999", fontSize: 13 }}>暂无对比数据。</p>;
              const bar = (done: number, total: number) => {
                const p = total > 0 ? done / total : 0;
                return (
                  <div style={{ flex: 1, height: 8, background: "#eef0f4", borderRadius: 4, overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.round(p * 100)}%`,
                        background: "#667eea",
                        borderRadius: 4,
                      }}
                    />
                  </div>
                );
              };
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 12, color: "#b45309", width: 90, flexShrink: 0 }}>
                      🧑‍🏫 家长安排
                    </span>
                    {bar(cur.parent_done, cur.parent_total)}
                    <span style={{ fontSize: 12, color: "#666", width: 70, textAlign: "right", flexShrink: 0 }}>
                      {cur.parent_done}/{cur.parent_total}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 12, color: "#667eea", width: 90, flexShrink: 0 }}>
                      🧒 自己计划
                    </span>
                    {bar(cur.self_done, cur.self_total)}
                    <span style={{ fontSize: 12, color: "#666", width: 70, textAlign: "right", flexShrink: 0 }}>
                      {cur.self_done}/{cur.self_total}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: "#aaa", marginTop: 2 }}>
                    （{fmtDate(cur.date)}，共 {cur.total} 项）
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
