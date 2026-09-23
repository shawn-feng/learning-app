/**
 * 家长端 · 孩子详情「计划」tab（ISSUE-130）。
 *
 * 对齐孩子端「今日计划」（TodoModal）的语义与观感，但按**天**铺开（今天起 14 天）：
 *  - 数据源 = GET /plans/range（三域 study/life/exam 逐日聚合；重复规则未来命中日服务端虚拟展开）；
 *  - 每天分两组：**家长制定（必须完成项）** owner=parent / **孩子自己制定（加分项）** owner=child，
 *    组头带完成计数 x/y；
 *  - 行内：状态图标 ✅/⬜/❌/🚫 + 域标签（学习/生活/考核）+ 顺延📌 / 循环🔁 + 新学/复习 + 截止时间；
 *  - **只读**：完成与否由系统判定（孩子端不可勾选防虚报），家长的审计修正入口在「积分」tab
 *    （RewardPanel 计划审计与修正）。
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

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
  virtual?: boolean;
}

interface Props {
  childId: string;
}

const KIND_LABEL: Record<string, string> = { study: "学习", life: "生活", exam: "考核" };
const STATUS_ICON: Record<string, string> = { done: "✅", missed: "❌", pending: "⬜", cancelled: "🚫" };
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const RANGE_DAYS = 14;

function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** '2026-09-22' → {label: '9月22日 周一', today?: true, tomorrow?: true}。 */
function dayHeader(dateStr: string): { label: string; today: boolean; tomorrow: boolean } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const today = localToday();
  return {
    label: `${m}月${d}日 ${WEEKDAYS[dt.getDay()]}`,
    today: dateStr === today,
    tomorrow: dateStr !== today && dateStr === shift(today, 1),
  };
}

function shift(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function fmtDue(dueAt: string): string {
  // 23:59:59 的当天窗口不显示时刻，只有指定了具体时间的才显示
  const m = dueAt.match(/ (\d{2}:\d{2})/);
  return m && m[1] !== "23:59" ? ` · ${m[1]}前` : "";
}

export default function ChildDailyPlans({ childId }: Props) {
  const [days, setDays] = useState<Array<{ date: string; items: PlanItem[] }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r: any = await window.api.plansRange(childId, localToday(), RANGE_DAYS);
      if (r?.success) setDays(r.days || []);
      else setError(r?.error || "加载计划失败");
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [childId]);

  useEffect(() => {
    load();
  }, [load]);

  const renderItem = (it: PlanItem, key: string) => {
    const done = it.status === "done";
    const missed = it.status === "missed";
    const modeTag = it.kind === "study" ? (it.mode === "review" ? "复习" : it.mode === "new" ? "新学" : "") : "";
    return (
      <div
        key={key}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          padding: "6px 10px",
          borderRadius: 8,
          background: "#fff",
          border: "1px solid #eef0f4",
        }}
      >
        <span style={{ fontSize: 15, lineHeight: "20px", flexShrink: 0 }} title={it.status}>
          {STATUS_ICON[it.status] ?? "⬜"}
        </span>
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
          {it.virtual && (
            <span style={{ fontSize: 11, color: "#7c3aed", marginRight: 6 }} title="来自重复计划（每天自动排）">
              循环
            </span>
          )}
          <span
            style={{
              fontSize: 13.5,
              lineHeight: 1.5,
              color: done ? "#aaa" : missed ? "#a32d2d" : "#333",
              textDecoration: done ? "line-through" : "none",
              wordBreak: "break-word",
            }}
          >
            {it.title}
          </span>
          {modeTag && <span style={{ fontSize: 11, color: "#999", marginLeft: 4 }}>（{modeTag}）</span>}
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>
            {fmtDue(it.dueAt)}
            {missed ? " · 未完成" : ""}
            {done && it.doneAt ? ` · 完成于 ${it.doneAt.slice(5, 16).replace("T", " ")}` : ""}
          </div>
        </div>
      </div>
    );
  };

  const renderGroup = (title: string, list: PlanItem[], accent: string, bg: string, border: string, keyPrefix: string) => {
    if (!list.length) return null;
    const doneCount = list.filter((i) => i.status === "done").length;
    return (
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: accent, marginBottom: 5 }}>
          {title}（{doneCount}/{list.length}）
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {list.map((it, i) => renderItem(it, `${keyPrefix}-${it.planId}-${i}`))}
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>🗓 计划 — 每天要完成的事</div>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888", lineHeight: 1.7 }}>
        与孩子端一致：三张计划表（学习/生活/考核）逐日汇总，分「家长制定（必须完成项）」与「孩子自己制定（加分项）」。
        完成情况由系统自动核对；要改安排或纠错，对右侧家长 AI 说，或在「积分」页审计修正。
        <button
          onClick={load}
          disabled={loading}
          style={{
            marginLeft: 8,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 10px",
            fontSize: 12,
            borderRadius: 6,
            border: "1px solid #cbd5e1",
            background: "#fff",
            color: "#475569",
            cursor: loading ? "default" : "pointer",
          }}
          title="刷新"
        >
          <RefreshCw size={12} /> 刷新
        </button>
      </p>

      {loading && <p style={{ color: "#888", fontSize: 13 }}>加载中…</p>}
      {error && <p style={{ color: "#b33", fontSize: 12 }}>{error}</p>}

      {!loading && !error && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {(() => {
            const today = localToday();
            const withItems = days.filter((d) => d.items.some((i) => i.status !== "cancelled"));
            if (!withItems.length) {
              return (
                <p style={{ color: "#999", fontSize: 13, border: "1px dashed #ddd", borderRadius: 10, padding: 16 }}>
                  未来 {RANGE_DAYS} 天没有安排。要对家长 AI 说「帮孩子排一下下周的学习计划」。
                </p>
              );
            }
            return withItems.map((d) => {
              const head = dayHeader(d.date);
              const active = d.items.filter((i) => i.status !== "cancelled");
              const parentItems = active.filter((i) => i.owner === "parent");
              const childItems = active.filter((i) => i.owner !== "parent");
              const doneCount = active.filter((i) => i.status === "done").length;
              return (
                <div
                  key={d.date}
                  style={{
                    border: head.today ? "2px solid #f2994a" : "1px solid #eef0f4",
                    borderRadius: 12,
                    padding: "10px 14px",
                    background: head.today ? "#fffdf7" : "#fff",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: head.today ? "#b45309" : "#475569" }}>
                    {head.today ? "今天" : head.tomorrow ? "明天" : ""}
                    {head.today || head.tomorrow ? `（${head.label}）` : head.label}
                    <span style={{ fontWeight: 400, color: "#94a3b8", marginLeft: 8, fontSize: 12 }}>
                      {doneCount}/{active.length} 已完成
                    </span>
                    {d.date < today && <span style={{ fontSize: 11, color: "#cbd5e1", marginLeft: 8 }}>（已过去）</span>}
                  </div>
                  {renderGroup("👨‍👩‍👧 家长制定（必须完成项）", parentItems, "#b45309", "#fff7ed", "#fed7aa", `p-${d.date}`)}
                  {renderGroup("🧒 孩子自己制定（加分项）", childItems, "#4f46e5", "#f5f7ff", "#e2e8ff", `c-${d.date}`)}
                </div>
              );
            });
          })()}
        </div>
      )}
    </div>
  );
}
