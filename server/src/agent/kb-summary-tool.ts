/**
 * summarize_conversation 工具（P1：上下文/记录压缩能力上移服务端）。
 *
 * 与客户端同名工具语义一致：按天汇总孩子对话并写入 daily（学习/生活/问答/任务），
 * 供 agent 在被要求「回顾/总结某天」时调用；date 缺省 = 今天；当天无会话返回跳过说明而非报错。
 *
 * 实现复用 worker 的 recording 流程（runRecordingSummary）——同一套「读当天会话 → 首轮注入上下文 →
 * ephemeral 会话写 kb」的实现，避免客户端/服务端/定时任务三处各写一遍导致行为漂移。
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import { runRecordingSummary } from "../worker/tasks.js";

export interface SummaryToolDeps {
  db: DatabaseSync;
  dataDir: string;
  parentId: string;
  childId: string;
}

function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function createSummarizeConversationTool(deps: SummaryToolDeps) {
  return defineTool({
    name: "summarize_conversation",
    label: "汇总某天的对话记录",
    description:
      "按天汇总孩子某天的对话并写入 daily（学习总结/生活事件/问答/任务）。当用户希望回顾或总结某天的学习内容、生活事件时调用；" +
      "date 缺省 = 今天；当天没有对话记录时返回跳过说明（不报错）。",
    parameters: Type.Object({
      date: Type.Optional(
        Type.String({ description: "目标日期 YYYY-MM-DD（本地时区）；缺省 = 今天" })
      ),
    }),
    execute: async (_toolCallId: string, params: { date?: string }) => {
      const date = params?.date?.trim() || localDate();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { content: [{ type: "text" as const, text: `日期格式不对：${date}（应为 YYYY-MM-DD）` }], details: {} };
      }
      const r = await runRecordingSummary(
        { dataDir: deps.dataDir, mainDb: deps.db, parentId: deps.parentId, childId: deps.childId } as any,
        date
      );
      return { content: [{ type: "text" as const, text: r?.message ?? `已处理 ${date}` }], details: {} };
    },
  });
}
