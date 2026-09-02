// 每日学习记录总结核心（recording 定时任务 / 新建会话前触发 / AI 工具 summarize_conversation 共用）。
// 按天汇总：读取指定日期 jsonl 会话（滤掉 thinking / toolCall / toolResult，只留对话文本）→
// 有会话则开 ephemeral session，首轮注入「已提供上下文」（主题进度+标签定义表+已有条目）+ 当天对话，
// 按 RECORDING_PROMPT 的「一次性完成」要求提取写入 daily；当天无会话则跳过（不消耗 token）。

import fs from "fs";
import path from "path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getSharedRuntime, getDefaultModel } from "./pi-runtime";
import { kbInsertTool, kbQueryTool, kbUpdateTool, todoListTool } from "./custom-tools";
import { tagsToMarkdown, type DailyEntry, type TagDef } from "./kb-sqlite";
import { dbQuery } from "./client-data";
import { RECORDING_PROMPT, RECORDING_SYSTEM_PROMPT } from "./recording-prompt";
import { logRound } from "./token-stats";

/** 本地时区 YYYY-MM-DD（不用 toISOString：那是 UTC 日期，东八区晚上会跨到错误的「今天」）。 */
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayRange(date: string): { start: number; end: number } {
  const [y, m, d] = date.split("-").map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return { start, end: start + 24 * 3600 * 1000 };
}

/**
 * 读取指定日期（本地时区）的对话文本：遍历 sessions 目录所有 jsonl（含归档），
 * 只取 type=message 且 role 为 user / assistant 的条目，content 数组里只保留 type=text 的部分
 * （排除 thinking / toolCall，role=toolResult 的条目整体跳过），按时间升序拼成对话记录。
 * 当天没有会话时返回空串。
 */
export function readDailyConversation(childDir: string, date: string): string {
  const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
  if (!fs.existsSync(sessionsDir)) return "";
  const { start, end } = dayRange(date);
  const msgs: { ts: number; role: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name.endsWith(".jsonl")) {
        for (const line of fs.readFileSync(full, "utf-8").split("\n").filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            if (entry.type !== "message" || !entry.message) continue;
            const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
            if (!Number.isFinite(ts) || ts < start || ts >= end) continue;
            const role = entry.message.role;
            if (role !== "user" && role !== "assistant") continue;
            const content = entry.message.content;
            const parts = Array.isArray(content) ? content : [];
            const texts = parts
              .filter((p: any) => p?.type === "text" && typeof p.text === "string")
              .map((p: any) => p.text.trim())
              .filter(Boolean);
            if (texts.length === 0) continue;
            msgs.push({ ts, role, text: texts.join("\n") });
          } catch {
            // 单行损坏跳过，不影响其余行
          }
        }
      }
    }
  };
  walk(sessionsDir);
  msgs.sort((a, b) => a.ts - b.ts);
  return msgs.map((m) => `${m.role === "user" ? "孩子" : "饺子"}: ${m.text}`).join("\n\n");
}

/** 遍历所有 jsonl，返回「有对话消息（user/assistant 文本）」的本地日期集合。 */
function collectConversationDates(childDir: string): Set<string> {
  const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
  const dates = new Set<string>();
  if (!fs.existsSync(sessionsDir)) return dates;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name.endsWith(".jsonl")) {
        for (const line of fs.readFileSync(full, "utf-8").split("\n").filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            if (entry.type !== "message" || !entry.message) continue;
            const role = entry.message.role;
            if (role !== "user" && role !== "assistant") continue;
            const content = entry.message.content;
            const parts = Array.isArray(content) ? content : [];
            const hasText = parts.some(
              (p: any) => p?.type === "text" && typeof p.text === "string" && p.text.trim()
            );
            if (!hasText) continue;
            const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
            if (!Number.isFinite(ts)) continue;
            const d = new Date(ts);
            dates.add(formatLocalDate(d));
          } catch {
            // 忽略损坏行
          }
        }
      }
    }
  };
  walk(sessionsDir);
  return dates;
}

/**
 * 找到 < beforeDate 之前「最后有会话」的日期（YYYY-MM-DD）；没有任何会话日期时返回 null。
 * 会话前触发用：新建会话前总结「之前的会话」——取今天之前最近有对话的一天。
 */
export function findLastConversationDate(childDir: string, beforeDate: string): string | null {
  const dates = collectConversationDates(childDir);
  let last: string | null = null;
  for (const d of dates) {
    if (d < beforeDate && (last === null || d > last)) last = d;
  }
  return last;
}

/** 最近有会话的日期（所有会话日期中的最大值）；没有则返回 null。AI 工具缺省 date 用。 */
export function findLatestConversationDate(childDir: string): string | null {
  const dates = collectConversationDates(childDir);
  let max: string | null = null;
  for (const d of dates) {
    if (max === null || d > max) max = d;
  }
  return max;
}

/**
 * 极简 ephemeral session（记录总结专用）：不加载 AGENTS.md（noContextFiles）、不加载任何技能
 * （noSkills），system prompt 用极简记录助手身份；工具只挂 kb 三件套（写 daily / 更新进度 / 查标签定义）。
 */
export async function createEphemeralSession(childDir: string) {
  const runtime = await getSharedRuntime();
  const model = await getDefaultModel();

  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    noContextFiles: true,
    noSkills: true,
    systemPromptOverride: () => RECORDING_SYSTEM_PROMPT,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    // customTools 的 name 必须同时出现在 tools 白名单（agent-session.js 的 isAllowedTool 会过滤），
    // kb 三件套缺一不可（ISSUE-006 教训）；todo_list 用于汇总时一并核对孩子自定任务完成情况。
    tools: ["kb_query", "kb_insert", "kb_update", "todo_list"],
    customTools: [kbQueryTool, kbInsertTool, kbUpdateTool, todoListTool],
  });
  return session;
}

/**
 * 把当天已有的 daily 条目整理成给 AI 的「已存在清单」文本（按区块分组，raw 截断省 token）。
 * 同一天可能多次汇总：清单用于让 AI 跳过已写入的条目、只补新增/更新。
 */
export function formatDailyExistingList(entries: DailyEntry[], maxRawLen = 120): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  const blocks = ["学习", "生活", "问答", "任务"] as const;
  for (const block of blocks) {
    const inBlock = entries.filter((e) => e.block === block);
    if (inBlock.length === 0) continue;
    lines.push(`【${block}】`);
    for (const e of inBlock) {
      const snippet = e.raw.replace(/\s+/g, " ").trim();
      lines.push(`- ${e.title}${snippet ? `：${snippet.slice(0, maxRawLen)}` : ""}`);
    }
  }
  return lines.join("\n");
}

export interface DailySummaryResult {
  /** 汇总的日期 YYYY-MM-DD */
  date: string;
  /** 是否实际执行了总结并写入 daily */
  summarized: boolean;
  /** 当天无会话被跳过 */
  skipped: boolean;
  /** 供日志 / AI 工具返回的文字说明 */
  note: string;
}

/**
 * 组装「已提供上下文」：主题清单+进度摘要 + 标签定义表 + 当天已有 daily 条目清单（去重用）。
 *
 * 目的（2026-08-27 首轮注入）：把 LLM 原本要分轮 kb_query 才能拿到的信息（主题映射、标签定义表、
 * 已有条目）一次性塞进首轮 prompt，让 LLM 在第一个回复里就完成全部提取与写入，工具调用一轮收尾，
 * 避免「先查再写、逐条插入」导致的十几轮往返（每轮都重发全文 + thinking）。
 *
 * 只注入主题级聚合行（queryTopicSummary），绝不注入逐课清单——论语 514 课全量塞进上下文是灾难。
 */
export async function buildProvidedContext(childDir: string, existingList: string): Promise<string> {
  const childId = path.basename(childDir);
  const [topics, summaries, tags] = await Promise.all([
    dbQuery<Array<{ name: string; topic_key: string; rules_json: string }>>("kb.topics.list", { child_id: childId }).catch(() => []),
    dbQuery<Array<{ topic: string; learned: number; total: number; next: string; updated: string }>>("kb.progress.list", { child_id: childId }).catch(() => []),
    dbQuery<TagDef[]>("kb.tags.list", { child_id: childId }).catch(() => []),
  ]);
  const topicLines = (summaries ?? []).map((p) => {
    const meta = (topics ?? []).find((t) => t.topic_key === p.topic);
    const name = meta?.name ?? p.topic;
    let line = `- ${name}（${p.topic}）：已学 ${p.learned}/${p.total}`;
    if (p.next.trim()) line += `，下一课「${p.next.trim()}」`;
    if (p.updated) line += `，最近更新 ${p.updated}`;
    return line;
  });
  const tagsText = tagsToMarkdown(tags ?? []);
  const parts = [
    "## 已提供的上下文（直接使用，无需调用工具查询）",
    "",
    "【主题清单与进度摘要】",
    topicLines.length ? topicLines.join("\n") : "（暂无学习主题）",
    "",
    "【标签定义表】",
    tagsText,
  ];
  if (existingList) {
    parts.push(
      "",
      "【当天 daily 已存在的记录（禁止重复插入）】",
      existingList,
      "规则：",
      "1. 清单中已存在的条目（标题一致或内容重复）禁止重复插入；",
      "2. 若清单中某条目有新信息需要补充，用 kb_update 更新它（不要新增条目）；",
      "3. 只对清单中没有的新条目调用 kb_insert。"
    );
  }
  return parts.join("\n");
}

/**
 * 按天汇总：读取指定日期会话 → 有会话则开 ephemeral session 提取写入 daily，无会话则跳过。
 *
 * @param childDir 孩子数据目录（data/children/<id>，也是工具 ctx.cwd）
 * @param date 目标日期 YYYY-MM-DD（本地时区）
 */
export async function summarizeDailyConversation(
  childDir: string,
  date: string
): Promise<DailySummaryResult> {
  const conversation = readDailyConversation(childDir, date);
  if (!conversation.trim()) {
    return { date, summarized: false, skipped: true, note: `${date} 没有会话，跳过本次总结` };
  }
  // 同一天可能被多次汇总（多时间点 / 会话前 / AI 工具）：
  // 先把当天已有的 daily 条目查出来，让 AI 跳过已写入的内容，避免重复入库（主键幂等仅兜底）。
  const childId = path.basename(childDir);
  const existing = await dbQuery<DailyEntry[]>("kb.daily_entries.queryByDate", {
    child_id: childId,
    date,
  }).catch(() => []);
  const existingList = formatDailyExistingList(existing ?? []);
  // 首轮注入全部上下文（主题进度 + 标签定义表 + 已有条目），配合 RECORDING_PROMPT 的「一次性完成」
  // 要求，让 LLM 首轮就返回全部 kb_insert/kb_update 调用，不再为「了解信息」分轮调用 kb_query。
  const provided = await buildProvidedContext(childDir, existingList);
  const session = await createEphemeralSession(childDir);
  try {
    const beforeCount = (session as any).messages?.length ?? 0;
    const prompt = `${RECORDING_PROMPT}\n\n${provided}\n\n今天是 ${date}。以下是孩子 ${date} 的对话记录，请按要求提取信息并写入 daily：\n\n${conversation}`;
    await session.prompt(prompt);
    logRound({ session, beforeCount, channel: "scheduler", childId: path.basename(childDir), ok: true });
    return { date, summarized: true, skipped: false, note: `已总结 ${date} 的对话并写入 daily` };
  } finally {
    session.dispose();
  }
}

/**
 * AI 工具：按天汇总孩子的对话并写入 daily（学习/生活/问答/任务四类）。
 * 当用户（孩子或家长）希望回顾、总结某天的学习内容或生活事件时，agent 自动调用本工具；
 * date 缺省时自动选择最近有会话的一天；当天没有会话则返回跳过说明，不报错。
 * 注意：本工具名 "summarize_conversation" 必须同时出现在 createAgentSession({ tools }) 白名单里
 * （ISSUE-006：customTools 缺白名单会被 isAllowedTool 过滤掉，工具不注册不激活）。
 */
export const summarizeConversationTool = defineTool({
  name: "summarize_conversation",
  label: "汇总某天的对话记录",
  description:
    "按天汇总孩子某天的对话并写入 daily（学习总结/生活事件/问答/任务）。当用户希望回顾或总结某天的学习内容、生活事件时调用；date 缺省自动选最近有会话的一天；当天无会话则返回跳过说明。",
  parameters: Type.Object({
    date: Type.Optional(
      Type.String({ description: "目标日期 YYYY-MM-DD（本地时区）；缺省 = 最近有会话的一天" })
    ),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const childDir = ctx.cwd;
    const today = formatLocalDate(new Date());
    const date = params.date ?? findLatestConversationDate(childDir) ?? today;
    const result = await summarizeDailyConversation(childDir, date);
    return { content: [{ type: "text" as const, text: result.note }] };
  },
});
