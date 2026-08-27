/**
 * 数据读写 RPC（DESIGN-SPLIT §3.4）：客户端不持有 SQLite，
 * 通过语义化 op 读写服务端数据；child 相关 op 强制归属校验。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { openKb } from "../db/kb.js";
import {
  getAgentPrompt,
  listAgentPromptHistory,
  restoreAgentPromptVersion,
  saveAgentPrompt,
} from "../db/agents.js";
import { openParentLib } from "../db/parent-lib.js";

interface RpcContext {
  dataDir: string;
  mainDb: DatabaseSync;
  parentId: string;
}

function assertChildOwned(ctx: RpcContext, childId: string): void {
  const row = ctx.mainDb
    .prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?")
    .get(childId, ctx.parentId);
  if (!row) {
    throw new ApiError(403, "无权访问该孩子的数据");
  }
}

function requireChildId(ctx: RpcContext, args: Record<string, unknown>): string {
  const childId = typeof args.child_id === "string" ? args.child_id : "";
  if (!childId) throw new ApiError(400, "缺少 child_id");
  assertChildOwned(ctx, childId);
  return childId;
}

function str(v: unknown, fallback = ""): string {
  return v === undefined || v === null ? fallback : String(v);
}

function num(v: unknown, fallback = 0): number {
  return v === undefined || v === null ? fallback : Number(v);
}

// ==================== query handlers ====================

type QueryHandler = (ctx: RpcContext, args: Record<string, unknown>) => unknown;

const queryHandlers: Record<string, QueryHandler> = {
  "kb.daily_entries.queryByDate": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      return db
        .prepare("SELECT date, block, title, raw, tags FROM daily_entries WHERE date = ? ORDER BY block, title")
        .all(str(args.date));
    } finally {
      db.close();
    }
  },
  "kb.topics.list": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      return db
        .prepare("SELECT name, topic_key, method, progress, rules_json FROM topics ORDER BY topic_key")
        .all();
    } finally {
      db.close();
    }
  },
  "kb.courses.list": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      const topic = str(args.topic, "");
      const sql =
        "SELECT topic, title, sort_order, status, mastery, first_learned, last_review, " +
        "review_count, material, send_material, tags, lesson_method, html_path, teaching_copy " +
        "FROM courses " +
        (topic ? "WHERE topic = ? " : "") +
        "ORDER BY topic, sort_order, title";
      return topic ? db.prepare(sql).all(topic) : db.prepare(sql).all();
    } finally {
      db.close();
    }
  },
  "kb.tags.list": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      return db.prepare("SELECT tag, dimension, criteria FROM tags ORDER BY tag").all();
    } finally {
      db.close();
    }
  },
  "kb.progress.list": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      return db.prepare("SELECT * FROM topic_progress ORDER BY topic").all();
    } finally {
      db.close();
    }
  },
  "agents.get": (ctx, args) => {
    const scope = str(args.scope);
    const ref = str(args.ref);
    if (scope === "child") assertChildOwned(ctx, ref);
    if (scope !== "child" && scope !== "parent") {
      throw new ApiError(400, "scope 仅支持 child / parent");
    }
    const content = getAgentPrompt(ctx.dataDir, scope, ref);
    return { content };
  },
  "agents.history": (ctx, args) => {
    const scope = str(args.scope);
    const ref = str(args.ref);
    if (scope === "child") assertChildOwned(ctx, ref);
    if (scope !== "child" && scope !== "parent") {
      throw new ApiError(400, "scope 仅支持 child / parent");
    }
    return listAgentPromptHistory(ctx.dataDir, scope, ref);
  },
  "parent_lib.topics.list": (ctx) => {
    const db = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      return db
        .prepare("SELECT name, topic_key, method, progress, rules_json FROM topics ORDER BY topic_key")
        .all();
    } finally {
      db.close();
    }
  },
  "parent_lib.courses.list": (ctx, args) => {
    const db = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      const topic = str(args.topic, "");
      const sql =
        "SELECT topic, title, sort_order, status, mastery, first_learned, last_review, " +
        "review_count, material, send_material, tags, lesson_method, html_path, teaching_copy " +
        "FROM courses " +
        (topic ? "WHERE topic = ? " : "") +
        "ORDER BY topic, sort_order, title";
      return topic ? db.prepare(sql).all(topic) : db.prepare(sql).all();
    } finally {
      db.close();
    }
  },
};

// ==================== exec handlers ====================

type ExecHandler = (ctx: RpcContext, args: Record<string, unknown>) => unknown;

const execHandlers: Record<string, ExecHandler> = {
  "kb.daily_entries.insert": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      db.prepare(
        `INSERT OR REPLACE INTO daily_entries (date, block, title, raw, tags)
         VALUES (?, ?, ?, ?, ?)`
      ).run(str(args.date), str(args.block), str(args.title), str(args.raw), str(args.tags));
      return { ok: true };
    } finally {
      db.close();
    }
  },
  "kb.topics.upsert": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      db.prepare(
        `INSERT INTO topics (name, topic_key, method, progress, rules_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           topic_key = excluded.topic_key,
           method = excluded.method,
           progress = excluded.progress,
           rules_json = excluded.rules_json`
      ).run(
        str(args.name),
        str(args.topic_key),
        str(args.method),
        str(args.progress),
        str(args.rules_json, "{}")
      );
      return { ok: true };
    } finally {
      db.close();
    }
  },
  "kb.courses.upsert": (ctx, args) => {
    const childId = requireChildId(ctx, args);
    const db = openKb(ctx.dataDir, ctx.parentId, childId);
    try {
      db.prepare(
        `INSERT INTO courses (
           topic, title, sort_order, status, mastery, first_learned, last_review,
           review_count, material, send_material, tags, lesson_method, html_path, teaching_copy
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(topic, title) DO UPDATE SET
           sort_order = excluded.sort_order,
           status = excluded.status,
           mastery = excluded.mastery,
           first_learned = excluded.first_learned,
           last_review = excluded.last_review,
           review_count = excluded.review_count,
           material = excluded.material,
           send_material = excluded.send_material,
           tags = excluded.tags,
           lesson_method = excluded.lesson_method,
           html_path = excluded.html_path,
           teaching_copy = excluded.teaching_copy`
      ).run(
        str(args.topic),
        str(args.title),
        num(args.sort_order),
        str(args.status),
        str(args.mastery),
        str(args.first_learned),
        str(args.last_review),
        num(args.review_count),
        str(args.material),
        str(args.send_material),
        str(args.tags),
        str(args.lesson_method),
        str(args.html_path),
        str(args.teaching_copy)
      );
      return { ok: true };
    } finally {
      db.close();
    }
  },
  "agents.save": (ctx, args) => {
    const scope = str(args.scope);
    const ref = str(args.ref);
    if (scope === "child") assertChildOwned(ctx, ref);
    if (scope !== "child" && scope !== "parent") {
      throw new ApiError(400, "scope 仅支持 child / parent");
    }
    saveAgentPrompt(ctx.dataDir, scope, ref, str(args.content));
    return { ok: true };
  },
  "agents.restore": (ctx, args) => {
    const scope = str(args.scope);
    const ref = str(args.ref);
    if (scope === "child") assertChildOwned(ctx, ref);
    if (scope !== "child" && scope !== "parent") {
      throw new ApiError(400, "scope 仅支持 child / parent");
    }
    const done = restoreAgentPromptVersion(ctx.dataDir, scope, ref, str(args.updated));
    return { ok: done };
  },
  "parent_lib.topics.upsert": (ctx, args) => {
    const db = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      db.prepare(
        `INSERT INTO topics (name, topic_key, method, progress, rules_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           topic_key = excluded.topic_key,
           method = excluded.method,
           progress = excluded.progress,
           rules_json = excluded.rules_json`
      ).run(
        str(args.name),
        str(args.topic_key),
        str(args.method),
        str(args.progress),
        str(args.rules_json, "{}")
      );
      return { ok: true };
    } finally {
      db.close();
    }
  },
  "parent_lib.courses.upsert": (ctx, args) => {
    const db = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      db.prepare(
        `INSERT INTO courses (
           topic, title, sort_order, status, mastery, first_learned, last_review,
           review_count, material, send_material, tags, lesson_method, html_path, teaching_copy
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(topic, title) DO UPDATE SET
           sort_order = excluded.sort_order,
           status = excluded.status,
           mastery = excluded.mastery,
           first_learned = excluded.first_learned,
           last_review = excluded.last_review,
           review_count = excluded.review_count,
           material = excluded.material,
           send_material = excluded.send_material,
           tags = excluded.tags,
           lesson_method = excluded.lesson_method,
           html_path = excluded.html_path,
           teaching_copy = excluded.teaching_copy`
      ).run(
        str(args.topic),
        str(args.title),
        num(args.sort_order),
        str(args.status),
        str(args.mastery),
        str(args.first_learned),
        str(args.last_review),
        num(args.review_count),
        str(args.material),
        str(args.send_material),
        str(args.tags),
        str(args.lesson_method),
        str(args.html_path),
        str(args.teaching_copy)
      );
      return { ok: true };
    } finally {
      db.close();
    }
  },
};

// ==================== routes ====================

interface DbRoutesDeps {
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

export function registerDbRoutes(app: FastifyInstance, deps: DbRoutesDeps): void {
  const ctxFor = (req: { headers: Record<string, string | string[] | undefined> }): RpcContext => ({
    dataDir: deps.config.dataDir,
    mainDb: deps.db,
    parentId: authParent(req, deps.config.jwtSecret),
  });

  app.post("/api/v1/db/query", async (req, reply) => {
    const { op, args } = (req.body ?? {}) as { op?: string; args?: Record<string, unknown> };
    if (!op) return reply.code(400).send({ error: "缺少 op" });
    const handler = queryHandlers[op];
    if (!handler) return reply.code(400).send({ error: `未知查询操作: ${op}` });
    try {
      return { op, result: handler(ctxFor(req), args ?? {}) };
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  app.post("/api/v1/db/exec", async (req, reply) => {
    const { op, args } = (req.body ?? {}) as { op?: string; args?: Record<string, unknown> };
    if (!op) return reply.code(400).send({ error: "缺少 op" });
    const handler = execHandlers[op];
    if (!handler) return reply.code(400).send({ error: `未知执行操作: ${op}` });
    try {
      return { op, result: handler(ctxFor(req), args ?? {}) };
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });
}
