import { useEffect, useState } from "react";
import IconButton from "./IconButton";
import { Plus, Save, Trash2 } from "lucide-react";

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

interface ParentSchedulerConfig {
  autoNewSession: { enabled: boolean; hour: number; minute: number };
}

interface EventPollConfig {
  enabled: boolean;
  intervalMinutes: number;
}

function defaultParentConfig(): ParentSchedulerConfig {
  return { autoNewSession: { enabled: false, hour: 21, minute: 0 } };
}

function defaultEventPollConfig(): EventPollConfig {
  return { enabled: true, intervalMinutes: 2 };
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
  // 家长会话配置（autoNewSession，2026-08-24：家长会话持久化 + 自动新建策略）
  const [parentCfg, setParentCfg] = useState<ParentSchedulerConfig>(defaultParentConfig());
  const [parentStatus, setParentStatus] = useState("");
  // 云端事件轮询（ISSUE-041 层 C：家长发课→孩子收到的延迟上界）
  const [eventPoll, setEventPoll] = useState<EventPollConfig>(defaultEventPollConfig());
  const [eventPollStatus, setEventPollStatus] = useState("");

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
        // 家长会话配置（scheduler:config:get 现在返回 parent 段）
        if (res.parent) {
          setParentCfg({ ...defaultParentConfig(), ...res.parent });
        }
      }
      const ep = await window.api.eventPollConfigGet();
      if (ep) {
        setEventPoll({ ...defaultEventPollConfig(), ...ep });
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

  async function saveParent() {
    const res = await window.api.schedulerParentConfigSet(parentCfg);
    if (res?.success) {
      setParentStatus("已保存");
    } else {
      setParentStatus(`保存失败: ${res?.error || "未知错误"}`);
    }
  }

  function updateParentTime(value: string) {
    const [h, m] = value.split(":").map((x) => Number(x));
    if (Number.isFinite(h) && Number.isFinite(m)) {
      setParentCfg((p) => ({ ...p, autoNewSession: { ...p.autoNewSession, hour: h, minute: m } }));
    }
  }

  async function saveEventPoll() {
    const interval = Number(eventPoll.intervalMinutes);
    if (!Number.isFinite(interval) || interval < 1 || interval > 60) {
      setEventPollStatus("间隔需为 1-60 分钟");
      return;
    }
    const res = await window.api.eventPollConfigSet({
      enabled: eventPoll.enabled,
      intervalMinutes: Math.floor(interval),
    });
    if (res && typeof res.enabled === "boolean") {
      setEventPollStatus("已保存");
    } else {
      setEventPollStatus("保存失败");
    }
  }

  const pad2 = (n: number) => String(n).padStart(2, "0");

  return (
    <div className="settings-section">
      <h3>定时任务</h3>
      <p className="desc">
        为每个孩子单独设置自动任务（学习记录总结、学习进度追踪、每日会话重置、自动新建会话）。默认全部关闭，开启后才会在后台定时调用模型。会话重置 / 自动新建会话只清空对话与学习资料面板，不会清除学习进度。注意：自动新建会话已包含「跨天自动开新 + 每天定点开新」，与「每日会话重置」功能重叠，二者择一开启即可。
      </p>

      {!loaded ? (
        <p style={{ color: "#888", fontSize: 13 }}>加载中…</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* 家长会话（自动新建会话）配置区——2026-08-24：家长会话持久化，策略与孩子一致 */}
          <div
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
                marginBottom: 10,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 15 }}>家长会话（自动新建会话）</div>
              <IconButton
                icon={Save}
                title="保存"
                onClick={saveParent}
                style={{
                  padding: "6px 14px",
                  background: "#667eea",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 8, lineHeight: 1.6 }}>
              家长工作台的 AI 会话（课程管理 / 教学内容）会持久保存对话历史。开启后：跨天自动开新会话；或每天到设定时间自动开新会话（与孩子一致）。旧会话保留为归档。
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={parentCfg.autoNewSession.enabled}
                onChange={(e) =>
                  setParentCfg((p) => ({
                    ...p,
                    autoNewSession: { ...p.autoNewSession, enabled: e.target.checked },
                  }))
                }
              />
              自动新建会话
            </label>
            {parentCfg.autoNewSession.enabled && (
              <div style={{ marginTop: 8, marginLeft: 26, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, color: "#666" }}>每天新建时间：</span>
                <input
                  type="time"
                  value={`${pad2(parentCfg.autoNewSession.hour)}:${pad2(parentCfg.autoNewSession.minute)}`}
                  onChange={(e) => updateParentTime(e.target.value)}
                  style={{
                    padding: "4px 6px",
                    border: "1px solid #ddd",
                    borderRadius: 6,
                    fontSize: 13,
                  }}
                />
              </div>
            )}
            {parentStatus && (
              <div style={{ fontSize: 12, color: parentStatus.includes("失败") ? "red" : "#48bb78", marginTop: 6 }}>
                {parentStatus}
              </div>
            )}
          </div>

          {/* 云端事件轮询配置区（ISSUE-041 层 C：家长发课→孩子收到的延迟上界，设备级） */}
          <div
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
                marginBottom: 10,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 15 }}>云端事件轮询</div>
              <IconButton
                icon={Save}
                title="保存"
                onClick={saveEventPoll}
                style={{
                  padding: "6px 14px",
                  background: "#667eea",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 8, lineHeight: 1.6 }}>
              应用定期向云端询问「有没有家长发来的课程分配包 / 进度查询请求」，有则立即在本地处理：
              分配包写入本机数据库（学习进度不受影响），进度请求则生成摘要上传。间隔越短，家长在另一台
              电脑分配后孩子收到得越快（默认 2 分钟）。孩子打开学习会话时还会额外立即检查一次，无需等待轮询。
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={eventPoll.enabled}
                onChange={(e) => setEventPoll((p) => ({ ...p, enabled: e.target.checked }))}
              />
              开启事件轮询
            </label>
            <div style={{ marginTop: 8, marginLeft: 26, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, color: "#666" }}>轮询间隔（分钟）：</span>
              <input
                type="number"
                min={1}
                max={60}
                value={eventPoll.intervalMinutes}
                onChange={(e) =>
                  setEventPoll((p) => ({ ...p, intervalMinutes: Number(e.target.value) }))
                }
                style={{
                  width: 72,
                  padding: "4px 6px",
                  border: "1px solid #ddd",
                  borderRadius: 6,
                  fontSize: 13,
                }}
              />
            </div>
            {eventPollStatus && (
              <div style={{ fontSize: 12, color: eventPollStatus.includes("失败") ? "red" : "#48bb78", marginTop: 6 }}>
                {eventPollStatus}
              </div>
            )}
          </div>

          {children.length === 0 ? (
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
                  <IconButton
                    icon={Save}
                    title="保存"
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
                  />
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
                          <IconButton
                            icon={Trash2}
                            title="删除"
                            danger
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
                          />
                        </div>
                      ))}
                      <div>
                          <IconButton
                            icon={Plus}
                            title="添加时间点"
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
                          />
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
  )}
    </div>
  );
}
