import fs from "fs";
import path from "path";
import { getSharedDir } from "../config";

export type VoiceProviderId = "aliyun" | "tencent" | "iflytek" | "baidu";

export interface VoiceConfig {
  enabled: boolean;
  provider: VoiceProviderId;
  providers: Record<VoiceProviderId, Record<string, string>>;
}

const DEFAULT_CONFIG: VoiceConfig = {
  enabled: false,
  provider: "aliyun",
  providers: {
    aliyun: { appKey: "", accessKeyId: "", accessKeySecret: "" },
    tencent: { secretId: "", secretKey: "" },
    iflytek: { appId: "", apiKey: "", apiSecret: "" },
    baidu: { appId: "", apiKey: "", secretKey: "" },
  },
};

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
