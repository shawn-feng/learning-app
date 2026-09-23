/**
 * ISSUE-135 P0-a 回归（2026-09-23）：考核结果重构——结果直写孩子库三层，主库 exam_attempts 退场。
 *
 * 覆盖：
 * ① persistExamResult 一次提交写全：exam_plan_courses（题级富字段）/ exam_course_results（Σgot,Σmax,显式 rate）
 *    / knowledge_point_records（outcome 阈值 + 知识点名快照）/ speech_assessments（题级评测 + question_id 关联）
 *    / exam_plans（done + attempt_id + score）；
 * ② 幂等：同一计划重复提交不新增行、不重复计知识点；
 * ③ 知识点回退：提交项缺 knowledgePointId 时按家长库 course_knowledge_questions（course_uuid + question_id）定位；
 * ④ 无 scheduleId：自动补建 custom 计划并归属，结果不丢；
 * ⑤ 结构收敛：exam_plan_courses.score 已删、courses 掌握四列存在且重开库不被 dropLegacyCourseColumns 误删、
 *    course_progress 视图改读 exam_course_results；
 * ⑥ worker 幂等兜底：补概要 + 补 done，且不覆盖已有概要（LLM 润色结果不会被回滚）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { getCourseUuid, getOrCreateKnowledgePoint, linkQuestionToKnowledgePoint, saveQuestion } from "../server/src/db/assess-content";
import { persistExamResult } from "../server/src/exam-results";
import { runPlanStat } from "../server/src/worker/plan-domain";
import type { WorkerTaskCtx } from "../server/src/worker/tasks";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue135-"));
const parentId = "parent-135";
const childId = "child-135";
const T = "lunyu";
const C1 = "为政第二";

const mainDb = openDb(dataDir);
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p135@test", new Date().toISOString(), new Date().toISOString());
mainDb
  .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(childId, parentId, "珊珊", new Date().toISOString(), new Date().toISOString());

function withParent<T>(fn: (db: ReturnType<typeof openParentLib>) => T): T {
  const db = openParentLib(dataDir, parentId);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ---- seed：家长库一门课 + 两个知识点 + 两道题（其中一题挂到知识点，用于回退定位）----
withParent((db) => {
  db.prepare("INSERT INTO topics (name, topic_key) VALUES (?, ?)").run(T, T);
  db.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 1)").run(T, C1);
});
const courseUuid = withParent((db) => {
  const u = getCourseUuid(db, T, C1);
  if (!u) throw new Error("seed 失败：课程 uuid 未回填");
  return u;
});
const kpA = withParent((db) => getOrCreateKnowledgePoint(db, courseUuid, "为政以德", "德治的核心主张"));
const kpB = withParent((db) => getOrCreateKnowledgePoint(db, courseUuid, "譬如北辰", "比喻句义"));
const qMounted = withParent((db) => saveQuestion(db, { stem: "「为政以德」怎么理解", answer: "以德行治理", pointMax: 10 }));
withParent((db) => {
  linkQuestionToKnowledgePoint(db, { questionId: qMounted, courseId: courseUuid, knowledgePointId: kpB.id });
});

// 孩子库：课程行（uuid 留空，验证「家长库回填」路径）
function seedChildCourse(): void {
  const kb = openKb(dataDir, parentId, childId);
  try {
    kb.prepare("INSERT OR REPLACE INTO courses (topic, topic_key, title, uuid, sort_order) VALUES (?,?,?,?,1)").run(T, T, C1, "");
    kb.prepare("INSERT OR REPLACE INTO topics (name, topic_key, learn_type) VALUES (?,?,?)").run(T, T, "required");
  } finally {
    kb.close();
  }
}
seedChildCourse();

function seedPlan(planId: string): void {
  const kb = openKb(dataDir, parentId, childId);
  try {
    const now = new Date().toISOString();
    kb.prepare(
      `INSERT OR REPLACE INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
         start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
       VALUES (?,?,?,?,'parent','custom','','{}','conversation','','2026-09-23 00:00:00','2026-09-23 23:59:59','pending','',NULL,'','','required',1,0,1,?,?)`
    ).run(planId, parentId, childId, "自定义考核", now, now);
  } finally {
    kb.close();
  }
}

const PER_QUESTION = [
  {
    qid: "q1",
    course: C1,
    question: "「为政以德」怎么理解",
    refText: "",
    pointGot: 9,
    pointMax: 10,
    correct: true,
    aiComment: "答到了德治的要点",
    asrText: "为政以德就是用德行来治理",
    questionId: qMounted,
    knowledgePointId: kpA.id,
    knowledgePointName: "为政以德",
  },
  {
    qid: "q2",
    course: C1,
    question: "「譬如北辰」什么意思",
    pointGot: 4,
    pointMax: 10,
    correct: false,
    aiComment: "比喻句义说不清",
    asrText: "像北边的星星",
    // 故意不给 knowledgePointId / questionId → 走家长库挂载表回退（qMounted 正好挂在 kpB）
    questionId: qMounted,
  },
  {
    qid: "q3",
    course: C1,
    question: "背诵原文",
    pointGot: 8,
    pointMax: 10,
    correct: true,
    aiComment: "背诵 80 分",
    audioFileId: "file_abc",
    questionType: "cn_recitation",
    refText: "为政以德，譬如北辰",
    speech: { overall: 80, pron: 78, accuracy: 81, integrity: 90, fluency: 70, prosody: 60, audioQuality: 95 },
  },
];

afterAll(() => {
  try {
    mainDb.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL 句柄滞后，忽略 */
  }
});

describe("ISSUE-135 P0-a 考核结果落库", () => {
  it("① 一次提交写全孩子库三层 + 评测存档 + 计划回填", () => {
    seedPlan("ep_135_a");
    const out = persistExamResult({
      dataDir,
      parentId,
      childId,
      attemptId: "exam_135_a",
      planId: "ep_135_a",
      title: "自定义考核 · 9月23日",
      submittedAt: "2026-09-23T12:00:00.000Z",
      score: 21,
      perQuestion: PER_QUESTION,
    });
    expect(out.planId).toBe("ep_135_a");
    expect(out.detailCount).toBe(3);
    expect(out.courseResults).toBe(1);
    expect(out.kpRecords).toBe(2); // kpA 显式 + kpB 由挂载表回退
    expect(out.speechArchived).toBe(1);
    expect(out.wrongSeeds).toHaveLength(3); // 口径与旧 worker 一致：**未拿满分**即进错题本（9/10、4/10、8/10 都算）

    const kb = openKb(dataDir, parentId, childId);
    try {
      // 明细：题级富字段 + 课程 uuid 已由家长库回填
      const d = kb
        .prepare("SELECT * FROM exam_plan_courses WHERE plan_id = ? ORDER BY seq")
        .all("ep_135_a") as Array<Record<string, unknown>>;
      expect(d).toHaveLength(3);
      expect(d[0]!.course_uuid).toBe(courseUuid);
      expect(d[1]!.ai_comment).toBe("比喻句义说不清");
      expect(d[1]!.knowledge_point_id).toBe(kpB.id); // 回退定位成功
      expect(d[1]!.knowledge_point_name).toBe("譬如北辰");
      expect(d[2]!.audio_file_id).toBe("file_abc");
      expect(d[2]!.behavior).toBe("cn_recitation");
      expect(d[2]!.ref_text).toBe("为政以德，譬如北辰");
      expect(d[2]!.correct).toBe(1);
      // 冗余 score 列已删
      const cols = (kb.prepare("PRAGMA table_info(exam_plan_courses)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).not.toContain("score");

      // 课程概要：Σgot/Σmax + 显式 rate + 概要文案
      const r = kb.prepare("SELECT * FROM exam_course_results WHERE plan_id = ?").get("ep_135_a") as Record<string, unknown>;
      expect(r.course_uuid).toBe(courseUuid);
      expect(r.point_got).toBe(21);
      expect(r.point_max).toBe(30);
      expect(Number(r.rate)).toBeCloseTo(0.7, 6);
      expect(r.question_count).toBe(3);
      expect(String(r.course_summary)).toContain("70%");
      expect(String(r.course_summary)).toContain("譬如北辰"); // 薄弱知识点入概要

      // 知识点流水：档位阈值 + 名快照
      const krs = kb
        .prepare("SELECT * FROM knowledge_point_records WHERE plan_id = ? ORDER BY knowledge_point_name")
        .all("ep_135_a") as Array<Record<string, unknown>>;
      expect(krs.map((x) => String(x.knowledge_point_id)).sort()).toEqual([kpA.id, kpB.id].sort());
      const byId = new Map(krs.map((x) => [String(x.knowledge_point_id), x]));
      expect(byId.get(kpA.id)!.outcome).toBe("solid"); // 9/10 = 0.9
      expect(byId.get(kpB.id)!.outcome).toBe("weak"); // 4/10 = 0.4
      expect(byId.get(kpB.id)!.knowledge_point_name).toBe("譬如北辰");
      expect(String(byId.get(kpB.id)!.summary)).toContain("比喻句义说不清");

      // 评测存档
      const sp = kb.prepare("SELECT * FROM speech_assessments WHERE plan_id = ?").get("ep_135_a") as Record<string, unknown>;
      expect(sp.overall).toBe(80);
      expect(sp.question_id).toBe("");
      expect(sp.audio_file_id).toBe("file_abc");
      expect(JSON.parse(String(sp.dimensions_json)).accuracy).toBe(81);

      // 计划回填
      const p = kb.prepare("SELECT status, attempt_id, score FROM exam_plans WHERE id = ?").get("ep_135_a") as Record<string, unknown>;
      expect(p.status).toBe("done");
      expect(p.attempt_id).toBe("exam_135_a");
      expect(Number(p.score)).toBe(21);
    } finally {
      kb.close();
    }
  });

  it("② 幂等：重复提交同计划不新增行、不重复计知识点", () => {
    persistExamResult({
      dataDir,
      parentId,
      childId,
      attemptId: "exam_135_a2",
      planId: "ep_135_a",
      title: "自定义考核 · 9月23日",
      submittedAt: "2026-09-23T12:30:00.000Z",
      score: 21,
      perQuestion: PER_QUESTION,
    });
    const kb = openKb(dataDir, parentId, childId);
    try {
      const n = (t: string) =>
        Number((kb.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE plan_id = 'ep_135_a'`).get() as { c: number }).c);
      expect(n("exam_plan_courses")).toBe(3);
      expect(n("exam_course_results")).toBe(1);
      expect(n("knowledge_point_records")).toBe(2);
      expect(n("speech_assessments")).toBe(1);
    } finally {
      kb.close();
    }
  });

  it("③ 缺 scheduleId 时自动补建 custom 计划并归属", () => {
    const out = persistExamResult({
      dataDir,
      parentId,
      childId,
      attemptId: "exam_135_b",
      title: "临时考核",
      submittedAt: "2026-09-23T13:00:00.000Z",
      score: 9,
      perQuestion: [PER_QUESTION[0]],
    });
    expect(out.planId).not.toBe("");
    const kb = openKb(dataDir, parentId, childId);
    try {
      const p = kb.prepare("SELECT status, title FROM exam_plans WHERE id = ?").get(out.planId) as Record<string, unknown>;
      expect(p.status).toBe("done");
      expect(p.title).toBe("临时考核");
      expect(
        Number((kb.prepare("SELECT COUNT(*) AS c FROM exam_course_results WHERE plan_id = ?").get(out.planId) as { c: number }).c)
      ).toBe(1);
    } finally {
      kb.close();
    }
  });

  it("④ 结构收敛：courses 掌握四列存在且重开库不被误删；course_progress 改读新表", () => {
    // 写入四列后重开库两次 —— dropLegacyCourseColumns 的删除名单里绝不能出现同名列
    for (let i = 0; i < 2; i++) {
      const kb = openKb(dataDir, parentId, childId);
      try {
        kb.prepare(
          "UPDATE courses SET mastery_level='needs_review', mastery_desc='最开始只能背原文；最新能举例', teaching_advice='先复述再举例', mastery_updated_at='2026-09-23T21:30:00.000Z' WHERE title = ?"
        ).run(C1);
      } finally {
        kb.close();
      }
    }
    const kb = openKb(dataDir, parentId, childId);
    try {
      const c = kb.prepare("SELECT mastery_level, mastery_desc, teaching_advice FROM courses WHERE title = ?").get(C1) as Record<string, unknown>;
      expect(c.mastery_level).toBe("needs_review");
      expect(String(c.mastery_desc)).toContain("最开始");
      expect(c.teaching_advice).toBe("先复述再举例");
      // 视图改读 exam_course_results：取该课**最近一次**考核（= ③ 那场 13:00 的临时考核，9/10 = 0.9）
      const v = kb.prepare("SELECT lastExamRate, lastExamAt FROM course_progress WHERE title = ?").get(C1) as Record<string, unknown>;
      expect(Number(v.lastExamRate)).toBeCloseTo(0.9, 6);
      expect(String(v.lastExamAt)).toBe("2026-09-23T13:00:00.000Z");
    } finally {
      kb.close();
    }
  });

  it("⑤ worker 幂等兜底：补概要/补 done，且不覆盖已有概要", () => {
    // 造一个「有明细、没概要、没 done_at」的残局（模拟写概要及时崩溃）
    seedPlan("ep_135_c");
    const kb = openKb(dataDir, parentId, childId);
    try {
      const now = new Date().toISOString();
      kb.prepare(
        `INSERT INTO exam_plan_courses (id,plan_id,course_uuid,course_name,question_id,point_got,point_max,correct,seq,created_at)
         VALUES ('epc_c1','ep_135_c',?,?,?,6,10,0,0,?)`
      ).run(courseUuid, C1, "q_c1", now);
    } finally {
      kb.close();
    }
    const ctx: WorkerTaskCtx = {
      dataDir,
      mainDb,
      parentId,
      childId,
      auth: {},
      schedulerConfig: {},
      now: new Date(2026, 8, 24, 0, 5, 0),
    };
    const out = runPlanStat(ctx);
    expect(out.exams).toBeGreaterThanOrEqual(1);

    const kb2 = openKb(dataDir, parentId, childId);
    try {
      const p = kb2.prepare("SELECT status, done_at FROM exam_plans WHERE id = ?").get("ep_135_c") as Record<string, unknown>;
      expect(p.status).toBe("done");
      expect(String(p.done_at)).not.toBe("");
      const r = kb2.prepare("SELECT point_got, point_max, rate, course_summary FROM exam_course_results WHERE plan_id = ?").get("ep_135_c") as Record<string, unknown>;
      expect(Number(r.point_got)).toBe(6);
      expect(Number(r.point_max)).toBe(10);
      expect(Number(r.rate)).toBeCloseTo(0.6, 6);
      // 兜底概要不能被后续 tick 覆盖成空
      const before = String(r.course_summary);
      runPlanStat(ctx);
      const r2 = kb2.prepare("SELECT course_summary FROM exam_course_results WHERE plan_id = ?").get("ep_135_c") as Record<string, unknown>;
      expect(String(r2.course_summary)).toBe(before);
    } finally {
      kb2.close();
    }
  });
});
