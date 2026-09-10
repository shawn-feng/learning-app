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
import { openKb } from "../db/kb.js";
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
  // ISSUE-059：课程时间表升级为「模板 + 星期映射」（客户端本地用于上课/下课提醒，服务端仅结构对齐、不参与调度）
  classTemplates?: Array<{ id?: string; name?: string; times?: Array<{ start?: string; end?: string; label?: string }> }>;
  classWeek?: { [day: number]: string | null };
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
  const lifePlans = todayLifePlansText(ctx.dataDir, ctx.parentId, ctx.childId, formatLocalDate(ctx.now));
  const parts = [
    "## 已提供的上下文（直接使用，无需调用工具查询）",
    "",
    "【主题清单与进度摘要】",
    topicLines.length ? topicLines.join("\n") : "（暂无学习主题）",
    "",
    "【标签定义表】",
    tagsText || "（无标签定义）",
  ];
  if (lifePlans) {
    parts.push(
      "",
      "【今天的生活计划（判定完成用；写 daily 时带上对应 plan_id 与 plan_outcome）】",
      lifePlans,
      "规则：对照本次对话判断每条是否完成，写该事件的 daily 条目时带 plan_id=上面的 id、plan_outcome=done/missed/unknown；",
      "对不上任何计划行的自由事件照常记录但不带 plan_id；**不要编造计划项、不要改动计划**（状态由系统更新）。"
    );
  }
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

/** 当天生活计划清单（供 recording 判定完成并回写 plan_id/plan_outcome）。 */
function todayLifePlansText(dataDir: string, parentId: string, childId: string, date: string): string {
  try {
    const kb = openKb(dataDir, parentId, childId);
    try {
      const rows = kb
        .prepare(
          `SELECT id, title, creator, due_at FROM life_plans
           WHERE active = 1 AND status = 'pending'
             AND (start_at = '' OR substr(start_at,1,10) <= ?)
             AND (due_at  = '' OR substr(due_at,1,10)  >= ?)
           ORDER BY due_at`
        )
        .all(date, date) as Array<{ id: string; title: string; creator: string; due_at: string }>;
      if (!rows.length) return "";
      return rows
        .map(
          (r) =>
            `- plan_id=${r.id}｜「${r.title}」｜截止 ${String(r.due_at).slice(0, 16)}｜${
              r.creator === "parent" ? "必须完成项（家长制定）" : "加分项（孩子自定）"
            }`
        )
        .join("\n");
    } finally {
      kb.close();
    }
  } catch {
    return "";
  }
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

registerTask(recordingTask);
