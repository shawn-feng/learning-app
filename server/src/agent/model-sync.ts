/**
 * 会话模型同步 + 模型错误友好化（ISSUE-126）：
 *
 * 背景（2026-09-21 201 现场）：qwen-tokenplan 周额度用尽（429）后客户端永远「等待模型返回」——
 *  1) ensureEntry 内存命中即返回，pickWorkerModel 只在会话首次创建时解析一次，
 *     用户改 defaultModel 对已存在的会话永不生效（孩子/家长 registry 同病）；
 *  2) SDK 对模型 API 失败不 emit error 事件、不 throw，只记 stopReason:"error" +
 *     errorMessage 的空 assistant 消息，attachStream 不识别就静默结束轮次。
 *
 * 两个共用件（孩子/家长 registry 各自接入）：
 *  - syncSessionModel：每轮提交前对比「设置里的默认模型」与「会话当前绑定模型」，
 *    不一致则 SDK session.setModel() 原地热切换（历史/上下文/工具全保留，不销毁重建；
 *    setModel 自带新 provider 的 key 校验，没配 key 直接抛错）。
 *  - friendlyModelError：把 SDK 记在 assistant 消息上的原始错误（429 额度 JSON 等）
 *    翻译成用户能看懂的一句话（attachStream 转 error 事件时用）。
 */
import type { DatabaseSync } from "node:sqlite";
import { getWorkerRuntime, pickWorkerModel } from "@pi/agent-core";
import { readParentSettings } from "../worker/scheduler.js";

export interface ModelSyncDeps {
  db: DatabaseSync;
  dataDir: string;
}

/** 这里用到的 SDK AgentSession 最小面（get model() / setModel()）。 */
interface SessionLike {
  model?: { provider?: string; id?: string } | undefined;
  setModel: (model: unknown) => Promise<void>;
}

export interface ModelSyncResult {
  ok: boolean;
  /** 切换失败时给前端的一句话（本轮不发送） */
  error?: string;
}

/**
 * 每轮提交前调用：默认模型变了就原地热切换，会话上下文不丢。
 * 失败不静默——返回 ok:false + 可读原因，由调用方决定本轮如何收场（不发送、回 5xx）。
 */
export async function syncSessionModel(
  deps: ModelSyncDeps,
  parentId: string,
  session: SessionLike,
  logTag: string
): Promise<ModelSyncResult> {
  try {
    const settings = readParentSettings(deps.db, deps.dataDir, parentId);
    const runtime = await getWorkerRuntime(deps.dataDir, parentId, settings.auth);
    const model = pickWorkerModel(runtime, settings.appSettings) as
      | { provider: string; id: string }
      | undefined;
    const cur = session.model;
    if (!model || !cur || !cur.provider || !cur.id) return { ok: true };
    if (model.provider === cur.provider && model.id === cur.id) return { ok: true };
    console.log(
      `[${logTag}] 默认模型变更 ${cur.provider}/${cur.id} → ${model.provider}/${model.id}，原地热切换（会话历史保留）`
    );
    await session.setModel(model);
    return { ok: true };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.warn(`[${logTag}] 默认模型热切换失败:`, message);
    return {
      ok: false,
      error: `默认模型切换失败：${message}。本轮消息未发送，请先在设置里为新模型厂商配置 API Key，或换回可用模型。`,
    };
  }
}

/**
 * SDK 记在 assistant 消息上的原始模型错误 → 用户能看懂的一句话。
 * 常见形态：「429: {"message":"Your token-plan 1-week quota has been exhausted...
 * reset at 09-27 04:32:00 UTC...","code":"insufficient_quota"}」、401 key 无效等。
 */
export function friendlyModelError(raw: string): string {
  const s = String(raw ?? "");
  const resetDay = s.match(/reset at (\d{2}-\d{2})/i);
  if (/insufficient_quota|quota has been exhausted/i.test(s)) {
    return `模型套餐额度已用完${resetDay ? `，${resetDay[1]} 重置` : ""}。请在设置里切换模型，或等待额度重置。`;
  }
  if (/401|invalid[_ ]api[_ ]key|unauthorized/i.test(s)) {
    return "模型 API Key 无效或已过期，请在设置里检查该厂商的 Key。";
  }
  if (/\b429\b|rate.?limit/i.test(s)) {
    return "模型服务限流，请稍后重试。";
  }
  return `模型调用失败：${s}`;
}
