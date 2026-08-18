import ffmpegStatic from "ffmpeg-static";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// ffmpeg 候选路径（按优先级）：FFMPEG_BIN 环境变量 > ffmpeg-static 自带二进制 > 系统 PATH 里的 ffmpeg
// 注意：ffmpeg-static 的 exe 可能因下载中断而残缺（PE 节表超出实际文件大小），
// existsSync/MZ 头检查无法识别，必须实际执行探测。
function ffmpegCandidates(): string[] {
  const envBin = process.env.FFMPEG_BIN;
  const list: string[] = [];
  if (envBin && fs.existsSync(envBin)) list.push(envBin);
  if (ffmpegStatic && typeof ffmpegStatic === "string" && fs.existsSync(ffmpegStatic)) {
    list.push(ffmpegStatic);
  }
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
          cleanup();
          // 提取 stderr 里的关键错误行，便于定位（如 End of file / Invalid data 等）
          const detail = String(stderr || "")
            .split("\n")
            .filter((l) => /Error|Invalid|End of file|not found|No such/i.test(l))
            .slice(0, 3)
            .map((l) => l.trim())
            .join(" | ");
          reject(
            new Error(
              `音频转换失败（ffmpeg）${detail ? `：${detail}` : `：${(err as Error).message.split("\n")[0]}`}`
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
        fs.unlinkSync(tmpIn);
      } catch {}
      try {
        fs.unlinkSync(tmpOut);
      } catch {}
    }
  });
}
