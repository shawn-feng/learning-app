/**
 * ISSUE-135 P0-b 回归（2026-09-26）：历史考核回填知识点记录 —— backfillExamKpRecords。
 *
 * 背景：P0-a（2026-09-23）之前提交的考核只有 exam_plan_courses 明细 / exam_course_results 概要，
 * knowledge_point_records(source='exam') 全空 —— 掌握闭环的第 3 环（知识点累计）拿不到考核数据。
 * 回填与提交时（persistExamResult）同一套口径：outcome 阈值 0.8/0.6、错题评语作 summary、
 * 知识点缺失走家长库挂载表回退；老数据「同题整行重复」必须先去重（否则 Σ得分翻倍）。
 *
 * 覆盖：
 * ① 显式 kp + 回退定位都能落 records；outcome 阈值与 summary 取评语；
 * ② 老数据整行重复被剔除（Σgot 不翻倍）；
 * ③ 无 kp 也定位不到的行跳过（rowsWithoutKp），不编造；
 * ④ Σgot/Σmax 对账（records 聚合 == 带知识点明细行合计）；
 * ⑤ 幂等：已有 records 的计划跳过，重跑零新增；
 * ⑥ 不影响概要/明细（只补 records 这一层）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { getCourseUuid, getOrCreateKnowledgePoint, linkQuestionToKnowledgePoint, saveQuestion } from "../server/src/db/assess-content";
import { backfillExamKpRecords } from "../server/src/exam-results";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue135-backfill-"));
const parentId = "parent-135bf";
const childId = "child-135bf";
const T = "lunyu";
const C1 = "学而第一";

const mainDb = openDb(dataDir);
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p135bf@test", new Date().toISOString(), new Date().toISOString());
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

withParent((db) => {
  db.prepare("INSERT INTO topics (name, topic_key) VALUES (?, ?)").run(T, T);
  db.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 1)").run(T, C1);
});
const courseUuid = withParent((db) => {
  const u = getCourseUuid(db, T, C1);
  if (!u) throw new Error("seed 失败：课程 uuid 未回填");
  return u;
});
const kpA = withParent((db) => getOrCreateKnowledgePoint(db, courseUuid, "学而时习之", "学习与实践"));
const kpB = withParent((db) => getOrCreateKnowledgePoint(db, courseUuid, "孝悌为本", "仁的根本"));
const qMounted = withParent((db) => saveQuestion(db, { stem: "「孝悌」怎么理解", answer: "孝敬父母、尊敬兄长", pointMax: 10 }));
withParent((db) => linkQuestionToKnowledgePoint(db, { questionId: qMounted, courseId: courseUuid, knowledgePointId: kpB.id }));

const PLAN = "ep_135bf_old";
const DONE_AT = "2026-09-14T10:00:00.000Z";
{
  const kb = openKb(dataDir, parentId, childId);
  try {
    const now = new Date().toISOString();
    kb.prepare(
      `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
         start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
       VALUES (?,?,?,?,'parent','custom','','{}','conversation','','2026-09-14 00:00:00','2026-09-14 23:59:59',
         'done','exam_135bf_old',9,'','${DONE_AT}','required',1,0,1,?,?)`
    ).run(PLAN, parentId, childId, "学而篇第一章背诵考核", now, now);
    // 课程行 uuid 留空 → 验证回填时走家长库解析
    kb.prepare("INSERT OR REPLACE INTO courses (topic, topic_key, title, uuid, sort_order) VALUES (?,?,?,?,1)").run(T, T, C1, "");
    kb.prepare("INSERT OR REPLACE INTO topics (name, topic_key, learn_type) VALUES (?,?,?)").run(T, T, "required");

    const ins = kb.prepare(
      `INSERT INTO exam_plan_courses (id,plan_id,course_uuid,course_name,knowledge_point_id,knowledge_point_name,
         question_id,question_text,point_got,point_max,correct,ai_comment,seq,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    let n = 0;
    const row = (o: Record<string, unknown>) => ins.run(`epc_bf_${n++}`, PLAN, o.course_uuid ?? "", C1, o.kp ?? "", "", o.qid ?? "", o.text ?? "", o.got, o.max, o.correct ?? null, o.comment ?? "", o.seq, now);
    // ① 显式 kp：9/10
    row({ kp: kpA.id, text: "「学而时习之」怎么理解", got: 9, max: 10, correct: 1, comment: "答到了要点", seq: 0 });
    // ② kp 空 + question_id 可回退 → kpB：4/10
    row({ qid: qMounted, text: "「孝悌」怎么理解", got: 4, max: 10, correct: 0, comment: "说不清孝悌", seq: 1 });
    // ③ 与 ① 整行重复（老数据 ×2）：去重后不得把 Σgot 翻倍
    row({ kp: kpA.id, text: "「学而时习之」怎么理解", got: 9, max: 10, correct: 1, comment: "答到了要点", seq: 0 });
    // ⑤ uuid 拆分变体（2026-09-26 实测）：同题同 seq 两行只差 course_uuid（'' vs 已回填）——同属重复
    row({ kp: kpA.id, text: "「学而时习之」怎么理解", got: 9, max: 10, correct: 1, comment: "答到了要点", seq: 0, course_uuid: courseUuid });
    // ④ 无 kp、无 question_id：回退定位不到 → 跳过
    row({ text: "来历不明的一题", got: 0, max: 10, correct: 0, seq: 2 });
  } finally {
    kb.close();
  }
}

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

describe("ISSUE-135 P0-b 历史考核回填知识点记录", () => {
  it("①~④ 回填：显式/回退 kp 都落档、整行重复剔除、定位不到跳过、Σ 对账一致", () => {
    const out = backfillExamKpRecords({ dataDir, parentId, childId });
    expect(out.plansScanned).toBe(1);
    expect(out.plansBackfilled).toBe(1);
    expect(out.recordsWritten).toBe(2);
    expect(out.duplicateRowsDropped).toBe(2);
    expect(out.rowsWithoutKp).toBe(1);
    expect(out.issues).toEqual([]);

    const kb = openKb(dataDir, parentId, childId);
    try {
      const recs = kb
        .prepare("SELECT * FROM knowledge_point_records WHERE source='exam' AND plan_id = ?")
        .all(PLAN) as Array<Record<string, unknown>>;
      expect(recs).toHaveLength(2);
      const byKp = new Map(recs.map((r) => [String(r.knowledge_point_id), r]));
      const a = byKp.get(kpA.id)!;
      expect(a.outcome).toBe("solid"); // 9/10
      expect(Number(a.point_got)).toBe(9); // 去重后不翻倍
      expect(String(a.summary)).toContain("答到了要点");
      expect(a.course_uuid).toBe(courseUuid); // 老明细 uuid 空 → 回填时解析回写
      expect(String(a.record_at)).toBe(DONE_AT); // 用计划完成时间，不用回填时刻
      const b = byKp.get(kpB.id)!;
      expect(b.outcome).toBe("weak"); // 4/10
      expect(String(b.summary)).toContain("说不清孝悌");
      expect(String(b.source_ref)).toBe("exam_135bf_old");
    } finally {
      kb.close();
    }
  });

  it("⑤ 幂等：已有 records 的计划跳过，重跑零新增；概要/明细不受影响", () => {
    const kb = openKb(dataDir, parentId, childId);
    let detailCount = 0;
    let summaryCount = 0;
    try {
      detailCount = (kb.prepare("SELECT COUNT(*) AS c FROM exam_plan_courses WHERE plan_id = ?").get(PLAN) as { c: number }).c;
      summaryCount = (kb.prepare("SELECT COUNT(*) AS c FROM exam_course_results WHERE plan_id = ?").get(PLAN) as { c: number }).c;
    } finally {
      kb.close();
    }
    const out2 = backfillExamKpRecords({ dataDir, parentId, childId });
    expect(out2.plansScanned).toBe(0);
    expect(out2.recordsWritten).toBe(0);

    const kb2 = openKb(dataDir, parentId, childId);
    try {
      expect((kb2.prepare("SELECT COUNT(*) AS c FROM knowledge_point_records WHERE source='exam' AND plan_id = ?").get(PLAN) as { c: number }).c).toBe(2);
      expect((kb2.prepare("SELECT COUNT(*) AS c FROM exam_plan_courses WHERE plan_id = ?").get(PLAN) as { c: number }).c).toBe(detailCount);
      expect((kb2.prepare("SELECT COUNT(*) AS c FROM exam_course_results WHERE plan_id = ?").get(PLAN) as { c: number }).c).toBe(summaryCount);
    } finally {
      kb2.close();
    }
  });

  it("⑥ 指定 planIds 可精确补单个计划；rebuild 无 planIds 直接拒绝", () => {
    const out = backfillExamKpRecords({ dataDir, parentId, childId, planIds: [PLAN, "ep_not_exist"] });
    expect(out.plansScanned).toBe(0); // 已有 records → 幂等跳过；不存在的过滤掉
    expect(out.issues).toEqual([]);
    // rebuild 是删了重算的危险动作，必须显式点名计划
    expect(() => backfillExamKpRecords({ dataDir, parentId, childId, rebuild: true })).toThrow(/planIds/);
    // rebuild + planIds：删掉重算，结果与首次一致
    const out2 = backfillExamKpRecords({ dataDir, parentId, childId, planIds: [PLAN], rebuild: true });
    expect(out2.recordsWritten).toBe(2);
    expect(out2.duplicateRowsDropped).toBe(2);
  });
});
