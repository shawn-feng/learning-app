/**
 * ISSUE-135 P4 回归（2026-09-23）：掌握闭环归纳 —— 作为**自定义定时任务**（自然语言指令 + 工具）实现。
 *
 * 覆盖：
 * ① 工具面契约：自定义任务的工具白名单必须含 4 个 mastery_* + 3 个 parent_db_*（漏登记 = 工具静默不可见）；
 * ② 默认任务播种：type=custom / 每天 21:30 / 启用 / owner=parent / 带自然语言指令 + 分配现有孩子；
 *    二次调用幂等；家长删除后不再重建（settings 标记）；新增孩子会补分配；
 * ③ mastery_todo_list：列出待归纳学习计划 + 需刷新掌握的课程；无事时给出「无需更新」；
 * ④ mastery_plan_context：素材齐（知识点 id 清单 / 学习记录原文 / 历史掌握 / 错题本）；
 * ⑤ mastery_save_records：写知识点流水（幂等覆盖）+ 学习计划 result_summary；非法 kp / outcome 被拒并报告；
 * ⑥ mastery_save_course_mastery：写 courses 掌握四列 + knowledge_point_progress（计数由工具实时统计）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { getCourseUuid, getOrCreateKnowledgePoint, saveQuestion, linkQuestionToKnowledgePoint } from "../server/src/db/assess-content";
import { upsertMistake } from "../server/src/db/mistakes";
import {
  createMasteryTools,
  ensureDefaultMasteryTask,
  MASTERY_TOOL_NAMES,
  DEFAULT_MASTERY_TASK_TIME,
  DEFAULT_MASTERY_TASK_INSTRUCTION,
} from "../server/src/worker/mastery-tools";
import { customTaskToolNames } from "../server/src/worker/custom-tasks";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue135-mastery-"));
const parentId = "parent-135m";
const childId = "child-135m";
const T = "lunyu";
const C1 = "学而第一";

const mainDb = openDb(dataDir);
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p135m@test", new Date().toISOString(), new Date().toISOString());
mainDb
  .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(childId, parentId, "珊珊", new Date().toISOString(), new Date().toISOString());

function withParent<T2>(fn: (db: ReturnType<typeof openParentLib>) => T2): T2 {
  const db = openParentLib(dataDir, parentId);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ---- seed：家长库（主题/课程/知识点/挂载题）+ 孩子库（课程行、已完成的学习计划、学习记录、错题）----
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
const qMounted = withParent((db) => saveQuestion(db, { stem: "「学而时习之」怎么理解", answer: "学了要实践", pointMax: 10 }));
withParent((db) => linkQuestionToKnowledgePoint(db, { questionId: qMounted, courseId: courseUuid, knowledgePointId: kpA.id }));

const PLAN_ID = "sp_135m_1";
const DAY = "2026-09-23";
{
  const kb = openKb(dataDir, parentId, childId);
  try {
    kb.prepare("INSERT OR REPLACE INTO courses (topic, topic_key, title, uuid, sort_order) VALUES (?,?,?,?,1)").run(T, T, C1, courseUuid);
    kb.prepare("INSERT OR REPLACE INTO topics (name, topic_key, learn_type) VALUES (?,?,?)").run(T, T, "required");
    kb.prepare(
      `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,
         start_at,due_at,status,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'new','parent','conversation',?,?,'done',?,'required',1,0,1,?,?)`
    ).run(
      PLAN_ID, parentId, childId, T, courseUuid, C1,
      `${DAY} 00:00:00`, `${DAY} 23:59:59`, `${DAY}T11:00:00.000Z`, `${DAY}T08:00:00.000Z`, `${DAY}T11:00:00.000Z`
    );
    kb.prepare("INSERT INTO daily_entries (date, block, title, raw) VALUES (?,?,?,?)").run(
      DAY, "学习", C1, "孩子读了「学而时习之」并说：学了要常常练习。问「孝悌」时它说不太清楚。"
    );
  } finally {
    kb.close();
  }
  // 错题本：一个未掌握的薄弱点（薄弱证据）
  upsertMistake(dataDir, parentId, childId, {
    kind: "weak_point",
    content: `${C1}·孝悌为本（4/10）`,
    detail: "把「孝悌」和「学习」混在一起说了",
    source: "exam",
    course_ref: C1,
    knowledge_point_id: kpB.id,
    knowledge_point_name: "孝悌为本",
  });
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

const tools = createMasteryTools({ dataDir, parentId, childId });
const tool = (name: string) => {
  const t = tools.find((x: any) => x.name === name) as any;
  if (!t) throw new Error(`找不到工具 ${name}`);
  return t;
};
const text = (r: any): string => (r?.content ?? []).map((c: any) => c.text).join("");

describe("ISSUE-135 P4 掌握闭环（自定义任务 + 工具）", () => {
  it("① 工具面契约：白名单含 4 个 mastery_* + 3 个 parent_db_*", () => {
    const names = customTaskToolNames();
    for (const n of MASTERY_TOOL_NAMES) expect(names, `白名单缺 ${n}`).toContain(n);
    for (const n of ["parent_db_describe", "parent_db_read", "parent_db_write"]) {
      expect(names, `白名单缺 ${n}`).toContain(n);
    }
    // 原有定制任务能力不能被覆盖掉
    for (const n of ["get_date", "kb_query", "kb_insert", "kb_update", "weather_query", "create_reminders"]) {
      expect(names).toContain(n);
    }
    // createMasteryTools 实际产出的工具名 = MASTERY_TOOL_NAMES（防两处漂移）
    expect(tools.map((t: any) => t.name).sort()).toEqual([...MASTERY_TOOL_NAMES].sort());
  });

  it("② 默认任务播种：custom/21:30/启用/带指令 + 分配现有孩子；幂等；删后不重建；新孩子补分配", () => {
    ensureDefaultMasteryTask(mainDb, parentId);
    const t = mainDb
      .prepare("SELECT id, name, type, time, enabled, owner, frequency, instruction FROM scheduler_tasks WHERE parent_id = ? AND type = 'custom'")
      .get(parentId) as Record<string, unknown>;
    expect(t.name).toBe("学习情况分析");
    expect(t.type).toBe("custom");
    expect(t.time).toBe(DEFAULT_MASTERY_TASK_TIME);
    expect(Number(t.enabled)).toBe(1);
    expect(t.owner).toBe("parent");
    expect(t.frequency).toBe("daily");
    expect(String(t.instruction)).toBe(DEFAULT_MASTERY_TASK_INSTRUCTION);
    expect(String(t.instruction)).toContain("mastery_todo_list");

    const assigns = mainDb.prepare("SELECT child_id, enabled FROM scheduler_task_assignments WHERE task_id = ?").all(t.id) as Array<
      Record<string, unknown>
    >;
    expect(assigns.map((a) => a.child_id)).toEqual([childId]);
    expect(Number(assigns[0]!.enabled)).toBe(1);

    // 二次调用：不新增行
    ensureDefaultMasteryTask(mainDb, parentId);
    const n1 = (mainDb.prepare("SELECT COUNT(*) AS c FROM scheduler_tasks WHERE parent_id = ? AND type='custom'").get(parentId) as { c: number }).c;
    expect(n1).toBe(1);

    // 家长删除后不再重建（尊重家长选择）
    mainDb.prepare("DELETE FROM scheduler_tasks WHERE id = ?").run(t.id);
    ensureDefaultMasteryTask(mainDb, parentId);
    const n2 = (mainDb.prepare("SELECT COUNT(*) AS c FROM scheduler_tasks WHERE parent_id = ? AND type='custom'").get(parentId) as { c: number }).c;
    expect(n2).toBe(0);

    // 换一个家长（未播种过）验证新孩子会被补分配
    const pid2 = "parent-135m2";
    const cid2 = "child-135m2";
    mainDb
      .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
      .run(pid2, "p135m2@test", new Date().toISOString(), new Date().toISOString());
    mainDb
      .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run(cid2, pid2, "闻闻", new Date().toISOString(), new Date().toISOString());
    ensureDefaultMasteryTask(mainDb, pid2);
    const tid2 = `task_mastery_${pid2}`;
    ensureDefaultMasteryTask(mainDb, pid2);
    const a2 = mainDb.prepare("SELECT child_id FROM scheduler_task_assignments WHERE task_id = ?").all(tid2) as Array<{ child_id: string }>;
    expect(a2.map((x) => x.child_id)).toEqual([cid2]);
  });

  it("③ mastery_todo_list：列出待归纳计划与需刷新课程", async () => {
    const out = text(await tool("mastery_todo_list").execute("x", { days: 3 }));
    expect(out).toContain(PLAN_ID);
    expect(out).toContain(C1);
    expect(out).toContain("需要刷新掌握的课程");
    expect(out).toContain("待归纳的学习计划");
  });

  it("④ mastery_plan_context：素材齐（知识点 id / 学习记录 / 历史 / 错题）", async () => {
    const out = text(await tool("mastery_plan_context").execute("x", { plan_id: PLAN_ID }));
    expect(out).toContain(`id=${kpA.id}`);
    expect(out).toContain(`id=${kpB.id}`);
    expect(out).toContain("常常练习"); // daily 原文
    expect(out).toContain("错题本未掌握项");
    expect(out).toContain("孝悌为本");
    // 不存在的计划要明确报错
    await expect(tool("mastery_plan_context").execute("x", { plan_id: "nope" })).rejects.toThrow(/找不到/);
  });

  it("⑤ mastery_save_records：幂等写入 + 课程概要；非法 kp/outcome 被拒并报告", async () => {
    const params = {
      plan_id: PLAN_ID,
      source: "study",
      items: [
        { knowledge_point_id: kpA.id, outcome: "solid", summary: "能自己解释「学而时习之」并举了练琴的例子" },
        { knowledge_point_id: kpB.id, outcome: "weak", summary: "把「孝悌」和「学习」混在一起，需要重新讲" },
      ],
      result_summary: "本次能复述并解释「学而时习之」；「孝悌为本」还没分清。",
    };
    const out1 = text(await tool("mastery_save_records").execute("x", params));
    expect(out1).toContain("2 个知识点");
    // 幂等：重复执行不新增行
    await tool("mastery_save_records").execute("x", params);
    const kb = openKb(dataDir, parentId, childId);
    try {
      const n = (kb.prepare("SELECT COUNT(*) AS c FROM knowledge_point_records WHERE source='study' AND plan_id = ?").get(PLAN_ID) as { c: number }).c;
      expect(n).toBe(2);
      const r = kb.prepare("SELECT outcome, knowledge_point_name, course_uuid FROM knowledge_point_records WHERE plan_id = ? AND knowledge_point_id = ?").get(PLAN_ID, kpB.id) as Record<string, unknown>;
      expect(r.outcome).toBe("weak");
      expect(r.knowledge_point_name).toBe("孝悌为本");
      expect(r.course_uuid).toBe(courseUuid);
      const sp = kb.prepare("SELECT result_summary FROM study_plans WHERE id = ?").get(PLAN_ID) as { result_summary: string };
      expect(sp.result_summary).toContain("学而时习之");
    } finally {
      kb.close();
    }
    // 非法输入：编造的 kp id / 非法 outcome → 不写、如实报告
    const bad = text(
      await tool("mastery_save_records").execute("x", {
        plan_id: PLAN_ID,
        source: "study",
        items: [
          { knowledge_point_id: "kp-编造的", outcome: "solid", summary: "x" },
          { knowledge_point_id: kpA.id, outcome: "perfect", summary: "x" },
        ],
      })
    );
    expect(bad).toContain("未写入");
    expect(bad).toContain("不存在");
    expect(bad).toContain("非法");
  });

  it("⑥ mastery_save_course_mastery：写课程四列 + 知识点累计（计数由工具统计）", async () => {
    const out = text(
      await tool("mastery_save_course_mastery").execute("x", {
        course: C1,
        mastery_level: "needs_review",
        mastery_desc: "最开始（09-23）只能复述原文；最新（09-23）能解释「学而时习之」并举例，「孝悌为本」还没分清。",
        teaching_advice: "下次先用「孝悌」和「学习」各举一个身边例子，帮孩子把两个概念分开。",
        knowledge_points: [
          { knowledge_point_id: kpA.id, level: "learning", mastery_desc: "能解释并举例，还需要多练" },
          { knowledge_point_id: kpB.id, level: "needs_review", mastery_desc: "概念与「学习」混淆" },
        ],
      })
    );
    expect(out).toContain(C1);
    const kb = openKb(dataDir, parentId, childId);
    try {
      const c = kb.prepare("SELECT mastery_level, mastery_desc, teaching_advice, mastery_updated_at FROM courses WHERE title = ?").get(C1) as Record<string, unknown>;
      expect(c.mastery_level).toBe("needs_review");
      expect(String(c.mastery_desc)).toContain("最开始");
      expect(String(c.teaching_advice)).toContain("孝悌");
      expect(String(c.mastery_updated_at)).not.toBe("");

      const p = kb.prepare("SELECT level, study_count, exam_count, last_outcome, knowledge_point_name FROM knowledge_point_progress WHERE knowledge_point_id = ?").get(kpB.id) as Record<string, unknown>;
      expect(p.level).toBe("needs_review");
      expect(Number(p.study_count)).toBe(1); // 上一步写入的 1 条学习记录（工具实时统计，不由模型编造）
      expect(Number(p.exam_count)).toBe(0);
      expect(p.last_outcome).toBe("weak");
      expect(p.knowledge_point_name).toBe("孝悌为本");
    } finally {
      kb.close();
    }
    // 非法档位直接拒绝
    await expect(
      tool("mastery_save_course_mastery").execute("x", { course: C1, mastery_level: "very_good", mastery_desc: "x" })
    ).rejects.toThrow(/mastery_level/);
  });
});
