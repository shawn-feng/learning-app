import { useEffect, useState } from "react";
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
 * 单课详情：进度字段（courses 表）+ 该课「学习情况的总结」（daily_entries，block='学习'）。
 * 两者均取自数据库唯一真源；不再从 materials 文件读取任何内容。
 * 两端（孩子/家长）共用。
 */
export default function CourseDetail({ childId, topicDir, topicName, course, onBack, courseStatus }: Props) {
  const [summaries, setSummaries] = useState<CourseDailySummary[] | null>(null);
  const [loading, setLoading] = useState(false);

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

      {/* 学习情况的总结（daily_entries，block='学习'，数据库唯一真源） */}
      <div className="lesson-summary">
        <div className="lesson-summary-head">📝 这一课的学习总结</div>
        {loading && <div className="placeholder">⏳ 正在加载学习总结…</div>}
        {!loading && summaries && summaries.length === 0 && (
          <div className="lesson-summary-empty">（暂未找到该课的学习总结记录）</div>
        )}
        {!loading &&
          summaries?.map((s, i) => (
            <div className="lesson-summary-card" key={`${s.date}-${i}`}>
              <div className="lesson-summary-meta">
                <span className="lesson-summary-date">{s.date}</span>
                <span className="lesson-summary-title">{s.title}</span>
              </div>
              <div className="markdown-body lesson-summary-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.raw || ""}</ReactMarkdown>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
