import { useState, useEffect, useCallback } from "react";

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

interface Props {
  childId: string;
}

/** 学习进度看板：汇总各学习主题的进度，来源 learning/{topic}/{topic}.md 的 frontmatter */
export default function LearningDashboard({ childId }: Props) {
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  const { totals } = summary;

  return (
    <div className="dashboard-panel">
      <div className="dashboard-header">
        <h2>学习进度看板</h2>
        <button className="dashboard-refresh" onClick={load} title="刷新">
          🔄
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

      {/* 主题卡片列表 */}
      <div className="dashboard-topics">
        {summary.topics.map((t) => {
          const done = t.total > 0 && t.learned >= t.total;
          return (
            <div key={t.name} className={`topic-card ${done ? "done" : ""}`}>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
