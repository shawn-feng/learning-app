/**
 * 配置下发（DESIGN-SPLIT §7）：客户端每 2 分钟轮询 /config/revision，
 * 不一致则拉 /config 全量；家长端经 /config/set 改配置并自增 revision。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { bumpConfigRevision, getConfigRevision } from "../db.js";

interface ConfigDeps {
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

export function registerConfigRoutes(app: FastifyInstance, deps: ConfigDeps): void {
  // 轮询入口：只回 revision，客户端与本地缓存比对
  app.get("/api/v1/config/revision", async (req, reply) => {
    try {
      authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    return { revision: getConfigRevision(deps.db) };
  });

  // 全量配置：{ revision, config: { key: value, ... } }
  app.get("/api/v1/config", async (req, reply) => {
    try {
      authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const rows = deps.db
      .prepare("SELECT key, value_json FROM settings ORDER BY key")
      .all() as Array<{ key: string; value_json: string }>;
    const config: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        config[r.key] = JSON.parse(r.value_json);
      } catch {
        config[r.key] = r.value_json;
      }
    }
    return { revision: getConfigRevision(deps.db), config };
  });

  // 写配置（单键）：value 为任意 JSON，写入后 revision +1（跨设备 2min 内生效）
  app.post("/api/v1/config/set", async (req, reply) => {
    try {
      authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const { key, value } = (req.body ?? {}) as { key?: string; value?: unknown };
    if (!key?.trim()) return reply.code(400).send({ error: "key 必填" });
    deps.db
      .prepare(
        "INSERT INTO settings (key, value_json, updated) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated = excluded.updated"
      )
      .run(key.trim(), JSON.stringify(value ?? null), new Date().toISOString());
    const revision = bumpConfigRevision(deps.db);
    return { ok: true, revision };
  });
}
