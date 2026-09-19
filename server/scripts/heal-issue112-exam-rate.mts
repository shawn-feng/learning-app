/**
 * ISSUE-112 存量治愈（2026-09-19）：考核得分率被记 0%。
 *
 * 根因：2026-09-14 考核 v2 起，提交路由（routes/exam.ts）先行置 exam_plans.done + attempt_id，
 * worker applyExamAttempts 仅凭 attempt_id 判重 → 逐题明细（exam_plan_courses）从未回填 →
 * computeExamRate 分母 0 → 得分率恒 0%，命中「不合格」档误扣分。
 *
 * 本脚本（幂等，可复跑）：
 *   A. 回填明细：attempt_id 已设但 exam_plan_courses 为空的计划，从主库 exam_attempts.per_question
 *      重放 worker 的逐题写入；
 *   B. 重算已结算的 exam 统计/流水：对 reward_daily_stats(source='exam', tier!='') 且已落流水的
 *      归属日，按修复后口径（courses 明细，缺失时回退 per_question 求和）重算 rate → 重新评档 →
 *      原地修正 stats 行与 points_ledger 行，并重算 balance_after 链与 points_balance。
 *      与 settleGroup 同口径：points=0 不留流水行（错误扣分行删除）。
 *
 * 用法：node ../node_modules/tsx/dist/cli.mts heal-issue112-exam-rate.mts <dataDir> [--dry-run]
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.js";
import { openKb } from "../src/db/kb.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dataDir = args.filter((a) => !a.startsWith("--"))[0] ?? "";
if (!dataDir || !fs.existsSync(dataDir)) {
  console.error("用法：tsx heal-issue112-exam-rate.mts <dataDir> [--dry-run]");
  process.exit(1);
}

interface Tier { min: number; max: number; label: string; points: number }

const DEFAULT_EXAM_TIERS: Tier[] = [
  { min: 0, max: 0.8, label: "不合格", points: -15 },
  { min: 0.8, max: 0.9, label: "合格", points: 0 },
  { min: 0.9, max: 1.0, label: "良好", points: 10 },
  { min: 1.0, max: 1.0, label: "优秀", points: 20 },
];

function matchTier(tiers: Tier[], rate: number): Tier | undefined {
  const r = Math.max(0, Math.min(1, rate));
  for (const t of tiers) {
    if (t.min === t.max) {
      if (r === t.min) return t;
      continue;
    }
    if (r >= t.min && r < t.max) return t;
  }
  return tiers.length ? tiers[tiers.length - 1] : undefined;
}

function parseTiers(raw: string | null | undefined): Tier[] {
  try {
    const a = JSON.parse(raw || "[]") as Tier[];
    if (!Array.isArray(a) || !a.length) return DEFAULT_EXAM_TIERS;
    return a
      .filter((t) => t && typeof t.min === "number" && typeof t.max === "number")
      .map((t) => ({ min: Number(t.min), max: Number(t.max), label: String(t.label ?? ""), points: Number(t.points) || 0 }));
  } catch {
    return DEFAULT_EXAM_TIERS;
  }
}

function perQuestionSums(mainDb: DatabaseSync, attemptId: string | null | undefined): { g: number; m: number } {
  if (!attemptId) return { g: 0, m: 0 };
  const row = mainDb.prepare("SELECT per_question FROM exam_attempts WHERE id = ?").get(attemptId) as
    | { per_question?: string }
    | undefined;
  if (!row?.per_question) return { g: 0, m: 0 };
  let pq: Array<Record<string, unknown>> = [];
  try {
    pq = JSON.parse(row.per_question) as Array<Record<string, unknown>>;
  } catch {
    return { g: 0, m: 0 };
  }
  let g = 0;
  let m = 0;
  for (const q of pq) {
    g += Number(q.pointGot) || 0;
    m += Number(q.pointMax) || 0;
  }
  return { g, m };
}

const mainDb = openDb(dataDir);
try {
  const children = mainDb.prepare("SELECT id, parent_id, name FROM children").all() as Array<{
    id: string; parent_id: string; name: string;
  }>;
  console.log(`children: ${children.length}`);

  for (const child of children) {
    let kb: DatabaseSync;
    try {
      kb = openKb(dataDir, child.parent_id, child.id);
    } catch (e) {
      console.log(`[${child.name}] 跳过（kb 打开失败：${String((e as Error).message || e)}）`);
      continue;
    }
    try {
      console.log(`\n===== ${child.name} (${child.id}) =====`);

      // ---- A. 回填逐题明细 ----
      const plans = kb
        .prepare(
          `SELECT id, attempt_id, updated_at FROM exam_plans
           WHERE active = 1 AND attempt_id != '' AND status = 'done'
             AND NOT EXISTS (SELECT 1 FROM exam_plan_courses WHERE plan_id = exam_plans.id)`
        )
        .all() as Array<{ id: string; attempt_id: string; updated_at: string }>;
      const nowIso = new Date().toISOString();
      const insCourse = kb.prepare(
        `INSERT INTO exam_plan_courses (id,plan_id,course_uuid,course_name,knowledge_point_id,question_id,
          point_got,point_max,score,seq,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      );
      let backfilled = 0;
      for (const p of plans) {
        const row = mainDb.prepare("SELECT per_question FROM exam_attempts WHERE id = ?").get(p.attempt_id) as
          | { per_question?: string }
          | undefined;
        let pq: Array<Record<string, unknown>> = [];
        try {
          pq = row?.per_question ? (JSON.parse(row.per_question) as Array<Record<string, unknown>>) : [];
        } catch {
          pq = [];
        }
        if (!pq.length) {
          console.log(`  [skip] ${p.id} attempt ${p.attempt_id} per_question 为空（无明细可回填）`);
          continue;
        }
        if (!dryRun) {
          kb.prepare("DELETE FROM exam_plan_courses WHERE plan_id = ?").run(p.id);
          let seq = 0;
          for (const q of pq) {
            insCourse.run(
              randomUUID(), p.id, String(q.courseId ?? ""), String(q.course ?? ""),
              String(q.knowledgePointId ?? ""), String(q.questionId ?? ""),
              q.pointGot != null ? Number(q.pointGot) : null, q.pointMax != null ? Number(q.pointMax) : null,
              q.pointGot != null ? Number(q.pointGot) : null, seq++, nowIso
            );
          }
        }
        backfilled++;
      }
      console.log(`A. 明细回填：${backfilled}/${plans.length} 个计划${dryRun ? "（dry-run 未写入）" : ""}`);

      // ---- B. 重算已结算的 exam 统计 + 流水 ----
      const cfg = kb.prepare("SELECT exam_tiers_json, exam_gate_parent_min_score, child_no_deduct FROM reward_configs WHERE child_id = ?").get(child.id) as
        | { exam_tiers_json?: string; exam_gate_parent_min_score?: number; child_no_deduct?: number }
        | undefined;
      const tiers = parseTiers(cfg?.exam_tiers_json);
      const gateMin = Number(cfg?.exam_gate_parent_min_score ?? 0.9);
      const childNoDeduct = Number(cfg?.child_no_deduct ?? 0) === 1;

      const settled = kb
        .prepare(
          `SELECT date, owner, required_total, required_done, rate, tier, points_awarded, gate_ok
           FROM reward_daily_stats WHERE source = 'exam' AND tier != '' ORDER BY date`
        )
        .all() as Array<{
        date: string; owner: "parent" | "child"; required_total: number; required_done: number;
        rate: number; tier: string; points_awarded: number; gate_ok: number | null;
      }>;
      if (!settled.length) {
        console.log("B. 无已结算 exam 统计行，跳过重算");
        continue;
      }

      // 重算某 owner 某日得分率（修复后口径：courses 明细，m=0 时回退 per_question 求和）
      const examRate = (owner: "parent" | "child", date: string) => {
        const hits = kb
          .prepare(
            `SELECT id, attempt_id FROM exam_plans WHERE creator = ? AND active = 1 AND count_in_rate = 1
             AND ( (status='done' AND substr(done_at,1,10) = ?) OR (status='missed' AND substr(due_at,1,10) = ?) )`
          )
          .all(owner, date, date) as Array<{ id: string; attempt_id: string | null }>;
        let got = 0;
        let max = 0;
        for (const p of hits) {
          const agg = kb
            .prepare("SELECT COALESCE(SUM(point_got),0) AS g, COALESCE(SUM(point_max),0) AS m FROM exam_plan_courses WHERE plan_id = ?")
            .get(p.id) as { g: number; m: number };
          let g = Number(agg?.g) || 0;
          let m = Number(agg?.m) || 0;
          if (m === 0) {
            const fb = perQuestionSums(mainDb, p.attempt_id);
            g = fb.g;
            m = fb.m;
          }
          got += g;
          max += m;
        }
        return { total: hits.length, rate: max > 0 ? got / max : 0 };
      };

      const updStats = kb.prepare(
        "UPDATE reward_daily_stats SET rate = ?, tier = ?, gate_ok = ?, points_awarded = ?, updated = ? WHERE date = ? AND source = 'exam' AND owner = ?"
      );
      let statsFixed = 0;
      let ledgerFixed = 0;
      let ledgerDeleted = 0;
      let ledgerInserted = 0;

      for (const s of settled) {
        const r = { rate: examRate(s.owner, s.date).rate, points: 0, tier: undefined as Tier | undefined, gateOk: null as boolean | null };
        const tier = matchTier(tiers, r.rate);
        let points = tier ? tier.points : 0;
        let gateOk: boolean | null = null;
        if (s.owner === "child") {
          // 门控与 settleGroup 同口径：parentExam.total>0 且 parentExam.rate >= gateMin
          const pExam = examRate("parent", s.date);
          gateOk = pExam.total > 0 && pExam.rate >= gateMin;
          if (childNoDeduct && points < 0) points = 0;
          if (!gateOk) points = 0;
        }
        r.points = points;
        r.tier = tier;
        r.gateOk = gateOk;

        const oldPoints = Number(s.points_awarded) || 0;
        const rateChanged = Math.abs(Number(s.rate) - r.rate) > 1e-9;
        const tierChanged = (tier?.label ?? "") !== s.tier;
        const pointsChanged = oldPoints !== points;
        if (!rateChanged && !tierChanged && !pointsChanged) continue;

        console.log(
          `  [fix] ${s.date} ${s.owner}: rate ${Number(s.rate).toFixed(4)}→${r.rate.toFixed(4)}, tier ${s.tier}→${tier?.label ?? ""}, points ${oldPoints}→${points}`
        );
        statsFixed++;
        if (!dryRun) {
          updStats.run(
            r.rate, tier?.label ?? "", gateOk === null ? null : gateOk ? 1 : 0, points, nowIso, s.date, s.owner
          );
        }

        // 流水行：唯一 source_id = `${date}|exam|${owner}`
        const sourceId = `${s.date}|exam|${s.owner}`;
        const ledger = kb
          .prepare(
            "SELECT id, type, amount, reason, reason_code, meta_json FROM points_ledger WHERE child_id = ? AND biz_date = ? AND source_table = 'reward_daily_stats' AND source_id = ?"
          )
          .get(child.id, s.date, sourceId) as
          | { id: string; type: string; amount: number; reason: string; reason_code: string; meta_json: string }
          | undefined;
        if (points === 0) {
          if (ledger) {
            console.log(`    [ledger] 删除错误流水行（重算后 0 分不动账）：${ledger.reason}`);
            ledgerDeleted++;
            if (!dryRun) kb.prepare("DELETE FROM points_ledger WHERE id = ?").run(ledger.id);
          }
          continue;
        }
        const type = points > 0 ? "earn" : "deduct";
        const reason =
          `${s.owner === "parent" ? "必须完成项" : "加分项"}·考核得分率 ${(r.rate * 100).toFixed(0)}%` +
          `，命中「${tier?.label ?? ""}」档 ${points > 0 ? "+" : ""}${points}` +
          (s.owner === "child" && gateOk ? "（门控已开）" : "");
        if (!ledger) {
          console.log(`    [ledger] 补插缺失流水行：${reason}`);
          ledgerInserted++;
          if (!dryRun) {
            kb.prepare(
              `INSERT INTO points_ledger (id,child_id,ts,biz_date,type,amount,balance_after,reason_code,reason,rate,meta_json,source_table,source_id,operator,created_at)
               VALUES (?,?,?,?,?,?,0,?,?,?,?, 'reward_daily_stats',?, 'system', ?)`
            ).run(
              randomUUID(), child.id, nowIso.replace("T", " ").slice(0, 19), s.date, type, Math.abs(points),
              s.owner === "parent" ? (points > 0 ? "exam_award" : "exam_deduct") : "exam_award",
              reason, r.rate,
              JSON.stringify({ tier, owner: s.owner, gate: gateOk, healed: "ISSUE-112" }),
              sourceId, nowIso
            );
          }
        } else {
          console.log(`    [ledger] ${ledger.type}${ledger.amount} → ${type}${Math.abs(points)}：${reason}`);
          ledgerFixed++;
          if (!dryRun) {
            let meta: Record<string, unknown> = {};
            try {
              meta = JSON.parse(ledger.meta_json || "{}") as Record<string, unknown>;
            } catch {
              meta = {};
            }
            meta.tier = tier;
            meta.healed = "ISSUE-112";
            kb.prepare(
              "UPDATE points_ledger SET type = ?, amount = ?, reason_code = ?, reason = ?, rate = ?, meta_json = ? WHERE id = ?"
            ).run(
              type, Math.abs(points),
              s.owner === "parent" ? (points > 0 ? "exam_award" : "exam_deduct") : "exam_award",
              reason, r.rate, JSON.stringify(meta), ledger.id
            );
          }
        }
      }
      console.log(
        `B. 重算：stats 修正 ${statsFixed} 行，流水 修正 ${ledgerFixed} / 删除 ${ledgerDeleted} / 补插 ${ledgerInserted}${dryRun ? "（dry-run 未写入）" : ""}`
      );

      // ---- C. 余额链重算（有变动才做）----
      if (!dryRun && (statsFixed > 0 || ledgerFixed > 0 || ledgerDeleted > 0 || ledgerInserted > 0)) {
        const rows = kb
          .prepare(
            "SELECT id, type, amount FROM points_ledger WHERE child_id = ? ORDER BY created_at, rowid"
          )
          .all(child.id) as Array<{ id: string; type: string; amount: number }>;
        let running = 0;
        const updBal = kb.prepare("UPDATE points_ledger SET balance_after = ? WHERE id = ?");
        for (const r of rows) {
          running += r.type === "earn" ? Number(r.amount) : -Number(r.amount);
          updBal.run(running, r.id);
        }
        kb.prepare(
          "INSERT INTO points_balance (child_id, balance, updated) VALUES (?,?,?) ON CONFLICT(child_id) DO UPDATE SET balance = excluded.balance, updated = excluded.updated"
        ).run(child.id, running, nowIso);
        console.log(`C. 余额重算：${running} 分（${rows.length} 行流水）`);
      }
    } finally {
      kb.close();
    }
  }
  console.log(`\n${dryRun ? "[DRY-RUN] 完成（未写入）" : "完成"}`);
} finally {
  mainDb.close();
}
