/**
 * Token 统计（ISSUE-010）
 *
 * 目标：记录每一轮发给 agent 的真实 token 消耗 + 上下文增量结构，便于了解消耗。
 *
 * 数据来源分层（关键设计）：
 *  - 真实用量（input / output / cacheRead / cacheWrite / cost）：
 *    直接读 SDK assistant 消息自带的 `usage` 字段（@earendil-works/pi-ai 的 Usage，
 *    agent-session.js 每条 assistant 消息都会挂 result.usage），累加本轮新增部分即可，
 *    不本地估算、不按字符猜。注意 user / toolResult / system 消息不带 usage，
 *    因此只有「assistant 回复的用量」是真实值。
 *  - 已有 vs 新增（上下文增量结构）：
 *    SDK 不给 user / tool 消息的 token，用本地近似分词估算（中文 ~1.5 字符/token，
 *    其它 ~4 字符/token），仅用于理解上下文结构，不作为计费依据（日志字段标
 *    existingTokens / newTokens，与真实 usage 字段分开）。
 *
 * 落点（按 childId 隔离，append-only）：
 *  - 孩子 / 定时任务（有 childId）：data/children/<childId>/token-log.jsonl
 *  - 家长会话（无 childId）：data/token-log.jsonl
 *  每行一条 JSON，形如：
 *  {"seq":1,"ts":"...","channel":"child","childId":"...","sessionFile":"xxx.jsonl",
 *   "model":"deepseek/deepseek-v4-flash","ok":true,
 *   "input":123,"output":45,"cacheRead":0,"cacheWrite":0,"cost":0.001,"totalTokens":168,
 *   "existingTokens":900,"newTokens":120,"assistantCalls":1,"replyLength":60}
 */
import fs from "fs";
import path from "path";
import { getDataDir, getChildDir } from "./config";

/** 日志文件保留上限：超出后截断保留最近 N 行，避免无限膨胀。 */
export const MAX_TOKEN_LOG_LINES = 5000;

export type TokenChannel = "child" | "parent" | "scheduler";

export interface TokenLogEntry {
  seq: number;
  ts: string;
  channel: TokenChannel;
  childId?: string;
  /** 活跃会话文件名（basename）；临时/内存会话可能为空 */
  sessionFile?: string;
  /** 模型标签 provider/modelId */
  model: string;
  /** 本轮 LLM 是否正常返回（stopReason !== error） */
  ok: boolean;
  /** 真实用量：本轮 prompt 期间新增 assistant 消息的 usage 累加 */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  totalTokens: number;
  /** 估算：发送前（prompt 前）已有消息的 token（含历史 user/assistant/tool） */
  existingTokens: number;
  /** 估算：本轮新增消息的 token（用户输入 + 工具往返 + 回复） */
  newTokens: number;
  /** 本轮实际发生的 LLM 调用次数（工具循环时 >1） */
  assistantCalls: number;
  /** 最终可展示回复的文本长度（字符数，非 token） */
  replyLength?: number;
}

export interface RoundStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  totalTokens: number;
  existingTokens: number;
  newTokens: number;
  assistantCalls: number;
}

// ---------------------------------------------------------------------------
// 本地近似分词（仅用于「已有 vs 新增」拆分，不做计费依据）
// ---------------------------------------------------------------------------

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(CJK_RE) || []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount / 1.5) + Math.ceil(otherCount / 4);
}

/** 提取消息的纯文本（content 可能是 string 或 (TextContent|ThinkingContent|ToolCall|ImageContent)[]） */
function messageText(m: any): string {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((x: any) => x && x.type === "text" && typeof x.text === "string")
      .map((x: any) => x.text)
      .join(" ");
  }
  return "";
}

// ---------------------------------------------------------------------------
// 用量收集
// ---------------------------------------------------------------------------

/**
 * 计算一轮 prompt 的用量统计。
 *
 * @param session     AgentSession（duck-typed：只读 messages / model / sessionManager）
 * @param beforeCount prompt() 调用前 `session.messages.length` 的快照
 *
 * 规则：
 *  - 真实用量只累加 beforeCount **之后**新增的 assistant 消息的 usage（防御 0/undefined）；
 *  - existingTokens = 前 beforeCount 条消息的本地估算和；
 *  - newTokens = beforeCount 之后新增消息的本地估算和。
 */
export function computeRoundStats(session: any, beforeCount: number): RoundStats {
  const messages: any[] = session?.messages || [];
  const stats: RoundStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    totalTokens: 0,
    existingTokens: 0,
    newTokens: 0,
    assistantCalls: 0,
  };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isNew = i >= beforeCount;
    if (isNew && m?.role === "assistant" && m.usage && m.stopReason !== "error") {
      const u = m.usage;
      stats.input += Number(u.input) || 0;
      stats.output += Number(u.output) || 0;
      stats.cacheRead += Number(u.cacheRead) || 0;
      stats.cacheWrite += Number(u.cacheWrite) || 0;
      stats.totalTokens += Number(u.totalTokens) || 0;
      stats.cost += Number(u.cost?.total ?? u.cost ?? 0) || 0;
      stats.assistantCalls++;
    }
    const tokens = estimateTokens(messageText(m));
    if (isNew) stats.newTokens += tokens;
    else stats.existingTokens += tokens;
  }
  return stats;
}

export function modelLabelOf(session: any): string {
  const m = session?.model;
  if (!m) return "unknown";
  return m.provider ? `${m.provider}/${m.id}` : String(m.id || "unknown");
}

function sessionFileOf(session: any): string | undefined {
  try {
    const f = session?.sessionManager?.getSessionFile?.();
    return f ? path.basename(f) : undefined;
  } catch {
    return undefined;
  }
}

/** 取最后一条 assistant 消息的可展示文本（与 ipc-handlers 的提取规则一致） */
function lastAssistantText(session: any): string {
  const messages: any[] = session?.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const text = messageText(m);
    if (text) return text;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 日志读写
// ---------------------------------------------------------------------------

/** 日志文件路径：有 childId 按孩子隔离；无 childId（家长会话）落 data 根。 */
export function getTokenLogPath(childId?: string): string {
  if (childId) return path.join(getChildDir(childId), "token-log.jsonl");
  return path.join(getDataDir(), "token-log.jsonl");
}

/**
 * 一站式：prompt 后调用，收集本轮用量并追加日志。
 * 内部自动计算 seq（文件已有行数 + 1）与 ts，失败静默（统计不应影响主流程）。
 */
export function logRound(opts: {
  session: any;
  beforeCount: number;
  channel: TokenChannel;
  childId?: string;
  ok: boolean;
  replyLength?: number;
}): void {
  try {
    const { session, beforeCount, channel, childId, ok, replyLength } = opts;
    const stats = computeRoundStats(session, beforeCount);
    const entry: TokenLogEntry = {
      seq: 0,
      ts: new Date().toISOString(),
      channel,
      childId,
      sessionFile: sessionFileOf(session),
      model: modelLabelOf(session),
      ok,
      ...stats,
      replyLength:
        replyLength ?? (channel === "child" || channel === "parent" ? lastAssistantText(session).length : undefined),
    };
    appendTokenLog(entry, childId);
  } catch (err) {
    console.error(`[token-stats] logRound failed:`, (err as Error).message);
  }
}

export function appendTokenLog(entry: TokenLogEntry, childId?: string): void {
  const filePath = getTokenLogPath(childId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let seq = 1;
  if (fs.existsSync(filePath)) {
    try {
      const existing = fs.readFileSync(filePath, "utf-8").trim();
      if (existing) seq = existing.split("\n").length + 1;
    } catch {
      /* 读失败按新文件处理 */
    }
  }
  entry.seq = seq;
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
  pruneTokenLog(filePath);
}

/** 超上限时截断保留最近 MAX_TOKEN_LOG_LINES 行（低频触发，文件最大 ~1MB，可接受） */
function pruneTokenLog(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < 200 * MAX_TOKEN_LOG_LINES) return; // 粗略预估：行数没超就不读
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    if (lines.length <= MAX_TOKEN_LOG_LINES + 1) return;
    fs.writeFileSync(filePath, lines.slice(-MAX_TOKEN_LOG_LINES).join("\n"), "utf-8");
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 读取最近 limit 条日志（按行从尾部截取，忽略坏行） */
export function readTokenLog(childId?: string, limit = 100): TokenLogEntry[] {
  const filePath = getTokenLogPath(childId);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  const out: TokenLogEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

export interface TokenSummary {
  rounds: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  totalTokens: number;
  lastTs: string | null;
  /** 按模型分组（真实 input/output/cost） */
  byModel: Record<string, { rounds: number; input: number; output: number; cost: number }>;
}

/** 汇总全部日志（读整个文件累计；文件有 5000 行上限，安全） */
export function getTokenSummary(childId?: string): TokenSummary {
  const summary: TokenSummary = {
    rounds: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalCost: 0,
    totalTokens: 0,
    lastTs: null,
    byModel: {},
  };
  for (const e of readTokenLog(childId, MAX_TOKEN_LOG_LINES)) {
    summary.rounds++;
    summary.totalInput += e.input;
    summary.totalOutput += e.output;
    summary.totalCacheRead += e.cacheRead;
    summary.totalCacheWrite += e.cacheWrite;
    summary.totalCost += e.cost;
    summary.totalTokens += e.totalTokens;
    if (!summary.lastTs || e.ts > summary.lastTs) summary.lastTs = e.ts;
    const key = e.model || "unknown";
    const m = (summary.byModel[key] ||= { rounds: 0, input: 0, output: 0, cost: 0 });
    m.rounds++;
    m.input += e.input;
    m.output += e.output;
    m.cost += e.cost;
  }
  return summary;
}
