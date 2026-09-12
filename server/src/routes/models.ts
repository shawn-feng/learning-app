/**
 * 模型配置路由（P4 薄客户端用）：模型列表 + 密钥 + 家长 app_settings。
 *
 * 现状：密钥与 app_settings 已能经 /config/set 写入（settings 表，auth 加密），本路由补上
 * 「客户端设置页」真正需要、但服务端此前缺失的三件事：
 *  - GET  /api/v1/models               模型列表（静态展开 provider 表，无需 auth，供下拉与视觉过滤）
 *  - POST /api/v1/models/apikey        设置某 provider 的 API key（合并进 auth 封套，加密落盘）
 *  - POST /api/v1/models/app_settings  合并 app_settings（defaultModel / visionModel / programmingModel / tts…）
 *
 * 为什么单独成路由而不是让客户端反复 fetch+merge /config：合并逻辑（auth 的 {provider:{type,key}} 封套、
 * app_settings 的读改写）若放在每个客户端，会出现「两设备并发改 key 互相覆盖」的竞态；收口到服务端一处。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { getServerSecret, encryptJson, decryptJson } from "../crypto.js";
import { bumpConfigRevision } from "../db.js";
import { listProviderModels } from "@pi/agent-core";

interface ModelsDeps {
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

function handleAuthError(err: unknown, reply: any): boolean {
  if (err instanceof ApiError) {
    reply.code(err.status).send({ error: err.message });
    return true;
  }
  return false;
}

export function registerModelRoutes(app: FastifyInstance, deps: ModelsDeps): void {
  const keyFor = (parentId: string, key: string) => `${parentId}:${key}`;
  const secret = getServerSecret(deps.config.dataDir);

  /** 读某家长某 settings 键（auth 解密、其余 JSON.parse）。 */
  function readSetting(parentId: string, key: string): unknown {
    const row = deps.db
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(keyFor(parentId, key)) as { value_json?: string } | undefined;
    if (!row?.value_json) return undefined;
    if (key === "auth") return decryptJson(secret, row.value_json);
    try {
      return JSON.parse(row.value_json);
    } catch {
      return undefined;
    }
  }

  /** 写某家长某 settings 键（auth 加密、其余 JSON 字符串化），revision +1。 */
  function writeSetting(parentId: string, key: string, value: unknown): void {
    const stored = key === "auth" ? encryptJson(secret, value) : JSON.stringify(value ?? null);
    deps.db
      .prepare(
        "INSERT INTO settings (key, value_json, updated) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated = excluded.updated"
      )
      .run(keyFor(parentId, key), stored, new Date().toISOString());
    bumpConfigRevision(deps.db);
  }

  app.get("/api/v1/models", async (req, reply) => {
    try {
      authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    return { models: listProviderModels() };
  });

  // 设置某 provider 的 API key：合并进 auth 封套（{ provider: { type:"api_key", key } }），加密落盘。
  // 与客户端 setProviderApiKey 的 auth.json 结构一致（多设备同步环共享同一结构）。
  app.post("/api/v1/models/apikey", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { provider, apiKey } = (req.body ?? {}) as { provider?: string; apiKey?: string };
    if (!provider?.trim()) return reply.code(400).send({ error: "provider 必填" });
    const auth = (readSetting(parentId, "auth") as Record<string, any>) ?? {};
    auth[provider.trim()] = { type: "api_key", key: String(apiKey ?? "") };
    writeSetting(parentId, "auth", auth);
    return { ok: true };
  });

  // 合并 app_settings（只更新传入的字段，不整体覆盖），供模型选择/tts 等设置。
  app.post("/api/v1/models/app_settings", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const patch = (req.body ?? {}) as Record<string, unknown>;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return reply.code(400).send({ error: "patch 必须是对象" });
    }
    const current = (readSetting(parentId, "app_settings") as Record<string, unknown>) ?? {};
    writeSetting(parentId, "app_settings", { ...current, ...patch });
    return { ok: true, appSettings: { ...current, ...patch } };
  });

  // 读取当前 app_settings + auth 脱敏态（供设置页回显；auth 只回 provider 名 + 是否有 key，不回明文）。
  app.get("/api/v1/models/settings", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const appSettings = (readSetting(parentId, "app_settings") as Record<string, unknown>) ?? {};
    const auth = (readSetting(parentId, "auth") as Record<string, any>) ?? {};
    const providers = Object.keys(auth).map((p) => ({ provider: p, hasKey: !!(auth[p] as any)?.key }));
    return { appSettings, providers };
  });
}
