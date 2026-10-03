/**
 * ASR 配置真源（ISSUE-165：语音识别凭证配置上收服务端）。
 *
 * 取代「每台设备各自一份 voice-config.json + 本机 auth.json 兜底」：
 *   - 存储：settings 表 key=`<parentId>:asr_config`，AES-256-GCM 加密（对齐 auth 封套）；
 *   - shape 沿用客户端 VoiceConfig（enabled/provider/providers 四通道 apiKey/endpoint），
 *     迁移零转换；客户端一次性导入后本机文件退役；
 *   - 兜底语义上收：通道 apiKey 留空时由服务端回退读同家长 auth 封套
 *     （settings `<parentId>:auth`）——qwen/mimo 各自按通道（按量/套餐）取段，
 *     判定沿用客户端规则：endpoint 含 "token-plan" 即套餐段；
 *   - 打码：GET 永远只回 apiKey 打码（前6+****+后4）；endpoint 非凭证，明文回显。
 */
import type { DatabaseSync } from "node:sqlite";
import { encryptJson, decryptJson } from "../crypto.js";
import { maskSecret } from "../util/mask.js";

export type AsrProviderId = "qwen" | "qwen-tokenplan" | "mimo" | "mimo-tokenplan";

export interface AsrConfig {
  enabled: boolean;
  provider: AsrProviderId;
  providers: Record<AsrProviderId, Record<string, string>>;
}

const QWEN_TOKENPLAN_ASR_ENDPOINT =
  "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const MIMO_TOKENPLAN_ASR_ENDPOINT = "https://token-plan-cn.xiaomimimo.com/v1/chat/completions";

export const ASR_PROVIDER_ORDER: AsrProviderId[] = ["qwen", "qwen-tokenplan", "mimo", "mimo-tokenplan"];

export function defaultAsrConfig(): AsrConfig {
  return {
    enabled: false,
    provider: "qwen",
    providers: {
      qwen: { apiKey: "" },
      "qwen-tokenplan": { apiKey: "", endpoint: QWEN_TOKENPLAN_ASR_ENDPOINT },
      mimo: { apiKey: "" },
      "mimo-tokenplan": { apiKey: "", endpoint: MIMO_TOKENPLAN_ASR_ENDPOINT },
    },
  };
}

function asrKey(parentId: string): string {
  return `${parentId}:asr_config`;
}

/** 读取配置（无存储/解析失败 → 默认配置）。stored=是否已有落库值。 */
export function readAsrConfig(
  db: DatabaseSync,
  secret: Buffer,
  parentId: string
): { cfg: AsrConfig; stored: boolean } {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(asrKey(parentId)) as
    | { value_json?: string }
    | undefined;
  if (!row?.value_json) return { cfg: defaultAsrConfig(), stored: false };
  const parsed = decryptJson(secret, row.value_json) as Partial<AsrConfig> | null;
  if (!parsed || typeof parsed !== "object") return { cfg: defaultAsrConfig(), stored: true };
  const base = defaultAsrConfig();
  return {
    cfg: {
      enabled: !!parsed.enabled,
      provider: (ASR_PROVIDER_ORDER as string[]).includes(String(parsed.provider))
        ? (parsed.provider as AsrProviderId)
        : "qwen",
      providers: { ...base.providers, ...(parsed.providers || {}) },
    },
    stored: true,
  };
}

export function writeAsrConfig(db: DatabaseSync, secret: Buffer, parentId: string, cfg: AsrConfig): void {
  const enc = encryptJson(secret, cfg);
  db.prepare(
    `INSERT INTO settings (key, value_json, updated) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated=excluded.updated`
  ).run(asrKey(parentId), enc, new Date().toISOString());
}

/**
 * 应用前端补丁：凭证字段「空值或含 *」视为未修改，跳过（保留原值）——与客户端旧语义逐字对齐。
 */
export function applyAsrConfigPatch(cfg: AsrConfig, patch: Partial<AsrConfig>): AsrConfig {
  if (patch.enabled !== undefined) cfg.enabled = !!patch.enabled;
  if (patch.provider && (ASR_PROVIDER_ORDER as string[]).includes(patch.provider)) {
    cfg.provider = patch.provider;
  }
  for (const [pname, creds] of Object.entries(patch.providers || {})) {
    const id = pname as AsrProviderId;
    if (!ASR_PROVIDER_ORDER.includes(id)) continue;
    if (!cfg.providers[id]) cfg.providers[id] = {};
    for (const [k, v] of Object.entries(creds || {})) {
      if (typeof v === "string" && v && !v.includes("*")) {
        cfg.providers[id][k] = v;
      }
    }
  }
  return cfg;
}

/** 打码：apiKey 6/4；endpoint 非凭证，明文保留（设置页只读展示）。绝不回明文 key。 */
export function maskAsrConfig(cfg: AsrConfig): AsrConfig {
  const masked: AsrConfig = { enabled: cfg.enabled, provider: cfg.provider, providers: {} as AsrConfig["providers"] };
  for (const [pname, creds] of Object.entries(cfg.providers)) {
    const m: Record<string, string> = {};
    if (creds.apiKey) m.apiKey = maskSecret(creds.apiKey);
    if (creds.endpoint) m.endpoint = creds.endpoint;
    masked.providers[pname as AsrProviderId] = m;
  }
  return masked;
}

/** 从本家长 auth 封套读通道兜底 key（语义对齐旧本机 auth.json：按 endpoint 是否含 token-plan 选段）。 */
export function getAuthEnvelopeKey(
  db: DatabaseSync,
  secret: Buffer,
  parentId: string,
  family: "qwen" | "mimo",
  isTokenPlan: boolean
): string {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`${parentId}:auth`) as
    | { value_json?: string }
    | undefined;
  if (!row?.value_json) return "";
  const auth = decryptJson(secret, row.value_json) as Record<string, any> | null;
  if (!auth) return "";
  const segId = isTokenPlan ? `${family}-tokenplan` : family;
  const seg = auth?.[segId];
  const key = seg?.key || seg?.apiKey;
  return typeof key === "string" ? key.trim() : "";
}

/** 通道是否可用：自身 apiKey 或 auth 封套兜底 key 任一存在。 */
export function isChannelConfigured(
  db: DatabaseSync,
  secret: Buffer,
  parentId: string,
  cfg: AsrConfig,
  id: AsrProviderId
): boolean {
  const creds = cfg.providers[id] || {};
  if ((creds.apiKey || "").trim()) return true;
  const family = id.startsWith("mimo") ? "mimo" : "qwen";
  const isTokenPlan = (creds.endpoint || "").includes("token-plan");
  return getAuthEnvelopeKey(db, secret, parentId, family, isTokenPlan).length > 0;
}

/** 生成识别候选：默认服务在前，其余已配置的按固定顺序在后（对齐客户端 getTranscribeCandidates）。 */
export function getTranscribeCandidates(
  db: DatabaseSync,
  secret: Buffer,
  parentId: string,
  cfg: AsrConfig
): Array<{ id: AsrProviderId; creds: Record<string, string> }> {
  const out: Array<{ id: AsrProviderId; creds: Record<string, string> }> = [];
  const pushIfConfigured = (id: AsrProviderId) => {
    if (isChannelConfigured(db, secret, parentId, cfg, id)) {
      out.push({ id, creds: cfg.providers[id] || {} });
    }
  };
  if (ASR_PROVIDER_ORDER.includes(cfg.provider)) pushIfConfigured(cfg.provider);
  for (const id of ASR_PROVIDER_ORDER) {
    if (id !== cfg.provider) pushIfConfigured(id);
  }
  return out;
}
