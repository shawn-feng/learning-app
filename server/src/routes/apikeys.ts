/**
 * 开放 API 密钥管理（家长 JWT）：
 * - GET    /api/v1/apikeys   查询当前有效键（脱敏：只回 prefix，绝不回完整 Key）
 * - POST   /api/v1/apikeys   生成（一账号一有效键，已有 → 409；响应**一次性**返回完整 Key）
 * - DELETE /api/v1/apikeys   吊销（第三方立即 401）；吊销后可再生成新键
 *
 * 安全：库里只存 sha256(key)；比较走 timingSafeEqual（open-api 鉴权侧）；
 * 重新生成 = DELETE + POST（前端两步，服务端不提供"原地换键"避免误触丢键）。
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";

interface ApiKeysDeps {
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

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key, "utf-8").digest("hex");
}

/** 生成开放 API Key：laxk_ + 32 字节随机 base64url。prefix 取前 12 位（含 laxk_）供展示。 */
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `laxk_${crypto.randomBytes(32).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 12) };
}

export function registerApiKeysRoutes(app: FastifyInstance, deps: ApiKeysDeps): void {
  app.get("/api/v1/apikeys", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const row = deps.db
      .prepare(
        "SELECT id, prefix, child_id, label, last_used_at, request_count, created_at FROM api_keys WHERE parent_id = ? AND revoked_at IS NULL"
      )
      .get(parentId) as
      | { id: string; prefix: string; child_id: string; label: string; last_used_at: string | null; request_count: number; created_at: string }
      | undefined;
    return { key: row ?? null };
  });

  app.post("/api/v1/apikeys", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const body = (req.body ?? {}) as { child_id?: string; label?: string };
    const childId = String(body.child_id ?? "").trim();
    const label = String(body.label ?? "").trim().slice(0, 50);
    if (childId) {
      const owned = deps.db.prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?").get(childId, parentId);
      if (!owned) return reply.code(403).send({ error: "无权关联该孩子" });
    }
    const existing = deps.db
      .prepare("SELECT id FROM api_keys WHERE parent_id = ? AND revoked_at IS NULL")
      .get(parentId);
    if (existing) return reply.code(409).send({ error: "已存在有效 API Key（先吊销旧键再生成）" });

    const { key, hash, prefix } = generateApiKey();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    deps.db
      .prepare(
        "INSERT INTO api_keys (id, parent_id, key_hash, prefix, child_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, parentId, hash, prefix, childId, label, now);
    // secret 仅此一次返回（库里只有 hash，丢了只能重新生成）
    return { key: { id, prefix, child_id: childId, label, created_at: now }, secret: key };
  });

  app.delete("/api/v1/apikeys", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const r = deps.db
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE parent_id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), parentId);
    if (r.changes === 0) return reply.code(404).send({ error: "没有有效的 API Key" });
    return { ok: true };
  });
}
