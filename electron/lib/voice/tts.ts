import { EdgeTTS } from "@andresaya/edge-tts";
import crypto from "crypto";

export interface TtsOptions {
  voice?: string;
  rate?: string | number;
  volume?: string | number;
}

// 语音选型（对齐 wowenglish 偏好：中文晓晓，英文英音，正常语速 1.0）
const VOICE_ZH = "zh-CN-XiaoxiaoNeural";
const VOICE_EN = "en-GB-SoniaNeural";
const DEFAULT_RATE = "0%"; // 1.0 倍语速（正常语速）

// 内存 LRU 缓存：命中即秒回，避免重复请求 Edge TTS 在线服务
const CACHE_MAX = 100;
const cache = new Map<string, Buffer>();

// 缓存 key 必须包含 voice + rate + volume + text，否则不同音色/语速会读到错音频
function cacheKey(
  text: string,
  voice: string,
  rate: string | number,
  volume: string | number
): string {
  const raw = `${voice}\u0000${rate}\u0000${volume}\u0000${text}`;
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

// 合成语音，返回 MP3 Buffer（带 LRU 缓存）
export async function synthesize(text: string, opts: TtsOptions = {}): Promise<Buffer> {
  const clean = cleanTtsText(text || "");
  if (!clean) throw new Error("朗读文本为空");

  const voice = opts.voice || detectVoice(clean);
  const rate = opts.rate ?? DEFAULT_RATE;
  const volume = opts.volume ?? "100%";
  const key = cacheKey(clean, voice, rate, volume);

  // 命中缓存：移到队尾（LRU）后直接返回
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const tts = new EdgeTTS();
  await tts.synthesize(clean, voice, {
    rate,
    volume,
    outputFormat: "audio-24khz-96kbitrate-mono-mp3",
  });
  const buf = tts.toBuffer();

  // 写入缓存，超上限淘汰最旧一条
  cache.set(key, buf);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return buf;
}
