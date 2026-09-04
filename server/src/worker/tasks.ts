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
      ["kb_query", "kb_insert", "kb_update", "todo_list"],
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

// ---------- todo（v2：一事一行 / 一课一行，纯 SQL） ----------

/** 主库某天 study_plan_items 行（一课一行）。 */
interface PlanCourseRow {
  id: string;
  date: string;
  topic_key: string;
  course_name: string;
  mode: string;
  origin: string;
  status: string;
  done_at: string;
}

interface TodoRow {
  id: string;
  title: string;
  source: string;
  plan_id: string;
  status: string;
  done_at: string;
  note: string;
}

/** 读主库某天全部排期行。 */
function loadPlanRowsServer(ctx: WorkerTaskCtx, date: string): PlanCourseRow[] {
  return ctx.mainDb
    .prepare(
      "SELECT id, date, topic_key, course_name, mode, origin, status, done_at FROM study_plan_items " +
        "WHERE parent_id = ? AND child_id = ? AND active = 1 AND date = ? ORDER BY created_at ASC"
    )
    .all(ctx.parentId, ctx.childId, date) as unknown as PlanCourseRow[];
}

/** 读孩子 kb 某天全部 todo_items。 */
function loadTodoRowsServer(ctx: WorkerTaskCtx, date: string): TodoRow[] {
  return (
    runKbQuery<TodoRow[]>(ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.todo.list", {
      child_id: ctx.childId,
      date,
    }) ?? []
  );
}

/**
 * 今日家长 todolist 与学习计划同步（v2）。每次 plan tick 调用：
 * 以 study_plan_items 当日排期为真源，把「今天要学/复习的课」物化进 child kb 的 todo_items（source=parent，
 * 关联 plan_id）。规则：
 *  - 预判完成：new 行课程已标注学过（✅/first_learned，不限日期，提前学也算）→ 计划行直接标 done，
 *    对应 todo 物化为 done——否则该行会被 carry 反复顺延（stat 只由当天 daily 驱动，无 daily 时不会回写）；
 *  - 计划里某课今日有排 → 若尚无对应家长 todo 则新增；已有且计划仍在则保留（含已完成态）；
 *  - 计划的课被删除/停用 → 对应家长 todo 一并删除；
 *  - 同一 (course_name, mode) 若今天有 conversation+carry 两行 → 只物化一个（去重，保留先落库的行）；
 *  - 孩子自规划项（source=child）绝不动。
 */
export async function runTodoGenServer(ctx: WorkerTaskCtx): Promise<void> {
  const today = formatLocalDate(ctx.now);
  const planRows = loadPlanRowsServer(ctx, today);
  const todoRows = loadTodoRowsServer(ctx, today);
  const now = new Date().toISOString();

  // 0) 预判已完成（与 stat 的 planCourseDone 同口径）：new 行课程已学过即 done（提前学也算）；
  //    review 行当天已复习过也算。标记计划行，供物化 todo 时带完成态、并防 carry 顺延已完成行。
  const courses =
    runKbQuery<Array<{ title: string; status: string; first_learned: string; last_review: string }>>(
      ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.courses.list", { child_id: ctx.childId }
    ) ?? [];
  const courseByTitle = new Map<string, { status: string; first_learned: string; last_review: string }>();
  for (const c of courses) {
    const title = (c.title || "").trim();
    if (title && !courseByTitle.has(title)) courseByTitle.set(title, c);
  }
  const doneById = new Map<string, boolean>();
  let preDone = 0;
  for (const r of planRows) {
    const course = courseByTitle.get(r.course_name);
    const isDone = course ? planCourseDone(today, course, r.mode) : false;
    doneById.set(r.id, isDone);
    if (isDone && r.status !== "done") {
      ctx.mainDb
        .prepare("UPDATE study_plan_items SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?")
        .run(today, now, r.id);
      preDone++;
    }
  }

  const planIds = new Set(planRows.map((r) => r.id));
  const parentTodos = todoRows.filter((t) => t.source === "parent");

  // 1) 删除：计划已删/停用的家长 todo（其 plan_id 不在今日计划里）
  let removed = 0;
  for (const t of parentTodos) {
    if (!planIds.has(t.plan_id)) {
      runKbExec(ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.todo.removeByPlan", { child_id: ctx.childId, id: t.id, plan_id: t.plan_id });
      removed++;
    }
  }
  // 2) 去重 & 新增：按 (course_name, mode) 保留首个 plan_id，缺的补家长 todo（已判完成的行带 done 建行）
  const seenCourse = new Set<string>();
  let added = 0;
  for (const r of planRows) {
    const courseKey = `${r.course_name}\u0000${r.mode}`;
    if (seenCourse.has(courseKey)) continue; // conversation+carry 同日同课去重
    seenCourse.add(courseKey);
    const exist = parentTodos.find((t) => t.plan_id === r.id);
    if (exist) continue;
    const isDone = doneById.get(r.id) ?? false;
    runKbExec(ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.todo.addParent", {
      child_id: ctx.childId,
      date: today,
      title: r.course_name,
      plan_id: r.id,
      note: r.mode === "review" ? "复习" : "",
      status: isDone ? "done" : "pending",
      done_at: isDone ? today : "",
    });
    added++;
  }
  if (removed || added || preDone) {
    console.log(
      `[worker:todo-gen] child ${ctx.childId}: ${today} 家长项同步（新增 ${added}，删除 ${removed}，预判已完成 ${preDone}）`
    );
  }
}

const DONE_RATE_OK = 0.8;

/**
 * 判某排期行是否完成（2026-09-04 语义调整）：
 *  - review（复习）行：必须「当天」复习过（last_review == 今天）——复习就是为了当天巩固；
 *  - new（新学）行：课程在 courses 里标注学过（状态 ✅ 或有首次学习日期）即完成，**不要求日期在计划当天**
 *    ——提前学（把明天的课今天学了）也算完成。mode 由家长 agent 制定计划时按已学/未学判定，
 *    不会把没学过的课排成复习，故 new 行无需再防错排。
 */
function planCourseDone(
  today: string,
  course: { status?: string; first_learned: string; last_review: string },
  mode: string
): boolean {
  const reviewed = (course.last_review || "").trim();
  if (mode === "review") return reviewed === today;
  if ((course.status || "").trim() === "✅") return true;
  return !!(course.first_learned || "").trim();
}

/**
 * 纯代码统计（v2，不再碰 markdown/不再剥前缀）。数据源全结构化：
 *  - 完成真源 = courses 当天活动（first_learned / last_review == 今天）；
 *  - stat 先按今天排期行精确 join courses → 今天实际学/复习完的行 → 回写 study_plan_items.status='done' + done_at；
 *  - 再据此勾选 child kb 今日家长 todo（source=parent，按 plan_id 关联）；
 *  - 最后从 todo_items 汇总 child_todo_stats（家长/孩子项分开）。
 * @returns true = 跳过（当天无 todo_items），false = 已执行统计
 */
export async function runTodoStatServer(ctx: WorkerTaskCtx): Promise<boolean> {
  const today = formatLocalDate(ctx.now);
  const todoRows = loadTodoRowsServer(ctx, today);
  if (todoRows.length === 0) {
    console.log(`[worker:todo-stat] child ${ctx.childId}: ${today} 无 todolist，跳过`);
    return true;
  }
  const planRows = loadPlanRowsServer(ctx, today);
  const courses =
    runKbQuery<Array<{ topic: string; title: string; status: string; first_learned: string; last_review: string }>>(
      ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.courses.list", { child_id: ctx.childId }
    ) ?? [];
  const courseByTitle = new Map<string, { status: string; first_learned: string; last_review: string }>();
  for (const c of courses) {
    const title = (c.title || "").trim();
    if (title && !courseByTitle.has(title)) courseByTitle.set(title, c);
  }
  // 1) 回写今天排期行的完成态
  // 记录每排期行「是否完成」的判定结果（判定依据 courses 当天活动，与库内 status 无关），
  // 供第 2) 步同步家长 todo 用——不能读 r.status（那是在本函数开头 load 的陈旧内存值，
  // 第 1) 步的 UPDATE 尚未反映进去）。
  const doneOfPlan = new Map<string, boolean>();
  let planDoneCount = 0;
  for (const r of planRows) {
    const course = courseByTitle.get(r.course_name);
    if (!course) {
      doneOfPlan.set(r.id, false); // 排了但孩子课程表没有该课 → 不完成
      continue;
    }
    const isDone = planCourseDone(today, course, r.mode);
    doneOfPlan.set(r.id, isDone);
    if (isDone && r.status !== "done") {
      ctx.mainDb
        .prepare("UPDATE study_plan_items SET status = 'done', done_at = ?, updated_at = ? WHERE id = ?")
        .run(today, new Date().toISOString(), r.id);
      planDoneCount++;
    }
  }
  // 2) 勾选/取消家长 todo（按 plan_id 关联今天排期行的 done 判定）
  const doneByPlanId = doneOfPlan;
  let todoChanged = 0;
  for (const t of todoRows) {
    if (t.source !== "parent") continue;
    const shouldDone = doneByPlanId.get(t.plan_id) ?? false;
    if ((t.status === "done") !== shouldDone) {
      runKbExec(ctx.dataDir, ctx.mainDb, ctx.parentId, "kb.todo.set", {
        child_id: ctx.childId,
        id: t.id,
        status: shouldDone ? "done" : "pending",
      });
      todoChanged++;
    }
  }
  if (planDoneCount || todoChanged) {
    console.log(`[worker:todo-stat] child ${ctx.childId}: ${today} 完成项 ${planDoneCount}（排期回写），todo 调整 ${todoChanged}`);
  }
  await saveTodoStatsServer(ctx, today);
  return false;
}

/** 按 todo_items 行汇总（一事一行：source=parent → 家长项）。 */
function countTodoTasksServer(rows: TodoRow[]): {
  total: number; done: number; parentTotal: number; parentDone: number; selfTotal: number; selfDone: number;
} {
  let total = 0, done = 0, parentTotal = 0, parentDone = 0, selfTotal = 0, selfDone = 0;
  for (const r of rows) {
    total++;
    const isDone = r.status === "done";
    if (isDone) done++;
    if (r.source === "parent") {
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
  const todoRows = loadTodoRowsServer(ctx, date);
  if (todoRows.length === 0) return;
  const c = countTodoTasksServer(todoRows);
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

registerTask(recordingTask);
