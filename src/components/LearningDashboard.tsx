import { useState, useEffect, useCallback, type CSSProperties } from "react";
import CourseDetail, { matchesCourseSearch } from "./CourseDetail";
import IconButton from "./IconButton";
import { ArrowLeft, RefreshCw } from "lucide-react";

/** 课程综合全景（服务端 course_status 返回的维度子集，列表行与单课详情展示用）。 */
interface CourseStatusLite {
  topic: string;
  title: string;
  status: string;
  examMastery: string;
  examCount: number;
  lastExamAt: string;
  examRate: number;
  planReviewAt: string;
  focus: string[];
}

/** 课程列表排序按钮样式。 */
function sortBtn(active: boolean): CSSProperties {
  return {
    padding: "3px 10px",
    borderRadius: 6,
    border: active ? "1.5px solid #667eea" : "1px solid #ddd",
    background: active ? "#f0f4ff" : "#fff",
    color: active ? "#3b4cca" : "#6b7686",
    fontSize: 12,
    cursor: "pointer",
  };
}

interface TopicSummary {
  name: string;
  topicKey: string;
  learned: number;
  total: number;
  percent: number;
  next: string;
  updated: string;
  type: string; // 必学 / 选学 / 复习（旧 daily 每日目标已停用，ISSUE-033）
}

interface LearningSummary {
  topics: TopicSummary[];
  totals: {
    learned: number;
    total: number;
    percent: number;
    topicCount: number;
    completedCount: number;
  };
}

/** 单主题进度明细（来自 learning:topic IPC，对应 kb-sqlite 的 TopicProgress）。 */
interface CourseItem {
  topic: string;
  title: string;
  sortOrder: number;
  status: string;
  mastery: string;
  firstLearned: string;
  lastReview: string;
  reviewCount: number;
  material: string;
  sendMaterial: string;
  tags: string;
}

interface TopicDetail {
  topic: string;
  learned: number;
  total: number;
  next: string;
  updated: string;
  items: CourseItem[];
}

interface Props {
  childId: string;
}

/** 学习进度看板：汇总各学习主题的进度，来源 learning/{topic}/{topic}.md 的 frontmatter */
export default function LearningDashboard({ childId }: Props) {
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 钻取状态：null = 总览；topic 级 = 选定主题、列出每课；course 级 = 选定单课、看当课汇总
  const [drill, setDrill] = useState<{ topic: TopicSummary; detail: TopicDetail | null; course: CourseItem | null } | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [search, setSearch] = useState("");
  // 课程综合全景：title -> 考核/复习情况（服务端 course_status，一次拉全量）
  const [courseStatusMap, setCourseStatusMap] = useState<Record<string, CourseStatusLite>>({});
  // 课程列表排序：null=默认原序 | 'rateAsc' | 'rateDesc'
  const [sortBy, setSortBy] = useState<null | "rateAsc" | "rateDesc">(null);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    window.api
      .learningSummary(childId)
      .then((r: any) => {
        if (r?.success) {
          setSummary(r.data);
        } else {
          setError(r?.error || "加载失败");
        }
      })
      .catch((e: any) => setError(e.message || "加载失败"))
      .finally(() => setLoading(false));
    // 拉取该孩子全部课程的考核/复习全景（失败静默，不影响列表）
    window.api
      .courseStatus(childId)
      .then((r: any) => {
        const arr: CourseStatusLite[] = r?.success ? r.data || [] : [];
        const map: Record<string, CourseStatusLite> = {};
        for (const c of arr) if (c?.title) map[c.title] = c;
        setCourseStatusMap(map);
      })
      .catch(() => setCourseStatusMap({}));
  }, [childId]);

  useEffect(() => {
    load();
  }, [load]);

  // 切走孩子时退出钻取
  useEffect(() => {
    setDrill(null);
  }, [childId]);

  function openTopic(t: TopicSummary) {
    const topicDir = t.topicKey;
    setSearch("");
    setDrill({ topic: t, detail: null, course: null });
    setLoadingDetail(true);
    window.api
      .learningTopic(childId, topicDir)
      .then((r: any) => {
        if (r?.success) {
          setDrill((d) => (d ? { ...d, detail: r.data } : d));
        } else {
          setError(r?.error || "加载课程失败");
        }
      })
      .catch((e: any) => setError(e.message || "加载课程失败"))
      .finally(() => setLoadingDetail(false));
  }

  function openCourse(c: CourseItem) {
    setDrill((d) => (d ? { ...d, course: c } : d));
  }

  function goBack() {
    setDrill((d) => {
      if (!d) return d;
      if (d.course) return { ...d, course: null }; // 从单课返回主题列表
      return null; // 从主题列表返回总览
    });
  }

  /** 课程考核正确率：优先用服务端 course_status 的 examRate；无则返回 null（未考核/无数据）。 */
  function examRateOf(title: string): number | null {
    const s = courseStatusMap[title];
    if (!s) return null;
    if (s.examRate != null && (s.examCount ?? 0) > 0) return s.examRate;
    return null;
  }

  /** 课程列表展示排序后的条目（保持原序 or 按考核正确率；未考核排最后）。 */
  function sortedCourseItems(items: CourseItem[]): CourseItem[] {
    if (!sortBy) return items;
    const arr = [...items];
    const rateOf = (c: CourseItem) => {
      const r = examRateOf(c.title);
      return r == null ? -1 : r;
    };
    arr.sort((a, b) => {
      const ra = rateOf(a);
      const rb = rateOf(b);
      if (ra < 0 && rb < 0) return 0;
      if (ra < 0) return 1;
      if (rb < 0) return -1;
      return sortBy === "rateAsc" ? ra - rb : rb - ra;
    });
    return arr;
  }

  if (loading) {
    return (
      <div className="dashboard-panel">
        <div className="placeholder">⏳ 正在汇总学习进度…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-panel">
        <div className="placeholder">
          ⚠️ {error}
          <br />
          <button className="confirm" onClick={load} style={{ marginTop: 12 }}>
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!summary || summary.topics.length === 0) {
    return (
      <div className="dashboard-panel">
        <div className="placeholder">📊 还没有学习主题，快去开启第一个吧</div>
      </div>
    );
  }

  // ---------- 单课详情（含课程学习的总结内容 + 考核/复习全景） ----------
  if (drill?.course) {
    return (
      <CourseDetail
        childId={childId}
        topicDir={drill.topic.topicKey}
        topicName={drill.topic.name}
        course={drill.course}
        onBack={goBack}
        courseStatus={courseStatusMap[drill.course.title] ?? null}
      />
    );
  }

  // ---------- 主题内：每课列表 ----------
  if (drill?.detail) {
    const d = drill.detail;
    const shown = d.items.filter((c) => matchesCourseSearch(c, search));
    const sortShown = sortedCourseItems(d.items).filter((c) => matchesCourseSearch(c, search));
    return (
      <div className="dashboard-panel">
        <div className="dash-breadcrumb">
          <IconButton icon={ArrowLeft} title="返回" onClick={goBack} className="dash-back" />
          <span className="dash-crumb-current">{drill.topic.name}</span>
          <span className="dash-crumb-sep">·</span>
          <span className="dash-crumb">{d.learned}/{d.total} 课</span>
        </div>

        {loadingDetail && <div className="placeholder">⏳ 正在加载课程…</div>}

        <div className="lesson-search-wrap">
          <input
            className="lesson-search"
            type="text"
            placeholder="🔍 搜索课程 / 标签…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search.trim() && (
            <span className="lesson-search-count">
              {shown.length} / {d.items.length}
            </span>
          )}
        </div>

        {/* 排序：按考核正确率 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 12, color: "#6b7686", flexWrap: "wrap" }}>
          <span>排序：</span>
          <button
            onClick={() => setSortBy(sortBy === "rateAsc" ? null : "rateAsc")}
            style={sortBtn(sortBy === "rateAsc")}
            title="考核正确率从低到高（需关注的在前）"
          >
            考核准确率 低→高{sortBy === "rateAsc" ? " ✓" : ""}
          </button>
          <button
            onClick={() => setSortBy(sortBy === "rateDesc" ? null : "rateDesc")}
            style={sortBtn(sortBy === "rateDesc")}
            title="考核正确率从高到低"
          >
            考核准确率 高→低{sortBy === "rateDesc" ? " ✓" : ""}
          </button>
          {sortBy && (
            <button onClick={() => setSortBy(null)} style={sortBtn(false)}>
              恢复原序
            </button>
          )}
          <span style={{ color: "#bbb" }}>（无考核数据的课程排在最后）</span>
        </div>

        <div className="lesson-list">
          {(sortShown.length ? sortShown : shown).map((c) => {
            const rate = examRateOf(c.title);
            return (
              <button className="lesson-row" key={c.title} onClick={() => openCourse(c)}>
                <span className="lesson-status">{c.status}</span>
                <span className="lesson-main">
                  <span className="lesson-title">{c.title}</span>
                  <span className="lesson-sub">
                    {c.mastery && <span className="lesson-mastery">掌握度 {c.mastery}</span>}
                    {rate != null && (
                      <span className={`lesson-exam ${rate < 0.7 ? "weak" : ""}`} title="历次考核逐题正确率">
                        🎯 考核 {Math.round(rate * 100)}%
                      </span>
                    )}
                    {c.tags && <span className="lesson-tags">{c.tags}</span>}
                    {(c.firstLearned || c.reviewCount > 0) && (
                      <span className="lesson-meta">
                        {c.firstLearned ? `首次 ${c.firstLearned}` : ""}
                        {c.reviewCount > 0 ? ` · 复习 ${c.reviewCount} 次` : ""}
                      </span>
                    )}
                  </span>
                </span>
                <span className="lesson-arrow">›</span>
              </button>
            );
          })}
          {!loadingDetail && shown.length === 0 && (
            <div className="lesson-search-empty">没有匹配「{search}」的课程</div>
          )}
        </div>
      </div>
    );
  }

  // ---------- 总览：总体进度 + 各主题（点击钻取） ----------
  const { totals } = summary;
  return (
    <div className="dashboard-panel">
      <div className="dashboard-header">
        <h2>学习进度看板</h2>
        <button className="dashboard-refresh" onClick={load} title="刷新">
          <RefreshCw size={18} />
        </button>
      </div>

      {/* 总览卡片 */}
      <div className="dashboard-overview">
        <div className="overview-main">
          <div className="overview-label">总体进度</div>
          <div className="overview-num">
            {totals.learned} <span className="overview-total">/ {totals.total}</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${totals.percent}%` }} />
          </div>
        </div>
        <div className="overview-stats">
          <div className="stat">
            <div className="stat-value">{totals.percent}%</div>
            <div className="stat-label">完成率</div>
          </div>
          <div className="stat">
            <div className="stat-value">{totals.completedCount}</div>
            <div className="stat-label">已完成主题</div>
          </div>
          <div className="stat">
            <div className="stat-value">{totals.topicCount}</div>
            <div className="stat-label">主题总数</div>
          </div>
        </div>
      </div>

      {/* 主题卡片列表（点击钻取每课） */}
      <div className="dashboard-topics">
        {summary.topics.map((t) => {
          const done = t.total > 0 && t.learned >= t.total;
          return (
            <button
              key={t.name}
              className={`topic-card ${done ? "done" : ""}`}
              style={{ textAlign: "left", cursor: "pointer", width: "100%" }}
              onClick={() => openTopic(t)}
            >
              <div className="topic-card-head">
                <div className="topic-name">
                  {done ? "🏆 " : ""}
                  {t.name}
                </div>
                <div className="topic-badges">
                  {t.type && (
                    <span className={`badge ${t.type === "必学" ? "must" : "optional"}`}>{t.type}</span>
                  )}
                </div>
              </div>

              <div className="topic-progress-row">
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${t.percent}%` }} />
                </div>
                <div className="topic-progress-num">
                  {t.learned}/{t.total} · {t.percent}%
                </div>
              </div>

              <div className="topic-meta">
                {t.next && (
                  <div className="topic-next" title={t.next}>
                    下一步：{t.next}
                  </div>
                )}
                {t.updated && <div className="topic-updated">更新于 {t.updated}</div>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
