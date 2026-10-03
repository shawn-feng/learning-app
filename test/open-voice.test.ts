/**
 * 开放 API 语音功能回归（2026-09-29）：
 * - POST /open/agent/voice：缺音频 400、未启用 400、假 key 真网 502（聚合错误，与 /asr/transcribe 同源）；
 * - chat 的 tts 参数形状（失败轮不带 audio）；
 * - GET /open/files/:id 下载鉴权（API Key、归属）；
 * - TTS 纯函数（cleanTtsText / detectVoice）。
 * ASR 聚合链与 routes/asr.ts 同源（transcribeWithFallback），改造回归由 issue165 / qwen-asr 套件覆盖。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openDb } from "../server/src/db";
import { registerApiKeysRoutes } from "../server/src/routes/apikeys";
import { registerOpenApiRoutes } from "../server/src/routes/open-api";
import { signSession } from "../server/src/auth/jwt";
import { defaultAsrConfig, writeAsrConfig } from "../server/src/asr/config";
import { getServerSecret } from "../server/src/crypto";
import { cleanTtsText, detectVoice } from "../server/src/tts/index";
import type { ServerConfig } from "../server/src/config";
import type { FastifyInstance } from "fastify";

// fastify 只装在 server/node_modules；从 server 目录解析才能命中（根 node_modules 没有）。
const requireFromServer = createRequire(path.resolve("server/src/index.ts"));
const Fastify = requireFromServer("fastify") as (opts?: Record<string, unknown>) => FastifyInstance;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openvoice-"));
const SECRET = "test-secret-openvoice";
const parentId = "parent-openvoice";
const childId = "child-openvoice";
const config: ServerConfig = { port: 8788, upstreamBase: "", jwtSecret: SECRET, tokenTtlDays: 7, dataDir };
const db = openDb(dataDir);
const serverSecret = getServerSecret(dataDir);

let app: FastifyInstance;
let jwt = "";
let apiKey = "";

/** 构造合法 16k/单声道/16bit WAV（秒数秒的静音），能通过 ffmpeg 转码 */
function makeWav16k(seconds = 1): Buffer {
  const sampleRate = 16000;
  const samples = sampleRate * seconds;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

beforeAll(async () => {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(parentId, "ov@test", now, now);
  db.prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(childId, parentId, "闻闻", now, now);
  jwt = signSession({ parent_id: parentId, email: "ov@test", plan: "" }, SECRET, 7);
  app = Fastify({ logger: false });
  registerApiKeysRoutes(app, { config, db });
  registerOpenApiRoutes(app, { config, db });
  await app.ready();
  const create = await app.inject({
    method: "POST",
    url: "/api/v1/apikeys",
    headers: { authorization: `Bearer ${jwt}` },
    payload: { child_id: childId },
  });
  apiKey = create.json().secret;
});

afterAll(async () => {
  await app.close();
});

describe("TTS 纯函数", () => {
  it("cleanTtsText 去 markdown/emoji、保留标点", () => {
    expect(cleanTtsText("**你好**，世界！ 🎉")).toBe("你好，世界！");
    expect(cleanTtsText("# 标题\n- 列表项")).toBe("标题\n列表项");
    expect(cleanTtsText("[链接文字](http://x.com)")).toBe("链接文字");
  });
  it("detectVoice 中英文分流量", () => {
    expect(detectVoice("你好，今天天气不错")).toBe("zh-CN-XiaoxiaoNeural");
    expect(detectVoice("Hello world, this is english")).toBe("en-GB-SoniaNeural");
  });

  it("synthesizeReply 带 sampleRate → 48k 16bit 单声道 WAV（真连 edge-tts）", async () => {
    const { synthesizeReply } = await import("../server/src/tts/index");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-rate-"));
    const r = await synthesizeReply("你好", { sampleRate: 48000 }, dataDir);
    expect(r.mime).toBe("audio/wav");
    // RIFF 头校验：采样率字段位于 offset 24（LE）
    expect(r.buffer.toString("ascii", 0, 4)).toBe("RIFF");
    expect(r.buffer.readUInt32LE(24)).toBe(48000);
    expect(r.buffer.readUInt16LE(22)).toBe(1); // 单声道
  }, 60000);
});

describe("POST /open/agent/voice", () => {
  it("缺少音频 → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/open/agent/voice",
      headers: { "x-api-key": apiKey, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(0),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("缺少音频");
  });

  it("fmt=pcm 缺 sample_rate → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/open/agent/voice?fmt=pcm",
      headers: { "x-api-key": apiKey, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(96000),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("sample_rate");
  });

  it("48k 裸 PCM 直传（fmt=pcm&sample_rate=48000）→ 服务端转码后进 ASR 链（未启用 400）", async () => {
    // ESP32 零重配置场景：设备固定 48k 编解码配置，录音 48k 裸 PCM 直传
    const pcm48k = Buffer.alloc(48000 * 2); // 1 秒 48k/16bit/单声道静音
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/open/agent/voice?fmt=pcm&sample_rate=48000",
      headers: { "x-api-key": apiKey, "content-type": "application/octet-stream" },
      payload: pcm48k,
    });
    // 转码成功才会走到 ASR 配置检查（默认 enabled=false → 语音输入未启用）
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("语音输入未启用");
  }, 30000);

  it("ASR 未启用 → 400（配置检查在转码前也拦得住：默认 enabled=false）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/open/agent/voice",
      headers: { "x-api-key": apiKey, "content-type": "audio/wav" },
      payload: makeWav16k(1),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("语音输入未启用");
  }, 30000);

  it("假 key 真网 → 502 聚合错误（证明 multipart→转码→配置→provider 链路通）", async () => {
    const cfg = defaultAsrConfig();
    cfg.enabled = true;
    cfg.provider = "qwen";
    cfg.providers.qwen.apiKey = "sk-fake-openvoice-test";
    writeAsrConfig(db, serverSecret, parentId, cfg);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/open/agent/voice",
      headers: { "x-api-key": apiKey, "content-type": "audio/wav" },
      payload: makeWav16k(1),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("所有语音服务均识别失败");
  }, 60000);
});

describe("chat 的 tts 参数形状", () => {
  it("tts=true 但本轮失败：final 不带 audio（TTS 只对成功回复合成）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/open/agent/chat",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      payload: { text: "你好", tts: true, timeout_ms: 8000 },
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const final = lines[lines.length - 1];
    expect(final.type).toBe("final");
    // 测试环境无模型 → ok:false；此时绝不应出现 audio 字段
    expect(final.audio).toBeUndefined();
  }, 30000);
});

describe("GET /open/files/:id 下载", () => {
  it("裸流上传 → API Key 下载内容一致；坏 Key 401；陌生 id 404", async () => {
    const up = await app.inject({
      method: "POST",
      url: `/api/v1/open/files/raw?filename=probe.txt&child_id=${childId}`,
      headers: { "x-api-key": apiKey, "content-type": "application/octet-stream" },
      payload: Buffer.from("下载回归内容ABC"),
    });
    const { file, ref } = up.json();

    const dl = await app.inject({ method: "GET", url: `/api/v1/open/files/${file.id}`, headers: { "x-api-key": apiKey } });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe("下载回归内容ABC");
    expect(dl.headers["content-type"]).toBe("text/plain");

    const bad = await app.inject({ method: "GET", url: `/api/v1/open/files/${file.id}`, headers: { "x-api-key": "laxk_bad" } });
    expect(bad.statusCode).toBe(401);

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/open/files/00000000-0000-4000-8000-000000000000",
      headers: { "x-api-key": apiKey },
    });
    expect(missing.statusCode).toBe(404);
    void ref;
  });
});
