/**
 * ISSUE-174 模型渠道三态 + 配额四类拆分回归（2026-10-10 调整）：
 * ① 渠道解析：modelChannel 缺省 builtin，custom/off 直通，非法值回落 builtin；
 * ② pickWorkerModel/pickVisionModel 按渠道池选模型：off 抛错；builtin 忽略自定义默认；
 *    custom 忽略 tokenhub、无默认时回落第一个已配 Key 的自定义（视觉要求 image 输入）；
 * ③ 模型类别归类：文本/视觉/语音识别/语音合成；
 * ④ ASR 用量落库 + GET /tokenhub/quota 返回四类聚合。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openDb } from "../server/src/db";
import {
  resolveModelChannel,
  resolveConfiguredModelKey,
  firstCustomModelKey,
  pickWorkerModel,
  pickVisionModel,
  PROVIDER_REGISTRATIONS,
  listProviderModels,
  TOKENHUB_PROVIDER_ID,
} from "@pi/agent-core";
import {
  classifyModelCategory,
  recordAsrTokenUsage,
  queryTokenUsageByCategory,
} from "../server/src/db/token-usage";
import { registerModelRoutes } from "../server/src/routes/models";
import { signSession } from "../server/src/auth/jwt";
import type { ServerConfig } from "../server/src/config";
import type { FastifyInstance } from "fastify";

const requireFromServer = createRequire(path.resolve("server/src/index.ts"));
const Fastify = requireFromServer("fastify") as (opts?: Record<string, unknown>) => FastifyInstance;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue174-channel-"));
const SECRET = "test-secret-channel";
const parentId = "parent-chan";
const mainDb = openDb(dataDir);
const config: ServerConfig = {
  port: 8791,
  upstreamBase: "http://upstream.test",
  jwtSecret: SECRET,
  tokenTtlDays: 7,
  dataDir,
};
const token = signSession({ parent_id: parentId }, SECRET, 7);

// runtime 桩：把 getModel 的入参原样回显，便于断言选中的是哪个渠道池的模型
const stubRuntime = () =>
  ({
    getModel: (provider: string, modelId: string) => ({ provider, modelId }),
  }) as any;

const auth = {
  qwen: { type: "api_key", key: "sk-qwen-x" },
  tokenhub: { type: "api_key", key: "sk-th-x" },
};

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes("/api/tokenhub/quota") ? {} : {}),
    })) as any
  );
  mainDb
    .prepare("INSERT INTO parents (id, email, cloud_token, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run(parentId, "chan@test", "cloud-token-chan", new Date().toISOString(), new Date().toISOString());
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("ISSUE-174 ① 渠道解析", () => {
  it("缺省/非法值 = builtin；custom/off 直通", () => {
    expect(resolveModelChannel(undefined)).toBe("builtin");
    expect(resolveModelChannel({})).toBe("builtin");
    expect(resolveModelChannel({ modelChannel: "weird" })).toBe("builtin");
    expect(resolveModelChannel({ modelChannel: "custom" })).toBe("custom");
    expect(resolveModelChannel({ modelChannel: "off" })).toBe("off");
  });
});

describe("ISSUE-174 ② 渠道池选模型", () => {
  it("resolveConfiguredModelKey：builtin 只认 tokenhub；custom 只认已配 Key 的自定义；off 全拒", () => {
    expect(resolveConfiguredModelKey("tokenhub/deepseek/deepseek-flash", auth, "builtin")?.provider).toBe("tokenhub");
    expect(resolveConfiguredModelKey("qwen/qwen-max", auth, "builtin")).toBeNull();
    expect(resolveConfiguredModelKey("tokenhub/deepseek/deepseek-flash", auth, "custom")).toBeNull();
    expect(resolveConfiguredModelKey("qwen/qwen-max", auth, "custom")?.provider).toBe("qwen");
    expect(resolveConfiguredModelKey("qwen/deepseek-v3", { minimax: { key: "x" } } as any, "custom")).toBeNull();
    expect(resolveConfiguredModelKey("tokenhub/deepseek/deepseek-flash", auth, "off")).toBeNull();
  });

  it("pickWorkerModel：off 抛错；builtin 忽略自定义默认回落 tokenhub；custom 忽略 tokenhub 默认", () => {
    expect(() => pickWorkerModel(stubRuntime(), { modelChannel: "off" }, auth, "")).toThrow(/停用/);
    const builtin = pickWorkerModel(
      stubRuntime(),
      { modelChannel: "builtin", defaultModel: "qwen/qwen-max" },
      auth,
      ""
    );
    expect(`${builtin.provider}/${builtin.modelId}`).toBe("tokenhub/deepseek/deepseek-flash");
    const custom = pickWorkerModel(
      stubRuntime(),
      { modelChannel: "custom", defaultModel: "tokenhub/deepseek/deepseek-flash" },
      auth,
      "tokenhub/deepseek/deepseek-flash"
    );
    // tokenhub 默认在 custom 渠道被忽略 → 回落第一个已配 Key 的自定义 provider 首模型
    const fb = firstCustomModelKey(auth);
    expect(fb).not.toBeNull();
    expect(`${custom.provider}/${custom.modelId}`).toBe(`${fb!.provider}/${fb!.modelId}`);
    // custom 渠道用户自定义默认优先生效
    const customPicked = pickWorkerModel(
      stubRuntime(),
      { modelChannel: "custom", defaultModel: "qwen/qwen-max" },
      auth,
      ""
    );
    expect(`${customPicked.provider}/${customPicked.modelId}`).toBe("qwen/qwen-max");
  });

  it("pickWorkerModel：custom 无任何 Key → 抛可读错误", () => {
    expect(() => pickWorkerModel(stubRuntime(), { modelChannel: "custom" }, {}, "")).toThrow(/自定义模型/);
  });

  it("pickVisionModel：custom 回落第一个支持 image 输入的自定义模型", () => {
    const visionFb = firstCustomModelKey(auth, { input: "image" });
    expect(visionFb).not.toBeNull();
    // 期望值与注册表互证：该 provider 确有 image 模型
    const imgModels = listProviderModels().filter(
      (m) => m.provider === visionFb!.provider && (m.input || []).includes("image")
    );
    expect(imgModels.length).toBeGreaterThan(0);
    const v = pickVisionModel(
      stubRuntime(),
      { modelChannel: "custom" },
      auth,
      "tokenhub/deepseek/deepseek-v4-flash-vision-exp"
    );
    expect(`${v.provider}/${v.modelId}`).toBe(`${visionFb!.provider}/${visionFb!.modelId}`);
  });

  it("firstCustomModelKey 按 provider 注册表顺序取第一个已配 Key 的（跳过 tokenhub）", () => {
    const firstKeyed = PROVIDER_REGISTRATIONS.find(([pid]) => pid !== TOKENHUB_PROVIDER_ID && auth[pid]);
    expect(firstCustomModelKey(auth)?.provider).toBe(firstKeyed![0]);
  });
});

describe("ISSUE-174 ③④ 类别归类 / ASR 落库 / 配额四类聚合", () => {
  it("classifyModelCategory：文本/视觉/语音识别/语音合成", () => {
    expect(classifyModelCategory("deepseek/deepseek-flash")).toBe("text");
    expect(classifyModelCategory("deepseek/deepseek-v4-flash-vision-exp")).toBe("vision");
    expect(classifyModelCategory("hy-vision-2.0-instruct")).toBe("vision");
    expect(classifyModelCategory("glm-5v-turbo")).toBe("vision");
    expect(classifyModelCategory("qwen/qwen3-vl-flash")).toBe("vision");
    expect(classifyModelCategory("hy-asr-3.0-preview")).toBe("asr");
    expect(classifyModelCategory("qwen-audio-3.0-asr-flash")).toBe("asr");
    expect(classifyModelCategory("edge-tts-zh")).toBe("tts");
    expect(classifyModelCategory("")).toBe("text");
  });

  it("recordAsrTokenUsage 落库 + queryTokenUsageByCategory 四类聚合（含今日）", async () => {
    const today = new Date().toLocaleDateString("sv-SE");
    const ins = mainDb.prepare(
      `INSERT INTO token_usage (parent_id, session_file, entry_id, ts, date, scope, child_id, slot,
        model, stop_reason, input, cache_read, cache_write, output, reasoning, total_tokens, cost)
       VALUES (?,?,?,?,?,'child','', 'main', ?, 'stop', 0,0,0,0,0, ?, 0)`
    );
    ins.run(parentId, "f1", "e1", Date.now(), today, "deepseek/deepseek-flash", 100);
    ins.run(parentId, "f1", "e2", Date.now(), today, "deepseek/deepseek-v4-flash-vision-exp", 50);
    // 自定义模型用量：不消耗 TokenHub 配额，必须被排除（用户 2026-10-10 拍板）
    ins.run(parentId, "f1", "e3", Date.now(), today, "mimo-v2.5", 999);
    ins.run(parentId, "f1", "e4", Date.now(), today, "DeepSeek-V4.1-flash", 888);
    recordAsrTokenUsage(mainDb, parentId, "hy-asr-3.0-preview", { input: 20, output: 10, total: 30 });

    const { today: cat, byDay } = queryTokenUsageByCategory(mainDb, parentId, 7);
    expect(cat).toEqual({ text: 100, vision: 50, asr: 30, tts: 0 });
    const todayRow = byDay.find((d) => d.date === today);
    expect(todayRow?.text).toBe(100);
    expect(todayRow?.asr).toBe(30);
    // ASR 合成行 slot=asr，不干扰会话扫描（session_file=asr 非真实文件路径）
    const row = mainDb
      .prepare("SELECT slot, scope, total_tokens FROM token_usage WHERE parent_id=? AND session_file='asr'")
      .get(parentId) as any;
    expect(row.slot).toBe("asr");
    expect(row.total_tokens).toBe(30);
  });

  it("GET /tokenhub/quota 返回 local.categories 四类拆分", async () => {
    const app = Fastify({ logger: false });
    registerModelRoutes(app, { config, db: mainDb });
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tokenhub/quota",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.local.categories.today).toEqual({ text: 100, vision: 50, asr: 30, tts: 0 });
      expect(Array.isArray(body.local.categories.byDay)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
