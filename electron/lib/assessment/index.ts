// 发音评测统一入口：家长端配置评测服务（智聆 / 阿里儿童），
// 收到 16k 单声道 wav 后调对应 provider 评测，返回统一 AssessmentResult。
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

export async function assessAudio(
  wav: Buffer,
  opts: { provider?: AssessmentProviderId; refText?: string } = {}
): Promise<AssessmentResult> {
  const cfg = loadAssessmentConfig();
  if (!cfg.enabled) throw new Error("发音评测未启用，请先在「设置 → 发音评测」中开启");
  const id = opts.provider || cfg.provider;
  const creds = cfg.providers[id];
  if (!creds) throw new Error(`未找到评测服务配置：${id}`);
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
