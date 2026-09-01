// 发音评测统一入口：家长端配置评测服务（智聆 / 阿里儿童）。
// 输入 = 原始录音 buffer（webm/opus，与 voice 转写链路一致）：先统一转 16k 单声道 wav，
// 再调对应 provider 评测（智聆内部会再抽 PCM），返回统一 AssessmentResult。
// 后续英语角模式下：录音 → ASR 转写（voice 链路）与 assessAudio 并行，
// 以 ASR 文本回填 refText 自评分（自由对话无参考文本）。
import type { AssessmentProviderId, AssessmentResult } from "./types";
import {
  loadAssessmentConfig,
  saveAssessmentConfig,
  getMaskedAssessmentConfig,
  applyAssessmentConfigPatch,
  isAssessmentConfigured,
} from "./assessment-config";
import { assess as tencentAssess } from "./providers/tencent-soe";
import { assess as aliyunAssess } from "./providers/aliyun-kid";
import { webmToWav16k } from "../voice/audio";

export async function assessAudio(
  audio: Buffer,
  opts: { provider?: AssessmentProviderId; refText?: string } = {}
): Promise<AssessmentResult> {
  const cfg = loadAssessmentConfig();
  if (!cfg.enabled) throw new Error("发音评测未启用，请先在「设置 → 发音评测」中开启");
  const id = opts.provider || cfg.provider;
  const creds = cfg.providers[id];
  if (!creds) throw new Error(`未找到评测服务配置：${id}`);

  // 录音原始格式是 webm/opus，必须先转 16k/单声道/16bit wav
  let wav: Buffer;
  try {
    wav = await webmToWav16k(audio);
  } catch (e) {
    throw new Error(`音频转 16k wav 失败（录音太短或格式异常）：${(e as Error).message}`);
  }

  if (id === "tencent-soe") return tencentAssess(wav, creds, { refText: opts.refText || "" });
  if (id === "aliyun-kid") return aliyunAssess(wav, creds, { refText: opts.refText || "" });
  throw new Error(`未知评测服务：${id}`);
}

export {
  loadAssessmentConfig,
  saveAssessmentConfig,
  getMaskedAssessmentConfig,
  applyAssessmentConfigPatch,
  isAssessmentConfigured,
};
export type { AssessmentProviderId, AssessmentResult } from "./types";
