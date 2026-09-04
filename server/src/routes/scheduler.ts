/**
 * 定时任务管理（新模型）路由：
 * - GET  /api/v1/scheduler/tasks                 任务列表（含分配 + 最近执行结果）
 * - POST /api/v1/scheduler/tasks                 创建任务（先创建）
 * - PATCH/DELETE /api/v1/scheduler/tasks/:id     更新/删除任务
 * - POST /api/v1/scheduler/tasks/:id/assign      分配给孩子（再分配；enabled=false 取消分配）
 * - GET  /api/v1/scheduler/runs                  执行结果查询
 * - GET  /api/v1/scheduler/effective-config      任务+分配 → 每孩子有效配置（客户端合并推 scheduler_config）
 * 鉴权：家长 JWT；assign 的 childId 必须归属该家长。
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import {
  SCHEDULER_TASK_TYPES,
  buildEffectiveChildConfig,
  listTaskRuns,
  listTasksWithAssignments,
  createReminderTask,
  listChildReminders,
  takeDueReminders,
  type SchedulerTaskType,
  type ReminderFrequency,
  type ReminderOwner,
} from "../db/task-runs.js";

interface SchedulerDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

function authParent(req: { headers: Record<string, string | string[] | undefined> }, secret: string): string {
  const header = req.headers.authorization;
  const token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) throw new ApiError(401, "缺少 session token");
  try {
    return verifySession(token, secret).parent_id;
  } catch {
    throw new ApiError(401, "session 无效或已过期，请重新登录");
  }
}

function assertChildOwned(db: DatabaseSync, parentId: string, childId: string): void {
  const row = db.prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?").get(childId, parentId);
  if (!row) throw new ApiError(403, "无权访问该孩子的数据");
}

function handleAuthError(err: unknown, reply: any): boolean {
  if (err instanceof ApiError) {
    reply.code(err.status).send({ error: err.message });
    return true;
  }
  return false;
}

function validTime(t: unknown): t is string {
  return typeof t === "string" && /^\d{2}:\d{2}$/.test(t);
}

export function registerSchedulerRoutes(app: FastifyInstance, deps: SchedulerDeps): void {
  app.get("/api/v1/scheduler/tasks", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    return { tasks: listTasksWithAssignments(deps.db, parentId) };
  });

  app.post("/api/v1/scheduler/tasks", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { name, type, time, extra } = (req.body ?? {}) as {
      name?: string;
      type?: string;
      time?: string;
      extra?: Record<string, unknown>;
    };
    if (!name?.trim()) return reply.code(400).send({ error: "任务名称必填" });
    if (!type || !(SCHEDULER_TASK_TYPES as string[]).includes(type)) {
      return reply.code(400).send({ error: `type 仅支持: ${SCHEDULER_TASK_TYPES.join(" / ")}` });
    }
    // reminder 类任务走专用 /reminders 接口（需关联孩子 + 频率/语音字段），不走通用任务创建
    if (type === "reminder") {
      return reply.code(400).send({ error: "reminder 类型请使用 POST /api/v1/scheduler/reminders" });
    }
    if (!validTime(time)) return reply.code(400).send({ error: "time 必填（HH:mm）" });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    deps.db
      .prepare(
        "INSERT INTO scheduler_tasks (id, parent_id, name, type, time, extra_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)"
      )
      .run(id, parentId, name.trim(), type, time, JSON.stringify(extra ?? {}), now, now);
    return { ok: true, task: listTasksWithAssignments(deps.db, parentId).find((t) => t.id === id) };
  });

  app.patch("/api/v1/scheduler/tasks/:id", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { id } = req.params as { id: string };
    const row = deps.db
      .prepare("SELECT 1 FROM scheduler_tasks WHERE id = ? AND parent_id = ?")
      .get(id, parentId);
    if (!row) return reply.code(403).send({ error: "无权访问该任务" });
    const { name, time, enabled, extra } = (req.body ?? {}) as {
      name?: string;
      time?: string;
      enabled?: boolean;
      extra?: Record<string, unknown>;
    };
    if (name !== undefined && !String(name).trim()) return reply.code(400).send({ error: "任务名称不能为空" });
    if (time !== undefined && !validTime(time)) return reply.code(400).send({ error: "time 格式应为 HH:mm" });
    const cur = deps.db.prepare("SELECT * FROM scheduler_tasks WHERE id = ?").get(id) as {
      name: string;
      time: string;
      extra_json: string;
      enabled: number;
    };
    const nextName = name !== undefined ? String(name).trim() : cur.name;
    const nextTime = time !== undefined ? (time as string) : cur.time;
    const nextEnabled = enabled !== undefined ? (enabled ? 1 : 0) : cur.enabled;
    let nextExtra = cur.extra_json;
    if (extra !== undefined) nextExtra = JSON.stringify(extra);
    deps.db
      .prepare(
        "UPDATE scheduler_tasks SET name = ?, time = ?, extra_json = ?, enabled = ?, updated_at = ? WHERE id = ?"
      )
      .run(nextName, nextTime, nextExtra, nextEnabled, new Date().toISOString(), id);
    return { ok: true };
  });

  app.delete("/api/v1/scheduler/tasks/:id", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { id } = req.params as { id: string };
    const row = deps.db
      .prepare("SELECT 1 FROM scheduler_tasks WHERE id = ? AND parent_id = ?")
      .get(id, parentId);
    if (!row) return reply.code(403).send({ error: "无权访问该任务" });
    // 删任务保留历史执行结果（task_id 置空防悬挂）；分配一并删除
    deps.db.prepare("DELETE FROM scheduler_task_assignments WHERE task_id = ?").run(id);
    deps.db.prepare("UPDATE task_runs SET task_id = NULL WHERE task_id = ?").run(id);
    deps.db.prepare("DELETE FROM scheduler_tasks WHERE id = ?").run(id);
    return { ok: true };
  });

  // 分配给孩子（upsert；enabled=false = 取消分配）
  app.post("/api/v1/scheduler/tasks/:id/assign", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { id } = req.params as { id: string };
    const row = deps.db
      .prepare("SELECT 1 FROM scheduler_tasks WHERE id = ? AND parent_id = ?")
      .get(id, parentId);
    if (!row) return reply.code(403).send({ error: "无权访问该任务" });
    const { childId, enabled } = (req.body ?? {}) as { childId?: string; enabled?: boolean };
    if (!childId) return reply.code(400).send({ error: "childId 必填" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    deps.db
      .prepare(
        "INSERT INTO scheduler_task_assignments (task_id, child_id, enabled, created_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(task_id, child_id) DO UPDATE SET enabled = excluded.enabled"
      )
      .run(id, childId, enabled === false ? 0 : 1, new Date().toISOString());
    return { ok: true };
  });

  // 执行结果查询（可按孩子过滤；倒序）
  app.get("/api/v1/scheduler/runs", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId, limit } = req.query as { childId?: string; limit?: string };
    if (childId) {
      try {
        assertChildOwned(deps.db, parentId, childId);
      } catch (err) {
        if (handleAuthError(err, reply)) return;
        throw err;
      }
    }
    return {
      runs: listTaskRuns(deps.db, parentId, {
        childId: childId || undefined,
        limit: Number(limit) || undefined,
      }),
    };
  });

  // 有效配置：任务+分配 → 每孩子 recording/todo/autoNewSession（客户端合并推 scheduler_config）
  app.get("/api/v1/scheduler/effective-config", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    return { children: buildEffectiveChildConfig(deps.db, parentId) };
  });

  // —— ISSUE-047：孩子端 agent 自建定时提醒（语音 + 频率）——
  // 创建提醒：关联孩子 + 频率/语音字段；owner 默认 child（agent 创建）。家长也可带 owner=parent。
  app.post("/api/v1/scheduler/reminders", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const b = (req.body ?? {}) as {
      childId?: string;
      name?: string;
      text?: string;
      time?: string;
      frequency?: string;
      weekday?: number;
      intervalMinutes?: number;
      voice?: boolean;
      fireAt?: string;
      owner?: string;
    };
    if (!b.childId) return reply.code(400).send({ error: "childId 必填" });
    try {
      assertChildOwned(deps.db, parentId, b.childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    if (!b.name?.trim()) return reply.code(400).send({ error: "提醒名称必填" });
    if (!b.text?.trim()) return reply.code(400).send({ error: "提醒内容(text)必填" });
    if (!validTime(b.time)) return reply.code(400).send({ error: "time 必填（HH:mm）" });
    const freqs: ReminderFrequency[] = ["once", "daily", "weekly", "interval"];
    const frequency = (b.frequency as ReminderFrequency) || "daily";
    if (!freqs.includes(frequency)) return reply.code(400).send({ error: `frequency 仅支持: ${freqs.join(" / ")}` });
    if (frequency === "weekly" && (b.weekday == null || b.weekday < 0 || b.weekday > 6)) {
      return reply.code(400).send({ error: "weekly 需提供 weekday（0=周日..6=周六）" });
    }
    if (frequency === "interval" && !(b.intervalMinutes && b.intervalMinutes > 0)) {
      return reply.code(400).send({ error: "interval 需提供 intervalMinutes(>0)" });
    }
    if (frequency === "once" && !b.fireAt) {
      return reply.code(400).send({ error: "once 需提供 fireAt(ISO 目标时间)" });
    }
    const id = createReminderTask(deps.db, {
      parentId,
      childId: b.childId,
      name: b.name.trim(),
      text: b.text.trim(),
      time: b.time,
      frequency,
      weekday: b.weekday ?? null,
      intervalMinutes: b.intervalMinutes ?? null,
      voice: b.voice !== false,
      fireAt: b.fireAt ?? null,
      owner: (b.owner as ReminderOwner) ?? "child",
    });
    return { ok: true, id };
  });

  // 到期提醒拉取（客户端每分钟轮询）：返回该孩子当前到期且尚未播报的提醒，并就地标记已触发（幂等）。
  app.get("/api/v1/scheduler/reminders", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.query as { childId?: string };
    if (!childId) return reply.code(400).send({ error: "childId 必填" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const due = takeDueReminders(deps.db, parentId, childId);
    return { reminders: due };
  });

  // 某孩子的全部提醒（agent 列举 / 家长可见用）
  app.get("/api/v1/scheduler/reminders/list", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.query as { childId?: string };
    if (!childId) return reply.code(400).send({ error: "childId 必填" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    return { reminders: listChildReminders(deps.db, parentId, childId) };
  });
}

export type { SchedulerTaskType };
