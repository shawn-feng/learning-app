/**
 * 孩子管理（家长维度）：创建 / 列表 / 改名 / 删除。
 * 孩子数据在服务端（kb 独立文件，见 db/kb.ts），删除孩子仅删 children 行，
 * 其 kb 文件保留（本期不做物理删除，避免误删学习数据）。
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";

interface ChildrenDeps {
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

export function registerChildrenRoutes(app: FastifyInstance, deps: ChildrenDeps): void {
  app.post("/api/v1/children", async (req, reply) => {
    const parentId = authParent(req, deps.config.jwtSecret);
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: "name 必填" });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    deps.db
      .prepare("INSERT INTO children (id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, parentId, name.trim(), now, now);
    return { child: { id, parent_id: parentId, name: name.trim(), created_at: now } };
  });

  app.get("/api/v1/children", async (req) => {
    const parentId = authParent(req, deps.config.jwtSecret);
    const rows = deps.db
      .prepare("SELECT id, name, created_at FROM children WHERE parent_id = ? ORDER BY created_at")
      .all(parentId);
    return { children: rows };
  });

  app.patch("/api/v1/children/:id", async (req, reply) => {
    const parentId = authParent(req, deps.config.jwtSecret);
    const { id } = req.params as { id: string };
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name?.trim()) return reply.code(400).send({ error: "name 必填" });
    const row = deps.db
      .prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?")
      .get(id, parentId);
    if (!row) return reply.code(403).send({ error: "无权访问该孩子" });
    deps.db
      .prepare("UPDATE children SET name = ?, updated_at = ? WHERE id = ?")
      .run(name.trim(), new Date().toISOString(), id);
    return { ok: true };
  });

  app.delete("/api/v1/children/:id", async (req, reply) => {
    const parentId = authParent(req, deps.config.jwtSecret);
    const { id } = req.params as { id: string };
    const row = deps.db
      .prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?")
      .get(id, parentId);
    if (!row) return reply.code(403).send({ error: "无权访问该孩子" });
    // 仅删除 children 行；kb 文件本期保留（防误删学习数据）
    deps.db.prepare("DELETE FROM children WHERE id = ?").run(id);
    return { ok: true };
  });
}
