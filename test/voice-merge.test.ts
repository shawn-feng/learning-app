import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";

import { probeFfmpeg, extractWavPcm, concatWav, mergeWebmSegments, webmToWav16k } from "../electron/lib/voice/audio";

// ISSUE-021：多段 webm 语音（多次按住说话）合并为单个 16k/单声道/16bit WAV。
// 合并核心 = 逐段转 WAV → 抽 PCM → 拼接 → 重写 44 字节标准头，无需 ffmpeg concat。

/** 手工构造一个最小合法 PCM WAV（16k/单声道/16bit），用于纯函数测试 */
function makeWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(16000 * 1 * 2, 28); // 字节率
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // 位深
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const tmpCleanup: string[] = [];
async function genWebm(durationSec: number): Promise<Buffer> {
  const ffmpeg = await probeFfmpeg();
  const out = path.join(os.tmpdir(), `gen-${Date.now()}-${Math.random().toString(36).slice(2)}.webm`);
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      ["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`, "-c:a", "libopus", out],
      { timeout: 20000 },
      (err) => {
        if (err) return reject(err);
        const buf = fs.readFileSync(out);
        tmpCleanup.push(out);
        resolve(buf);
      }
    );
  });
}
afterEach(() => {
  for (const p of tmpCleanup.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
});

describe("extractWavPcm：WAV 解析与格式校验", () => {
  it("抽取标准 PCM 数据（不含 44 字节头）", () => {
    const pcm = Buffer.from(new Uint8Array(1000).map((_, i) => i % 256));
    const wav = makeWav(pcm);
    expect(extractWavPcm(wav).equals(pcm)).toBe(true);
  });

  it("非 WAV 文件报错", () => {
    expect(() => extractWavPcm(Buffer.from("NOTAWAVfilecontentxxxx"))).toThrow(/非 WAV/);
  });

  it("非 16k/单声道/16bit 的 WAV 报错", () => {
    const pcm = Buffer.alloc(200);
    const wav = makeWav(pcm);
    wav.writeUInt32LE(44100, 24); // 改成 44100
    expect(() => extractWavPcm(wav)).toThrow(/采样率/);
  });
});

describe("concatWav：PCM 拼接 + 重写信头", () => {
  it("拼接两段，data 长度 = 两段之和，头部字段正确", () => {
    const a = Buffer.alloc(9600, 1); // 0.3s @16k*2
    const b = Buffer.alloc(9600, 2); // 0.3s
    const merged = concatWav([a, b]);
    expect(merged.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(merged.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(merged.readUInt16LE(20)).toBe(1); // PCM
    expect(merged.readUInt16LE(22)).toBe(1); // 单声道
    expect(merged.readUInt32LE(24)).toBe(16000);
    expect(merged.readUInt16LE(34)).toBe(16); // 16bit
    const dataSize = merged.readUInt32LE(40);
    expect(dataSize).toBe(19200);
    expect(merged.subarray(44, 44 + 9600).equals(a)).toBe(true);
    expect(merged.subarray(44 + 9600, 44 + 19200).equals(b)).toBe(true);
  });

  it("空数组拼接抛错", () => {
    expect(() => concatWav([])).toThrow();
  });
});

describe("mergeWebmSegments：端到端合并", () => {
  it("两段 webm 合并为单个 WAV，data 长度约等于两段之和", async () => {
    const seg1 = await genWebm(0.3);
    const seg2 = await genWebm(0.3);
    const p1 = extractWavPcm(await webmToWav16k(seg1));
    const p2 = extractWavPcm(await webmToWav16k(seg2));
    const merged = await mergeWebmSegments([seg1, seg2]);
    expect(merged.subarray(0, 4).toString("ascii")).toBe("RIFF");
    const dataSize = merged.readUInt32LE(40);
    expect(Math.abs(dataSize - (p1.length + p2.length))).toBeLessThanOrEqual(40);
  }, 30000);

  it("空输入抛错", async () => {
    await expect(mergeWebmSegments([])).rejects.toThrow(/没有可合并/);
  });

  it("单段坏数据被跳过，其余段仍合并成功", async () => {
    const good = await genWebm(0.3);
    const bad = Buffer.alloc(3000, 0x41); // 非媒体数据
    const merged = await mergeWebmSegments([bad, good]);
    expect(merged.subarray(0, 4).toString("ascii")).toBe("RIFF");
    const expected = extractWavPcm(await webmToWav16k(good)).length;
    const dataSize = merged.readUInt32LE(40);
    expect(Math.abs(dataSize - expected)).toBeLessThanOrEqual(40);
  }, 30000);
});
