/**
 * 服务端无头 worker 的任务注册机制（方案B 阶段②/④）。
 * - WorkerTask：type + points(cfg)（应触发的时间点 HH:mm）+ run(ctx)。
 * - registerTask 注册；未来新增「孩子不在场时 agent 自主做事」只需实现 WorkerTask 并注册，
 *   调度器（worker/scheduler.ts）统一驱动，无需改 scheduler。
 * 首批任务：recording（每日对话总结写 daily）+ todo（Todolist 生成/统计）。
 * 数据源全部在服务端：当天对话读 data/sessions 镜像（readServerDailyConversation），
 * kb 读写经 routes/db.ts 导出的 handler（runKbQuery/runKbExec），不再依赖客户端存活。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { runKbQuery, runKbExec } from "../routes/db.js";
import { readServerDailyConversation } from "../db/sessions.js";
import { getWorkerRuntime, pickWorkerModel } from "./runtime.js";
import { createWorkerKbTools, formatLocalDate } from "./kb-tools.js";
import { RECORDING_PROMPT, RECORDING_SYSTEM_PROMPT } from "./recording-prompt.js";

/** 与客户端 scheduler.ts 的 SchedulerChildConfig 对齐（结构兼容，缺省字段调用方已补齐）。 */
export interface WorkerSchedulerChildConfig {
  recording?: { enabled?: boolean; times?: string[]; onNewSession?: boolean };
  autoNewSession?: { enabled?: boolean; hour?: number; minute?: number };
  archiveLimit?: number;
  classTimes?: Array<{ start?: string; end?: string; label?: string }>;
  classAlertMode?: string;
  todo?: { enabled?: boolean; genTime?: string; statTime?: string };
}

export interface WorkerTaskCtx {
  dataDir: string;
  mainDb: DatabaseSync;
  parentId: string;
  childId: string;
  /** 服务端密钥（settings "auth" 解密后；为空对象 = 未配置模型 key） */
  auth: Record<string, unknown>;
  appSettings?: Record<string, unknown>;
  schedulerConfig: WorkerSchedulerChildConfig;
  now: Date;
  /** 本次触发的 HH:mm 时间点（同任务多时间点区分用，如 todo 的 gen/stat） */
  point?: string;
}

export interface WorkerRunResult {
  /** ok=成功；skip=无内容跳过（如当天无对话）；缺省按 ok 记 */
  status?: "ok" | "skip";
  message?: string;
}

export interface WorkerTask {
  type: string;
  /** 返回应触发的时间点（HH:mm）；空数组 = 本任务不参与调度（如仅手动触发） */
  points(cfg: WorkerSchedulerChildConfig): string[];
  /** 补跑策略：latest=只补最近一个已过期点（recording 一天一次汇总）；all=按序补全部已过期点（todo 的 gen+stat） */
  catchUp?: "latest" | "all";
  run(ctx: WorkerTaskCtx): Promise<WorkerRunResult | void>;
}

const registry = new Map<string, WorkerTask>();

export function registerTask(task: WorkerTask): void {
  registry.set(task.type, task);
}

export function listTasks(): WorkerTask[] {
  return [...registry.values()];
}

/** HH:mm（本地时区）。 */
export function hhmm(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** 前一天（YYYY-MM-DD）。 */
function prevDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return formatLocalDate(new Date(y, m - 1, d - 1));
}

// ---------- ephemeral 会话 ----------

/**
 * 服务端无头 ephemeral 会话：与客户端 createEphemeralSession 同构
 * （noContextFiles + noSkills + inMemory + systemPromptOverride），
 * cwd 用家长 kb 目录（已存在），agentDir 用 .worker/agent 隔离目录。
 */
async function createWorkerEphemeralSession(
  ctx: WorkerTaskCtx,
  systemPrompt: string,
  toolNames: string[],
  customTools: any[]
) {
  const runtime = await getWorkerRuntime(ctx.dataDir, ctx.parentId, ctx.auth);
  const model = pickWorkerModel(runtime, ctx.appSettings);
  const cwd = path.join(ctx.dataDir, "kb", ctx.parentId);
  const agentDir = path.join(ctx.dataDir, ".worker", "agent", ctx.parentId, ctx.childId);
  fs.mkdirSync(agentDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noContextFiles: true,
    noSkills: true,
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    tools: toolNames,
    customTools,
  });
  return session;
}

// ---------- recording ----------

const BLOCKS = ["学习", "生活", "问答", "任务"] as const;

function formatDailyExistingListLite(
  entries: Array<{ block: string; title: string; raw: string }>,
  maxRawLen = 120
): string {
  if (!entries.length) return "";
  const lines: string[] = [];
  for (const b of BLOCKS) {
    const inBlock = entries.filter((e) => e.block === b);
    if (!inBlock.length) continue;
    lines.push(`【${b}】`);
    for (const e of inBlock) {
      const snippet = e.raw.replace(/\s+/g, " ").trim();
      lines.push(`- ${e.title}${snippet ? `：${snippet.slice(0, maxRawLen)}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** 首轮注入上下文（镜像客户端 buildProvidedContext：主题进度 + 标签定义 + 已有 daily）。 */
async function buildProvidedContextLite(
  ctx: WorkerTaskCtx,
  existingList: string
): Promise<string> {
  const [topics, summaries, tags] = [
    runKbQuery<Array<{ name: string; topic_key: string; rules_json: string }>>(
      ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.topics.list", { child_id: ctx.childId }
    ),
    runKbQuery<Array<{ topic: string; learned: number; total: number; next: string; updated: string }>>(
      ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.progress.list", { child_id: ctx.childId }
    ),
    runKbQuery<Array<{ tag: string; dimension: string; criteria: string }>>(
      ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.tags.list", { child_id: ctx.childId }
    ),
  ];
  const topicLines = (summaries ?? []).map((p) => {
    const meta = (topics ?? []).find((t) => t.topic_key === p.topic);
    const name = meta?.name ?? p.topic;
    let line = `- ${name}（${p.topic}）：已学 ${p.learned}/${p.total}`;
    if (p.next.trim()) line += `，下一课「${p.next.trim()}」`;
    if (p.updated) line += `，最近更新 ${p.updated}`;
    return line;
  });
  const tagsText = (tags ?? []).map((t) => `- ${t.tag}（${t.dimension}）：${t.criteria}`).join("\n");
  const parts = [
    "## 已提供的上下文（直接使用，无需调用工具查询）",
    "",
    "【主题清单与进度摘要】",
    topicLines.length ? topicLines.join("\n") : "（暂无学习主题）",
    "",
    "【标签定义表】",
    tagsText || "（无标签定义）",
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

const recordingTask: WorkerTask = {
  type: "recording",
  // 一天最多补一次汇总（与客户端 runCatchUp 一致：只补最近一个已过期时间点）
  catchUp: "latest",
  points: (cfg) =>
    cfg.recording?.enabled && Array.isArray(cfg.recording.times)
      ? cfg.recording.times.filter((t) => /^\d{2}:\d{2}$/.test(t))
      : [],
  run: async (ctx): Promise<WorkerRunResult> => {
    const date = formatLocalDate(ctx.now);
    const conversation = readServerDailyConversation(ctx.dataDir, ctx.parentId, ctx.childId, date);
    if (!conversation.trim()) {
      console.log(`[worker:recording] child ${ctx.childId}: ${date} 无会话，跳过`);
      return { status: "skip", message: `${date} 无会话，跳过` };
    }
    const existing = runKbQuery<Array<{ block: string; title: string; raw: string }>>(
      ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.daily_entries.queryByDate", { child_id: ctx.childId, date }
    );
    const existingList = formatDailyExistingListLite(existing ?? []);
    const provided = await buildProvidedContextLite(ctx, existingList);
    const kbTools = createWorkerKbTools(ctx);
    const session = await createWorkerEphemeralSession(
      ctx,
      RECORDING_SYSTEM_PROMPT,
      ["kb_query", "kb_insert", "kb_update"],
      kbTools
    );
    try {
      const prompt = `${RECORDING_PROMPT}\n\n${provided}\n\n今天是 ${date}。以下是孩子 ${date} 的对话记录，请按要求提取信息并写入 daily：\n\n${conversation}`;
      await session.prompt(prompt);
      console.log(`[worker:recording] child ${ctx.childId}: ${date} 已总结`);
      return { status: "ok", message: `已总结 ${date} 的对话并写入 daily` };
    } finally {
      session.dispose();
    }
  },
};

// ---------- todo ----------

/** 主库 study_plan_items 当日排期行（与 routes/study-plans.ts GET /today 同口径：kind='date' + active=1）。 */
interface PlanRowLite {
  origin: string;
  content: string;
}

interface PlanTodayItemLite {
  text: string;
  carry: boolean;
}

function parsePlanContent(raw: string): Array<{ text: string }> {
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as Array<{ text: string }>) : [];
  } catch {
    return [];
  }
}

/**
 * 读学习计划当日聚合（ISSUE-033，替代旧 rules_json.daily）。
 * 服务端 worker 直接查主库 study_plan_items（SQL 与客户端读 GET /study-plans/today 同口径），
 * 只把行内 content 展平为 items——carry 顺延行由 study-plan-carry.ts 每日写入，这里不做任何排期展开。
 */
function loadTodayPlanItemsServer(ctx: WorkerTaskCtx, today: string): PlanTodayItemLite[] {
  const rows = ctx.mainDb
    .prepare(
      "SELECT origin, content FROM study_plan_items WHERE parent_id = ? AND child_id = ? AND active = 1 AND kind = 'date' AND date = ? ORDER BY created_at ASC"
    )
    .all(ctx.parentId, ctx.childId, today) as unknown as PlanRowLite[];
  const items: PlanTodayItemLite[] = [];
  for (const r of rows) {
    for (const it of parsePlanContent(r.content)) {
      if (!it.text) continue;
      items.push({ text: it.text, carry: r.origin === "carry" });
    }
  }
  return items;
}

/** 当日计划 items → [家长] markdown 行（同文本去重；carry = 昨天没学完顺延来的，标注原因）。 */
function planItemsToParentLines(items: PlanTodayItemLite[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const text = (it.text || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(it.carry ? `- [ ] [家长] ${text}（昨天没学完，今天补上）` : `- [ ] [家长] ${text}`);
  }
  return lines;
}

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

/**
 * 从 markdown 提取昨日未完成项（供「酌情并入今天」）。
 * 只取孩子自规划项：`[家长]` 项未完成由学习计划 carry（服务端每日顺延）确定性处理，
 * 若这里再并入会造成同文本重复出现两条。
 */
function extractUnfinished(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const m = /^\s*[-*]\s*\[( )\]\s*(.*)$/.exec(line);
    if (!m) continue;
    if (/\[家长\]/.test(m[2])) continue;
    const content = m[2].trim();
    if (content) out.push(`- [ ] ${content}`);
  }
  return out;
}

async function runTodoGenServer(ctx: WorkerTaskCtx): Promise<void> {
  const today = formatLocalDate(ctx.now);
  const planItems = loadTodayPlanItemsServer(ctx, today);
  const todayTodo = runKbQuery<{ itemsMd: string } | null>(
    ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.todo.get", { child_id: ctx.childId, date: today }
  );
  const yesterdayTodo = runKbQuery<{ itemsMd: string } | null>(
    ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.todo.get", { child_id: ctx.childId, date: prevDate(today) }
  );
  const parentLines = planItemsToParentLines(planItems);
  const selfTasks = extractSelfTasks(todayTodo?.itemsMd ?? "");
  const yesterdayUnfinished = extractUnfinished(yesterdayTodo?.itemsMd ?? "");
  const parts: string[] = [`今天是 ${today}。请为孩子生成今天的 todolist（今日计划）。`];
  if (parentLines.length > 0) {
    parts.push("【家长规定项（来自学习计划，必须全部保留，标 [家长]，绝不能删改文字）】\n" + parentLines.join("\n"));
  } else {
    parts.push("【家长规定项】今天的学习计划没有安排内容（空天 = 不要求学）。");
  }
  if (selfTasks.length > 0) {
    parts.push("【今天已记录的自规划项（孩子之前要求的，必须保留）】\n" + selfTasks.join("\n"));
  }
  if (yesterdayUnfinished.length > 0) {
    parts.push("【昨日未完成项（酌情并入今天，可调整表述）】\n" + yesterdayUnfinished.join("\n"));
  }
  parts.push(
    "请用 todo_list 工具：先 action=read（date 省略即今天）确认当前内容，再 action=update 整体写入。\n" +
      "格式要求：markdown checkbox（`- [ ]` 未完成 / `- [x]` 已完成）；家长规定项保留 `[家长]` 标记并排在前面；" +
      "孩子自规划项排在后面；可在自规划区补充 1~3 条对孩子今天合理的事（如读书、运动、家务），但不要编造离谱任务。"
  );
  const kbTools = createWorkerKbTools(ctx);
  const session = await createWorkerEphemeralSession(
    ctx,
    "你是一个认真细致的「今日计划」整理助手。你只负责孩子的 Todolist（今日计划）markdown 的生成与完成度核对，不做其他事。",
    ["todo_list", "kb_query", "get_date"],
    kbTools
  );
  try {
    await session.prompt(parts.join("\n\n"));
    console.log(`[worker:todo-gen] child ${ctx.childId}: ${today} 已生成`);
  } finally {
    session.dispose();
  }
}

const DONE_RATE_OK = 0.8;

/** @returns true = 跳过（当天无 todolist），false = 已执行统计 */
async function runTodoStatServer(ctx: WorkerTaskCtx): Promise<boolean> {
  const today = formatLocalDate(ctx.now);
  const todayTodo = runKbQuery<{ itemsMd: string } | null>(
    ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.todo.get", { child_id: ctx.childId, date: today }
  );
  if (!todayTodo?.itemsMd?.trim()) {
    console.log(`[worker:todo-stat] child ${ctx.childId}: ${today} 无 todolist，跳过`);
    return true;
  }
  const conversation = readServerDailyConversation(ctx.dataDir, ctx.parentId, ctx.childId, today);
  const summaries = runKbQuery<Array<{ topic: string; learned: number; total: number; next: string; updated: string }>>(
    ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.progress.list", { child_id: ctx.childId }
  );
  const kbTools = createWorkerKbTools(ctx);
  const session = await createWorkerEphemeralSession(
    ctx,
    "你是一个认真细致的「今日计划」整理助手。你只负责孩子的 Todolist（今日计划）markdown 的生成与完成度核对，不做其他事。",
    ["todo_list", "kb_query", "get_date"],
    kbTools
  );
  try {
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
        ? `【各主题学习进度摘要（判断 [家长] 项——学习计划安排的具体课程——的完成情况）】\n${summaries
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
  } finally {
    session.dispose();
  }
  await saveTodoStatsServer(ctx, today);
  return false;
}

function countTodoTasksServer(md: string): {
  total: number; done: number; parentTotal: number; parentDone: number; selfTotal: number; selfDone: number;
} {
  let total = 0, done = 0, parentTotal = 0, parentDone = 0, selfTotal = 0, selfDone = 0;
  for (const line of md.split("\n")) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/.exec(line);
    if (!m) continue;
    total++;
    const isDone = m[1].toLowerCase() === "x";
    if (isDone) done++;
    if (/\[家长\]/.test(m[2])) {
      parentTotal++;
      if (isDone) parentDone++;
    } else {
      selfTotal++;
      if (isDone) selfDone++;
    }
  }
  return { total, done, parentTotal, parentDone, selfTotal, selfDone };
}

interface TodoStatsRow {
  date: string; total: number; done: number; parent_total: number; parent_done: number;
  self_total: number; self_done: number; rate: number; streak: number;
}

async function saveTodoStatsServer(ctx: WorkerTaskCtx, date: string): Promise<void> {
  const todo = runKbQuery<{ itemsMd: string } | null>(
    ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.todo.get", { child_id: ctx.childId, date }
  );
  if (!todo?.itemsMd?.trim()) return;
  const c = countTodoTasksServer(todo.itemsMd);
  const rate = c.total > 0 ? c.done / c.total : 0;
  let streak = 0;
  const yesterday = prevDate(date);
  const prevRows = runKbQuery<TodoStatsRow[]>(
    ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.todo.stats.list", { child_id: ctx.childId, range: 31 }
  );
  const prev = (prevRows ?? []).find((r) => r.date === yesterday);
  if (rate >= DONE_RATE_OK) {
    streak = prev && prev.rate >= DONE_RATE_OK ? (prev.streak || 0) + 1 : 1;
  }
  runKbExec(ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.todo.stats.upsert", {
    child_id: ctx.childId,
    date,
    total: c.total,
    done: c.done,
    parent_total: c.parentTotal,
    parent_done: c.parentDone,
    self_total: c.selfTotal,
    self_done: c.selfDone,
    rate: Number(rate.toFixed(3)),
    streak,
  });
}

const todoTask: WorkerTask = {
  type: "todo",
  // gen/stat 两个时间点都要补（与客户端 runCatchUp 一致：按时间先后各补一次）
  catchUp: "all",
  points: (cfg) => {
    if (!cfg.todo?.enabled) return [];
    const pts: string[] = [];
    if (/^\d{2}:\d{2}$/.test(cfg.todo.genTime ?? "")) pts.push(cfg.todo!.genTime!);
    if (/^\d{2}:\d{2}$/.test(cfg.todo.statTime ?? "")) pts.push(cfg.todo!.statTime!);
    return pts;
  },
  run: async (ctx): Promise<WorkerRunResult> => {
    if (ctx.point === ctx.schedulerConfig.todo?.genTime) {
      await runTodoGenServer(ctx);
      return { status: "ok", message: `已生成 ${formatLocalDate(ctx.now)} 的今日计划` };
    }
    if (ctx.point === ctx.schedulerConfig.todo?.statTime) {
      const skipped = await runTodoStatServer(ctx);
      return skipped
        ? { status: "skip", message: `${formatLocalDate(ctx.now)} 无 todolist，跳过统计` }
        : { status: "ok", message: `已统计 ${formatLocalDate(ctx.now)} 的完成度` };
    }
    return { status: "ok", message: "" };
  },
};

registerTask(recordingTask);
registerTask(todoTask);
