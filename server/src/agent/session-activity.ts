/**
 * 会话活跃度登记处（ISSUE-146 P0）。
 *
 * ## 为什么需要它
 * 挂死看门狗（2026-09-18）的判据原本是「会话 240s 没有 emit 任何 SDK 事件 ⇒ 模型挂起 ⇒ abort」。
 * 这个判据对**长时工具**是错的：`parent_build_material` / `create_html_lesson` 的 execute 内部
 * `await` 的是一个**完全独立的嵌套会话**（编程 agent，`programming-agent.ts`），它的 text/thinking/tool
 * 事件**不会**进父会话——父层在整个工具执行期间只有 `tool_start` 一个事件，之后静默到 `tool_end`。
 *
 * 201 生产实测（2026-09-24 只读 journal）：
 * - 网页生成 9 次，`median=321.4s / max=654.2s`，**6 次 > 240s**；
 * - `判定挂死` 8 次，其中 **5 次与 lesson-01~05 严格 1:1 配对**（典型：`12:32:51 挂死` →
 *   `12:32:52 生成完成 lesson-01（242.8s）`，外层被 abort 后 1 秒嵌套会话才跑完）；
 * - 报错文案还写成「模型服务超过 240 秒无响应」，把「系统自己砍的」误归因给模型。
 *
 * ## 判据拆成两个进度源
 * - `lastActivityAt`：任何 SDK 事件都刷新（含长工具经 `onUpdate` 回报的 `tool_execution_update`，
 *   以及子会话经父工具转发的进度）；
 * - `runningTools`：由**父会话**的 `tool_execution_start/end` 维护的计数。`>0` 表示「正在等一个工具」，
 *   此时静默是**正常**的 ⇒ watchdog 跳过「模型静默」判定，改由工具硬上限 `TOOL_EXEC_TIMEOUT_MS` 兜底。
 *
 * 两层叠加后：① 长工具不再被误杀；② 模型**真**挂起（无工具在跑且无事件）仍照旧 240s 兜底，
 * 不会因为「放宽」而丢掉原有的兜底能力（生产那 3 次没有配对的挂死很可能正是这一类）。
 *
 * ⚠️ key 语义：一律用**会话 key**（家长 `${parentId}:parent` / 孩子 `${parentId}:${childId}:${kind}`），
 * 不用流（SSE）key。孩子侧多个会话（main/scene/course）共享同一个 streamKey，而静默必须**按会话**判。
 */
export const SESSION_IDLE_TIMEOUT_MS = 240_000;
/** 工具执行硬上限：单次工具跑过它即视为真卡死（实测最长 654s ≈ 11 分钟，30 分钟留足余量） */
export const TOOL_EXEC_TIMEOUT_MS = 30 * 60_000;

const lastActivity = new Map<string, number>();
/** key → 正在执行中的工具名栈（同一个工具可能并发/重入，用栈而非单个值） */
const runningTools = new Map<string, string[]>();

/** 标记活动（任何事件到达都算「这一轮还活着」）。 */
export function markActivity(key: string, at = Date.now()): void {
  lastActivity.set(key, at);
}

/** 工具开始执行：计数 +1（toolName 用于超时文案，可读）。 */
export function beginToolExecution(key: string, toolName?: string): void {
  const arr = runningTools.get(key) ?? [];
  arr.push(String(toolName ?? ""));
  runningTools.set(key, arr);
  markActivity(key);
}

/** 工具结束执行（含失败/被中止）：计数 −1；多余调用不会产出负计数。 */
export function endToolExecution(key: string, toolName?: string): void {
  const arr = runningTools.get(key);
  if (!arr || arr.length === 0) return;
  const i = toolName ? arr.lastIndexOf(String(toolName)) : arr.length - 1;
  arr.splice(i >= 0 ? i : arr.length - 1, 1);
  if (arr.length === 0) runningTools.delete(key);
  markActivity(key);
}

export function runningToolCount(key: string): number {
  return runningTools.get(key)?.length ?? 0;
}

/** 当前在跑的工具名（超时文案用）。 */
export function runningToolNames(key: string): string[] {
  return [...(runningTools.get(key) ?? [])];
}

/** 最近一次活动时间；无记录返回 undefined（调用方自行回退到「本轮开始时间」）。 */
export function lastActivityAt(key: string): number | undefined {
  return lastActivity.get(key);
}

/** 会话释放（reset/dispose/重建）时清理，防 Map 随会话数常驻。 */
export function clearActivity(key: string): void {
  lastActivity.delete(key);
  runningTools.delete(key);
}

/**
 * 从工具的 `onUpdate` 载荷（`AgentToolResult`）提取**一行**进度文案，供 SSE 的 `tool_progress` 事件用。
 * 约定：优先 `details.progress`（结构化，服务端自己产，最可靠）；否则取 `content` 里第一个 text 块首行。
 * 客户端只把它当"给人看的一句话"，不做解析 —— 所以这里压成单行并截断。
 */
export function toolProgressText(partialResult: unknown, limit = 120): string {
  const r = partialResult as { content?: unknown[]; details?: { progress?: unknown } } | null | undefined;
  const fromDetails = r?.details?.progress;
  let text = typeof fromDetails === "string" ? fromDetails : "";
  if (!text && Array.isArray(r?.content)) {
    for (const c of r.content) {
      const b = c as { type?: string; text?: string };
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        text = b.text.trim();
        break;
      }
    }
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}
