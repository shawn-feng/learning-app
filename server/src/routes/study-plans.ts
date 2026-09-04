/**
 * 学习计划（ISSUE-033 重构 v2，2026-09-04）路由：家长对话制定 → 「每天学什么」排期（服务端数据真源）。
 * 每行 = 一门课的排期（一课一行，不再 content JSON 塞多课）：
 *   date=执行日期 · topic_key · course_name(真实课程名, 不带「复习：」前缀) · mode(new|review)
 *   status(pending|done|carried) · done_at —— 由 worker stat 在孩子当天实际学/复习完对应课程后写入。
 * 家长面板的完成态 = 服务端直接读 status/done_at 下发（不再靠客户端剥文本前缀现算）。
 * - GET    /api/v1/study-plans?childId=&date=&from=&to=  排期行列表（一课一行，date 倒序）
 * - GET    /api/v1/study-plans/today?childId=&date=       当日聚合（gen 据此生成家长 todolist；含 carry 标记）
 * - POST   /api/v1/study-plans                           创建（家长 agent study_plan_create 落库点）
 * - PATCH  /api/v1/study-plans/:id                        更新单行（改 date/停用/标记）
 * - DELETE /api/v1/study-plans/:id                        删除单行
 * 鉴权：家长 JWT；childId 归属校验；行归属按 parent_id。
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { openKb } from "../db/kb.js";

interface StudyPlanDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

interface PlanItemInput {
  topicKey?: string;
  courseName?: string;
  mode?: string;
}

export interface StudyPlanRowDto {
  id: string;
  childId: string;
  date: string;
  topicKey: string;
  courseName: string;
  mode: string;
  origin: string;
  status: string;
  doneAt: string;
  done: boolean; // 服务端按 child kb 课程当天活动判定（new 看 first_learned / review 看 last_review == date）
  active: number;
  updatedAt: string;
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

function validDate(d: unknown): d is string {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

/** 校验并规范化排期输入数组：[{topicKey?, courseName 必填, mode?}]，上限 100 防滥用。 */
function parseItems(raw: unknown): PlanItemInput[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) return null;
  const items: PlanItemInput[] = [];
  for (const it of raw) {
    if (typeof it !== "object" || it === null) return null;
    const { topicKey, courseName, mode } = it as { topicKey?: unknown; courseName?: unknown; mode?: unknown };
    if (typeof courseName !== "string" || !courseName.trim()) return null;
    const m = typeof mode === "string" ? mode.trim().toLowerCase() : "";
    if (m && m !== "new" && m !== "review") return null;
    items.push({
      topicKey: typeof topicKey === "string" && topicKey.trim() ? topicKey.trim() : "",
      courseName: courseName.trim(),
      mode: m === "review" ? "review" : "new",
    });
  }
  return items;
}

interface PlanRow {
  id: string;
  child_id: string;
  date: string;
  topic_key: string;
  course_name: string;
  mode: string;
  origin: string;
  status: string;
  done_at: string;
  active: number;
  updated_at: string;
}

function fetchRow(db: DatabaseSync, parentId: string, id: string): PlanRow | undefined {
  return db.prepare("SELECT * FROM study_plan_items WHERE id = ? AND parent_id = ?").get(id, parentId) as
    | PlanRow
    | undefined;
}

/**
 * 服务端计算每行完成态：读孩子 kb 该课当天活动。
 * mode=new → courses.first_learned == date；mode=review → courses.last_review == date。
 * 找不到对应课程 → done=false（排了但课程表没有，视为未完成）。
 */
function loadCourseDoneMap(
  dataDir: string,
  parentId: string,
  childId: string,
  date: string
): Map<string, boolean> {
  const key = (topicKey: string, courseName: string) => `${topicKey}\u0000${courseName}\u0000${date}`;
  const out = new Map<string, boolean>();
  try {
    const db = openKb(dataDir, parentId, childId);
    try {
      const rows = db
        .prepare("SELECT topic, title, first_learned, last_review FROM courses")
        .all() as Array<{ topic: string; title: string; first_learned: string; last_review: string }>;
      for (const c of rows) {
        const title = (c.title || "").trim();
        if (!title) continue;
        // 只记录「今天有活动」的课；调用方按 (topic,title) 查。
        const learned = (c.first_learned || "").trim() === date;
        const reviewed = (c.last_review || "").trim() === date;
        if (learned || reviewed) out.set(key((c.topic || "").trim(), title), true);
      }
    } finally {
      db.close();
    }
  } catch {
    // 读不到课程表则不判定（保持未完成）
  }
  return out;
}

function toDto(r: PlanRow, doneMap: Map<string, boolean>): StudyPlanRowDto {
  const done = doneMap.has(`${r.topic_key}\u0000${r.course_name}\u0000${r.date}`);
  return {
    id: r.id,
    childId: r.child_id,
    date: r.date,
    topicKey: r.topic_key,
    courseName: r.course_name,
    mode: r.mode,
    origin: r.origin,
    status: r.status,
    doneAt: r.done_at,
    done,
    active: r.active,
    updatedAt: r.updated_at,
  };
}

export function registerStudyPlanRoutes(app: FastifyInstance, deps: StudyPlanDeps): void {
  // 列表（家长回显 / 只读面板）。可 date 精确、from/to 段过滤。
  app.get("/api/v1/study-plans", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId, date, from, to } = (req.query ?? {}) as {
      childId?: string;
      date?: string;
      from?: string;
      to?: string;
    };
    if (!childId) return reply.code(400).send({ error: "childId 必填" });
    for (const d of [date, from, to]) {
      if (d !== undefined && !validDate(d)) return reply.code(400).send({ error: "date 格式应为 YYYY-MM-DD" });
    }
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    let rows: PlanRow[] = deps.db
      .prepare(
        "SELECT * FROM study_plan_items WHERE parent_id = ? AND child_id = ? AND active = 1 ORDER BY date DESC, created_at ASC LIMIT 2000"
      )
      .all(parentId, childId) as unknown as PlanRow[];
    if (date) rows = rows.filter((r) => r.date === date);
    if (from) rows = rows.filter((r) => r.date >= from!);
    if (to) rows = rows.filter((r) => r.date <= to!);
    // 完成态按行各自的 date 判定（每行可能不同天）
    const byDate = new Map<string, Map<string, boolean>>();
    for (const r of rows) {
      if (!byDate.has(r.date)) byDate.set(r.date, loadCourseDoneMap(deps.config.dataDir ?? "", parentId, childId, r.date));
    }
    const out = rows.map((r) => toDto(r, byDate.get(r.date) ?? new Map()));
    return { ok: true, rows: out };
  });

  // 当日聚合（gen 据此生成家长 todolist / 查看某天）。每课一行；status 直接下发完成态。
  app.get("/api/v1/study-plans/today", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId, date } = (req.query ?? {}) as { childId?: string; date?: string };
    if (!childId) return reply.code(400).send({ error: "childId 必填" });
    const day = date ?? new Date().toISOString().slice(0, 10);
    if (!validDate(day)) return reply.code(400).send({ error: "date 格式应为 YYYY-MM-DD" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const rows = deps.db
      .prepare(
        "SELECT * FROM study_plan_items WHERE parent_id = ? AND child_id = ? AND active = 1 AND date = ? ORDER BY created_at ASC"
      )
      .all(parentId, childId, day) as unknown as PlanRow[];
    const doneMap = loadCourseDoneMap(deps.config.dataDir ?? "", parentId, childId, day);
    const items = rows.map((r) => ({
      planId: r.id,
      topicKey: r.topic_key,
      courseName: r.course_name,
      text: r.course_name, // 兼容旧「一项文本」直觉：todolist 标题用课程名
      mode: r.mode,
      carry: r.origin === "carry",
      status: r.status,
      doneAt: r.done_at,
      done: doneMap.has(`${r.topic_key}\u0000${r.course_name}\u0000${day}`),
    }));
    return { ok: true, date: day, items };
  });

  // 创建（家长 agent study_plan_create）。body: { childId, date, items: [{topicKey?, courseName, mode?}] }
  // 幂等合并（同日同课程已存在则跳过；模式不同则升级为 review 标注）。
  app.post("/api/v1/study-plans", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId, date, items } = (req.body ?? {}) as {
      childId?: string;
      date?: string;
      items?: unknown;
    };
    if (!childId) return reply.code(400).send({ error: "childId 必填" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const day = date ?? new Date().toISOString().slice(0, 10);
    if (!validDate(day)) return reply.code(400).send({ error: "date 格式应为 YYYY-MM-DD" });
    const parsed = parseItems(items);
    if (!parsed) return reply.code(400).send({ error: "items 应为 [{courseName, mode?}] 数组（≤100 项）" });

    const existing = deps.db
      .prepare(
        "SELECT topic_key, course_name, mode FROM study_plan_items WHERE parent_id = ? AND child_id = ? AND active = 1 AND date = ?"
      )
      .all(parentId, childId, day) as unknown as Array<{ topic_key: string; course_name: string; mode: string }>;
    const have = new Set(existing.map((r) => `${r.topic_key}\u0000${r.course_name}\u0000${r.mode}`));
    const inserted: string[] = [];
    const skipped: string[] = [];
    for (const it of parsed) {
      const k = `${it.topicKey}\u0000${it.courseName}\u0000${it.mode}`;
      if (have.has(k)) {
        skipped.push(`${it.courseName}（${it.mode}）`);
        continue;
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const topicKey = it.topicKey ?? "";
      const courseName = it.courseName ?? "";
      const mode = it.mode ?? "new";
      deps.db
        .prepare(
          "INSERT INTO study_plan_items (id, parent_id, child_id, date, topic_key, course_name, mode, origin, status, done_at, active, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'conversation', 'pending', '', 1, ?, ?)"
        )
        .run(id, parentId, childId, day, topicKey, courseName, mode, now, now);
      have.add(k);
      inserted.push(`${it.courseName}（${it.mode === "review" ? "复习" : "新学"}）`);
    }
    return { ok: true, inserted, skipped, date: day };
  });

  // 更新单行（家长 agent study_plan_update：改 date / 改 mode / 停用）
  app.patch("/api/v1/study-plans/:id", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { id } = req.params as { id: string };
    const cur = fetchRow(deps.db, parentId, id);
    if (!cur) return reply.code(403).send({ error: "无权访问该排期行" });
    const { date, mode, active } = (req.body ?? {}) as {
      date?: string;
      mode?: string;
      active?: boolean;
    };
    const sets: string[] = [];
    const vals: Array<string | number> = [];
    if (date !== undefined) {
      if (!validDate(date)) return reply.code(400).send({ error: "date 格式应为 YYYY-MM-DD" });
      sets.push("date = ?");
      vals.push(date);
    }
    if (mode !== undefined) {
      const m = String(mode).trim().toLowerCase();
      if (m !== "new" && m !== "review") return reply.code(400).send({ error: "mode 仅支持 new / review" });
      sets.push("mode = ?");
      vals.push(m);
    }
    if (active !== undefined) {
      sets.push("active = ?");
      vals.push(active ? 1 : 0);
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      vals.push(new Date().toISOString());
      deps.db
        .prepare(`UPDATE study_plan_items SET ${sets.join(", ")} WHERE id = ?`)
        .run(...vals, id);
    }
    return { ok: true };
  });

  // 删除单行（家长 agent「把某天/某课删了」）
  app.delete("/api/v1/study-plans/:id", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { id } = req.params as { id: string };
    const cur = fetchRow(deps.db, parentId, id);
    if (!cur) return reply.code(403).send({ error: "无权访问该排期行" });
    deps.db.prepare("DELETE FROM study_plan_items WHERE id = ?").run(id);
    return { ok: true };
  });
}
