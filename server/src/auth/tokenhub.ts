/**
 * TokenHub Key 物化（ISSUE-174 统一模型接入）。
 *
 * benefit-auth（云端）是 Key 权威：每中台用户一把 TokenHub API Key（默认日配额 500 万
 * tokens，管理员可调）。本模块负责把该 Key「物化」进本机 server 的加密 auth 封套
 * （settings `<parentId>:auth` 增加 tokenhub 段）——此后全部模型热路径
 * （readParentSettings → getWorkerRuntime → pickWorkerModel）零改动地用上 TokenHub。
 *
 * 换取凭证 = 家长的 cloud_token（parents 表，登录时由云端签发的 user JWT，72h）：
 * 服务端不持有任何服务级密钥，纯「用户凭据转发」，与 auth/proxy.ts 的既有模式一致。
 *
 * 触发时机：
 *  - startTokenHubKeySync()：后台每 5 分钟扫全量家长（覆盖存量用户/网络失败重试）
 *  - 登录成功钩子（routes/auth.ts）：新登录即时换取
 *  - GET /models/settings 懒触发（设置页打开时）
 *
 * 失败语义：静默（log warn），下轮重试。Key 未就绪时模型调用会报认证错误并自愈。
 */
import { nowLocalIso, toLocalIso } from "../util/time.js";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "../config.js";
import { getServerSecret, encryptJson, decryptJson } from "../crypto.js";
import { bumpConfigRevision } from "../db.js";

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;

export interface TokenHubKeyInfo {
  apiKey: string;
  keyId: string;
  quota: { cycleUnit: string; cycleCredits: number; cycleUsed: number; quotaStatus: string; keyStatus: string };
}

/** 拉取家长 cloud_token；无则返回空串。 */
function getCloudToken(db: DatabaseSync, parentId: string): string {
  const row = db.prepare("SELECT cloud_token FROM parents WHERE id = ?").get(parentId) as
    | { cloud_token?: string }
    | undefined;
  return (row?.cloud_token || "").trim();
}

/** 调云端 benefit-auth 发放/换取本家长的 TokenHub Key（幂等；失败抛错由调用方决定策略）。 */
export async function fetchTokenHubKey(upstreamBase: string, cloudToken: string): Promise<TokenHubKeyInfo> {
  let res: Response;
  try {
    res = await fetch(`${upstreamBase}/api/tokenhub/key`, {
      headers: { Authorization: `Bearer ${cloudToken}` },
    });
  } catch {
    throw new Error("无法连接云端认证服务");
  }
  if (res.status === 401) throw new Error("cloud_token 已过期，等待家长下次登录刷新");
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      /* 保留默认 */
    }
    throw new Error(detail);
  }
  const body = (await res.json()) as { apiKey?: string; keyId?: string; quota?: TokenHubKeyInfo["quota"] };
  if (!body.apiKey || !body.keyId) throw new Error("云端返回缺少 apiKey/keyId");
  return {
    apiKey: body.apiKey,
    keyId: body.keyId,
    quota: body.quota ?? { cycleUnit: "d", cycleCredits: 0, cycleUsed: 0, quotaStatus: "", keyStatus: "" },
  };
}

/** 云端已删除重建 Key 时本地旧 Key 会失效——每轮比对刷新（幂等发放返回同一把，仅变化时回写）。 */
export async function ensureParentTokenHubKey(
  config: ServerConfig,
  db: DatabaseSync,
  parentId: string
): Promise<boolean> {
  const cloudToken = getCloudToken(db, parentId);
  if (!cloudToken) return false;
  const info = await fetchTokenHubKey(config.upstreamBase, cloudToken);
  const secret = getServerSecret(config.dataDir);
  const keyRow = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`${parentId}:auth`) as
    | { value_json?: string }
    | undefined;
  const auth = keyRow?.value_json
    ? ((decryptJson(secret, keyRow.value_json) as Record<string, any> | null) ?? {})
    : {};
  const existing = typeof auth?.tokenhub?.key === "string" ? auth.tokenhub.key : "";
  if (existing === info.apiKey) return false; // 无变化，避免 revision 抖动
  auth.tokenhub = { type: "api_key", key: info.apiKey };
  db.prepare(
    "INSERT INTO settings (key, value_json, updated) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated = excluded.updated"
  ).run(`${parentId}:auth`, encryptJson(secret, auth), nowLocalIso());
  bumpConfigRevision(db);
  console.log(`[tokenhub] 已物化家长 ${parentId} 的 TokenHub Key（${info.keyId}${existing ? "，轮换更新" : ""}）`);
  return true;
}

/** 云端配额查询（供设置页配额面板；只读，不写本地）。 */
export async function fetchTokenHubQuota(
  upstreamBase: string,
  cloudToken: string
): Promise<{ keyMasked: string; quota: TokenHubKeyInfo["quota"]; defaultDailyCredits: number } | null> {
  let res: Response;
  try {
    res = await fetch(`${upstreamBase}/api/tokenhub/quota`, {
      headers: { Authorization: `Bearer ${cloudToken}` },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json()) as {
    keyMasked?: string;
    quota?: TokenHubKeyInfo["quota"];
    defaultDailyCredits?: number;
  };
  if (!body.quota) return null;
  return {
    keyMasked: body.keyMasked ?? "",
    quota: body.quota,
    defaultDailyCredits: body.defaultDailyCredits ?? 0,
  };
}

/** 官方按模型用量（与配额扣减同源；账号整体口径，分钟级以上延迟）。
 *  配额面板的「今日分类消耗」用它，保证与「今日已用」对得上。 */
export async function fetchTokenHubUsageModels(
  upstreamBase: string,
  cloudToken: string,
  days = 1
): Promise<Array<{ model: string; input: number; output: number; total: number }>> {
  let res: Response;
  try {
    res = await fetch(`${upstreamBase}/api/tokenhub/usage-models?days=${days}`, {
      headers: { Authorization: `Bearer ${cloudToken}` },
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as {
    rows?: Array<{ model: string; input: number; output: number; total: number }>;
  };
  return body.rows ?? [];
}

// ==================== 系统默认模型（管理端四下拉，云端统一下发） ====================

export interface SystemDefaultModels {
  /** 完整模型键 "tokenhub/<modelId>"：agent 文本 / 编程 agent 的系统默认 */
  text: string;
  /** 完整模型键：视觉模块（读图）系统默认 */
  vision: string;
  /** ASR 模型名（通道内模型，如 qwen-audio-3.0-asr-flash；无 provider 前缀） */
  asr: string;
  /** TTS 模型名（edge-tts 或 minimax-speech-*） */
  tts: string;
  /** 合成音色（TTS=minimax-speech-* 时生效的 MiniMax voice_id，管理端「合成音色」下拉） */
  voice: string;
}

const BUILTIN_MODEL_DEFAULTS: SystemDefaultModels = {
  text: `tokenhub/deepseek/deepseek-flash`,
  vision: `tokenhub/deepseek/deepseek-v4-flash-vision-exp`,
  asr: "qwen-audio-3.0-asr-flash",
  tts: "edge-tts",
  voice: "minimax_55e81114-ce7e-4ca1",
};

const META_MODEL_CONFIG_KEY = "tokenhub_model_config";
let sysModelsCache: SystemDefaultModels | null = null;

/** 各功能模块的系统默认模型：云端配置 → 上次缓存的云端配置 → 内置常量。 */
export function getSystemDefaultModels(): SystemDefaultModels {
  return sysModelsCache ?? BUILTIN_MODEL_DEFAULTS;
}

/** 拉取云端默认模型配置（公开端点，仅模型名）；成功则更新内存缓存 + meta 持久化（离线启动仍有值）。 */
async function refreshSystemDefaultModels(upstreamBase: string, db: DatabaseSync): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`${upstreamBase}/api/tokenhub/model-config`);
  } catch {
    return false;
  }
  if (!res.ok) return false;
  const body = (await res.json()) as { models?: Record<string, string> };
  const m = body.models;
  if (!m?.text || !m?.vision) return false;
  const next: SystemDefaultModels = {
    text: `tokenhub/${m.text}`,
    vision: `tokenhub/${m.vision}`,
    asr: m.asr || BUILTIN_MODEL_DEFAULTS.asr,
    tts: m.tts || BUILTIN_MODEL_DEFAULTS.tts,
    voice: m.voice || BUILTIN_MODEL_DEFAULTS.voice,
  };
  sysModelsCache = next;
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(META_MODEL_CONFIG_KEY, JSON.stringify(next));
  return true;
}

/** 启动时从 meta 恢复上次云端配置（断网/云端未部署时仍有可用默认）。 */
function loadSystemDefaultModelsFromMeta(db: DatabaseSync): void {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(META_MODEL_CONFIG_KEY) as
      | { value?: string }
      | undefined;
    if (row?.value) {
      const parsed = JSON.parse(row.value) as SystemDefaultModels;
      if (parsed?.text && parsed?.vision) {
        // 旧 meta 无 voice 字段（voice 下发先于该字段上线）：补默认，避免合成取到 undefined
        sysModelsCache = { ...parsed, voice: parsed.voice || BUILTIN_MODEL_DEFAULTS.voice };
      }
    }
  } catch {
    /* 损坏则用内置常量 */
  }
}

/** 后台同步循环（启动延迟 15s，之后每 5 分钟一轮；逐家长串行、单家长失败不影响其余）。 */
const lastWarnAt = new Map<string, number>();

function warnThrottled(parentId: string, message: string): void {
  const now = Date.now();
  if (now - (lastWarnAt.get(parentId) ?? 0) < 60 * 60 * 1000) return; // 同家长至多每小时告警一次
  lastWarnAt.set(parentId, now);
  console.warn(`[tokenhub] 家长 ${parentId} 换取失败: ${message}`);
}

export function startTokenHubKeySync(config: ServerConfig, db: DatabaseSync): void {
  loadSystemDefaultModelsFromMeta(db);
  const runOnce = async (trigger: string) => {
    try {
      // 系统默认模型（云端四下拉）：每轮先刷新（公开端点，无需家长凭证）
      if (await refreshSystemDefaultModels(config.upstreamBase, db)) {
        const m = getSystemDefaultModels();
        console.log(`[tokenhub] ${trigger}: 系统默认模型已同步 text=${m.text} vision=${m.vision} asr=${m.asr} tts=${m.tts} voice=${m.voice}`);
      }
    } catch (e) {
      console.warn(`[tokenhub] ${trigger}: 默认模型拉取失败: ${(e as Error).message}`);
    }
    try {
      const rows = db.prepare(
        "SELECT id FROM parents WHERE cloud_token IS NOT NULL AND cloud_token != ''"
      ).all() as Array<{ id: string }>;
      let ok = 0;
      for (const r of rows) {
        try {
          if (await ensureParentTokenHubKey(config, db, r.id)) ok++;
        } catch (e) {
          warnThrottled(r.id, (e as Error).message);
        }
      }
      if (rows.length) console.log(`[tokenhub] ${trigger}: 扫描 ${rows.length} 位家长，新物化/更新 ${ok}`);
    } catch (e) {
      console.warn(`[tokenhub] ${trigger}: 扫描失败: ${(e as Error).message}`);
    }
  };
  setTimeout(() => void runOnce("startup"), STARTUP_DELAY_MS);
  setInterval(() => void runOnce("periodic"), SYNC_INTERVAL_MS);
}
