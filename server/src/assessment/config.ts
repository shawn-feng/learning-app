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
  /** 考核录音最低平均音量（0-100 归一分，与客户端 exam-template 同一口径，见 volume.ts）。0 = 不校验。
   *  ISSUE-191 起作为**默认线**：孩子没有单独设置时用它（新孩子 / 旧配置 / 未单独配置的孩子）。 */
  minVolumeNorm: number;
  /**
   * ISSUE-191：每个孩子单独的音量阈值（childId → 0-100 归一分，0 = 该孩子不校验）。
   * 每个孩子的设备麦克风灵敏度、年龄/说话音量都不一样，家长按孩子单独设置；未出现在表里的孩子
   * 回退 `minVolumeNorm`（默认线）。存储仍在该家长的 assessment_config 加密 JSON 内，随配置下发。
   */
  minVolumeNormByChild: Record<string, number>;
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

/**
 * 合并「每个孩子的阈值覆盖表」补丁（ISSUE-191）：
 * - 数值 → 夹取到 0-100 写入（0 = 该孩子不校验）；
 * - `null` → 删除该孩子的覆盖（回到家长默认线）——设置页「用默认」按钮用它；
 * - 非法值/空 childId 忽略；非对象补丁原样返回 existing。
 */
export function mergeVolumeNormByChild(
  existing: Record<string, number>,
  patch: unknown
): Record<string, number> {
  const next: Record<string, number> = { ...(existing || {}) };
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return next;
  for (const [childId, raw] of Object.entries(patch as Record<string, unknown>)) {
    if (!childId) continue;
    if (raw === null) {
      delete next[childId];
      continue;
    }
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) continue;
    next[childId] = Math.min(100, Math.max(0, n));
  }
  return next;
}

/**
 * 解析已落盘的「每个孩子的阈值覆盖表」（ISSUE-191）：只收 childId 非空、值为 0-100 整数的条目，
 * 非法/数组/非对象一律丢弃（旧配置无此字段 → 空表，回退家长默认线）。
 */
export function parseVolumeNormByChild(v: unknown): Record<string, number> {
  return mergeVolumeNormByChild({}, v);
}

/**
 * 某孩子实际生效的音量阈值：有单独设置（ISSUE-191）用单独的（含 0=该孩子不校验），
 * 否则回退家长默认线 `minVolumeNorm`。考核/聊天/服务端兜底三处都走本函数，避免口径漂移。
 */
export function resolveMinVolumeNorm(
  cfg: Pick<AssessmentConfig, "minVolumeNorm" | "minVolumeNormByChild">,
  childId?: string
): number {
  if (!childId) return cfg.minVolumeNorm;
  const per = cfg.minVolumeNormByChild?.[childId];
  return per == null ? cfg.minVolumeNorm : per;
}

const DEFAULT_CONFIG: AssessmentConfig = {
  enabled: false,
  provider: "tencent-soe",
  providers: {
    "tencent-soe": { appId: "", secretId: "", secretKey: "" },
    "aliyun-ssecp": { appKey: "", appSecret: "", userId: "pi-child" },
  },
  minVolumeNorm: DEFAULT_EXAM_MIN_VOLUME_NORM,
  minVolumeNormByChild: {},
  recitePassDefault: DEFAULT_EXAM_RECITE_PASS,
  typeThres: 0,
};

/** 读取并解密该家长的测评配置（服务端内部使用，不对外暴露明文密钥）。 */
export function loadAssessmentConfig(db: DatabaseSync, parentId: string, dataDir: string): AssessmentConfig {
  const secret = getServerSecret(dataDir);
  const row = db
    .prepare("SELECT value_json FROM assessment_config WHERE parent_id = ?")
    .get(parentId) as { value_json: string } | undefined;
  if (!row) return { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers }, minVolumeNormByChild: {} };
  let parsed: any = null;
  try {
    const dec = decryptJson(secret, row.value_json);
    parsed = dec ?? JSON.parse(row.value_json);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers }, minVolumeNormByChild: {} };
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
    // ISSUE-191：旧配置无「每个孩子」覆盖表 → 空表（全员回退上面的默认线）
    minVolumeNormByChild: parseVolumeNormByChild(parsed.minVolumeNormByChild),
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
    // ISSUE-191：每孩子阈值不是密钥，原样回显（设置页按孩子展示滑条）
    minVolumeNormByChild: { ...(cfg.minVolumeNormByChild || {}) },
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
    /** ISSUE-191：按孩子覆盖（childId → 0-100，null=删除回到默认线）；只更新传入的条目，未传的条目保留 */
    minVolumeNormByChild?: Record<string, number | null>;
    recitePassDefault?: number;
    typeThres?: number;
  }
): AssessmentConfig {
  const cfg = loadAssessmentConfig(db, parentId, dataDir);
  cfg.enabled = !!patch.enabled;
  if (patch.provider) cfg.provider = patch.provider as AssessmentProviderId;
  // ISSUE-183：两个字段传了（含 0=不校验）才更新；未传保持原值
  if (patch.minVolumeNorm != null) cfg.minVolumeNorm = parseVolumeThreshold(patch.minVolumeNorm, cfg.minVolumeNorm);
  // ISSUE-191：合并式更新——null 删除该孩子的覆盖（「用默认」），旧客户端/局部保存不传本字段时不动既有覆盖
  if (patch.minVolumeNormByChild) {
    cfg.minVolumeNormByChild = mergeVolumeNormByChild(cfg.minVolumeNormByChild, patch.minVolumeNormByChild);
  }
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
