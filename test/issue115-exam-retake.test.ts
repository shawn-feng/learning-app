/**
 * ISSUE-115 回归（2026-09-19）：考核当天重考。
 *
 * 守住：
 * ① exam_plans.retake 列迁移（新建库建表自带 + 老库幂等补列）；
 * ② LLM 输出解析/归一化（retake_needed=false 合法、title 强制「重考」前缀、schema 错误可反馈）；
 * ③ maybeCreateRetakePlan 全链路（注入 ask 免 LLM）：生成 → 课程/知识点校验 → 创建
 *    （retake='' 防连环、count_in_rate 按设置默认不计入、确定性 id 幂等、当天窗口）；
 * ④ 错误反馈重试环与失败兜底（评分结果不受影响）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { getCourseUuid, getOrCreateKnowledgePoint, saveQuestion, replaceCourseContent } from "../server/src/db/assess-content";
import {
  buildRetakePrompt,
  getRetakeCountInRate,
  maybeCreateRetakePlan,
  parseRetakeDraft,
  setRetakeCountInRate,
} from "../server/src/exam-retake";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue115-"));
const parentId = "parent-115";
const childId = "child-115";
const COURSE = "论语为政篇第一章";

const mainDb = openDb(dataDir);
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p115@test", new Date().toISOString(), new Date().toISOString());
mainDb
  .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(childId, parentId, "珊珊", new Date().toISOString(), new Date().toISOString());

/** 家长库播种：lunyu/论语为政篇第一章 + 知识点「背诵」×1 题（走真实 getOrCreate/save/replace 链路）。 */
function seedParentLib(): void {
  let pl = openParentLib(dataDir, parentId);
  pl.prepare("INSERT INTO topics (name, topic_key, method, progress, rules_json) VALUES ('lunyu', 'lunyu', '', '', '{}')").run();
  pl.prepare("INSERT INTO courses (topic, title, sort_order) VALUES ('lunyu', ?, 1)").run(COURSE);
  pl.close();
  pl = openParentLib(dataDir, parentId); // 重开触发 ensureAssessContentSchema 给 courses 回填 uuid
  const uuid = getCourseUuid(pl, "lunyu", COURSE);
  if (!uuid) throw new Error("seed 失败：course uuid 未生成");
  const kp = getOrCreateKnowledgePoint(pl, uuid, "背诵", "背诵原文");
  const qid = saveQuestion(pl, { stem: "背诵本章原文", answer: "为政以德，譬如北辰，居其所而众星共之", pointMax: 10 });
  replaceCourseContent(pl, uuid, [{ knowledgePointId: kp.id, overview: "", questionIds: [qid] }]);
  pl.close();
}

/** 孩子库播种：课程行（validateRetakeCourses 用孩子库 courses 定位课程名）。 */
function seedChildKb(): void {
  const kb = openKb(dataDir, parentId, childId);
  try {
    kb.prepare("INSERT INTO courses (topic, topic_key, title) VALUES ('lunyu', 'lunyu', ?)").run(COURSE);
    kb
      .prepare(
        `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
           start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at,retake)
         VALUES ('ep_115',?,?, '自定义考核','parent','custom','','{}','conversation','', '2026-09-19 00:00:00','2026-09-19 23:59:59','pending','','NULL','','','required',1,0,1,?,?,'错两题以上当天原题重考')`
      )
      .run(parentId, childId, new Date().toISOString(), new Date().toISOString());
  } finally {
    kb.close();
  }
}

const PER_QUESTION = [
  { qid: "q1", course: COURSE, knowledgePointName: "背诵", pointGot: 6, pointMax: 10, correct: false, aiComment: "背诵 63 分，漏句" },
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

describe("ISSUE-115 exam_plans.retake 迁移", () => {
  it("新建库：CREATE TABLE 直接带 retake 列", () => {
    const kb = openKb(dataDir, parentId, childId);
    try {
      const cols = (kb.prepare("PRAGMA table_info(exam_plans)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain("retake");
    } finally {
      kb.close();
    }
  });

  it("老库：缺 retake 列时 openKb 幂等补列", () => {
    const dir = path.join(dataDir, "kb", parentId);
    fs.mkdirSync(dir, { recursive: true });
    const oldPath = path.join(dir, "child-115-old.sqlite");
    const raw = new DatabaseSync(oldPath);
    // 模拟 ISSUE-115 之前的 exam_plans 老结构（列与现 schema 一致、只缺 retake——索引依赖这些列）
    raw.exec(`
      CREATE TABLE exam_plans (
        id TEXT PRIMARY KEY, parent_id TEXT NOT NULL DEFAULT '', child_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '', creator TEXT NOT NULL DEFAULT 'parent', kind TEXT NOT NULL DEFAULT 'fixed',
        freq TEXT NOT NULL DEFAULT '', scope_json TEXT NOT NULL DEFAULT '{}', origin TEXT NOT NULL DEFAULT 'conversation',
        recurrence_id TEXT NOT NULL DEFAULT '', start_at TEXT NOT NULL DEFAULT '', due_at TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending', attempt_id TEXT NOT NULL DEFAULT '', score REAL, result TEXT NOT NULL DEFAULT '',
        done_at TEXT NOT NULL DEFAULT '', task_type TEXT NOT NULL DEFAULT 'required', count_in_rate INTEGER NOT NULL DEFAULT 1,
        points INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    raw.close();
    const kb = openKb(dataDir, parentId, "child-115-old");
    try {
      const cols = (kb.prepare("PRAGMA table_info(exam_plans)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain("retake");
    } finally {
      kb.close();
    }
  });
});

describe("ISSUE-115 输出解析与 prompt", () => {
  it("parseRetakeDraft：合法输出归一化（title 强制重考前缀、count 下限 1）", () => {
    const r = parseRetakeDraft(
      JSON.stringify({ title: "为政篇重考", courses: [{ title: COURSE, kps: [{ name: "背诵", count: 0 }] }] })
    );
    expect(r.error).toBeUndefined();
    expect(r.draft?.retakeNeeded).toBe(true);
    expect(r.draft?.title).toBe("重考：为政篇重考");
    expect(r.draft?.courses[0]?.kps[0]?.count).toBe(1);
  });

  it("parseRetakeDraft：retake_needed=false 合法（标准未触发）", () => {
    const r = parseRetakeDraft(JSON.stringify({ retake_needed: false, reason: "只错一题，未达错两题标准" }));
    expect(r.error).toBeUndefined();
    expect(r.draft?.retakeNeeded).toBe(false);
    expect(r.draft?.reason).toContain("未达");
  });

  it("parseRetakeDraft：坏 JSON / 缺 courses → 可反馈的错误", () => {
    expect(parseRetakeDraft("我不是 JSON").error).toBeTruthy();
    expect(parseRetakeDraft(JSON.stringify({ retake_needed: true })).error).toContain("courses");
  });

  it("buildRetakePrompt：含重考标准原文、总分与逐题摘要", () => {
    const p = buildRetakePrompt({
      retake: "错两题以上当天原题重考",
      examTitle: "自定义考核",
      childName: "珊珊",
      score: 6,
      scoreMax: 10,
      dateStr: "2026-09-19",
      perQuestion: PER_QUESTION,
    });
    expect(p).toContain("错两题以上当天原题重考");
    expect(p).toContain("6/10");
    expect(p).toContain(COURSE);
    expect(p).toContain("retake_needed");
  });
});

describe("ISSUE-115 maybeCreateRetakePlan 全链路（注入 ask）", () => {
  const planId = "ep_115";
  const now = new Date(2026, 8, 19, 16, 0, 0);
  const validDraft = JSON.stringify({
    title: "重考：自定义考核",
    courses: [{ title: COURSE, kps: [{ name: "背诵", count: 1 }] }],
    note: "把错的再背一遍",
  });

  it("retake 字段为空 → 不触发（无 retake 计划的行为零变化）", async () => {
    const r = await maybeCreateRetakePlan({
      dataDir, db: mainDb, parentId, childId,
      planId: "ep_none", attemptId: "exam_x", examTitle: "自定义考核", score: 9, perQuestion: PER_QUESTION, now,
    });
    expect(r.triggered).toBe(false);
  });

  it("生成并创建当天重考计划：retake=''、count_in_rate 默认 0、origin=retake、确定性 id", async () => {
    seedParentLib();
    seedChildKb();
    const r = await maybeCreateRetakePlan({
      dataDir, db: mainDb, parentId, childId,
      planId, attemptId: "exam_115_a", examTitle: "自定义考核", score: 6, perQuestion: PER_QUESTION, now,
      ask: async () => validDraft,
    });
    expect(r.created).toBe(true);
    expect(r.planId).toBe(`retake_${planId}`);

    const kb = openKb(dataDir, parentId, childId);
    try {
      const p = kb.prepare("SELECT * FROM exam_plans WHERE id = ?").get(`retake_${planId}`) as Record<string, unknown>;
      expect(p["retake"]).toBe(""); // 防连环重考：服务端强制
      expect(p["origin"]).toBe("retake");
      expect(p["count_in_rate"]).toBe(0); // 默认不计入评分档
      expect(p["status"]).toBe("pending");
      expect(String(p["title"])).toContain("重考");
      expect(String(p["start_at"])).toMatch(/2026-09-19 00:00:00/);
      expect(String(p["due_at"])).toMatch(/2026-09-19 23:59:59/);
      const scope = JSON.parse(String(p["scope_json"])) as { courses: Array<{ title: string; kps: Array<{ name: string; count: number }> }>; retake_of?: string; note?: string };
      expect(scope.retake_of).toBe(planId);
      expect(scope.courses[0]?.title).toBe(COURSE);
      expect(scope.courses[0]?.kps[0]?.name).toBe("背诵");
      expect(scope.note).toBe("把错的再背一遍");
    } finally {
      kb.close();
    }
  });

  it("幂等：同一原计划重复提交 → 不重复创建", async () => {
    const r = await maybeCreateRetakePlan({
      dataDir, db: mainDb, parentId, childId,
      planId, attemptId: "exam_115_b", examTitle: "自定义考核", score: 6, perQuestion: PER_QUESTION, now,
      ask: async () => validDraft,
    });
    expect(r.triggered).toBe(true);
    expect(r.created).toBe(false);
    expect(r.note).toContain("已存在");
  });

  it("错误反馈重试环：首轮坏输出 → 反馈后第二轮成功", async () => {
    const planId2 = "ep_115_retry";
    const kb = openKb(dataDir, parentId, childId);
    try {
      kb
        .prepare(
          `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
             start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at,retake)
           VALUES (?,?,?,'自定义考核','parent','custom','','{}','conversation','','2026-09-19 00:00:00','2026-09-19 23:59:59','pending','',NULL,'','','required',1,0,1,?,?,'错两题以上当天原题重考')`
        )
        .run(planId2, parentId, childId, new Date().toISOString(), new Date().toISOString());
    } finally {
      kb.close();
    }
    const prompts: string[] = [];
    const r = await maybeCreateRetakePlan({
      dataDir, db: mainDb, parentId, childId,
      planId: planId2, attemptId: "exam_115_c", examTitle: "自定义考核", score: 6, perQuestion: PER_QUESTION, now,
      ask: async (p) => {
        prompts.push(p);
        return prompts.length === 1 ? "好的，我来生成（这不是 JSON）" : validDraft;
      },
    });
    expect(r.created).toBe(true);
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain("上一轮");
    expect(prompts[1]).toContain("不是合法 JSON"); // 首轮错误被追加进对话
  });

  it("幻觉课程名 → 校验失败反馈 → 模型改用真实课程名后创建", async () => {
    const planId3 = "ep_115_halluc";
    const kb = openKb(dataDir, parentId, childId);
    try {
      kb
        .prepare(
          `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
             start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at,retake)
           VALUES (?,?,?,'自定义考核','parent','custom','','{}','conversation','','2026-09-19 00:00:00','2026-09-19 23:59:59','pending','',NULL,'','','required',1,0,1,?,?,'错两题以上当天原题重考')`
        )
        .run(planId3, parentId, childId, new Date().toISOString(), new Date().toISOString());
    } finally {
      kb.close();
    }
    const badDraft = JSON.stringify({ title: "重考：X", courses: [{ title: "不存在的课程", kps: [] }] });
    const prompts: string[] = [];
    const r = await maybeCreateRetakePlan({
      dataDir, db: mainDb, parentId, childId,
      planId: planId3, attemptId: "exam_115_d", examTitle: "自定义考核", score: 6, perQuestion: PER_QUESTION, now,
      ask: async (p) => {
        prompts.push(p);
        return prompts.length === 1 ? badDraft : validDraft;
      },
    });
    expect(r.created).toBe(true);
    expect(prompts[1]).toContain("不存在");
  });

  it("标准未触发（retake_needed=false）→ 不创建，note 说明原因", async () => {
    const planId4 = "ep_115_skip";
    const kb = openKb(dataDir, parentId, childId);
    try {
      kb
        .prepare(
          `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
             start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at,retake)
           VALUES (?,?,?,'自定义考核','parent','custom','','{}','conversation','','2026-09-19 00:00:00','2026-09-19 23:59:59','pending','',NULL,'','','required',1,0,1,?,?,'错两题以上当天原题重考')`
        )
        .run(planId4, parentId, childId, new Date().toISOString(), new Date().toISOString());
    } finally {
      kb.close();
    }
    const r = await maybeCreateRetakePlan({
      dataDir, db: mainDb, parentId, childId,
      planId: planId4, attemptId: "exam_115_e", examTitle: "自定义考核", score: 9, perQuestion: PER_QUESTION, now,
      ask: async () => JSON.stringify({ retake_needed: false, reason: "只错一题，未达错两题标准" }),
    });
    expect(r.created).toBe(false);
    expect(r.note).toContain("无需重考");
    expect(r.note).toContain("未达");
  });

  it("重试耗尽 → 创建失败但不抛错、原计划评分不受影响", async () => {
    const planId5 = "ep_115_fail";
    const kb = openKb(dataDir, parentId, childId);
    try {
      kb
        .prepare(
          `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
             start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at,retake)
           VALUES (?,?,?,'自定义考核','parent','custom','','{}','conversation','','2026-09-19 00:00:00','2026-09-19 23:59:59','done','exam_115_f',6,'','2026-09-19T08:00:00Z','required',1,0,1,?,?,'错两题以上当天原题重考')`
        )
        .run(planId5, parentId, childId, new Date().toISOString(), new Date().toISOString());
    } finally {
      kb.close();
    }
    const r = await maybeCreateRetakePlan({
      dataDir, db: mainDb, parentId, childId,
      planId: planId5, attemptId: "exam_115_f", examTitle: "自定义考核", score: 6, perQuestion: PER_QUESTION, now,
      ask: async () => "仍然是自由文本，不是 JSON",
    });
    expect(r.triggered).toBe(true);
    expect(r.created).toBe(false);
    expect(r.note).toContain("失败");
    // 原计划 done + score 不受影响（评分绝不丢）
    const kb2 = openKb(dataDir, parentId, childId);
    try {
      const p = kb2.prepare("SELECT status, score FROM exam_plans WHERE id = ?").get(planId5) as { status: string; score: number };
      expect(p.status).toBe("done");
      expect(Number(p.score)).toBe(6);
    } finally {
      kb2.close();
    }
  });

  it("设置项：retake 计入评分档时新计划 count_in_rate=1", async () => {
    setRetakeCountInRate(mainDb, parentId, true);
    expect(getRetakeCountInRate(mainDb, parentId)).toBe(true);
    const planId6 = "ep_115_cir1";
    const kb = openKb(dataDir, parentId, childId);
    try {
      kb
        .prepare(
          `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
             start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at,retake)
           VALUES (?,?,?,'自定义考核','parent','custom','','{}','conversation','','2026-09-19 00:00:00','2026-09-19 23:59:59','pending','',NULL,'','','required',1,0,1,?,?,'错两题以上当天原题重考')`
        )
        .run(planId6, parentId, childId, new Date().toISOString(), new Date().toISOString());
    } finally {
      kb.close();
    }
    const r = await maybeCreateRetakePlan({
      dataDir, db: mainDb, parentId, childId,
      planId: planId6, attemptId: "exam_115_g", examTitle: "自定义考核", score: 6, perQuestion: PER_QUESTION, now,
      ask: async () => validDraft,
    });
    expect(r.created).toBe(true);
    const kb2 = openKb(dataDir, parentId, childId);
    try {
      const p = kb2.prepare("SELECT count_in_rate FROM exam_plans WHERE id = ?").get(`retake_${planId6}`) as { count_in_rate: number };
      expect(p.count_in_rate).toBe(1);
    } finally {
      kb2.close();
    }
    setRetakeCountInRate(mainDb, parentId, false); // 还原默认
  });
});
