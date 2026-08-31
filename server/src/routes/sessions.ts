/**
 * 会话同步与家长回顾（方案B 阶段①）：
 * - POST /api/v1/sessions/:childId/sync  客户端增量上传 jsonl（行级幂等，客户端权威）
 * - GET  /api/v1/sessions/:childId/dates 有会话消息的日期列表（回顾页日期选择）
 * - GET  /api/v1/sessions/:childId?date=YYYY-MM-DD 某天完整逐字稿（剔除 thinking，附工具调用）
 * 鉴权：家长 JWT；childId 必须归属该家长（children.parent_id）。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import {
  appendAndIndexSession,
  listSessionDates,
  querySessionMessages,
} from "../db/sessions.js";

interface SessionsDeps {
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

function handleAuthError(err: unknown, reply: any) {
  if (err instanceof ApiError) {
    reply.code(err.status).send({ error: err.message });
    return true;
  }
  return false;
}

export function registerSessionsRoutes(app: FastifyInstance, deps: SessionsDeps): void {
  app.post(
    "/api/v1/sessions/:childId/sync",
    { bodyLimit: 8 * 1024 * 1024 },
    async (req, reply) => {
      let parentId: string;
      try {
        parentId = authParent(req, deps.config.jwtSecret);
      } catch (err) {
        if (handleAuthError(err, reply)) return;
        throw err;
      }
      const { childId } = req.params as { childId: string };
      try {
        assertChildOwned(deps.db, parentId, childId);
      } catch (err) {
        if (handleAuthError(err, reply)) return;
        throw err;
      }
      const body = (req.body ?? {}) as {
        files?: Array<{ name?: string; fromOffset?: number; fromIndex?: number; lines?: string[] }>;
      };
      const files = Array.isArray(body.files) ? body.files : [];
      const acks: Array<{ name: string; syncedBytes: number; lineCount: number }> = [];
      for (const f of files) {
        const name = String(f?.name ?? "");
        const fromOffset = Number(f?.fromOffset ?? 0);
        const fromIndex = Number(f?.fromIndex ?? 0);
        const lines = Array.isArray(f?.lines)
          ? f.lines.map((l) => String(l))
          : [];
        if (!name) return reply.code(400).send({ error: "缺少文件名" });
        try {
          acks.push(
            appendAndIndexSession(
              deps.db,
              deps.config.dataDir,
              parentId,
              childId,
              name,
              fromOffset,
              fromIndex,
              lines
            )
          );
        } catch (err) {
          if (handleAuthError(err, reply)) return;
          throw err;
        }
      }
      return { ok: true, files: acks };
    }
  );

  app.get("/api/v1/sessions/:childId/dates", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    return { dates: listSessionDates(deps.db, childId) };
  });

  app.get("/api/v1/sessions/:childId", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { date } = req.query as { date?: string };
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.code(400).send({ error: "date 必填（YYYY-MM-DD）" });
    }
    return { date, messages: querySessionMessages(deps.db, childId, date) };
  });
}
