/**
 * ISSUE-112 回归（2026-09-19）：计入积分的考核得分率为 0（9/10 实得被记 0% 误扣分）。
 *
 * 根因：2026-09-14 考核 v2 起，提交路由先行置 exam_plans.done + attempt_id；
 * worker applyExamAttempts 仅凭 attempt_id 判重 → exam_plan_courses 逐题明细从未回填 →
 * computeExamRate 分母 0 → 得分率恒 0% → 命中「不合格」档误扣分。
 *
 * 守住三件事：
 * ① 路由先行置 done 的状态下，runPlanStat 仍会回填逐题明细并按真实得分率结算（9/10 → 90% → 良好 +10）；
 * ② 结算幂等：复跑不重复发分；
 * ③ 口径兜底：即使明细缺失（courses 分母 0），computeExamRate 也能从主库 per_question 还原得分率。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
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

const PER_QUESTION = JSON.stringify([
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
]);

/** 复刻 2026-09-14 后提交路由留下的状态：attempt 已写入主库、计划已被置 done + attempt_id、明细为空。 */
function seedRouteStyleExam(mainDb: ReturnType<typeof openDb>, childId: string, attemptId: string, planId: string) {
  mainDb
    .prepare(
      `INSERT INTO exam_attempts (id,parent_id,child_id,topic,title,started_at,submitted_at,status,score,per_question,course_mastery,reinforce_plan,wrong_questions,created_at,schedule_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      attemptId, parentId, childId, "论语", "自定义考核",
      "2026-09-17T01:10:00.000Z", "2026-09-17T01:19:29.442Z", "done", 9,
      PER_QUESTION, "{}", "{}", "[]", "2026-09-17T01:19:29.442Z", planId
    );
  const kb = openKb(dataDir, parentId, childId);
  try {
    kb
      .prepare(
        `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
           start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
         VALUES (?,?,?,?,'parent','custom','','{}','conversation','',?,?,?,?,?,'',?,'required',1,0,1,?,?)`
      )
      .run(
        planId, parentId, childId, "自定义考核",
        "2026-09-17 00:00:00", "2026-09-17 23:59:59",
        "done", attemptId, 9, "2026-09-17T01:19:31.988Z",
        "2026-09-17T01:19:31.988Z", "2026-09-17T01:19:31.988Z"
      );
  } finally {
    kb.close();
  }
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

describe("ISSUE-112 考核得分率 0%（路由先行置 done → 明细未回填）", () => {
  const mainDb = openDb(dataDir);
  mainDb
    .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
    .run(parentId, "p112@test", new Date().toISOString(), new Date().toISOString());
  mainDb
    .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(childId, parentId, "珊珊", new Date().toISOString(), new Date().toISOString());

  it("① runPlanStat 回填明细并按真实得分率结算：9/10 → 90% → 良好 +10（不再误扣 -15）", () => {
    seedRouteStyleExam(mainDb, childId, "exam_112_a", "ep_112_a");
    const kb = openKb(dataDir, parentId, childId);
    try {
      const out = runPlanStat(makeCtx(childId, mainDb));
      expect(out.exams).toBe(1); // 挂接真实发生（旧代码此处为 0）

      // 逐题明细已回填
      const c = kb
        .prepare("SELECT COUNT(*) AS n, SUM(point_got) AS g, SUM(point_max) AS m FROM exam_plan_courses WHERE plan_id = 'ep_112_a'")
        .get() as { n: number; g: number; m: number };
      expect(c.n).toBe(1);
      expect(c.g).toBe(9);
      expect(c.m).toBe(10);

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

  it("③ 口径兜底：明细缺失时 computeExamRate 回退主库 per_question 求和（settleRewards 直调）", () => {
    const child2 = "child-112-b";
    mainDb
      .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run(child2, parentId, "兜底", new Date().toISOString(), new Date().toISOString());
    seedRouteStyleExam(mainDb, child2, "exam_112_b", "ep_112_b");
    // 模拟「明细始终缺失」的坏状态：不跑 applyExamAttempts，直接结算
    const kb = openKb(dataDir, parentId, child2);
    try {
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
