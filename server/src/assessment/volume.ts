// ISSUE-183：考核录音平均音量校验——统一音量口径（服务端兜底 / 客户端 iframe 前置校验共用一份公式）。
// ⚠️ 客户端侧的同公式实现：src/lib/exam-template.ts（iframe 是独立 HTML，无法 import，改动必须两边同步）。
//
// 口径：解码后 PCM 的全程 RMS（均方根）→ dBFS → 0-100 归一分：
//   norm = clamp(round((20·log10(rms) + 60) × 100/60), 0, 100)   （-60 dBFS → 0 分，0 dBFS → 100 分）
// 校验统一在解码后的 PCM 上算（webm(opus) 容器电平与 wav 不同，不读容器电平）；
// 多段合并的在合并后整体算一次（合并 RMS ≥ 各段 RMS 最小值，故"每段达标 ⇒ 合并达标"）。

/** 归一分满分区间下限（dBFS）：低于它按 0 分计。 */
const NORM_FLOOR_DB = -60;

/** 考核录音最低平均音量默认阈值（0-100 归一分）≈ -35 dBFS 档（ISSUE-183：默认值待真实孩子录音实测校准）。 */
export const DEFAULT_EXAM_MIN_VOLUME_NORM = 42;

/** 朗读/背诵通过线家长默认值（ISSUE-183：维度平均分口径下可由家长自行调整）。 */
export const DEFAULT_EXAM_RECITE_PASS = 90;

/** RMS（0-1 浮点刻度，int16 需先除 32768）→ 0-100 归一分。静音(rms=0) → 0 分。 */
export function rmsToVolumeNorm(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(100, Math.max(0, Math.round(((db - NORM_FLOOR_DB) * 100) / (0 - NORM_FLOOR_DB))));
}

/** 解析家长设置的阈值：非法/缺省回退 fallback；负数按 0（不校验）计。 */
export function parseVolumeThreshold(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
}

/** 同上，通过线：0-100 之外回退 fallback。 */
export function parsePassLine(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
}
