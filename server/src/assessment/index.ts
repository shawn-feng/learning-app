// 发音评测统一入口（服务端）：读取服务端配置后，按 provider 分流到对应引擎。
// 音频输入 = 原始录音 buffer（webm/opus，与 voice 转写链路一致），内部统一转 16k 单声道 wav。
import type { DatabaseSync } from "node:sqlite";
import { loadAssessmentConfig } from "./config.js";
import { assess as tencentAssess } from "./providers/tencent-soe.js";
import { assess as aliyunAssess } from "./providers/aliyun-ssecp.js";
import { webmToWav16k } from "./audio.js";
import type { AssessmentProviderId, AssessmentResult } from "./types.js";

export async function assessAudio(
  db: DatabaseSync,
  parentId: string,
  dataDir: string,
  audio: Buffer,
  opts: { provider?: AssessmentProviderId; refText?: string } = {}
): Promise<AssessmentResult> {
  const cfg = loadAssessmentConfig(db, parentId, dataDir);
  if (!cfg.enabled) throw new Error("发音评测未启用，请先在「设置 → 发音评测」中开启并配置评测服务");
  const id = (opts.provider || cfg.provider) as AssessmentProviderId;
  const creds = cfg.providers[id];
  if (!creds) throw new Error(`未找到评测服务配置：${id}`);

  let wav: Buffer;
  try {
    wav = await webmToWav16k(audio);
  } catch (e) {
    throw new Error(`音频转 16k wav 失败（录音太短或格式异常）：${(e as Error).message}`);
  }

  if (id === "tencent-soe") return tencentAssess(wav, creds, { refText: opts.refText || "" });
  if (id === "aliyun-ssecp") return aliyunAssess(wav, creds, { refText: opts.refText || "" });
  throw new Error(`未知评测服务：${id}`);
}

export { loadAssessmentConfig, getMaskedAssessmentConfig, applyAssessmentConfigPatch } from "./config.js";
export type { AssessmentConfig } from "./config.js";
export type { AssessmentProviderId, AssessmentResult, SpeechAssessment } from "./types.js";
export { toSpeechAssessment } from "./toSpeechAssessment.js";
