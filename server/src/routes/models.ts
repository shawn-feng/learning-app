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
import { nowLocalIso, toLocalIso } from "../util/time.js";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { getServerSecret, encryptJson, decryptJson } from "../crypto.js";
import { bumpConfigRevision } from "../db.js";
import { listProviderModels, getWorkerRuntime, PROVIDER_REGISTRATIONS, getProviderEmbedding, TOKENHUB_PROVIDER_ID } from "@pi/agent-core";
import { readParentSettings } from "../worker/scheduler.js";
import { maskSecret } from "../util/mask.js";
import { ensureParentTokenHubKey, fetchTokenHubQuota, fetchTokenHubUsageModels } from "../auth/tokenhub.js";

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
      .run(keyFor(parentId, key), stored, nowLocalIso());
    bumpConfigRevision(deps.db);
  }

  // ISSUE-174 调整：保留全量 provider 模型列表（自定义模型渠道），tokenhub 作为系统默认
  // provider 也在列表中（其模型无需用户配置 Key）。
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

  // 校验某 provider 的密钥是否可用（真实探测：用该家长的 auth 建运行时 → runtime.checkAuth）。
  // 与客户端设置页「测试连接」语义一致；探测失败不抛异常，返回 SDK 的检查结果。
  app.post("/api/v1/models/check", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { provider } = (req.body ?? {}) as { provider?: string };
    if (!provider?.trim()) return reply.code(400).send({ error: "provider 必填" });
    try {
      const settings = readParentSettings(deps.db, deps.config.dataDir, parentId);
      const runtime = await getWorkerRuntime(deps.config.dataDir, parentId, settings.auth);
      const status = await runtime.checkAuth(provider.trim());
      return { ok: true, status };
    } catch (err) {
      return { ok: false, status: false, error: (err as Error).message };
    }
  });

  // 读取当前 app_settings + auth 脱敏态（供设置页回显；auth 只回 provider 名 + 打码 key，不回明文）。
  app.get("/api/v1/models/settings", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    // ISSUE-174：懒触发 TokenHub Key 物化（封套缺失时异步换取，不阻塞本响应）
    void ensureParentTokenHubKey(deps.config, deps.db, parentId).catch(() => {
      /* 静默：后台循环会重试 */
    });
    const appSettings = (readSetting(parentId, "app_settings") as Record<string, unknown>) ?? {};
    const auth = (readSetting(parentId, "auth") as Record<string, any>) ?? {};
    // ISSUE-111：合并注册表全量 provider（含未配 key 的）+ 向量化能力提示（provider 内置声明，零配置）
    const merged = new Map<string, boolean>();
    for (const pid of PROVIDER_REGISTRATIONS.map(([pid]) => pid)) merged.set(pid, !!(auth as any)[pid]?.key);
    for (const pid of Object.keys(auth)) if (!merged.has(pid)) merged.set(pid, !!(auth as any)[pid]?.key);
    const providers = [...merged.entries()].map(([provider, hasKey]) => {
      const cap = getProviderEmbedding(provider);
      // ISSUE-163：回显打码 key（前6+****+后4），设置页可知当前用的是哪把
      const keyMasked = hasKey ? maskSecret(String((auth as any)[provider].key ?? "")) : "";
      return {
        provider,
        hasKey,
        keyMasked,
        embedding: cap ? { supported: true, model: cap.model } : { supported: false },
      };
    });
    return { appSettings, providers };
  });

  // 大模型配额（ISSUE-174，设置页「大模型配额」面板）：
  // remote = 云端官方口径（网关统计，CycleUsed 有分钟级以上到账延迟）；local = 本地 token_usage
  // 按日累计（准实时）。两者并列展示，硬限额由腾讯网关强制，展示延迟不影响扣减。
  app.get("/api/v1/tokenhub/quota", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    void ensureParentTokenHubKey(deps.config, deps.db, parentId).catch(() => {
      /* 静默 */
    });
    const row = deps.db.prepare("SELECT cloud_token FROM parents WHERE id = ?").get(parentId) as
      | { cloud_token?: string }
      | undefined;
    const cloudToken = (row?.cloud_token || "").trim();
    let remote = null;
    let remoteError = "";
    if (cloudToken) {
      try {
        remote = await fetchTokenHubQuota(deps.config.upstreamBase, cloudToken);
        if (!remote) remoteError = "云端服务暂不可达";
      } catch (e) {
        remoteError = (e as Error).message;
      }
    } else {
      remoteError = "家长未登录云端（无法获取官方配额）";
    }
    const children = deps.db
      .prepare("SELECT id FROM children WHERE parent_id = ?")
      .all(parentId) as Array<{ id: string }>;
    const { scanTokenUsageIntoDb } = await import("../db/token-usage.js");
    scanTokenUsageIntoDb(deps.db, deps.config.dataDir, parentId, children.map((c) => c.id));
    // 四类拆分 + 今日/近7天（仅内置 TokenHub 模型——自定义模型不消耗该配额，不能混入）
    const { queryTokenUsageByCategory, classifyModelCategory } = await import("../db/token-usage.js");
    const categories = queryTokenUsageByCategory(deps.db, parentId, 7);
    const today = categories.today;
    const todayTotal = today.text + today.vision + today.asr + today.tts;
    const days = categories.byDay
      .map((d) => ({ date: d.date, tokens: d.total, cost: d.cost }))
      .slice(-7);
    // 官方分类：模型占比取自 DescribeUsageRankList（该视图聚合滞后约1小时，直接用永远追不上
    // 实时 CycleUsed），按占比把**实时 CycleUsed** 折算到四类——总和精确等于「今日已用」。
    // 视图拉不到/当日无数据时置 null，面板回落本地记录。
    let officialCategories: { text: number; vision: number; asr: number; tts: number } | null = null;
    let officialCategoriesNote = "";
    const cycleUsed = remote?.quota?.cycleUsed ?? 0;
    const officialRows = cloudToken
      ? await fetchTokenHubUsageModels(deps.config.upstreamBase, cloudToken, 1).catch(() => [])
      : [];
    const rankTotal = officialRows.reduce((s, r) => s + (r.total || 0), 0);
    if (officialRows.length && rankTotal > 0 && cycleUsed > 0) {
      const alloc: Record<string, number> = { text: 0, vision: 0, asr: 0, tts: 0 };
      for (const r of officialRows) alloc[classifyModelCategory(r.model)] += (cycleUsed * (r.total || 0)) / rankTotal;
      // 整数化 + 余差归占比最大的类，保证 sum === CycleUsed
      const rounded: Record<string, number> = {};
      let used = 0;
      for (const k of Object.keys(alloc)) {
        rounded[k] = Math.floor(alloc[k]);
        used += rounded[k];
      }
      let diff = cycleUsed - used;
      for (const k of Object.keys(alloc).sort((a, b) => alloc[b] - alloc[a])) {
        if (diff <= 0) break;
        rounded[k] += 1;
        diff -= 1;
      }
      officialCategories = {
        text: rounded.text,
        vision: rounded.vision,
        asr: rounded.asr,
        tts: rounded.tts,
      };
      officialCategoriesNote = "按官方模型占比折算到当前已用（占比视图有约1小时延迟）";
    }
    return {
      remote,
      remoteError,
      local: {
        today: todayTotal,
        days,
        categories,
      },
      officialCategories,
      officialCategoriesNote,
      modelInfo: {
        provider: TOKENHUB_PROVIDER_ID,
        textModel: "deepseek/deepseek-flash",
        visionModel: "deepseek/deepseek-v4-flash-vision-exp",
      },
    };
  });
}
