import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// ffmpeg-static 是带原生二进制的 npm 包：
// 1) 打包后二进制必须在 asar 外才能 exec（已在 package.json 用 asarUnpack 解包到 app.asar.unpacked）；
// 2) 二进制架构必须与运行的 dmg 一致（x64 dmg 必须含 x64 ffmpeg，arm64 dmg 必须含 arm64 ffmpeg），
//    否则 Intel Mac 跑到 arm64 ffmpeg 会直接执行失败。
// 用懒 require + 容错，避免该模块缺失/不可用时拖垮整个语音功能，并给出可操作的报错。
function getFfmpegStaticPath(): string | null {
  try {
    // ffmpeg-static 经 electron-vite externalizeDepsPlugin 外部化，运行时直接 require
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require("ffmpeg-static");
    return typeof p === "string" ? p : null;
  } catch (e) {
    console.warn(`[voice] 无法加载 ffmpeg-static 模块（${os.platform()}/${os.arch()}）：${(e as Error).message}`);
    return null;
  }
}

// ffmpeg 候选路径（按优先级）：FFMPEG_BIN 环境变量 > ffmpeg-static 自带二进制 > 系统 PATH 里的 ffmpeg
// 注意：ffmpeg-static 的二进制可能因下载中断而残缺（PE 节表超出实际文件大小），
// existsSync 检查无法识别，必须实际执行探测（见 probeFfmpeg）。
function ffmpegCandidates(): string[] {
  const list: string[] = [];
  const envBin = process.env.FFMPEG_BIN;
  if (envBin && fs.existsSync(envBin)) list.push(envBin);
  const staticPath = getFfmpegStaticPath();
  if (staticPath && fs.existsSync(staticPath)) list.push(staticPath);
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

// 探测第一个能正常执行的 ffmpeg（执行 -version 验证），结果缓存
export function probeFfmpeg(): Promise<string> {
  if (cachedFfmpeg) return Promise.resolve(cachedFfmpeg);
  if (probing) return probing;
  probing = (async () => {
    const errors: string[] = [];
    for (const bin of ffmpegCandidates()) {
      try {
        await runFfmpegVersion(bin);
        cachedFfmpeg = bin;
        console.log(`[voice] 使用 ffmpeg: ${bin}`);
        return bin;
      } catch (e) {
        errors.push(`${bin}: ${(e as Error).message.split("\n")[0]}`);
        console.warn(`[voice] ffmpeg 不可用 ${bin}:`, (e as Error).message.split("\n")[0]);
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

// 把 webm/opus 音频转成 16kHz / 16bit / 单声道 WAV（阿里云 NLS / 腾讯云 / 千问 ASR 均支持）
export async function webmToWav16k(input: Buffer): Promise<Buffer> {
  // 空 / 半成品 webm 直接快速失败：MediaRecorder 极短录音或麦克风无数据时，
  // 输出可能只有 EBML 容器头、不含音频帧（Chromium 已知行为）。ffmpeg 对这类
  // 输入（0 字节 ~ 1KB 级）一律报 "Invalid data found when processing input"，
  // 前端 size 阈值已收紧，这里主进程兜底 + 报出实际大小便于排查。
  // 有效录音（≥250ms opus，16kHz mono）通常 > 2KB，此阈值不会误伤正常输入。
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
      `stt-in-${Date.now()}-${Math.random().toString(36).slice(2)}.webm`
    );
    const tmpOut = path.join(
      os.tmpdir(),
      `stt-out-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
    );
    fs.writeFileSync(tmpIn, input);

    const args = [
      "-y",
      "-i",
      tmpIn,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      tmpOut,
    ];

    execFile(
      ffmpegPath,
      args,
      { timeout: 30000, maxBuffer: 1024 * 1024 * 64 },
      (err, _stdout, stderr) => {
        if (err) {
          // 保留输入文件（tmpdir 由系统定期清理），路径随错误返回，便于复现排查
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
      // 成功路径一并删除输入 webm（错误路径有意保留 tmpIn 便于复现排查，见上）
      try {
        fs.unlinkSync(tmpIn);
      } catch {}
    }
  });
}

// ===== ISSUE-021：多段 webm 语音合并为单个 WAV =====
// webmToWav16k 输出为 16kHz / 单声道 / 16bit PCM 的标准 WAV。
// 合并策略：逐段转 WAV → 抽取 PCM 数据 → 拼接 → 重写 44 字节标准头，
// 无需再跑 ffmpeg concat，且输出格式与单段完全一致（浏览器可播）。

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
    // chunk 之间按字对齐（偶数长度）
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

/** 把多段 PCM 拼成标准 44 字节头 + 拼接体的 WAV Buffer。 */
export function concatWav(pcmChunks: Buffer[]): Buffer {
  if (!pcmChunks.length) throw new Error("没有可拼接的音频段");
  const total = pcmChunks.reduce((n, c) => n + c.length, 0);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + total, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk 大小
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(16000, 24); // 采样率
  header.writeUInt32LE(16000 * 1 * 2, 28); // 字节率 = sampleRate * channels * bytesPerSample
  header.writeUInt16LE(2, 32); // block align = channels * bytesPerSample
  header.writeUInt16LE(16, 34); // 位深
  header.write("data", 36, "ascii");
  header.writeUInt32LE(total, 40);
  return Buffer.concat([header, ...pcmChunks]);
}

/**
 * 把多段 webm/opus 录音合并为单个 16k/单声道/16bit WAV Buffer。
 * 单段失败会被跳过（其余段仍合并），避免一段坏数据丢掉整段语音。
 */
export async function mergeWebmSegments(segments: Buffer[]): Promise<Buffer> {
  if (!segments.length) throw new Error("没有可合并的音频段");
  const pcms: Buffer[] = [];
  for (const seg of segments) {
    try {
      const wav = await webmToWav16k(seg);
      pcms.push(extractWavPcm(wav));
    } catch {
      // 单段转换失败（如仍是不完整 webm）：跳过该段，继续合并其余
    }
  }
  if (!pcms.length) throw new Error("所有音频段均无法转换，合并失败");
  return concatWav(pcms);
}
