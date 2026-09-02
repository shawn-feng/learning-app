import { useState, useEffect, useCallback } from "react";
import CourseDetail, { matchesCourseSearch } from "./CourseDetail";
import IconButton from "./IconButton";
import { ArrowLeft } from "lucide-react";

interface Props {
  childrenList: any[];
  selectedChild: any;
  onSelectChild: (child: any) => void;
}

interface TopicSummary {
  name: string;
  topicKey: string;
  learned: number;
  total: number;
  percent: number;
  next: string;
  updated: string;
  type: string; // 必学 / 选学 / 复习（旧 daily 每日目标已停用，ISSUE-033：每日安排看学习计划）
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

// 进度数据源已从 SQLite（kb.sqlite，ISSUE-023 P2）统一；此处不再读旧 markdown（study-topics.md 等）。

export default function ProgressView({ childrenList, selectedChild, onSelectChild }: Props) {
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  const [loading, setLoading] = useState(false);

  const [drill, setDrill] = useState<{ topic: TopicSummary; detail: TopicDetail | null; course: CourseItem | null } | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!selectedChild) {
      setSummary(null);
      setDrill(null);
      return;
    }
    setLoading(true);
    setDrill(null);
    window.api
      .learningSummary(selectedChild.childId)
      .then((r: any) => setSummary(r?.success ? r.data : null))
      .finally(() => setLoading(false));
  }, [selectedChild]);

  function openTopic(t: TopicSummary) {
    const topicDir = t.topicKey;
    setSearch("");
    setDrill({ topic: t, detail: null, course: null });
    setLoadingDetail(true);
    window.api
      .learningTopic(selectedChild.childId, topicDir)
      .then((r: any) => {
        if (r?.success) setDrill((d) => (d ? { ...d, detail: r.data } : d));
      })
      .finally(() => setLoadingDetail(false));
  }

  function openCourse(c: CourseItem) {
    setDrill((d) => (d ? { ...d, course: c } : d));
  }

  function goBack() {
    setDrill((d) => {
      if (!d) return d;
      if (d.course) return { ...d, course: null };
      return null;
    });
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  return (
    <div>
      <h3 style={{ marginBottom: 16 }}>学习进度</h3>

      {childrenList.length === 0 ? (
        <p style={{ color: "#888" }}>还没有孩子，请先在"孩子管理"中添加。</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
            {childrenList.map((child) => (
              <button
                key={child.childId}
                onClick={() => onSelectChild(child)}
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: selectedChild?.childId === child.childId ? "2px solid #667eea" : "1px solid #ddd",
                  background: selectedChild?.childId === child.childId ? "#f0f4ff" : "white",
                  cursor: "pointer",
                }}
              >
                {child.avatar} {child.name}
              </button>
            ))}
          </div>

          {!selectedChild && <p style={{ color: "#888" }}>选择一个孩子查看学习进度。</p>}

          {selectedChild && loading && <p>加载中...</p>}

          {selectedChild && !loading && summary && (
            <div>
              {/* 单课详情（含课程学习的总结内容） */}
              {drill?.course && (
                <CourseDetail
                  childId={selectedChild.childId}
                  topicDir={drill.topic.topicKey}
                  topicName={drill.topic.name}
                  course={drill.course}
                  onBack={goBack}
                />
              )}

              {/* 主题内：每课列表 */}
              {drill?.detail && !drill.course && (
                <div>
                  <div className="dash-breadcrumb" style={{ marginBottom: 12 }}>
                    <IconButton icon={ArrowLeft} title="返回" onClick={goBack} className="dash-back" />
                    <span className="dash-crumb-current">{drill.topic.name}</span>
                    <span className="dash-crumb-sep">·</span>
                    <span className="dash-crumb">{drill.detail.learned}/{drill.detail.total} 课</span>
                  </div>
                  {loadingDetail && <p>加载中...</p>}
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
                        {drill.detail.items.filter((c) => matchesCourseSearch(c, search)).length} / {drill.detail.items.length}
                      </span>
                    )}
                  </div>
                  <div className="lesson-list">
                    {drill.detail.items.filter((c) => matchesCourseSearch(c, search)).map((c) => (
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
                    {!loadingDetail && drill.detail.items.filter((c) => matchesCourseSearch(c, search)).length === 0 && (
                      <div className="lesson-search-empty">没有匹配「{search}」的课程</div>
                    )}
                  </div>
                </div>
              )}

              {/* 总览：今日评估 + 主题卡片（点击钻取） */}
              {!drill && (
                <>
                  {/* 今日学习情况（按主题看今天是否学过；每天学什么以学习计划为准，见 ISSUE-033） */}
                  {summary.topics.some((t) => t.type) && (
                    <div className="settings-section" style={{ marginBottom: 24 }}>
                      <h3 style={{ marginBottom: 8 }}>今日学习情况</h3>
                      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                        <thead>
                          <tr style={{ borderBottom: "1px solid #eee" }}>
                            <th style={{ textAlign: "left", padding: "8px 4px" }}>主题</th>
                            <th style={{ textAlign: "left", padding: "8px 4px" }}>类型</th>
                            <th style={{ textAlign: "left", padding: "8px 4px" }}>完成情况</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.topics.map((t) => {
                            const updatedToday = t.updated?.startsWith(todayStr()) || false;
                            return (
                              <tr key={t.name} style={{ borderBottom: "1px solid #f5f5f5" }}>
                                <td style={{ padding: "8px 4px" }}>{t.name}</td>
                                <td style={{ padding: "8px 4px" }}>{t.type || "—"}</td>
                                <td style={{ padding: "8px 4px" }}>
                                  {updatedToday ? (
                                    <span style={{ color: "#48bb78" }}>✅ 今天已学习</span>
                                  ) : (
                                    <span style={{ color: "#e53e3e" }}>⬜ 今日未学习</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* 主题卡片列表 */}
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
                </>
              )}
            </div>
          )}

          {selectedChild && !loading && summary && summary.topics.length === 0 && (
            <p style={{ color: "#888" }}>还没有学习主题。孩子开始学习后，进度会显示在这里。</p>
          )}
        </>
      )}
    </div>
  );
}
