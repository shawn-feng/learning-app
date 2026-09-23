/**
 * 计划域 + 积分域 worker（2026-09-10 重构，设计见 DESIGN-plan-domain-rewrite / DESIGN-reward-points）。
 *
 * 职责（取代旧的 todo_gen / todo_stat / carry 三件套）：
 *   1) expandRecurrences：把 plan_recurrences 命中今天的规则展开成计划行（三表之一，origin=recurrence，幂等）
 *   2) runPlanStat：三域判定 + 到期 carry + 归属日统计 + 积分结算
 *      - 学习域：daily 学习记录（标题=课程名、记录日落在计划窗口内）→ study_plans.done（并回写当天 daily 学习条目的 plan_id）
 *      - 考核域（ISSUE-135 P0-a 起）：结果由提交路由直写孩子库三层，worker 只做单库幂等兜底（见 applyExamAttempts）
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
import { openParentLib } from "../db/parent-lib.js";
import { upsertMistake, examMistakeSynced } from "../db/mistakes.js";
import type { WorkerTaskCtx } from "./tasks.js";
import { formatLocalDate } from "./kb-tools.js";
import { logWarn } from "../log.js";

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
  // ISSUE-123：课程库 title 集合（study 重复规则展开时校验课程名；家长库不可用 → null = 跳过校验按旧行为）
  let courseTitles: Set<string> | null = null;
  try {
    const pdb = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      courseTitles = new Set(
        (pdb.prepare("SELECT title FROM courses").all() as Array<{ title: string }>)
          .map((r) => (r.title || "").trim())
          .filter(Boolean)
      );
    } finally {
      pdb.close();
    }
  } catch {
    /* 家长库不可用：不校验 */
  }
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
          created++;
        } else if (planType === "study") {
          const courseName = String(payload.course_name || title);
          // ISSUE-123：课程已不在课程库的计划永远无法被 daily 学习记录按 course_name 匹配完成
          // → 跳过不展开（游标照常推进避免每天重复告警；规则如已失效请删除后重建）。
          if (courseTitles && courseTitles.size > 0 && !courseTitles.has(courseName)) {
            console.warn(
              `[worker:plan] recurrence ${String(r.id).slice(0, 12)}: 课程「${courseName}」已不在课程库，今日跳过展开`
            );
          } else {
            kb.prepare(
              `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,recurrence_id,
                start_at,due_at,status,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,'recurrence','',?,?,?,'pending','','',?,?,?,1,?,?)`
            ).run(
              id, ctx.parentId, ctx.childId, String(payload.topic_key || ""), String(payload.course_uuid || ""),
              courseName, String(payload.mode || "new"), String(payload.creator || "parent"), String(r.id),
              dayStart(today), dayEnd(today),
              String(payload.task_type || "required"), Number(payload.count_in_rate ?? 1), Number(payload.points || 0), ts, ts
            );
            created++;
          }
        } else {
          continue; // exam 重复暂不展开（考核由排期/固定档承担）
        }
      }
      kb.prepare("UPDATE plan_recurrences SET last_expanded_date = ?, updated_at = ? WHERE id = ?").run(today, nowStr(ctx.now), String(r.id));
    }
    return created;
  } finally {
    kb.close();
  }
}

/** 三域判定：学习（daily 学习记录落在窗口）/ 生活（daily 证据）→ done。返回判定条数。 */
function applySignals(ctx: WorkerTaskCtx, kb: DatabaseSync, today: string): number {
  let n = 0;
  const now = nowStr(ctx.now);

  // ---------- 学习域 ----------
  // 2026-09-11 起：完成信号 = daily 学习记录，不再读 courses（后者是旧口径、且 last_review 无确定性写入方）。
  // 判定条件：daily 学习条目的标题 == 课程名，且记录日 date 落在计划的 [start_at, due_at] 窗口内。
  let dailyLearning: Array<{ title: string; date: string }> = [];
  try {
    dailyLearning = kb
      .prepare("SELECT title, date FROM daily_entries WHERE block = '学习'")
      .all() as Array<{ title: string; date: string }>;
  } catch {
    /* daily 表缺失则学习域不判定 */
  }
  const learnedDatesByCourse = new Map<string, Set<string>>();
  for (const r of dailyLearning) {
    const t = String(r.title ?? "");
    if (!t) continue;
    let set = learnedDatesByCourse.get(t);
    if (!set) {
      set = new Set();
      learnedDatesByCourse.set(t, set);
    }
    set.add(String(r.date ?? ""));
  }
  const studyPlans = kb
    .prepare("SELECT id, topic_key, course_uuid, course_name, start_at, due_at FROM study_plans WHERE status = 'pending' AND active = 1")
    .all() as Array<{ id: string; topic_key: string; course_uuid: string; course_name: string; start_at: string; due_at: string }>;
  const updStudy = kb.prepare("UPDATE study_plans SET status='done', done_at=?, result=?, updated_at=? WHERE id=?");
  const updDaily = kb.prepare(
    "UPDATE daily_entries SET plan_id = ?, plan_outcome = 'done' WHERE date = ? AND block = '学习' AND (plan_id IS NULL OR plan_id = '') AND title = ?"
  );
  for (const p of studyPlans) {
    const dates = learnedDatesByCourse.get(p.course_name);
    if (!dates) continue;
    const d = [...dates].find(
      (x) => (!p.start_at || x >= dateOf(p.start_at)) && (!p.due_at || x <= dateOf(p.due_at))
    );
    if (!d) continue;
    updStudy.run(`${d} 12:00:00`, "学习完成", now, p.id);
    // 回写当天 daily 学习条目的 plan_id（标题精确等于课程名；匹配不到则跳过，不造记录）
    try {
      updDaily.run(p.id, d, p.course_name);
    } catch {
      /* 未装 daily 表则跳过 */
    }
    n++;
  }

  // ---------- 生活域（recording 证据）----------
  // ISSUE-099 RC1 兜底：AI 偶尔把 planId/planOutcome 退化成 raw 正文行（如「- planId：…」「- planOutcome：done」），
  // 结构化列为空 → 完成判定看不见。此处从 raw 回捞并把结构化列补写回去
  // （幂等：仅当解析结果与现有列不一致时更新；同时治愈历史脏数据行）。
  try {
    // daily_entries 主键是复合键 (date, block, title)，无 id 列（ISSUE-099 实测）
    const rawRows = kb
      .prepare(
        "SELECT date, block, title, raw, plan_id, plan_outcome FROM daily_entries WHERE raw LIKE '%planOutcome%' OR raw LIKE '%plan_outcome%' OR raw LIKE '%planId%' OR raw LIKE '%plan_id%'"
      )
      .all() as Array<{ date: string; block: string; title: string; raw: string; plan_id: string; plan_outcome: string }>;
    const fixDaily = kb.prepare("UPDATE daily_entries SET plan_id = ?, plan_outcome = ? WHERE date = ? AND block = ? AND title = ?");
    for (const r of rawRows) {
      const mId = r.raw.match(/plan_?id\s*[:：]\s*([0-9a-fA-F-]{16,})/i);
      const mOut = r.raw.match(/plan_?outcome\s*[:：]\s*(done|missed|unknown)/i);
      if (!mId && !mOut) continue;
      const pid = (mId?.[1] ?? r.plan_id ?? "").trim();
      const pout = (mOut?.[1] ?? r.plan_outcome ?? "").trim();
      if ((pid && pid !== r.plan_id) || (pout && pout !== r.plan_outcome)) {
        fixDaily.run(pid, pout, r.date, r.block, r.title);
      }
    }
  } catch {
    /* daily 表缺失则跳过兜底 */
  }
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

/** 到期未完成 → missed + 复制新行到当天（carry）。cancelled 不复制。返回 (missed, carried)。
 *  考核计划（exam_plans）只判 missed、**不顺延**——考核错过后由家长重排（2026-09-11 拍板；
 *  此前 specs 误含 exam_plans 导致考核也被顺延，已修正）。 */
function expireAndCarry(ctx: WorkerTaskCtx, kb: DatabaseSync, today: string): { missed: number; carried: number } {
  const now = nowStr(ctx.now);
  const nowIso = ctx.now.toISOString();
  let missed = 0;
  let carried = 0;

  const specs: Array<{ table: string; cols: string[] }> = [
    { table: "study_plans", cols: ["topic_key", "course_uuid", "course_name", "mode", "creator", "task_type", "count_in_rate", "points"] },
    { table: "life_plans", cols: ["title", "creator", "task_type", "count_in_rate", "points"] },
  ];

  for (const s of specs) {
    const rows = kb
      .prepare(`SELECT * FROM ${s.table} WHERE status = 'pending' AND active = 1 AND due_at != '' AND due_at < ?`)
      .all(now) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const id = String(r.id);
      kb.prepare(`UPDATE ${s.table} SET status='missed', updated_at=? WHERE id=?`).run(nowIso, id);
      missed++;
      // 复制新行到当天（窗口=当天；不继承原窗口）。carry_from=原行 id（溯源）；origin='carry' 供「顺延」过滤。
      const newId = randomUUID();
      const colNames = s.cols.join(", ");
      const placeholders = s.cols.map(() => "?").join(", ");
      const values: Array<string | number | null> = s.cols.map((c) => {
        const v = r[c];
        return v == null ? "" : typeof v === "number" ? v : String(v);
      });
      kb.prepare(
        `INSERT INTO ${s.table} (id, parent_id, child_id, ${colNames}, carry_from, origin, start_at, due_at, status, result, done_at,
           active, created_at, updated_at)
         VALUES (?, ?, ?, ${placeholders}, ?, 'carry', ?, ?, 'pending', '', '', 1, ?, ?)`
      ).run(
        newId,
        ctx.parentId,
        ctx.childId,
        ...values,
        id,
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

/**
 * 考核域**幂等兜底**（ISSUE-135 P0-a 收窄）：提交路由（routes/exam.ts）已把结果直写孩子库三层，
 * 这里只补两种残缺状态，且**只读孩子库**（不再跨主库 exam_attempts —— 该表已废弃）：
 *   ① 计划已 done 且逐题明细在，但 exam_course_results 缺行（写概要及时崩溃）→ 按明细补概要；
 *   ② 计划有明细/概要却没被置 done（写 done 前失败）→ 补 done。
 * 补记一律 `DO NOTHING`，绝不覆盖路由已写好的数据（含 LLM 润色过的 course_summary）。
 */
function applyExamAttempts(ctx: WorkerTaskCtx, kb: DatabaseSync): number {
  const now = nowStr(ctx.now);
  const plans = kb
    .prepare(
      `SELECT id, attempt_id, done_at FROM exam_plans
        WHERE child_id = ? AND active = 1
          AND EXISTS (SELECT 1 FROM exam_plan_courses ec WHERE ec.plan_id = exam_plans.id)`
    )
    .all(ctx.childId) as Array<{ id: string; attempt_id: string; done_at: string }>;
  let repaired = 0;
  const ins = kb.prepare(
    `INSERT INTO exam_course_results (id,parent_id,child_id,plan_id,attempt_ref,topic_key,course_uuid,course_name,
       exam_at,point_got,point_max,rate,question_count,course_summary,plan_review_at,focus_json,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'','[]',?,?)
     ON CONFLICT(plan_id, course_uuid) DO NOTHING`
  );
  for (const p of plans) {
    let touched = false;
    if (String(p.done_at ?? "") === "") {
      kb.prepare("UPDATE exam_plans SET status='done', done_at=?, updated_at=? WHERE id=?").run(now, now, p.id);
      touched = true;
    }
    const rows = kb
      .prepare("SELECT course_uuid, course_name, point_got, point_max FROM exam_plan_courses WHERE plan_id = ?")
      .all(p.id) as Array<{ course_uuid: string; course_name: string; point_got: number | null; point_max: number | null }>;
    const byCourse = new Map<string, { uuid: string; name: string; topicKey: string; got: number; max: number; count: number }>();
    for (const r of rows) {
      const key = String(r.course_uuid ?? "") || `name:${String(r.course_name ?? "")}`;
      let e = byCourse.get(key);
      if (!e) {
        const tk = kb.prepare("SELECT topic_key FROM courses WHERE title = ?").get(String(r.course_name ?? "")) as
          | { topic_key?: string }
          | undefined;
        e = { uuid: key, name: String(r.course_name ?? ""), topicKey: String(tk?.topic_key ?? ""), got: 0, max: 0, count: 0 };
        byCourse.set(key, e);
      }
      e.got += Number(r.point_got) || 0;
      e.max += Number(r.point_max) || 0;
      e.count += 1;
    }
    const examAt = String(p.done_at ?? "") || now;
    for (const e of byCourse.values()) {
      const exist = kb
        .prepare("SELECT 1 FROM exam_course_results WHERE plan_id = ? AND course_uuid = ?")
        .get(p.id, e.uuid);
      if (exist) continue;
      const rate = e.max > 0 ? e.got / e.max : null;
      ins.run(
        randomUUID(),
        ctx.parentId,
        ctx.childId,
        p.id,
        String(p.attempt_id ?? ""),
        e.topicKey,
        e.uuid,
        e.name,
        examAt,
        e.got,
        e.max,
        rate,
        e.count,
        `本次「${e.name || "未分课程"}」考了 ${e.count} 题，得 ${Math.round(e.got * 10) / 10}/${Math.round(e.max * 10) / 10} 分。`,
        now,
        now
      );
      touched = true;
    }
    if (touched) repaired++;
  }
  return repaired;
}

interface GroupStat {
  total: number;
  done: number;
  missed: number;
  optionalDone: number;
  rate: number;
}

/**
 * 归属日统计（2026-09-10 收口修正——窗口覆盖口径）：
 * 分母 = 当天窗口覆盖的全部 count_in_rate 行（done/missed/pending 都算），
 * rate = done / 分母。此前口径只数 done+missed、pending 不进分母，
 * 导致白天 stat tick 结算时分母=已完成数 → rate 恒 100% 提前发满档分。
 * （跨天场景：done 行无论哪天完成都算当窗口日的完成；missed 行由 expireAndCarry 在到期日落定。）
 */
function computeGroupStats(
  kb: DatabaseSync,
  table: string,
  owner: string,
  date: string
): GroupStat {
  const rows = kb
    .prepare(
      `SELECT status, task_type, count_in_rate FROM ${table}
       WHERE creator = ? AND active = 1 AND count_in_rate = 1
         AND (start_at = '' OR substr(start_at,1,10) <= ?)
         AND (due_at  = '' OR substr(due_at,1,10)  >= ?)`
    )
    .all(owner, date, date) as Array<{ status: string; task_type: string; count_in_rate: number }>;
  const required = rows.filter((r) => r.task_type !== "optional");
  const optionalDone = rows.filter((r) => r.task_type === "optional" && r.status === "done").length;
  const total = required.length;
  const done = required.filter((r) => r.status === "done").length;
  const missed = required.filter((r) => r.status === "missed").length;
  return { total, done, missed, optionalDone, rate: total ? done / total : 0 };
}

/** 考核组得分率（Σ得分/Σ满分，仅归属日=当天的已完成场次）。
 *  ISSUE-135 P0-a：数据源全部在孩子库 —— 优先读课程概要 exam_course_results（一行一课的 Σgot/Σmax），
 *  该表缺行（写概要及时崩溃）时回退逐题明细 exam_plan_courses 求和；两者都在同一文件，无需跨库兜底。
 *  口径保住 ISSUE-112 的教训：分母为 0 时不再让得分率退化成 0% 误扣分，而是在这里如实回退求和。 */
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
      .prepare("SELECT COALESCE(SUM(point_got),0) AS g, COALESCE(SUM(point_max),0) AS m FROM exam_course_results WHERE plan_id = ?")
      .get(p.id) as { g: number; m: number };
    let g = Number(agg?.g) || 0;
    let m = Number(agg?.m) || 0;
    if (m === 0) {
      const fb = kb
        .prepare("SELECT COALESCE(SUM(point_got),0) AS g, COALESCE(SUM(point_max),0) AS m FROM exam_plan_courses WHERE plan_id = ?")
        .get(p.id) as { g: number; m: number };
      g = Number(fb?.g) || 0;
      m = Number(fb?.m) || 0;
    }
    got += g;
    max += m;
  }
  return { total: plans.length, done: plans.length, missed: 0, optionalDone: 0, rate: max > 0 ? got / max : 0 };
}

interface SettleResult {
  earned: number;
  deducted: number;
  ledgerRows: number;
}

/** 积分结算：**每天 tick 结算「上一日」**（其窗口已确定结束）——评档 + 门控 + 流水（幂等）；当天只写实时进度。
 *  设计意图：窗口未结束不发分（此前 stat tick 白天就结算，分母只含已完成行 → rate 恒 100% 提前发满档分）。
 *  2026-09-11 修复：旧实现用 `finalOk = now > dayEnd(today)` 判"当天窗口结束"，但 now 与 today 同源同日，
 *  该条件恒 false → 流水从不写入、余额恒 0。改为结算上一日后，昨天的计划行已在 expireAndCarry 全部进入
 *  终态（done/missed/cancelled），分母口径稳定；流水唯一索引保证重复 tick 不会重复发分。
 *  注：结算后家长回改昨日计划（reopen）不会重发/追回流水——结算一次性语义，如需纠错走手工调整。 */
export function settleRewards(ctx: WorkerTaskCtx, kb: DatabaseSync, today: string): SettleResult {
  const cfg = loadRewardConfig(kb, ctx.childId);
  const now = nowStr(ctx.now);
  const nowIso = ctx.now.toISOString();
  const out: SettleResult = { earned: 0, deducted: 0, ledgerRows: 0 };
  const yd = new Date(ctx.now);
  yd.setDate(yd.getDate() - 1);
  const settleDay = formatLocalDate(yd); // 日终结算日 = 昨天

  // 各组在指定归属日的统计（学习+生活合并为 todo；考核按场次归属日）
  const groupsFor = (date: string) => {
    const parentTodo = mergeTodo(
      computeGroupStats(kb, "study_plans", "parent", date),
      computeGroupStats(kb, "life_plans", "parent", date)
    );
    const childTodo = mergeTodo(
      computeGroupStats(kb, "study_plans", "child", date),
      computeGroupStats(kb, "life_plans", "child", date)
    );
    return {
      parentTodo,
      childTodo,
      parentExam: computeExamRate(kb, "parent", date),
      childExam: computeExamRate(kb, "child", date),
    };
  };
  const mergeTodo = (a: GroupStat, b: GroupStat): GroupStat => {
    const total = a.total + b.total;
    const done = a.done + b.done;
    return { total, done, missed: a.missed + b.missed, optionalDone: a.optionalDone + b.optionalDone, rate: total ? done / total : 0 };
  };

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

  /** 今天的实时进度：只写统计（rate=实时口径），不评档、不发分、不动流水。 */
  const writeLiveStats = (source: "todo" | "exam", owner: "parent" | "child", stat: GroupStat) => {
    if (!stat.total) return;
    upsertStats.run(
      ctx.childId, today, source, owner, stat.total, stat.done, stat.optionalDone, stat.missed,
      stat.rate, "", null,
      0, "", nowIso
    );
  };

  /** 某日的日终结算：评档 + 写流水（唯一索引幂等，复跑不重复发分）。 */
  const settleGroup = (
    date: string,
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
      ctx.childId, date, source, owner, stat.total, stat.done, stat.optionalDone, stat.missed,
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
      randomUUID(), ctx.childId, now, date, type, Math.abs(points), balanceOf() + points,
      owner === "parent" ? (points > 0 ? `${source}_award` : `${source}_deduct`) : `${source}_award`,
      reason, stat.rate,
      JSON.stringify({ tier, owner, counts: { total: stat.total, done: stat.done, missed: stat.missed }, gate: effectiveGate, gateReason }),
      `${date}|${source}|${owner}`, nowIso
    );
    if (res.changes === 0) return; // 已结算过 → 不再累加
    out.ledgerRows++;
    if (points > 0) out.earned += points;
    else out.deducted += Math.abs(points);
  };

  // ① 今天：实时进度（不评档、不发分）
  const live = groupsFor(today);
  writeLiveStats("todo", "parent", live.parentTodo);
  writeLiveStats("exam", "parent", live.parentExam);
  writeLiveStats("todo", "child", live.childTodo);
  writeLiveStats("exam", "child", live.childExam);

  // ② 昨天：日终结算（评档 + 门控 + 流水）
  const y = groupsFor(settleDay);
  settleGroup(settleDay, "todo", "parent", y.parentTodo, cfg.todoTiers, null, "");
  settleGroup(settleDay, "exam", "parent", y.parentExam, cfg.examTiers, null, "");

  // 孩子组（加分项）：门控 = 昨天家长组达标
  const todoGateOk = y.parentTodo.total > 0 && y.parentTodo.rate >= cfg.todoGateParentMinRate;
  const examGateOk = y.parentExam.total > 0 && y.parentExam.rate >= cfg.examGateParentMinScore;
  settleGroup(
    settleDay, "todo", "child", y.childTodo, cfg.todoTiers, todoGateOk,
    todoGateOk ? "" : `必须完成项完成率未达 ${(cfg.todoGateParentMinRate * 100).toFixed(0)}%`
  );
  settleGroup(
    settleDay, "exam", "child", y.childExam, cfg.examTiers, examGateOk,
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
