import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, MessageSquare } from "lucide-react";
import IconButton from "./IconButton";

/**
 * 学习计划只读面板（ISSUE-033 P4 重构 2026-09-04）：家长查看孩子的「每天学什么」排期表。
 * - 数据真源=服务端 study_plans（一课一行；studyPlan:list / studyPlan:today IPC 透传，done 由服务端按课程当天活动下发）；
 * - 本面板**只读**：编辑一律走右侧「家长 AI」对话（study_plan_* 工具），带「在对话里修改」引导按钮；
 * - 今天卡片单独展示（含 📌 昨天没学完顺延来的 carry 项），其后为未来 N 天排期表（空天=不要求学，不列出）。
 */
interface PlanRow {
  id: string;
  childId: string;
  date: string;
  courseName: string;
  mode: string;
  origin: string;
  status: string;
  done: boolean;
  updatedAt: string;
}

interface TodayItem {
  planId: string;
  courseName: string;
  text: string;
  mode: string;
  carry: boolean;
  status: string;
  done: boolean;
}

interface Props {
  /** 孩子列表（面板内做孩子切换）；空数组显示引导 */
  children: any[];
  /** 「在对话里修改」回调（家长中心场景=展开右侧聊天；缺省隐藏按钮外的提示） */
  onAskInChat?: () => void;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 本地时区 YYYY-MM-DD。 */
function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** '2026-09-02' → '9月2日 周三'。 */
function fmtDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}月${d}日 ${WEEKDAYS[dt.getDay()]}`;
}

/** 日期 +n 天 → YYYY-MM-DD（本地）。 */
function shiftDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

export default function StudyPlanPanel({ children, onAskInChat }: Props) {
  const [activeChildId, setActiveChildId] = useState<string>("");
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [todayItems, setTodayItems] = useState<TodayItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 孩子列表就绪/变化时默认选第一个
  useEffect(() => {
    if (children.length > 0 && !children.some((c) => c.childId === activeChildId)) {
      setActiveChildId(children[0].childId);
    }
    if (children.length === 0) {
      setActiveChildId("");
      setRows([]);
      setTodayItems([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  const load = useCallback(async () => {
    if (!activeChildId) return;
    setLoading(true);
    setError("");
    try {
      const today = localToday();
      const from = shiftDate(today, 1); // 今天单独卡片展示，表从明天起
      const [listR, todayR] = await Promise.all([
        window.api.studyPlanList(activeChildId, { from }),
        window.api.studyPlanToday(activeChildId, today),
      ]);
      if (listR?.success) setRows(listR.rows || []);
      else setError(listR?.error || "加载排期失败");
      if (todayR?.success) setTodayItems(todayR.items || []);
      else setError((e) => e || todayR?.error || "加载今天安排失败");
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [activeChildId]);

  useEffect(() => {
    load();
  }, [load]);

  const activeChild = useMemo(
    () => children.find((c) => c.childId === activeChildId) || null,
    [children, activeChildId]
  );

  // 按日期分组（升序）
  const byDate = useMemo(() => {
    const map = new Map<string, PlanRow[]>();
    for (const r of rows) {
      const arr = map.get(r.date) || [];
      arr.push(r);
      map.set(r.date, arr);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [rows]);

  if (children.length === 0) {
    return <p style={{ color: "#888", fontSize: 13 }}>还没有孩子。先在「孩子管理」添加孩子，再在家长 AI 对话里制定学习计划。</p>;
  }

  const carryCount = todayItems.filter((it) => it.carry).length;
  const doneTrue = todayItems.filter((it) => it.done === true).length;
  const doneDetermined = todayItems.filter((it) => it.done !== undefined).length;
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
        📋 学习计划 — {activeChild?.name || ""}
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888" }}>
        只读查看「每天学什么」。想改某天的安排，在右侧家长 AI 对话里说即可（如「9 月 5 号只学数学」）；没排课的天 = 不要求学。
        {onAskInChat && (
          <button
            onClick={onAskInChat}
            style={{
              marginLeft: 8,
              padding: "3px 10px",
              fontSize: 12,
              borderRadius: 6,
              border: "1px solid #667eea",
              background: "#eef0ff",
              color: "#5a67d8",
              cursor: "pointer",
            }}
          >
            <MessageSquare size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
            在对话里修改
          </button>
        )}
      </p>

      {/* 孩子切换 */}
      {children.length > 1 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {children.map((c) => (
            <button
              key={c.childId}
              onClick={() => setActiveChildId(c.childId)}
              style={{
                padding: "6px 14px",
                borderRadius: 8,
                border: activeChildId === c.childId ? "2px solid #667eea" : "1px solid #ddd",
                background: activeChildId === c.childId ? "#f0f4ff" : "#fff",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {c.avatar} {c.name}
            </button>
          ))}
          <IconButton icon={RefreshCw} title="刷新" onClick={load} disabled={loading} style={{ marginLeft: "auto" }} />
        </div>
      )}
      {children.length === 1 && (
        <div style={{ marginBottom: 14, display: "flex", justifyContent: "flex-end" }}>
          <IconButton icon={RefreshCw} title="刷新" onClick={load} disabled={loading} />
        </div>
      )}

      {loading && <p style={{ color: "#888" }}>加载中…</p>}
      {error && <p style={{ color: "#b33", fontSize: 12 }}>{error}</p>}

      {/* 今天卡片 */}
      <div
        style={{
          background: "#fdf6ec",
          border: "1px solid #f0dfc0",
          borderRadius: 10,
          padding: "10px 14px",
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          今天（{fmtDay(localToday())}）
          {todayItems.length > 0 && (
            <span style={{ fontWeight: 400, color: "#888", marginLeft: 6 }}>
              {todayItems.length} 项{carryCount > 0 ? ` · ${carryCount} 项是补昨天的 📌` : ""}
              {doneDetermined > 0 ? ` · 今天已学 ${doneTrue} 项` : ""}
            </span>
          )}
        </div>
        {todayItems.length === 0 ? (
          <div style={{ fontSize: 12, color: "#999" }}>今天没有安排内容（空天 = 不要求学）。</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
            {(() => {
              const seen = new Set<string>();
              return todayItems
                .filter((it) => {
                  const t = (it.courseName || it.text || "").trim();
                  if (!t || seen.has(t)) return false;
                  seen.add(t);
                  return true;
                })
                .map((it, i) => {
                  const done = it.done === true;
                  const label = it.courseName || it.text || "";
                  const modeTag = it.mode === "review" ? "复习" : it.mode === "new" ? "新学" : "";
                  const prefix = done ? "✅ " : it.carry ? "📌 " : "⬜ ";
                  const color = done ? "#2f9e44" : it.carry ? "#b7791f" : "#888";
                  const note =
                    done
                      ? it.carry
                        ? "（补昨天的，今天已学）"
                        : "（今天已学）"
                      : it.carry
                        ? "（昨天没学完，今天补上）"
                        : "";
                  return (
                    <li key={`${it.planId}-${i}`} style={{ color }}>
                      {prefix}
                      {label}
                      {modeTag ? <span style={{ color: "#999", fontSize: 11, marginLeft: 4 }}>（{modeTag}）</span> : null}
                      {note && <span style={{ color: "#999", fontSize: 11, marginLeft: 4 }}>{note}</span>}
                    </li>
                  );
                });
            })()}
          </ul>
        )}
      </div>

      {/* 未来排期表 */}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>接下来的安排</div>
      {!loading && !error && byDate.length === 0 && (
        <p style={{ color: "#999", fontSize: 12 }}>未来没有排课。需要安排吗？在右侧家长 AI 对话里说「帮孩子做学习计划」。</p>
      )}
      {byDate.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {byDate.map(([date, dayRows]) => {
            const items = dayRows.filter(
              (r, idx, self) => self.findIndex((x) => x.courseName === r.courseName) === idx
            );
            return (
              <div key={date} style={{ border: "1px solid #f0f0f0", borderRadius: 10, padding: "8px 12px", background: "#fff" }}>
                <div style={{ fontSize: 12, color: "#667eea", fontWeight: 600, marginBottom: 4 }}>{fmtDay(date)}</div>
                {items.map((r, i) => {
                  const modeTag = r.mode === "review" ? "复习" : "新学";
                  const prefix = r.origin === "carry" ? "📌 " : "• ";
                  const color = r.origin === "carry" ? "#b7791f" : "#333";
                  const note = r.origin === "carry" ? "（顺延来的补学）" : "";
                  return (
                    <div key={`${date}-${i}`} style={{ fontSize: 13, color, padding: "1px 0" }}>
                      {prefix}
                      {r.courseName}
                      <span style={{ color: "#999", fontSize: 11, marginLeft: 4 }}>（{modeTag}）</span>
                      {note && <span style={{ color: "#999", fontSize: 11, marginLeft: 4 }}>{note}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
