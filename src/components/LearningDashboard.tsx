import { useState, useEffect, useCallback } from "react";
import CourseDetail, { matchesCourseSearch } from "./CourseDetail";
import IconButton from "./IconButton";
import { ArrowLeft, RefreshCw } from "lucide-react";

interface TopicSummary {
  name: string;
  file: string;
  learned: number;
  total: number;
  percent: number;
  next: string;
  updated: string;
  daily: number | null;
  type: string;
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
  }, [childId]);

  useEffect(() => {
    load();
  }, [load]);

  // 切走孩子时退出钻取
  useEffect(() => {
    setDrill(null);
  }, [childId]);

  function openTopic(t: TopicSummary) {
    const topicDir = t.file.split("/")[0];
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

  // ---------- 单课详情（含课程学习的总结内容） ----------
  if (drill?.course) {
    return (
      <CourseDetail
        childId={childId}
        topicDir={drill.topic.file.split("/")[0]}
        topicName={drill.topic.name}
        course={drill.course}
        onBack={goBack}
      />
    );
  }

  // ---------- 主题内：每课列表 ----------
  if (drill?.detail) {
    const d = drill.detail;
    const shown = d.items.filter((c) => matchesCourseSearch(c, search));
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

        <div className="lesson-list">
          {shown.map((c) => (
            <button className="lesson-row" key={c.title} onClick={() => openCourse(c)}>
              <span className="lesson-status">{c.status}</span>
              <span className="lesson-main">
                <span className="lesson-title">{c.title}</span>
                <span className="lesson-sub">
                  {c.mastery && <span className="lesson-mastery">掌握度 {c.mastery}</span>}
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
          ))}
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
                  {t.daily !== null && <span className="badge daily">每日 {t.daily}</span>}
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
