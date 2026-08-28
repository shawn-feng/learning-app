import fs from "fs";
import path from "path";
import { getSharedDir } from "../config";

// 语音合成（TTS）配置：与「模型配置」同模式——先选 provider，apiKey 可留空（复用模型配置 auth.json 同名段）。
export type TtsProviderId = "edge-tts" | "qwen" | "qwen-tokenplan" | "mimo" | "mimo-tokenplan";

export interface TtsProviderConfig {
  apiKey?: string; // 留空 = 复用模型配置（auth.json）同名 provider 的 key；edge-tts 无需 key
  voice?: string; // 该 provider 下的默认音色
}

export interface TtsConfig {
  provider: TtsProviderId; // 默认合成 provider（朗读时优先）
  providers: Record<TtsProviderId, TtsProviderConfig>;
}

export const TTS_PROVIDER_ORDER: TtsProviderId[] = [
  "edge-tts",
  "qwen",
  "qwen-tokenplan",
  "mimo",
  "mimo-tokenplan",
];

const DEFAULT_CONFIG: TtsConfig = {
  provider: "edge-tts",
  providers: {
    "edge-tts": {},
    qwen: { apiKey: "" },
    "qwen-tokenplan": { apiKey: "" },
    mimo: { apiKey: "" },
    "mimo-tokenplan": { apiKey: "" },
  },
};

export function getTtsConfigPath(): string {
  return path.join(getSharedDir(), "tts-config.json");
}

export function loadTtsConfig(): TtsConfig {
  try {
    const raw = fs.readFileSync(getTtsConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      provider: TTS_PROVIDER_ORDER.includes(parsed.provider) ? parsed.provider : "edge-tts",
      providers: {
        ...DEFAULT_CONFIG.providers,
        ...(parsed.providers || {}),
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers } };
  }
}

export function saveTtsConfig(config: TtsConfig): void {
  fs.writeFileSync(getTtsConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

// 打码（供前端展示，绝不返回明文密钥）
export function getMaskedTtsConfig(): TtsConfig {
  const cfg = loadTtsConfig();
  const masked: TtsConfig = { provider: cfg.provider, providers: {} as TtsConfig["providers"] };
  for (const [pname, creds] of Object.entries(cfg.providers)) {
    const m: TtsProviderConfig = {};
    if (creds.apiKey) m.apiKey = maskSecret(creds.apiKey);
    if (creds.voice) m.voice = creds.voice;
    masked.providers[pname as TtsProviderId] = m;
  }
  return masked;
}

// 应用前端补丁：apiKey「空值或含 *」视为未修改（保留原值）；voice 直接覆盖
export function applyTtsConfigPatch(patch: {
  provider?: string;
  providers?: Record<string, TtsProviderConfig>;
}): TtsConfig {
  const cfg = loadTtsConfig();
  if (patch.provider && TTS_PROVIDER_ORDER.includes(patch.provider as TtsProviderId)) {
    cfg.provider = patch.provider as TtsProviderId;
  }
  for (const [pname, creds] of Object.entries(patch.providers || {})) {
    const id = pname as TtsProviderId;
    if (!cfg.providers[id]) cfg.providers[id] = {};
    if (creds.apiKey !== undefined && creds.apiKey && !creds.apiKey.includes("*")) {
      cfg.providers[id].apiKey = creds.apiKey;
    }
    if (creds.voice !== undefined) {
      cfg.providers[id].voice = creds.voice || undefined;
    }
  }
  saveTtsConfig(cfg);
  return cfg;
}

export function maskSecret(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "*".repeat(v.length);
  return v.slice(0, 3) + "****" + v.slice(-4);
}
