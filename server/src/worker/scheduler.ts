/**
 * 服务端无头 worker 调度器（方案B 阶段②）。
 * 每 2 分钟 cron：遍历所有家长 → 孩子，分别跑 plan / stat / recording 三类任务。
 * - plan（重复规则展开）：把 plan_recurrences 命中当天的规则展开成计划行（幂等）。
 * - stat（三域判定 + 统计 + 积分）：每次 tick 都跑，写入全部幂等——学习/考核/生活三域判定、
 *   到期 missed + carry 复制新行、归属日统计、积分结算（见 worker/plan-domain.ts）。
 *   旧的事件驱动（daily 条数变化才跑）已废除——判 missed / 结算依赖时间推进，必须周期性跑。
 * - recording：仍按配置的 recording.times 时间点触发（5 分钟桶匹配，保证落点不错过）。
 * **触发源（2026-09-02 修复，勿再回退）**：优先读 scheduler_tasks + 分配（buildEffectiveChildConfig，
 * 服务端即真源，不依赖客户端推送时机）；无任务分配的孩子回退旧 settings scheduler_config（老客户端兼容）。
 * 注：本调度器在 learning-server 进程内，设备 7x24 在线 → 客户端关机/休眠不再导致漏跑。
 */
import cron from "node-cron";
import { DatabaseSync } from "node:sqlite";
import { getServerSecret, decryptJson } from "../crypto.js";
import { runKbQuery } from "../routes/db.js";
import { getWorkerStateKey, setWorkerState } from "../db/sessions.js";
import {
  buildEffectiveChildConfig,
  findTaskForRun,
  recordTaskRun,
  type EffectiveChildConfig,
} from "../db/task-runs.js";
import { listTasks, hhmm, type WorkerSchedulerChildConfig, type WorkerTask, type WorkerTaskCtx } from "./tasks.js";
import { formatLocalDate } from "./kb-tools.js";
import { expandRecurrences, runPlanStat } from "./plan-domain.js";

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
  cron.schedule("*/2 * * * *", async () => {
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
  console.log("[worker] 无头 worker 调度器已启动（每2分钟：plan(carry+gen)/stat 游标驱动 + recording 定时）");
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

/** worker 任务类型 → 任务表类型。
 *  2026-09-10 ：todo_gen / todo_stat 已下线（计划域三表 + 动态 todolist），现在只剩 recording。 */
function schedulerTaskTypeFor(task: WorkerTask): string {
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
    const matchType = schedulerTaskTypeFor(task);
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

/**
 * stat 去重扩展键（worker_state.last_key）的存储格式。
 * - 旧格式：纯日期字符串（如 "2026-09-03"）= 「当天已跑过一次」（老逻辑一天只统计一次，
 *   2026-09-03 改为「新增 daily 记录即重跑」后，遇到旧格式当天先补跑一次再升级为 JSON）。
 * - 新格式：JSON {date, count}——count = 上次统计时当天 daily 学习记录条数；
 *   当天 daily 条数增加（孩子又学完新课/复习课）→ 下一 tick（≤2 分钟）会重跑统计，让打勾及时反映。
 */
interface StatSeen {
  ranToday: boolean;
  /** 上次统计时的 daily 条数；-1 = 旧格式当天已跑（强制再跑一次后刷新）。 */
  count: number;
}

function parseStatSeen(raw: string, today: string): StatSeen {
  if (!raw) return { ranToday: false, count: -1 };
  try {
    const o = JSON.parse(raw) as { date?: string; count?: number };
    if (o?.date === today) return { ranToday: true, count: Number.isFinite(o.count) ? (o.count as number) : -1 };
    return { ranToday: false, count: -1 }; // 跨天：视为未跑
  } catch {
    // 旧格式纯日期：当天已跑过一次 → count=-1 强制再跑一次（把旧一行统计升级成新格式）
    return raw === today ? { ranToday: true, count: -1 } : { ranToday: false, count: -1 };
  }
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

/**
 * plan tick：先 carry（游标=昨天，昨天未完成→顺延到今天），再 gen（每次 tick 以最新计划
 * 同步今日家长 todolist——家长中途改计划 ≤2 分钟反映到 todolist）。
 * carry 与 gen 合并且 carry 在前，保证顺延行在 gen 读取当日排期前落库。
 */
export async function runPlanTick(deps: WorkerSchedulerDeps): Promise<void> {
  // 2026-09-10 计划域重构：todolist 不再物化（动态查三张计划表）；carry 已并入 stat（判 missed 时复制新行）。
  // plan tick 只负责「按重复规则展开计划行」。
  const now = new Date();
  const today = formatLocalDate(now);
  const parents = deps.db.prepare("SELECT id FROM parents").all() as Array<{ id: string }>;
  for (const p of parents) {
    const settings = readParentSettings(deps.db, deps.dataDir, p.id);
    for (const childId of listChildIds(deps.db, p.id)) {
      try {
        const created = expandRecurrences(buildTodoCtx(deps, p.id, childId, {}, settings, now));
        if (created) console.log(`[worker:plan] child=${childId}: 重复规则展开 ${created} 条计划（${today}）`);
      } catch (e) {
        console.error(`[worker:plan] recurrence-expand child=${childId} failed:`, (e as Error).message);
      }
    }
  }
}

/** 某家长的全部孩子 id。 */
function listChildIds(db: DatabaseSync, parentId: string): string[] {
  return (db.prepare("SELECT id FROM children WHERE parent_id = ?").all(parentId) as Array<{ id: string }>).map(
    (r) => r.id
  );
}

// 2026-09-10 计划域重构：childHasPlanToday / childHasTodosToday 已删（plan tick 不再物化 todolist；stat tick 每次都跑、写入幂等）。

/**
 * stat tick：每次 tick 都跑（计划域三表 + 积分结算每次都是幂等的；不再依赖 todo_items 是否存在的旧逻辑）。
 * worker_state.last_key = {date, count}，daily 新增 → 触发新一轮 stat（学习/考核/生活三域 + 积分结算）。
 */
export async function runStatTick(deps: WorkerSchedulerDeps): Promise<void> {
  const now = new Date();
  const today = formatLocalDate(now);
  const parents = deps.db.prepare("SELECT id FROM parents").all() as Array<{ id: string }>;
  for (const p of parents) {
    const settings = readParentSettings(deps.db, deps.dataDir, p.id);
    // 2026-09-10 计划域重构：stat = 三域判定（学习/考核/生活）→ 到期 carry → 归属日统计 → 积分结算。
    // 事件驱动 + 周期性：每次 tick 都跑（结算/判 missed 依赖时间推进），写入全部幂等
    // （points_ledger 唯一索引 / carry 只对 pending 且已过期行生效 / 统计 upsert）。
    for (const childId of listChildIds(deps.db, p.id)) {
      try {
        const r = runPlanStat(buildTodoCtx(deps, p.id, childId, {}, settings, now));
        const changed = r.signals + r.exams + r.missed + r.carried + r.reward.ledgerRows;
        if (changed) {
          console.log(
            `[worker:stat] child=${childId}: 学习判定 ${r.signals}，考核场次 ${r.exams}，missed ${r.missed}（carry ${r.carried}），` +
              `统计 ${r.stats} 组，积分 +${r.reward.earned}/-${r.reward.deducted}（流水 ${r.reward.ledgerRows} 条）`
          );
        }
      } catch (e) {
        console.error(`[worker:stat] child=${childId} failed:`, (e as Error).message);
      }
    }
  }
}
