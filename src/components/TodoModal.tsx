import { useCallback, useEffect, useState } from "react";
import { ListTodo, TrendingUp, X, Sparkles } from "lucide-react";

/**
 * 孩子端「今日计划」弹框（2026-09-10 计划域重构版）。
 *
 * - **今日计划**：动态 todolist —— 三张计划表（学习/生活/考核）中「窗口覆盖当天」的行，
 *   按**制定人**分两组展示：必须完成项（家长制定）/ 加分项（孩子自定）。
 *   ⚠️ **不提供勾选**（设计定案）：完成与否由 LLM/系统判定（生活靠对话证据、学习靠课程学习时间、考核靠提交），
 *   孩子勾选会造成虚报。家长可在家长端「积分」页做审计与修正。
 * - **我的执行力**：近 N 天完成率趋势（来自 reward_daily_stats 按日汇总）。
 * - **我的积分**：余额 + 积分流水（每一分变动都有原因）+ 门控未解锁提示。
 */
interface PlanItem {
  planId: string;
  kind: "study" | "life" | "exam";
  title: string;
  topicKey: string;
  mode: string;
  owner: string; // parent=必须完成项 / child=加分项
  origin: string;
  startAt: string;
  dueAt: string;
  status: string; // pending | done | missed | cancelled
  doneAt: string;
  carry: boolean;
  taskType?: string;
  points?: number;
  score?: number;
}

interface StatsRow {
  date: string;
  total: number;
  done: number;
  rate: number;
  points: number;
  missed: number;
  cancelled: number;
  optionalDone: number;
}

interface LedgerRow {
  id: string;
  ts: string;
  bizDate: string;
  type: string;
  amount: number;
  balanceAfter: number;
  reasonCode: string;
  reason: string;
  rate: number | null;
  operator: string;
}

interface RewardData {
  balance: number;
  totals: { earned: number; deducted: number; redeemed: number };
  stats: Array<{
    source: string;
    owner: string;
    total: number;
    done: number;
    missed: number;
    rate: number;
    tier: string;
    gateOk: number | null;
    pointsAwarded: number;
  }>;
  gateBlocked: Array<{ source: string; rate: number; tier: string }>;
  ledger: LedgerRow[];
}

const KIND_LABEL: Record<string, string> = { study: "学习", life: "生活", exam: "考核" };
const STATUS_ICON: Record<string, string> = { done: "✅", missed: "❌", pending: "⬜", cancelled: "🚫" };

function fmtDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return `${m}月${d}日`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const BAR_MIN = 4;
const RATE_OK = 0.8;

export default function TodoModal({
  childId,
  onClose,
  onStartCourse,
}: {
  childId: string;
  onClose: () => void;
  onStartCourse?: (courseKey: string) => void;
}) {
  const [tab, setTab] = useState<"today" | "stats" | "points">("today");
  const [items, setItems] = useState<PlanItem[]>([]);
  const [today, setToday] = useState("");
  const [rows, setRows] = useState<StatsRow[]>([]);
  const [reward, setReward] = useState<RewardData | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [t, s, r] = await Promise.all([
        window.api.todoGet(childId),
        window.api.todoStatsList(childId, 30),
        window.api.rewardGet(childId, { days: 30, limit: 60 }),
      ]);
      if (t?.success) {
        setToday(t.date || "");
        setItems(Array.isArray((t as any).items) ? ((t as any).items as PlanItem[]) : []);
      }
      if (s?.success && Array.isArray(s.rows)) setRows(s.rows as StatsRow[]);
      if (r?.success) setReward(r as unknown as RewardData);
    } catch {
      /* 读取失败保持空态 */
    } finally {
      setLoading(false);
    }
  }, [childId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const active = items.filter((i) => i.status !== "cancelled");
  const doneCount = active.filter((i) => i.status === "done").length;
  const rate = active.length > 0 ? doneCount / active.length : 0;
  const parentItems = active.filter((i) => i.owner === "parent");
  const childItems = active.filter((i) => i.owner !== "parent");
  const bestStreak = (() => {
    let best = 0;
    let cur = 0;
    for (const r of [...rows].reverse()) {
      if (r.rate >= RATE_OK) {
        cur++;
        best = Math.max(best, cur);
      } else cur = 0;
    }
    return best;
  })();
  const curStreak = (() => {
    let cur = 0;
    for (const r of rows) {
      if (r.rate >= RATE_OK) cur++;
      else break;
    }
    return cur;
  })();

  const renderGroup = (title: string, list: PlanItem[], accent: string, bg: string, border: string) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: accent, marginBottom: 6 }}>
        {title}（{list.filter((i) => i.status === "done").length}/{list.length}）
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {list.map((it) => (
          <div
            key={it.planId}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "8px 10px",
              borderRadius: 8,
              background: bg,
              border: `1px solid ${border}`,
            }}
          >
            <span style={{ fontSize: 16, lineHeight: "22px", flexShrink: 0 }}>{STATUS_ICON[it.status] ?? "⬜"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: "inline-block",
                  fontSize: 11,
                  color: "#475569",
                  background: "#e2e8f0",
                  borderRadius: 4,
                  padding: "1px 6px",
                  marginRight: 6,
                }}
              >
                {KIND_LABEL[it.kind] ?? it.kind}
              </span>
              {it.carry && (
                <span style={{ fontSize: 11, color: "#a32d2d", marginRight: 6 }} title="由未完成计划顺延而来">
                  顺延
                </span>
              )}
              <span
                style={{
                  fontSize: 14,
                  lineHeight: 1.5,
                  color: it.status === "done" ? "#aaa" : it.status === "missed" ? "#a32d2d" : "#333",
                  textDecoration: it.status === "done" ? "line-through" : "none",
                  wordBreak: "break-word",
                }}
              >
                {it.title}
              </span>
              {it.kind === "study" && it.topicKey === "english" && it.status === "pending" && (
                <button
                  onClick={() => onStartCourse?.(`english:${it.title}`)}
                  style={{
                    display: "inline-block",
                    marginLeft: 8,
                    border: "none",
                    background: "#185FA5",
                    color: "white",
                    padding: "3px 10px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: "pointer",
                    verticalAlign: "middle",
                  }}
                  title="进入英语课专用会话（全程英文教学）"
                >
                  🌍 进入课程
                </button>
              )}
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
                {it.dueAt ? `截止 ${fmtTime(it.dueAt)}` : ""}
                {it.status === "missed" ? " · 未完成" : ""}
                {it.status === "done" && it.doneAt ? ` · 完成于 ${fmtTime(it.doneAt)}` : ""}
                {it.status === "pending" && it.kind === "life" ? " · 完成后跟 AI 老师说一声即可" : ""}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal todo-modal" onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: "92vw" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>📋 今日计划</h2>
          <button
            onClick={onClose}
            title="关闭"
            style={{ border: "none", background: "transparent", cursor: "pointer", color: "#888", padding: 4 }}
          >
            <X size={20} />
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 12, borderBottom: "1px solid #eee", paddingBottom: 8 }}>
          {(
            [
              ["today", <ListTodo size={16} key="a" />, "今日计划"],
              ["stats", <TrendingUp size={16} key="b" />, "我的执行力"],
              ["points", <Sparkles size={16} key="c" />, "我的积分"],
            ] as const
          ).map(([key, icon, label]) => (
            <button
              key={key}
              onClick={() => setTab(key as "today" | "stats" | "points")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                border: "none",
                background: tab === key ? "#667eea" : "transparent",
                color: tab === key ? "white" : "#666",
                padding: "6px 14px",
                borderRadius: 8,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {icon} {label}
            </button>
          ))}
        </div>

        {loading ? (
          <p style={{ color: "#888", fontSize: 13 }}>加载中…</p>
        ) : tab === "today" ? (
          <div style={{ maxHeight: 430, overflowY: "auto" }}>
            {today && <div style={{ fontSize: 12, color: "#999", marginBottom: 8 }}>{fmtDate(today)} 要做的事</div>}
            {active.length === 0 ? (
              <p style={{ color: "#999", fontSize: 13, lineHeight: 1.8 }}>今天还没有安排～ 可以跟 AI 老师聊聊今天想做什么。</p>
            ) : (
              <>
                {parentItems.length > 0 && renderGroup("必须完成项", parentItems, "#b45309", "#fff7ed", "#fed7aa")}
                {childItems.length > 0 && renderGroup("加分项", childItems, "#4f46e5", "#f5f7ff", "#e2e8ff")}
              </>
            )}
            {active.length > 0 && (
              <div style={{ fontSize: 12, color: "#999", marginTop: 12, lineHeight: 1.6 }}>
                {doneCount}/{active.length} 已完成（{Math.round(rate * 100)}%）
                {curStreak > 0 && <> · 🔥 已连续达标 {curStreak} 天</>}
                <br />
                完成情况由系统自动核对（不用手动打勾）；家长可以查看记录并做修正。
              </div>
            )}
          </div>
        ) : tab === "stats" ? (
          <div style={{ maxHeight: 430, overflowY: "auto" }}>
            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              {[
                [`🔥 ${curStreak}`, "连续达标天数", "#667eea", "#f5f7ff", "#e2e8ff"],
                [bestStreak > 0 ? String(bestStreak) : "—", "历史最高连续", "#22c55e", "#f0fdf4", "#bbf7d0"],
                [
                  rows.length ? `${Math.round(rows[0].rate * 100)}%` : "—",
                  "最近完成率",
                  "#f59e0b",
                  "#fff7ed",
                  "#fed7aa",
                ],
              ].map(([v, label, color, bg, border], i) => (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    background: bg as string,
                    border: `1px solid ${border}`,
                    borderRadius: 10,
                    padding: "10px 12px",
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: 22, fontWeight: 700, color: color as string }}>{v}</div>
                  <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#444", marginBottom: 6 }}>近 30 天完成率</div>
            {rows.length === 0 ? (
              <p style={{ color: "#999", fontSize: 13 }}>还没有执行力数据。</p>
            ) : (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 120 }}>
                {[...rows].reverse().map((r, i, arr) => {
                  const pct = Math.max(0, Math.min(1, r.rate));
                  const h = Math.max(BAR_MIN, Math.round(pct * 100));
                  const ok = pct >= RATE_OK;
                  return (
                    <div
                      key={r.date}
                      title={`${fmtDate(r.date)}：${r.done}/${r.total}（${Math.round(pct * 100)}%）${ok ? " ✅达标" : ""}${
                        r.points ? ` 积分 ${r.points > 0 ? "+" : ""}${r.points}` : ""
                      }`}
                      style={{
                        flex: 1,
                        minWidth: 4,
                        background: ok ? "#667eea" : "#cbd5e1",
                        height: `${h}px`,
                        borderRadius: "3px 3px 0 0",
                        opacity: i === arr.length - 1 ? 1 : 0.75,
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div style={{ maxHeight: 430, overflowY: "auto" }}>
            <div
              style={{
                background: "linear-gradient(135deg,#667eea,#764ba2)",
                color: "white",
                borderRadius: 12,
                padding: "14px 16px",
                marginBottom: 14,
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.85 }}>我的积分</div>
              <div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.2 }}>{reward?.balance ?? 0}</div>
              {reward && (
                <div style={{ fontSize: 11, opacity: 0.85, marginTop: 4 }}>
                  累计获得 {reward.totals.earned} · 扣除 {reward.totals.deducted}
                  {reward.totals.redeemed > 0 ? ` · 已兑换 ${reward.totals.redeemed}` : ""}
                </div>
              )}
            </div>

            {reward?.gateBlocked?.length ? (
              <div
                style={{
                  background: "#fffbeb",
                  border: "1px solid #fde68a",
                  borderRadius: 8,
                  padding: "8px 10px",
                  fontSize: 12,
                  color: "#92400e",
                  marginBottom: 12,
                  lineHeight: 1.6,
                }}
              >
                本次未加分：必须完成项还没完成。
                <br />
                （如果必须完成项全部完成，本次就能拿到积分啦）
              </div>
            ) : null}

            {reward?.stats?.length ? (
              <div style={{ fontSize: 13, fontWeight: 600, color: "#444", marginBottom: 6 }}>今日结算</div>
            ) : null}
            {reward?.stats?.map((s, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                  color: "#555",
                  padding: "6px 2px",
                  borderBottom: "1px solid #f1f5f9",
                }}
              >
                <span>
                  {s.source === "exam" ? "考核" : "计划"} · {s.owner === "parent" ? "必须完成项" : "加分项"}
                  {s.tier ? ` · ${s.tier}` : ""}
                </span>
                <span>
                  {s.done}/{s.total}（{Math.round(s.rate * 100)}%）{" "}
                  <b style={{ color: s.pointsAwarded > 0 ? "#16a34a" : s.pointsAwarded < 0 ? "#dc2626" : "#94a3b8" }}>
                    {s.pointsAwarded > 0 ? `+${s.pointsAwarded}` : s.pointsAwarded || 0}
                  </b>
                </span>
              </div>
            ))}

            <div style={{ fontSize: 13, fontWeight: 600, color: "#444", margin: "14px 0 6px" }}>积分明细</div>
            {!reward?.ledger?.length ? (
              <p style={{ color: "#999", fontSize: 13 }}>还没有积分记录。完成计划就能拿分啦～</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {reward.ledger.map((l) => (
                  <div key={l.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#555" }}>
                    <span style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                      {l.reason || l.reasonCode}
                      <span style={{ color: "#b0b7c3", marginLeft: 6 }}>{fmtTime(l.ts)}</span>
                    </span>
                    <b style={{ color: l.type === "deduct" ? "#dc2626" : l.type === "redeem" ? "#7c3aed" : "#16a34a" }}>
                      {l.type === "deduct" ? "-" : l.type === "redeem" ? "-" : "+"}
                      {l.amount}
                    </b>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
