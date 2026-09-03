/**
 * 服务端无头 worker 调度器（方案B 阶段②）。
 * 每 5 分钟 cron：遍历所有家长 → 孩子，分别跑 plan / stat / recording 三类任务。
 * - plan（carry+gen）：carry 顺延（游标=昨天）先于当日 todolist 生成（游标=今天；今天已有 todolist 则跳过）。
 * - stat（完成度统计）：游标=今天，事件驱动——当天有新的 daily 学习记录且已有 todolist 时执行一次。
 * - recording：仍按配置的 recording.times 时间点触发（5 分钟桶匹配，保证落点不错过）。
 * **触发源（2026-09-02 修复，勿再回退）**：优先读 scheduler_tasks + 分配（buildEffectiveChildConfig，
 * 服务端即真源，不依赖客户端推送时机）；无任务分配的孩子回退旧 settings scheduler_config（老客户端兼容）。
 * 注：本调度器在 learning-server 进程内，设备 7x24 在线 → 客户端关机/休眠不再导致漏跑。
 */
import cron from "node-cron";
import type { DatabaseSync } from "node:sqlite";
import { getServerSecret, decryptJson } from "../crypto.js";
import { runKbQuery } from "../routes/db.js";
import { getWorkerStateKey, setWorkerState } from "../db/sessions.js";
import {
  buildEffectiveChildConfig,
  findTaskForRun,
  recordTaskRun,
  type EffectiveChildConfig,
} from "../db/task-runs.js";
import { listTasks, hhmm, runTodoGenServer, runTodoStatServer, type WorkerSchedulerChildConfig, type WorkerTask, type WorkerTaskCtx } from "./tasks.js";
import { formatLocalDate } from "./kb-tools.js";
import { runStudyPlanCarryTick } from "./study-plan-carry.js";

interface WorkerSchedulerDeps {
  dataDir: string;
  db: DatabaseSync;
}

interface ParentSettings {
  auth: Record<string, unknown>;
  appSettings?: Record<string, unknown>;
  schedulerConfig?: { children?: Record<string, WorkerSchedulerChildConfig> };
}

function readParentSettings(db: DatabaseSync, dataDir: string, parentId: string): ParentSettings {
  const secret = getServerSecret(dataDir);
  const get = (key: string): unknown => {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`${parentId}:${key}`) as
      | { value_json?: string }
      | undefined;
    if (!row?.value_json) return undefined;
    if (key === "auth") {
      const dec = decryptJson(secret, row.value_json);
      if (dec !== null) return dec;
      // 兼容旧明文存储
      try {
        return JSON.parse(row.value_json);
      } catch {
        return undefined;
      }
    }
    try {
      return JSON.parse(row.value_json);
    } catch {
      return undefined;
    }
  };
  return {
    auth: (get("auth") as Record<string, unknown>) ?? {},
    appSettings: (get("app_settings") as Record<string, unknown>) ?? undefined,
    schedulerConfig: (get("scheduler_config") as ParentSettings["schedulerConfig"]) ?? undefined,
  };
}

export function startWorkerScheduler(deps: WorkerSchedulerDeps): void {
  cron.schedule("*/5 * * * *", async () => {
    // 顺序执行：先 plan（carry→gen），再 stat，最后 recording。保证 carry 行在 gen 前落库、todolist 在 stat 前生成。
    try { await runPlanTick(deps); } catch (e) { console.error("[worker] plan tick failed:", (e as Error).message); }
    try { await runStatTick(deps); } catch (e) { console.error("[worker] stat tick failed:", (e as Error).message); }
    try { await runWorkerTick(deps); } catch (e) { console.error("[worker] tick failed:", (e as Error).message); }
  });
  // 启动补跑：服务端重启/掉线 → plan/stat 游标自愈（下一 tick 重试），recording 按 catchUp 补跑（不阻塞启动）
  setTimeout(async () => {
    try { await runPlanTick(deps); } catch (e) { console.error("[worker] plan catch-up failed:", (e as Error).message); }
    try { await runStatTick(deps); } catch (e) { console.error("[worker] stat catch-up failed:", (e as Error).message); }
    try { await runWorkerCatchUp(deps); } catch (e) { console.error("[worker] catch-up failed:", (e as Error).message); }
  }, 3000);
  console.log("[worker] 无头 worker 调度器已启动（每5分钟：plan(carry+gen)/stat 游标驱动 + recording 定时）");
}

/**
 * 当天已跑时间点集合（worker_state.last_key，JSON {date, points[]}）。
 * 单值 last_run 只能记最后一次执行，todo 这类多时间点任务（gen+stat）补跑会重复，
 * 故用集合记录「今天已跑过的所有点」（跨天自动失效）。
 */
function parseRunSet(key: string, today: string): Set<string> {
  try {
    const o = JSON.parse(key) as { date?: string; points?: string[] };
    if (o?.date === today && Array.isArray(o.points)) {
      return new Set(o.points);
    }
  } catch {
    /* 旧格式/损坏 → 视为空集合 */
  }
  return new Set();
}

/** 把 HH:mm 向下取整到 5 分钟桶起点（分钟数）。 */
function bucketStartMin(nowMin: string): number {
  const [h, m] = nowMin.split(":").map(Number);
  return Math.floor((h * 60 + m) / 5) * 5;
}

/** 配置的触发点是否落在本 5 分钟桶内（保证每点每桶恰好触发一次）。 */
function pointInBucket(point: string, nowMin: string): boolean {
  const [ph, pm] = point.split(":").map(Number);
  const pt = ph * 60 + pm;
  const bs = bucketStartMin(nowMin);
  return pt >= bs && pt < bs + 5;
}

/**
 * 合并某孩子的执行配置：任务模型孩子（有任一分配任务）→ 该类型以任务为准、未分配类型关闭；
 * 无任务分配的孩子（旧模型）→ 原样用 legacy scheduler_config。
 */
function resolveChildConfig(
  legacy: WorkerSchedulerChildConfig | undefined,
  eff: EffectiveChildConfig | undefined
): WorkerSchedulerChildConfig | undefined {
  if (!legacy && !eff) return undefined;
  const base: WorkerSchedulerChildConfig = legacy ? JSON.parse(JSON.stringify(legacy)) : {};
  if (!eff) return base;
  const hasTask = eff.recording.enabled || eff.todo.enabled || eff.autoNewSession.enabled;
  if (!hasTask) return base;
  return {
    ...base,
    // 任务驱动：enabled 以任务分配为准（避免旧 per-child 配置残留误跑/双跑）
    recording: {
      enabled: eff.recording.enabled,
      times: eff.recording.enabled ? eff.recording.times : [],
      onNewSession: eff.recording.enabled ? eff.recording.onNewSession : false,
    },
    todo: {
      enabled: eff.todo.enabled,
      genTime: eff.todo.enabled ? eff.todo.genTime : "",
      statTime: eff.todo.enabled ? eff.todo.statTime : "",
    },
    autoNewSession: { ...eff.autoNewSession },
  };
}

/** 遍历某家长的（孩子 id, 合并配置）序列；skippedParent 标记无任何可用配置。 */
function collectChildConfigs(
  deps: WorkerSchedulerDeps,
  parentId: string,
  settings: ParentSettings
): Array<{ childId: string; cc: WorkerSchedulerChildConfig }> {
  const effMap = buildEffectiveChildConfig(deps.db, parentId);
  const legacyChildren = settings.schedulerConfig?.children ?? {};
  const children = deps.db.prepare("SELECT id FROM children WHERE parent_id = ?").all(parentId) as Array<{ id: string }>;
  const out: Array<{ childId: string; cc: WorkerSchedulerChildConfig }> = [];
  for (const c of children) {
    const cc = resolveChildConfig(legacyChildren[c.id], effMap[c.id]);
    if (!cc) continue;
    out.push({ childId: c.id, cc });
  }
  return out;
}

/** 该时间点今天是否已跑过。 */
function alreadyRanToday(deps: WorkerSchedulerDeps, childId: string, taskType: string, point: string, today: string): boolean {
  const key = getWorkerStateKey(deps.db, childId, taskType);
  return parseRunSet(key, today).has(point);
}

/** worker 任务类型 → 任务表类型（todo 按时间点拆 gen/stat；recording 同名）。 */
function schedulerTaskTypeFor(task: WorkerTask, cc: WorkerSchedulerChildConfig, point: string): string {
  if (task.type === "todo") {
    if (point === cc.todo?.genTime) return "todo_gen";
    if (point === cc.todo?.statTime) return "todo_stat";
    return "todo";
  }
  return task.type;
}

/** 在指定时间点执行某任务（成功才记 worker_state，失败不记 → 下轮/补跑自愈）。 */
async function runTaskAtPoint(
  deps: WorkerSchedulerDeps,
  parentId: string,
  childId: string,
  cc: WorkerSchedulerChildConfig,
  task: WorkerTask,
  point: string,
  now: Date,
  settings: ParentSettings
): Promise<void> {
  const startedAt = new Date();
  let status: "ok" | "skip" | "error" = "ok";
  let message = "";
  try {
    const result = await task.run({
      dataDir: deps.dataDir,
      mainDb: deps.db,
      parentId,
      childId,
      auth: settings.auth,
      appSettings: settings.appSettings,
      schedulerConfig: cc,
      now,
      point,
    });
    status = result?.status === "skip" ? "skip" : "ok";
    message = result?.message ?? "";
  } catch (e) {
    status = "error";
    message = (e as Error).message ?? String(e);
    console.error(`[worker] task=${task.type} child=${childId} failed@${point}:`, message);
  }

  // 执行结果写入 task_runs（家长「定时任务执行结果」查询；任务匹配 = 类型+时间点+孩子分配）
  try {
    const matchType = schedulerTaskTypeFor(task, cc, point);
    const matched = findTaskForRun(deps.db, parentId, childId, matchType, point);
    recordTaskRun(deps.db, {
      parentId,
      childId,
      taskId: matched?.id ?? null,
      taskName: matched?.name ?? task.type,
      taskType: matchType,
      date: formatLocalDate(now),
      point,
      status,
      message,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[worker] record task_runs failed (${task.type} ${childId}):`, (e as Error).message);
  }

  // 去重游标：仅成功/跳过才推进（失败下一分钟重试）；last_run 记「触发点当天时刻」，
  // last_key 记「当天已跑点集合」（todo 多时间点不互相覆盖）。
  if (status !== "error") {
    const [hh, mm] = point.split(":").map(Number);
    const at = new Date(now);
    at.setHours(hh, mm, 0, 0);
    const today = formatLocalDate(now);
    const ran = parseRunSet(getWorkerStateKey(deps.db, childId, task.type), today);
    ran.add(point);
    setWorkerState(
      deps.db,
      childId,
      task.type,
      at.toISOString(),
      JSON.stringify({ date: today, points: [...ran].sort() })
    );
  }
  console.log(`[worker] task=${task.type} child=${childId} ${status}@${point}${message ? ` (${message})` : ""}`);
}

export async function runWorkerTick(deps: WorkerSchedulerDeps): Promise<void> {
  const now = new Date();
  const nowMin = hhmm(now);
  const today = formatLocalDate(now);
  const parents = deps.db.prepare("SELECT id FROM parents").all() as Array<{ id: string }>;
  for (const p of parents) {
    const settings = readParentSettings(deps.db, deps.dataDir, p.id);
    for (const { childId, cc } of collectChildConfigs(deps, p.id, settings)) {
      for (const task of listTasks()) {
        // 5 分钟桶匹配：配置的触发点落在本桶内才跑（保证每点每桶恰好一次，不漏非整 5 分的点）
        const pts = task.points(cc).filter((pt) => pointInBucket(pt, nowMin));
        if (!pts.length) continue;
        for (const pt of pts) {
          if (alreadyRanToday(deps, childId, task.type, pt, today)) continue;
          try {
            await runTaskAtPoint(deps, p.id, childId, cc, task, pt, now, settings);
          } catch (e) {
            // 失败不记 worker_state → 下一桶（仍命中）或下次补跑自愈；不阻塞其它孩子/任务
            console.error(`[worker] task=${task.type} child=${childId} failed:`, (e as Error).message);
          }
        }
      }
    }
  }
}

/**
 * 启动补跑：对每个孩子每个任务，把「今天已过且当天未跑」的时间点按 catchUp 策略补跑一次。
 * - latest：取最近一个已过期未跑的点（recording 一天一次汇总，与客户端 runCatchUp 对齐）
 * - all：按时间顺序补跑全部已过期未跑的点（todo 的 gen + stat 都要）
 */
export async function runWorkerCatchUp(deps: WorkerSchedulerDeps): Promise<void> {
  const now = new Date();
  const nowMin = hhmm(now);
  const today = formatLocalDate(now);
  const parents = deps.db.prepare("SELECT id FROM parents").all() as Array<{ id: string }>;
  for (const p of parents) {
    const settings = readParentSettings(deps.db, deps.dataDir, p.id);
    for (const { childId, cc } of collectChildConfigs(deps, p.id, settings)) {
      for (const task of listTasks()) {
        const points = task.points(cc).filter((t) => t <= nowMin).sort();
        if (!points.length) continue;
        const candidates =
          task.catchUp === "latest"
            ? [points[points.length - 1]]
            : points; // "all"（默认）：按序补全部
        for (const point of candidates) {
          if (alreadyRanToday(deps, childId, task.type, point, today)) continue;
          try {
            await runTaskAtPoint(deps, p.id, childId, cc, task, point, now, settings);
          } catch (e) {
            console.error(`[worker] catch-up task=${task.type} child=${childId} failed:`, (e as Error).message);
          }
        }
      }
    }
  }
}

// ---------- plan (carry + gen) / stat：游标驱动，不再按固定时刻 ----------

/** 某 (childId, key) 是否已处理过指定 day（游标 = worker_state.last_key === day）。 */
function cursorDayDone(deps: WorkerSchedulerDeps, childId: string, key: string, day: string): boolean {
  return getWorkerStateKey(deps.db, childId, key) === day;
}
function markCursorDay(deps: WorkerSchedulerDeps, childId: string, key: string, day: string, now: Date): void {
  setWorkerState(deps.db, childId, key, now.toISOString(), day);
}

/** 构造 gen/stat 所需的 WorkerTaskCtx（不依赖时间点，point 留空）。 */
function buildTodoCtx(
  deps: WorkerSchedulerDeps,
  parentId: string,
  childId: string,
  cc: WorkerSchedulerChildConfig,
  settings: ParentSettings,
  now: Date
): WorkerTaskCtx {
  return {
    dataDir: deps.dataDir,
    mainDb: deps.db,
    parentId,
    childId,
    auth: settings.auth,
    appSettings: settings.appSettings,
    schedulerConfig: cc,
    now,
    point: "",
  };
}

/** 今天是否已有 todolist（用于 gen 跳过判定 / stat 前置条件）。 */
function todayHasTodolist(deps: WorkerSchedulerDeps, parentId: string, childId: string, today: string): boolean {
  const todo = runKbQuery<{ itemsMd: string } | null>(
    deps.dataDir, deps.db, parentId, "kb.todo.get", { child_id: childId, date: today }
  );
  return !!todo?.itemsMd?.trim();
}

/**
 * plan tick：先 carry（游标=昨天，昨天未完成→顺延到今天），再 gen（游标=今天）。
 * gen 每天每孩子一次：今天还没有 todolist 就生成，已有则跳过。
 * carry 与 gen 合并且 carry 在前，保证顺延行在 gen 读取当日排期前落库。
 */
export async function runPlanTick(deps: WorkerSchedulerDeps): Promise<void> {
  // carry 先于 gen：runStudyPlanCarryTick 内部按 (child, 昨天) 游标幂等（一天一次，已顺延过即跳过）
  await runStudyPlanCarryTick(deps).catch((e) =>
    console.error("[worker] study-plan carry failed:", (e as Error).message)
  );
  const now = new Date();
  const today = formatLocalDate(now);
  const parents = deps.db.prepare("SELECT id FROM parents").all() as Array<{ id: string }>;
  for (const p of parents) {
    const settings = readParentSettings(deps.db, deps.dataDir, p.id);
    for (const { childId, cc } of collectChildConfigs(deps, p.id, settings)) {
      if (!cc.todo?.enabled) continue;
      try {
        // 2026-09-03：gen = todolist↔计划「同步」（不再是生成一次就锁死）——每次 tick 以最新
        // study_plan_items 刷新今日【家长规定项】：家长中途改计划 ≤5 分钟反映到 todo；
        // 无变化不写回；同文本已勾保持 [x]；孩子自定任务等非家长内容原样保留。
        await runTodoGenServer(buildTodoCtx(deps, p.id, childId, cc, settings, now));
      } catch (e) {
        console.error(`[worker:plan] todo-sync child=${childId} failed:`, (e as Error).message);
      }
    }
  }
}

/** 当天是否有新的 daily 学习记录（stat 的事件触发条件）。 */
function todayHasDaily(deps: WorkerSchedulerDeps, parentId: string, childId: string, today: string): boolean {
  const daily = runKbQuery<Array<unknown>>(
    deps.dataDir, deps.db, parentId, "kb.daily_entries.queryByDate", { child_id: childId, date: today }
  );
  return !!daily && daily.length > 0;
}

/**
 * stat tick：游标=今天，事件驱动——当天有新的 daily 学习记录且今天已有 todolist 时，执行一次。
 * 不再按固定时刻：只要出现新学习记录就统计，且每天只统计一次（游标防重）。
 */
export async function runStatTick(deps: WorkerSchedulerDeps): Promise<void> {
  const now = new Date();
  const today = formatLocalDate(now);
  const parents = deps.db.prepare("SELECT id FROM parents").all() as Array<{ id: string }>;
  for (const p of parents) {
    const settings = readParentSettings(deps.db, deps.dataDir, p.id);
    for (const { childId, cc } of collectChildConfigs(deps, p.id, settings)) {
      if (!cc.todo?.enabled) continue;
      try {
        if (cursorDayDone(deps, childId, "todo_stat", today)) continue;
        if (!todayHasTodolist(deps, p.id, childId, today)) continue;
        if (!todayHasDaily(deps, p.id, childId, today)) continue;
        await runTodoStatServer(buildTodoCtx(deps, p.id, childId, cc, settings, now));
        markCursorDay(deps, childId, "todo_stat", today, now);
        console.log(`[worker:stat] child=${childId}: ${today} 已统计完成度`);
      } catch (e) {
        console.error(`[worker:stat] child=${childId} failed:`, (e as Error).message);
      }
    }
  }
}
