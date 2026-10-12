/**
 * ISSUE-174 TokenHub 统一模型接入回归：
 * ① provider 注册：tokenhub 在注册表（含 embedding 能力声明），兜底常量已切 tokenhub；
 * ② 模型选择收口：defaultModel/visionModel 仅 tokenhub 生效，旧 provider 遗留配置被忽略；
 * ③ Key 物化：ensureParentTokenHubKey 换取 → 合并进加密 auth 封套；同值跳过、变化更新；
 * ④ GET /tokenhub/quota：官方口径（remote）+ 本地口径（days）+ 未登录 401。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openDb } from "../server/src/db";
import { getServerSecret, decryptJson } from "../server/src/crypto";
import { registerModelRoutes } from "../server/src/routes/models";
import { ensureParentTokenHubKey } from "../server/src/auth/tokenhub";
import {
  PROVIDER_REGISTRATIONS,
  WORKER_DEFAULT_PROVIDER,
  WORKER_DEFAULT_MODEL,
  TOKENHUB_PROVIDER_ID,
  getProviderEmbedding,
  pickWorkerModel,
  pickVisionModel,
  firstCustomModelKey,
} from "@pi/agent-core";
import { signSession } from "../server/src/auth/jwt";
import type { ServerConfig } from "../server/src/config";
import type { FastifyInstance } from "fastify";

const requireFromServer = createRequire(path.resolve("server/src/index.ts"));
const Fastify = requireFromServer("fastify") as (opts?: Record<string, unknown>) => FastifyInstance;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue174-tokenhub-"));
const SECRET = "test-secret-174";
const parentId = "parent-r174";

const mainDb = openDb(dataDir);
const config: ServerConfig = {
  port: 8788,
  upstreamBase: "http://upstream.test",
  jwtSecret: SECRET,
  tokenTtlDays: 7,
  dataDir,
};

let app: FastifyInstance;
const token = signSession({ parent_id: parentId }, SECRET, 7);

// ---- 可编程 fetch 桩：模拟云端 benefit-auth /api/tokenhub/key|quota ----
let keyResponses: Array<{ status: number; body: unknown }> = [];
let quotaBody: unknown = {};
const fetchCalls: string[] = [];
const fetchStub = vi.fn(async (url: any, init?: any) => {
  const u = String(url);
  fetchCalls.push(u);
  if (u.includes("/api/tokenhub/key")) {
    const r = keyResponses.shift() ?? { status: 200, body: { apiKey: "sk-fixed", keyId: "ak-x" } };
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as any;
  }
  if (u.includes("/api/tokenhub/quota")) {
    return { ok: true, status: 200, json: async () => quotaBody } as any;
  }
  return { ok: false, status: 404, json: async () => ({}) } as any;
});

const stubRuntime = (table: Record<string, any>) =>
  ({
    getModel: (provider: string, modelId: string) => table[`${provider}/${modelId}`] ?? null,
  }) as any;

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchStub);
  mainDb
    .prepare("INSERT INTO parents (id, email, cloud_token, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run(parentId, "r174@test", "cloud-token-174", new Date().toISOString(), new Date().toISOString());
  app = Fastify({ logger: false });
  registerModelRoutes(app, { config, db: mainDb });
  await app.ready();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("ISSUE-174 ① provider 注册", () => {
  it("tokenhub 已注册且带 embedding 能力；兜底常量指向 tokenhub 统一模型", () => {
    const ids = PROVIDER_REGISTRATIONS.map(([pid]) => pid);
    expect(ids).toContain("tokenhub");
    const cap = getProviderEmbedding(TOKENHUB_PROVIDER_ID);
    expect(cap?.model).toBe("kinfra-text-embedding-0.6b");
    expect(cap?.dimensions).toBe(1024);
    expect(WORKER_DEFAULT_PROVIDER).toBe("tokenhub");
    expect(WORKER_DEFAULT_MODEL).toBe("deepseek/deepseek-flash");
  });

  it("tokenhub 模型清单含文本与视觉模型", () => {
    const models = PROVIDER_REGISTRATIONS.find(([pid]) => pid === "tokenhub")?.[1].models ?? [];
    const ids = models.map((m) => m.id);
    expect(ids).toContain("deepseek/deepseek-flash");
    expect(ids).toContain("deepseek/deepseek-v4-flash-vision-exp");
  });
});

describe("ISSUE-174 ② 模型选择（2026-10-10 渠道互斥版：builtin 只用 tokenhub / custom 只用自定义）", () => {
  const table = {
    "tokenhub/deepseek/deepseek-flash": { name: "text" },
    "tokenhub/deepseek/deepseek-v4-flash-vision-exp": { name: "vision" },
    "moyu/DeepSeek-V4.1-flash": { name: "legacy" },
    "qwen/qwen3-vl-flash": { name: "legacy-vision" },
  };
  const authNoKey = { qwen: { type: "api_key", key: "" } };
  const authWithKey = {
    moyu: { type: "api_key", key: "sk-moyu" },
    qwen: { type: "api_key", key: "sk-qwen" },
  };

  it("defaultModel 指向自定义 provider 但未配 Key → 忽略，走 tokenhub 默认", () => {
    expect(pickWorkerModel(stubRuntime(table), { defaultModel: "moyu/DeepSeek-V4.1-flash" })).toEqual({ name: "text" });
    expect(pickWorkerModel(stubRuntime(table), { defaultModel: "moyu/DeepSeek-V4.1-flash" }, authNoKey)).toEqual({ name: "text" });
  });

  it("渠道互斥（2026-10-10 拍板）：builtin 渠道即使自定义 Key 已配也忽略；custom 渠道才生效", () => {
    // 默认渠道（builtin）：自定义模型整体停用，即使 Key 已配置
    expect(pickWorkerModel(stubRuntime(table), { defaultModel: "moyu/DeepSeek-V4.1-flash" }, authWithKey)).toEqual({
      name: "text",
    });
    // 显式 custom 渠道：自定义默认生效
    expect(
      pickWorkerModel(stubRuntime(table), { modelChannel: "custom", defaultModel: "moyu/DeepSeek-V4.1-flash" }, authWithKey)
    ).toEqual({ name: "legacy" });
    // custom 渠道：tokenhub 默认被忽略 → 回落第一个已配 Key 的自定义 provider 首模型（注册表序）
    const fb = firstCustomModelKey(authWithKey)!;
    table[`${fb.provider}/${fb.modelId}`] ??= { name: "legacy-fb" };
    expect(
      pickWorkerModel(stubRuntime(table), { modelChannel: "custom", defaultModel: "tokenhub/deepseek/deepseek-flash" }, authWithKey)
    ).toEqual(table[`${fb.provider}/${fb.modelId}`]);
  });

  it("defaultModel 指向 tokenhub → 恒生效（无需 Key）", () => {
    expect(
      pickWorkerModel(stubRuntime(table), { defaultModel: "tokenhub/deepseek/deepseek-v4-flash-vision-exp" }, undefined)
    ).toEqual({ name: "vision" });
  });

  it("无 defaultModel → tokenhub 默认", () => {
    expect(pickWorkerModel(stubRuntime(table), {})).toEqual({ name: "text" });
    expect(pickWorkerModel(stubRuntime(table), undefined, authWithKey)).toEqual({ name: "text" });
  });

  it("systemDefault（管理端四下拉下发）：无用户默认时生效；用户默认优先；不可用项回落内置", () => {
    expect(
      pickWorkerModel(stubRuntime(table), {}, undefined, "tokenhub/deepseek/deepseek-v4-flash-vision-exp")
    ).toEqual({ name: "vision" });
    expect(
      pickWorkerModel(stubRuntime(table), { defaultModel: "tokenhub/deepseek/deepseek-flash" }, undefined, "tokenhub/deepseek/deepseek-v4-flash-vision-exp")
    ).toEqual({ name: "text" });
    // systemDefault 指向自定义 provider（builtin 渠道）→ 忽略 → 内置 tokenhub 默认
    expect(pickWorkerModel(stubRuntime(table), {}, undefined, "moyu/DeepSeek-V4.1-flash")).toEqual({ name: "text" });
    expect(
      pickVisionModel(stubRuntime(table), {}, undefined, "tokenhub/deepseek/deepseek-flash")
    ).toEqual({ name: "text" });
  });

  it("visionModel：qwen 未配 Key → tokenhub 视觉默认；custom 渠道配了 Key → 生效；tokenhub 值 builtin 恒生效", () => {
    expect(pickVisionModel(stubRuntime(table), { visionModel: "qwen/qwen3-vl-flash" })).toEqual({ name: "vision" });
    // builtin 渠道：qwen 视觉模型即使配了 Key 也忽略（渠道互斥）
    expect(pickVisionModel(stubRuntime(table), { visionModel: "qwen/qwen3-vl-flash" }, authWithKey)).toEqual({
      name: "vision",
    });
    // custom 渠道：qwen 视觉模型生效（注册表 qwen 有 image 模型，回落链取 qwen 首个 image 模型）
    expect(
      pickVisionModel(stubRuntime(table), { modelChannel: "custom", visionModel: "qwen/qwen3-vl-flash" }, authWithKey)
    ).toEqual({ name: "legacy-vision" });
    expect(pickVisionModel(stubRuntime(table), { visionModel: "tokenhub/deepseek/deepseek-flash" }, undefined)).toEqual({
      name: "text",
    });
    expect(pickVisionModel(stubRuntime(table), {}, authWithKey)).toEqual({ name: "vision" });
  });
});

describe("ISSUE-174 ③ Key 物化", () => {
  it("换取 → 合并进加密 auth 封套；重复换取同值不写；云端换新 Key → 轮换更新", async () => {
    keyResponses = [
      { status: 200, body: { apiKey: "sk-tokenhub-aaa", keyId: "ak-1", quota: { cycleUnit: "d", cycleCredits: 5000000, cycleUsed: 0, quotaStatus: "active", keyStatus: "enable" } } },
      { status: 200, body: { apiKey: "sk-tokenhub-aaa", keyId: "ak-1" } },
      { status: 200, body: { apiKey: "sk-tokenhub-bbb", keyId: "ak-2" } },
    ];
    expect(await ensureParentTokenHubKey(config, mainDb, parentId)).toBe(true);
    const secret = getServerSecret(dataDir);
    const row = mainDb.prepare("SELECT value_json FROM settings WHERE key = ?").get(`${parentId}:auth`) as any;
    const auth = decryptJson(secret, row.value_json) as Record<string, any>;
    expect(auth.tokenhub).toEqual({ type: "api_key", key: "sk-tokenhub-aaa" });

    expect(await ensureParentTokenHubKey(config, mainDb, parentId)).toBe(false); // 同值跳过

    expect(await ensureParentTokenHubKey(config, mainDb, parentId)).toBe(true); // 云端换新 → 轮换
    const row2 = mainDb.prepare("SELECT value_json FROM settings WHERE key = ?").get(`${parentId}:auth`) as any;
    const auth2 = decryptJson(secret, row2.value_json) as Record<string, any>;
    expect(auth2.tokenhub.key).toBe("sk-tokenhub-bbb");
  });
});

describe("ISSUE-174 ④ /tokenhub/quota 路由", () => {
  it("未登录 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/tokenhub/quota" });
    expect(res.statusCode).toBe(401);
  });

  it("官方口径 + 本地口径聚合返回；不含 Key 明文", async () => {
    quotaBody = {
      keyMasked: "sk-to****bbb",
      quota: { cycleUnit: "d", cycleCredits: 5000000, cycleUsed: 1234, quotaStatus: "active", keyStatus: "enable" },
      defaultDailyCredits: 5000000,
    };
    // 种一条本地用量（内置模型——自定义模型不计入配额，见 issue174-model-channel 测试）
    mainDb
      .prepare(
        `INSERT INTO token_usage (parent_id, session_file, entry_id, ts, date, scope, model, total_tokens, cost)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(parentId, "s1", "e1", Date.now(), new Date().toLocaleDateString("sv-SE"), "parent", "deepseek/deepseek-flash", 4321, 0);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tokenhub/quota",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.remote?.quota?.cycleUsed).toBe(1234);
    expect(body.remote?.keyMasked).toBe("sk-to****bbb");
    expect(Array.isArray(body.local?.days)).toBe(true);
    expect(body.local.today).toBe(4321);
    expect(body.modelInfo?.textModel).toBe("deepseek/deepseek-flash");
    expect(JSON.stringify(body)).not.toContain("sk-tokenhub-bbb");
  });
});
