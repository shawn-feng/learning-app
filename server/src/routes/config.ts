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
  // settings 键按家长隔离：`{parent_id}:{key}`（2026-08-30 起，模型配置与 key 都跟家长账号，
  // 不做全家长共用）。revision 全局自增（家长 A 改配置 → B 也拉一次全量，仅自己的键，无害）。
  const keyFor = (parentId: string, key: string) => `${parentId}:${key}`;

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

  // 全量配置（仅当前家长的键）：{ revision, config: { key: value, ... } }
  app.get("/api/v1/config", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const prefix = `${parentId}:`;
    const rows = deps.db
      .prepare("SELECT key, value_json FROM settings WHERE key LIKE ? ORDER BY key")
      .all(`${prefix}%`) as Array<{ key: string; value_json: string }>;
    const config: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        config[r.key.slice(prefix.length)] = JSON.parse(r.value_json);
      } catch {
        config[r.key.slice(prefix.length)] = r.value_json;
      }
    }
    return { revision: getConfigRevision(deps.db), config };
  });

  // 写配置（单键，按家长隔离）：value 为任意 JSON，写入后 revision +1（跨设备 2min 内生效）
  app.post("/api/v1/config/set", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
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
      .run(keyFor(parentId, key.trim()), JSON.stringify(value ?? null), new Date().toISOString());
    const revision = bumpConfigRevision(deps.db);
    return { ok: true, revision };
  });
}
