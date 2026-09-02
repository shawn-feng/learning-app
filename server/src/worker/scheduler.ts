/**
 * 服务端无头 worker 调度器（方案B 阶段②）。
 * 每分钟 cron：遍历所有家长 → 孩子 → 注册的 WorkerTask，命中配置时间点且当天该点未跑过
 * （worker_state 去重，比对「本地日期 + hh:mm」）则执行，与客户端 scheduler.ts 语义一致。
 * 配置来源：服务端 settings 的 scheduler_config（客户端 saveSchedulerConfig 已 push 上云）。
 * 注：本调度器在 learning-server 进程内，设备 7x24 在线 → 客户端关机/休眠不再导致漏跑。
 */
import cron from "node-cron";
import type { DatabaseSync } from "node:sqlite";
import { getServerSecret, decryptJson } from "../crypto.js";
import { getWorkerStateKey, setWorkerState } from "../db/sessions.js";
import { findTaskForRun, recordTaskRun } from "../db/task-runs.js";
import { listTasks, hhmm, type WorkerSchedulerChildConfig, type WorkerTask } from "./tasks.js";
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
  cron.schedule("* * * * *", () => {
    // 学习计划顺延检测先于 todo 各时间点（carry 行须在当天 gen 前落库）
    void runStudyPlanCarryTick({ dataDir: deps.dataDir, db: deps.db }).catch((e) =>
      console.error("[worker] study-plan carry tick failed:", (e as Error).message)
    );
    void runWorkerTick(deps).catch((e) => console.error("[worker] tick failed:", (e as Error).message));
  });
  // 启动补跑：服务端重启/掉线错过当天时间点 → 按任务 catchUp 策略补跑（不阻塞启动）
  setTimeout(() => {
    void runStudyPlanCarryTick({ dataDir: deps.dataDir, db: deps.db }).catch((e) =>
      console.error("[worker] study-plan carry catch-up failed:", (e as Error).message)
    );
    void runWorkerCatchUp(deps).catch((e) => console.error("[worker] catch-up failed:", (e as Error).message));
  }, 3000);
  console.log("[worker] 无头 worker 调度器已启动（每分钟，recording/todo 自主任务 + 学习计划顺延）");
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

/** 该时间点今天是否已跑过。 */
function alreadyRanToday(deps: WorkerSchedulerDeps, childId: string, taskType: string, point: string, today: string): boolean {
  const key = getWorkerStateKey(deps.db, childId, taskType);
  return parseRunSet(key, today).has(point);
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
    const matched = findTaskForRun(deps.db, parentId, childId, task.type, point);
    recordTaskRun(deps.db, {
      parentId,
      childId,
      taskId: matched?.id ?? null,
      taskName: matched?.name ?? task.type,
      taskType: task.type,
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
    const childrenCfg = settings.schedulerConfig?.children;
    if (!childrenCfg) continue;
    const children = deps.db.prepare("SELECT id FROM children WHERE parent_id = ?").all(p.id) as Array<{ id: string }>;
    for (const c of children) {
      const cc = childrenCfg[c.id];
      if (!cc) continue;
      for (const task of listTasks()) {
        if (!task.points(cc).includes(nowMin)) continue;
        if (alreadyRanToday(deps, c.id, task.type, nowMin, today)) continue;
        try {
          await runTaskAtPoint(deps, p.id, c.id, cc, task, nowMin, now, settings);
        } catch (e) {
          // 失败不记 worker_state → 下一分钟（仅当仍命中该时间点）或下次补跑自愈；不阻塞其它孩子/任务
          console.error(`[worker] task=${task.type} child=${c.id} failed:`, (e as Error).message);
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
    const childrenCfg = settings.schedulerConfig?.children;
    if (!childrenCfg) continue;
    const children = deps.db.prepare("SELECT id FROM children WHERE parent_id = ?").all(p.id) as Array<{ id: string }>;
    for (const c of children) {
      const cc = childrenCfg[c.id];
      if (!cc) continue;
      for (const task of listTasks()) {
        const points = task.points(cc).filter((t) => t <= nowMin).sort();
        if (!points.length) continue;
        const candidates =
          task.catchUp === "latest"
            ? [points[points.length - 1]]
            : points; // "all"（默认）：按序补全部
        for (const point of candidates) {
          if (alreadyRanToday(deps, c.id, task.type, point, today)) continue;
          try {
            await runTaskAtPoint(deps, p.id, c.id, cc, task, point, now, settings);
          } catch (e) {
            console.error(`[worker] catch-up task=${task.type} child=${c.id} failed:`, (e as Error).message);
          }
        }
      }
    }
  }
}
