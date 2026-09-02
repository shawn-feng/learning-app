import { useCallback, useEffect, useState } from "react";
import { Plus, Save, Trash2, RefreshCw, Users } from "lucide-react";
import IconButton from "./IconButton";

interface ChildItem {
  childId: string;
  name: string;
  avatar?: string;
}

interface SchedulerTask {
  id: string;
  name: string;
  type: "recording" | "todo_gen" | "todo_stat" | "auto_new_session";
  time: string;
  extra: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  assignments: Array<{ childId: string; enabled: boolean }>;
  lastRun: { date: string; point: string; status: string; message: string; finishedAt: string } | null;
}

interface TaskRun {
  id: string;
  childId: string;
  taskId: string | null;
  taskName: string;
  taskType: string;
  date: string;
  point: string;
  status: string;
  message: string;
  startedAt: string;
  finishedAt: string;
}

const TYPE_META: Record<SchedulerTask["type"], { label: string; icon: string; hint: string }> = {
  recording: {
    label: "每日学习记录总结",
    icon: "📝",
    hint: "到点自动总结当天对话写入 daily（当天无对话自动跳过）",
  },
  todo_gen: {
    label: "今日计划 · 生成",
    icon: "📋",
    hint: "到点自动生成/刷新当天 Todolist（家长规定项 + 自规划项）",
  },
  todo_stat: {
    label: "今日计划 · 统计",
    icon: "✅",
    hint: "到点核对当天 Todolist 完成度并打勾，更新「我的执行力」",
  },
  auto_new_session: {
    label: "自动新建会话",
    icon: "🔄",
    hint: "到点自动开新会话（旧会话保留为归档）",
  },
};

const RUN_STATUS: Record<string, { label: string; color: string }> = {
  ok: { label: "成功", color: "#38a169" },
  skip: { label: "跳过", color: "#d69e2e" },
  error: { label: "失败", color: "#e53e3e" },
};

function fmt(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 家长中心「定时任务」页（新模型）：先创建任务 → 分配给孩子 → 卡片展示 + 执行结果查询。
 * 任务/分配/结果存服务端（/api/v1/scheduler/*）；任务变更后把「有效配置」合并回
 * scheduler_config（保留 classTimes/archiveLimit），worker 与客户端调度链路不变。
 */
export default function SchedulerTasksPanel({ children }: { children: ChildItem[] }) {
  const [tasks, setTasks] = useState<SchedulerTask[]>([]);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // 新建任务表单
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<{ name: string; type: SchedulerTask["type"]; time: string; onNewSession: boolean }>({
    name: "",
    type: "recording",
    time: "21:00",
    onNewSession: false,
  });
  // 分配弹窗
  const [assignFor, setAssignFor] = useState<SchedulerTask | null>(null);

  const childName = useCallback(
    (childId: string) => children.find((c) => c.childId === childId)?.name ?? childId,
    [children]
  );

  /** 任务变更后：把服务端「有效配置」（recording/todo/autoNewSession）合并回 scheduler_config */
  const pushEffectiveConfig = useCallback(async () => {
    try {
      const eff = await window.api.schedulerEffectiveConfigGet();
      const cur = await window.api.schedulerConfigGet();
      if (!eff?.success || !cur?.success) return;
      const effChildren = (eff.children ?? {}) as Record<string, any>;
      for (const [childId, e] of Object.entries(effChildren)) {
        const base = cur.configs?.[childId] ?? {};
        const merged = {
          ...base,
          recording: e?.recording ?? { enabled: false, times: [], onNewSession: false },
          todo: e?.todo ?? { enabled: false, genTime: "08:00", statTime: "21:00" },
          autoNewSession: e?.autoNewSession ?? { enabled: false, hour: 21, minute: 0 },
        };
        await window.api.schedulerConfigSet(childId, merged);
      }
    } catch (e) {
      console.warn("[scheduler-tasks] push effective config failed:", e);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [t, r] = await Promise.all([
        window.api.schedulerTasksList(),
        window.api.schedulerRunsList({ limit: 30 }),
      ]);
      if (t?.success) setTasks(t.tasks ?? []);
      else setError(t?.error || "加载任务失败");
      if (r?.success) setRuns(r.runs ?? []);
    } catch (e: any) {
      setError(e?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    pushEffectiveConfig();
  }, [load, pushEffectiveConfig]);

  function defaultName(type: SchedulerTask["type"], time: string): string {
    return `${TYPE_META[type].label} ${time}`;
  }

  async function createTask() {
    if (!form.name.trim()) {
      setError("请填写任务名称");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await window.api.schedulerTaskCreate({
        name: form.name.trim(),
        type: form.type,
        time: form.time,
        extra: form.type === "recording" ? { onNewSession: form.onNewSession } : {},
      });
      if (res?.success) {
        setShowCreate(false);
        setForm({ name: "", type: "recording", time: "21:00", onNewSession: false });
        await load();
        await pushEffectiveConfig();
      } else {
        setError(res?.error || "创建失败");
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleTaskEnabled(task: SchedulerTask, enabled: boolean) {
    const res = await window.api.schedulerTaskUpdate(task.id, { enabled });
    if (res?.success) {
      await load();
      await pushEffectiveConfig();
    }
  }

  async function deleteTask(task: SchedulerTask) {
    const r = await window.api.confirmDialog({
      title: "删除定时任务",
      message: `确定删除任务「${task.name}」吗？`,
      detail: "删除后该任务将不再执行（历史执行结果保留）。",
      confirmLabel: "删除",
      cancelLabel: "取消",
    });
    if (!r?.confirmed) return;
    const res = await window.api.schedulerTaskDelete(task.id);
    if (res?.success) {
      await load();
      await pushEffectiveConfig();
    }
  }

  async function toggleAssign(childId: string, enabled: boolean) {
    if (!assignFor) return;
    const res = await window.api.schedulerTaskAssign(assignFor.id, childId, enabled);
    if (res?.success) {
      await load();
      await pushEffectiveConfig();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}>⏰ 定时任务</h3>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "#888", lineHeight: 1.6 }}>
            先创建任务，再把任务分配给孩子；到点由服务端自动执行（设备关机/休眠也不漏跑），下方可查询执行结果。
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <IconButton
            icon={RefreshCw}
            title="刷新"
            onClick={load}
            style={{ padding: "8px 12px", border: "1px solid #ddd", borderRadius: 8, background: "#fff", fontSize: 13, cursor: "pointer" }}
          />
          <button
            onClick={() => setShowCreate((v) => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "8px 14px",
              background: "#667eea", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, cursor: "pointer",
            }}
          >
            <Plus size={16} /> 新建任务
          </button>
        </div>
      </div>

      {error && <div style={{ color: "#e53e3e", fontSize: 12 }}>{error}</div>}

      {/* 新建任务表单 */}
      {showCreate && (
        <div style={{ border: "1px solid #667eea", borderRadius: 10, padding: 16, background: "#fafbff" }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>新建定时任务</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: "#666", width: 70 }}>任务类型：</span>
              <select
                value={form.type}
                onChange={(e) => {
                  const type = e.target.value as SchedulerTask["type"];
                  setForm((f) => ({ ...f, type, name: defaultName(type, f.time) }));
                }}
                style={{ padding: "6px 10px", fontSize: 13, borderRadius: 6, border: "1px solid #ddd" }}
              >
                {(Object.keys(TYPE_META) as SchedulerTask["type"][]).map((t) => (
                  <option key={t} value={t}>
                    {TYPE_META[t].icon} {TYPE_META[t].label}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 13, color: "#666", marginLeft: 8 }}>时间：</span>
              <input
                type="time"
                value={form.time}
                onChange={(e) => setForm((f) => ({ ...f, time: e.target.value, name: defaultName(f.type, e.target.value) }))}
                style={{ padding: "6px 8px", fontSize: 13, borderRadius: 6, border: "1px solid #ddd" }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: "#666", width: 70 }}>任务名称：</span>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                style={{ flex: 1, minWidth: 200, padding: "6px 10px", fontSize: 13, borderRadius: 6, border: "1px solid #ddd" }}
              />
            </div>
            {form.type === "recording" && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.onNewSession}
                  onChange={(e) => setForm((f) => ({ ...f, onNewSession: e.target.checked }))}
                />
                每次新建会话前，自动总结之前的会话
              </label>
            )}
            <div style={{ fontSize: 12, color: "#999", lineHeight: 1.6 }}>{TYPE_META[form.type].hint}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={createTask}
                disabled={busy}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", background: "#667eea", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, cursor: "pointer" }}
              >
                <Save size={14} /> {busy ? "创建中…" : "创建任务"}
              </button>
              <button
                onClick={() => setShowCreate(false)}
                style={{ padding: "8px 14px", background: "#fff", border: "1px solid #ddd", borderRadius: 8, fontSize: 13, cursor: "pointer" }}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 任务卡片 */}
      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: "#999", fontSize: 13 }}>加载中…</div>
      ) : tasks.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: "#999", fontSize: 13, border: "1px dashed #ddd", borderRadius: 10 }}>
          还没有定时任务，点右上角「新建任务」创建，再分配给指定孩子。
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
          {tasks.map((task) => {
            const meta = TYPE_META[task.type] ?? { label: task.type, icon: "⏰", hint: "" };
            const assigned = task.assignments.filter((a) => a.enabled);
            const last = task.lastRun;
            const st = last ? RUN_STATUS[last.status] : null;
            return (
              <div
                key={task.id}
                style={{
                  border: "1px solid #eee", borderRadius: 12, padding: 14, background: "#fff",
                  opacity: task.enabled ? 1 : 0.62, display: "flex", flexDirection: "column", gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span style={{ fontSize: 22 }}>{meta.icon}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.name}</div>
                      <div style={{ fontSize: 11, color: "#999" }}>{meta.label}</div>
                    </div>
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#666", cursor: "pointer", flexShrink: 0 }}>
                    <input type="checkbox" checked={task.enabled} onChange={(e) => toggleTaskEnabled(task, e.target.checked)} />
                    {task.enabled ? "开启" : "关闭"}
                  </label>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ background: "#eef0ff", color: "#5a67d8", borderRadius: 6, padding: "2px 8px", fontWeight: 600 }}>
                    🕐 {task.time}
                  </span>
                  {task.type === "recording" && task.extra.onNewSession === true && (
                    <span style={{ background: "#fef3e2", color: "#b7791f", borderRadius: 6, padding: "2px 8px", fontSize: 11 }}>
                      会话前自动总结
                    </span>
                  )}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
                  <span style={{ color: "#888" }}>已分配：</span>
                  {assigned.length === 0 ? (
                    <span style={{ color: "#aaa" }}>（未分配）</span>
                  ) : (
                    assigned.map((a) => (
                      <span key={a.childId} style={{ background: "#f0f4ff", color: "#4a6da7", borderRadius: 10, padding: "1px 8px" }}>
                        {childName(a.childId)}
                      </span>
                    ))
                  )}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <span style={{ color: "#888" }}>最近执行：</span>
                  {last ? (
                    <span style={{ color: st?.color ?? "#666", fontWeight: 500 }}>
                      {st?.label ?? last.status} · {last.date} {last.point}
                      {last.message ? `（${last.message.slice(0, 40)}${last.message.length > 40 ? "…" : ""}）` : ""}
                    </span>
                  ) : (
                    <span style={{ color: "#aaa" }}>暂无记录</span>
                  )}
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                  <button
                    onClick={() => setAssignFor(task)}
                    style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", background: "#eef0ff", color: "#5a67d8", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer" }}
                  >
                    <Users size={13} /> 分配孩子
                  </button>
                  <button
                    onClick={() => deleteTask(task)}
                    style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", background: "#fdf6f6", color: "#b33", border: "none", borderRadius: 6, fontSize: 12, cursor: "pointer" }}
                  >
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 分配弹窗 */}
      {assignFor && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
          onClick={() => setAssignFor(null)}
        >
          <div
            style={{ background: "#fff", borderRadius: 12, padding: 20, width: 420, maxWidth: "92vw", maxHeight: "80vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>分配任务「{assignFor.name}」</div>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 12 }}>
              勾选 = 该孩子执行此任务；取消勾选 = 不再执行（不影响其他孩子）。
            </div>
            {children.length === 0 ? (
              <div style={{ color: "#999", fontSize: 13 }}>还没有孩子账号。</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {children.map((c) => {
                  const a = assignFor.assignments.find((x) => x.childId === c.childId);
                  const checked = a?.enabled ?? false;
                  return (
                    <label key={c.childId} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggleAssign(c.childId, e.target.checked)}
                      />
                      <span>{c.avatar ?? "👧"}</span> {c.name}
                    </label>
                  );
                })}
              </div>
            )}
            <div style={{ marginTop: 16, textAlign: "right" }}>
              <button
                onClick={() => setAssignFor(null)}
                style={{ padding: "8px 16px", background: "#667eea", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, cursor: "pointer" }}
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 执行结果 */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>📊 执行结果（最近 {runs.length} 次）</div>
          <IconButton
            icon={RefreshCw}
            title="刷新结果"
            onClick={() => window.api.schedulerRunsList({ limit: 30 }).then((r: any) => r?.success && setRuns(r.runs ?? []))}
            style={{ padding: "4px 8px", border: "1px solid #ddd", borderRadius: 6, background: "#fff", fontSize: 12, cursor: "pointer" }}
          />
        </div>
        {runs.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "#999", fontSize: 13, border: "1px dashed #ddd", borderRadius: 10 }}>
            还没有执行记录（任务到点执行后这里会显示结果）。
          </div>
        ) : (
          <div style={{ border: "1px solid #eee", borderRadius: 10, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#fafbff", color: "#666", textAlign: "left" }}>
                  <th style={{ padding: "8px 10px" }}>日期</th>
                  <th style={{ padding: "8px 10px" }}>时间点</th>
                  <th style={{ padding: "8px 10px" }}>孩子</th>
                  <th style={{ padding: "8px 10px" }}>任务</th>
                  <th style={{ padding: "8px 10px" }}>状态</th>
                  <th style={{ padding: "8px 10px" }}>信息</th>
                  <th style={{ padding: "8px 10px" }}>完成时间</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const st = RUN_STATUS[r.status] ?? { label: r.status, color: "#666" };
                  return (
                    <tr key={r.id} style={{ borderTop: "1px solid #f0f0f0" }}>
                      <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>{r.date}</td>
                      <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>{r.point}</td>
                      <td style={{ padding: "7px 10px" }}>{childName(r.childId)}</td>
                      <td style={{ padding: "7px 10px" }}>{r.taskName}</td>
                      <td style={{ padding: "7px 10px", color: st.color, fontWeight: 600, whiteSpace: "nowrap" }}>{st.label}</td>
                      <td style={{ padding: "7px 10px", color: "#888", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.message}>
                        {r.message || "-"}
                      </td>
                      <td style={{ padding: "7px 10px", whiteSpace: "nowrap", color: "#999" }}>{fmt(r.finishedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
