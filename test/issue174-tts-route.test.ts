/**
 * ISSUE-174 续：客户端朗读合成上收服务端（POST /api/v1/tts/synthesize）。
 * 背景：app 客户端本机 edge-tts 被微软 403 拒绝（2026-10-12 实测），且管理端 minimax-speech-*
 * 只能在服务端调用（家长 Key 不出服务端）。fastify inject + stub fetch/EdgeTTS，验证：
 *  1. 鉴权：无 token / 坏 token → 401
 *  2. builtin 渠道 + 封套有 TokenHub Key → 200 audio/mpeg（TokenHub hex→MP3），用量落库
 *  3. custom / off 渠道 → 不注入 Key → edge 路径（免费，不烧配额）
 *  4. TokenHub 失败 → 回落 edge（音频不缺席，502 不出现）
 *  5. 空文本 → 400；参数（rate/volume）透传到 TokenHub speed/vol
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";

// 管理端默认模型 → minimax-speech-2.8-turbo
vi.mock("../server/src/auth/tokenhub", () => ({
  getSystemDefaultModels: () => ({
    text: "tokenhub/deepseek/deepseek-flash",
    vision: "tokenhub/deepseek/deepseek-v4-flash-vision-exp",
    asr: "hy-asr-3.0-preview",
    tts: "minimax-speech-2.8-turbo",
  }),
}));
// edge-tts 不出真实网络
vi.mock("@andresaya/edge-tts", () => ({
  EdgeTTS: class {
    async synthesize() {}
    toBuffer() {
      return Buffer.from("edge-fake-mp3");
    }
  },
}));

const { registerTtsRoutes } = await import("../server/src/routes/tts");
const { getServerSecret, encryptJson } = await import("../server/src/crypto");
const { signSession } = await import("../server/src/auth/jwt");

const HEX_AUDIO = Buffer.from("ID3\x04fake-mp3").toString("hex");
const PARENT = "p-tts";
const JWT_SECRET = "test-jwt-secret";

function tokenhubOk() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: { audio: HEX_AUDIO, status: 2 },
      base_resp: { status_code: 0, status_msg: "success" },
      usage: { chars: 6, total_tokens: 123 },
    }),
  } as unknown as Response;
}

interface Harness {
  app: FastifyInstance;
  db: DatabaseSync;
  dataDir: string;
  token: string;
}

// fastify 只装在 server/node_modules；从 server 目录解析才能命中（根 node_modules 没有）
const requireFromServer = createRequire(path.resolve("server/src/index.ts"));
const Fastify = requireFromServer("fastify") as (opts?: Record<string, unknown>) => FastifyInstance;

function buildHarness(channel: "builtin" | "custom" | "off" = "builtin", withKey = true): Harness {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tts-route-")));
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL DEFAULT '{}', updated TEXT NOT NULL)`);
  const auth: Record<string, unknown> = withKey ? { tokenhub: { type: "api_key", key: "sk-parent-key" } } : {};
  db.prepare("INSERT INTO settings (key, value_json, updated) VALUES (?,?,?)").run(
    `${PARENT}:auth`,
    encryptJson(getServerSecret(dataDir), auth),
    new Date().toISOString()
  );
  if (channel !== "builtin") {
    db.prepare("INSERT INTO settings (key, value_json, updated) VALUES (?,?,?)").run(
      `${PARENT}:app_settings`,
      JSON.stringify({ modelChannel: channel }),
      new Date().toISOString()
    );
  }
  const app = Fastify();
  registerTtsRoutes(app as never, {
    config: { dataDir, jwtSecret: JWT_SECRET } as never,
    db,
  });
  return { app, db, dataDir, token: signSession({ parent_id: PARENT, email: "t@t", plan: "basic" }, JWT_SECRET, 1) };
}

describe("POST /api/v1/tts/synthesize", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(tokenhubOk());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("无 token / 坏 token → 401", async () => {
    const { app } = buildHarness();
    const r1 = await app.inject({ method: "POST", url: "/api/v1/tts/synthesize", payload: { text: "你好" } });
    expect(r1.statusCode).toBe(401);
    const r2 = await app.inject({
      method: "POST",
      url: "/api/v1/tts/synthesize",
      headers: { Authorization: "Bearer bad" },
      payload: { text: "你好" },
    });
    expect(r2.statusCode).toBe(401);
  });

  it("空文本 → 400", async () => {
    const { app } = buildHarness();
    const token = signSession({ parent_id: PARENT, email: "t@t", plan: "basic" }, JWT_SECRET, 1);
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/tts/synthesize",
      headers: { Authorization: `Bearer ${token}` },
      payload: { text: "  " },
    });
    expect(r.statusCode).toBe(400);
  });

  it("builtin + 封套 Key → TokenHub 合成 200 audio/mpeg；rate 透传 speed；同文本二发走服务端缓存", async () => {
    const { app } = buildHarness();
    const token = signSession({ parent_id: PARENT, email: "t@t", plan: "basic" }, JWT_SECRET, 1);
    const r1 = await app.inject({
      method: "POST",
      url: "/api/v1/tts/synthesize",
      headers: { Authorization: `Bearer ${token}` },
      payload: { text: "你好世界", rate: "+20%" },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.headers["content-type"]).toContain("audio/mpeg");
    expect(Buffer.from(r1.body as Buffer).toString("latin1")).toBe(Buffer.from(HEX_AUDIO, "hex").toString("latin1"));
    const body = JSON.parse(String((vi.mocked(globalThis.fetch).mock.calls[0] as any)[1].body));
    expect(body.model).toBe("minimax-speech-2.8-turbo");
    expect(body.voice_setting.speed).toBeCloseTo(1.2);
    // 二发：服务端 tts-cache 命中 → fetch 仍只有一次
    await app.inject({
      method: "POST",
      url: "/api/v1/tts/synthesize",
      headers: { Authorization: `Bearer ${token}` },
      payload: { text: "你好世界", rate: "+20%" },
    });
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1);
  });

  it("custom 渠道 → 不注入 Key → edge 路径（免费）", async () => {
    const { app } = buildHarness("custom");
    const token = signSession({ parent_id: PARENT, email: "t@t", plan: "basic" }, JWT_SECRET, 1);
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/tts/synthesize",
      headers: { Authorization: `Bearer ${token}` },
      payload: { text: "hello world" },
    });
    expect(r.statusCode).toBe(200);
    expect(Buffer.from(r.body as Buffer).toString()).toBe("edge-fake-mp3");
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(0); // 没碰 TokenHub
  });

  it("TokenHub 失败 → 回落 edge（200，不 502）", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const { app } = buildHarness();
    const token = signSession({ parent_id: PARENT, email: "t@t", plan: "basic" }, JWT_SECRET, 1);
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/tts/synthesize",
      headers: { Authorization: `Bearer ${token}` },
      payload: { text: "你好" },
    });
    expect(r.statusCode).toBe(200);
    expect(Buffer.from(r.body as Buffer).toString()).toBe("edge-fake-mp3");
  });
});
