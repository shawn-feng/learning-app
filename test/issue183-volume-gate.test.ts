/**
 * ISSUE-183 需求 A 回归：考核录音平均音量服务端兜底（/assessment/assess 评测前校验）。
 *
 * 客户端 iframe 已有前置校验（每段录完即校、不达标不入答案）；本兜底拦旧版客户端/绕过场景——
 * 评测前对合并音频整体再算一次平均音量（16k WAV 解码 PCM 的 RMS → 0-100 归一分），
 * 低于家长阈值（assessment 配置 minVolumeNorm，0=不校验）→ 422 + code=VOLUME_TOO_LOW 按未答拦下，不送评测引擎。
 *
 * 真 fastify + 真 sqlite + 真 WAV（本机 ffmpeg 转码链路）：quiet=-49dBFS→18 分 / loud=-17dBFS→72 分。
 * 音量关之后到达的下一处失败是「智聆配置不完整」（空凭证）——用它证明音频已过音量关、送进了评测。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openDb } from "../server/src/db";
import { registerAssessmentRoutes } from "../server/src/routes/assessment";
import { signSession } from "../server/src/auth/jwt";
import type { ServerConfig } from "../server/src/config";
import type { FastifyInstance } from "fastify";

const requireFromServer = createRequire(path.resolve("server/src/index.ts"));
const Fastify = requireFromServer("fastify") as (opts?: Record<string, unknown>) => FastifyInstance;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue183-vol-"));
const SECRET = "test-secret-183";
const parentId = "parent-r183";
const childId = "child-r183";
// ISSUE-191：第二个孩子——用于验证「没有单独设置 → 回退默认线」
const child2Id = "child-r183-b";

const mainDb = openDb(dataDir);
const config: ServerConfig = {
  port: 8788,
  upstreamBase: "",
  jwtSecret: SECRET,
  tokenTtlDays: 7,
  dataDir,
};

let app: FastifyInstance;
let token: string;

const QUIET = makeWav(0.005); // -49 dBFS → 18 分
const LOUD = makeWav(0.2); // -17 dBFS → 72 分

function seedAudio(id: string, stored: string, buf: Buffer, ownerChild: string = childId): void {
  const now = new Date().toISOString();
  mainDb
    .prepare(
      "INSERT INTO files (id, parent_id, child_id, original_name, stored_path, mime, size, created_at) VALUES (?,?,?,?,?,?,?,?)"
    )
    .run(id, parentId, ownerChild, stored, stored, "audio/wav", buf.length, now);
  const abs = path.join(dataDir, "workspaces", parentId, ownerChild, "uploads", stored);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}

async function saveConfig(patch: Record<string, unknown>): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/assessment/config",
    headers: { authorization: `Bearer ${token}` },
    payload: { enabled: false, providers: {}, ...patch },
  });
  expect(res.statusCode).toBe(200);
}

async function assessAs(
  ownerChild: string,
  fileId: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/assessment/assess",
    headers: { authorization: `Bearer ${token}` },
    payload: { childId: ownerChild, audioFileId: fileId, refText: "你好世界" },
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function assess(fileId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return assessAs(childId, fileId);
}

beforeAll(async () => {
  const now = new Date().toISOString();
  mainDb.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(parentId, "r183@test", now, now);
  mainDb
    .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(childId, parentId, "珊珊", now, now);
  mainDb
    .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(child2Id, parentId, "闻闻", now, now);
  seedAudio("file-quiet", "quiet.wav", QUIET);
  seedAudio("file-loud", "loud.wav", LOUD);
  seedAudio("file-quiet-2", "quiet2.wav", QUIET, child2Id);
  token = signSession({ parent_id: parentId, email: "r183@test", plan: "basic" }, SECRET, 7);
  app = Fastify();
  registerAssessmentRoutes(app, { config, db: mainDb });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  mainDb.close();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄可能延迟释放，忽略 */
  }
});

describe("ISSUE-183 录音平均音量服务端兜底", () => {
  it("阈值 42（默认档）：小声录音 → 422 VOLUME_TOO_LOW，按未答拦下且不送评测", async () => {
    await saveConfig({ enabled: true, minVolumeNorm: 42 });
    const r = await assess("file-quiet");
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.code).toBe("VOLUME_TOO_LOW");
    expect(r.body.volumeNorm).toBe(18);
    expect(r.body.minVolumeNorm).toBe(42);
    expect(String(r.body.error)).toContain("声音太小");
  });

  it("阈值 42：大声录音通过音量关（下一处失败是评测凭证，而非音量）", async () => {
    const r = await assess("file-loud");
    expect(r.status).toBe(502);
    expect(r.body.code).toBeUndefined();
    expect(String(r.body.error)).not.toContain("声音太小");
  });

  it("家长把阈值设为 0（关闭）→ 小声录音不再被音量关拦截", async () => {
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/assessment/config",
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: true, providers: {}, minVolumeNorm: 0 },
    });
    expect(saved.json().config.minVolumeNorm).toBe(0);
    const r = await assess("file-quiet");
    expect(r.status).not.toBe(422);
    expect(String(r.body.error)).not.toContain("声音太小");
  });

  it("评测未启用 → 不做音量校验（保持原「发音评测未启用」报错）", async () => {
    await saveConfig({ enabled: false, minVolumeNorm: 42 });
    const r = await assess("file-quiet");
    expect(r.status).toBe(502);
    expect(String(r.body.error)).toContain("发音评测未启用");
  });
});

// ISSUE-191：家长按孩子单独设置阈值后，服务端兜底按该孩子的线拦（不再所有孩子共用一条）。
describe("ISSUE-191 服务端兜底：按孩子阈值", () => {
  it("该孩子单独 60 → 小声(18)按 60 拦下（不是全局 42）", async () => {
    await saveConfig({ enabled: true, minVolumeNorm: 42, minVolumeNormByChild: { [childId]: 60 } });
    const r = await assess("file-quiet");
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.code).toBe("VOLUME_TOO_LOW");
    expect(r.body.minVolumeNorm).toBe(60);
  });

  it("该孩子显式设 0（关闭）→ 小声也不拦", async () => {
    await saveConfig({ enabled: true, minVolumeNorm: 42, minVolumeNormByChild: { [childId]: 0 } });
    const r = await assess("file-quiet");
    expect(r.status).not.toBe(422);
  });

  it("另一个孩子没有单独设置 → 回退默认线（默认 0 时小声也不拦）", async () => {
    await saveConfig({ enabled: true, minVolumeNorm: 0, minVolumeNormByChild: { [childId]: 60 } });
    const r = await assessAs(child2Id, "file-quiet-2");
    expect(r.status).not.toBe(422);
  });

  it("家长端试音（childId 为空）→ 不做音量校验", async () => {
    await saveConfig({ enabled: true, minVolumeNorm: 42, minVolumeNormByChild: { [childId]: 60 } });
    const r = await assessAs("", "file-quiet");
    expect(r.status).not.toBe(422);
    expect(String(r.body.error)).not.toContain("声音太小");
  });
});

/** 造 16kHz/单声道/16bit PCM WAV（0.25s 正弦波，指定峰值幅度），>2KB 过最短校验。 */
function makeWav(amplitude: number): Buffer {
  const rate = 16000;
  const seconds = 0.25;
  const samples = Math.floor(rate * seconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
