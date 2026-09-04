/**
 * 定时任务管理（新模型）数据访问：任务定义 / 孩子分配 / 执行结果（task_runs）。
 * 语义：先创建任务（scheduler_tasks）→ 再分配给孩子（scheduler_task_assignments）→
 * 执行由 worker（recording/todo）与客户端（auto_new_session）进行，每次执行写 task_runs。
 * effective-config = 任务+分配 → 每孩子有效配置（recording/todo/autoNewSession），
 * 客户端据此合并 classTimes/archiveLimit 推回 scheduler_config，执行链路不变。
 */
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type SchedulerTaskType = "recording" | "todo_gen" | "todo_stat" | "auto_new_session" | "reminder";

export const SCHEDULER_TASK_TYPES: SchedulerTaskType[] = [
  "recording",
  "todo_gen",
  "todo_stat",
  "auto_new_session",
  "reminder",
];

export interface SchedulerTaskRow {
  id: string;
  parent_id: string;
  name: string;
  type: SchedulerTaskType;
  time: string;
  extra_json: string;
  enabled: number;
  owner: string;
  frequency: string;
  reminder_text: string | null;
  weekday: number | null;
  interval_minutes: number | null;
  voice: number;
  fire_at: string | null;
  last_fired_at: string | null;
  expired: number;
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
  owner: "parent" | "child";
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
      owner: (t.owner as "parent" | "child") ?? "parent",
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

/* ------------------------------------------------------------------ *
 * ISSUE-047：孩子端 agent 自建定时提醒（到点语音播报 + 频率）。
 * 复用 scheduler_tasks（type='reminder'）+ scheduler_task_assignments，
 * 仅 owner='child' 区分归属；家长端 listTasksWithAssignments 天然可见。
 * ------------------------------------------------------------------ */

export type ReminderFrequency = "once" | "daily" | "weekly" | "interval";
export type ReminderOwner = "parent" | "child";

export interface ReminderInput {
  parentId: string;
  childId: string;
  name: string;
  text: string;
  time: string; // HH:mm
  frequency: ReminderFrequency;
  weekday?: number | null; // weekly: 0=周日..6=周六
  intervalMinutes?: number | null; // interval: 每隔 N 分钟
  voice?: boolean;
  fireAt?: string | null; // once: ISO 目标时间
  owner?: ReminderOwner;
}

export interface ReminderView {
  id: string;
  name: string;
  text: string;
  time: string;
  frequency: ReminderFrequency;
  weekday: number | null;
  intervalMinutes: number | null;
  voice: boolean;
  fireAt: string | null;
  owner: ReminderOwner;
  enabled: boolean;
  expired: boolean;
  createdAt: string;
}

/** 创建一条提醒任务：scheduler_tasks(type=reminder) + 分配给孩子（enabled=1）。返回 task id。 */
export function createReminderTask(db: DatabaseSync, input: ReminderInput): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // interval 类从「创建时刻」起算首次间隔，故 last_fired_at 置为 now（首次 fire = now + intervalMinutes）；
  // 其余类型（once/daily/weekly）置 NULL，由到期判定按目标时刻/日期触发。
  const initialLastFired = input.frequency === "interval" ? now : null;
  db.prepare(
    `INSERT INTO scheduler_tasks
       (id, parent_id, name, type, time, extra_json, enabled, owner, frequency, reminder_text,
        weekday, interval_minutes, voice, fire_at, last_fired_at, expired, created_at, updated_at)
     VALUES (?, ?, ?, 'reminder', ?, '{}', 1, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    id,
    input.parentId,
    input.name.trim(),
    input.time,
    input.owner ?? "child",
    input.frequency,
    input.text ?? "",
    input.weekday ?? null,
    input.intervalMinutes ?? null,
    input.voice === false ? 0 : 1,
    input.fireAt ?? null,
    initialLastFired,
    now,
    now
  );
  db.prepare(
    `INSERT INTO scheduler_task_assignments (task_id, child_id, enabled, created_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(task_id, child_id) DO UPDATE SET enabled = 1`
  ).run(id, input.childId, now);
  return id;
}

/** 某孩子的全部提醒任务（含已过期/禁用），用于 agent 列举与家长可见。 */
export function listChildReminders(db: DatabaseSync, parentId: string, childId: string): ReminderView[] {
  const rows = db
    .prepare(
      `SELECT t.* FROM scheduler_tasks t
       JOIN scheduler_task_assignments a ON a.task_id = t.id
       WHERE t.parent_id = ? AND t.type = 'reminder' AND a.child_id = ?
       ORDER BY t.created_at DESC`
    )
    .all(parentId, childId) as unknown as Array<Record<string, unknown>>;
  return rows.map(mapReminderRow);
}

/** 某家长家庭下的全部提醒（家长端任务管理页只读可见用）。 */
export function listFamilyReminders(db: DatabaseSync, parentId: string): ReminderView[] {
  const rows = db
    .prepare(
      `SELECT t.* FROM scheduler_tasks t
       WHERE t.parent_id = ? AND t.type = 'reminder'
       ORDER BY t.created_at DESC`
    )
    .all(parentId) as unknown as Array<Record<string, unknown>>;
  return rows.map(mapReminderRow);
}

function mapReminderRow(r: Record<string, unknown>): ReminderView {
  return {
    id: String(r.id),
    name: String(r.name),
    text: r.reminder_text == null ? "" : String(r.reminder_text),
    time: String(r.time),
    frequency: (r.frequency as ReminderFrequency) ?? "daily",
    weekday: r.weekday == null ? null : Number(r.weekday),
    intervalMinutes: r.interval_minutes == null ? null : Number(r.interval_minutes),
    voice: Number(r.voice ?? 1) === 1,
    fireAt: r.fire_at == null ? null : String(r.fire_at),
    owner: (r.owner as ReminderOwner) ?? "parent",
    enabled: Number(r.enabled ?? 1) === 1,
    expired: Number(r.expired ?? 0) === 1,
    createdAt: String(r.created_at),
  };
}

function hhmmNow(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 该提醒在 now 是否「到期应播报」（不含去重判定）。 */
function isReminderDue(row: Record<string, unknown>, now: Date): boolean {
  const freq = (row.frequency as ReminderFrequency) ?? "daily";
  const lastFired = row.last_fired_at == null ? null : new Date(String(row.last_fired_at));
  if (freq === "once") {
    if (Number(row.expired ?? 0) === 1) return false;
    const fa = row.fire_at == null ? null : new Date(String(row.fire_at));
    return fa != null && fa.getTime() <= now.getTime();
  }
  if (freq === "interval") {
    const iv = Number(row.interval_minutes ?? 0);
    if (!(iv > 0)) return false;
    if (lastFired == null) return true;
    return now.getTime() - lastFired.getTime() >= iv * 60_000;
  }
  // daily / weekly：今天尚未触发过 且 已过今日目标时刻
  const lastFiredDate = lastFired ? localDateStr(lastFired) : "";
  if (lastFiredDate === localDateStr(now)) return false;
  if (freq === "weekly") {
    const wd = Number(row.weekday ?? -1);
    if (wd < 0 || wd > 6) return false;
    if (now.getDay() !== wd) return false;
  }
  const target = String(row.time ?? "99:99");
  return hhmmNow(now) >= target;
}

export interface DueReminder {
  id: string;
  text: string;
  voice: boolean;
}

/**
 * 取该孩子「当前到期且尚未播报」的提醒，并就地标记已触发（last_fired_at / once→expired），
 * 避免同周期重复播报（客户端每分钟轮询幂等）。返回待语音播报的列表。
 */
export function takeDueReminders(db: DatabaseSync, parentId: string, childId: string, now: Date = new Date()): DueReminder[] {
  const rows = db
    .prepare(
      `SELECT t.* FROM scheduler_tasks t
       JOIN scheduler_task_assignments a ON a.task_id = t.id
       WHERE t.parent_id = ? AND t.type = 'reminder' AND t.enabled = 1 AND a.child_id = ? AND a.enabled = 1`
    )
    .all(parentId, childId) as unknown as Array<Record<string, unknown>>;
  const due: DueReminder[] = [];
  const ts = now.toISOString();
  for (const r of rows) {
    if (!isReminderDue(r, now)) continue;
    due.push({
      id: String(r.id),
      text: r.reminder_text == null ? "" : String(r.reminder_text),
      voice: Number(r.voice ?? 1) === 1,
    });
    if ((r.frequency as ReminderFrequency) === "once") {
      db.prepare("UPDATE scheduler_tasks SET expired = 1, last_fired_at = ?, updated_at = ? WHERE id = ?").run(
        ts,
        ts,
        String(r.id)
      );
    } else {
      db.prepare("UPDATE scheduler_tasks SET last_fired_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, String(r.id));
    }
  }
  return due;
}
