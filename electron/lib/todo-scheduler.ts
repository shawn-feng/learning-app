/**
 * ISSUE-025：孩子 Todolist（今日计划）的定时生成 / 统计。
 *
 * - 生成（genTime）：ephemeral agent 融合「家长规定项（来自各主题 rules_json 的 daily/必学，
 *   标 [家长] 不可改）」+「孩子自规划项（当天对话中 agent 已写 / 孩子要求）」+「昨日未完成项」，
 *   生成当天 todolist markdown，经 todo_list 工具整体写回服务端（child_todos 表）。
 * - 统计（statTime）：ephemeral agent 依据当天会话 + 学习进度把 `- [ ]` 打勾为 `- [x]` 写回；
 *   主进程随后**确定性解析** markdown（数 checkbox），计算完成率/家长项 vs 自规划项拆分/
 *   连续达标天数，落库 child_todo_stats（供孩子端「我的执行力」趋势）。
 *
 * 数据真源在服务端（server/src/routes/db.ts 的 kb.todo.* handler，child_kb 独立文件，自动进备份）。
 * [家长] 项不可删改文字、只能打勾——由 agent 提示词约定执行（服务端不解析内容）。
 */
import path from "path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getSharedRuntime, getDefaultModel } from "./pi-runtime";
import { getChildDir } from "./config";
import { dbQuery, dbExec } from "./client-data";
import { formatLocalDate, readDailyConversation } from "./daily-summary";
import { todoListTool, kbQueryTool, getDateTool, countTodoTasks } from "./custom-tools";
import { logRound } from "./token-stats";

/** 「达标」完成率阈值：连续达标天数按此口径累计（全部完成算 100%，80% 以上算达标）。 */
export const DONE_RATE_OK = 0.8;

/** todolist 定时任务的极简 system prompt（无 AGENTS、无技能，只做 todolist 一件事）。 */
const TODO_SYSTEM_PROMPT = `你是一个认真细致的「今日计划」整理助手。你只负责孩子的 Todolist（今日计划）markdown 的生成与完成度核对，不做其他事。`;

interface TodoStatsRow {
  date: string;
  total: number;
  done: number;
  parent_total: number;
  parent_done: number;
  self_total: number;
  self_done: number;
  rate: number;
  streak: number;
}

/** 打开 todolist 专用 ephemeral session（todo_list + kb_query + get_date 三工具）。 */
async function createTodoSession(childDir: string) {
  const runtime = await getSharedRuntime();
  const model = await getDefaultModel();

  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    noContextFiles: true,
    noSkills: true,
    systemPromptOverride: () => TODO_SYSTEM_PROMPT,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    // customTools 的 name 必须同时出现在 tools 白名单（agent-session.js isAllowedTool 过滤）
    tools: ["todo_list", "kb_query", "get_date"],
    customTools: [todoListTool, kbQueryTool, getDateTool],
  });
  return session;
}

/** 日期前一天（YYYY-MM-DD）。 */
function prevDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const prev = new Date(y, m - 1, d - 1);
  return formatLocalDate(prev);
}

interface TopicRule {
  name: string;
  topicKey: string;
  daily: string;
  type: string;
}

/** 取孩子各主题的 rules_json（家长规定项数据源）。 */
async function loadTopicRules(childId: string): Promise<TopicRule[]> {
  const rows = await dbQuery<
    Array<{ name: string; topic_key: string; rules_json: string }>
  >("kb.topics.list", { child_id: childId }).catch(() => []);
  return (rows ?? []).map((r) => {
    let rules: Record<string, string> = {};
    try {
      rules = JSON.parse(r.rules_json || "{}") as Record<string, string>;
    } catch {
      rules = {};
    }
    return {
      name: r.name,
      topicKey: r.topic_key,
      daily: String(rules.daily ?? ""),
      type: String(rules.type ?? ""),
    };
  });
}

/** 家长规定项 → markdown 行（设了 daily →「今天学 X 课」；type=必学未设 daily →「必学」；都没设 → 跳过）。 */
function buildParentLines(rules: TopicRule[]): string[] {
  const lines: string[] = [];
  for (const r of rules) {
    if (r.daily && r.daily.trim()) {
      lines.push(`- [ ] [家长] ${r.name}（${r.topicKey}）：今天学 ${r.daily.trim()} 课`);
    } else if (r.type === "必学") {
      lines.push(`- [ ] [家长] 必学：${r.name}（${r.topicKey}）`);
    }
    // 完全没设规则的主题不进 todolist
  }
  return lines;
}

/** 从 markdown 提取非 [家长] 的任务行原文（孩子自规划项，生成时保留）。 */
function extractSelfTasks(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/.exec(line);
    if (!m) continue;
    if (/\[家长\]/.test(m[2])) continue;
    const content = m[2].trim();
    if (content) out.push(`- [ ] ${content}`);
  }
  return out;
}

/** 从 markdown 提取未完成项原文（昨日顺延用；[家长] 项也在内，agent 决定是否并入今天）。 */
function extractUnfinished(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const m = /^\s*[-*]\s*\[( )\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const content = m[2].trim();
    if (content) out.push(`- [ ] ${content}`);
  }
  return out;
}

/**
 * 生成点任务：生成（或刷新）当天 todolist。
 * 上下文 = 家长项基线（服务端拼好，[家长] 不可改）+ 今天已有的自规划项 + 昨日未完成项，
 * 由 agent 一次性 todo_list.update 写回（覆盖式；prompt 要求保留全部 [家长] 项）。
 */
export async function runTodoGen(childId: string): Promise<void> {
  const childDir = getChildDir(childId);
  const today = formatLocalDate(new Date());
  const [topicRules, todayTodo, yesterdayTodo] = await Promise.all([
    loadTopicRules(childId),
    dbQuery<{ itemsMd: string } | null>("kb.todo.get", { child_id: childId, date: today }).catch(() => null),
    dbQuery<{ itemsMd: string } | null>("kb.todo.get", {
      child_id: childId,
      date: prevDate(today),
    }).catch(() => null),
  ]);

  const parentLines = buildParentLines(topicRules);
  const selfTasks = extractSelfTasks(todayTodo?.itemsMd ?? "");
  const yesterdayUnfinished = extractUnfinished(yesterdayTodo?.itemsMd ?? "");

  const parts: string[] = [];
  parts.push(`今天是 ${today}。请为孩子生成今天的 todolist（今日计划）。`);
  if (parentLines.length > 0) {
    parts.push(
      "【家长规定项（来自学习规则）——必须全部保留，标 [家长]，绝不能删改文字】\n" +
        parentLines.join("\n")
    );
  } else {
    parts.push("【家长规定项】今天没有设置学习规则的主题（家长项为空）。");
  }
  if (selfTasks.length > 0) {
    parts.push("【今天已记录的自规划项（孩子之前要求的，必须保留）】\n" + selfTasks.join("\n"));
  }
  if (yesterdayUnfinished.length > 0) {
    parts.push(
      "【昨日未完成项（酌情并入今天，可调整表述）】\n" + yesterdayUnfinished.join("\n")
    );
  }
  parts.push(
    "请用 todo_list 工具：先 action=read（date 省略即今天）确认当前内容，再 action=update 整体写入。\n" +
      "格式要求：markdown checkbox（`- [ ]` 未完成 / `- [x]` 已完成）；家长规定项保留 `[家长]` 标记并排在前面；" +
      "孩子自规划项排在后面；可在自规划区补充 1~3 条对孩子今天合理的事（如读书、运动、家务），但不要编造离谱任务。"
  );

  const session = await createTodoSession(childDir);
  try {
    const beforeCount = (session as any).messages?.length ?? 0;
    await session.prompt(parts.join("\n\n"));
    logRound({ session, beforeCount, channel: "todo-gen", childId, ok: true });
  } finally {
    session.dispose();
  }
}

/**
 * 统计点任务：核对当天 todolist 完成度。
 * 1) agent 依据当天会话 + 学习进度把完成项 `[ ]`→`[x]` 写回（[家长] 项只许打勾）；
 * 2) 主进程随后重新读取 markdown，确定性解析统计并落库 child_todo_stats。
 */
export async function runTodoStat(childId: string): Promise<void> {
  const childDir = getChildDir(childId);
  const today = formatLocalDate(new Date());

  const todayTodo = await dbQuery<{ itemsMd: string } | null>("kb.todo.get", {
    child_id: childId,
    date: today,
  }).catch(() => null);
  if (!todayTodo?.itemsMd?.trim()) {
    // 当天还没有 todolist（未生成）→ 没有可统计内容，跳过
    console.log(`Todo stat skipped for ${childId}: ${today} 无 todolist`);
    return;
  }

  const conversation = readDailyConversation(childDir, today);
  const summaries = await dbQuery<
    Array<{ topic: string; learned: number; total: number; next: string; updated: string }>
  >("kb.progress.list", { child_id: childId }).catch(() => []);

  const session = await createTodoSession(childDir);
  try {
    const beforeCount = (session as any).messages?.length ?? 0;
    const prompt = [
      `今天是 ${today}。以下是孩子今天的 todolist 与学习情况，请核对完成度并更新。`,
      "【今天的 todolist】",
      todayTodo.itemsMd,
      "",
      conversation.trim()
        ? `【今天孩子的对话记录（判断依据之一）】\n${conversation}`
        : "【今天孩子的对话记录】今天没有对话记录。",
      "",
      summaries.length
        ? `【各主题学习进度摘要（判断「[家长] 每天学 X 课」类完成情况）】\n${summaries
            .map((p) => `- ${p.topic}：已学 ${p.learned}/${p.total}${p.next ? `，下一课「${p.next}」` : ""}`)
            .join("\n")}`
        : "",
      "",
      "请用 todo_list 工具处理：先 action=read 确认，再 action=update 写回。规则：",
      "1. 已完成的任务把 `- [ ]` 改为 `- [x]`（依据：学习类对照进度/对话是否学了；生活类对照对话是否提及）；",
      "2. `[家长]` 项只能打勾完成，绝不能删除或修改文字；",
      "3. 未完成的保持 `- [ ]`，不要为了好看而全打勾——完成度必须真实。",
    ].join("\n");
    await session.prompt(prompt);
    logRound({ session, beforeCount, channel: "todo-stat", childId, ok: true });
  } finally {
    session.dispose();
  }

  // agent 写回后，主进程确定性解析落库（不依赖 LLM 结构化输出，数 checkbox 即可）
  await saveTodoStats(childId, today);
}

/** 读取当天 markdown → 计算统计 → upsert child_todo_stats（含连续达标天数）。 */
export async function saveTodoStats(childId: string, date: string): Promise<TodoStatsRow | null> {
  const todo = await dbQuery<{ itemsMd: string } | null>("kb.todo.get", {
    child_id: childId,
    date,
  }).catch(() => null);
  if (!todo?.itemsMd?.trim()) return null;

  const c = countTodoTasks(todo.itemsMd);
  const rate = c.total > 0 ? c.done / c.total : 0;

  // 连续达标天数：昨天达标则 +1，否则从 1 起；今天不达标则归 0
  let streak = 0;
  const yesterday = prevDate(date);
  const prevRows = await dbQuery<TodoStatsRow[]>("kb.todo.stats.list", {
    child_id: childId,
    range: 31,
  }).catch(() => []);
  const prev = (prevRows ?? []).find((r) => r.date === yesterday);
  if (rate >= DONE_RATE_OK) {
    streak = prev && prev.rate >= DONE_RATE_OK ? (prev.streak || 0) + 1 : 1;
  }

  const row: TodoStatsRow = {
    date,
    total: c.total,
    done: c.done,
    parent_total: c.parentTotal,
    parent_done: c.parentDone,
    self_total: c.selfTotal,
    self_done: c.selfDone,
    rate: Number(rate.toFixed(3)),
    streak,
  };
  await dbExec("kb.todo.stats.upsert", {
    child_id: childId,
    ...row,
  });
  return row;
}
