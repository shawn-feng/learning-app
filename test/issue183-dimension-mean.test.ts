/**
 * ISSUE-183 需求 B 回归：发音评测最终分 = 各维度平均（不再单独采信引擎综合分）。
 *
 * 背景：aliyun-ssecp 原样采信 `overall ?? pron`（综合权重不可控，低音量下与维度分走向不一致），
 * tencent-soe 采信 `SuggestedScore`。改为 accuracy/fluency/integrity（智聆 Pron* 三维）取平均
 * （四舍五入）；三个维度都缺才回退综合分，再缺回退 0。
 * 同文件顺带锁音量归一分公式（客户端 exam-template 与服务端 volume.ts 两端同口径的锚）。
 */
import { describe, expect, it } from "vitest";
import { parseSsecpResult } from "../server/src/assessment/providers/aliyun-ssecp";
import { parseSoeResult } from "../server/src/assessment/providers/tencent-soe";
import { dimensionMeanScore } from "../server/src/assessment/score";
import { rmsToVolumeNorm, DEFAULT_EXAM_MIN_VOLUME_NORM } from "../server/src/assessment/volume";
import { wavAverageVolumeNorm } from "../server/src/assessment/audio";

describe("ISSUE-183 维度平均：dimensionMeanScore 基础语义", () => {
  it("三个维度取平均并四舍五入", () => {
    expect(dimensionMeanScore([80, 70, 100], 55)).toBe(83); // (80+70+100)/3 = 83.33
    expect(dimensionMeanScore([90, 90, 90], 0)).toBe(90);
  });

  it("维度部分缺失：只平均存在的维度", () => {
    expect(dimensionMeanScore([80, undefined, 100], 55)).toBe(90);
    expect(dimensionMeanScore([undefined, 70, null], 55)).toBe(70);
  });

  it("三维度全缺 → 回退综合分；综合分也缺/非法 → 0", () => {
    expect(dimensionMeanScore([undefined, NaN, null], 66)).toBe(66);
    expect(dimensionMeanScore([], 55.4)).toBe(55);
    expect(dimensionMeanScore([], undefined)).toBe(0);
  });
});

describe("ISSUE-183 维度平均：aliyun-ssecp（声希）", () => {
  it("accuracy/fluency/integrity 平均作为最终分（不采信 overall）", () => {
    const r = parseSsecpResult(
      { result: { accuracy: 80, fluency: { overall: 70 }, integrity: 100, overall: 55, details: [] } },
      "cn.pred.score"
    );
    expect(r.score).toBe(83);
    expect(r.accuracy).toBe(80);
    expect(r.fluency).toBe(70);
    expect(r.completeness).toBe(100);
  });

  it("维度缺失：缺哪个不平均哪个；全缺回退 overall", () => {
    const partial = parseSsecpResult({ result: { accuracy: 60, integrity: 80, overall: 10 } }, "cn.pred.score");
    expect(partial.score).toBe(70);
    const fallback = parseSsecpResult({ result: { overall: 44 } }, "cn.pred.score");
    expect(fallback.score).toBe(44);
    const empty = parseSsecpResult({ result: {} }, "cn.pred.score");
    expect(empty.score).toBe(0);
  });
});

describe("ISSUE-183 维度平均：tencent-soe（智聆，同口径对齐）", () => {
  it("Pron* 三维平均作为最终分（不采信 SuggestedScore）", () => {
    const r = parseSoeResult({ PronAccuracy: 60, PronFluency: 80, PronCompletion: 100, SuggestedScore: 50 });
    expect(r.score).toBe(80);
  });

  it("维度全缺 → 回退 SuggestedScore；再缺 → 0", () => {
    expect(parseSoeResult({ SuggestedScore: 77 }).score).toBe(77);
    expect(parseSoeResult({}).score).toBe(0);
  });
});

describe("ISSUE-183 音量归一分（两端同口径的公式锚）", () => {
  it("RMS → 0-100：-35dBFS 档 ≈ 42（默认阈值），0 dBFS = 100，静音 = 0", () => {
    expect(rmsToVolumeNorm(Math.pow(10, -35 / 20))).toBe(DEFAULT_EXAM_MIN_VOLUME_NORM);
    expect(rmsToVolumeNorm(1)).toBe(100);
    expect(rmsToVolumeNorm(0)).toBe(0);
    expect(rmsToVolumeNorm(Number.NaN)).toBe(0);
  });

  it("wavAverageVolumeNorm：对 16k/单声道/16bit WAV 全程 RMS 计分", () => {
    // 正弦波 RMS = 峰值/√2：0.2 → -17.0 dBFS → 72 分
    expect(wavAverageVolumeNorm(makeWav(0.2, 0.2))).toBe(72);
    // 0.005 → -49 dBFS → 18 分，低于默认阈值 42
    expect(wavAverageVolumeNorm(makeWav(0.005, 0.2))).toBeLessThan(DEFAULT_EXAM_MIN_VOLUME_NORM);
  });
});

/** 造 16kHz/单声道/16bit PCM WAV（正弦波，指定峰值幅度），供音量计算断言。 */
function makeWav(amplitude: number, seconds: number): Buffer {
  const rate = 16000;
  const samples = Math.floor(rate * seconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // 字节率
  header.writeUInt16LE(2, 32); // 块对齐
  header.writeUInt16LE(16, 34); // 位深
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
