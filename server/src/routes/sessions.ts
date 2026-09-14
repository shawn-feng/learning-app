/**
 * 家长对话回顾（会话消息索引在服务端，客户端不再同步）：
 * - GET  /api/v1/sessions/:childId/dates 有会话消息的日期列表（回顾页日期选择）
 * - GET  /api/v1/sessions/:childId?date=YYYY-MM-DD 某天完整逐字稿（剔除 thinking，附工具调用）
 * 9/12 迁移后：孩子对话全部由服务端 agent 落盘到 data/agent-sessions/，服务端在「对话回顾」读取前
 * 调用 indexAgentSessionsIntoDb 把新增消息增量写入 session_messages（见 db/sessions.ts）。
 * 鉴权：家长 JWT；childId 必须归属该家长（children.parent_id）。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import {
  indexAgentSessionsIntoDb,
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
    // 服务端索引：把 agent-sessions 新增消息增量写入 session_messages，再查日期列表
    indexAgentSessionsIntoDb(deps.db, deps.config.dataDir, parentId, childId);
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
    // 服务端索引：把 agent-sessions 新增消息增量写入 session_messages，再查逐字稿
    indexAgentSessionsIntoDb(deps.db, deps.config.dataDir, parentId, childId);
    return { date, messages: querySessionMessages(deps.db, childId, date) };
  });
}
