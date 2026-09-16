/**
 * models 域（Phase 2 实现）——移植 electron/lib/ipc-handlers.ts 的 pi:* 模型通道 +
 * electron/lib/server-agent-client.ts / voice/tts-config.ts 的语义：
 *   - piGetModels：GET /models → 直接返回 [{provider,id,name,input}] 数组（ipc 形态，
 *     ModelSelector 用 Array.isArray 消费）；失败返回 {success:false,error}（同 ipc）。
 *   - piSwitchModel：薄客户端已改为家长级模型（服务端 app_settings.defaultModel），
 *     与 ipc pi:switch_model 一致返回引导到设置页的错误。
 *   - 默认/编程/视觉模型：GET /models/settings 读 app_settings.<field>；
 *     写走 POST /models/app_settings 合并端点（绝无整键覆盖，ISSUE-097）。
 *     默认模型维度为**家长级**（无 childId 维度，与 Electron 一致）。
 *     set 成功后经 eventBus 发 pi:default_model_changed（对齐 ipc 向所有窗口广播）。
 *   - piSetApiKey：POST /models/apikey（服务端合并进 auth 封套加密落盘）。
 *   - piCheckProvider：POST /models/check（30s 超时对齐 checkProviderAuth）。
 *   - TTS 配置：Electron 存本地 shared/tts-config.json（设备级、不上云）→ Web 存
 *     localStorage "web.ttsConfig"，打码/补丁语义逐行对齐 voice/tts-config.ts
 *     （apiKey 含 * 或空 = 未修改；voice 直接覆盖）。voices 音色清单：Web 朗读引擎为
 *     浏览器 speechSynthesis（Phase 5 接管播放），这里返回 edge-tts（免费默认项）的
 *     音色目录保持下拉结构一致；qwen/mimo 为服务端 HTTP TTS，浏览器无法直连，
 *     不列（选了也不可用）。
 */
import { http } from "../core/server-fetch";
import { eventBus } from "../core/event-bus";

// ---------------------------------------------------------------------------
// TTS 配置（localStorage，设备级；对齐 electron/lib/voice/tts-config.ts）
// ---------------------------------------------------------------------------

type TtsProviderId = "edge-tts" | "qwen" | "qwen-tokenplan" | "mimo" | "mimo-tokenplan";

interface TtsProviderConfig {
  apiKey?: string;
  voice?: string;
}

interface TtsConfig {
  provider: TtsProviderId;
  providers: Record<TtsProviderId, TtsProviderConfig>;
}

const TTS_PROVIDER_ORDER: TtsProviderId[] = [
  "edge-tts",
  "qwen",
  "qwen-tokenplan",
  "mimo",
  "mimo-tokenplan",
];

const DEFAULT_TTS_CONFIG: TtsConfig = {
  provider: "edge-tts",
  providers: {
    "edge-tts": {},
    qwen: { apiKey: "" },
    "qwen-tokenplan": { apiKey: "" },
    mimo: { apiKey: "" },
    "mimo-tokenplan": { apiKey: "" },
  },
};

const LS_KEY_TTS = "web.ttsConfig";

/** edge-tts 免费音色目录（移植 electron/lib/voice/tts.ts EDGE_TTS_VOICES；Web 经 speechSynthesis 尽力映射）。 */
const WEB_TTS_VOICES: Array<{ provider: string; voiceId: string; name: string }> = [
  { provider: "edge-tts", voiceId: "zh-CN-XiaoxiaoNeural", name: "晓晓（中文·女声）" },
  { provider: "edge-tts", voiceId: "zh-CN-XiaoyiNeural", name: "晓伊（中文·女声·活泼）" },
  { provider: "edge-tts", voiceId: "zh-CN-YunxiNeural", name: "云希（中文·男声·阳光）" },
  { provider: "edge-tts", voiceId: "zh-CN-YunyangNeural", name: "云扬（中文·男声·新闻）" },
  { provider: "edge-tts", voiceId: "zh-CN-liaoning-XiaobeiNeural", name: "晓北（中文·东北女声）" },
  { provider: "edge-tts", voiceId: "zh-CN-shaanxi-XiaoniNeural", name: "晓妮（中文·陕西女声）" },
  { provider: "edge-tts", voiceId: "zh-HK-HiuGaaiNeural", name: "曉佳（粤语·女声）" },
  { provider: "edge-tts", voiceId: "zh-TW-HsiaoChenNeural", name: "曉臻（台湾·女声）" },
  { provider: "edge-tts", voiceId: "en-GB-SoniaNeural", name: "Sonia（英文·英音女声）" },
  { provider: "edge-tts", voiceId: "en-US-AriaNeural", name: "Aria（英文·美音女声）" },
];

function loadTtsConfig(): TtsConfig {
  try {
    const raw = localStorage.getItem(LS_KEY_TTS);
    if (!raw) return { ...DEFAULT_TTS_CONFIG, providers: { ...DEFAULT_TTS_CONFIG.providers } };
    const parsed = JSON.parse(raw);
    return {
      provider: TTS_PROVIDER_ORDER.includes(parsed.provider) ? parsed.provider : "edge-tts",
      providers: {
        ...DEFAULT_TTS_CONFIG.providers,
        ...(parsed.providers || {}),
      },
    };
  } catch {
    return { ...DEFAULT_TTS_CONFIG, providers: { ...DEFAULT_TTS_CONFIG.providers } };
  }
}

function saveTtsConfig(config: TtsConfig): void {
  try {
    localStorage.setItem(LS_KEY_TTS, JSON.stringify(config, null, 2));
  } catch {
    /* 隐私模式等场景静默 */
  }
}

/** 打码（对齐 maskSecret，绝不返回明文密钥）。 */
function maskSecret(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "*".repeat(v.length);
  return v.slice(0, 3) + "****" + v.slice(-4);
}

function getMaskedTtsConfig(): TtsConfig {
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

/** 应用前端补丁（对齐 applyTtsConfigPatch：apiKey 空或含 * 视为未修改）。 */
function applyTtsConfigPatch(patch: {
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

// ---------------------------------------------------------------------------
// app_settings 读写辅助（对齐 getModelSettings/setAppSettings）
// ---------------------------------------------------------------------------

async function getAppSettingsField(field: string): Promise<string> {
  const s = await http<{ appSettings: Record<string, unknown> }>("/models/settings");
  return String((s.appSettings as Record<string, unknown>)[field] ?? "");
}

async function setAppSettingsField(field: string, key: string): Promise<void> {
  await http("/models/app_settings", { method: "POST", body: { [field]: key } });
}

// ---------------------------------------------------------------------------
// window.api 方法
// ---------------------------------------------------------------------------

export const modelsDomain = {
  /** piGetModels: () => Promise<Array<{provider,id,name,input}> | {success:false,error}>（GET /models） */
  piGetModels: async (): Promise<unknown> => {
    try {
      const data = await http<{ models: Array<{ provider: string; id: string; name?: string; input?: string[] }> }>("/models");
      const models = data?.models ?? [];
      return models.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name || m.id,
        input: m.input || [],
      }));
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** piSwitchModel: (childId, provider, modelId) => Promise<{ success: false; error: string }>（薄客户端：模型已收口家长级，对齐 ipc） */
  piSwitchModel: async (
    _childId: string,
    _provider: string,
    _modelId: string
  ): Promise<{ success: boolean; error: string }> => {
    return { success: false, error: "模型已改为家长级（服务端），请在设置页修改默认模型。" };
  },

  /** piGetDefaultModel: () => Promise<{ success: boolean; key: string; error?: string }>（app_settings.defaultModel） */
  piGetDefaultModel: async (): Promise<{ success: boolean; key: string; error?: string }> => {
    try {
      return { success: true, key: await getAppSettingsField("defaultModel") };
    } catch (err) {
      return { success: false, error: (err as Error).message, key: "" };
    }
  },

  /** piSetDefaultModel: (key) => Promise<{ success: boolean; key: string; error?: string }>（成功后广播 pi:default_model_changed） */
  piSetDefaultModel: async (key: string): Promise<{ success: boolean; key: string; error?: string }> => {
    try {
      await setAppSettingsField("defaultModel", key || "");
      eventBus.emit("pi:default_model_changed", key || "");
      return { success: true, key: key || "" };
    } catch (err) {
      return { success: false, error: (err as Error).message, key: "" };
    }
  },

  /** piGetProgrammingModel: () => Promise<{ success: boolean; key: string; error?: string }>（app_settings.programmingModel，空=未配置） */
  piGetProgrammingModel: async (): Promise<{ success: boolean; key: string; error?: string }> => {
    try {
      return { success: true, key: await getAppSettingsField("programmingModel") };
    } catch (err) {
      return { success: false, error: (err as Error).message, key: "" };
    }
  },

  /** piSetProgrammingModel: (key) => Promise<{ success: boolean; key: string; error?: string }> */
  piSetProgrammingModel: async (key: string): Promise<{ success: boolean; key: string; error?: string }> => {
    try {
      await setAppSettingsField("programmingModel", key || "");
      return { success: true, key: key || "" };
    } catch (err) {
      return { success: false, error: (err as Error).message, key: "" };
    }
  },

  /** piGetVisionModel: () => Promise<{ success: boolean; key: string; error?: string }>（app_settings.visionModel） */
  piGetVisionModel: async (): Promise<{ success: boolean; key: string; error?: string }> => {
    try {
      return { success: true, key: await getAppSettingsField("visionModel") };
    } catch (err) {
      return { success: false, error: (err as Error).message, key: "" };
    }
  },

  /** piSetVisionModel: (key) => Promise<{ success: boolean; key: string; error?: string }> */
  piSetVisionModel: async (key: string): Promise<{ success: boolean; key: string; error?: string }> => {
    try {
      await setAppSettingsField("visionModel", key || "");
      return { success: true, key: key || "" };
    } catch (err) {
      return { success: false, error: (err as Error).message, key: "" };
    }
  },

  /** piGetTtsConfig: () => Promise<{ success: boolean; config: TtsConfig; voices: Array<{provider,voiceId,name}> }>（打码配置 + 音色清单） */
  piGetTtsConfig: async (): Promise<{
    success: boolean;
    config: TtsConfig;
    voices: Array<{ provider: string; voiceId: string; name: string }>;
  }> => {
    return { success: true, config: getMaskedTtsConfig(), voices: WEB_TTS_VOICES };
  },

  /** piSetTtsConfig: (patch) => Promise<{ success: boolean; config: TtsConfig; provider: TtsProviderId }> */
  piSetTtsConfig: async (patch: {
    provider?: string;
    providers?: Record<string, TtsProviderConfig>;
  }): Promise<{ success: boolean; config: TtsConfig; provider: TtsProviderId }> => {
    const cfg = applyTtsConfigPatch(patch || {});
    return { success: true, config: getMaskedTtsConfig(), provider: cfg.provider };
  },

  /** onPiDefaultModelChanged: (callback) => 取消订阅函数（pi:default_model_changed，经 eventBus） */
  onPiDefaultModelChanged: (callback: (key: string) => void): (() => void) => {
    return eventBus.on("pi:default_model_changed", (key: string) => callback(key));
  },

  /** piSetApiKey: (provider, apiKey) => Promise<{ success: boolean; error?: string }>（POST /models/apikey） */
  piSetApiKey: async (provider: string, apiKey: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await http("/models/apikey", { method: "POST", body: { provider, apiKey } });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** piCheckProvider: (provider) => Promise<{ success: boolean; status?: boolean; error?: string }>（POST /models/check，30s 真实探测） */
  piCheckProvider: async (provider: string): Promise<{ success: boolean; status?: boolean; error?: string }> => {
    try {
      const r = await http<{ ok: boolean; status: boolean }>("/models/check", {
        method: "POST",
        body: { provider },
        timeoutMs: 30000,
      });
      return { success: true, status: r.status === true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};
