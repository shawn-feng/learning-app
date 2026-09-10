/**
 * 计划域 + 积分域：家长端接口（2026-09-10 计划域重构）。
 *
 * 数据真源：**孩子 kb** 的 study_plans / exam_plans / life_plans / reward_*（设计见
 * 根目录 DESIGN-plan-domain-rewrite-2026-09-10.md 与 DESIGN-reward-points-2026-09-10.md）。
 *
 * - GET  /api/v1/plans/today?childId=&date=      当日三域计划聚合（动态 todolist：三表窗口覆盖当天的行）
 * - POST /api/v1/plans/status                    家长审计与修正：cancel（取消）/ reopen（撤销完成）/ done（代判完成）
 * - GET  /api/v1/rewards/:childId?date=&limit=   余额 + 当日结算（含"未解锁"gate_ok）+ 流水
 * - GET  /api/v1/rewards/:childId/config         积分奖罚设置（分档 + 门控阈值）
 * - PUT  /api/v1/rewards/:childId/config         保存设置（校验区间连续覆盖 [0,1]、互不重叠）
 * - POST /api/v1/rewards/:childId/redeem         提交兑换申请（扣分写流水 reason_code='redeem'）
 *
 * 鉴权：家长 JWT + childId 归属校验。
 *
 * ⚠️ 状态写入者约定：三张计划表的 status **由 stat tick 统一写**（除考核提交路径外）。
 * 本文件的 `POST /plans/status` 是设计认可的**家长审计权**例外（§13.3：撤销虚报 / 取消计划），
 * 属于人对系统的显式修正，不是自动判定——不要把它扩展成通用的状态编辑器。
 */
import crypto, { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { openKb } from "../db/kb.js";

interface Deps {
  config: ServerConfig;
  db: DatabaseSync;
}

function authParent(req: { headers: Record<string, string | string[] | undefined> }, secret: string): string {
  const header = req.headers.authorization;
  const token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) throw new ApiError(401, "缺少 session token");
  try {
    return verifySession(token, secret).parent_id;
  } catch {
    throw new ApiError(401, "session 无效或已过期，请重新登录");
  }
}

function assertChildOwned(db: DatabaseSync, parentId: string, childId: string): void {
  const row = db.prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?").get(childId, parentId);
  if (!row) throw new ApiError(403, "无权访问该孩子的数据");
}

function handleAuthError(err: unknown, reply: any): boolean {
  if (err instanceof ApiError) {
    reply.code(err.status).send({ error: err.message });
    return true;
  }
  return false;
}

function validDate(d: unknown): d is string {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

function todayLocal(): string {
  return new Date().toLocaleDateString("sv-SE");
}

/** 默认积分设置（与 DESIGN-reward-points §九 决策汇总一致；家长可改）。 */
const DEFAULT_TODO_TIERS = [
  { min: 0, max: 0.6, label: "不合格", points: -10 },
  { min: 0.6, max: 0.8, label: "合格", points: 0 },
  { min: 0.8, max: 1.0, label: "良好", points: 10 },
  { min: 1.0, max: 1.0, label: "优秀", points: 20 },
];
const DEFAULT_EXAM_TIERS = [
  { min: 0, max: 0.8, label: "不合格", points: -15 },
  { min: 0.8, max: 0.9, label: "合格", points: 0 },
  { min: 0.9, max: 1.0, label: "良好", points: 10 },
  { min: 1.0, max: 1.0, label: "优秀", points: 20 },
];

interface Tier {
  min: number;
  max: number;
  label: string;
  points: number;
}

/** 校验分档：升序、连续覆盖 [0,1]、互不重叠；100% 可为独立闭区间档。 */
function validateTiers(raw: unknown, name: string): Tier[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ApiError(400, `${name} 必须是非空数组`);
  const tiers: Tier[] = raw.map((t) => {
    const o = t as Record<string, unknown>;
    const min = Number(o.min);
    const max = Number(o.max);
    const points = Math.round(Number(o.points) || 0);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 1 || min > max) {
      throw new ApiError(400, `${name} 区间非法（min/max 需在 0~1 且 min ≤ max）`);
    }
    return { min, max, label: String(o.label ?? ""), points };
  });
  tiers.sort((a, b) => a.min - b.min);
  const first = tiers[0]!;
  if (first.min !== 0) throw new ApiError(400, `${name} 必须从 0 开始`);
  const last = tiers[tiers.length - 1]!;
  if (last.max !== 1) throw new ApiError(400, `${name} 必须覆盖到 100%`);
  for (let i = 1; i < tiers.length; i++) {
    const prev = tiers[i - 1]!;
    const cur = tiers[i]!;
    // 左闭右开：下一档 min 必须等于上一档 max；末档用 [1,1] 闭区间单独一档
    if (Math.abs(cur.min - prev.max) > 1e-9) {
      throw new ApiError(400, `${name} 区间不连续或重叠（第 ${i} 档从 ${cur.min} 开始，上一档到 ${prev.max}）`);
    }
  }
  return tiers;
}

export function registerPlanRewardRoutes(app: FastifyInstance, deps: Deps): void {
  // ==================== 当日三域聚合（动态 todolist） ====================
  app.get("/api/v1/plans/today", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId, date } = (req.query ?? {}) as { childId?: string; date?: string };
    if (!childId) return reply.code(400).send({ error: "childId 必填" });
    if (date !== undefined && !validDate(date)) return reply.code(400).send({ error: "date 格式应为 YYYY-MM-DD" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const day = date || todayLocal();
    const kb = openKb(deps.config.dataDir ?? "", parentId, childId);
    try {
      const study = kb
        .prepare(
          `SELECT id, course_name, topic_key, mode, creator, origin, start_at, due_at, status, done_at, carry_from
             FROM study_plans WHERE active = 1
              AND (start_at = '' OR substr(start_at,1,10) <= ?) AND (due_at = '' OR substr(due_at,1,10) >= ?)
            ORDER BY due_at, created_at`
        )
        .all(day, day) as Array<Record<string, unknown>>;
      const life = kb
        .prepare(
          `SELECT id, title, creator, origin, start_at, due_at, status, done_at, carry_from, task_type, points
             FROM life_plans WHERE active = 1
              AND (start_at = '' OR substr(start_at,1,10) <= ?) AND (due_at = '' OR substr(due_at,1,10) >= ?)
            ORDER BY due_at, created_at`
        )
        .all(day, day) as Array<Record<string, unknown>>;
      const exam = kb
        .prepare(
          `SELECT id, title, creator, start_at, due_at, status, done_at, score
             FROM exam_plans WHERE active = 1
              AND (start_at = '' OR substr(start_at,1,10) <= ?) AND (due_at = '' OR substr(due_at,1,10) >= ?)
            ORDER BY due_at, created_at`
        )
        .all(day, day) as Array<Record<string, unknown>>;

      const items = [
        ...study.map((r) => ({
          planId: String(r.id),
          kind: "study" as const,
          title: String(r.course_name ?? ""),
          topicKey: String(r.topic_key ?? ""),
          mode: String(r.mode ?? "new"),
          owner: String(r.creator ?? "parent"),
          origin: String(r.origin ?? ""),
          startAt: String(r.start_at ?? ""),
          dueAt: String(r.due_at ?? ""),
          status: String(r.status ?? "pending"),
          doneAt: String(r.done_at ?? ""),
          carry: !!r.carry_from,
        })),
        ...life.map((r) => ({
          planId: String(r.id),
          kind: "life" as const,
          title: String(r.title ?? ""),
          topicKey: "",
          mode: "life",
          owner: String(r.creator ?? "parent"),
          origin: String(r.origin ?? ""),
          startAt: String(r.start_at ?? ""),
          dueAt: String(r.due_at ?? ""),
          status: String(r.status ?? "pending"),
          doneAt: String(r.done_at ?? ""),
          carry: !!r.carry_from,
          taskType: String(r.task_type ?? "required"),
          points: Number(r.points) || 0,
        })),
        ...exam.map((r) => ({
          planId: String(r.id),
          kind: "exam" as const,
          title: String(r.title ?? "考核"),
          topicKey: "",
          mode: "exam",
          owner: String(r.creator ?? "parent"),
          origin: "exam",
          startAt: String(r.start_at ?? ""),
          dueAt: String(r.due_at ?? ""),
          status: String(r.status ?? "pending"),
          doneAt: String(r.done_at ?? ""),
          carry: false,
          score: Number(r.score) || 0,
        })),
      ];
      items.sort((a, b) => (a.dueAt || "").localeCompare(b.dueAt || "") || a.title.localeCompare(b.title));
      return { ok: true, date: day, items };
    } finally {
      kb.close();
    }
  });

  // ==================== 家长审计与修正 ====================
  app.post("/api/v1/plans/status", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as {
      childId?: string;
      planId?: string;
      kind?: string;
      action?: string;
      note?: string;
    };
    const childId = String(body.childId ?? "");
    const planId = String(body.planId ?? "");
    const kind = String(body.kind ?? "");
    const action = String(body.action ?? "");
    if (!childId || !planId) return reply.code(400).send({ error: "childId / planId 必填" });
    const table =
      kind === "study" ? "study_plans" : kind === "life" ? "life_plans" : kind === "exam" ? "exam_plans" : "";
    if (!table) return reply.code(400).send({ error: "kind 仅支持 study / life / exam" });
    if (!["cancel", "reopen", "done"].includes(action)) {
      return reply.code(400).send({ error: "action 仅支持 cancel（取消计划）/ reopen（撤销判定）/ done（家长代判完成）" });
    }
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const kb = openKb(deps.config.dataDir ?? "", parentId, childId);
    try {
      const row = kb.prepare(`SELECT id, status FROM ${table} WHERE id = ?`).get(planId) as
        | { id: string; status: string }
        | undefined;
      if (!row) return reply.code(404).send({ error: "计划不存在" });
      const now = new Date().toISOString();
      const note = String(body.note ?? "");
      if (action === "cancel") {
        // 取消 = 不计分母、不再 carry（停止无限累积的唯一手段）；仅家长可操作
        kb.prepare(`UPDATE ${table} SET status = 'cancelled', result = ?, updated_at = ? WHERE id = ?`).run(
          note || "家长取消",
          now,
          planId
        );
      } else if (action === "reopen") {
        // 撤销判定（虚报纠错）：done/missed → pending；到期未过的会自然再判、已过的由 stat 再判 missed
        kb.prepare(`UPDATE ${table} SET status = 'pending', done_at = '', result = ?, updated_at = ? WHERE id = ?`).run(
          note || "家长撤销判定",
          now,
          planId
        );
      } else {
        kb.prepare(`UPDATE ${table} SET status = 'done', done_at = ?, result = ?, updated_at = ? WHERE id = ?`).run(
          now,
          note || "家长代判完成",
          now,
          planId
        );
      }
      return { ok: true, status: action === "cancel" ? "cancelled" : action === "done" ? "done" : "pending" };
    } finally {
      kb.close();
    }
  });

  // ==================== 孩子自建生活计划（2026-09-10：制定人=孩子自己） ====================
  /** POST /api/v1/plans/life —— 孩子端 agent plan_create 工具的落库入口。
   *  creator 固定 'child'（加分项，task_type=optional），单日窗口；同 title+date 已有 pending 行则跳过（防重复）。 */
  app.post("/api/v1/plans/life", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as { childId?: string; title?: string; date?: string; time?: string };
    const childId = String(body.childId ?? "");
    const title = String(body.title ?? "").trim();
    if (!childId || !title) return reply.code(400).send({ error: "childId / title 必填" });
    if (title.length > 200) return reply.code(400).send({ error: "title 过长（≤200 字）" });
    const date = String(body.date ?? "") || new Date().toLocaleDateString("sv-SE");
    if (!validDate(date)) return reply.code(400).send({ error: "date 格式应为 YYYY-MM-DD" });
    const time = String(body.time ?? "").trim();
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return reply.code(400).send({ error: "time 格式应为 HH:mm" });
    }
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const kb = openKb(deps.config.dataDir ?? "", parentId, childId);
    try {
      const dup = kb
        .prepare(
          `SELECT id FROM life_plans WHERE title = ? AND active = 1 AND status IN ('pending')
             AND substr(start_at,1,10) <= ? AND substr(due_at,1,10) >= ?`
        )
        .get(title, date, date) as { id: string } | undefined;
      if (dup) {
        return { ok: true, skipped: true, planId: dup.id, message: "同名计划当天已存在（待完成），未重复创建" };
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      kb.prepare(
        `INSERT INTO life_plans
           (id,parent_id,child_id,title,creator,origin,carry_from,recurrence_id,start_at,due_at,status,result,done_at,
            task_type,count_in_rate,points,active,created_at,updated_at)
         VALUES (?,?,?,?,'child','conversation','','',?,?, 'pending','','','optional',1,0,1,?,?)`
      ).run(id, parentId, childId, title, `${date} 00:00:00`, time ? `${date} ${time}:00` : `${date} 23:59:59`, now, now);
      return { ok: true, planId: id, date, dueAt: time ? `${date} ${time}:00` : `${date} 23:59:59` };
    } finally {
      kb.close();
    }
  });

  /** POST /api/v1/plans/exam —— 孩子端 agent plan_exam 工具的落库入口（孩子自请考核，安排而非发起）。
   *  creator 固定 'child'（加分项，task_type=optional），kind='self'；考核实际发起/评分走考核页，
   *  提交后由 worker applyExamAttempts 挂接结果（本行仅承载「哪天想考」的安排与展示）。 */
  app.post("/api/v1/plans/exam", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as { childId?: string; title?: string; date?: string };
    const childId = String(body.childId ?? "");
    const title = String(body.title ?? "").trim();
    if (!childId || !title) return reply.code(400).send({ error: "childId / title 必填" });
    if (title.length > 200) return reply.code(400).send({ error: "title 过长（≤200 字）" });
    const date = String(body.date ?? "") || new Date().toLocaleDateString("sv-SE");
    if (!validDate(date)) return reply.code(400).send({ error: "date 格式应为 YYYY-MM-DD" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const kb = openKb(deps.config.dataDir ?? "", parentId, childId);
    try {
      const dup = kb
        .prepare(
          `SELECT id FROM exam_plans WHERE title = ? AND creator = 'child' AND active = 1 AND status = 'pending'
             AND substr(start_at,1,10) <= ? AND substr(due_at,1,10) >= ?`
        )
        .get(title, date, date) as { id: string } | undefined;
      if (dup) {
        return { ok: true, skipped: true, planId: dup.id, message: "同天已有同名自请考核，未重复创建" };
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      kb.prepare(
        `INSERT INTO exam_plans
           (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,start_at,due_at,status,
            attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
         VALUES (?,?,?,?,'child','self','','{}','conversation','',?,?, 'pending','','','','', 'optional',1,0,1,?,?)`
      ).run(id, parentId, childId, title, `${date} 00:00:00`, `${date} 23:59:59`, now, now);
      return { ok: true, planId: id, date };
    } finally {
      kb.close();
    }
  });

  // ==================== 积分：读取（余额 + 当日结算 + 流水） ====================
  app.get("/api/v1/rewards/:childId", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    const { date, limit, days } = (req.query ?? {}) as { date?: string; limit?: string; days?: string };
    if (date !== undefined && !validDate(date)) return reply.code(400).send({ error: "date 格式应为 YYYY-MM-DD" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const day = date || todayLocal();
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    const kb = openKb(deps.config.dataDir ?? "", parentId, childId);
    try {
      const balRow = kb.prepare("SELECT balance FROM points_balance WHERE child_id = ?").get(childId) as
        | { balance: number }
        | undefined;
      const sum = kb
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN type='earn' THEN amount ELSE 0 END), 0) AS earned,
             COALESCE(SUM(CASE WHEN type='deduct' THEN amount ELSE 0 END), 0) AS deducted,
             COALESCE(SUM(CASE WHEN type='redeem' THEN amount ELSE 0 END), 0) AS redeemed
           FROM points_ledger WHERE child_id = ?`
        )
        .get(childId) as { earned: number; deducted: number; redeemed: number };
      const balance = Number(balRow?.balance ?? Number(sum.earned) - Number(sum.deducted) - Number(sum.redeemed));
      const stats = kb
        .prepare(
          `SELECT source, owner, required_total, required_done, optional_done, missed_count, cancelled_count,
                  rate, tier, gate_ok, points_awarded, settled_at
             FROM reward_daily_stats WHERE child_id = ? AND date = ? ORDER BY source, owner`
        )
        .all(childId, day) as Array<Record<string, unknown>>;
      const ledger = kb
        .prepare(
          `SELECT id, ts, biz_date, type, amount, balance_after, reason_code, reason, rate, meta_json, source_table, source_id, operator
             FROM points_ledger WHERE child_id = ? ORDER BY ts DESC LIMIT ?`
        )
        .all(childId, n) as Array<Record<string, unknown>>;
      // 近 N 天按日汇总（趋势图用；owner 合并、todo/exam 合并展示当日总完成率）
      const dayCount = Math.min(180, Math.max(1, Number(days) || 30));
      const recentStats = kb
        .prepare(
          `SELECT date,
                  SUM(required_total) AS total,
                  SUM(required_done)  AS done,
                  SUM(optional_done)  AS optional_done,
                  SUM(missed_count)   AS missed,
                  SUM(cancelled_count) AS cancelled,
                  SUM(points_awarded) AS points
             FROM reward_daily_stats WHERE child_id = ?
            GROUP BY date ORDER BY date DESC LIMIT ?`
        )
        .all(childId, dayCount) as Array<Record<string, unknown>>;
      // 未解锁提示（策略 A）：孩子组达标但门控未开
      const gateBlocked = stats
        .filter((s) => s.owner === "child" && Number(s.gate_ok) === 0)
        .map((s) => ({ source: String(s.source), rate: Number(s.rate) || 0, tier: String(s.tier ?? "") }));
      return {
        ok: true,
        date: day,
        balance,
        totals: { earned: Number(sum.earned), deducted: Number(sum.deducted), redeemed: Number(sum.redeemed) },
        stats: stats.map((s) => ({
          source: String(s.source),
          owner: String(s.owner),
          total: Number(s.required_total) || 0,
          done: Number(s.required_done) || 0,
          optionalDone: Number(s.optional_done) || 0,
          missed: Number(s.missed_count) || 0,
          cancelled: Number(s.cancelled_count) || 0,
          rate: Number(s.rate) || 0,
          tier: String(s.tier ?? ""),
          gateOk: s.gate_ok == null ? null : Number(s.gate_ok),
          pointsAwarded: Number(s.points_awarded) || 0,
          settledAt: String(s.settled_at ?? ""),
        })),
        gateBlocked,
        recentStats: recentStats.map((r) => {
          const total = Number(r.total) || 0;
          const done = Number(r.done) || 0;
          return {
            date: String(r.date),
            total,
            done,
            optionalDone: Number(r.optional_done) || 0,
            missed: Number(r.missed) || 0,
            cancelled: Number(r.cancelled) || 0,
            rate: total > 0 ? done / total : 0,
            points: Number(r.points) || 0,
          };
        }),
        ledger: ledger.map((l) => ({
          id: String(l.id),
          ts: String(l.ts ?? ""),
          bizDate: String(l.biz_date ?? ""),
          type: String(l.type ?? ""),
          amount: Number(l.amount) || 0,
          balanceAfter: Number(l.balance_after) || 0,
          reasonCode: String(l.reason_code ?? ""),
          reason: String(l.reason ?? ""),
          rate: l.rate == null ? null : Number(l.rate),
          meta: String(l.meta_json ?? ""),
          operator: String(l.operator ?? "system"),
        })),
      };
    } finally {
      kb.close();
    }
  });

  // ==================== 积分：设置（分档 + 门控） ====================
  app.get("/api/v1/rewards/:childId/config", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const kb = openKb(deps.config.dataDir ?? "", parentId, childId);
    try {
      const row = kb.prepare("SELECT * FROM reward_configs WHERE child_id = ?").get(childId) as
        | Record<string, unknown>
        | undefined;
      const parse = (s: unknown, fallback: Tier[]): Tier[] => {
        try {
          const arr = JSON.parse(String(s ?? "[]"));
          return Array.isArray(arr) && arr.length ? (arr as Tier[]) : fallback;
        } catch {
          return fallback;
        }
      };
      return {
        ok: true,
        config: {
          todoTiers: parse(row?.todo_tiers_json, DEFAULT_TODO_TIERS),
          examTiers: parse(row?.exam_tiers_json, DEFAULT_EXAM_TIERS),
          todoGateMinRate: row?.todo_gate_parent_min_rate == null ? 1.0 : Number(row.todo_gate_parent_min_rate),
          examGateMinScore: row?.exam_gate_parent_min_score == null ? 0.9 : Number(row.exam_gate_parent_min_score),
          childNoDeduct: row?.child_no_deduct == null ? true : Number(row.child_no_deduct) === 1,
          optionalPoints: row?.optional_points == null ? 5 : Number(row.optional_points),
        },
      };
    } finally {
      kb.close();
    }
  });

  app.put("/api/v1/rewards/:childId/config", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    // 传了哪部分就校验哪部分（支持只改门控；tiers 需整份提交）
    const kb = openKb(deps.config.dataDir ?? "", parentId, childId);
    try {
      const cur = kb.prepare("SELECT * FROM reward_configs WHERE child_id = ?").get(childId) as
        | Record<string, unknown>
        | undefined;
      const parse = (s: unknown, fallback: Tier[]): Tier[] => {
        try {
          const arr = JSON.parse(String(s ?? "[]"));
          return Array.isArray(arr) && arr.length ? (arr as Tier[]) : fallback;
        } catch {
          return fallback;
        }
      };
      const todoTiers =
        body.todoTiers === undefined ? parse(cur?.todo_tiers_json, DEFAULT_TODO_TIERS) : validateTiers(body.todoTiers, "待办分档");
      const examTiers =
        body.examTiers === undefined ? parse(cur?.exam_tiers_json, DEFAULT_EXAM_TIERS) : validateTiers(body.examTiers, "考核分档");
      const todoGate =
        body.todoGateMinRate === undefined ? Number(cur?.todo_gate_parent_min_rate ?? 1.0) : Number(body.todoGateMinRate);
      const examGate =
        body.examGateMinScore === undefined ? Number(cur?.exam_gate_parent_min_score ?? 0.9) : Number(body.examGateMinScore);
      if (!(todoGate >= 0 && todoGate <= 1) || !(examGate >= 0 && examGate <= 1)) {
        return reply.code(400).send({ error: "门控阈值需在 0~1 之间" });
      }
      const noDeduct =
        body.childNoDeduct === undefined ? (cur?.child_no_deduct == null ? 1 : Number(cur.child_no_deduct)) : body.childNoDeduct ? 1 : 0;
      const optionalPoints =
        body.optionalPoints === undefined ? Number(cur?.optional_points ?? 5) : Math.round(Number(body.optionalPoints) || 0);
      const now = new Date().toISOString();
      kb.prepare(
        `INSERT INTO reward_configs (child_id, todo_tiers_json, exam_tiers_json, todo_gate_parent_min_rate,
           exam_gate_parent_min_score, child_no_deduct, optional_points, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(child_id) DO UPDATE SET
           todo_tiers_json = excluded.todo_tiers_json,
           exam_tiers_json = excluded.exam_tiers_json,
           todo_gate_parent_min_rate = excluded.todo_gate_parent_min_rate,
           exam_gate_parent_min_score = excluded.exam_gate_parent_min_score,
           child_no_deduct = excluded.child_no_deduct,
           optional_points = excluded.optional_points,
           updated = excluded.updated`
      ).run(
        childId,
        JSON.stringify(todoTiers),
        JSON.stringify(examTiers),
        todoGate,
        examGate,
        noDeduct,
        optionalPoints,
        now
      );
      return { ok: true };
    } finally {
      kb.close();
    }
  });

  // ==================== 积分：兑换申请 ====================
  app.post("/api/v1/rewards/:childId/redeem", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as { itemId?: string; cost?: number; note?: string };
    const cost = Math.max(0, Math.round(Number(body.cost) || 0));
    if (!cost) return reply.code(400).send({ error: "cost 必填（正整数）" });
    const kb = openKb(deps.config.dataDir ?? "", parentId, childId);
    try {
      const balRow = kb.prepare("SELECT balance FROM points_balance WHERE child_id = ?").get(childId) as
        | { balance: number }
        | undefined;
      const balance = Number(balRow?.balance ?? 0);
      if (balance < cost) return reply.code(400).send({ error: `积分不足（余额 ${balance}，需要 ${cost}）` });
      const now = new Date().toISOString();
      const day = todayLocal();
      const id = crypto.randomUUID();
      kb.exec("BEGIN");
      try {
        kb.prepare(
          `INSERT INTO redemption_requests (id, child_id, item_id, custom_desc, cost, status, parent_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
        ).run(id, childId, String(body.itemId ?? ""), String(body.note ?? ""), cost, parentId, now);
        kb.prepare(
          `INSERT INTO points_ledger (id, child_id, ts, biz_date, type, amount, balance_after, reason_code, reason,
             rate, meta_json, source_table, source_id, operator, created_at)
           VALUES (?, ?, ?, ?, 'redeem', ?, ?, 'redeem', ?, NULL, ?, 'redemption_requests', ?, 'parent', ?)`
        ).run(
          crypto.randomUUID(),
          childId,
          now,
          day,
          cost,
          balance - cost,
          String(body.note ?? "兑换申请"),
          JSON.stringify({ itemId: String(body.itemId ?? ""), cost }),
          id,
          now
        );
        kb.prepare(
          `INSERT INTO points_balance (child_id, balance, updated) VALUES (?, ?, ?)
           ON CONFLICT(child_id) DO UPDATE SET balance = excluded.balance, updated = excluded.updated`
        ).run(childId, balance - cost, now);
        kb.exec("COMMIT");
      } catch (e) {
        kb.exec("ROLLBACK");
        throw e;
      }
      return { ok: true, requestId: id, balance: balance - cost };
    } finally {
      kb.close();
    }
  });
}
