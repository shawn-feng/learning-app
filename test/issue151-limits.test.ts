/**
 * ISSUE-151 拍板实施回归：上传/外发两类区分。
 * - 存储类（multipart 全通道）Infinity 不变；
 * - 外发类入口 413：ASR /asr/transcribe、开放 API /open/agent/voice 超 20MB 即拒（可读文案）。
 * 常量值锁定（改动限制值须同步 ISSUE-151 记录）。
 * 用真监听 + 原生 fetch/FormData（inject 手工构造 multipart 有 CRLF 转义坑）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openDb } from "../server/src/db";
import { registerApiKeysRoutes } from "../server/src/routes/apikeys";
import { registerOpenApiRoutes } from "../server/src/routes/open-api";
import { registerAsrRoutes } from "../server/src/routes/asr";
import { signSession } from "../server/src/auth/jwt";
import { getServerSecret } from "../server/src/crypto";
import {
  ASR_AUDIO_MAX_BYTES,
  ASSESS_AUDIO_MAX_BYTES,
  VISION_IMAGE_MAX_BYTES,
  JSON_BODY_LIMIT,
  bytesLabel,
} from "../server/src/util/limits";
import type { ServerConfig } from "../server/src/config";
import type { FastifyInstance } from "fastify";

const requireFromServer = createRequire(path.resolve("server/src/index.ts"));
const Fastify = requireFromServer("fastify") as (opts?: Record<string, unknown>) => FastifyInstance;
const multipartPlugin = requireFromServer("@fastify/multipart");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue151-"));
const SECRET = "test-secret-151";
const parentId = "parent-151";
const config: ServerConfig = { port: 8788, upstreamBase: "", jwtSecret: SECRET, tokenTtlDays: 7, dataDir };
const db = openDb(dataDir);
const serverSecret = getServerSecret(dataDir);

let app: FastifyInstance;
let jwt = "";
let apiKey = "";
let baseUrl = "";

function makeJunkBytes(bytes: number): Buffer {
  // 伪音频（非 wav 头也行——413 在格式探测/ASR 调用之前拦截）
  return Buffer.alloc(bytes, 0x61);
}

beforeAll(async () => {
  app = Fastify({ logger: false, bodyLimit: JSON_BODY_LIMIT });
  db.prepare("INSERT INTO parents (id, email, created_at, updated_at) VALUES (?,?,?,?)").run(
    parentId,
    "p151@test.io",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z"
  );
  void (app as any).register(multipartPlugin, { limits: { fileSize: Infinity } }); // 生产同款：存储类不限
  registerApiKeysRoutes(app as any, { config, db } as any);
  registerOpenApiRoutes(app as any, { config, db } as any);
  registerAsrRoutes(app as any, { config, db } as any);
  await app.ready();

  jwt = signSession({ parent_id: parentId, email: "p151@test.io", plan: "pro" }, SECRET, 7);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/apikeys",
    headers: { Authorization: `Bearer ${jwt}` },
    payload: { label: "t151" },
  });
  apiKey = ((created.json() as any).secret || "") as string;
  expect(apiKey).toBeTruthy();

  // inject 的手工 multipart 构造有 CRLF 坑——改真监听 + 原生 fetch/FormData
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  try {
    await app.close();
  } catch {
    /* ignore */
  }
});

describe("ISSUE-151 限制常量（拍板值锁定）", () => {
  it("外发类 20MB/20MB/10MB、JSON body 16MB；bytesLabel 可读", () => {
    expect(ASR_AUDIO_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(ASSESS_AUDIO_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(VISION_IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(JSON_BODY_LIMIT).toBe(16 * 1024 * 1024);
    expect(bytesLabel(20 * 1024 * 1024)).toBe("20MB");
    expect(bytesLabel(512 * 1024)).toBe("512KB");
  });
});

describe("ISSUE-151 外发类入口 413", () => {
  it("/asr/transcribe：>20MB multipart → 413 带可读文案（原生 FormData）", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([makeJunkBytes(ASR_AUDIO_MAX_BYTES + 1024)], { type: "audio/wav" }), "big.wav");
    const res = await fetch(`${baseUrl}/api/v1/asr/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: fd,
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("外发限制");
  });

  it("/open/agent/voice：>20MB 裸流 → 413（API Key 鉴权后、外发前拦截）", async () => {
    const res = await fetch(`${baseUrl}/api/v1/open/agent/voice?filename=big.wav`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "audio/wav" },
      body: makeJunkBytes(ASR_AUDIO_MAX_BYTES + 1024),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("外发限制");
  });
});
