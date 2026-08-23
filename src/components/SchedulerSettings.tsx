import { useEffect, useState } from "react";

interface SchedulerChildConfig {
  recording: { enabled: boolean; times: string[]; onNewSession: boolean };
  sessionReset: { enabled: boolean; hour: number; minute: number };
  autoNewSession: { enabled: boolean; hour: number; minute: number };
  archiveLimit: number;
}

interface ChildItem {
  childId: string;
  name: string;
  aiEmoji?: string;
}

function defaultConfig(): SchedulerChildConfig {
  return {
    recording: { enabled: false, times: ["21:00"], onNewSession: false },
    sessionReset: { enabled: false, hour: 22, minute: 0 },
    autoNewSession: { enabled: false, hour: 21, minute: 0 },
    archiveLimit: 20,
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
        // 用 defaultConfig 兜底，确保旧配置（缺 autoNewSession 等字段）也能正常渲染
        map[c.childId] = { ...defaultConfig(), ...(map[c.childId] || {}) };
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
        为每个孩子单独设置自动任务（学习记录总结、学习进度追踪、每日会话重置、自动新建会话）。默认全部关闭，开启后才会在后台定时调用模型。会话重置 / 自动新建会话只清空对话与学习资料面板，不会清除学习进度。注意：自动新建会话已包含「跨天自动开新 + 每天定点开新」，与「每日会话重置」功能重叠，二者择一开启即可。
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

                {/* 每日学习记录总结（recording）：多时间点触发 + 会话前自动总结 */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
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
                      每日学习记录总结
                    </label>
                  </div>
                  {cfg.recording.enabled && (
                    <div
                      style={{
                        marginTop: 8,
                        marginLeft: 26,
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                    >
                      <div style={{ fontSize: 13, color: "#666" }}>
                        每天在这些时间点自动总结当天对话（可多个；当天无对话自动跳过）：
                      </div>
                      {cfg.recording.times.map((t, idx) => (
                        <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input
                            type="time"
                            value={t}
                            onChange={(e) =>
                              updateConfig(child.childId, (p) => ({
                                ...p,
                                recording: {
                                  ...p.recording,
                                  times: p.recording.times.map((v, i) =>
                                    i === idx ? e.target.value : v
                                  ),
                                },
                              }))
                            }
                            style={{
                              padding: "4px 6px",
                              border: "1px solid #ddd",
                              borderRadius: 6,
                              fontSize: 13,
                            }}
                          />
                          <button
                            onClick={() =>
                              updateConfig(child.childId, (p) => ({
                                ...p,
                                recording: {
                                  ...p.recording,
                                  times: p.recording.times.filter((_, i) => i !== idx),
                                },
                              }))
                            }
                            style={{
                              padding: "4px 10px",
                              border: "1px solid #ddd",
                              borderRadius: 6,
                              background: "white",
                              fontSize: 13,
                              cursor: "pointer",
                            }}
                          >
                            删除
                          </button>
                        </div>
                      ))}
                      <div>
                        <button
                          onClick={() =>
                            updateConfig(child.childId, (p) => ({
                              ...p,
                              recording: {
                                ...p.recording,
                                times: [...p.recording.times, "21:00"],
                              },
                            }))
                          }
                          style={{
                            padding: "4px 10px",
                            border: "1px solid #ddd",
                            borderRadius: 6,
                            background: "white",
                            fontSize: 13,
                            cursor: "pointer",
                          }}
                        >
                          + 添加时间点
                        </button>
                      </div>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={cfg.recording.onNewSession}
                          onChange={(e) =>
                            updateConfig(child.childId, (p) => ({
                              ...p,
                              recording: { ...p.recording, onNewSession: e.target.checked },
                            }))
                          }
                        />
                        每次新建会话前，自动总结之前的会话
                      </label>
                    </div>
                  )}
                </div>

                {/* session-reset */}
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={cfg.sessionReset.enabled}
                      onChange={(e) =>
                        updateConfig(child.childId, (p) => ({
                          ...p,
                          sessionReset: { ...p.sessionReset, enabled: e.target.checked },
                        }))
                      }
                    />
                    会话重置（清空对话与学习资料，不清除进度）
                  </label>
                  {cfg.sessionReset.enabled && (
                    <span style={{ fontSize: 13, color: "#666" }}>
                      每天{" "}
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={cfg.sessionReset.hour}
                        onChange={(e) =>
                          updateConfig(child.childId, (p) => ({
                            ...p,
                            sessionReset: {
                              ...p.sessionReset,
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
                        value={cfg.sessionReset.minute}
                        onChange={(e) =>
                          updateConfig(child.childId, (p) => ({
                            ...p,
                            sessionReset: {
                              ...p.sessionReset,
                              minute: Math.max(0, Math.min(59, parseInt(e.target.value) || 0)),
                            },
                          }))
                        }
                        style={{ width: 44, padding: "4px 6px", border: "1px solid #ddd", borderRadius: 6 }}
                      />
                    </span>
                  )}
                </div>

                {/* 自动新建会话 */}
                <div
                  style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}
                >
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={cfg.autoNewSession.enabled}
                      onChange={(e) =>
                        updateConfig(child.childId, (p) => ({
                          ...p,
                          autoNewSession: {
                            ...(p.autoNewSession || { enabled: false, hour: 21, minute: 0 }),
                            enabled: e.target.checked,
                          },
                        }))
                      }
                    />
                    自动新建会话（开启后：① app 启动时若最后一次对话不是当天则开新会话；② 每天固定时间节点开新会话）
                  </label>
                  {cfg.autoNewSession.enabled && (
                    <span style={{ fontSize: 13, color: "#666" }}>
                      每天{" "}
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={cfg.autoNewSession.hour}
                        onChange={(e) =>
                          updateConfig(child.childId, (p) => ({
                            ...p,
                            autoNewSession: {
                              ...(p.autoNewSession || { enabled: true, hour: 21, minute: 0 }),
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
                        value={cfg.autoNewSession.minute}
                        onChange={(e) =>
                          updateConfig(child.childId, (p) => ({
                            ...p,
                            autoNewSession: {
                              ...(p.autoNewSession || { enabled: true, hour: 21, minute: 0 }),
                              minute: Math.max(0, Math.min(59, parseInt(e.target.value) || 0)),
                            },
                          }))
                        }
                        style={{ width: 44, padding: "4px 6px", border: "1px solid #ddd", borderRadius: 6 }}
                      />
                    </span>
                  )}
                </div>

                {/* 历史会话归档保留上限 */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 4,
                  }}
                >
                  <span style={{ fontSize: 13, color: "#666" }}>
                    历史会话归档保留数量
                    <input
                      type="number"
                      min={0}
                      max={200}
                      value={cfg.archiveLimit}
                      onChange={(e) =>
                        updateConfig(child.childId, (p) => ({
                          ...p,
                          archiveLimit: Math.max(
                            0,
                            Math.min(200, parseInt(e.target.value) || 0)
                          ),
                        }))
                      }
                      style={{
                        width: 56,
                        marginLeft: 6,
                        padding: "4px 6px",
                        border: "1px solid #ddd",
                        borderRadius: 6,
                      }}
                    />
                    <span style={{ marginLeft: 6, color: "#999" }}>
                      个（每次会话重置后只保留最近 N 个旧会话文件；设为 0 则不保留历史归档）
                    </span>
                  </span>
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
