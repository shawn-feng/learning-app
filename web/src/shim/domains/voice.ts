/**
 * voice 域（Phase 5 实现）：TTS（Electron 主进程 edge-tts → MP3 → Web speechSynthesis）、
 * STT（ffmpeg 转 wav + 云端 provider → SpeechRecognition 并行听写）、
 * 多段录音合并（ffmpeg PCM → WebAudio 解码 + 纯 JS 重采样 + WAV 编码）、
 * 场景课录音保存、语音配置。签名逐条摘自 electron/preload.ts，返回形状逐通道对齐
 * electron/lib/ipc-handlers.ts（voice:scene_save 1679 / config:get,set 1838-1849 /
 * transcribe 1851 / merge 1864 / tts 1898）。
 *
 * Web 引擎映射（设计方案 §2 映射表 #6/#7/#8）：
 *   - voiceTts：浏览器 speechSynthesis 无法产出 MP3 buffer → 按映射表返回「标记对象」
 *     {success:true, audio:""}，未分支调用点安全 no-op；实际播报一律走 voiceSpeak
 *     （渲染层播放点 web 分支已改道，见 ChatWindow/MaterialsPanel/Learn）。
 *   - voiceTranscribe：浏览器无法转写传入 buffer → 返回并行听写会话（voice/stt.ts，
 *     由 useAudioRecorder web 分支驱动）的识别文本 + 传入音频 base64。
 *   - voiceMerge：WebAudio 解码 → 纯 JS 重采样混单 → 16k/单声道/16bit WAV（voice/wav.ts），
 *     上传服务端 files 通道拿 id 作 path（对齐 files 域的不透明 token 语义，历史消息可回放）。
 *   - voiceConfigGet/Set：STT 配置存 localStorage "web.voiceConfig"，打码/补丁语义对齐
 *     electron/lib/voice/voice-config.ts；Web 用浏览器引擎无需凭证，首次默认开启
 *     （Chrome/Edge 支持 SpeechRecognition 即 enabled=true，对齐 Electron「语音自动开启」决策）。
 *   - piGetTtsConfig/piSetTtsConfig：**不在此域**——models.ts（Phase 2）已实现且共用
 *     localStorage "web.ttsConfig" 存储；本域若重复实现会因 install 展开顺序覆盖它。
 * Web 专属扩展方法（Electron preload 无此签名面，渲染层一律 window.api.__web 守卫后调用）：
 *   voiceSpeak / voiceSpeakCancel / voiceDictationStart / voiceDictationStop。
 */
import { http } from "../core/server-fetch";
import { speak, cancelSpeak, isSpeechSynthesisSupported, type SpeakOptions } from "../voice/tts";
import { startDictation, stopDictation, consumeDictationResult, isSttSupported } from "../voice/stt";
import { base64ToUint8, uint8ToBase64, decodeAudioToMono16k, encodeWav16kMono } from "../voice/wav";

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** ArrayBuffer → base64（分块转换避免 String.fromCharCode 爆栈）。 */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  return uint8ToBase64(new Uint8Array(buf));
}

interface FileUploadResp {
  file?: { id?: string };
}

/** 上传音频到服务端 files 通道（child 归属），返回 fileId。
 *  协议对齐 exam 域 uploadExamVoice（POST /files/upload，multipart child_id + file）。 */
async function uploadVoiceFile(childId: string, originalName: string, buffer: ArrayBuffer): Promise<string> {
  const form = new FormData();
  form.append("child_id", childId);
  form.append("file", new Blob([buffer]), originalName || `voice-${Date.now()}.webm`);
  const res = await http<Response>("/files/upload", {
    method: "POST",
    body: form,
    raw: true,
    timeoutMs: 120000,
  });
  const data = (await res.json()) as FileUploadResp;
  const id = data.file?.id;
  if (!id) throw new Error("语音上传失败：服务端未返回 file id");
  return id;
}

// ---------------------------------------------------------------------------
// 语音输入（STT）配置 —— localStorage "web.voiceConfig"，语义对齐 voice/voice-config.ts
// ---------------------------------------------------------------------------

type SttProviderId = "qwen" | "qwen-tokenplan" | "mimo" | "mimo-tokenplan";

const STT_PROVIDER_ORDER: SttProviderId[] = ["qwen", "qwen-tokenplan", "mimo", "mimo-tokenplan"];

interface SttConfig {
  enabled: boolean;
  provider: SttProviderId;
  providers: Record<string, Record<string, string>>;
}

const LS_KEY_STT = "web.voiceConfig";

/** 默认配置。enabled 初值 = 浏览器支持 SpeechRecognition（对齐 Electron「语音自动开启」：
 *  Web 的浏览器引擎无需凭证即可用，支持即视为「已配置」）。 */
function defaultSttConfig(): SttConfig {
  return {
    enabled: isSttSupported(),
    provider: "qwen",
    providers: {
      qwen: { apiKey: "" },
      "qwen-tokenplan": { apiKey: "", endpoint: "" },
      mimo: { apiKey: "" },
      "mimo-tokenplan": { apiKey: "", endpoint: "" },
    },
  };
}

function loadSttConfig(): SttConfig {
  try {
    const raw = localStorage.getItem(LS_KEY_STT);
    const def = defaultSttConfig();
    if (!raw) return def;
    const parsed = JSON.parse(raw);
    return {
      enabled: !!parsed.enabled,
      provider: STT_PROVIDER_ORDER.includes(parsed.provider) ? parsed.provider : "qwen",
      providers: { ...def.providers, ...(parsed.providers || {}) },
    };
  } catch {
    return defaultSttConfig();
  }
}

function saveSttConfig(config: SttConfig): void {
  try {
    localStorage.setItem(LS_KEY_STT, JSON.stringify(config, null, 2));
  } catch {
    /* 隐私模式等场景静默 */
  }
}

/** 打码（对齐 voice-config.ts maskSecret：首 3 + **** + 尾 4）。 */
function maskSecret(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "*".repeat(v.length);
  return v.slice(0, 3) + "****" + v.slice(-4);
}

/** 打码后的配置（绝不返回明文密钥；对齐 getMaskedConfig 的全字段打码）。 */
function getMaskedSttConfig(): SttConfig {
  const cfg = loadSttConfig();
  const masked: SttConfig = { enabled: cfg.enabled, provider: cfg.provider, providers: {} };
  for (const [pname, creds] of Object.entries(cfg.providers)) {
    const m: Record<string, string> = {};
    for (const [k, v] of Object.entries(creds || {})) {
      m[k] = maskSecret(v);
    }
    masked.providers[pname] = m;
  }
  return masked;
}

/** 应用补丁（对齐 applyVoiceConfigPatch：字段「空值或含 *」视为未修改，跳过保留原值）。 */
function applySttConfigPatch(patch: {
  enabled?: boolean;
  provider?: string;
  providers?: Record<string, Record<string, string>>;
}): void {
  const cfg = loadSttConfig();
  if (patch.enabled !== undefined) cfg.enabled = !!patch.enabled;
  if (patch.provider && STT_PROVIDER_ORDER.includes(patch.provider as SttProviderId)) {
    cfg.provider = patch.provider as SttProviderId;
  }
  for (const [pname, creds] of Object.entries(patch.providers || {})) {
    if (!cfg.providers[pname]) cfg.providers[pname] = {};
    for (const [k, v] of Object.entries(creds || {})) {
      if (v && !v.includes("*")) {
        cfg.providers[pname][k] = v;
      }
    }
  }
  saveSttConfig(cfg);
}

// ---------------------------------------------------------------------------
// window.api 方法
// ---------------------------------------------------------------------------

export const voiceDomain = {
  /**
   * voiceSpeak: (text, opts?) => Promise<boolean>（Web 专属扩展，映射表 #6）。
   * 浏览器 speechSynthesis 播报：resolve(true)=播到终点，false=被打断/取消/出错/不支持。
   * opts.mode：interrupt（默认，点读/查词/朗读，新取代旧）| queue（场景多角色连读 FIFO）。
   * rate 传 edge-tts 风格百分号串（"+0%"/"-50%"…），与聊天朗读档位同源。
   */
  voiceSpeak: (text: string, opts?: SpeakOptions): Promise<boolean> => speak(text, opts),

  /** voiceSpeakCancel: () => void（Web 专属扩展）：停止按钮语义——取消当前播报并清空队列。 */
  voiceSpeakCancel: (): void => cancelSpeak(),

  /**
   * voiceDictationStart: () => Promise<void>（Web 专属扩展）。
   * 起一次 SpeechRecognition 听写会话（与 MediaRecorder 录音并行）。
   * 浏览器不支持时 reject 明确错误；useAudioRecorder web 分支 catch 后降级为只录不识别。
   */
  voiceDictationStart: (): Promise<void> => startDictation(),

  /** voiceDictationStop: () => Promise<{text, error}>（Web 专属扩展）：收尾听写会话并落账。 */
  voiceDictationStop: (): Promise<{ text: string; error: string }> => stopDictation(),

  /** sceneVoiceSave: (childId, data) => Promise<{success; path?; rel?; error?}>（voice:scene_save）
   *  Electron 落 children/<id>/voice/scene/<date>/；Web 上传 files 通道，path/rel 同为
   *  服务端 file id（不透明 token，渲染层 readUpload/附件标记语义不变）。 */
  sceneVoiceSave: async (
    childId: string,
    data: ArrayBuffer
  ): Promise<{ success: boolean; path?: string; rel?: string; error?: string }> => {
    try {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const name = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Date.now().toString(36)}.webm`;
      const id = await uploadVoiceFile(childId, name, data);
      return { success: true, path: id, rel: id };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** voiceConfigGet: () => Promise<{success; config}>（voice:config:get，打码回显）。 */
  voiceConfigGet: async (): Promise<{ success: boolean; config?: SttConfig; error?: string }> => {
    return { success: true, config: getMaskedSttConfig() };
  },

  /** voiceConfigSet: (patch) => Promise<{success; config?; error?}>（voice:config:set，补丁合并语义）。 */
  voiceConfigSet: async (patch: {
    enabled?: boolean;
    provider?: string;
    providers?: Record<string, Record<string, string>>;
  }): Promise<{ success: boolean; config?: SttConfig; error?: string }> => {
    try {
      applySttConfigPatch(patch || {});
      return { success: true, config: getMaskedSttConfig() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /**
   * voiceTranscribe: (audio, onlyProvider?) => Promise<{success; text?; audio?; error?}>（voice:transcribe）。
   * Web 无法转写传入 buffer（无云端 ASR 通道）：识别文本来自并行听写会话（voiceDictation*，
   * 由 useAudioRecorder web 分支驱动），audio=传入音频的 base64（对齐 ipc 返回，供前端播放）。
   * onlyProvider 在 Web 无对应引擎，忽略（签名兼容）。浏览器不支持 → success:false 带明确错误。
   */
  voiceTranscribe: async (
    audio: ArrayBuffer,
    _onlyProvider?: string
  ): Promise<{ success: boolean; text?: string; audio?: string; error?: string }> => {
    let b64 = "";
    try {
      b64 = arrayBufferToBase64(audio);
    } catch {
      /* 空/异常音频：不阻断文本返回 */
    }
    if (!isSttSupported()) {
      return { success: false, error: "当前浏览器不支持语音识别（需 Chrome/Edge）", audio: b64 };
    }
    const { text, error } = consumeDictationResult();
    if (error && !text) {
      return { success: false, error, audio: b64 };
    }
    // 对齐 ipc：success 时 {text, audio}；静音/无结果 text=""，走渲染层现有容错
    return { success: true, text, audio: b64 };
  },

  /**
   * voiceMerge: (childId, segments) => Promise<{success; path?; data?; error?}>（voice:merge）。
   * segments=各段录音的 base64（voiceTranscribe 返回的 audio / 前端自采 webm，与 Electron 同为
   * 自包含内容引用）。Web 链路：base64 → WebAudio 解码（坏段跳过，对齐 mergeWebmSegments）
   * → 16kHz 单声道重采样 → 16bit PCM 拼接 → 标准 WAV → 上传 files 通道拿 id 作 path
   * （历史消息 readUpload 回放走同一 token；上传失败不阻断——path 缺省仅当场播放 data 可用）。
   * data=合并 WAV 的 base64，对齐 ipc（前端立即播放/直接交评测）。
   */
  voiceMerge: async (
    childId: string,
    segments: string[]
  ): Promise<{ success: boolean; path?: string; data?: string; error?: string }> => {
    try {
      if (!Array.isArray(segments) || segments.length < 2) {
        return { success: false, error: "需要至少两段录音才能合并" };
      }
      const pcms: Float32Array[] = [];
      for (const seg of segments) {
        try {
          const bytes = base64ToUint8(seg);
          // 过短段跳过（对齐 webmToWav16k 的 2000 字节下限：极短录音只有 EBML 头无音频帧）
          if (bytes.length < 2000) continue;
          pcms.push(await decodeAudioToMono16k(bytes.buffer));
        } catch {
          // 单段坏数据（不完整 webm/解码失败）：跳过该段继续合并其余
        }
      }
      if (!pcms.length) return { success: false, error: "所有音频段均无法转换，合并失败" };
      const wav = encodeWav16kMono(pcms);
      let path = "";
      try {
        path = await uploadVoiceFile(childId, `${Date.now()}-merged.wav`, wav);
      } catch {
        /* 服务端不可达：不阻断发送，仅当场播放可用（path 为空渲染层按未落盘处理） */
      }
      return { success: true, path, data: uint8ToBase64(new Uint8Array(wav)) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /**
   * voiceTts: (text, opts?) => Promise<{success; audio}>（voice:tts 的 Web 标记实现）。
   * 浏览器 speechSynthesis 无法产出 MP3 buffer → 按映射表 #6 返回标记对象：
   * success=true 且 audio=""——未分支的调用点因 `!r.audio` 安全 no-op，不再崩；
   * 实际播报一律走 voiceSpeak（渲染层播放点已 web 分支改道）。
   */
  voiceTts: async (text: string, opts?: any): Promise<{ success: boolean; audio: string }> => {
    void text;
    void opts;
    return { success: true, audio: "" };
  },
};
