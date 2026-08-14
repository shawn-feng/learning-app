import { useState, useEffect } from "react";

interface Props {
  childrenList: any[];
  selectedChild: any;
  onSelectChild: (child: any) => void;
}

interface TopicProgress {
  name: string;
  learned: number;
  total: number;
  next: string;
  updated: string;
}

function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const result: Record<string, any> = {};
  for (const line of yaml.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      result[key] = val;
    }
  }
  return result;
}

export default function ProgressView({ childrenList, selectedChild, onSelectChild }: Props) {
  const [progress, setProgress] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedChild) return;
    setLoading(true);
    window.api
      .getProgress(selectedChild.childId)
      .then((data: any) => setProgress(data || {}))
      .finally(() => setLoading(false));
  }, [selectedChild]);

  function parseTopics(): TopicProgress[] {
    const topics: TopicProgress[] = [];
    const topicsContent = progress.studyTopics || "";
    const mapping = parseFrontmatter(topicsContent).topics;

    if (mapping && typeof mapping === "object") {
      for (const [topic, info] of Object.entries(mapping as Record<string, any>)) {
        const detailFile = typeof info === "string" ? info : info?.detail;
        if (!detailFile) continue;
        const detailContent = progress[detailFile];
        if (detailContent) {
          const fm = parseFrontmatter(detailContent);
          topics.push({
            name: topic,
            learned: parseInt(fm.learned) || 0,
            total: parseInt(fm.total) || 0,
            next: fm.next || "",
            updated: fm.updated || "",
          });
        }
      }
    }
    return topics;
  }

  const topics = parseTopics();

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

          {selectedChild && !loading && topics.length === 0 && (
            <div>
              <p style={{ color: "#888", marginBottom: 16 }}>
                还没有学习主题。孩子开始学习后，进度会显示在这里。
              </p>
              {progress.studyTopics && (
                <div className="settings-section">
                  <h3>主题目录文件</h3>
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, color: "#555" }}>
                    {progress.studyTopics}
                  </pre>
                </div>
              )}
            </div>
          )}

          {selectedChild && !loading && topics.length > 0 && (
            <div>
              {topics.map((t) => {
                const pct = t.total > 0 ? Math.round((t.learned / t.total) * 100) : 0;
                return (
                  <div key={t.name} className="progress-topic">
                    <h4>{t.name}</h4>
                    <div className="progress-bar">
                      <div className="fill" style={{ width: `${pct}%` }} />
                    </div>
                    <div style={{ fontSize: 13, color: "#666", marginBottom: 8 }}>
                      已完成 {t.learned}/{t.total} 课（{pct}%）
                      {t.next && <span> · 下一课：{t.next}</span>}
                    </div>
                    {t.updated && (
                      <div style={{ fontSize: 12, color: "#999" }}>最近更新：{t.updated}</div>
                    )}
                  </div>
                );
              })}

              {progress.studyRules && (() => {
                const rules = parseFrontmatter(progress.studyRules).rules;
                if (!rules || typeof rules !== "object") return null;
                const today = new Date().toISOString().slice(0, 10);
                return (
                  <div className="settings-section">
                    <h3>今日评估</h3>
                    <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid #eee" }}>
                          <th style={{ textAlign: "left", padding: "8px 4px" }}>主题</th>
                          <th style={{ textAlign: "left", padding: "8px 4px" }}>每日目标</th>
                          <th style={{ textAlign: "left", padding: "8px 4px" }}>完成情况</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(rules as Record<string, any>).map(([topic, rule]) => {
                          const t = topics.find((t) => t.name === topic);
                          const updatedToday = t?.updated?.startsWith(today) || false;
                          return (
                            <tr key={topic} style={{ borderBottom: "1px solid #f5f5f5" }}>
                              <td style={{ padding: "8px 4px" }}>{topic}</td>
                              <td style={{ padding: "8px 4px" }}>{rule.daily} 课/天</td>
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
                );
              })()}

              {progress.dailyLogs && progress.dailyLogs.length > 0 && (
                <div className="settings-section">
                  <h3>最近日志</h3>
                  {[...progress.dailyLogs].reverse().slice(0, 3).map((log: any) => (
                    <details key={log.name} style={{ marginBottom: 8 }}>
                      <summary style={{ cursor: "pointer", fontWeight: 500 }}>{log.name}</summary>
                      <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, marginTop: 8, color: "#555" }}>
                        {log.content}
                      </pre>
                    </details>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
