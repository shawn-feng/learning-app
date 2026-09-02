/**
 * 定时任务管理（新模型）数据访问：任务定义 / 孩子分配 / 执行结果（task_runs）。
 * 语义：先创建任务（scheduler_tasks）→ 再分配给孩子（scheduler_task_assignments）→
 * 执行由 worker（recording/todo）与客户端（auto_new_session）进行，每次执行写 task_runs。
 * effective-config = 任务+分配 → 每孩子有效配置（recording/todo/autoNewSession），
 * 客户端据此合并 classTimes/archiveLimit 推回 scheduler_config，执行链路不变。
 */
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type SchedulerTaskType = "recording" | "todo_gen" | "todo_stat" | "auto_new_session";

export const SCHEDULER_TASK_TYPES: SchedulerTaskType[] = [
  "recording",
  "todo_gen",
  "todo_stat",
  "auto_new_session",
];

export interface SchedulerTaskRow {
  id: string;
  parent_id: string;
  name: string;
  type: SchedulerTaskType;
  time: string;
  extra_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface EffectiveChildConfig {
  recording: { enabled: boolean; times: string[]; onNewSession: boolean };
  todo: { enabled: boolean; genTime: string; statTime: string };
  autoNewSession: { enabled: boolean; hour: number; minute: number };
}

/** 记录一次执行结果。 */
export function recordTaskRun(
  db: DatabaseSync,
  row: {
    parentId: string;
    childId: string;
    taskId: string | null;
    taskName: string;
    taskType: string;
    date: string;
    point: string;
    status: "ok" | "skip" | "error";
    message: string;
    startedAt: string;
    finishedAt: string;
  }
): void {
  db.prepare(
    `INSERT INTO task_runs (id, parent_id, child_id, task_id, task_name, task_type, date, point, status, message, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    row.parentId,
    row.childId,
    row.taskId,
    row.taskName,
    row.taskType,
    row.date,
    row.point,
    row.status,
    row.message,
    row.startedAt,
    row.finishedAt
  );
}

/** 按「任务类型 + 时间点 + 孩子分配」匹配任务（worker 执行时挂接 task_id/名称用）。 */
export function findTaskForRun(
  db: DatabaseSync,
  parentId: string,
  childId: string,
  type: string,
  point: string
): { id: string; name: string } | null {
  const row = db
    .prepare(
      `SELECT t.id, t.name FROM scheduler_tasks t
       JOIN scheduler_task_assignments a ON a.task_id = t.id
       WHERE t.parent_id = ? AND t.type = ? AND t.time = ? AND t.enabled = 1
         AND a.child_id = ? AND a.enabled = 1
       ORDER BY t.created_at LIMIT 1`
    )
    .get(parentId, type, point, childId) as { id: string; name: string } | undefined;
  return row ?? null;
}

export interface TaskWithAssignments {
  id: string;
  name: string;
  type: SchedulerTaskType;
  time: string;
  extra: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  assignments: Array<{ childId: string; enabled: boolean }>;
  /** 最近一次执行结果（task_runs 按任务最近一条，无则 null） */
  lastRun: { date: string; point: string; status: string; message: string; finishedAt: string } | null;
}

/** 家长的全部任务（含分配 + 最近执行结果）。 */
export function listTasksWithAssignments(db: DatabaseSync, parentId: string): TaskWithAssignments[] {
  const tasks = db
    .prepare("SELECT * FROM scheduler_tasks WHERE parent_id = ? ORDER BY created_at")
    .all(parentId) as unknown as SchedulerTaskRow[];
  const out: TaskWithAssignments[] = [];
  for (const t of tasks) {
    const assigns = db
      .prepare("SELECT child_id, enabled FROM scheduler_task_assignments WHERE task_id = ?")
      .all(t.id) as Array<{ child_id: string; enabled: number }>;
    const lastRun = db
      .prepare(
        "SELECT date, point, status, message, finished_at FROM task_runs WHERE task_id = ? ORDER BY finished_at DESC LIMIT 1"
      )
      .get(t.id) as { date: string; point: string; status: string; message: string; finished_at: string } | undefined;
    let extra: Record<string, unknown> = {};
    try {
      extra = JSON.parse(t.extra_json || "{}");
    } catch {
      extra = {};
    }
    out.push({
      id: t.id,
      name: t.name,
      type: t.type,
      time: t.time,
      extra,
      enabled: t.enabled === 1,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      assignments: assigns.map((a) => ({ childId: a.child_id, enabled: a.enabled === 1 })),
      lastRun: lastRun
        ? {
            date: lastRun.date,
            point: lastRun.point,
            status: lastRun.status,
            message: lastRun.message,
            finishedAt: lastRun.finished_at,
          }
        : null,
    });
  }
  return out;
}

/**
 * 任务+分配 → 每孩子有效配置（recording / todo / autoNewSession）。
 * 未分配任何任务的孩子的对应功能 = 关闭；仅分配部分类型时其余保持关闭。
 */
export function buildEffectiveChildConfig(
  db: DatabaseSync,
  parentId: string
): Record<string, EffectiveChildConfig> {
  const children = db
    .prepare("SELECT id FROM children WHERE parent_id = ?")
    .all(parentId) as Array<{ id: string }>;
  const tasks = db
    .prepare("SELECT * FROM scheduler_tasks WHERE parent_id = ? AND enabled = 1 ORDER BY created_at")
    .all(parentId) as unknown as SchedulerTaskRow[];
  const assigns = db
    .prepare(
      `SELECT a.task_id, a.child_id FROM scheduler_task_assignments a
       JOIN scheduler_tasks t ON t.id = a.task_id
       WHERE t.parent_id = ? AND a.enabled = 1`
    )
    .all(parentId) as Array<{ task_id: string; child_id: string }>;

  const byChild = new Map<string, SchedulerTaskRow[]>();
  for (const a of assigns) {
    const task = tasks.find((t) => t.id === a.task_id);
    if (!task) continue;
    const arr = byChild.get(a.child_id) ?? [];
    arr.push(task);
    byChild.set(a.child_id, arr);
  }

  const empty: EffectiveChildConfig = {
    recording: { enabled: false, times: [], onNewSession: false },
    todo: { enabled: false, genTime: "", statTime: "" },
    autoNewSession: { enabled: false, hour: 21, minute: 0 },
  };

  const result: Record<string, EffectiveChildConfig> = {};
  for (const c of children) {
    const tasksFor = byChild.get(c.id) ?? [];
    const cfg: EffectiveChildConfig = JSON.parse(JSON.stringify(empty));
    const recording = tasksFor.filter((t) => t.type === "recording");
    if (recording.length > 0) {
      cfg.recording.enabled = true;
      cfg.recording.times = recording.map((t) => t.time).sort();
      cfg.recording.onNewSession = recording.some((t) => {
        try {
          return (JSON.parse(t.extra_json || "{}") as { onNewSession?: boolean }).onNewSession === true;
        } catch {
          return false;
        }
      });
    }
    const gen = tasksFor.find((t) => t.type === "todo_gen");
    const stat = tasksFor.find((t) => t.type === "todo_stat");
    if (gen || stat) {
      cfg.todo.enabled = true;
      cfg.todo.genTime = gen ? gen.time : "";
      cfg.todo.statTime = stat ? stat.time : "";
    }
    const auto = tasksFor.find((t) => t.type === "auto_new_session");
    if (auto) {
      const [h, m] = auto.time.split(":").map(Number);
      cfg.autoNewSession.enabled = true;
      cfg.autoNewSession.hour = Number.isFinite(h) ? h : 21;
      cfg.autoNewSession.minute = Number.isFinite(m) ? m : 0;
    }
    result[c.id] = cfg;
  }
  return result;
}

/** 最近执行结果（家长维度；可按孩子过滤；limit 上限 100）。 */
export function listTaskRuns(
  db: DatabaseSync,
  parentId: string,
  opts: { childId?: string; limit?: number } = {}
): Array<{
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
}> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
  const childId = opts.childId ?? "";
  const rows = childId
    ? db
        .prepare(
          "SELECT * FROM task_runs WHERE parent_id = ? AND child_id = ? ORDER BY finished_at DESC LIMIT ?"
        )
        .all(parentId, childId, limit)
    : db
        .prepare("SELECT * FROM task_runs WHERE parent_id = ? ORDER BY finished_at DESC LIMIT ?")
        .all(parentId, limit);
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    childId: String(r.child_id),
    taskId: r.task_id ? String(r.task_id) : null,
    taskName: String(r.task_name),
    taskType: String(r.task_type),
    date: String(r.date),
    point: String(r.point),
    status: String(r.status),
    message: String(r.message),
    startedAt: String(r.started_at),
    finishedAt: String(r.finished_at),
  }));
}
