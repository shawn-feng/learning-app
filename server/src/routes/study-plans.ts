/**
 * 学习计划（ISSUE-033，2026-09-02）路由：家长对话制定 → 「每天学什么」排期行（服务端数据真源）。
 * - GET  /api/v1/study-plans?childId=xxx             排期行列表（date 倒序，供家长回显 / 只读面板）
 * - POST /api/v1/study-plans                         创建排期行（家长 agent 工具 study_plan_create 落库点）
 * - PATCH  /api/v1/study-plans/:id                   更新某行（content/date/active；家长 agent 工具 study_plan_update）
 * - DELETE /api/v1/study-plans/:id                   删除某行（study_plan_update 覆盖「删某天」场景）
 * - GET  /api/v1/study-plans/today?childId=&date=    当日聚合：kind=date AND date=@d AND active 的行按 content 展平为 items，
 *                                                    含 origin='carry'（未完成顺延）；gen 侧据此生成 [家长] todo 行。
 * 鉴权：家长 JWT；childId 必须归属该家长；行归属按 parent_id 校验。
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";

interface StudyPlanDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

interface PlanItem {
  text: string;
  topicKey?: string;
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

/** 校验并规范化 content 数组：[{ text 必填非空, topicKey? }]，上限 100 项防滥用。 */
function parseContent(raw: unknown): PlanItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) return null;
  const items: PlanItem[] = [];
  for (const it of raw) {
    if (typeof it !== "object" || it === null) return null;
    const { text, topicKey } = it as { text?: unknown; topicKey?: unknown };
    if (typeof text !== "string" || !text.trim()) return null;
    items.push({ text: text.trim(), topicKey: typeof topicKey === "string" && topicKey ? topicKey : undefined });
  }
  return items;
}

interface PlanRow {
  id: string;
  child_id: string;
  kind: string;
  date: string;
  content: string;
  origin: string;
  active: number;
  created_at: string;
  updated_at: string;
}

function fetchRow(db: DatabaseSync, parentId: string, id: string): PlanRow | undefined {
  return db.prepare("SELECT * FROM study_plan_items WHERE id = ? AND parent_id = ?").get(id, parentId) as
    | PlanRow
    | undefined;
}

function listChildRows(db: DatabaseSync, parentId: string, childId: string): PlanRow[] {
  return db
    .prepare(
      "SELECT * FROM study_plan_items WHERE parent_id = ? AND child_id = ? AND active = 1 ORDER BY date DESC, updated_at DESC LIMIT 500"
    )
    .all(parentId, childId) as unknown as PlanRow[];
}

export function registerStudyPlanRoutes(app: FastifyInstance, deps: StudyPlanDeps): void {
  // 列表（家长回显 / 只读面板；可选 date 精确过滤某天，供 create 去重查重）
  app.get("/api/v1/study-plans", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId, date } = (req.query ?? {}) as { childId?: string; date?: string };
    if (!childId) return reply.code(400).send({ error: "childId 必填" });
    if (date !== undefined && !validDate(date)) return reply.code(400).send({ error: "date 格式应为 YYYY-MM-DD" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const rows = date
      ? (deps.db
          .prepare(
            "SELECT * FROM study_plan_items WHERE parent_id = ? AND child_id = ? AND active = 1 AND date = ? ORDER BY date DESC, updated_at DESC LIMIT 500"
          )
          .all(parentId, childId, date) as unknown as PlanRow[])
      : listChildRows(deps.db, parentId, childId);
    return {
      ok: true,
      rows: rows.map((r) => ({
        id: r.id,
        childId: r.child_id,
        kind: r.kind,
        date: r.date,
        origin: r.origin,
        content: safeParseContent(r.content),
        updatedAt: r.updated_at,
      })),
    };
  });

  // 当日聚合（gen 侧生成 [家长] todo 行；date 缺省 = UTC 当天兜底，客户端应显式传本地日期）
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
        "SELECT * FROM study_plan_items WHERE parent_id = ? AND child_id = ? AND active = 1 AND kind = 'date' AND date = ? ORDER BY created_at ASC"
      )
      .all(parentId, childId, day) as unknown as PlanRow[];
    const items: Array<{ planId: string; text: string; topicKey?: string; carry: boolean }> = [];
    for (const r of rows) {
      const content = safeParseContent(r.content);
      for (const it of content) {
        items.push({ planId: r.id, text: it.text, topicKey: it.topicKey, carry: r.origin === "carry" });
      }
    }
    // 文本去重（同日同文本只留一条——防御历史重复行；首个出现的 carry 标记保留）
    const seenText = new Set<string>();
    const dedup: typeof items = [];
    for (const it of items) {
      if (!it.text || seenText.has(it.text)) continue;
      seenText.add(it.text);
      dedup.push(it);
    }
    return { ok: true, date: day, items: dedup };
  });

  // 创建（家长 agent study_plan_create）
  // 幂等合并语义（2026-09-02 修复同日重复行）：同 (child, kind=date, date) 已有 active 行时——
  //   全部重复 → 不落库返回现有最新行（duplicated:true）；部分新增 → 新项追加进最新一行（同日保持单行），
  //   杜绝「分多次追加同一天」时每次都以完整清单新建行造成面板重复。
  app.post("/api/v1/study-plans", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId, date, content, kind } = (req.body ?? {}) as {
      childId?: string;
      date?: string;
      content?: unknown;
      kind?: string;
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
    const items = parseContent(content);
    if (!items) return reply.code(400).send({ error: "content 必填：非空 [{text, topicKey?}] 数组（≤100 项）" });
    const k = kind ?? "date";
    if (k !== "date") return reply.code(400).send({ error: "kind 当前仅支持 date（daily 预留）" });

    // 幂等合并：查同 (child, kind, date) 的 active 行
    const existingRows = deps.db
      .prepare(
        "SELECT id, content FROM study_plan_items WHERE parent_id = ? AND child_id = ? AND kind = ? AND date = ? AND active = 1 ORDER BY created_at ASC"
      )
      .all(parentId, childId, k, day) as unknown as Array<{ id: string; content: string }>;
    const have = new Set<string>();
    for (const r of existingRows) {
      for (const it of safeParseContent(r.content)) if (it.text) have.add(it.text);
    }
    const toAdd = items.filter((it) => !have.has(it.text));
    if (existingRows.length > 0) {
      if (toAdd.length === 0) {
        // 全部已存在：幂等返回现有最新行，不新增
        const last = existingRows[existingRows.length - 1];
        return { ok: true, duplicated: true, row: fetchRow(deps.db, parentId, last.id) };
      }
      // 部分新增：追加进最新一行（同日单行 canonical）
      const target = existingRows[existingRows.length - 1];
      const merged = [...safeParseContent(target.content), ...toAdd];
      deps.db
        .prepare("UPDATE study_plan_items SET content = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(merged), new Date().toISOString(), target.id);
      return { ok: true, merged: true, row: fetchRow(deps.db, parentId, target.id) };
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    deps.db
      .prepare(
        "INSERT INTO study_plan_items (id, parent_id, child_id, kind, date, content, origin, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'conversation', 1, ?, ?)"
      )
      .run(id, parentId, childId, k, day, JSON.stringify(items), now, now);
    return { ok: true, row: fetchRow(deps.db, parentId, id) };
  });

  // 更新（家长 agent study_plan_update：改 content / 改日期 / 停用）
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
    const { date, content, active } = (req.body ?? {}) as {
      date?: string;
      content?: unknown;
      active?: boolean;
    };
    const next: { date: string; content: string; active: number; updated_at: string } = {
      date: cur.date,
      content: cur.content,
      active: cur.active,
      updated_at: new Date().toISOString(),
    };
    if (date !== undefined) {
      if (!validDate(date)) return reply.code(400).send({ error: "date 格式应为 YYYY-MM-DD" });
      next.date = date;
    }
    if (content !== undefined) {
      const items = parseContent(content);
      if (!items) return reply.code(400).send({ error: "content 应为非空 [{text, topicKey?}] 数组（≤100 项）" });
      next.content = JSON.stringify(items);
    }
    if (active !== undefined) next.active = active ? 1 : 0;
    deps.db
      .prepare("UPDATE study_plan_items SET date = ?, content = ?, active = ?, updated_at = ? WHERE id = ?")
      .run(next.date, next.content, next.active, next.updated_at, id);
    return { ok: true, row: fetchRow(deps.db, parentId, id) };
  });

  // 删除（家长 agent「把 9 月 5 号删了」）
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

function safeParseContent(raw: string): PlanItem[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as PlanItem[]) : [];
  } catch {
    return [];
  }
}
