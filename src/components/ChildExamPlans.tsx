/**
 * 家长端 · 孩子详情「考核计划」tab（ISSUE-130）。
 *
 * **按孩子端考核页（ExamView pick 阶段）的布局展示**，家长只读、不发起考核：
 *  - 顶部「今天要做的考核」卡（待考核/没考完的状态徽标，无开始按钮——考核由孩子在孩子端参加）；
 *  - 下方左「全部考核计划」列表：时间（全部/今天/近7天/近30天/更早）× 状态（全部/未完成/已完成）筛选，
 *    按与今天的距离排序——**历史与未来都有**；
 *  - 右侧详情：状态徽标 / 考核时间与频率 / 内容备注 / 考核课程+要点
 *    （normalizePlanCourses 双格式兼容，防 2026-09-15 白屏前科）；
 *    已完成 → 该次成绩逐题（得分/对错/评语/听原音）；未来 → 「未到考核时间」提示。
 *
 * 数据：examSchedules（考核计划，含未来）+ examAttempts（历史成绩），IPC 均为现有通道
 * （examAttempts 的服务端数据源自 ISSUE-135 P0-a 起改为孩子库结果三表，响应形状未变）。
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { formatCourseSpec, normalizePlanCourses } from "../lib/plan-scope";

interface ScheduleItem {
  id: string;
  kind: "fixed" | "custom";
  freq: string;
  scheduledAt: string;
  status: "pending" | "started" | "done" | "expired";
  attemptId: string;
  title: string;
  scope: Record<string, unknown>;
}

interface Props {
  childId: string;
}

const FREQ_LABEL: Record<string, string> = { daily: "每天", weekly: "每周", monthly: "每月", halfyear: "每半年", yearly: "每年" };
const STATUS_BADGE: Record<string, { text: string; color: string; bg: string }> = {
  pending: { text: "待考核", color: "#b9770a", bg: "#fdf3e3" },
  started: { text: "没考完", color: "#c0392b", bg: "#fdecea" },
  done: { text: "已完成", color: "#27ae60", bg: "#e8f7ee" },
  expired: { text: "已过期", color: "#888", bg: "#f0f2f5" },
};

function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function fmtDateTime(iso: string): string {
  return iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }).slice(0, 16) : "—";
}
const canStart = (s: ScheduleItem) => s.status === "pending" || s.status === "started";

export default function ChildExamPlans({ childId }: Props) {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [attempts, setAttempts] = useState<any[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [timeFilter, setTimeFilter] = useState<"all" | "today" | "week" | "month" | "earlier">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "done">("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // 成绩原音回放：qid → data URL（听原音按钮按需拉取）
  const [audioSrc, setAudioSrc] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [rS, rA] = await Promise.all([
        window.api.examSchedules(childId) as Promise<any>,
        (window.api.examAttempts(childId) as Promise<any>).catch(() => ({ success: false })),
      ]);
      if (!rS?.success) throw new Error(rS?.error || "获取考核排期失败");
      const list: ScheduleItem[] = rS.data?.schedules || [];
      setSchedules(list);
      if (rA?.success && Array.isArray(rA.data)) setAttempts(rA.data);
      // 默认选中「距今天最近」的一条（列表同排序）
      if (list.length) {
        setSelectedPlanId((prev) => {
          if (prev && list.some((s) => s.id === prev)) return prev;
          const sorted = [...list].sort(
            (a, b) =>
              Math.abs(new Date(a.scheduledAt).getTime() - Date.now()) -
              Math.abs(new Date(b.scheduledAt).getTime() - Date.now())
          );
          return sorted[0]!.id;
        });
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [childId]);

  useEffect(() => {
    load();
  }, [load]);

  async function playAudio(fileId: string, qid: string) {
    if (playing === qid) {
      setPlaying(null);
      return;
    }
    try {
      const r: any = await window.api.examAudio(fileId);
      if (r?.success && r.data) {
        setAudioSrc((prev) => ({ ...prev, [qid]: r.data }));
        setPlaying(qid);
      }
    } catch {
      /* 静默 */
    }
  }

  const todayKey = dayKeyOf(new Date().toISOString());
  const todayOpen = schedules.filter((s) => dayKeyOf(s.scheduledAt) === todayKey && canStart(s));
  const attemptOfSchedule = (sch: ScheduleItem) =>
    attempts.find((a) => a.id === sch.attemptId) ||
    attempts.find((a) => String(a.title || "") === String(sch.title || ""));

  const planList = schedules
    .filter((s) => {
      if (statusFilter === "open" && !canStart(s)) return false;
      if (statusFilter === "done" && s.status !== "done") return false;
      if (timeFilter === "today") return dayKeyOf(s.scheduledAt) === todayKey;
      const diff = (Date.now() - new Date(s.scheduledAt).getTime()) / 86400000;
      if (timeFilter === "week") return diff < 7;
      if (timeFilter === "month") return diff < 30;
      if (timeFilter === "earlier") return diff >= 30;
      return true;
    })
    .slice()
    .sort((a, b) => {
      const da = Math.abs(new Date(a.scheduledAt).getTime() - Date.now());
      const db = Math.abs(new Date(b.scheduledAt).getTime() - Date.now());
      return da - db;
    });
  const selectedPlan = schedules.find((s) => s.id === selectedPlanId) || null;

  // 已完成考核的成绩详情（家长视角：逐题得分/评语/听原音；发音维度明细见错题闭环二期，这里保持紧凑）
  const renderAttempt = (at: any) => {
    const qs: Array<any> = at?.perQuestion || [];
    const maxP = qs.reduce((s: number, q) => s + (Number(q?.pointMax) || 0), 0);
    return (
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
          <span style={{ fontSize: 26, fontWeight: 800, color: (at?.score ?? 0) >= 60 ? "#27ae60" : "#e74c3c" }}>
            {at?.score ?? 0} 分
          </span>
          {maxP ? <span style={{ color: "#888", fontSize: 12 }}>满分 {maxP} 分</span> : null}
          <span style={{ color: "#999", fontSize: 12 }}>
            {at?.submittedAt ? `交卷：${fmtDateTime(at.submittedAt)}` : ""}
          </span>
        </div>
        {qs.length === 0 && <div style={{ color: "#aaa", fontSize: 13 }}>这次考核没有逐题记录。</div>}
        {qs.map((q: any, i: number) => (
          <div key={String(q?.qid || i)} style={{ borderTop: "1px solid #f0f0f0", padding: "9px 0", fontSize: 13 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700 }}>
                第 {i + 1} 题{q?.course ? ` · ${q.course}` : ""}
              </span>
              <span style={{ color: q?.correct ? "#2f8a52" : "#c0392b", fontWeight: 700 }}>
                {q?.correct ? "✓" : "✗"} {q?.pointGot ?? 0}/{q?.pointMax ?? "—"}
              </span>
              {q?.questionType && (
                <span style={{ fontSize: 11, background: "#eef2ff", color: "#3b4cca", borderRadius: 999, padding: "1px 8px" }}>
                  背诵/口语
                </span>
              )}
              {q?.audioFileId && (
                <button
                  onClick={() => playAudio(q.audioFileId, q.qid)}
                  style={{ border: "1px solid #ddd", background: playing === q.qid ? "#eef0ff" : "#fff", borderRadius: 6, padding: "2px 10px", fontSize: 12, cursor: "pointer", color: "#5a67d8" }}
                >
                  {playing === q.qid ? "⏹ 停止" : "▶ 听原音"}
                </button>
              )}
            </div>
            {q?.question ? <div style={{ color: "#555", marginTop: 3 }}>题目：{q.question}</div> : null}
            {q?.refText ? <div style={{ color: "#7b5b1a", marginTop: 3 }}>原文：{q.refText}</div> : null}
            {q?.asrText ? <div style={{ color: "#444", marginTop: 3 }}>回答：{q.asrText}</div> : null}
            {q?.aiComment ? <div style={{ color: "#888", marginTop: 3 }}>评语：{q.aiComment}</div> : null}
            {audioSrc[q?.qid] && playing === q.qid && (
              <audio controls autoPlay src={audioSrc[q.qid]} style={{ width: "100%", maxWidth: 340, marginTop: 6, height: 32 }} />
            )}
          </div>
        ))}
      </div>
    );
  };

  const filterChip = (active: boolean, color: string, label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        border: "none",
        borderRadius: 999,
        padding: "3px 12px",
        fontSize: 12,
        cursor: "pointer",
        background: active ? color : "#eef1f6",
        color: active ? "#fff" : "#556",
        fontWeight: 600,
      }}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>🎯 考核计划</div>
        <button
          onClick={load}
          disabled={loading}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 12px",
            fontSize: 12,
            borderRadius: 6,
            border: "1px solid #cbd5e1",
            background: "#fff",
            color: "#475569",
            cursor: loading ? "default" : "pointer",
          }}
        >
          <RefreshCw size={12} /> 刷新
        </button>
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888", lineHeight: 1.7 }}>
        与孩子端考核页同布局：未来的排期与历史成绩都在这里。考核由孩子在孩子端参加；要新增/调整考核，对右侧家长 AI 说（如「周五考论语的乡党篇」）。
      </p>
      {loading && <p style={{ color: "#888", fontSize: 13 }}>加载中…</p>}
      {error && <p style={{ color: "#b33", fontSize: 12 }}>{error}</p>}

      {!loading && !error && (
        <>
          {/* —— 顶部：今天要做的考核（家长只读） —— */}
          <div style={{ background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "13px 16px", marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>📅 今天要做的考核</div>
            {todayOpen.length === 0 ? (
              <p style={{ color: "#888", fontSize: 13, margin: 0 }}>今天没有待考核的安排。</p>
            ) : (
              todayOpen.map((sch) => {
                const badge = STATUS_BADGE[sch.status] || STATUS_BADGE.pending!;
                return (
                  <div key={sch.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>
                        {sch.title}
                        {sch.kind === "custom" && (
                          <span style={{ marginLeft: 8, fontSize: 11, background: "#eef2ff", color: "#3b4cca", borderRadius: 999, padding: "1px 8px" }}>自定义</span>
                        )}
                      </div>
                      <div style={{ color: "#6b7686", fontSize: 12, marginTop: 2 }}>
                        {sch.freq ? `${FREQ_LABEL[sch.freq] || sch.freq}考核` : ""}
                        {sch.status === "started" ? " · 上次没考完，孩子可重新作答" : " · 孩子端今天可参加"}
                      </div>
                    </div>
                    <span style={{ fontSize: 11, color: badge.color, background: badge.bg, borderRadius: 999, padding: "2px 10px", whiteSpace: "nowrap" }}>
                      {badge.text}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          {/* —— 下部：左 = 全部考核计划列表 / 右 = 详情或成绩 —— */}
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start", minHeight: 320 }}>
            <div style={{ width: 300, flexShrink: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>🗂 全部考核计划</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                {([
                  ["all", "全部时间"],
                  ["today", "今天"],
                  ["week", "最近7天"],
                  ["month", "最近30天"],
                  ["earlier", "更早"],
                ] as const).map(([v, label]) => filterChip(timeFilter === v, "#3b6ef5", label, () => setTimeFilter(v)))}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                {([
                  ["all", "全部状态"],
                  ["open", "未完成"],
                  ["done", "已完成"],
                ] as const).map(([v, label]) => filterChip(statusFilter === v, "#f2994a", label, () => setStatusFilter(v)))}
              </div>
              <div style={{ maxHeight: 420, overflowY: "auto", paddingRight: 2 }}>
                {planList.length === 0 ? (
                  <p style={{ color: "#888", fontSize: 13, margin: 0 }}>没有符合条件的考核计划。</p>
                ) : (
                  planList.map((sch) => {
                    const badge = STATUS_BADGE[sch.status] || STATUS_BADGE.pending!;
                    const active = sch.id === selectedPlanId;
                    const isToday = dayKeyOf(sch.scheduledAt) === todayKey;
                    return (
                      <div
                        key={sch.id}
                        onClick={() => setSelectedPlanId(sch.id)}
                        style={{
                          background: "#fff",
                          border: active ? "2px solid #3b6ef5" : "1px solid #e6eaf0",
                          borderRadius: 10,
                          padding: "10px 12px",
                          marginBottom: 8,
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span
                            style={{
                              fontWeight: 700,
                              fontSize: 13,
                              flex: 1,
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {sch.title}
                          </span>
                          <span style={{ fontSize: 11, color: badge.color, background: badge.bg, borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap" }}>
                            {badge.text}
                          </span>
                        </div>
                        <div style={{ color: "#6b7686", fontSize: 12, marginTop: 2 }}>
                          {isToday ? "今天" : fmtDate(sch.scheduledAt)}
                          {sch.freq ? ` · ${FREQ_LABEL[sch.freq] || sch.freq}` : ""}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* 右：详情 */}
            <div style={{ flex: 1, minWidth: 0, background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: 18 }}>
              {!selectedPlan ? (
                <div style={{ height: "100%", minHeight: 200, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, color: "#98a2b0", fontSize: 13 }}>
                  <div style={{ fontSize: 34 }}>👆</div>
                  <div>点击左侧考核计划查看详情；已完成的可查看考核成绩</div>
                </div>
              ) : (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                    <span style={{ fontWeight: 800, fontSize: 16 }}>{selectedPlan.title}</span>
                    {selectedPlan.kind === "custom" && (
                      <span style={{ fontSize: 11, background: "#eef2ff", color: "#3b4cca", borderRadius: 999, padding: "1px 8px" }}>自定义</span>
                    )}
                    {(() => {
                      const badge = STATUS_BADGE[selectedPlan.status] || STATUS_BADGE.pending!;
                      return (
                        <span style={{ fontSize: 11, color: badge.color, background: badge.bg, borderRadius: 999, padding: "1px 8px" }}>
                          {badge.text}
                        </span>
                      );
                    })()}
                  </div>
                  <div style={{ color: "#6b7686", fontSize: 13, marginBottom: 2 }}>
                    考核时间：{fmtDate(selectedPlan.scheduledAt)}
                    {dayKeyOf(selectedPlan.scheduledAt) === todayKey ? "（今天）" : ""}
                    {selectedPlan.freq ? ` · ${FREQ_LABEL[selectedPlan.freq] || selectedPlan.freq}考核` : ""}
                  </div>
                  {selectedPlan.scope?.note ? (
                    <div style={{ color: "#6b7686", fontSize: 13, marginBottom: 2 }}>考核内容：{String(selectedPlan.scope.note)}</div>
                  ) : null}

                  {/* 考核课程列表（normalizePlanCourses 双格式兼容，禁止直接渲染对象） */}
                  {(() => {
                    const cs = normalizePlanCourses(selectedPlan.scope?.courses);
                    if (!cs.length) {
                      return (
                        <div style={{ color: "#888", fontSize: 13, marginTop: 8 }}>
                          考核课程将在开始时按学习/复习内容挑选。
                        </div>
                      );
                    }
                    return (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>📚 考核课程（{cs.length} 门）</div>
                        {cs.map((c) => (
                          <div key={c.title} style={{ borderTop: "1px solid #f0f0f0", padding: "7px 0", fontSize: 13 }}>
                            <div style={{ fontWeight: 600 }}>· {formatCourseSpec(c)}</div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {selectedPlan.status === "done" ? (
                    (() => {
                      const at = attemptOfSchedule(selectedPlan);
                      return at ? (
                        <div style={{ marginTop: 12 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, margin: "10px 0 4px" }}>🏁 考核结果</div>
                          {renderAttempt(at)}
                        </div>
                      ) : (
                        <div style={{ color: "#888", fontSize: 13, marginTop: 12 }}>这次考核已完成，成绩记录暂时没有找到。</div>
                      );
                    })()
                  ) : canStart(selectedPlan) ? (
                    <div style={{ color: "#b9770a", fontSize: 13, marginTop: 12, background: "#fdf3e3", borderRadius: 8, padding: "8px 12px" }}>
                      {dayKeyOf(selectedPlan.scheduledAt) > todayKey
                        ? `还没到考核时间，${fmtDate(selectedPlan.scheduledAt)}当天孩子在孩子端参加。`
                        : "今天的考核，等孩子在孩子端进入「学习考核」参加。"}
                    </div>
                  ) : (
                    <div style={{ color: "#888", fontSize: 13, marginTop: 12 }}>这次考核已过期，孩子未参加。</div>
                  )}
                </div>
              )}
            </div>
          </div>

          {schedules.length === 0 && (
            <p style={{ color: "#888", fontSize: 13, margin: "10px 0 0" }}>
              还没有考核安排。固定考核会在设定日期自动出现；想临时安排可以对右侧家长 AI 说「周五考论语的乡党篇」。
            </p>
          )}
        </>
      )}
    </div>
  );
}
