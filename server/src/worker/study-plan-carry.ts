/**
 * 学习计划「未完成顺延」每日检测（ISSUE-033 P0b，2026-09-02；判定口径 2026-09-03 修正）。
 *
 * 判定口径（v2）：以昨天 todolist（child_todos）里**未勾的 `[家长]` 行**为准——
 *   昨天的 `[家长]` checkbox 由 stat（纯代码，按课程当天活动）确定性打勾，是「昨天没学完」
 *   的直接真源；顺延 = 昨天计划 items 中「昨天未完成 且 今天尚未排」的 text。
 *   ⚠️ v1 曾依赖 child_todo_stats（昨天 stat 跑不出 stats 就不顺延）→ 9/2 实测 stat 缺失时
 *   该顺延没顺延，家长界面/todo 缺失；v2 直接读 todo checkbox，无需 stats 也能正确顺延。
 * 顺延动作：把上述 text 写为今天 origin='carry' 的新行（text 相同的不重复叠加）。
 * 幂等：worker_state(child_id, 'study_plan_carry').last_key = 昨天日期 → 每天每孩子只处理一次
 *   （每分钟 tick 与启动补跑都会触发，先到先得）。
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openKb } from "../db/kb.js";
import { getWorkerStateKey, setWorkerState } from "../db/sessions.js";
import { formatLocalDate } from "./kb-tools.js";

const CARRY_TASK = "study_plan_carry";

interface CarryDeps {
  dataDir: string;
  db: DatabaseSync;
}

interface PlanRow {
  parent_id: string;
  content: string;
}

interface PlanItem {
  text: string;
  topicKey?: string;
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

function parseContent(raw: string): PlanItem[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as PlanItem[]) : [];
  } catch {
    return [];
  }
}

function collectTexts(rows: PlanRow[]): Set<string> {
  const s = new Set<string>();
  for (const r of rows) {
    for (const it of parseContent(r.content)) {
      if (it.text) s.add(it.text);
    }
  }
  return s;
}

/**
 * 每日顺延检测：对「昨天有 date 行」的孩子，若昨日完成统计明确未达标 → 未学 items 顺延到今天。
 * 幂等游标见文件头；异常不抛出（由调用方记日志），单孩子失败不阻塞其它孩子。
 */
export async function runStudyPlanCarryTick(deps: CarryDeps): Promise<void> {
  const now = new Date();
  const today = formatLocalDate(now);
  const yesterday = shiftDate(today, -1);

  // 只关注昨天实际有排期行的孩子（避免全量遍历+开库开销）
  const pendingChildren = deps.db
    .prepare(
      "SELECT DISTINCT child_id FROM study_plan_items WHERE kind = 'date' AND date = ? AND active = 1"
    )
    .all(yesterday) as Array<{ child_id: string }>;
  if (!pendingChildren.length) return;

  for (const { child_id: childId } of pendingChildren) {
    try {
      if (getWorkerStateKey(deps.db, childId, CARRY_TASK) === yesterday) continue; // 今天已处理过昨天
      const done = await carryOnceForChild(deps, childId, today, yesterday, now);
      // 无论本次是否顺延都记游标（幂等：防止缺 stats 的孩子每分钟重复开库）
      setWorkerState(deps.db, childId, CARRY_TASK, now.toISOString(), yesterday);
      if (done) console.log(`[carry] child=${childId}: 昨日未学完 → 顺延 ${done} 项到 ${today}`);
    } catch (e) {
      console.error(`[carry] child=${childId} failed:`, (e as Error).message);
    }
  }
}

/** 读昨天 todolist 里未勾的 `[家长]` 行文本（剥前缀与顺延注释；空 = 无 todo / 全勾完 → 不顺延）。 */
function yesterdayUndoneParentTexts(deps: CarryDeps, childId: string, date: string): string[] {
  const db = openKb(deps.dataDir, currentParentOf(deps, childId), childId);
  try {
    const row = db
      .prepare("SELECT items_md FROM child_todos WHERE date = ?")
      .get(date) as { items_md: string } | undefined;
    if (!row?.items_md) return [];
    const out: string[] = [];
    for (const line of row.items_md.split("\n")) {
      const m = /^\s*[-*]\s*\[( )\]\s*\[家长\]\s*(.*)$/.exec(line);
      if (!m) continue;
      const text = (m[2] || "")
        .replace(/（昨天没学完，今天补上）\s*$/, "")
        .replace(/（顺延来的补学）\s*$/, "")
        .trim();
      if (text) out.push(text);
    }
    return out;
  } finally {
    db.close();
  }
}

async function carryOnceForChild(
  deps: CarryDeps,
  childId: string,
  today: string,
  yesterday: string,
  now: Date
): Promise<number> {
  const rows = deps.db
    .prepare(
      "SELECT parent_id, content FROM study_plan_items WHERE child_id = ? AND kind = 'date' AND date = ? AND active = 1"
    )
    .all(childId, yesterday) as unknown as PlanRow[];
  if (!rows.length) return 0;

  // 昨天没学完的 = 昨天 todolist 中未勾的 [家长] 行（stat 已按当天活动确定性打勾；无 todo/全勾完 → 不顺延）
  const undoneTexts = yesterdayUndoneParentTexts(deps, childId, yesterday);
  if (!undoneTexts.length) return 0;
  const undoneSet = new Set(undoneTexts);

  // 今天已排的 text（conversation / carry 均算，避免同文本重复叠加）
  const todayRows = deps.db
    .prepare(
      "SELECT content FROM study_plan_items WHERE child_id = ? AND kind = 'date' AND date = ? AND active = 1"
    )
    .all(childId, today) as unknown as PlanRow[];
  const todayTexts = collectTexts(todayRows);

  // 顺延 = 昨天计划 items 中「昨天未完成 且 今天尚未排」的 text
  const carryItems: PlanItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const it of parseContent(r.content)) {
      const t = (it.text || "").trim();
      if (!t || !undoneSet.has(t) || todayTexts.has(t) || seen.has(t)) continue;
      seen.add(t);
      carryItems.push({ text: it.text, topicKey: it.topicKey });
    }
  }
  if (!carryItems.length) return 0;

  const parentId = rows[0].parent_id;
  const id = crypto.randomUUID();
  deps.db
    .prepare(
      "INSERT INTO study_plan_items (id, parent_id, child_id, kind, date, content, origin, active, created_at, updated_at) VALUES (?, ?, ?, 'date', ?, ?, 'carry', 1, ?, ?)"
    )
    .run(id, parentId, childId, today, JSON.stringify(carryItems), now.toISOString(), now.toISOString());
  return carryItems.length;
}

/** 从主库反查孩子归属家长（openKb 需要 parentId 目录）。 */
function currentParentOf(deps: CarryDeps, childId: string): string {
  const row = deps.db.prepare("SELECT parent_id FROM children WHERE id = ?").get(childId) as
    | { parent_id: string }
    | undefined;
  return row?.parent_id ?? "_orphan";
}
