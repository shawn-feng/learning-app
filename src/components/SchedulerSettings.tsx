import { useEffect, useState } from "react";

interface SchedulerChildConfig {
  recording: { enabled: boolean; intervalHours: number };
  studyTracker: { enabled: boolean; hour: number; minute: number };
}

interface ChildItem {
  childId: string;
  name: string;
  aiEmoji?: string;
}

function defaultConfig(): SchedulerChildConfig {
  return {
    recording: { enabled: false, intervalHours: 1 },
    studyTracker: { enabled: false, hour: 21, minute: 0 },
  };
}

export default function SchedulerSettings() {
  const [children, setChildren] = useState<ChildItem[]>([]);
  const [configs, setConfigs] = useState<Record<string, SchedulerChildConfig>>({});
  const [status, setStatus] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const list = await window.api.childList();
      const childrenList = (list || []) as ChildItem[];
      setChildren(childrenList);

      const res = await window.api.schedulerConfigGet();
      const map: Record<string, SchedulerChildConfig> = {};
      if (res?.success) {
        for (const [childId, cfg] of Object.entries(res.configs || {})) {
          map[childId] = cfg as SchedulerChildConfig;
        }
      }
      for (const c of childrenList) {
        if (!map[c.childId]) map[c.childId] = defaultConfig();
      }
      setConfigs(map);
      setLoaded(true);
    })();
  }, []);

  function updateConfig(
    childId: string,
    updater: (prev: SchedulerChildConfig) => SchedulerChildConfig
  ) {
    setConfigs((prev) => ({
      ...prev,
      [childId]: updater(prev[childId] || defaultConfig()),
    }));
  }

  async function save(childId: string) {
    const cfg = configs[childId];
    if (!cfg) return;
    const res = await window.api.schedulerConfigSet(childId, cfg);
    if (res?.success) {
      setStatus((s) => ({ ...s, [childId]: "已保存" }));
    } else {
      setStatus((s) => ({ ...s, [childId]: `保存失败: ${res?.error || "未知错误"}` }));
    }
  }

  return (
    <div className="settings-section">
      <h3>定时任务</h3>
      <p className="desc">
        为每个孩子单独设置自动任务（学习记录总结、学习进度追踪）。默认全部关闭，开启后才会在后台定时调用模型。
      </p>

      {!loaded ? (
        <p style={{ color: "#888", fontSize: 13 }}>加载中…</p>
      ) : children.length === 0 ? (
        <p style={{ color: "#888", fontSize: 13 }}>还没有孩子账号。</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {children.map((child) => {
            const cfg = configs[child.childId] || defaultConfig();
            return (
              <div
                key={child.childId}
                style={{
                  border: "1px solid #eee",
                  borderRadius: 10,
                  padding: 16,
                  background: "#fafbff",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 12,
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 15 }}>
                    {child.aiEmoji ? `${child.aiEmoji} ` : ""}
                    {child.name}
                  </div>
                  <button
                    onClick={() => save(child.childId)}
                    style={{
                      padding: "6px 14px",
                      background: "#667eea",
                      color: "white",
                      border: "none",
                      borderRadius: 6,
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    保存
                  </button>
                </div>

                {/* recording */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    marginBottom: 10,
                  }}
                >
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={cfg.recording.enabled}
                      onChange={(e) =>
                        updateConfig(child.childId, (p) => ({
                          ...p,
                          recording: { ...p.recording, enabled: e.target.checked },
                        }))
                      }
                    />
                    学习记录总结（recording）
                  </label>
                  {cfg.recording.enabled && (
                    <span style={{ fontSize: 13, color: "#666" }}>
                      每{" "}
                      <input
                        type="number"
                        min={1}
                        max={24}
                        value={cfg.recording.intervalHours}
                        onChange={(e) =>
                          updateConfig(child.childId, (p) => ({
                            ...p,
                            recording: {
                              ...p.recording,
                              intervalHours: Math.max(1, parseInt(e.target.value) || 1),
                            },
                          }))
                        }
                        style={{ width: 48, padding: "4px 6px", border: "1px solid #ddd", borderRadius: 6 }}
                      />{" "}
                      小时
                    </span>
                  )}
                </div>

                {/* study-tracker */}
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={cfg.studyTracker.enabled}
                      onChange={(e) =>
                        updateConfig(child.childId, (p) => ({
                          ...p,
                          studyTracker: { ...p.studyTracker, enabled: e.target.checked },
                        }))
                      }
                    />
                    学习进度追踪（study-tracker）
                  </label>
                  {cfg.studyTracker.enabled && (
                    <span style={{ fontSize: 13, color: "#666" }}>
                      每天{" "}
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={cfg.studyTracker.hour}
                        onChange={(e) =>
                          updateConfig(child.childId, (p) => ({
                            ...p,
                            studyTracker: {
                              ...p.studyTracker,
                              hour: Math.max(0, Math.min(23, parseInt(e.target.value) || 0)),
                            },
                          }))
                        }
                        style={{ width: 44, padding: "4px 6px", border: "1px solid #ddd", borderRadius: 6 }}
                      />
                      :
                      <input
                        type="number"
                        min={0}
                        max={59}
                        value={cfg.studyTracker.minute}
                        onChange={(e) =>
                          updateConfig(child.childId, (p) => ({
                            ...p,
                            studyTracker: {
                              ...p.studyTracker,
                              minute: Math.max(0, Math.min(59, parseInt(e.target.value) || 0)),
                            },
                          }))
                        }
                        style={{ width: 44, padding: "4px 6px", border: "1px solid #ddd", borderRadius: 6 }}
                      />
                    </span>
                  )}
                </div>

                {status[child.childId] && (
                  <p
                    style={{
                      fontSize: 12,
                      marginTop: 8,
                      color: status[child.childId].startsWith("保存失败") ? "red" : "#667eea",
                    }}
                  >
                    {status[child.childId]}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
