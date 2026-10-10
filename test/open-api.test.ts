/**
 * 开放 API（API Key）回归（2026-09-28）：
 * - apikeys 管理组：生命周期（生成/查询/按 id 吊销/再生成）、多键制（可并存、上限 409）、完整 Key 不回显；
 * - open 组：Key 鉴权（无/坏/吊销 → 401）、child 归属（403/400）、prompt 校验（400）；
 * - chat 的 NDJSON 形状契约（progress…final 行）——未配置模型时终态就是 ok:false 的 final 行，
 *   正好锁住"最后一行必为 final"的协议；
 * - files/raw 裸流上传 + marker 格式逐字校验。
 * 与 issue135-exam-routes 同套路：真 fastify + 真 sqlite + 真 JWT；不建真实 agent 会话（无模型）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openDb } from "../server/src/db";
import { registerApiKeysRoutes } from "../server/src/routes/apikeys";
import { registerOpenApiRoutes, attachTtsAudioToMessages } from "../server/src/routes/open-api";
import { signSession } from "../server/src/auth/jwt";
import type { ServerConfig } from "../server/src/config";
import type { FastifyInstance } from "fastify";

// fastify 只装在 server/node_modules；从 server 目录解析才能命中（根 node_modules 没有）。
const requireFromServer = createRequire(path.resolve("server/src/index.ts"));
const Fastify = requireFromServer("fastify") as (opts?: Record<string, unknown>) => FastifyInstance;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openapi-"));
const SECRET = "test-secret-openapi";
const parentId = "parent-openapi";
const otherParentId = "parent-openapi-other";
const childId = "child-openapi";
const otherChildId = "child-openapi-other";

const config: ServerConfig = { port: 8788, upstreamBase: "", jwtSecret: SECRET, tokenTtlDays: 7, dataDir };
const db = openDb(dataDir);

let app: FastifyInstance;
let jwt = "";
let apiKey = ""; // 当前有效键（未绑定默认孩子，请求显式带 child_id）
let revokedKey = ""; // 已吊销键（测 401）

beforeAll(async () => {
  const now = new Date().toISOString();
  for (const [pid, email] of [
    [parentId, "oa@test"],
    [otherParentId, "oa2@test"],
  ]) {
    db.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(pid, email, now, now);
  }
  db.prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(childId, parentId, "珊珊", now, now);
  db.prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(otherChildId, otherParentId, "别人家孩子", now, now);
  jwt = signSession({ parent_id: parentId, email: "oa@test", plan: "" }, SECRET, 7);
  app = Fastify({ logger: false });
  registerApiKeysRoutes(app, { config, db });
  registerOpenApiRoutes(app, { config, db });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function auth(key: string) {
  return { authorization: `Bearer ${key}` };
}

describe("apikeys 管理组（家长 JWT，多键制）", () => {
  it("无 JWT → 401；有 JWT 初始无键", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/apikeys" })).statusCode).toBe(401);
    const res = await app.inject({ method: "GET", url: "/api/v1/apikeys", headers: auth(jwt) });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys).toEqual([]);
  });

  it("生成：一次性返回完整 Key（laxk_ 前缀 + prefix 12 位）；可并存多把；查询永不回完整 Key；按 id 吊销", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/apikeys",
      headers: auth(jwt),
      payload: { child_id: childId, label: "硬件" },
    });
    expect(create.statusCode).toBe(200);
    const { key, secret } = create.json();
    expect(secret.startsWith("laxk_")).toBe(true);
    expect(secret.length).toBeGreaterThan(40);
    expect(key.prefix).toHaveLength(12);
    expect(secret.startsWith(key.prefix)).toBe(true);

    // 多键制：再生成一把不报 409
    const create2 = await app.inject({ method: "POST", url: "/api/v1/apikeys", headers: auth(jwt), payload: {} });
    expect(create2.statusCode).toBe(200);
    apiKey = create2.json().secret;

    const list = await app.inject({ method: "GET", url: "/api/v1/apikeys", headers: auth(jwt) });
    expect(list.statusCode).toBe(200);
    const keys = list.json().keys;
    expect(keys).toHaveLength(2);
    expect(keys.map((k: { prefix: string }) => k.prefix)).toContain(key.prefix);
    expect(JSON.stringify(list.json())).not.toContain(secret);
    revokedKey = secret;

    // 吊销：不带 id → 400；带 id → 200；重复吊销同一把 → 404；另一把不受影响
    const delNoId = await app.inject({ method: "DELETE", url: "/api/v1/apikeys", headers: auth(jwt) });
    expect(delNoId.statusCode).toBe(400);
    const del = await app.inject({ method: "DELETE", url: `/api/v1/apikeys?id=${key.id}`, headers: auth(jwt) });
    expect(del.statusCode).toBe(200);
    const delAgain = await app.inject({ method: "DELETE", url: `/api/v1/apikeys?id=${key.id}`, headers: auth(jwt) });
    expect(delAgain.statusCode).toBe(404);
    const listAfter = await app.inject({ method: "GET", url: "/api/v1/apikeys", headers: auth(jwt) });
    expect(listAfter.json().keys).toHaveLength(1);
  });

  it("child_id 不归属 → 403；有效键达上限 → 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/apikeys",
      headers: auth(jwt),
      payload: { child_id: otherChildId },
    });
    expect(res.statusCode).toBe(403);

    // 当前有效 1 把（上限 10）：补到上限后再生成 → 409；吊销一把后恢复可生成
    for (let i = 0; i < 9; i++) {
      const r = await app.inject({ method: "POST", url: "/api/v1/apikeys", headers: auth(jwt), payload: {} });
      expect(r.statusCode).toBe(200);
    }
    const overflow = await app.inject({ method: "POST", url: "/api/v1/apikeys", headers: auth(jwt), payload: {} });
    expect(overflow.statusCode).toBe(409);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/apikeys?id=${(await app.inject({ method: "GET", url: "/api/v1/apikeys", headers: auth(jwt) })).json().keys[0].id}`,
      headers: auth(jwt),
    });
    expect(del.statusCode).toBe(200);
    // 吊销的 keys[0] 可能正是 apiKey 指向的键——重建一把并把 apiKey 指过去，供后续 open 组使用
    const recreate = await app.inject({ method: "POST", url: "/api/v1/apikeys", headers: auth(jwt), payload: {} });
    expect(recreate.statusCode).toBe(200);
    apiKey = recreate.json().secret;
  });
});

describe("open 组鉴权", () => {
  it("无 Key / 坏 Key / 已吊销 Key → 401（status、chat、stream 一致）", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/open/agent/status"],
      ["POST", "/api/v1/open/agent/chat"],
      ["GET", "/api/v1/open/agent/stream"],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
      expect((await app.inject({ method, url, headers: auth("laxk_totallywrong") })).statusCode).toBe(401);
      expect((await app.inject({ method, url, headers: auth(revokedKey) })).statusCode).toBe(401);
    }
  });

  it("X-API-Key 头同样可用", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/open/agent/status?child_id=${childId}`,
      headers: { "x-api-key": apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ busy: false, child_id: childId });
  });
});

describe("open 组参数校验", () => {
  it("Key 未绑定默认孩子且请求不带 child_id → 400", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/open/agent/status", headers: auth(apiKey) })).statusCode).toBe(400);
  });

  it("别人的孩子 → 403", async () => {
    for (const url of [
      `/api/v1/open/agent/status?child_id=${otherChildId}`,
      `/api/v1/open/agent/history?child_id=${otherChildId}`,
    ]) {
      expect((await app.inject({ method: "GET", url, headers: auth(apiKey) })).statusCode).toBe(403);
    }
  });

  it("chat：text 与 attachments 全空 / kind 非法 / ref 非法 → 400", async () => {
    const post = (payload: unknown) =>
      app.inject({ method: "POST", url: "/api/v1/open/agent/chat", headers: auth(apiKey), payload });
    expect((await post({ text: "  ", child_id: childId })).statusCode).toBe(400);
    expect((await post({ text: "hi", attachments: [{ kind: "video", name: "x", ref: "files/x" }], child_id: childId })).statusCode).toBe(400);
    expect((await post({ text: "hi", attachments: [{ kind: "image", name: "x", ref: "materials/evil" }], child_id: childId })).statusCode).toBe(400);
  });
});

describe("chat NDJSON 快照流形状", () => {
  it("200 + application/x-ndjson；每行合法 JSON；最后一行 type=final", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/open/agent/chat",
      headers: auth(apiKey),
      payload: { text: "你好", child_id: childId, timeout_ms: 8000 },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("application/x-ndjson");
    const lines = res.body.split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = lines.map((l) => JSON.parse(l));
    const last = parsed[parsed.length - 1];
    expect(last.type).toBe("final");
    expect(typeof last.ok).toBe("boolean");
    // 未配置模型：终态应为 ok:false + error（不依赖模型，正好锁协议）
    expect(last.ok).toBe(false);
    expect(String(last.error).length).toBeGreaterThan(0);
  }, 30000);
});

describe("files/raw 裸流上传", () => {
  it("上传 → files 表登记 + ref/marker 格式正确；ref 可随 chat 通过校验", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/open/files/raw?filename=rec.wav&child_id=${childId}`,
      headers: { ...auth(apiKey), "content-type": "audio/wav" },
      payload: Buffer.from("RIFF....WAVEfmt fake"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ref).toMatch(/^files\/[0-9a-f-]{36}$/);
    expect(body.marker).toBe(`【附件音频：rec.wav|${body.ref}】`);
    expect(body.file.mime).toBe("audio/wav");
    expect(body.file.size).toBeGreaterThan(0);

    const row = db.prepare("SELECT stored_path, child_id FROM files WHERE id = ?").get(body.ref.slice("files/".length)) as any;
    expect(row.child_id).toBe(childId);
    expect(fs.existsSync(path.join(dataDir, "workspaces", parentId, childId, "uploads", row.stored_path))).toBe(true);

    // 合法 ref 通过 buildPrompt 校验（后续因无模型收 ok:false 的 final 行，不 400）
    const chat = await app.inject({
      method: "POST",
      url: "/api/v1/open/agent/chat",
      headers: auth(apiKey),
      payload: { text: "听听这段录音", attachments: [{ kind: "audio", name: "rec.wav", ref: body.ref }], child_id: childId, timeout_ms: 8000 },
    });
    expect(chat.statusCode).toBe(200);
    const lines = chat.body.split("\n").filter((l) => l.trim());
    expect(JSON.parse(lines[lines.length - 1]).type).toBe("final");
  }, 30000);
});

describe("attachTtsAudioToMessages（history TTS 回填）", () => {
  const base = 1_700_000_000_000;
  const msg = (role: string, ts: number) => ({ role, content: [{ type: "text", text: "x" }], timestamp: ts });

  it("回复的音频落在 [本回复, 下一回复) 窗口内 → 回填；否则不回填", () => {
    const messages = [
      msg("user", base),
      msg("assistant", base + 1000), // 回复A：窗口 [A, B)
      msg("user", base + 60_000),
      msg("assistant", base + 61_000), // 回复B：窗口 [B, ∞)
    ];
    const rows = [
      { file_id: "a-file", turn_at: new Date(base + 2000).toISOString(), voice: "v", sample_rate: 16000, mime: "audio/wav", size: 111 },
      { file_id: "b-file", turn_at: new Date(base + 62_000).toISOString(), voice: "v", sample_rate: null, mime: "audio/wav", size: 222 },
    ];
    attachTtsAudioToMessages(messages, rows);
    expect((messages[1] as any).audio.url).toBe("/api/v1/open/files/a-file");
    expect((messages[1] as any).audio.sample_rate).toBe(16000);
    expect((messages[3] as any).audio.url).toBe("/api/v1/open/files/b-file");
    expect((messages[3] as any).audio.sample_rate).toBeUndefined();
    expect((messages[0] as any).audio).toBeUndefined();
  });

  it("一回复多条登记只取最早一条；无 timestamp 的 assistant 消息跳过、不充当窗口右界", () => {
    const messages = [
      msg("assistant", base), // 窗口 [base, base+120s)
      msg("assistant", base + 120_000), // 窗口 [base+120s, ∞)（后面无有时间戳的回复）
      { role: "assistant", content: [{ type: "text", text: "x" }] }, // 无 timestamp → 本身跳过，也不截断前一个窗口
    ];
    const rows = [
      { file_id: "late", turn_at: new Date(base + 300_000).toISOString(), voice: "v", sample_rate: null, mime: "audio/wav", size: 3 },
      { file_id: "early-1", turn_at: new Date(base + 1000).toISOString(), voice: "v", sample_rate: null, mime: "audio/wav", size: 1 },
      { file_id: "early-2", turn_at: new Date(base + 2000).toISOString(), voice: "v", sample_rate: null, mime: "audio/wav", size: 2 },
    ];
    attachTtsAudioToMessages(messages, rows);
    expect((messages[0] as any).audio.url).toBe("/api/v1/open/files/early-1");
    expect((messages[1] as any).audio.url).toBe("/api/v1/open/files/late");
    expect((messages[2] as any).audio).toBeUndefined();
  });
});
