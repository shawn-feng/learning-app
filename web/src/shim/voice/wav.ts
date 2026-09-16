/**
 * voice/wav.ts（Phase 5）：多段录音合并的 Web 实现。
 *
 * 对齐 electron/lib/voice/audio.ts 的合并语义（mergeWebmSegments）：
 *   webm/opus 多段 → 解码 → 统一 16kHz / 单声道 → 16bit PCM 拼接 → 标准 44 字节头 WAV。
 * 引擎差异：
 *   - Electron：ffmpeg 逐段转 16k wav → 抽 PCM 拼接；
 *   - Web：AudioContext.decodeAudioData 解码 → 纯 JS 线性插值重采样混单 → 直接编码 WAV。
 * 输出与 Electron 完全一致：16kHz / 单声道 / 16bit PCM WAV（SSECP 评测与 <audio> 播放直吃）。
 *
 * 纯函数（audioBufferToMono16k / encodeWav16kMono / base64 互转）不触碰浏览器全局，
 * 可在 Node 下单测；仅 decodeAudioToMono16k 依赖 WebAudio。
 */

/** DOM AudioBuffer 的最小结构面（便于 Node 侧构造合成入参单测）。 */
export interface AudioBufferLike {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

// ---------------------------------------------------------------------------
// base64 ↔ 字节（分块转换避免 String.fromCharCode / btoa 爆栈；对齐 files.ts 写法）
// ---------------------------------------------------------------------------

/** base64 → 字节（严格校验非空；非法输入抛错由调用方按「坏段跳过」处理）。 */
export function base64ToUint8(b64: string): Uint8Array {
  const clean = String(b64 || "").trim();
  if (!clean) throw new Error("空音频数据");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 字节 → base64（分块 apply 防 argument 上限）。 */
export function uint8ToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
  }
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// 解码 + 重采样混单
// ---------------------------------------------------------------------------

/**
 * 任意 AudioBuffer → 16kHz 单声道 Float32 PCM（-1..1）。
 * 多声道先平均混单，再线性插值重采样（语音场景质量足够，无 OfflineAudioContext 的
 * 采样率范围限制，Node 侧可对合成入参直接单测）。
 */
export function audioBufferToMono16k(audio: AudioBufferLike): Float32Array {
  const { sampleRate, length, numberOfChannels } = audio;
  if (!length || sampleRate <= 0) return new Float32Array(0);

  // 多声道 → 单声道（逐样本平均；单声道直接引用）
  let mono: Float32Array;
  if (numberOfChannels <= 1) {
    mono = audio.getChannelData(0);
  } else {
    mono = new Float32Array(length);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = audio.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i] += data[i];
    }
    for (let i = 0; i < length; i++) mono[i] /= numberOfChannels;
  }

  if (sampleRate === 16000) return mono;
  // 线性插值重采样到 16k
  const ratio = 16000 / sampleRate;
  const outLen = Math.max(1, Math.floor(length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, length - 1);
    const frac = pos - i0;
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }
  return out;
}

/**
 * 浏览器解码任意容器音频（webm/opus 等）→ 16kHz 单声道 PCM。
 * 用一次性 AudioContext 解码（用完即关）；浏览器不支持 WebAudio 时抛明确错误。
 */
export async function decodeAudioToMono16k(data: ArrayBufferLike): Promise<Float32Array> {
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext || w.webkitAudioContext;
  if (!Ctor) throw new Error("当前浏览器不支持 WebAudio，无法解码录音");
  const ctx = new Ctor();
  try {
    // slice 防 decodeAudioData detach 调用方 buffer（ArrayBufferLike → 独立 ArrayBuffer）
    const audio = await ctx.decodeAudioData((data as ArrayBuffer).slice(0));
    return audioBufferToMono16k(audio);
  } catch (err) {
    throw new Error(`音频解码失败（${(err as Error).message || "格式不支持"}）`);
  } finally {
    ctx.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// WAV 编码
// ---------------------------------------------------------------------------

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * 多段 16kHz 单声道 Float32 PCM → 标准 44 字节头 WAV（16k/单声道/16bit）。
 * 头部逐字段对齐 electron/lib/voice/audio.ts concatWav（RIFF/WAVE/fmt PCM/16000/1ch/16bit）。
 */
export function encodeWav16kMono(pcmChunks: Float32Array[]): ArrayBuffer {
  if (!pcmChunks.length) throw new Error("没有可拼接的音频段");
  const total = pcmChunks.reduce((n, c) => n + c.length * 2, 0);
  const out = new ArrayBuffer(44 + total);
  const view = new DataView(out);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + total, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk 大小
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, 16000, true); // 采样率
  view.setUint32(28, 16000 * 1 * 2, true); // 字节率 = sampleRate * channels * bytesPerSample
  view.setUint16(32, 2, true); // block align = channels * bytesPerSample
  view.setUint16(34, 16, true); // 位深
  writeAscii(view, 36, "data");
  view.setUint32(40, total, true);

  let off = 44;
  for (const chunk of pcmChunks) {
    for (let i = 0; i < chunk.length; i++) {
      let s = chunk[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      // 浮点 → 16bit（负/正满幅分别映射 -32768 / 32767，避免 +1 溢出回卷）
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return out;
}
