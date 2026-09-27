/**
 * ISSUE-163 密钥打码回显回归（2026-09-27）：
 * ① /models/settings 的 providers 携带 keyMasked（前6+****+后4），绝不回明文；
 * ② 未配 key 的 provider keyMasked 为空串；
 * ③ maskSecret 边界（短 key 全 *、长 key 6/4）；
 * ④ feishu-config GET 回 secretMasked。
 */
import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openDb } from "../server/src/db";
import { getServerSecret, encryptJson } from "../server/src/crypto";
import { registerModelRoutes } from "../server/src/routes/models";
import { registerWechatRoutes } from "../server/src/routes/wechat";
import { maskSecret as assessMask } from "../server/src/assessment/config";
import { maskSecret } from "../server/src/util/mask";
import { signSession } from "../server/src/auth/jwt";
import type { ServerConfig } from "../server/src/config";
import type { FastifyInstance } from "fastify";

const requireFromServer = createRequire(path.resolve("server/src/index.ts"));
const Fastify = requireFromServer("fastify") as (opts?: Record<string, unknown>) => FastifyInstance;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue163-mask-"));
const SECRET = "test-secret-163";
const parentId = "parent-r163";

const mainDb = openDb(dataDir);
const config: ServerConfig = {
  port: 8788,
  upstreamBase: "",
  jwtSecret: SECRET,
  tokenTtlDays: 7,
  dataDir,
};

let app: FastifyInstance;
const token = signSession({ parent_id: parentId }, SECRET, 7);

beforeAll(async () => {
  // 种 auth 设置：一个有 key、一个没有（models 路由读 settings 表 `<parentId>:auth`，AES 加密封套）
  const secret = getServerSecret(dataDir);
  const enc = encryptJson(secret, { qwen: { type: "api_key", key: "sk-abcdefgh12wxyz3456" } });
  mainDb
    .prepare(
      `INSERT INTO settings (key, value_json, updated) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`
    )
    .run(`${parentId}:auth`, enc, new Date().toISOString());

  app = Fastify({ logger: false });
  registerModelRoutes(app, { config, db: mainDb });
  registerWechatRoutes(app, { config, db: mainDb });
  await app.ready();
});

it("① /models/settings：qwen 有 keyMasked=sk-abc****3456 且不含明文；其它 provider 为空串", async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/models/settings", headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { providers: Array<{ provider: string; hasKey: boolean; keyMasked: string }> };
  const qwen = body.providers.find((p) => p.provider === "qwen");
  expect(qwen?.hasKey).toBe(true);
  expect(qwen?.keyMasked).toBe("sk-abc****3456");
  expect(JSON.stringify(body)).not.toContain("sk-abcdefgh12wxyz3456");
  const empty = body.providers.find((p) => p.provider !== "qwen" && !p.hasKey);
  expect(empty?.keyMasked).toBe("");
});

it("② maskSecret 边界：空串/短 key 全 */长 key 6+****+4", () => {
  expect(maskSecret("")).toBe("");
  expect(maskSecret("short12")).toBe("*******");
  expect(maskSecret("sk-abcdefgh12wxyz3456")).toBe("sk-abc****3456");
  // assessment 侧的打码同语义（对齐后）
  expect(assessMask("sk-abcdefgh12wxyz3456")).toBe("sk-abc****3456");
});

it("③ /wechat/feishu-config：未配置时 secretMasked 为空（不炸）", async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/wechat/feishu-config", headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { secretMasked?: string; hasSecret?: boolean };
  expect(body.hasSecret).toBe(false);
  expect(body.secretMasked).toBe("");
});
