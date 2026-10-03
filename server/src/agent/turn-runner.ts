/**
 * 轮次聚合器（渠道/开放 API 共用）：把"提交一轮 + 等 turn_end + 聚合过程快照"封装成一个函数。
 *
 * 从 routes/wechat.ts 提出（原微信桥私有实现），现有使用方：
 * - 微信桥（routes/wechat.ts）/ 飞书渠道（channels/feishu.ts）：拿最终文本回渠道，
 *   onProgress 快照驱动渠道侧进度卡片（飞书 ~2.6s 节流更新）；
 * - 开放 API（routes/open-api.ts）：快照写进 NDJSON 响应流，终态写最后一行。
 *
 * 语义：先订阅 stream-hub 再提交（不丢事件）；text/thinking 累积，tool 按 toolCallId 归并；
 * turn_end/error 收口；超时先回调 onTimeout（调用方负责 abort 解除会话 busy）再收口返回部分回复。
 */
import { agentStreamHub } from "./stream-hub.js";

export const DEFAULT_TURN_TIMEOUT_MS = 240_000;

/** 一轮的过程快照（供渠道/开放 API 做"思考中/工具调用/作答中"的实时展示） */
export interface TurnProgress {
  thinking: string;
  tools: Array<{ name: string; done: boolean; error?: boolean }>;
  text: string;
}

export interface TurnResult {
  ok: boolean;
  reply: string;
  /** 全量过程快照（最后一帧）：thinking 全文 + 工具列表（含完成态）。渠道渲染"可折叠思考过程"用 */
  progress: TurnProgress | null;
  error?: string;
  /** 接口超时收口时为 true（部分回复） */
  timedOut?: boolean;
}

/** 提交一轮并聚合最终文本：先订阅再提交，text_delta 累积，turn_end/error 收口。
 *  onProgress 给定时，每个 thinking/text/tool 事件都会带最新快照回调一次（节流由调用方负责）。
 *  onTimeout 给定时，超时先回调它（渠道用 session.abort() 解除会话卡死），再收口返回部分回复。 */
export async function runTurn(
  submit: () => Promise<{ ok: boolean; error?: string }>,
  hubKey: string,
  timeoutMs: number = DEFAULT_TURN_TIMEOUT_MS,
  onProgress?: (p: TurnProgress) => void,
  onTimeout?: () => void | Promise<void>
): Promise<TurnResult> {
  let text = "";
  let thinking = "";
  const tools = new Map<string, { name: string; done: boolean; error?: boolean }>();
  let finished: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let errorMessage: string | null = null;
  let timedOut = false;
  const snapshot = (): TurnProgress => ({
    thinking,
    tools: [...tools.values()].map((t) => ({ ...t })),
    text,
  });
  const unsubscribe = agentStreamHub.subscribe(hubKey, (e) => {
    if (e.type === "text_delta") {
      text += String((e.data as any)?.delta ?? "");
      onProgress?.(snapshot());
    } else if (e.type === "thinking_delta") {
      thinking += String((e.data as any)?.delta ?? "");
      onProgress?.(snapshot());
    } else if (e.type === "tool_start") {
      const callId = String((e.data as any)?.toolCallId ?? "");
      tools.set(callId, { name: String((e.data as any)?.toolName ?? "工具"), done: false });
      onProgress?.(snapshot());
    } else if (e.type === "tool_end") {
      const callId = String((e.data as any)?.toolCallId ?? "");
      const t = tools.get(callId);
      if (t) {
        t.done = true;
        t.error = (e.data as any)?.isError === true;
      }
      onProgress?.(snapshot());
    } else if (e.type === "error") {
      errorMessage = errorMessage ?? String((e.data as any)?.message ?? "agent 出错");
      finished?.();
    } else if (e.type === "turn_end") {
      finished?.();
    }
  });
  const timer = setTimeout(() => {
    timedOut = true;
    errorMessage = errorMessage ?? `等待超时（${Math.round(timeoutMs / 1000)}s）`;
    void (async () => {
      try {
        await onTimeout?.();
      } catch (err) {
        console.error("[turn-runner] 超时中止会话失败:", (err as Error)?.message || err);
      }
      finished?.();
    })();
  }, timeoutMs);
  try {
    const sub = await submit();
    if (!sub.ok) {
      return { ok: false, reply: "", error: sub.error ?? "提交失败", progress: null };
    }
    await done;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  const progress = snapshot();
  if (errorMessage && !text) return { ok: false, reply: "", error: errorMessage, progress };
  const reply = text.trim() || "（这轮没有文本回复）";
  return { ok: true, reply: errorMessage ? `${reply}\n\n（${errorMessage}）` : reply, progress, timedOut };
}
