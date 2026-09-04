import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import IconButton from "./IconButton";
import { ArrowLeft } from "lucide-react";

/** 课程进度字段（两端钻取共用，字段取自 SQLite courses 表）。 */
export interface CourseItemLite {
  title: string;
  status: string;
  mastery: string;
  firstLearned: string;
  lastReview: string;
  reviewCount: number;
  material: string;
  sendMaterial: string;
  tags: string;
}

/** 课程列表搜索：按课程名 / 标签匹配（不区分大小写）。两端共用。 */
export function matchesCourseSearch(c: { title: string; tags: string }, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return c.title.toLowerCase().includes(s) || (c.tags || "").toLowerCase().includes(s);
}

interface CourseDailySummary {
  date: string;
  title: string;
  raw: string;
  tags: string;
}

/** 考核逐题明细（exam_attempts.perQuestion，camelCase 与服务端 rowToAttempt 一致）。 */
interface ExamQuestion {
  qid: string;
  course?: string;
  question?: string;
  asrText?: string;
  pointGot?: number;
  pointMax?: number;
  correct?: boolean;
  aiComment?: string;
}

/** 一次考核（exam_attempts 行）。 */
interface ExamAttemptItem {
  id: string;
  title: string;
  submittedAt: string;
  score: number;
  perQuestion?: ExamQuestion[];
  courseMastery?: Record<string, { correct: number; total: number; rate: number }>;
  reinforcePlan?: Record<string, { planReviewAt?: string; focus?: string[]; aiSuggestion?: string }>;
}

/** 左栏「记录项」的统一定义：daily 学习/复习记录 或 一次考核场次。 */
interface RecordItem {
  key: string;
  kind: "learn" | "exam";
  date: string;
  label: string; // 主标签：如「📝 学习记录」/「🎯 考核」
  sub?: string; // 副文案：如「掌握度 熟练」
  summary?: CourseDailySummary;
  attempt?: ExamAttemptItem;
  myQuestions?: ExamQuestion[];
  cmText?: string; // 该场本课正确率文本
  aiSuggestion?: string;
  focus?: string[];
}

interface Props {
  childId: string;
  topicDir: string; // 主题目录名，如 "lunyu"
  topicName: string; // 主题显示名（中文，如 "论语"）
  course: CourseItemLite;
  onBack: () => void;
  /** 考核/复习全景（来自服务端 course_status；缺省不显示考核块） */
  courseStatus?: {
    status?: string;
    examMastery?: string;
    examCount?: number;
    lastExamAt?: string;
    examRate?: number;
    reviewCount?: number;
    lastReview?: string;
    planReviewAt?: string;
    focus?: string[];
  } | null;
}

/**
 * 单课详情：进度字段（courses 表）+ 该课「每一次学习/复习记录」的时间线（daily_entries，block='学习'）
 * + 「历次考核总结」（exam_attempts 中该课逐题评语）。
 * 数据均取自数据库唯一真源；不再从 materials 文件读取任何内容。
 * 两端（孩子/家长）共用。
 */
export default function CourseDetail({ childId, topicDir, topicName, course, onBack, courseStatus }: Props) {
  const [summaries, setSummaries] = useState<CourseDailySummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  // 该课历次考核（含逐题评语）
  const [examAttempts, setExamAttempts] = useState<ExamAttemptItem[] | null>(null);
  const [loadingExam, setLoadingExam] = useState(false);
  // 两栏视图：当前选中哪条记录
  const [activeKey, setActiveKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSummaries(null);
    window.api
      .learningCourseSummary(childId, topicName, course.title)
      .then((r: any) => {
        if (cancelled) return;
        setSummaries(r?.success ? r.data || [] : []);
      })
      .catch(() => {
        if (!cancelled) setSummaries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [childId, topicName, course.title]);

  // 拉取该课历次考核：全量 attempts 中筛出含本课的，按提交时间倒序（考核次数通常少，量可接受）
  useEffect(() => {
    let cancelled = false;
    setLoadingExam(true);
    setExamAttempts(null);
    window.api
      .examAttempts(childId)
      .then((r: any) => {
        if (cancelled) return;
        const ok = !!r?.success;
        const attempts: ExamAttemptItem[] = ok && r.data ? r.data : [];
        const mine = attempts
          .filter((a) => (a.perQuestion ?? []).some((q) => q.course === course.title))
          .sort((a, b) => (a.submittedAt > b.submittedAt ? -1 : a.submittedAt < b.submittedAt ? 1 : 0));
        setExamAttempts(mine);
      })
      .catch(() => {
        if (!cancelled) {
          setExamAttempts([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingExam(false);
      });
    return () => {
      cancelled = true;
    };
  }, [childId, course.title]);

  // 两栏记录列表：合并 daily 学习/复习记录（block='学习' 不分）与历次考核场次，按日期倒序（新在前）
  const recordList: RecordItem[] = useMemo(() => {
    const list: RecordItem[] = [];
    for (const s of summaries ?? []) {
      list.push({ key: `learn:${s.date}:${s.title}`, kind: "learn", date: s.date, label: "📝 学习记录", summary: s });
    }
    for (const at of examAttempts ?? []) {
      const myQs = (at.perQuestion ?? []).filter((q) => q.course === course.title);
      const cm = at.courseMastery?.[course.title];
      const rp = at.reinforcePlan?.[course.title];
      const cmText = cm?.total
        ? `本课正确率 ${Math.round((cm.correct / cm.total) * 100)}%（${cm.correct}/${cm.total}）`
        : cm
          ? "本课正确率 —"
          : undefined;
      list.push({
        key: `exam:${at.id}`,
        kind: "exam",
        date: at.submittedAt?.slice(0, 10) || "",
        label: `🎯 考核 · ${at.title || "考核"}`,
        sub: `总分 ${at.score}`,
        attempt: at,
        myQuestions: myQs,
        cmText,
        aiSuggestion: rp?.aiSuggestion,
        focus: rp?.focus,
      });
    }
    // 按日期倒序稳定排序（同日 learn/exam 保持各自加载顺序）
    list.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
    return list;
  }, [summaries, examAttempts, course.title]);

  // 数据就绪后默认选中最近一条（recordList 重算时若选中项仍存在则保留）
  useEffect(() => {
    if (recordList.length === 0) {
      setActiveKey(null);
      return;
    }
    setActiveKey((prev) => (prev && recordList.some((r) => r.key === prev) ? prev : recordList[0].key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordList.map((r) => r.key).join("|")]);

  const activeRecord = recordList.find((r) => r.key === activeKey) || null;

  const rows: Array<[string, string]> = [["状态", course.status]];
  if (course.mastery) rows.push(["掌握度", course.mastery]);
  if (course.firstLearned) rows.push(["首次学习", course.firstLearned]);
  if (course.lastReview) rows.push(["最近复习", course.lastReview]);
  if (course.reviewCount > 0) rows.push(["复习次数", String(course.reviewCount)]);
  if (course.tags) rows.push(["标签", course.tags]);
  // 考核/复习全景（来自服务端 course_status）
  if (courseStatus) {
    const cs = courseStatus;
    if (cs.examRate != null && (cs.examCount ?? 0) > 0) {
      rows.push(["考核正确率", `${Math.round((cs.examRate ?? 0) * 100)}%`]);
    }
    if ((cs.examCount ?? 0) > 0) rows.push(["考核次数", String(cs.examCount)]);
    if (cs.lastExamAt) rows.push(["最近考核", cs.lastExamAt]);
    if (cs.examMastery) rows.push(["考核掌握度", cs.examMastery]);
    if (cs.reviewCount != null && cs.reviewCount !== course.reviewCount) rows.push(["复习次数", String(cs.reviewCount)]);
    if (cs.planReviewAt) rows.push(["计划复习", cs.planReviewAt]);
    if (cs.focus && cs.focus.length > 0) rows.push(["复习重点", cs.focus.join("；")]);
  }

  return (
    <div className="dashboard-panel">
      <div className="dash-breadcrumb">
        <IconButton icon={ArrowLeft} title="返回" onClick={onBack} className="dash-back" />
        <span className="dash-crumb">{topicName}</span>
        <span className="dash-crumb-sep">›</span>
        <span className="dash-crumb-current">{course.title}</span>
      </div>

      {/* 学习情况（courses 表进度字段） */}
      <div className="lesson-detail-card">
        <div className="lesson-detail-title">
          <span className="lesson-status">{course.status}</span>
          {course.title}
        </div>
        {rows.length > 0 && (
          <div className="lesson-detail-rows">
            {rows.map(([k, v]) => (
              <div className="lesson-detail-row" key={k}>
                <span className="lesson-detail-key">{k}</span>
                <span className="lesson-detail-val">{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 两栏：左=记录列表（学习/复习+考核）｜右=选中记录的详情 */}
      <div style={{ display: "flex", gap: 16, marginTop: 12, alignItems: "flex-start", minWidth: 0 }}>
        {/* 左：记录列表 */}
        <div style={{ width: 280, minWidth: 0, flexShrink: 0, borderRight: "1px solid #eee", paddingRight: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>每次记录（{recordList.length}）</div>
          {loading || loadingExam ? (
            <div className="placeholder" style={{ fontSize: 12, padding: "8px 0" }}>⏳ 加载中…</div>
          ) : (
            <div style={{ overflowY: "auto", maxHeight: "70vh", paddingRight: 2 }}>
              {recordList.length === 0 && (
                <p style={{ color: "#888", fontSize: 12, padding: "8px 0" }}>
                  {summaries?.length === 0 && examAttempts?.length === 0
                    ? "（该课暂无学习记录，也暂未参加过考核）"
                    : "（暂无记录）"}
                </p>
              )}
              {recordList.map((r) => {
                const act = r.key === activeKey;
                return (
                  <div
                    key={r.key}
                    onClick={() => setActiveKey(r.key)}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 8,
                      marginBottom: 4,
                      cursor: "pointer",
                      background: act ? "#f0f4ff" : "#fff",
                      border: `1px solid ${act ? "#c3d2f5" : "#f0f0f0"}`,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 10,
                          borderRadius: 4,
                          padding: "0 5px",
                          flexShrink: 0,
                          color: r.kind === "exam" ? "#fff" : "#3b4cca",
                          background: r.kind === "exam" ? "#7b5b1a" : "#eef2ff",
                        }}
                      >
                        {r.kind === "exam" ? "考核" : "学习"}
                      </span>
                      <span style={{ fontSize: 12, color: "#bbb", flexShrink: 0 }}>{r.date}</span>
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 600, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.sub ? `${r.label} · ${r.sub}` : r.label}
                    </div>
                    {r.kind === "learn" && r.summary && (
                      <div style={{ fontSize: 11, color: "#999", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.summary.title}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 右：选中记录详情 */}
        <div style={{ flex: 1, minWidth: 0, borderLeft: "1px solid #eee", paddingLeft: 12 }}>
          {loading || loadingExam ? (
            <div className="placeholder">⏳ 正在加载…</div>
          ) : !activeRecord ? (
            <div className="lesson-summary-empty" style={{ padding: "12px 0" }}>（请选择左侧一条记录查看总结）</div>
          ) : activeRecord.kind === "learn" && activeRecord.summary ? (
            <div>
              <div className="lesson-summary-meta" style={{ marginBottom: 8 }}>
                <span className="lesson-summary-date">{activeRecord.summary.date}</span>
                <span className="lesson-summary-title">{activeRecord.summary.title}</span>
              </div>
              <div className="markdown-body lesson-summary-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{activeRecord.summary.raw || ""}</ReactMarkdown>
              </div>
            </div>
          ) : activeRecord.kind === "exam" && activeRecord.attempt ? (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{activeRecord.attempt.title || "考核"}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: (activeRecord.attempt.score ?? 0) >= 60 ? "#2f8a52" : "#c0392b" }}>
                  总分 {activeRecord.attempt.score}
                </span>
                {activeRecord.cmText && <span style={{ fontSize: 12, color: "#667eea" }}>{activeRecord.cmText}</span>}
                <span style={{ fontSize: 11, color: "#999" }}>{activeRecord.date}</span>
              </div>
              {!activeRecord.myQuestions || activeRecord.myQuestions.length === 0 ? (
                <div className="lesson-summary-empty">（该场没有本课的题目记录）</div>
              ) : (
                activeRecord.myQuestions.map((q, i) => {
                  const ok = !!q.correct;
                  return (
                    <div key={q.qid} style={{ padding: "8px 0", borderTop: "1px solid #f0f0f0", fontSize: 12.5 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600 }}>第 {i + 1} 题</span>
                        <span style={{ color: ok ? "#2f8a52" : "#c0392b", fontWeight: 700 }}>
                          {ok ? "✓" : "✗"} {q.pointGot ?? 0}/{q.pointMax ?? 0}
                        </span>
                      </div>
                      {q.question && <div style={{ color: "#666", marginTop: 2 }}>问：{q.question}</div>}
                      {q.asrText && (
                        <div style={{ color: "#555", marginTop: 2 }}>
                          答：<span style={{ background: "#f4f7ff", padding: "1px 6px", borderRadius: 4 }}>{q.asrText}</span>
                        </div>
                      )}
                      {q.aiComment && <div style={{ color: "#888", marginTop: 2 }}>评语：{q.aiComment}</div>}
                    </div>
                  );
                })
              )}
              {activeRecord.aiSuggestion && (
                <div style={{ marginTop: 10, fontSize: 12.5, color: "#7b5b1a", background: "#fdf7e6", borderRadius: 6, padding: "8px 12px" }}>
                  💡 复习建议：{activeRecord.aiSuggestion}
                  {activeRecord.focus?.length ? `（重点：${activeRecord.focus.join("、")}）` : ""}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
