// 发音评测服务配置（服务端唯一真源，按家长隔离，落 settings 表 key="<parentId>:assessment"，AES-256-GCM 加密）。
// 早期 Electron 本地 assessment-config.json 已废弃：凭证统一收归服务端（多端共享、密钥不落客户端明文）。
import { nowLocalIso, toLocalIso } from "../util/time.js";
import type { DatabaseSync } from "node:sqlite";
import { getServerSecret, encryptJson, decryptJson } from "../crypto.js";
import type { AssessmentProviderId } from "./types.js";
import {
  DEFAULT_EXAM_MIN_VOLUME_NORM,
  DEFAULT_EXAM_RECITE_PASS,
  parseVolumeThreshold,
  parsePassLine,
} from "./volume.js";

export interface AssessmentConfig {
  enabled: boolean;
  provider: AssessmentProviderId;
  providers: Record<AssessmentProviderId, Record<string, string>>;
  /** 考核录音最低平均音量（0-100 归一分，与客户端 exam-template 同一口径，见 volume.ts）。0 = 不校验。 */
  minVolumeNorm: number;
  /** 朗读/背诵通过线家长默认值（0-100）。题目/方法/排期自带 recitePass 时以题目为准，未设才用它。 */
  recitePassDefault: number;
  /**
   * 声希打分松紧 typeThres：0 默认（不启用）/ 1 严格 / 2 宽松 / 3 非常严格 / 4 非常宽松。
   * 仅 aliyun-ssecp 生效（腾讯智聆无此参数）；0 时不传，保持引擎默认档。
   */
  typeThres: number;
}

/** 声希 typeThres 合法档位。 */
export const SSECP_TYPE_THRES_OPTIONS = [0, 1, 2, 3, 4] as const;

/** 解析 typeThres：只接受 0-4 的整数，其余（含 null/空串）回退 fallback。 */
export function parseTypeThres(v: unknown, fallback: number): number {
  if (v == null || v === "") return fallback;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 4) return fallback;
  return n;
}

export const ASSESSMENT_PROVIDER_ORDER: AssessmentProviderId[] = ["tencent-soe", "aliyun-ssecp"];

const DEFAULT_CONFIG: AssessmentConfig = {
  enabled: false,
  provider: "tencent-soe",
  providers: {
    "tencent-soe": { appId: "", secretId: "", secretKey: "" },
    "aliyun-ssecp": { appKey: "", appSecret: "", userId: "pi-child" },
  },
  minVolumeNorm: DEFAULT_EXAM_MIN_VOLUME_NORM,
  recitePassDefault: DEFAULT_EXAM_RECITE_PASS,
  typeThres: 0,
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
    // ISSUE-183：旧配置无这两个字段 → 回默认值（阈值 42≈-35dBFS / 通过线 90）
    minVolumeNorm: parseVolumeThreshold(parsed.minVolumeNorm, DEFAULT_EXAM_MIN_VOLUME_NORM),
    recitePassDefault: parsePassLine(parsed.recitePassDefault, DEFAULT_EXAM_RECITE_PASS),
    // 旧配置无 typeThres → 0（不启用，保持引擎默认松紧）
    typeThres: parseTypeThres(parsed.typeThres, DEFAULT_CONFIG.typeThres),
  };
}

/** 打码单个字段：空串返回空串；否则只露首尾，中间 ****。绝不返回明文密钥。（ISSUE-163：对齐 6/4 语义） */
export function maskSecret(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "*".repeat(v.length);
  return `${v.slice(0, 6)}****${v.slice(-4)}`;
}

/** 返回打码后的配置（供前端展示，绝不返回明文密钥）。 */
export function getMaskedAssessmentConfig(cfg: AssessmentConfig): AssessmentConfig {
  const masked: AssessmentConfig = {
    enabled: cfg.enabled,
    provider: cfg.provider,
    providers: {} as AssessmentConfig["providers"],
    minVolumeNorm: cfg.minVolumeNorm,
    recitePassDefault: cfg.recitePassDefault,
    typeThres: cfg.typeThres,
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
    minVolumeNorm?: number;
    recitePassDefault?: number;
    typeThres?: number;
  }
): AssessmentConfig {
  const cfg = loadAssessmentConfig(db, parentId, dataDir);
  cfg.enabled = !!patch.enabled;
  if (patch.provider) cfg.provider = patch.provider as AssessmentProviderId;
  // ISSUE-183：两个字段传了（含 0=不校验）才更新；未传保持原值
  if (patch.minVolumeNorm != null) cfg.minVolumeNorm = parseVolumeThreshold(patch.minVolumeNorm, cfg.minVolumeNorm);
  if (patch.recitePassDefault != null) cfg.recitePassDefault = parsePassLine(patch.recitePassDefault, cfg.recitePassDefault);
  if (patch.typeThres != null) cfg.typeThres = parseTypeThres(patch.typeThres, cfg.typeThres);

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
  ).run(parentId, stored, nowLocalIso());
  return cfg;
}
