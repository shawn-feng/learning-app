/**
 * 服务端 TTS（开放 API 语音回复用）：把 agent 回复合成音频随消息下发给第三方设备。
 *
 * provider 分发（管理端「语音合成模型」下拉统一下发，server 每 5 分钟同步）：
 *  - **edge-tts**（默认）：微软 Edge 在线语音，免费无需 Key，零配置开箱即用；
 *  - **tokenhub**（minimax-speech-* 系）：官方 MiniMax 同步合成代理
 *    POST /v1/wand/minimax-tts/sync_tts（hex 音频、与文本同池计费），用家长托管 Key，
 *    仅 builtin 渠道启用（切自定义/停用 → 回落 edge，不烧家长配额）；
 *  - 其余选项（indextts-2 等）：暂未接入，告警一次后继续用 edge-tts。
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
import { getSystemDefaultModels } from "../auth/tokenhub.js";
let warnedNonEdge = false;
let warnedTokenhubFallback = false;

export interface TtsResult {
  buffer: Buffer;
  mime: "audio/mpeg" | "audio/wav";
  voice: string;
  /** 实际使用的合成模型（管理端默认模型或回落后的 edge-tts） */
  model?: string;
  /** 仅本次真实合成（非缓存命中）且走 TokenHub 时返回；官方计费口径 usage.total_tokens */
  usage?: { total: number };
}

export interface TtsOptions {
  /** edge-tts 音色 id（如 zh-CN-XiaoxiaoNeural）；缺省按文本语种自动选（中文晓晓/英文英音）。
   *  TokenHub 渠道忽略此参数（MiniMax 音色体系不同，固定默认系统音色）。 */
  voice?: string;
  /** 语速，如 "+10%" / "-20%"；默认正常语速 */
  rate?: string;
  volume?: string;
  /**
   * 指定后输出**重采样为该采样率的 16bit 单声道 WAV**（嵌入式设备固定编解码配置直喂，
   * 如 ESP32 播放侧 48k）；缺省输出原生 24kHz MP3。
   */
  sampleRate?: number;
  /** 家长 TokenHub 托管 Key（builtin 渠道时由调用方注入；空 = 不考虑 TokenHub 渠道） */
  tokenhubApiKey?: string;
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

/** 读两级缓存（内存 LRU 命中即回；磁盘命中回填内存） */
function cacheGet(dataDir: string, key: string): Buffer | null {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const fromDisk = tryReadDiskCache(dataDir, key);
  if (fromDisk) {
    cache.set(key, fromDisk);
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return fromDisk;
  }
  return null;
}

/** 写两级缓存（内存 LRU 淘汰最旧；磁盘异步落盘） */
function cachePut(dataDir: string, key: string, buf: Buffer): void {
  cache.set(key, buf);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  setImmediate(() => writeDiskCache(dataDir, key, buf));
}

// 缓存 key 必须包含 provider 模型 + voice + rate + volume + text，否则不同音色/模型会读到错音频
function cacheKey(model: string, text: string, voice: string, rate: string, volume: string): string {
  return crypto.createHash("sha256").update(`${model}\u0000${voice}\u0000${rate}\u0000${volume}\u0000${text}`).digest("hex");
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

// ==================== TokenHub TTS（minimax-speech-* 系，管理端默认模型） ====================
// 官方 MiniMax 同步语音合成代理（2026-10-12 实测 + 文档 /document/product/1823/135796）：
// POST /v1/wand/minimax-tts/sync_tts，{model, text, voice_setting, audio_setting, output_format}
// → {data:{audio:<hex>, status:2}, base_resp:{status_code}, usage:{total_tokens}}；
// 不支持流式；音色/语速/音量走 MiniMax 语义（speed 0.5~2 / vol (0,10]）。

const TOKENHUB_TTS_ENDPOINT = "https://tokenhub.tencentmaas.com/v1/wand/minimax-tts/sync_tts";
/** 默认系统音色（官方文档示例值；MiniMax 音色体系与 edge 不同，设备侧 voice 参数不透传） */
const TOKENHUB_TTS_VOICE = "minimax_55e81114-ce7e-4ca1";

/** 管理端选的合成模型是否走 TokenHub 渠道：仅 minimax-speech-* 已接入且必须有家长 Key。 */
export function pickTtsPlan(model: string, apiKey: string | undefined): "tokenhub" | "edge" {
  return /^minimax-speech-/.test(String(model || "")) && !!apiKey?.trim() ? "tokenhub" : "edge";
}

/** "+10%" / "-20%" / "0%" → speed 倍率（MiniMax [0.5, 2]；非法回落 1.0） */
function rateToSpeed(rate: string): number {
  const pct = Number(String(rate || "").replace("%", ""));
  const speed = Number.isFinite(pct) ? 1 + pct / 100 : 1;
  return Math.min(2, Math.max(0.5, speed));
}

/** "100%" → vol（MiniMax (0, 10]；非法回落 1.0） */
function volumeToVol(volume: string): number {
  const pct = Number(String(volume || "").replace("%", ""));
  const vol = Number.isFinite(pct) && pct > 0 ? pct / 100 : 1;
  return Math.min(10, vol);
}

/** TokenHub 同步合成：返回 24kHz MP3 + 官方计费 tokens（与文本/ASR 同池扣家长配额）。 */
export async function synthesizeTokenhubTts(
  text: string,
  o: { model: string; apiKey: string; rate?: string; volume?: string }
): Promise<{ buffer: Buffer; usage: { total: number } }> {
  const apiKey = (o.apiKey || "").trim();
  if (!apiKey) throw new Error("TokenHub 语音合成缺少 API Key（家长 Key 未发放）");
  const model = (o.model || "").trim();
  if (!/^minimax-speech-/.test(model)) throw new Error(`TokenHub 语音合成不支持模型 ${model || "(空)"}`);
  let res: Response;
  try {
    res = await fetch(TOKENHUB_TTS_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        text,
        voice_setting: { voice_id: TOKENHUB_TTS_VOICE, speed: rateToSpeed(o.rate ?? ""), vol: volumeToVol(o.volume ?? ""), pitch: 0 },
        audio_setting: { sample_rate: 24000, bitrate: 128000, format: "mp3", channel: 1 },
        subtitle_enable: false,
        output_format: "hex",
      }),
    });
  } catch {
    throw new Error("无法连接 TokenHub 语音合成服务");
  }
  const json: any = await res.json().catch(() => ({}));
  const baseCode = json?.base_resp?.status_code;
  if (!res.ok || (baseCode !== undefined && baseCode !== 0)) {
    const msg = json?.base_resp?.status_msg || json?.error?.message_zh || json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`TokenHub 语音合成失败: ${msg}`);
  }
  const data = json?.data ?? {};
  if (data.status !== 2) throw new Error(`TokenHub 语音合成未完成（status=${data.status ?? "?"}）`);
  let buffer: Buffer;
  try {
    buffer = Buffer.from(String(data.audio || ""), "hex");
  } catch {
    throw new Error("TokenHub 语音合成返回音频解码失败");
  }
  if (!buffer.length) throw new Error("TokenHub 语音合成返回空音频");
  const total = Number(json?.usage?.total_tokens);
  return { buffer, usage: { total: Number.isFinite(total) ? total : 0 } };
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
 * 合成语音（带内存 LRU + 磁盘持久缓存；缓存的是原生 24kHz MP3，重采样按需执行）。
 * 渠道分发：管理端默认模型为 minimax-speech-* 且注入了家长 Key → TokenHub；
 * TokenHub 失败回落 edge-tts（回复音频不因合成渠道故障而缺席）；其余一律 edge-tts。
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
  const rate = opts.rate ?? DEFAULT_RATE;
  const volume = opts.volume ?? "100%";

  // 渠道分发：管理端默认模型为 minimax-speech-* 且注入了家长 Key → TokenHub；其余 edge-tts。
  const wantTts = getSystemDefaultModels().tts || "edge-tts";
  let plan = pickTtsPlan(wantTts, opts.tokenhubApiKey);

  if (plan === "tokenhub") {
    const voice = TOKENHUB_TTS_VOICE;
    const key = cacheKey(wantTts, clean, voice, rate, volume);
    const hit = cacheGet(dataDir, key);
    if (hit) return postProcess(hit, opts.sampleRate, voice, wantTts);
    try {
      const r = await synthesizeTokenhubTts(clean, { model: wantTts, apiKey: opts.tokenhubApiKey!, rate, volume });
      cachePut(dataDir, key, r.buffer);
      return postProcess(r.buffer, opts.sampleRate, voice, wantTts, r.usage);
    } catch (e) {
      // 回复音频不因合成渠道故障而缺席：回落 edge-tts（免费，不烧家长配额）
      if (!warnedTokenhubFallback) {
        warnedTokenhubFallback = true;
        console.warn(`[tts] TokenHub 合成（${wantTts}）失败，本轮起回落 edge-tts: ${(e as Error).message}`);
      }
      plan = "edge";
    }
  }

  // 未接入的管理端选项（indextts-2 等）告警一次；minimax-speech-* 已接入（回落场景上一分支已告警）
  if (wantTts !== "edge-tts" && !/^minimax-speech-/.test(wantTts) && !warnedNonEdge) {
    warnedNonEdge = true;
    console.warn(`[tts] 配置的合成模型 ${wantTts} 暂不可用（无对应 provider），继续使用 edge-tts`);
  }
  const model = "edge-tts";
  const voice = opts.voice?.trim() || detectVoice(clean);
  const key = cacheKey(model, clean, voice, rate, volume);
  const hit = cacheGet(dataDir, key);
  if (hit) return postProcess(hit, opts.sampleRate, voice, model);
  const buf = await synthesizeEdgeTts(clean, voice, rate, volume);
  cachePut(dataDir, key, buf);
  return postProcess(buf, opts.sampleRate, voice, model);
}

/** 按 sampleRate 后处理：不指定 → 原生 24kHz MP3；指定 → 重采样 16bit 单声道 WAV。
 *  usage 仅在本次真实走 TokenHub 合成时带出（缓存命中/edge 均无官方计费）。 */
async function postProcess(
  mp3: Buffer,
  sampleRate: number | undefined,
  voice: string,
  model: string,
  usage?: { total: number }
): Promise<TtsResult> {
  if (!sampleRate) return { buffer: mp3, mime: "audio/mpeg", voice, model, usage };
  const wav = await resampleToWav(mp3, sampleRate);
  return { buffer: wav, mime: "audio/wav", voice, model, usage };
}
