import { EdgeTTS } from "@andresaya/edge-tts";
import crypto from "crypto";
import { synthesizeQwenTts, QWEN_TTS_VOICES } from "./providers/qwen-tts";
import { synthesizeMimoTts, MIMO_TTS_VOICES } from "./providers/mimo-tts";
import { loadTtsConfig, type TtsProviderId } from "./tts-config";

export interface TtsOptions {
  /** 合成 provider（edge-tts | qwen | qwen-tokenplan | mimo | mimo-tokenplan）；缺省读设置页配置，再缺省 edge-tts */
  provider?: string;
  voice?: string;
  rate?: string | number;
  volume?: string | number;
}

// 语音选型（对齐 wowenglish 偏好：中文晓晓，英文英音，正常语速 1.0）
const VOICE_ZH = "zh-CN-XiaoxiaoNeural";
const VOICE_EN = "en-GB-SoniaNeural";
const DEFAULT_RATE = "0%"; // 1.0 倍语速（正常语速）

// edge-tts（微软 Edge 在线语音，免费无需 Key）常用音色
const EDGE_TTS_VOICES: Array<{ voiceId: string; name: string }> = [
  { voiceId: "zh-CN-XiaoxiaoNeural", name: "晓晓（中文·女声）" },
  { voiceId: "zh-CN-XiaoyiNeural", name: "晓伊（中文·女声·活泼）" },
  { voiceId: "zh-CN-YunxiNeural", name: "云希（中文·男声·阳光）" },
  { voiceId: "zh-CN-YunyangNeural", name: "云扬（中文·男声·新闻）" },
  { voiceId: "zh-CN-liaoning-XiaobeiNeural", name: "晓北（中文·东北女声）" },
  { voiceId: "zh-CN-shaanxi-XiaoniNeural", name: "晓妮（中文·陕西女声）" },
  { voiceId: "zh-HK-HiuGaaiNeural", name: "曉佳（粤语·女声）" },
  { voiceId: "zh-TW-HsiaoChenNeural", name: "曉臻（台湾·女声）" },
  { voiceId: "en-GB-SoniaNeural", name: "Sonia（英文·英音女声）" },
  { voiceId: "en-US-AriaNeural", name: "Aria（英文·美音女声）" },
];

// 可选的语音合成（TTS）清单：「语音模型」= 合成 provider + 音色，key 格式 "provider/voiceId"。
// 与设置页「语音配置 → 语音合成」下拉同源；qwen/mimo 各分按量与 token-plan 套餐两通道（key 复用模型配置）。
export const TTS_VOICES: Array<{ provider: string; voiceId: string; name: string }> = [
  ...EDGE_TTS_VOICES.map((v) => ({ provider: "edge-tts", voiceId: v.voiceId, name: v.name })),
  ...QWEN_TTS_VOICES.map((voiceId) => ({ provider: "qwen", voiceId, name: `千问·${voiceId}` })),
  ...QWEN_TTS_VOICES.map((voiceId) => ({
    provider: "qwen-tokenplan",
    voiceId,
    name: `千问(套餐)·${voiceId}`,
  })),
  ...MIMO_TTS_VOICES.map((voiceId) => ({ provider: "mimo", voiceId, name: `MiMo·${voiceId}` })),
  ...MIMO_TTS_VOICES.map((voiceId) => ({
    provider: "mimo-tokenplan",
    voiceId,
    name: `MiMo(套餐)·${voiceId}`,
  })),
];

// 内存 LRU 缓存：命中即秒回，避免重复请求在线合成服务
const CACHE_MAX = 100;
const cache = new Map<string, Buffer>();

// 缓存 key 必须包含 provider + voice + rate + volume + text，否则不同 provider/音色会读到错音频
function cacheKey(
  provider: string,
  text: string,
  voice: string,
  rate: string | number,
  volume: string | number
): string {
  const raw = `${provider}\u0000${voice}\u0000${rate}\u0000${volume}\u0000${text}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// 清洗朗读文本：去掉 emoji 和 markdown 标记，保留正常句子标点（。，！？等），避免 TTS 读出不自然的符号
function cleanTtsText(text: string): string {
  return text
    // markdown 图片/链接：[alt](url) 和 ![alt](url) 都只保留 alt 文字
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 去掉 emoji（含变体选择符、肤色修饰符、零宽连接符）
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu, "")
    // 去掉 markdown 强调/代码符号 * _ ~ `
    .replace(/[*_~`]/g, "")
    // 去掉行首的标题 #、引用 >、列表 - +（后跟空格）
    .replace(/^[#>\-+]\s+/gm, "")
    // 收缩连续空白，压缩多余换行
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 简单语言检测：英文字符占比过半则用英音，否则中文
function detectVoice(text: string): string {
  const enCount = (text.match(/[a-zA-Z]/g) || []).length;
  const total = text.replace(/[\s\p{P}\p{S}]/gu, "").length;
  if (total > 0 && enCount / total > 0.5) return VOICE_EN;
  return VOICE_ZH;
}

// edge-tts 合成（免费，无需 Key）
async function synthesizeEdgeTts(
  text: string,
  voice: string,
  rate: string | number,
  volume: string | number
): Promise<Buffer> {
  const tts = new EdgeTTS();
  await tts.synthesize(text, voice, {
    rate,
    volume,
    outputFormat: "audio-24khz-96kbitrate-mono-mp3",
  });
  return tts.toBuffer();
}

// 合成语音，返回 MP3 Buffer（带 LRU 缓存）。
// provider 优先级：显式 opts.provider > 设置页「语音合成」默认（tts-config）> edge-tts（免费）。
// voice 优先级：显式 opts.voice > 设置页该 provider 默认音色 > edge-tts 按文本语言自动选（中文晓晓/英文英音）。
// qwen / mimo 的 apiKey 由 providers 内部解析：语音配置填的优先，留空复用模型配置（auth.json）同名段。
export async function synthesize(text: string, opts: TtsOptions = {}): Promise<Buffer> {
  const clean = cleanTtsText(text || "");
  if (!clean) throw new Error("朗读文本为空");

  const cfg = loadTtsConfig();
  const provider = (opts.provider || cfg.provider || "edge-tts") as TtsProviderId;
  const pcfg = cfg.providers[provider] || {};
  const isEdge = provider === "edge-tts";
  const voice = opts.voice || pcfg.voice || (isEdge ? detectVoice(clean) : "");
  if (!voice && !isEdge) throw new Error("语音合成缺省音色未配置，请先在设置中选择朗读音色");

  const rate = opts.rate ?? DEFAULT_RATE;
  const volume = opts.volume ?? "100%";
  const key = cacheKey(provider, clean, voice, rate, volume);

  // 命中缓存：移到队尾（LRU）后直接返回
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  let buf: Buffer;
  switch (provider) {
    case "qwen":
    case "qwen-tokenplan":
      buf = await synthesizeQwenTts(clean, voice, provider === "qwen-tokenplan", pcfg);
      break;
    case "mimo":
    case "mimo-tokenplan":
      buf = await synthesizeMimoTts(clean, voice, provider === "mimo-tokenplan", pcfg);
      break;
    case "edge-tts":
    default:
      buf = await synthesizeEdgeTts(clean, voice, rate, volume);
      break;
  }

  // 写入缓存，超上限淘汰最旧一条
  cache.set(key, buf);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return buf;
}
