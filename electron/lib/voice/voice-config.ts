import fs from "fs";
import path from "path";
import { getSharedDir, getAuthPath } from "../config";

export type VoiceProviderId = "aliyun" | "tencent" | "qwen" | "qwen-tokenplan" | "iflytek" | "baidu";

export interface VoiceConfig {
  enabled: boolean;
  provider: VoiceProviderId;
  providers: Record<VoiceProviderId, Record<string, string>>;
}

// 千问 token-plan 语音 ASR 端点（套餐通道）。按量端点不在 DEFAULT_CONFIG 里写死，
// 由 providers/qwen.ts 在未填 endpoint 时回退 dashscope 按量域名。
const QWEN_TOKENPLAN_ASR_ENDPOINT =
  "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

const DEFAULT_CONFIG: VoiceConfig = {
  enabled: false,
  provider: "aliyun",
  providers: {
    aliyun: { appKey: "", accessKeyId: "", accessKeySecret: "" },
    tencent: { secretId: "", secretKey: "" },
    qwen: { apiKey: "" },
    "qwen-tokenplan": { apiKey: "", endpoint: QWEN_TOKENPLAN_ASR_ENDPOINT },
    iflytek: { appId: "", apiKey: "", apiSecret: "" },
    baidu: { appId: "", apiKey: "", secretKey: "" },
  },
};

// 服务回退顺序（默认服务优先，其余按此顺序尝试）
export const VOICE_PROVIDER_ORDER: VoiceProviderId[] = ["aliyun", "tencent", "qwen", "qwen-tokenplan"];

// 判断某个语音服务是否已配置可用
export function isProviderConfigured(cfg: VoiceConfig, id: VoiceProviderId): boolean {
  const creds = cfg.providers[id] || {};
  switch (id) {
    case "aliyun":
      return !!(creds.appKey && creds.accessKeyId && creds.accessKeySecret);
    case "tencent":
      return !!(creds.secretId && creds.secretKey);
    case "qwen":
      if (creds.apiKey) return true;
      // apiKey 未填时回退模型认证配置（auth.json 的 qwen.key）
      try {
        const auth = JSON.parse(fs.readFileSync(getAuthPath(), "utf-8"));
        const key = auth?.qwen?.key || auth?.qwen?.apiKey;
        return typeof key === "string" && key.trim().length > 0;
      } catch {
        return false;
      }
    case "qwen-tokenplan":
      // token-plan 与按量是两套独立 API Key，不回退 qwen.key，必须自身 key 段有值
      if (creds.apiKey) return true;
      try {
        const auth = JSON.parse(fs.readFileSync(getAuthPath(), "utf-8"));
        const key = auth?.["qwen-tokenplan"]?.key || auth?.["qwen-tokenplan"]?.apiKey;
        return typeof key === "string" && key.trim().length > 0;
      } catch {
        return false;
      }
    default:
      return false; // iflytek / baidu 未实现
  }
}

// 生成识别候选：默认服务在前，其余已配置的按固定顺序在后
export function getTranscribeCandidates(cfg: VoiceConfig): { id: VoiceProviderId; creds: Record<string, string> }[] {
  const out: { id: VoiceProviderId; creds: Record<string, string> }[] = [];
  const pushIfConfigured = (id: VoiceProviderId) => {
    if (isProviderConfigured(cfg, id)) {
      out.push({ id, creds: cfg.providers[id] || {} });
    }
  };
  if (VOICE_PROVIDER_ORDER.includes(cfg.provider)) {
    pushIfConfigured(cfg.provider);
  }
  for (const id of VOICE_PROVIDER_ORDER) {
    if (id !== cfg.provider) pushIfConfigured(id);
  }
  return out;
}

export function getVoiceConfigPath(): string {
  return path.join(getSharedDir(), "voice-config.json");
}

export function loadVoiceConfig(): VoiceConfig {
  try {
    const raw = fs.readFileSync(getVoiceConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      enabled: !!parsed.enabled,
      provider: parsed.provider || "aliyun",
      providers: {
        ...DEFAULT_CONFIG.providers,
        ...(parsed.providers || {}),
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers } };
  }
}

export function saveVoiceConfig(config: VoiceConfig): void {
  fs.writeFileSync(getVoiceConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

// 打码：只回显首 3 位 + **** + 尾 4 位
export function maskSecret(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "*".repeat(v.length);
  return v.slice(0, 3) + "****" + v.slice(-4);
}

// 返回打码后的配置（供前端展示，绝不返回明文密钥）
export function getMaskedConfig(): VoiceConfig {
  const cfg = loadVoiceConfig();
  const masked: VoiceConfig = {
    enabled: cfg.enabled,
    provider: cfg.provider,
    providers: {} as VoiceConfig["providers"],
  };
  for (const [pname, creds] of Object.entries(cfg.providers)) {
    const m: Record<string, string> = {};
    for (const [k, v] of Object.entries(creds)) {
      m[k] = maskSecret(v);
    }
    masked.providers[pname as VoiceProviderId] = m;
  }
  return masked;
}

// 应用前端提交的补丁：凭证字段「空值或含 *」视为未修改，跳过（保留原值）
export function applyVoiceConfigPatch(patch: {
  enabled: boolean;
  provider: string;
  providers?: Record<string, Record<string, string>>;
}): VoiceConfig {
  const cfg = loadVoiceConfig();
  cfg.enabled = !!patch.enabled;
  if (patch.provider) cfg.provider = patch.provider as VoiceProviderId;

  for (const [pname, creds] of Object.entries(patch.providers || {})) {
    if (!cfg.providers[pname as VoiceProviderId]) {
      cfg.providers[pname as VoiceProviderId] = {};
    }
    for (const [k, v] of Object.entries(creds || {})) {
      if (v && !v.includes("*")) {
        cfg.providers[pname as VoiceProviderId][k] = v;
      }
    }
  }
  saveVoiceConfig(cfg);
  return cfg;
}
