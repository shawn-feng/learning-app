/**
 * 日志导出路由（ISSUE-162，ISSUE-044 的取回链路补全）：
 *   GET /api/v1/logs/server — 服务端日志全文（server-log.jsonl，authParent）
 *   GET /api/v1/logs/client — 占位端点：客户端日志在每台客户端本机（client-log.jsonl），
 *                             不在服务端，恒返回空 content + 说明（防两端点混淆）。
 * 日志本身不含对话正文与密钥（ISSUE-044 隐私红线），但含访问路径/ip，仅对家长开放。
 */
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { verifySession } from "../auth/jwt.js";
import { getServerLogText } from "../log.js";

interface Deps {
  jwtSecret: string;
}

function authParent(req: { headers: Record<string, string | string[] | undefined> }, secret: string): string {
  const header = req.headers.authorization;
  const token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) throw new Error("缺少 session token");
  return verifySession(token, secret).parent_id;
}

export function registerLogsRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/v1/logs/server", async (req, reply) => {
    try {
      authParent(req, deps.jwtSecret);
    } catch {
      return reply.code(401).send({ error: "未登录" });
    }
    return { content: getServerLogText() };
  });

  app.get("/api/v1/logs/client", async (req, reply) => {
    try {
      authParent(req, deps.jwtSecret);
    } catch {
      return reply.code(401).send({ error: "未登录" });
    }
    return { content: "", note: "客户端日志在各客户端本机（client-log.jsonl），服务端不留存" };
  });
}
