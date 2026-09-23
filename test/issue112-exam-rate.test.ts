/**
 * ISSUE-112 回归（2026-09-19，2026-09-23 随 ISSUE-135 P0-a 改写口径）：计入积分的考核得分率为 0
 * （9/10 实得被记 0% 误扣分）。
 *
 * 当时的根因：提交路由先行置 exam_plans.done + attempt_id，worker 仅凭 attempt_id 判重 → 逐题明细从未回填
 * → computeExamRate 分母 0 → 得分率恒 0%（并且还依赖主库 exam_attempts.per_question 兜底）。
 *
 * ISSUE-135 P0-a 之后：结果由提交路由**直写孩子库**（persistExamResult），worker 只做单库幂等兜底，
 * 得分率优先读 exam_course_results、缺行时回退逐题明细（都在同一个孩子库文件里）。本测试守住三件事：
 * ① 路由写入 → runPlanStat 按真实得分率结算（9/10 → 90% → 良好 +10）；
 * ② 结算幂等：复跑不重复发分、不重复回填；
 * ③ 单库兜底：概要行缺失（只留明细）时仍能还原 90%，不再需要跨库读主库。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { persistExamResult } from "../server/src/exam-results";
import { runPlanStat, settleRewards } from "../server/src/worker/plan-domain";
import type { WorkerTaskCtx } from "../server/src/worker/tasks";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue112-"));
const parentId = "parent-112";
const childId = "child-112";

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL 句柄滞后，忽略 */
  }
});

const PER_QUESTION = [
  {
    qid: "q1",
    course: "论语为政篇第一章",
    question: "背诵本章原文",
    pointGot: 9,
    pointMax: 10,
    correct: false,
    assessMethod: "speech",
    questionType: "cn_recitation",
  },
];

/** 复刻提交路由的落库：结果直写孩子库三层（明细 + 概要 + 知识点）并置计划 done。 */
function seedRouteStyleExam(childId: string, attemptId: string, planId: string, submittedAt: string): void {
  const kb = openKb(dataDir, parentId, childId);
  try {
    const now = new Date().toISOString();
    kb.prepare(
      `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
         start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
       VALUES (?,?,?,?,'parent','custom','','{}','conversation','',?,?,'pending','',NULL,'','','required',1,0,1,?,?)`
    ).run(planId, parentId, childId, "自定义考核", "2026-09-17 00:00:00", "2026-09-17 23:59:59", now, now);
  } finally {
    kb.close();
  }
  persistExamResult({
    dataDir,
    parentId,
    childId,
    attemptId,
    planId,
    title: "自定义考核",
    submittedAt,
    score: 9,
    perQuestion: PER_QUESTION,
  });
}

function makeCtx(childId: string, mainDb: ReturnType<typeof openDb>): WorkerTaskCtx {
  return {
    dataDir,
    mainDb,
    parentId,
    childId,
    auth: {},
    schedulerConfig: {},
    // 本地时区 2026-09-18 00:05 → 日终结算日 = 2026-09-17
    now: new Date(2026, 8, 18, 0, 5, 0),
  };
}

describe("ISSUE-112 考核得分率 0%（口径随 ISSUE-135 P0-a 更新）", () => {
  const mainDb = openDb(dataDir);
  mainDb
    .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
    .run(parentId, "p112@test", new Date().toISOString(), new Date().toISOString());
  mainDb
    .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(childId, parentId, "珊珊", new Date().toISOString(), new Date().toISOString());

  it("① 结果写入后按真实得分率结算：9/10 → 90% → 良好 +10（不再误扣 -15）", () => {
    seedRouteStyleExam(childId, "exam_112_a", "ep_112_a", "2026-09-17T01:19:29.442Z");
    const kb = openKb(dataDir, parentId, childId);
    try {
      const out = runPlanStat(makeCtx(childId, mainDb));

      // 明细/概要已由提交路径写好，worker 无需修补
      const c = kb
        .prepare("SELECT COUNT(*) AS n, SUM(point_got) AS g, SUM(point_max) AS m FROM exam_plan_courses WHERE plan_id = 'ep_112_a'")
        .get() as { n: number; g: number; m: number };
      expect(c.n).toBe(1);
      expect(c.g).toBe(9);
      expect(c.m).toBe(10);
      expect(out.exams).toBe(0); // 兜底无事可做（幂等）

      // 流水：earn +10 @90% 良好（修复前：deduct 15 @0% 不合格）
      const led = kb
        .prepare("SELECT type, amount, rate, reason, reason_code FROM points_ledger WHERE source_id = '2026-09-17|exam|parent'")
        .get() as { type: string; amount: number; rate: number; reason: string; reason_code: string };
      expect(led.type).toBe("earn");
      expect(led.amount).toBe(10);
      expect(led.rate).toBeCloseTo(0.9, 6);
      expect(led.reason).toContain("90%");
      expect(led.reason).toContain("良好");
      expect(led.reason_code).toBe("exam_award");

      const st = kb
        .prepare("SELECT rate, tier, points_awarded FROM reward_daily_stats WHERE date='2026-09-17' AND source='exam' AND owner='parent'")
        .get() as { rate: number; tier: string; points_awarded: number };
      expect(st.rate).toBeCloseTo(0.9, 6);
      expect(st.tier).toBe("良好");
      expect(st.points_awarded).toBe(10);
    } finally {
      kb.close();
    }
  });

  it("② 结算幂等：复跑 runPlanStat 不重复发分、不重复回填", () => {
    const kb = openKb(dataDir, parentId, childId);
    try {
      runPlanStat(makeCtx(childId, mainDb));
      const led = kb.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE source_id = '2026-09-17|exam|parent'").get() as { n: number };
      expect(led.n).toBe(1);
      const c = kb.prepare("SELECT COUNT(*) AS n FROM exam_plan_courses WHERE plan_id = 'ep_112_a'").get() as { n: number };
      expect(c.n).toBe(1);
    } finally {
      kb.close();
    }
  });

  it("③ 单库兜底：概要行缺失时 computeExamRate 回退逐题明细求和（settleRewards 直调）", () => {
    const child2 = "child-112-b";
    mainDb
      .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run(child2, parentId, "兜底", new Date().toISOString(), new Date().toISOString());
    seedRouteStyleExam(child2, "exam_112_b", "ep_112_b", "2026-09-17T02:00:00.000Z");
    // 模拟「概要行写丢了、只剩逐题明细」的坏状态：不跑 applyExamAttempts 修补，直接结算
    const kb = openKb(dataDir, parentId, child2);
    try {
      kb.prepare("DELETE FROM exam_course_results WHERE plan_id = 'ep_112_b'").run();
      const out = settleRewards(makeCtx(child2, mainDb), kb, "2026-09-17");
      expect(out.earned).toBe(10);
      const led = kb
        .prepare("SELECT type, amount, rate, reason FROM points_ledger WHERE source_id = '2026-09-17|exam|parent'")
        .get() as { type: string; amount: number; rate: number; reason: string };
      expect(led.type).toBe("earn");
      expect(led.amount).toBe(10);
      expect(led.rate).toBeCloseTo(0.9, 6);
      expect(led.reason).toContain("90%");
    } finally {
      kb.close();
    }
  });
});
