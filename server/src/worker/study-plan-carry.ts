/**
 * 学习计划「未完成顺延」每日检测（ISSUE-033 P0b，2026-09-02）。
 * 用户拍板的执行语义：服务端每日定时检测「昨天排的内容学没学完」→ 没学完的自动顺延叠加到今天。
 *
 * 判定口径（保守版）：以孩子 kb `child_todo_stats` 昨天的 `parent_total / parent_done` 为准——
 *   有完成统计且 parent_done < parent_total → 昨天未学完 → 顺延；
 *   昨天没有 stats（todo 未生成/未统计）→ 不臆断「没学」，不顺延（避免无限堆积）。
 * 顺延动作：把昨天所有 date 行（origin=conversation|carry）items 中、今天尚未排过的 text，
 *   写为今天 origin='carry' 的新行（text 相同的不重复叠加；today 聚合自然合并两类行）。
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

  const stats = readStats(deps, childId, yesterday);
  if (!stats || stats.parent_total <= 0 || stats.parent_done >= stats.parent_total) {
    return 0; // 无完成数据或已达标 → 不顺延
  }

  // 今天已排的 text（conversation / carry 均算，避免同文本重复叠加）
  const todayRows = deps.db
    .prepare(
      "SELECT content FROM study_plan_items WHERE child_id = ? AND kind = 'date' AND date = ? AND active = 1"
    )
    .all(childId, today) as unknown as PlanRow[];
  const todayTexts = collectTexts(todayRows);

  const carryItems: PlanItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const it of parseContent(r.content)) {
      if (!it.text || todayTexts.has(it.text) || seen.has(it.text)) continue;
      seen.add(it.text);
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

function readStats(
  deps: CarryDeps,
  childId: string,
  date: string
): { parent_total: number; parent_done: number } | null {
  const db = openKb(deps.dataDir, currentParentOf(deps, childId), childId);
  try {
    const row = db
      .prepare("SELECT parent_total, parent_done FROM child_todo_stats WHERE date = ?")
      .get(date) as { parent_total: number; parent_done: number } | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

/** 从主库反查孩子归属家长（openKb 需要 parentId 目录）。 */
function currentParentOf(deps: CarryDeps, childId: string): string {
  const row = deps.db.prepare("SELECT parent_id FROM children WHERE id = ?").get(childId) as
    | { parent_id: string }
    | undefined;
  return row?.parent_id ?? "_orphan";
}
