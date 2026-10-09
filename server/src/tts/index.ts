/**
 * 服务端 TTS（开放 API 语音回复用）：把 agent 回复合成音频随消息下发给第三方设备。
 *
 * V1 provider：**edge-tts**（微软 Edge 在线语音，免费无需 Key，客户端「语音合成」的默认项）——
 * 零配置开箱即用；qwen/mimo TTS 待其凭证上收服务端后按 asr_config 同款范式接入（provider 分发点已留）。
 *
 * 文本清洗/语种探测/缓存键规则逐字移植自 electron/lib/voice/tts.ts（家长端朗读），缓存独立：
 * <dataDir>/tts-cache/<sha256>.mp3（服务端数据目录，与客户端缓存互不相干）。
 */
import { EdgeTTS } from "@andresaya/edge-tts";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { probeFfmpeg } from "../assessment/audio.js";

export interface TtsResult {
  buffer: Buffer;
  mime: "audio/mpeg" | "audio/wav";
  voice: string;
}

export interface TtsOptions {
  /** edge-tts 音色 id（如 zh-CN-XiaoxiaoNeural）；缺省按文本语种自动选（中文晓晓/英文英音） */
  voice?: string;
  /** 语速，如 "+10%" / "-20%"；默认正常语速 */
  rate?: string;
  volume?: string;
  /**
   * 指定后输出**重采样为该采样率的 16bit 单声道 WAV**（嵌入式设备固定编解码配置直喂，
   * 如 ESP32 播放侧 48k）；缺省输出 edge-tts 原生 24kHz MP3。
   */
  sampleRate?: number;
}

// 语音选型（对齐客户端偏好：中文晓晓，英文英音，正常语速 1.0）
const VOICE_ZH = "zh-CN-XiaoxiaoNeural";
const VOICE_EN = "en-GB-SoniaNeural";
const DEFAULT_RATE = "0%"; // 1.0 倍语速（正常语速）

// 内存 LRU 缓存：命中即秒回，避免重复请求在线合成服务
const CACHE_MAX = 100;
const cache = new Map<string, Buffer>();

function getTtsCacheDir(dataDir: string): string {
  return path.join(dataDir, "tts-cache");
}

function diskCachePath(dataDir: string, key: string): string {
  return path.join(getTtsCacheDir(dataDir), `${key}.mp3`);
}

function tryReadDiskCache(dataDir: string, key: string): Buffer | null {
  try {
    return fs.readFileSync(diskCachePath(dataDir, key));
  } catch {
    return null;
  }
}

function writeDiskCache(dataDir: string, key: string, buf: Buffer): void {
  try {
    fs.mkdirSync(getTtsCacheDir(dataDir), { recursive: true });
    fs.writeFileSync(diskCachePath(dataDir, key), buf);
  } catch {
    /* 写盘失败不影响返回 */
  }
}

// 缓存 key 必须包含 voice + rate + volume + text，否则不同音色会读到错音频
function cacheKey(text: string, voice: string, rate: string, volume: string): string {
  return crypto.createHash("sha256").update(`edge-tts\u0000${voice}\u0000${rate}\u0000${volume}\u0000${text}`).digest("hex");
}

/** 清洗朗读文本：去掉 emoji 和 markdown 标记，保留正常句子标点，避免 TTS 读出不自然的符号（逐字移植客户端） */
export function cleanTtsText(text: string): string {
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

/** 简单语言检测：英文字符占比过半则用英音，否则中文（逐字移植客户端） */
export function detectVoice(text: string): string {
  const enCount = (text.match(/[a-zA-Z]/g) || []).length;
  const total = text.replace(/[\s\p{P}\p{S}]/gu, "").length;
  if (total > 0 && enCount / total > 0.5) return VOICE_EN;
  return VOICE_ZH;
}

/** edge-tts 合成（免费，无需 Key） */
async function synthesizeEdgeTts(
  text: string,
  voice: string,
  rate: string,
  volume: string
): Promise<Buffer> {
  const tts = new EdgeTTS();
  await tts.synthesize(text, voice, {
    rate,
    volume,
    outputFormat: "audio-24khz-96kbitrate-mono-mp3",
  });
  return tts.toBuffer();
}

/** MP3 → 指定采样率 / 16bit / 单声道 WAV（ffmpeg 重采样；供固定采样率的播放端直喂编解码器） */
async function resampleToWav(mp3: Buffer, sampleRate: number): Promise<Buffer> {
  const ffmpegPath = await probeFfmpeg();
  const tmpIn = path.join(fs.realpathSync(os.tmpdir()), `tts-in-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  const tmpOut = path.join(fs.realpathSync(os.tmpdir()), `tts-out-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  fs.writeFileSync(tmpIn, mp3);
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ["-y", "-i", tmpIn, "-ar", String(sampleRate), "-ac", "1", "-c:a", "pcm_s16le", tmpOut],
      { timeout: 30000, maxBuffer: 1024 * 1024 * 64, windowsHide: true },
      (err) => {
        if (err) {
          reject(new Error(`TTS 音频重采样失败（ffmpeg → ${sampleRate}Hz）：${(err as Error).message.split("\n")[0]}`));
          try { fs.unlinkSync(tmpIn); } catch { /* 忽略 */ }
          return;
        }
        try {
          const wav = fs.readFileSync(tmpOut);
          resolve(wav);
        } catch (e) {
          reject(e);
        } finally {
          try { fs.unlinkSync(tmpOut); } catch { /* 忽略 */ }
          try { fs.unlinkSync(tmpIn); } catch { /* 忽略 */ }
        }
      }
    );
  });
}

/**
 * 合成语音（带内存 LRU + 磁盘持久缓存；缓存的是 edge-tts 原生 MP3，重采样按需执行）。
 * @param dataDir 服务端数据目录（缓存落盘位置）
 * @throws 文本为空 / 在线合成失败（网络等）
 */
export async function synthesizeReply(
  text: string,
  opts: TtsOptions,
  dataDir: string
): Promise<TtsResult> {
  const clean = cleanTtsText(text || "");
  if (!clean) throw new Error("朗读文本为空");
  const voice = opts.voice?.trim() || detectVoice(clean);
  const rate = opts.rate ?? DEFAULT_RATE;
  const volume = opts.volume ?? "100%";
  const key = cacheKey(clean, voice, rate, volume);

  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return postProcess(hit, opts.sampleRate, voice);
  }
  const fromDisk = tryReadDiskCache(dataDir, key);
  if (fromDisk) {
    cache.set(key, fromDisk);
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return postProcess(fromDisk, opts.sampleRate, voice);
  }

  // provider 分发点：V1 仅 edge-tts；qwen/mimo TTS 凭证上收后在此扩展（对齐 TTS_PROVIDER_ORDER）
  const buf = await synthesizeEdgeTts(clean, voice, rate, volume);

  cache.set(key, buf);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  setImmediate(() => writeDiskCache(dataDir, key, buf));
  return postProcess(buf, opts.sampleRate, voice);
}

/** 按 sampleRate 后处理：不指定 → 原生 24kHz MP3；指定 → 重采样 16bit 单声道 WAV */
async function postProcess(mp3: Buffer, sampleRate: number | undefined, voice: string): Promise<TtsResult> {
  if (!sampleRate) return { buffer: mp3, mime: "audio/mpeg", voice };
  const wav = await resampleToWav(mp3, sampleRate);
  return { buffer: wav, mime: "audio/wav", voice };
}
