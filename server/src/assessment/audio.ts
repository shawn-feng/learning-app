// 服务端音频转换：webm/opus → 16kHz / 单声道 / 16bit WAV。
// 依赖系统 ffmpeg（或 FFMPEG_BIN 环境变量指向的可执行文件）。
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logInfo } from "../log.js";

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
    // windowsHide：子进程不挂到父进程的控制台/窗口站——长运行进程的终端会话失效后，
    // 新建控制台子进程会以 0xC0000142 (STATUS_DLL_INIT_FAILED) 整批失败（2026-10-01 实测）
    execFile(bin, ["-version"], { timeout: 15000, windowsHide: true }, (err) => {
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
      // 探测结果落日志：转码报错时能对上"服务端当时用的是哪个 ffmpeg"（PATH/FFMPEG_BIN 差异排查）
      logInfo("ffmpeg", "probe resolved", { bin });
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
  return toWav16k(input);
}

/**
 * 通用音频转码：任意输入 → 16kHz / 16bit / 单声道 WAV。
 * - inputFormat="auto"（默认）：自描述格式（wav/webm/opus/mp3/amr…），ffmpeg 按内容探测；
 * - inputFormat="s16le"：**裸 PCM**（嵌入式设备直传，无文件头），必须给 sampleRate/channels
 *   才能正确解读（开放 API 语音消息的 ESP32 48k 录音直传路径）。
 * 输出一律 16k/单声道/16bit PCM WAV（ASR/评测的标准输入）。
 */
export async function toWav16k(
  input: Buffer,
  opts: { inputFormat?: "auto" | "s16le"; sampleRate?: number; channels?: number } = {}
): Promise<Buffer> {
  const MIN_BYTES = 2000;
  if (input.length < MIN_BYTES) {
    return Promise.reject(
      new Error(
        `录音数据过短或为空（${input.length} 字节），无法解析。请按住麦克风说完整的一句话再松手。`
      )
    );
  }

  const inputFormat = opts.inputFormat ?? "auto";
  if (inputFormat === "s16le" && (!opts.sampleRate || opts.sampleRate <= 0)) {
    return Promise.reject(new Error("裸 PCM 上传必须提供 sample_rate（录音采样率，如 48000）"));
  }

  const ffmpegPath = await probeFfmpeg();
  return new Promise((resolve, reject) => {
    const ext = inputFormat === "s16le" ? "raw" : "webm";
    const tmpIn = path.join(
      os.tmpdir(),
      `assess-in-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    );
    const tmpOut = path.join(
      os.tmpdir(),
      `assess-out-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
    );
    fs.writeFileSync(tmpIn, input);

    // 裸 PCM：输入侧显式声明格式（-f s16le -ar X -ac Y），否则 ffmpeg 按内容自探测
    const inputArgs =
      inputFormat === "s16le"
        ? ["-f", "s16le", "-ar", String(opts.sampleRate), "-ac", String(opts.channels ?? 1)]
        : [];
    const args = ["-y", ...inputArgs, "-i", tmpIn, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmpOut];

    execFile(
      ffmpegPath,
      args,
      { timeout: 30000, maxBuffer: 1024 * 1024 * 64, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          // 完整 stderr 尾部 + 退出码原样带回（不做关键词过滤）——转码失败的原因必须可归因
          //（2026-10-01 实测教训：按关键词过滤会漏掉 Permission denied 类错误，导致只剩空详情）
          const detail = String(stderr || "")
            .trim()
            .split("\n")
            .slice(-6)
            .map((l) => l.trim())
            .join(" | ")
            .slice(-600);
          const exitCode = (err as any).code ?? "unknown";
          reject(
            new Error(
              `音频转换失败（ffmpeg exit=${exitCode}，输入 ${input.length} 字节，已保留原始文件 ${tmpIn}）` +
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
