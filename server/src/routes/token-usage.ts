/**
 * ISSUE-129 token 用量查询（家长端「Token 用量」页数据源）。
 * - GET /api/v1/token-usage/days?from=&to=&scope=    按日期 × 渠道聚合
 * - GET /api/v1/token-usage/sessions?date=&scope=    某天按会话聚合
 * - GET /api/v1/token-usage/dates                    有数据的日期列表
 * 读取前先跑一次扫描器（游标增量，幂等），保证刚发生的轮次可见。
 * 口径=模型返回字段原样直传（见 db/token-usage.ts）；scope: parent|child|scene|course。
 * 鉴权：家长 JWT。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import {
  listTokenUsageDates,
  queryTokenUsageDays,
  queryTokenUsageSessions,
  scanTokenUsageIntoDb,
} from "../db/token-usage.js";

interface TokenUsageDeps {
  config: ServerConfig;
  db: DatabaseSync;
  dataDir: string;
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

function handleAuthError(err: unknown, reply: any) {
  if (err instanceof ApiError) {
    reply.code(err.status).send({ error: err.message });
    return true;
  }
  return false;
}

export function registerTokenUsageRoutes(app: FastifyInstance, deps: TokenUsageDeps): void {
  const scan = (parentId: string): void => {
    const children = deps.db.prepare("SELECT id FROM children WHERE parent_id = ?").all(parentId) as Array<{
      id: string;
    }>;
    scanTokenUsageIntoDb(deps.db, deps.dataDir, parentId, children.map((c) => c.id));
  };

  app.get("/api/v1/token-usage/days", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    try {
      scan(parentId);
      const q = req.query as { from?: string; to?: string; scope?: string };
      const rows = queryTokenUsageDays(deps.db, parentId, {
        from: q.from || undefined,
        to: q.to || undefined,
        scope: q.scope || undefined,
      });
      reply.send({ days: rows });
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
  });

  app.get("/api/v1/token-usage/sessions", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const q = req.query as { date?: string; scope?: string };
    if (!q.date || !/^\d{4}-\d{2}-\d{2}$/.test(q.date)) {
      reply.code(400).send({ error: "date 必填（YYYY-MM-DD）" });
      return;
    }
    try {
      scan(parentId);
      const rows = queryTokenUsageSessions(deps.db, parentId, q.date, q.scope || undefined);
      reply.send({ date: q.date, sessions: rows });
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
  });

  app.get("/api/v1/token-usage/dates", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    try {
      scan(parentId);
      reply.send({ dates: listTokenUsageDates(deps.db, parentId) });
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
  });
}
