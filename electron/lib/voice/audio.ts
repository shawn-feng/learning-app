import ffmpegStatic from "ffmpeg-static";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// ffmpeg 路径解析：FFMPEG_BIN 环境变量 > ffmpeg-static 自带二进制 > 系统 PATH 里的 ffmpeg
function resolveFfmpegPath(): string {
  const envBin = process.env.FFMPEG_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  return "ffmpeg";
}

// 把 webm/opus 音频转成 16kHz / 16bit / 单声道 WAV（阿里云 NLS 与腾讯云 ASR 均支持）
export function webmToWav16k(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = resolveFfmpegPath();
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

    execFile(ffmpegPath, args, { timeout: 30000, maxBuffer: 1024 * 1024 * 64 }, (err) => {
      if (err) {
        cleanup();
        reject(err);
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
    });

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
