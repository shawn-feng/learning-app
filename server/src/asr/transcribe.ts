/**
 * ASR 聚合转录（ISSUE-165 提取共享）：按家长配置的候选链依次转录，语义与 routes/asr.ts 逐字一致。
 * 使用方：routes/asr.ts（家长 JWT 转录端点）+ routes/open-api.ts（开放 API 语音消息，API Key）。
 *
 * 渠道门控（2026-10-10 用户拍板）：开启 AI 模型（builtin）→ 语音仅走 TokenHub（wand-asr-v1，同池计费）；
 * 切自定义模型（custom）→ 仅走自配通道（千问/MiMo，Key 留空复用自定义模型同厂商 Key）；
 * off → 语音不可用。「没有识别到语音」属语义错误，短路不回退。
 */
import type { DatabaseSync } from "node:sqlite";
import {
  getTranscribeCandidates,
  getAuthEnvelopeKey,
  readAsrConfig,
  readVoiceChannel,
  type AsrProviderId,
} from "./config.js";
import { transcribeQwen, transcribeMimo } from "./providers.js";
import { transcribeTokenhub } from "./providers.js";
import { getSystemDefaultModels } from "../auth/tokenhub.js";
import { recordAsrTokenUsage } from "../db/token-usage.js";

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

  // 渠道门控（用户 2026-10-10 拍板）：开启 AI 模型 → 语音走 TokenHub；切自定义模型 → 走自配通道。
  const channel = readVoiceChannel(db, parentId);
  if (channel === "off") {
    throw new TranscribeError(400, "AI 模型已停用，语音输入不可用");
  }

  let candidates = getTranscribeCandidates(db, secret, parentId, cfg, channel);
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
        : channel === "custom"
          ? "自定义模型中未配置可用的语音通道：请在语音配置录入千问/MiMo Key，或先在「自定义模型」配置同厂商 Key"
          : "内置语音模型不可用：TokenHub Key 尚未就绪，请稍后重试或联系管理员"
    );
  }

  // 候选链由 getTranscribeCandidates 按渠道生成（builtin=仅 TokenHub；custom=仅自配通道）。
  const errors: string[] = [];
  // 管理端系统默认 ASR 模型（ISSUE-174 四下拉）：仅当与通道前缀匹配时作为模型覆盖，
  // 不匹配（如选了 TokenHub 预留项）则用通道内置模型（TokenHub 通道默认 hy-asr-3.0-preview）。
  const sysAsrModel = getSystemDefaultModels().asr;
  for (const { id, creds } of candidates) {
    // 兜底 key：auth 封套（按 endpoint 是否含 token-plan 选段，对齐旧本机 auth.json 语义）
    const family = id.startsWith("mimo") ? "mimo" : "qwen";
    const isTokenPlan = (creds.endpoint || "").includes("token-plan");
    const fallbackKey = getAuthEnvelopeKey(db, secret, parentId, family, isTokenPlan);
    const modelOverride = sysAsrModel.startsWith(family) ? sysAsrModel : "";
    try {
      const r =
        id === "tokenhub"
          ? await transcribeTokenhub(wav, creds, "")
          : id === "qwen" || id === "qwen-tokenplan"
            ? await transcribeQwen(wav, creds, fallbackKey, modelOverride || undefined)
            : await transcribeMimo(wav, creds, fallbackKey, modelOverride || undefined);
      // TokenHub 通道成功 → 补记 ASR 用量行（同池扣配额但无 agent 会话，扫描器扫不到）
      if (id === "tokenhub") {
        try {
          recordAsrTokenUsage(db, parentId, creds.model || "hy-asr-3.0-preview", r.usage);
        } catch {
          /* 统计落库失败不影响转录结果 */
        }
      }
      return { text: r.text, provider: id };
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
  const hint =
    channel === "builtin"
      ? "\n（内置语音走 TokenHub hy-asr-3.0-preview：请确认控制台已为该服务开通后付费）"
      : "";
  throw new TranscribeError(502, `所有语音服务均识别失败：\n${errors.join("\n")}${hint}`);
}
