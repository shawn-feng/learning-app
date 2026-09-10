/**
 * 计划域 + 积分域 worker（2026-09-10 重构，设计见 DESIGN-plan-domain-rewrite / DESIGN-reward-points）。
 *
 * 职责（取代旧的 todo_gen / todo_stat / carry 三件套）：
 *   1) expandRecurrences：把 plan_recurrences 命中今天的规则展开成计划行（三表之一，origin=recurrence，幂等）
 *   2) runPlanStat：三域判定 + 到期 carry + 归属日统计 + 积分结算
 *      - 学习域：courses 有学习时间且落在计划窗口内 → study_plans.done（并回写当天 daily 学习条目的 plan_id）
 *      - 考核域：当天考核场次 → exam_plans.done/score/attempt_id + exam_plan_courses 明细（计划期不固化题目）
 *      - 生活域：daily_entries(plan_id + plan_outcome='done') → life_plans.done
 *      - 到期未完成 → missed；**复制新行到当天**（origin=carry，窗口=当天）；cancelled 不复制
 *      - 归属日统计 → reward_daily_stats（source × owner）
 *      - 积分结算 → points_ledger（幂等，只有真实变动才写；见 settleRewards）
 *
 * ⚠️ 只有生活域需要 recording 参与（写 daily 证据）；学习/考核各有确定性信号源（courses / 考核提交）。
 * ⚠️ 本模块为服务端进程内 worker，直接 openKb 读写孩子库（家长端/客户端仍走 kb RPC op）。
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { openKb } from "../db/kb.js";
import type { WorkerTaskCtx } from "./tasks.js";
import { formatLocalDate } from "./kb-tools.js";

type Status = "pending" | "done" | "missed" | "cancelled";

interface Tier {
  min: number;
  max: number;
  label: string;
  points: number;
}

/** 默认档位（设计定案 18:42）：100% 为独立闭区间档 */
export const DEFAULT_TODO_TIERS: Tier[] = [
  { min: 0, max: 0.6, label: "不合格", points: -10 },
  { min: 0.6, max: 0.8, label: "合格", points: 0 },
  { min: 0.8, max: 1.0, label: "良好", points: 10 },
  { min: 1.0, max: 1.0, label: "优秀", points: 20 },
];
export const DEFAULT_EXAM_TIERS: Tier[] = [
  { min: 0, max: 0.8, label: "不合格", points: -15 },
  { min: 0.8, max: 0.9, label: "合格", points: 0 },
  { min: 0.9, max: 1.0, label: "良好", points: 10 },
  { min: 1.0, max: 1.0, label: "优秀", points: 20 },
];

interface RewardConfig {
  todoTiers: Tier[];
  examTiers: Tier[];
  todoGateParentMinRate: number;
  examGateParentMinScore: number;
  childNoDeduct: boolean;
}

function parseTiers(raw: string | null | undefined, fallback: Tier[]): Tier[] {
  try {
    const a = JSON.parse(raw || "[]") as Tier[];
    if (!Array.isArray(a) || !a.length) return fallback;
    return a
      .filter((t) => t && typeof t.min === "number" && typeof t.max === "number")
      .map((t) => ({ min: Number(t.min), max: Number(t.max), label: String(t.label ?? ""), points: Number(t.points) || 0 }));
  } catch {
    return fallback;
  }
}

export function loadRewardConfig(kb: DatabaseSync, childId: string): RewardConfig {
  const row = kb
    .prepare(
      "SELECT todo_tiers_json, exam_tiers_json, todo_gate_parent_min_rate, exam_gate_parent_min_score, child_no_deduct FROM reward_configs WHERE child_id = ?"
    )
    .get(childId) as
    | {
        todo_tiers_json?: string;
        exam_tiers_json?: string;
        todo_gate_parent_min_rate?: number;
        exam_gate_parent_min_score?: number;
        child_no_deduct?: number;
      }
    | undefined;
  return {
    todoTiers: parseTiers(row?.todo_tiers_json, DEFAULT_TODO_TIERS),
    examTiers: parseTiers(row?.exam_tiers_json, DEFAULT_EXAM_TIERS),
    todoGateParentMinRate: row?.todo_gate_parent_min_rate ?? 1.0,
    examGateParentMinScore: row?.exam_gate_parent_min_score ?? 0.9,
    childNoDeduct: (row?.child_no_deduct ?? 1) === 1,
  };
}

/** 命中档位：区间左闭右开，末档上界含 1（min===max===1 的独立档按闭区间处理）。 */
export function matchTier(tiers: Tier[], rate: number): Tier | undefined {
  const r = Math.max(0, Math.min(1, rate));
  for (const t of tiers) {
    if (t.min === t.max) {
      if (r === t.min) return t;
      continue;
    }
    if (r >= t.min && r < t.max) return t;
  }
  // 兜底：取最高档（rate=1 且未命中独立档时）
  return tiers.length ? tiers[tiers.length - 1] : undefined;
}

export function defaultTodoTiersJson(): string {
  return JSON.stringify(DEFAULT_TODO_TIERS);
}
export function defaultExamTiersJson(): string {
  return JSON.stringify(DEFAULT_EXAM_TIERS);
}

const dayStart = (d: string) => (d ? `${d.slice(0, 10)} 00:00:00` : "");
const dayEnd = (d: string) => (d ? `${d.slice(0, 10)} 23:59:59` : "");
const dateOf = (ts: string) => (ts || "").slice(0, 10);
const nowStr = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 展开重复规则（每日/每周）→ 计划行；游标 last_expanded_date 幂等。 */
export function expandRecurrences(ctx: WorkerTaskCtx): number {
  const today = formatLocalDate(ctx.now);
  const kb = openKb(ctx.dataDir, ctx.parentId, ctx.childId);
  try {
    const rows = kb
      .prepare("SELECT * FROM plan_recurrences WHERE enabled = 1 AND (last_expanded_date = '' OR last_expanded_date < ?)")
      .all(today) as Array<Record<string, unknown>>;
    let created = 0;
    for (const r of rows) {
      const startDate = String(r.start_date || today);
      const endDate = String(r.end_date || "");
      if (today < startDate) continue;
      if (endDate && today > endDate) {
        kb.prepare("UPDATE plan_recurrences SET enabled = 0, updated_at = ? WHERE id = ?").run(nowStr(ctx.now), String(r.id));
        continue;
      }
      const rule = String(r.rule || "daily");
      const weekday = r.weekday == null ? null : Number(r.weekday);
      const dow = ctx.now.getDay();
      const hit = rule === "daily" ? true : rule === "weekly" ? weekday === dow : false;
      if (hit) {
        const payload = (() => {
          try {
            return JSON.parse(String(r.payload_json || "{}")) as Record<string, unknown>;
          } catch {
            return {};
          }
        })();
        const planType = String(r.plan_type || "life");
        const title = String(payload.title ?? "（未命名）");
        const id = randomUUID();
        const ts = nowStr(ctx.now);
        if (planType === "life") {
          kb.prepare(
            `INSERT INTO life_plans (id,parent_id,child_id,title,creator,origin,recurrence_id,start_at,due_at,status,result,done_at,
              task_type,count_in_rate,points,active,created_at,updated_at)
             VALUES (?,?,?,?,?,'recurrence',?,?,?,'pending','','',?,?,?,1,?,?)`
          ).run(
            id, ctx.parentId, ctx.childId, title, String(payload.creator || "parent"), String(r.id),
            dayStart(today), dayEnd(today),
            String(payload.task_type || "required"), Number(payload.count_in_rate ?? 1), Number(payload.points || 0), ts, ts
          );
        } else if (planType === "study") {
          kb.prepare(
            `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,recurrence_id,
              start_at,due_at,status,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,'recurrence','',?,?,?,'pending','','',?,?,?,1,?,?)`
          ).run(
            id, ctx.parentId, ctx.childId, String(payload.topic_key || ""), String(payload.course_uuid || ""),
            String(payload.course_name || title), String(payload.mode || "new"), String(payload.creator || "parent"), String(r.id),
            dayStart(today), dayEnd(today),
            String(payload.task_type || "required"), Number(payload.count_in_rate ?? 1), Number(payload.points || 0), ts, ts
          );
        } else {
          continue; // exam 重复暂不展开（考核由排期/固定档承担）
        }
        created++;
      }
      kb.prepare("UPDATE plan_recurrences SET last_expanded_date = ?, updated_at = ? WHERE id = ?").run(today, nowStr(ctx.now), String(r.id));
    }
    return created;
  } finally {
    kb.close();
  }
}

/** 三域判定：学习（courses 学习时间落在窗口）/ 生活（daily 证据）→ done。返回判定条数。 */
function applySignals(ctx: WorkerTaskCtx, kb: DatabaseSync, today: string): number {
  let n = 0;
  const now = nowStr(ctx.now);

  // ---------- 学习域 ----------
  const courses = kb
    .prepare("SELECT topic, title, last_review AS learned_at FROM courses WHERE last_review != ''")
    .all() as Array<{ topic: string; title: string; learned_at: string | null }>;
  const studyPlans = kb
    .prepare("SELECT id, topic_key, course_uuid, course_name, start_at, due_at FROM study_plans WHERE status = 'pending' AND active = 1")
    .all() as Array<{ id: string; topic_key: string; course_uuid: string; course_name: string; start_at: string; due_at: string }>;
  const updStudy = kb.prepare("UPDATE study_plans SET status='done', done_at=?, result=?, updated_at=? WHERE id=?");
  for (const p of studyPlans) {
    const c = courses.find(
      (x) => x.title === p.course_name && (x.learned_at || "") !== ""
    );
    const learnedAt = c?.learned_at ?? "";
    if (!learnedAt) continue;
    const d = dateOf(learnedAt);
    const inWindow = (!p.start_at || d >= dateOf(p.start_at)) && (!p.due_at || d <= dateOf(p.due_at));
    if (!inWindow) continue;
    updStudy.run(`${d} 12:00:00`, "学习完成", now, p.id);
    // 回写当天 daily 学习条目的 plan_id（模糊匹配课程名；匹配不到则跳过，不造记录）
    try {
      kb.prepare(
        `UPDATE daily_entries SET plan_id = ?, plan_outcome = 'done'
         WHERE date = ? AND block = '学习' AND (plan_id IS NULL OR plan_id = '')
           AND (raw LIKE ? OR title LIKE ?)`
      ).run(p.id, d, `%${p.course_name}%`, `%${p.course_name}%`);
    } catch {
      /* 未装 daily 表则跳过 */
    }
    n++;
  }

  // ---------- 生活域（recording 证据）----------
  const evidences = kb
    .prepare("SELECT DISTINCT plan_id FROM daily_entries WHERE plan_id != '' AND plan_outcome = 'done'")
    .all() as Array<{ plan_id: string }>;
  const updLife = kb.prepare("UPDATE life_plans SET status='done', done_at=?, result=?, updated_at=? WHERE id=? AND status='pending'");
  for (const e of evidences) {
    const r = updLife.run(`${today} 12:00:00`, "生活完成（记录判定）", now, e.plan_id);
    if (r.changes > 0) n++;
  }

  return n;
}

/** 到期未完成 → missed + 复制新行到当天（carry）。cancelled 不复制。返回 (missed, carried)。 */
function expireAndCarry(ctx: WorkerTaskCtx, kb: DatabaseSync, today: string): { missed: number; carried: number } {
  const now = nowStr(ctx.now);
  const nowIso = ctx.now.toISOString();
  let missed = 0;
  let carried = 0;

  const specs: Array<{ table: string; cols: string[]; copyExtra: Record<string, unknown> }> = [
    { table: "study_plans", cols: ["topic_key", "course_uuid", "course_name", "mode", "creator", "task_type", "count_in_rate", "points"], copyExtra: {} },
    { table: "life_plans", cols: ["title", "creator", "task_type", "count_in_rate", "points"], copyExtra: {} },
    { table: "exam_plans", cols: ["title", "creator", "kind", "freq", "scope_json", "task_type", "count_in_rate", "points"], copyExtra: {} },
  ];

  for (const s of specs) {
    const rows = kb
      .prepare(`SELECT * FROM ${s.table} WHERE status = 'pending' AND active = 1 AND due_at != '' AND due_at < ?`)
      .all(now) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const id = String(r.id);
      kb.prepare(`UPDATE ${s.table} SET status='missed', updated_at=? WHERE id=?`).run(nowIso, id);
      missed++;
      // 复制新行到当天（窗口=当天；不继承原窗口）
      const newId = randomUUID();
      const colNames = s.cols.join(", ");
      const placeholders = s.cols.map(() => "?").join(", ");
      const values: Array<string | number | null> = s.cols.map((c) => {
        const v = r[c];
        return v == null ? "" : typeof v === "number" ? v : String(v);
      });
      // carry_from：study/life 两表有该列（顺延标记）；exam_plans 无此列也不 carry（考核错过后由家长重排）
      const hasCarry = s.table !== "exam_plans";
      const extraCols = hasCarry ? ", carry_from, origin" : ", origin";
      const extraVals = hasCarry ? ", ?, 'carry'" : ", 'carry'";
      kb.prepare(
        `INSERT INTO ${s.table} (id, parent_id, child_id, ${colNames}${extraCols}, start_at, due_at, status, result, done_at,
           active, created_at, updated_at)
         VALUES (?, ?, ?, ${placeholders}${extraVals}, ?, ?, 'pending', '', '', 1, ?, ?)`
      ).run(
        newId,
        ctx.parentId,
        ctx.childId,
        ...values,
        ...(hasCarry ? [id] : []),
        dayStart(today),
        dayEnd(today),
        nowIso,
        nowIso
      );
      carried++;
    }
  }
  return { missed, carried };
}

/** 考核域：把当天（及未挂接的）考核场次写入 exam_plans + exam_plan_courses。 */
function applyExamAttempts(ctx: WorkerTaskCtx, kb: DatabaseSync): number {
  const now = nowStr(ctx.now);
  const rows = ctx.mainDb
    .prepare(
      `SELECT id, title, submitted_at, score, per_question, schedule_id FROM exam_attempts
       WHERE parent_id = ? AND child_id = ? AND per_question != '[]'`
    )
    .all(ctx.parentId, ctx.childId) as Array<{
    id: string;
    title: string;
    submitted_at: string;
    score: number;
    per_question: string;
    schedule_id: string;
  }>;
  let n = 0;
  for (const a of rows) {
    const planId = a.schedule_id || `exam_${a.id}`;
    const hasPlan = kb.prepare("SELECT attempt_id FROM exam_plans WHERE id = ?").get(planId) as
      | { attempt_id?: string }
      | undefined;
    if (hasPlan?.attempt_id === a.id) continue; // 已挂接（幂等）
    if (!hasPlan) {
      kb.prepare(
        `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
           start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
         VALUES (?,?,?,?,'parent','custom','','{}','conversation','',?,?,'done',?,?,'',?,'required',1,0,1,?,?)`
      ).run(
        planId, ctx.parentId, ctx.childId, a.title || "考核",
        dayStart(a.submitted_at), dayEnd(a.submitted_at),
        a.id, a.score ?? null, a.submitted_at || now, now, now
      );
    } else {
      kb.prepare(
        "UPDATE exam_plans SET status='done', attempt_id=?, score=?, done_at=?, updated_at=? WHERE id=?"
      ).run(a.id, a.score ?? null, a.submitted_at || now, now, planId);
    }
    // 逐题明细（先清后插，幂等）
    kb.prepare("DELETE FROM exam_plan_courses WHERE plan_id = ?").run(planId);
    let pq: Array<Record<string, unknown>> = [];
    try {
      pq = JSON.parse(a.per_question) as Array<Record<string, unknown>>;
    } catch {
      pq = [];
    }
    let seq = 0;
    const ins = kb.prepare(
      `INSERT INTO exam_plan_courses (id,plan_id,course_uuid,course_name,category_id,knowledge_point_id,question_id,
        point_got,point_max,score,seq,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const q of pq) {
      ins.run(
        randomUUID(), planId, String(q.courseId ?? ""), String(q.course ?? ""), String(q.categoryId ?? ""),
        String(q.knowledgePointId ?? ""), String(q.questionId ?? ""),
        q.pointGot != null ? Number(q.pointGot) : null, q.pointMax != null ? Number(q.pointMax) : null,
        q.pointGot != null ? Number(q.pointGot) : null, seq++, now
      );
    }
    n++;
  }
  return n;
}

interface GroupStat {
  total: number;
  done: number;
  missed: number;
  optionalDone: number;
  rate: number;
}

/** 归属日统计（设计 §2.1）：done→完成那天；missed→最后一天；pending 不进分母。 */
function computeGroupStats(
  kb: DatabaseSync,
  table: string,
  owner: string,
  date: string
): GroupStat {
  const rows = kb
    .prepare(
      `SELECT status, done_at, due_at, task_type, count_in_rate FROM ${table}
       WHERE creator = ? AND active = 1 AND count_in_rate = 1
         AND ( (status='done' AND substr(done_at,1,10) = ?) OR (status='missed' AND substr(due_at,1,10) = ?) )`
    )
    .all(owner, date, date) as Array<{ status: string; done_at: string; due_at: string; task_type: string; count_in_rate: number }>;
  const required = rows.filter((r) => r.task_type !== "optional");
  const optionalDone = rows.filter((r) => r.task_type === "optional" && r.status === "done").length;
  const total = required.length;
  const done = required.filter((r) => r.status === "done").length;
  const missed = required.filter((r) => r.status === "missed").length;
  return { total, done, missed, optionalDone, rate: total ? done / total : 0 };
}

/** 考核组得分率（Σ得分/Σ满分，仅归属日=当天的已完成场次）。 */
function computeExamRate(kb: DatabaseSync, owner: string, date: string): GroupStat {
  const plans = kb
    .prepare(
      `SELECT id FROM exam_plans WHERE creator = ? AND active = 1 AND count_in_rate = 1
         AND ( (status='done' AND substr(done_at,1,10) = ?) OR (status='missed' AND substr(due_at,1,10) = ?) )`
    )
    .all(owner, date, date) as Array<{ id: string }>;
  if (!plans.length) return { total: 0, done: 0, missed: 0, optionalDone: 0, rate: 0 };
  let got = 0;
  let max = 0;
  for (const p of plans) {
    const agg = kb
      .prepare("SELECT COALESCE(SUM(point_got),0) AS g, COALESCE(SUM(point_max),0) AS m FROM exam_plan_courses WHERE plan_id = ?")
      .get(p.id) as { g: number; m: number };
    got += Number(agg?.g) || 0;
    max += Number(agg?.m) || 0;
  }
  return { total: plans.length, done: plans.length, missed: 0, optionalDone: 0, rate: max > 0 ? got / max : 0 };
}

interface SettleResult {
  earned: number;
  deducted: number;
  ledgerRows: number;
}

/** 积分结算（只结算当天，避免回溯）：档位 + 门控 + 流水（幂等）。 */
export function settleRewards(ctx: WorkerTaskCtx, kb: DatabaseSync, today: string): SettleResult {
  const cfg = loadRewardConfig(kb, ctx.childId);
  const now = nowStr(ctx.now);
  const nowIso = ctx.now.toISOString();
  const out: SettleResult = { earned: 0, deducted: 0, ledgerRows: 0 };

  // 先算两组的 todo 完成率与 exam 得分率（门控需要）
  const todoParent = computeGroupStats(kb, "study_plans", "parent", today);
  const todoParentLife = computeGroupStats(kb, "life_plans", "parent", today);
  const todoChild = computeGroupStats(kb, "study_plans", "child", today);
  const todoChildLife = computeGroupStats(kb, "life_plans", "child", today);
  const mergeTodo = (a: GroupStat, b: GroupStat): GroupStat => {
    const total = a.total + b.total;
    const done = a.done + b.done;
    return { total, done, missed: a.missed + b.missed, optionalDone: a.optionalDone + b.optionalDone, rate: total ? done / total : 0 };
  };
  const parentTodo = mergeTodo(todoParent, todoParentLife);
  const childTodo = mergeTodo(todoChild, todoChildLife);
  const parentExam = computeExamRate(kb, "parent", today);
  const childExam = computeExamRate(kb, "child", today);

  const upsertStats = kb.prepare(
    `INSERT INTO reward_daily_stats
      (child_id,date,source,owner,required_total,required_done,optional_done,missed_count,cancelled_count,rate,tier,gate_ok,points_awarded,settled_at,updated)
     VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)
     ON CONFLICT(child_id,date,source,owner) DO UPDATE SET
       required_total=excluded.required_total, required_done=excluded.required_done,
       optional_done=excluded.optional_done, missed_count=excluded.missed_count,
       rate=excluded.rate, tier=excluded.tier, gate_ok=excluded.gate_ok,
       points_awarded=excluded.points_awarded, settled_at=excluded.settled_at, updated=excluded.updated`
  );
  const insertLedger = kb.prepare(
    `INSERT OR IGNORE INTO points_ledger
      (id,child_id,ts,biz_date,type,amount,balance_after,reason_code,reason,rate,meta_json,source_table,source_id,operator,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'reward_daily_stats',?,'system',?)`
  );
  const balanceOf = () => {
    const r = kb
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN type='earn' THEN amount WHEN type IN ('deduct') THEN -amount ELSE -amount END),0) AS b FROM points_ledger WHERE child_id = ?"
      )
      .get(ctx.childId) as { b: number };
    return Number(r?.b) || 0;
  };

  const applyGroup = (
    source: "todo" | "exam",
    owner: "parent" | "child",
    stat: GroupStat,
    tiers: Tier[],
    gateOk: boolean | null,
    gateReason: string
  ) => {
    if (!stat.total) return; // 该组当天没有归属项 → 不结算
    const tier = matchTier(tiers, stat.rate);
    let points = tier ? tier.points : 0;
    let effectiveGate: boolean | null = null;
    if (owner === "child") {
      effectiveGate = gateOk;
      if (cfg.childNoDeduct && points < 0) points = 0; // 加分项永不扣分
      if (!gateOk) points = 0; // 门控未开 → 不加分
    }
    upsertStats.run(
      ctx.childId, today, source, owner, stat.total, stat.done, stat.optionalDone, stat.missed,
      stat.rate, tier?.label ?? "", effectiveGate === null ? null : effectiveGate ? 1 : 0,
      points, nowIso, nowIso
    );
    if (points === 0) return; // 无变动 → 不写流水
    const type = points > 0 ? "earn" : "deduct";
    const reason =
      `${owner === "parent" ? "必须完成项" : "加分项"}·${source === "todo" ? "计划完成率" : "考核得分率"} ${(stat.rate * 100).toFixed(0)}%` +
      `，命中「${tier?.label ?? ""}」档 ${points > 0 ? "+" : ""}${points}` +
      (owner === "child" && gateOk ? "（门控已开）" : "");
    // 幂等：唯一索引 (child_id,biz_date,type,source_table,source_id) 保证只插一次；
    // 未真正插入（复跑）时不计入本次结算结果、也不动余额。
    const res = insertLedger.run(
      randomUUID(), ctx.childId, now, today, type, Math.abs(points), balanceOf() + points,
      owner === "parent" ? (points > 0 ? `${source}_award` : `${source}_deduct`) : `${source}_award`,
      reason, stat.rate,
      JSON.stringify({ tier, owner, counts: { total: stat.total, done: stat.done, missed: stat.missed }, gate: effectiveGate, gateReason }),
      `${today}|${source}|${owner}`, nowIso
    );
    if (res.changes === 0) return; // 已结算过 → 不再累加
    out.ledgerRows++;
    if (points > 0) out.earned += points;
    else out.deducted += Math.abs(points);
  };

  // 家长组（必须完成项）：达标加分、不合格扣分
  applyGroup("todo", "parent", parentTodo, cfg.todoTiers, null, "");
  applyGroup("exam", "parent", parentExam, cfg.examTiers, null, "");

  // 孩子组（加分项）：门控 = 家长组达标
  const todoGateOk = parentTodo.total > 0 && parentTodo.rate >= cfg.todoGateParentMinRate;
  const examGateOk = parentExam.total > 0 && parentExam.rate >= cfg.examGateParentMinScore;
  applyGroup(
    "todo", "child", childTodo, cfg.todoTiers, todoGateOk,
    todoGateOk ? "" : `必须完成项完成率未达 ${(cfg.todoGateParentMinRate * 100).toFixed(0)}%`
  );
  applyGroup(
    "exam", "child", childExam, cfg.examTiers, examGateOk,
    examGateOk ? "" : `必须完成项得分率未达 ${(cfg.examGateParentMinScore * 100).toFixed(0)}%`
  );

  // 余额真源 = 流水（每次结算后重算，避免增量漂移）
  const finalBalance = balanceOf();
  kb.prepare(
    "INSERT INTO points_balance (child_id, balance, updated) VALUES (?,?,?) ON CONFLICT(child_id) DO UPDATE SET balance=excluded.balance, updated=excluded.updated"
  ).run(ctx.childId, finalBalance, nowIso);

  return out;
}

/** stat tick 主入口：判定 → 到期 carry → 统计 → 积分结算。 */
export function runPlanStat(ctx: WorkerTaskCtx): {
  signals: number;
  exams: number;
  missed: number;
  carried: number;
  stats: number;
  reward: SettleResult;
} {
  const today = formatLocalDate(ctx.now);
  const kb = openKb(ctx.dataDir, ctx.parentId, ctx.childId);
  try {
    const signals = applySignals(ctx, kb, today);
    const exams = applyExamAttempts(ctx, kb);
    const { missed, carried } = expireAndCarry(ctx, kb, today);
    const reward = settleRewards(ctx, kb, today);
    const stats = (kb.prepare("SELECT COUNT(*) AS c FROM reward_daily_stats WHERE date = ?").get(today) as { c: number }).c;
    return { signals, exams, missed, carried, stats, reward };
  } finally {
    kb.close();
  }
}
