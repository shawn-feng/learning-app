import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";

import { probeFfmpeg, webmToWav16k } from "../electron/lib/voice/audio";

// ISSUE-014：MediaRecorder 极短录音/无数据时输出「只有 EBML 头」的半成品 webm，
// ffmpeg 对 0 字节 ~1KB 级输入一律报 "Invalid data found when processing input"。
// 修复：输入 < 2000 字节直接快速失败（前端阈值同步收紧）；ffmpeg 失败保留原始文件 + 报大小。
// 注：ffmpeg 用 probeFfmpeg() 探测（FFMPEG_BIN > ffmpeg-static > 系统 PATH），
// 避免依赖 ffmpeg-static 的二进制在本机损坏时测试全挂（实测 Windows 下 5.3.0 段错误）。

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

describe("webmToWav16k：半成品输入防护（ISSUE-014）", () => {
  it("0 字节输入快速失败，不调 ffmpeg", async () => {
    await expect(webmToWav16k(Buffer.alloc(0))).rejects.toThrow(/录音数据过短或为空/);
  });

  it("小于 2000 字节的输入（只有容器头的半成品）快速失败", async () => {
    const tiny = Buffer.alloc(500, 0x1a); // 模拟仅有 EBML 头的半成品
    await expect(webmToWav16k(tiny)).rejects.toThrow(/录音数据过短或为空（500 字节）/);
  });

  it("有效 webm（≥250ms）正常转换为 16k WAV", async () => {
    const webm = await genWebm(0.5);
    expect(webm.length).toBeGreaterThan(2000);
    const wav = await webmToWav16k(webm);
    // RIFF header
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    // 16kHz 单声道 16bit
    const sampleRate = wav.readUInt32LE(24);
    const channels = wav.readUInt16LE(22);
    expect(sampleRate).toBe(16000);
    expect(channels).toBe(1);
  });

  it("ffmpeg 解析失败时错误带输入大小与保留的原始文件路径", async () => {
    // >2000 字节但非媒体数据 → ffmpeg Invalid data，应保留文件供排查
    const garbage = Buffer.alloc(3000, 0x41);
    const err = await webmToWav16k(garbage).catch((e: Error) => e);
    expect(err.message).toMatch(/音频转换失败（ffmpeg/);
    expect(err.message).toMatch(/输入 3000 字节/);
    const m = err.message.match(/已保留原始文件 (.+?)[)）]/);
    expect(m).not.toBeNull();
    // 文件确实被保留
    const kept = m![1];
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.statSync(kept).size).toBe(3000);
    tmpCleanup.push(kept);
  });
});
