// 发音评测服务配置（家长端设置）：腾讯云智聆（WebSocket） / 阿里 SSECP 声希（HTTP POST API，客户端直连）。
// 阿里方案评测在 app 客户端（Electron 主进程）完成，不经过我们的云服务端；声希直连鉴权拿 warrant_id，无需阿里云 AccessKey。
// 存储位置与 voice-config.json 同级（shared 目录），仿照 voice-config 的读写/打码/补丁模式。
import fs from "fs";
import path from "path";
import { getSharedDir } from "../config";
import { maskSecret } from "../voice/voice-config";
import type { AssessmentProviderId } from "./types";

export interface AssessmentConfig {
  enabled: boolean;
  provider: AssessmentProviderId;
  providers: Record<AssessmentProviderId, Record<string, string>>;
}

const DEFAULT_CONFIG: AssessmentConfig = {
  enabled: false,
  provider: "tencent-soe",
  providers: {
    // 腾讯云智聆口语评测（新版，WebSocket 流式）：中文背诵 16k_zh / 英文 16k_en
    "tencent-soe": { appId: "", secretId: "", secretKey: "" },
    // 阿里 SSECP 声希（HTTP POST API，客户端直连）：中文背诵 cn.pred.score / 英文 en.sent.score
    "aliyun-ssecp": { appKey: "", appSecret: "", userId: "pi-child" },
  },
};

export const ASSESSMENT_PROVIDER_ORDER: AssessmentProviderId[] = ["tencent-soe", "aliyun-ssecp"];

export function getAssessmentConfigPath(): string {
  return path.join(getSharedDir(), "assessment-config.json");
}

export function loadAssessmentConfig(): AssessmentConfig {
  try {
    const raw = fs.readFileSync(getAssessmentConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      enabled: !!parsed.enabled,
      provider: parsed.provider || "tencent-soe",
      providers: {
        ...DEFAULT_CONFIG.providers,
        ...(parsed.providers || {}),
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers } };
  }
}

export function saveAssessmentConfig(config: AssessmentConfig): void {
  fs.writeFileSync(getAssessmentConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

/** 某服务是否已配置完整（必需字段非空） */
export function isAssessmentConfigured(cfg: AssessmentConfig, id: AssessmentProviderId): boolean {
  const creds = cfg.providers[id] || {};
  if (id === "tencent-soe") return !!(creds.appId && creds.secretId && creds.secretKey);
  if (id === "aliyun-ssecp") return !!(creds.appKey && creds.appSecret);
  return false;
}

/** 返回打码后的配置（供前端展示，绝不返回明文密钥） */
export function getMaskedAssessmentConfig(): AssessmentConfig {
  const cfg = loadAssessmentConfig();
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

/** 应用前端提交的补丁：凭证字段「空值或含 *」视为未修改，跳过（保留原值） */
export function applyAssessmentConfigPatch(patch: {
  enabled: boolean;
  provider: string;
  providers?: Record<string, Record<string, string>>;
}): AssessmentConfig {
  const cfg = loadAssessmentConfig();
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
  saveAssessmentConfig(cfg);
  return cfg;
}
