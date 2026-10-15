/**
 * ISSUE-182 F4：自定义任务连续失败提醒。
 *
 * 家长不该靠翻执行结果页才知道任务挂了：custom 任务连续 error ≥2 次时，给家长推一条提醒——
 * - 持久化：主库 scheduler_alerts 表（重启不丢；每家长保留最近 50 条，防无限增长）；
 * - 推送：agentStreamHub 的家长流（`<pid>:parent` → display_content, source="scheduler_alert"），
 *   与 ISSUE-108 家长报表共用同一条 SSE 桥（electron 桥 → pi:display_content → Dashboard 红点）。
 *   离线家长上线后走 GET /api/v1/scheduler/alerts 读回持久列表。
 *
 * 计数语义：task_runs 里该任务（不分孩子/家长目标）最近两条都 error 即「连续失败 ≥2」；
 * 恢复 ok/skip 后自然重新计数。同一失败串只推一条：已有提醒晚于该任务最近一次非 error run
 * 就不再重复推（服务重启也不会重推旧失败）。
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowLocalIso } from "../util/time.js";
import { AgentStreamHub } from "../agent/stream-hub.js";

export interface SchedulerAlertView {
  id: string;
  parentId: string;
  taskId: string;
  taskName: string;
  message: string;
  createdAt: string;
}

/** 推送函数（默认实现走 agentStreamHub；测试注入桩）。 */
export type SchedulerAlertPublish = (streamKey: string, type: string, data: Record<string, unknown>) => void;

/** 每家长保留的提醒条数上限（滚动清理）。 */
const MAX_ALERTS_PER_PARENT = 50;

/** 写入一条失败提醒（含滚动清理）。返回提醒 id。 */
export function recordSchedulerAlert(
  db: DatabaseSync,
  row: { parentId: string; taskId: string; taskName: string; message: string }
): string {
  const id = crypto.randomUUID();
  const now = nowLocalIso();
  db.prepare(
    "INSERT INTO scheduler_alerts (id, parent_id, task_id, task_name, message, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, row.parentId, row.taskId, row.taskName, row.message, now);
  db.prepare(
    `DELETE FROM scheduler_alerts WHERE parent_id = ? AND id NOT IN (
       SELECT id FROM scheduler_alerts WHERE parent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
     )`
  ).run(row.parentId, row.parentId, MAX_ALERTS_PER_PARENT);
  return id;
}

/** 某家长的失败提醒列表（新的在前）。 */
export function listSchedulerAlerts(db: DatabaseSync, parentId: string, limit = 20): SchedulerAlertView[] {
  const rows = db
    .prepare(
      "SELECT id, parent_id, task_id, task_name, message, created_at FROM scheduler_alerts WHERE parent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?"
    )
    .all(parentId, Math.max(1, Math.min(100, limit))) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    parentId: String(r.parent_id),
    taskId: String(r.task_id),
    taskName: String(r.task_name ?? ""),
    message: String(r.message ?? ""),
    createdAt: String(r.created_at),
  }));
}

/**
 * custom 任务执行落库后调用：连续 error ≥2 → 落一条提醒并推家长流。
 * status 非 error 直接返回 false（恢复即清零，无需显式清计数）。
 * 返回是否新推了一条（测试断言用）。
 */
export function notifyCustomTaskFailure(
  db: DatabaseSync,
  publish: SchedulerAlertPublish | null | undefined,
  parentId: string,
  task: { id: string; name: string },
  status: "ok" | "skip" | "error",
  message: string
): boolean {
  if (status !== "error") return false;
  // 调用时当前 run 已插入 task_runs：最近两条都 error 才算「连续 ≥2」
  const recent = db
    .prepare(
      "SELECT status FROM task_runs WHERE task_id = ? ORDER BY finished_at DESC, rowid DESC LIMIT 2"
    )
    .all(task.id) as Array<{ status: string }>;
  if (recent.length < 2 || recent.some((r) => r.status !== "error")) return false;
  // 同一失败串只推一次：已有提醒晚于最近一次非 error run（从未成功过则只要有提醒就不再推）
  const lastOkAt = (
    db.prepare("SELECT MAX(finished_at) AS t FROM task_runs WHERE task_id = ? AND status != 'error'").get(task.id) as {
      t?: string | null;
    }
  ).t;
  const lastAlertAt = (
    db.prepare("SELECT MAX(created_at) AS t FROM scheduler_alerts WHERE task_id = ?").get(task.id) as {
      t?: string | null;
    }
  ).t;
  if (lastAlertAt && (!lastOkAt || lastAlertAt >= lastOkAt)) return false;

  recordSchedulerAlert(db, { parentId, taskId: task.id, taskName: task.name, message });
  publish?.(AgentStreamHub.key(parentId, "parent"), "display_content", {
    source: "scheduler_alert",
    title: `定时任务连续失败：${task.name}`,
    content: message,
    taskId: task.id,
    ts: Date.now(),
  });
  return true;
}
