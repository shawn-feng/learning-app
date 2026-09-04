/**
 * 学习计划「未完成顺延」每日检测（ISSUE-033 P0b，v3 2026-09-04 一课一行重构）。
 *
 * 判定口径（v3）：每行 study_plan_items 自带 status（pending/done）。**昨天仍为 pending 的行**即「昨天
 * 没学完」——stat 会在孩子当天学/复习完对应课程后把该行置 done。carry 不再读 todolist checkbox、不再
 * 剥文本前缀，纯按主库排期行 status 精确判定。
 * 顺延动作：把昨天 pending 且今天尚未排（同 course_name+mode）的行，改写为今天 origin='carry' 的新行。
 * 幂等：worker_state(child_id, 'study_plan_carry').last_key = 昨天日期 → 每天每孩子只处理一次
 *   （每分钟 tick 与启动补跑都会触发，先到先得）。
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getWorkerStateKey, setWorkerState } from "../db/sessions.js";
import { formatLocalDate } from "./kb-tools.js";

const CARRY_TASK = "study_plan_carry";

interface CarryDeps {
  dataDir: string;
  db: DatabaseSync;
}

interface PlanCourseRow {
  id: string;
  parent_id: string;
  child_id: string;
  date: string;
  topic_key: string;
  course_name: string;
  mode: string;
  origin: string;
  status: string;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地日期 shift：'2026-09-02' -1 → '2026-09-01'。 */
function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/**
 * 每日顺延检测：对「昨天有排期行」的孩子，若昨日仍有 pending 行（没学完）→ 顺延到今天（写为今天
 * origin='carry' 的新行）。幂等游标见文件头；单孩子失败不阻塞其它孩子。
 */
export async function runStudyPlanCarryTick(deps: CarryDeps): Promise<void> {
  const now = new Date();
  const today = formatLocalDate(now);
  const yesterday = shiftDate(today, -1);

  // 只关注昨天实际有排期行的孩子（避免全量遍历）
  const pendingChildren = deps.db
    .prepare("SELECT DISTINCT child_id FROM study_plan_items WHERE date = ? AND active = 1")
    .all(yesterday) as Array<{ child_id: string }>;
  if (!pendingChildren.length) return;

  for (const { child_id: childId } of pendingChildren) {
    try {
      if (getWorkerStateKey(deps.db, childId, CARRY_TASK) === yesterday) continue; // 今天已处理过昨天
      const done = await carryOnceForChild(deps, childId, today, yesterday, now);
      // 无论是否顺延都记游标（幂等）
      setWorkerState(deps.db, childId, CARRY_TASK, now.toISOString(), yesterday);
      if (done) console.log(`[carry] child=${childId}: 昨日未学完 → 顺延 ${done} 项到 ${today}`);
    } catch (e) {
      console.error(`[carry] child=${childId} failed:`, (e as Error).message);
    }
  }
}

async function carryOnceForChild(
  deps: CarryDeps,
  childId: string,
  today: string,
  yesterday: string,
  now: Date
): Promise<number> {
  // 昨天全部排期行（只取仍未完成 status != done）
  const rows = deps.db
    .prepare(
      "SELECT id, parent_id, child_id, date, topic_key, course_name, mode, origin, status " +
        "FROM study_plan_items WHERE child_id = ? AND date = ? AND active = 1"
    )
    .all(childId, yesterday) as unknown as PlanCourseRow[];
  const undoneRows = rows.filter((r) => r.status !== "done" && r.status !== "carried");
  if (!undoneRows.length) return 0;

  // 今天已排（含 carry 来的）同课去重键（course_name + mode），避免重复叠加
  const todayRows = deps.db
    .prepare("SELECT topic_key, course_name, mode FROM study_plan_items WHERE child_id = ? AND date = ? AND active = 1")
    .all(childId, today) as unknown as Array<{ topic_key: string; course_name: string; mode: string }>;
  const todayKeys = new Set(todayRows.map((r) => `${r.course_name}\u0000${r.mode}`));

  const parentId = undoneRows[0].parent_id;
  let carried = 0;
  for (const r of undoneRows) {
    const courseKey = `${r.course_name}\u0000${r.mode}`;
    if (todayKeys.has(courseKey)) {
      // 今天已经排过同课 → 不必叠加；但可把昨天的 pending 行停用，避免再被判定
      deps.db
        .prepare("UPDATE study_plan_items SET status = 'carried', active = 0, updated_at = ? WHERE id = ?")
        .run(now.toISOString(), r.id);
      continue;
    }
    todayKeys.add(courseKey);
    const id = crypto.randomUUID();
    deps.db
      .prepare(
        "INSERT INTO study_plan_items (id, parent_id, child_id, date, topic_key, course_name, mode, origin, status, done_at, active, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'carry', 'pending', '', 1, ?, ?)"
      )
      .run(id, parentId, childId, today, r.topic_key, r.course_name, r.mode, now.toISOString(), now.toISOString());
    // 昨天的行不再保持 pending（停用，防下一天重复顺延同课）
    deps.db
      .prepare("UPDATE study_plan_items SET status = 'carried', active = 0, updated_at = ? WHERE id = ?")
      .run(now.toISOString(), r.id);
    carried++;
  }
  return carried;
}
