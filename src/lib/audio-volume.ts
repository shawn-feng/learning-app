/**
 * ISSUE-183 / ISSUE-189：录音音量口径（客户端统一实现）。
 *
 * ⚠️ 公式与 `server/src/assessment/volume.ts`（服务端兜底）、`src/lib/exam-template.ts`
 * （考核 iframe 独立 HTML，无法 import）**完全一致**——任何一处改公式，三处必须同步。
 *
 * 口径：解码后 PCM 的全程 RMS → dBFS → 0-100 归一分：
 *   norm = clamp(round((20·log10(rms) + 60) × 100/60), 0, 100)   （-60 dBFS → 0 分，0 dBFS → 100 分）
 * 统一在**解码后的 PCM** 上算（webm(opus) 容器电平与 wav 不同，不读容器电平）。
 *
 * 使用场景：
 * - ISSUE-183 考核朗读/背诵题：录完每段算平均音量，不达标不入答案（见 exam-template.ts）。
 * - ISSUE-189 所有录音环节：录音实时音量条 + 送 ASR 前平均音量门（聊天语音输入 / 附件转写 /
 *   考核文字题 ASR），不达标直接拦下、不发送给识别服务。
 * - ISSUE-189 孩子端「声音检测」弹框：录一段、实时看音量、录完给达标结论。
 */

/** 归一分满分区间下限（dBFS）：低于它按 0 分计。 */
export const VOLUME_NORM_FLOOR_DB = -60;

/** 考核录音最低平均音量默认阈值（0-100 归一分）≈ -35 dBFS 档（ISSUE-183 默认值）。 */
export const DEFAULT_MIN_VOLUME_NORM = 42;

/**
 * 语音输入 / ASR 前置音量线的**默认值**（ISSUE-189）：与 ISSUE-183 考核默认阈值同档
 * （42 ≈ -35 dBFS）。实际生效的线由家长端「设置 → 发音评测 → 录音最低平均音量」决定
 * （`assessment_config.minVolumeNorm`，0=不校验），客户端经 `useVolumeThreshold` 读取；
 * 读不到配置时回退本值。考核 iframe 同源用 `GET /exam/config` 的 `examRules.minVolumeNorm`。
 */
export const MIN_ASR_VOLUME_NORM = DEFAULT_MIN_VOLUME_NORM;

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext || w.webkitAudioContext || null;
}

/** RMS（0-1 浮点刻度，int16 需先除 32768）→ 0-100 归一分。静音(rms=0) → 0 分。 */
export function rmsToVolumeNorm(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(100, Math.max(0, Math.round(((db - VOLUME_NORM_FLOOR_DB) * 100) / (0 - VOLUME_NORM_FLOOR_DB))));
}

/** 解析音量阈值：非法/缺省回退 fallback；负数按 0（关闭）计。 */
export function parseVolumeThreshold(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
}

/** 音量门是否开启（0 = 家长关闭校验 / 不拦）。 */
export function isVolumeGateEnabled(minNorm: number): boolean {
  return Number.isFinite(minNorm) && minNorm > 0;
}

/**
 * ASR 前置音量门判定：返回 true = 声音太小、**不要送识别服务**。
 * 测不出音量（null，解码失败/环境不支持）或阈值为 0 时一律放行——不因测不出而卡住孩子。
 */
export function isVolumeTooLow(norm: number | null, minNorm: number): norm is number {
  return norm !== null && isVolumeGateEnabled(minNorm) && norm < minNorm;
}

export type VolumeLevel = "ok" | "close" | "low";

export interface VolumeVerdict {
  level: VolumeLevel;
  /** 儿童友好文案（含本次音量与达标线数值，口径与考核页一致；不显示 dBFS 原始值）。 */
  text: string;
}

/** 平均音量结论：达标 / 还差一点点（差距 ≤8）/ 太小。文案与考核页 volShowMsg 同口径。 */
export function volumeVerdict(norm: number, minNorm: number): VolumeVerdict {
  if (minNorm <= 0 || norm >= minNorm) {
    return { level: "ok", text: `声音刚刚好 ✓（本次 ${norm}，达标线 ${minNorm}）` };
  }
  if (minNorm - norm <= 8) {
    return { level: "close", text: `还差一点点，再大声一些（本次 ${norm}，需要 ${minNorm}）` };
  }
  return { level: "low", text: `太小了听不清，大声说（本次 ${norm}，需要 ${minNorm}）` };
}

/** 音量条着色：达标=绿 / 偏轻=黄 / 太小=红（考核页与聊天实时条同一套色）。 */
export function volumeBarColor(norm: number, minNorm: number): string {
  if (minNorm <= 0 || norm >= minNorm) return "#58a700";
  if (minNorm - norm <= 12) return "#e6a23c";
  return "#ff4b4b";
}

/** AudioBuffer（解码后 PCM）→ 全程平均音量归一分；多声道按样本平均（与考核 iframe、服务端同算）。 */
export function averageVolumeNormOfBuffer(buf: AudioBuffer): number {
  try {
    const channels = buf.numberOfChannels;
    const len = buf.length;
    let sum = 0;
    let count = 0;
    for (let c = 0; c < channels; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        sum += data[i]! * data[i]!;
      }
      count += len;
    }
    return count ? rmsToVolumeNorm(Math.sqrt(sum / count)) : 0;
  } catch {
    return 0;
  }
}

/**
 * 解码整段录音（webm/opus、wav、mp3…）→ 全程平均音量归一分。
 * 解码失败（容器损坏 / 环境不支持）返回 null——调用方据此**放行**，不因测不出音量而卡住孩子。
 */
export async function measureBlobVolumeNorm(blob: Blob): Promise<number | null> {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctor();
    const bytes = await blob.arrayBuffer();
    const audio = await new Promise<AudioBuffer>((resolve, reject) => {
      const p = ctx!.decodeAudioData(bytes.slice(0), resolve, reject);
      // 旧实现（部分 WebView）只支持回调形式、返回 undefined；新实现返回 Promise
      if (p && typeof (p as Promise<AudioBuffer>).then === "function") {
        (p as Promise<AudioBuffer>).then(resolve, reject);
      }
    });
    return averageVolumeNormOfBuffer(audio);
  } catch {
    return null;
  } finally {
    try {
      await ctx?.close();
    } catch {
      /* 关闭失败忽略 */
    }
  }
}

export interface VolumeMeter {
  /** 当前一帧的实时音量归一分（录音中每帧调用，给音量条上色用）。 */
  getNorm(): number;
  /** 释放 AudioContext（必须调用，否则录音流关不掉音频节点）。 */
  close(): void;
}

/**
 * 录音流实时电平表（录音中 AnalyserNode 逐帧 RMS）——聊天语音输入与「声音检测」弹框共用。
 * 创建失败时返回空表（getNorm 恒 0），不阻断录音。
 */
export function createVolumeMeter(stream: MediaStream): VolumeMeter {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return { getNorm: () => 0, close: () => {} };
  let ctx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let buf: Float32Array | null = null;
  try {
    ctx = new Ctor();
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    buf = new Float32Array(analyser.fftSize);
    source.connect(analyser);
    // 不连 destination——只取电平，不把麦克风回放到扬声器（防啸叫）
  } catch {
    try {
      ctx?.close();
    } catch {
      /* 忽略 */
    }
    return { getNorm: () => 0, close: () => {} };
  }
  return {
    getNorm(): number {
      if (!analyser || !buf) return 0;
      try {
        analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
      } catch {
        return 0;
      }
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
      return rmsToVolumeNorm(Math.sqrt(sum / buf.length));
    },
    close(): void {
      try {
        source?.disconnect();
      } catch {
        /* 忽略 */
      }
      analyser = null;
      buf = null;
      try {
        ctx?.close();
      } catch {
        /* 忽略 */
      }
      ctx = null;
    },
  };
}
