// 服务端音频转换：webm/opus → 16kHz / 单声道 / 16bit WAV。
// 依赖系统 ffmpeg（或 FFMPEG_BIN 环境变量指向的可执行文件）。
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function ffmpegCandidates(): string[] {
  const list: string[] = [];
  const envBin = process.env.FFMPEG_BIN;
  if (envBin && fs.existsSync(envBin)) list.push(envBin);
  list.push("ffmpeg"); // 系统 PATH
  return list;
}

let cachedFfmpeg: string | null = null;
let probing: Promise<string> | null = null;

function runFfmpegVersion(bin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, ["-version"], { timeout: 15000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** 探测第一个能正常执行 `-version` 的 ffmpeg，结果缓存 */
export function probeFfmpeg(): Promise<string> {
  if (cachedFfmpeg) return Promise.resolve(cachedFfmpeg);
  if (probing) return probing;
  probing = (async () => {
    const errors: string[] = [];
    for (const bin of ffmpegCandidates()) {
      try {
        await runFfmpegVersion(bin);
        cachedFfmpeg = bin;
        return bin;
      } catch (e) {
        errors.push(`${bin}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    throw new Error(
      `未找到可用的 ffmpeg（${errors.join("；")}）。请安装 ffmpeg 或设置 FFMPEG_BIN 环境变量指向有效可执行文件`
    );
  })().finally(() => {
    probing = null;
  });
  return probing;
}

// 把 webm/opus 音频转成 16kHz / 16bit / 单声道 WAV（智聆 / 声希评测输入）
export async function webmToWav16k(input: Buffer): Promise<Buffer> {
  const MIN_WEBM_BYTES = 2000;
  if (input.length < MIN_WEBM_BYTES) {
    return Promise.reject(
      new Error(
        `录音数据过短或为空（${input.length} 字节），无法解析。请按住麦克风说完整的一句话再松手。`
      )
    );
  }

  const ffmpegPath = await probeFfmpeg();
  return new Promise((resolve, reject) => {
    const tmpIn = path.join(
      os.tmpdir(),
      `assess-in-${Date.now()}-${Math.random().toString(36).slice(2)}.webm`
    );
    const tmpOut = path.join(
      os.tmpdir(),
      `assess-out-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
    );
    fs.writeFileSync(tmpIn, input);

    const args = ["-y", "-i", tmpIn, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmpOut];

    execFile(
      ffmpegPath,
      args,
      { timeout: 30000, maxBuffer: 1024 * 1024 * 64 },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = String(stderr || "")
            .split("\n")
            .filter((l) => /Error|Invalid|End of file|not found|No such/i.test(l))
            .slice(0, 3)
            .map((l) => l.trim())
            .join(" | ");
          reject(
            new Error(
              `音频转换失败（ffmpeg，输入 ${input.length} 字节，已保留原始文件 ${tmpIn}）` +
                (detail ? `：${detail}` : `：${(err as Error).message.split("\n")[0]}`)
            )
          );
          return;
        }
        try {
          const wav = fs.readFileSync(tmpOut);
          cleanup();
          resolve(wav);
        } catch (e) {
          cleanup();
          reject(e);
        }
      }
    );

    function cleanup() {
      try {
        fs.unlinkSync(tmpOut);
      } catch {}
      try {
        fs.unlinkSync(tmpIn);
      } catch {}
    }
  });
}

/** 解析 WAV，抽取 PCM 数据并校验为 16k/单声道/16bit PCM。返回纯 PCM 字节。 */
export function extractWavPcm(wav: Buffer): Buffer {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("非 WAV 文件");
  }
  let offset = 12;
  let fmt: { audioFormat: number; sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + size;
    if (id === "fmt ") {
      fmt = {
        audioFormat: wav.readUInt16LE(bodyStart),
        sampleRate: wav.readUInt32LE(bodyStart + 4),
        channels: wav.readUInt16LE(bodyStart + 2),
        bitsPerSample: wav.readUInt16LE(bodyStart + 14),
      };
    } else if (id === "data") {
      data = wav.subarray(bodyStart, bodyEnd);
    }
    offset = bodyEnd + (size % 2);
  }
  if (!fmt) throw new Error("WAV 缺少 fmt 块");
  if (fmt.audioFormat !== 1) throw new Error(`WAV 非 PCM 格式(${fmt.audioFormat})`);
  if (fmt.sampleRate !== 16000) throw new Error(`WAV 采样率非 16k(${fmt.sampleRate})`);
  if (fmt.channels !== 1) throw new Error(`WAV 非单声道(${fmt.channels})`);
  if (fmt.bitsPerSample !== 16) throw new Error(`WAV 非 16bit(${fmt.bitsPerSample})`);
  if (!data) throw new Error("WAV 缺少 data 块");
  return data;
}
