// 发音评测服务配置（服务端唯一真源，按家长隔离，落 settings 表 key="<parentId>:assessment"，AES-256-GCM 加密）。
// 早期 Electron 本地 assessment-config.json 已废弃：凭证统一收归服务端（多端共享、密钥不落客户端明文）。
import type { DatabaseSync } from "node:sqlite";
import { getServerSecret, encryptJson, decryptJson } from "../crypto.js";
import type { AssessmentProviderId } from "./types.js";

export interface AssessmentConfig {
  enabled: boolean;
  provider: AssessmentProviderId;
  providers: Record<AssessmentProviderId, Record<string, string>>;
}

export const ASSESSMENT_PROVIDER_ORDER: AssessmentProviderId[] = ["tencent-soe", "aliyun-ssecp"];

const DEFAULT_CONFIG: AssessmentConfig = {
  enabled: false,
  provider: "tencent-soe",
  providers: {
    "tencent-soe": { appId: "", secretId: "", secretKey: "" },
    "aliyun-ssecp": { appKey: "", appSecret: "", userId: "pi-child" },
  },
};

/** 读取并解密该家长的测评配置（服务端内部使用，不对外暴露明文密钥）。 */
export function loadAssessmentConfig(db: DatabaseSync, parentId: string, dataDir: string): AssessmentConfig {
  const secret = getServerSecret(dataDir);
  const row = db
    .prepare("SELECT value_json FROM assessment_config WHERE parent_id = ?")
    .get(parentId) as { value_json: string } | undefined;
  if (!row) return { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers } };
  let parsed: any = null;
  try {
    const dec = decryptJson(secret, row.value_json);
    parsed = dec ?? JSON.parse(row.value_json);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers } };
  }
  return {
    enabled: !!parsed.enabled,
    provider: (parsed.provider as AssessmentProviderId) || "tencent-soe",
    providers: {
      ...DEFAULT_CONFIG.providers,
      ...(parsed.providers || {}),
    },
  };
}

/** 打码单个字段：空串返回空串；否则只露首尾，中间 ***。绝不返回明文密钥。 */
export function maskSecret(v: string): string {
  if (!v) return "";
  if (v.length <= 4) return "****";
  return `${v.slice(0, 2)}***${v.slice(-2)}`;
}

/** 返回打码后的配置（供前端展示，绝不返回明文密钥）。 */
export function getMaskedAssessmentConfig(cfg: AssessmentConfig): AssessmentConfig {
  const masked: AssessmentConfig = {
    enabled: cfg.enabled,
    provider: cfg.provider,
    providers: {} as AssessmentConfig["providers"],
  };
  for (const [pname, creds] of Object.entries(cfg.providers)) {
    const m: Record<string, string> = {};
    for (const [k, v] of Object.entries(creds)) {
      m[k] = maskSecret(v);
    }
    masked.providers[pname as AssessmentProviderId] = m;
  }
  return masked;
}

/** 应用前端提交的补丁并加密持久化：凭证字段「空值或含 *」视为未修改，跳过（保留原值）。 */
export function applyAssessmentConfigPatch(
  db: DatabaseSync,
  parentId: string,
  dataDir: string,
  patch: {
    enabled: boolean;
    provider?: string;
    providers?: Record<string, Record<string, string>>;
  }
): AssessmentConfig {
  const cfg = loadAssessmentConfig(db, parentId, dataDir);
  cfg.enabled = !!patch.enabled;
  if (patch.provider) cfg.provider = patch.provider as AssessmentProviderId;

  for (const [pname, creds] of Object.entries(patch.providers || {})) {
    if (!cfg.providers[pname as AssessmentProviderId]) {
      cfg.providers[pname as AssessmentProviderId] = {};
    }
    for (const [k, v] of Object.entries(creds || {})) {
      if (v && !v.includes("*")) {
        cfg.providers[pname as AssessmentProviderId][k] = v;
      }
    }
  }

  const secret = getServerSecret(dataDir);
  const stored = encryptJson(secret, cfg);
  db.prepare(
    "INSERT INTO assessment_config (parent_id, value_json, updated) VALUES (?, ?, ?) " +
      "ON CONFLICT(parent_id) DO UPDATE SET value_json = excluded.value_json, updated = excluded.updated"
  ).run(parentId, stored, new Date().toISOString());
  return cfg;
}
