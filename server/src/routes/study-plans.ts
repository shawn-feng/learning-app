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
import { openParentLib } from "../db/parent-lib.js";

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

/**
 * 计划域重构（2026-09-10）：计划已迁入**孩子 kb** 的 study_plans。
 * 本路由读写的真源随之切换（原主库 study_plan_items 仅作历史归档）。
 */
interface SpRow {
  id: string;
  child_id: string;
  topic_key: string;
  course_uuid: string;
  course_name: string;
  mode: string;
  creator: string;
  origin: string;
  start_at: string;
  due_at: string;
  status: string;
  result: string;
  done_at: string;
  active: number;
  updated_at: string;
}

function openChildKb(dataDir: string, parentId: string, childId: string): DatabaseSync {
  return openKb(dataDir, parentId, childId);
}

function readStudyPlans(dataDir: string, parentId: string, childId: string): SpRow[] {
  const kb = openChildKb(dataDir, parentId, childId);
  try {
    return kb
      .prepare("SELECT * FROM study_plans ORDER BY start_at DESC, created_at ASC LIMIT 2000")
      .all() as unknown as SpRow[];
  } finally {
    kb.close();
  }
}

/** 在家长名下所有孩子里定位一条计划（PATCH/DELETE 用；孩子数少，遍历可接受）。 */
function findPlanAcrossChildren(
  dataDir: string,
  mainDb: DatabaseSync,
  parentId: string,
  id: string
): { childId: string; row: SpRow } | undefined {
  const kids = mainDb.prepare("SELECT id FROM children WHERE parent_id = ?").all(parentId) as Array<{ id: string }>;
  for (const k of kids) {
    const kb = openChildKb(dataDir, parentId, k.id);
    try {
      const row = kb.prepare("SELECT * FROM study_plans WHERE id = ?").get(id) as unknown as SpRow | undefined;
      if (row) return { childId: k.id, row };
    } finally {
      kb.close();
    }
  }
  return undefined;
}

function toPlanDto(r: SpRow): StudyPlanRowDto {
  return {
    id: r.id,
    childId: r.child_id,
    date: (r.start_at || "").slice(0, 10),
    topicKey: r.topic_key,
    courseName: r.course_name,
    mode: r.mode,
    origin: r.origin,
    status: r.status,
    doneAt: r.done_at,
    done: r.status === "done",
    active: r.active,
    updatedAt: r.updated_at,
  };
}

function fetchRow(db: DatabaseSync, parentId: string, id: string): PlanRow | undefined {
  return db.prepare("SELECT * FROM study_plan_items WHERE id = ? AND parent_id = ?").get(id, parentId) as
    | PlanRow
    | undefined;
}

/**
 * 读孩子库课程状态（学过没学过/首次/最近复习），供按行 mode 判完成（2026-09-04 语义，与 worker stat 同口径）：
 *  - mode=new → 课程标注学过（状态 ✅ 或有首次学习日期）即 done，**不限日期**（提前学也算）；
 *  - mode=review → courses.last_review == 该行日期 才 done（复习必须当天）。
 * 找不到对应课程 → done=false（排了但课程表没有，视为未完成）。
 *
 * key 用**课程名(title)**匹配（与 worker 的 courseByTitle 同口径）——计划行 topic_key 常为空
 * （家长 agent 排课时未填），若用 topic_key+course_name 复合 key 会查不到 → 面板误显示未完成。
 */
function loadCourseStates(
  dataDir: string,
  parentId: string,
  childId: string
): Map<string, { status: string; first_learned: string; last_review: string }> {
  const out = new Map<string, { status: string; first_learned: string; last_review: string }>();
  try {
    const db = openKb(dataDir, parentId, childId);
    try {
      const rows = db
        .prepare("SELECT topic, title, status, first_learned, last_review FROM courses")
        .all() as Array<{ topic: string; title: string; status: string; first_learned: string; last_review: string }>;
      for (const c of rows) {
        const title = (c.title || "").trim();
        if (!title) continue;
        if (!out.has(title)) {
          out.set(title, { status: c.status || "", first_learned: c.first_learned || "", last_review: c.last_review || "" });
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // 读不到课程表则不判定（保持未完成）
  }
  return out;
}

/** 以课程库为锚匹配计划行课程（与 worker 同口径）：找 title 是 course_name（最长）前缀的课程，
 * 兼容「××章（上）/（下）」等拆章排法——课程库整章 title 必命中。 */
function lookupState(
  states: Map<string, { status: string; first_learned: string; last_review: string }>,
  planCourseName: string
): { status: string; first_learned: string; last_review: string } | undefined {
  const name = (planCourseName || "").trim();
  if (!name) return undefined;
  let best: { status: string; first_learned: string; last_review: string } | undefined;
  let bestLen = -1;
  for (const [title, st] of states) {
    if (title && name.startsWith(title) && title.length > bestLen) {
      best = st;
      bestLen = title.length;
    }
  }
  return best;
}

/** 单行完成判定（与 worker stat 的 planCourseDone 同口径）。 */
function planRowDone(r: PlanRow, states: Map<string, { status: string; first_learned: string; last_review: string }>): boolean {
  const c = lookupState(states, r.course_name);
  if (!c) return false;
  if (r.mode === "review") return (c.last_review || "").trim() === r.date;
  return (c.status || "").trim() === "✅" || !!(c.first_learned || "").trim();
}

function toDto(
  r: PlanRow,
  states: Map<string, { status: string; first_learned: string; last_review: string }>
): StudyPlanRowDto {
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
    done: planRowDone(r, states),
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
    let rows = readStudyPlans(deps.config.dataDir ?? "", parentId, childId).filter((r) => r.active === 1);
    if (date) rows = rows.filter((r) => (r.start_at || "").slice(0, 10) === date);
    if (from) rows = rows.filter((r) => (r.start_at || "").slice(0, 10) >= from!);
    if (to) rows = rows.filter((r) => (r.start_at || "").slice(0, 10) <= to!);
    return { ok: true, rows: rows.map(toPlanDto) };
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
    // 计划域重构（2026-09-10）：todolist 不再落表——当日聚合 = 三张计划表里「窗口覆盖当天」的行。
    const kb = openChildKb(deps.config.dataDir ?? "", parentId, childId);
    let studyRows: SpRow[] = [];
    let lifeRows: Array<{ id: string; title: string; creator: string; origin: string; start_at: string; due_at: string; status: string; done_at: string }> = [];
    try {
      studyRows = kb
        .prepare(
          `SELECT * FROM study_plans WHERE active = 1 AND status != 'cancelled'
             AND (start_at = '' OR substr(start_at,1,10) <= ?) AND (due_at = '' OR substr(due_at,1,10) >= ?)
           ORDER BY created_at ASC`
        )
        .all(day, day) as unknown as SpRow[];
      lifeRows = kb
        .prepare(
          `SELECT id, title, creator, origin, start_at, due_at, status, done_at FROM life_plans
           WHERE active = 1 AND status != 'cancelled'
             AND (start_at = '' OR substr(start_at,1,10) <= ?) AND (due_at = '' OR substr(due_at,1,10) >= ?)
           ORDER BY due_at, created_at ASC`
        )
        .all(day, day) as unknown as typeof lifeRows;
    } finally {
      kb.close();
    }
    const items = [
      ...studyRows.map((r) => ({
        planId: r.id,
        topicKey: r.topic_key,
        courseName: r.course_name,
        text: r.course_name,
        mode: r.mode,
        owner: r.creator, // parent=必须完成项 / child=加分项
        carry: r.origin === "carry",
        status: r.status,
        doneAt: r.done_at,
        done: r.status === "done",
      })),
      ...lifeRows.map((r) => ({
        planId: r.id,
        topicKey: "",
        courseName: "",
        text: r.title,
        mode: "life",
        owner: r.creator,
        carry: r.origin === "carry",
        status: r.status,
        doneAt: r.done_at,
        done: r.status === "done",
      })),
    ];
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

    const existing = readStudyPlans(deps.config.dataDir ?? "", parentId, childId).filter(
      (r) => r.active === 1 && (r.start_at || "").slice(0, 10) === day
    );
    const have = new Set(existing.map((r) => `${r.topic_key}\u0000${r.course_name}\u0000${r.mode}`));
    // ISSUE-029 任务2：topic_key 自动反查——排课工具契约只传课程名（不传 topic），此前 topic_key
    // 恒存空串，英语课入口按钮（按 topic_key==='english' 判定）永远不显示。入库时按课程名在
    // 家长库 courses（(topic,title) 复合主键，title 基本唯一）反查补全；查不到留空（不影响
    // gen/stat 完成判定——那两处按 course_name 匹配）。
    const titleToTopic = new Map<string, string>();
    // 计划域 S1（2026-09-10）：同时反查课程 uuid（course_uuid = 计划行对课程的真引用，替代按名匹配）
    const titleToUuid = new Map<string, string>();
    try {
      const pdb = openParentLib(deps.config.dataDir, parentId);
      try {
        const crows = pdb.prepare("SELECT topic, title, uuid FROM courses").all() as Array<{
          topic: string;
          title: string;
          uuid: string | null;
        }>;
        for (const r of crows) {
          const t = (r.title || "").trim();
          if (t && !titleToTopic.has(t)) titleToTopic.set(t, r.topic);
          if (t && r.uuid && !titleToUuid.has(t)) titleToUuid.set(t, String(r.uuid));
        }
      } finally {
        pdb.close();
      }
    } catch {
      /* 家长库不可用时 topic_key 留空 */
    }
    const inserted: string[] = [];
    const skipped: string[] = [];
    for (const it of parsed) {
      const courseName = (it.courseName ?? "").trim();
      const topicKey = it.topicKey || titleToTopic.get(courseName) || "";
      const mode = it.mode ?? "new";
      const k = `${topicKey}\u0000${courseName}\u0000${mode}`;
      if (have.has(k)) {
        skipped.push(`${it.courseName}（${it.mode}）`);
        continue;
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const courseUuid = titleToUuid.get(courseName) || "";
      // 计划域重构：写入孩子 kb study_plans（窗口=当天 00:00:00 ~ 23:59:59；creator=parent → 必须完成项）
      const kbIns = openKb(deps.config.dataDir ?? "", parentId, childId);
      try {
        kbIns
          .prepare(
            `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,recurrence_id,
               start_at,due_at,status,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,'parent','conversation','','',?,?,'pending','','','required',1,0,1,?,?)`
          )
          .run(id, parentId, childId, topicKey, courseUuid, courseName, mode, `${day} 00:00:00`, `${day} 23:59:59`, now, now);
      } finally {
        kbIns.close();
      }
      have.add(k);
      inserted.push(`${it.courseName}（${mode === "review" ? "复习" : "新学"}）`);
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
    const found = findPlanAcrossChildren(deps.config.dataDir ?? "", deps.db, parentId, id);
    if (!found) return reply.code(403).send({ error: "无权访问该排期行" });
    const { date, mode, active } = (req.body ?? {}) as {
      date?: string;
      mode?: string;
      active?: boolean;
    };
    const sets: string[] = [];
    const vals: Array<string | number> = [];
    if (date !== undefined) {
      if (!validDate(date)) return reply.code(400).send({ error: "date 格式应为 YYYY-MM-DD" });
      sets.push("start_at = ?", "due_at = ?");
      vals.push(`${date} 00:00:00`, `${date} 23:59:59`);
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
      const kb = openKb(deps.config.dataDir ?? "", parentId, found.childId);
      try {
        kb.prepare(`UPDATE study_plans SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
      } finally {
        kb.close();
      }
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
    const found = findPlanAcrossChildren(deps.config.dataDir ?? "", deps.db, parentId, id);
    if (!found) return reply.code(403).send({ error: "无权访问该排期行" });
    const kb = openKb(deps.config.dataDir ?? "", parentId, found.childId);
    try {
      kb.prepare("DELETE FROM study_plans WHERE id = ?").run(id);
    } finally {
      kb.close();
    }
    return { ok: true };
  });
}
