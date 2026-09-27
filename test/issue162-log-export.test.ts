/**
 * ISSUE-162 日志导出路由回归（2026-09-27）：
 * GET /api/v1/logs/server（家长 JWT）返回 server-log.jsonl 全文；
 * GET /api/v1/logs/client 占位端点恒空 content + note。
 *
 * 覆盖：① server 端点 200 形状且含 init 后写入的日志行；② 缺 token 401；
 * ③ client 占位端点 200 content:"" + note；④ getServerLogText 与写入内容一致。
 */
import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { initServerLog, logInfo, getServerLogText } from "../server/src/log";
import { registerLogsRoutes } from "../server/src/routes/logs";
import { signSession } from "../server/src/auth/jwt";
import type { FastifyInstance } from "fastify";

// fastify 只装在 server/node_modules；从 server 目录解析才能命中（根 node_modules 没有）。
const requireFromServer = createRequire(path.resolve("server/src/index.ts"));
const Fastify = requireFromServer("fastify") as (opts?: Record<string, unknown>) => FastifyInstance;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue162-logs-"));
const SECRET = "test-secret-162";
const parentId = "parent-r162";

const app: FastifyInstance = Fastify({ logger: false });

beforeAll(async () => {
  initServerLog(dataDir);
  logInfo("test", "issue162 boot line", { parentId });
  registerLogsRoutes(app, { jwtSecret: SECRET });
  await app.ready();
});

it("① /logs/server 200：形状 {content} 且含刚写入的日志行", async () => {
  const token = signSession({ parent_id: parentId }, SECRET, 7);
  const res = await app.inject({ method: "GET", url: "/api/v1/logs/server", headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { content: string };
  expect(typeof body.content).toBe("string");
  expect(body.content).toContain("issue162 boot line");
});

it("② 缺 token → 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/logs/server" });
  expect(res.statusCode).toBe(401);
});

it("③ /logs/client 占位端点 200：content 空 + note 说明", async () => {
  const token = signSession({ parent_id: parentId }, SECRET, 7);
  const res = await app.inject({ method: "GET", url: "/api/v1/logs/client", headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { content: string; note?: string };
  expect(body.content).toBe("");
  expect(body.note).toBeTruthy();
});

it("④ /logs/client 缺 token 同样 401；getServerLogText 与文件一致", async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/logs/client" });
  expect(res.statusCode).toBe(401);
  const text = getServerLogText();
  expect(text).toContain("issue162 boot line");
  expect(text.endsWith("\n") || text === "").toBe(true);
});
