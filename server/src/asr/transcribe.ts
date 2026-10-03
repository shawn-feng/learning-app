/**
 * ASR 聚合转录（ISSUE-165 提取共享）：按家长配置的候选链依次转录，语义与 routes/asr.ts 逐字一致。
 * 使用方：routes/asr.ts（家长 JWT 转录端点）+ routes/open-api.ts（开放 API 语音消息，API Key）。
 *
 * 回退顺序：默认服务优先，其余已配置通道按固定顺序；「没有识别到语音」属语义错误，短路不回退；
 * 兜底 key 由服务端从同家长 auth 封套解析（endpoint 含 token-plan 选 <family>-tokenplan 段）。
 */
import type { DatabaseSync } from "node:sqlite";
import {
  getTranscribeCandidates,
  getAuthEnvelopeKey,
  readAsrConfig,
  type AsrProviderId,
} from "./config.js";
import { transcribeQwen, transcribeMimo } from "./providers.js";

export const PROVIDER_NAMES: Record<string, string> = {
  qwen: "千问(按量)",
  "qwen-tokenplan": "千问(token-plan)",
  mimo: "小米 MiMo(按量)",
  "mimo-tokenplan": "小米 MiMo(token-plan)",
};

/** 带语义状态码的转录失败（调用方直接映射 HTTP 响应） */
export class TranscribeError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "TranscribeError";
  }
}

export interface TranscribeResult {
  text: string;
  provider: AsrProviderId;
}

/**
 * 转录一段 16k wav（多通道回退聚合）。
 * @param opts.onlyProvider 单通道验证（设置页「测试该服务」）：不回退，错误回原始形态
 * @throws TranscribeError 400 未启用/未配置/没有识别到语音；502 全部候选失败
 */
export async function transcribeWithFallback(
  db: DatabaseSync,
  secret: Buffer,
  parentId: string,
  wav: Buffer,
  opts: { onlyProvider?: string } = {}
): Promise<TranscribeResult> {
  const { cfg } = readAsrConfig(db, secret, parentId);
  if (!cfg.enabled) {
    throw new TranscribeError(400, "语音输入未启用，请先在设置中开启");
  }

  let candidates = getTranscribeCandidates(db, secret, parentId, cfg);
  const onlyProvider = String(opts.onlyProvider ?? "").trim();
  if (onlyProvider) {
    const id = onlyProvider as AsrProviderId;
    candidates = cfg.providers[id] ? [{ id, creds: cfg.providers[id] }] : [];
  }
  if (candidates.length === 0) {
    throw new TranscribeError(
      400,
      onlyProvider
        ? "该语音服务尚未配置凭证，请先填写并保存"
        : "未配置可用的语音服务，请先在设置中填写凭证"
    );
  }

  const errors: string[] = [];
  for (const { id, creds } of candidates) {
    // 兜底 key：auth 封套（按 endpoint 是否含 token-plan 选段，对齐旧本机 auth.json 语义）
    const family = id.startsWith("mimo") ? "mimo" : "qwen";
    const isTokenPlan = (creds.endpoint || "").includes("token-plan");
    const fallbackKey = getAuthEnvelopeKey(db, secret, parentId, family, isTokenPlan);
    try {
      const text =
        id === "qwen" || id === "qwen-tokenplan"
          ? await transcribeQwen(wav, creds, fallbackKey)
          : await transcribeMimo(wav, creds, fallbackKey);
      return { text, provider: id };
    } catch (e) {
      const msg = (e as Error).message;
      // 语义错误（如「没有识别到语音」）：不是服务不可用，不应回退，直接上报
      if (/没有识别到语音/.test(msg)) {
        throw new TranscribeError(400, msg);
      }
      errors.push(`${PROVIDER_NAMES[id] || id}: ${msg}`);
    }
  }
  // 设置页「测试该服务」单通道验证：回原始错误（对齐旧客户端语义），不套聚合头
  if (onlyProvider) {
    throw new TranscribeError(502, errors[errors.length - 1] || "识别失败");
  }
  throw new TranscribeError(502, `所有语音服务均识别失败：\n${errors.join("\n")}`);
}
