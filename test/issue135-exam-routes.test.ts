/**
 * ISSUE-135 P0-a 路由级回归（2026-09-23）：考核结果读取接口的**端到端冒烟**。
 *
 * 为什么需要它：P0-a 把 `GET /exam/attempts`、`/exam/course-records`、`/courses/status`、
 * `/assess/questions/:id/records` 的读取源从主库整包 JSON 换成孩子库三表，**只测了写入函数
 * `persistExamResult`**，路由 handler 里的 SQL 无人覆盖 → 0.5.6 部署到 201 后
 * `GET /exam/attempts/:childId` 直接 500 `no such column: topic_key`（select 了 exam_plans 不存在的列）。
 * 本文件用真 fastify + 真 sqlite + 真 JWT 把四条读接口跑通，锁住响应形状。
 *
 * 覆盖：① 四条读接口 200 且形状/字段正确；② 缺 token → 401；③ 非本人孩子 → 403。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { getCourseUuid, getOrCreateKnowledgePoint } from "../server/src/db/assess-content";
import { registerExamRoutes } from "../server/src/routes/exam";
import { signSession } from "../server/src/auth/jwt";
import type { ServerConfig } from "../server/src/config";
import type { FastifyInstance } from "fastify";

// fastify 只装在 server/node_modules；从 server 目录解析才能命中（根 node_modules 没有）。
const requireFromServer = createRequire(path.resolve("server/src/index.ts"));
const Fastify = requireFromServer("fastify") as (opts?: Record<string, unknown>) => FastifyInstance;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue135-routes-"));
const SECRET = "test-secret-135";
const parentId = "parent-r135";
const otherParentId = "parent-r135-other";
const childId = "child-r135";
const otherChildId = "child-r135-other";
const TOPIC = "lunyu";
const COURSE = "为政第二";
const PLAN = "plan-r135";
const ATTEMPT = "exam-r135";
const EXAM_AT = "2026-09-23T12:30:00.000Z";

const mainDb = openDb(dataDir);
const config: ServerConfig = {
  port: 8788,
  upstreamBase: "",
  jwtSecret: SECRET,
  tokenTtlDays: 7,
  dataDir,
};

let app: FastifyInstance;
let token: string;
let courseUuid = "";
let kpId = "";

beforeAll(async () => {
  const now = new Date().toISOString();
  for (const [pid, email] of [
    [parentId, "r135@test"],
    [otherParentId, "r135b@test"],
  ]) {
    mainDb.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(pid, email, now, now);
  }
  mainDb
    .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(childId, parentId, "珊珊", now, now);
  mainDb
    .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(otherChildId, otherParentId, "别人家孩子", now, now);

  // 家长库：主题 + 课程（拿 uuid）
  const parent = openParentLib(dataDir, parentId);
  try {
    parent.prepare("INSERT INTO topics (name, topic_key) VALUES (?, ?)").run(TOPIC, TOPIC);
    parent.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 1)").run(TOPIC, COURSE);
  } finally {
    parent.close();
  }
  const parentRo = openParentLib(dataDir, parentId);
  courseUuid = getCourseUuid(parentRo, TOPIC, COURSE) || "";
  kpId = getOrCreateKnowledgePoint(parentRo, courseUuid, "为政以德", "德治的核心主张").id;
  parentRo.close();
  if (!courseUuid || !kpId) throw new Error("seed 失败：课程 uuid / 知识点 id 未生成");
  if (!courseUuid) throw new Error("seed 失败：课程 uuid 未回填");

  // 孩子库：一场已完成考核（计划 + 逐题明细 + 课程概要）
  const kb = openKb(dataDir, parentId, childId);
  try {
    // 孩子库课程行（/courses/status 只纳入有学习/复习/考核信号的课程）
    kb.prepare(
      "INSERT INTO courses (topic, topic_key, title, uuid, sort_order, status, last_review, review_count, tags) VALUES (?,?,?,?,1,'✅','2026-09-23',1,'')"
    ).run(TOPIC, TOPIC, COURSE, courseUuid);
    kb.prepare(
      `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
         start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
       VALUES (?,?,?,?,'parent','custom','','{}','conversation','','','','done',?,?,?,?,'required',1,0,1,?,?)`
    ).run(PLAN, parentId, childId, "每日考核", ATTEMPT, 14, "", EXAM_AT, now, now);
    const insQ = kb.prepare(
      `INSERT INTO exam_plan_courses (id,plan_id,course_uuid,course_name,knowledge_point_id,knowledge_point_name,
         question_id,question_text,ref_text,point_got,point_max,correct,ai_comment,asr_text,audio_file_id,duration_ms,behavior,seq,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    insQ.run("epc-1", PLAN, courseUuid, COURSE, kpId, "为政以德", "q-1", "为政以德下一句？", "", 10, 10, 1, "答得好", "", "file-1", 1200, "generic", 0, now);
    insQ.run("epc-2", PLAN, courseUuid, COURSE, "kp-missing", "思无邪", "q-2", "诗三百一言以蔽之？", "", 4, 10, 0, "再想想", "思无邪", "", 900, "speech_recite", 1, now);
    kb.prepare(
      `INSERT INTO exam_course_results (id,parent_id,child_id,plan_id,attempt_ref,topic_key,course_uuid,course_name,
         exam_at,point_got,point_max,rate,question_count,course_summary,plan_review_at,focus_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run("ecr-1", parentId, childId, PLAN, "", TOPIC, courseUuid, COURSE, EXAM_AT, 14, 20, 0.7, 2, "本次考了 2 题", "2026-09-26", '["思无邪"]', now, now);
  } finally {
    kb.close();
  }

  token = signSession({ parent_id: parentId, email: "r135@test", plan: "basic" }, SECRET, 7);
  app = Fastify();
  registerExamRoutes(app, { config, db: mainDb });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  mainDb.close();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄可能延迟释放，忽略 */
  }
});

// ⚠️ 必须惰性构造：token 在 beforeAll 才赋值，顶层 `{authorization: \`Bearer ${token}\`}` 会固化成 "Bearer undefined" → 全 401。
const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

describe("ISSUE-135 P0-a 读接口（孩子库口径）", () => {
  it("GET /exam/attempts/:childId —— 200 且响应形状与旧主库口径一致", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/exam/attempts/${childId}`, headers: auth() });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { attempts: Array<Record<string, unknown>> };
    expect(body.attempts).toHaveLength(1);
    const a = body.attempts[0]!;
    expect(a.id).toBe(ATTEMPT); // 对外 id = attempt_id
    expect(a.topic).toBe(TOPIC); // 来自 exam_course_results.topic_key（exam_plans 没有该列）
    expect(a.title).toBe("每日考核");
    expect(a.submittedAt).toBe(EXAM_AT);
    expect(a.status).toBe("done");
    expect(a.score).toBe(14);
    expect(a.scheduleId).toBe(PLAN);
    const pq = a.perQuestion as Array<Record<string, unknown>>;
    expect(pq).toHaveLength(2);
    expect(pq[0]!.asrText).toBe("");
    expect(pq[0]!.audioFileId).toBe("file-1"); // 「听原音」依赖
    expect(pq[1]!.questionId).toBe("q-2");
    expect(pq[1]!.asrText).toBe("思无邪");
    expect(pq[1]!.correct).toBe(false);
    expect(pq[1]!.knowledgePointName).toBe("思无邪");
    // courseMastery 按题目现场聚合（旧口径保留）
    expect((a.courseMastery as Record<string, { correct: number; total: number }>)[COURSE]!.total).toBe(2);
    // reinforcePlan 承接 exam_course_results 的复习到期 + 重点
    expect((a.reinforcePlan as Record<string, { planReviewAt: string }>)[COURSE]!.planReviewAt).toBe("2026-09-26");
    expect(a.wrongQuestions).toEqual(["q-2"]);
  });

  it("GET /exam/course-records/:childId —— 200 且含课程记录", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/exam/course-records/${childId}`, headers: auth() });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { records: Array<Record<string, unknown>> };
    expect(body.records.length).toBeGreaterThan(0);
    const rec = body.records.find((r) => r.course === COURSE);
    expect(rec, JSON.stringify(body.records.slice(0, 3))).toBeTruthy();
    expect(Number(rec!.total)).toBe(2);
    expect(Number(rec!.correct)).toBe(1);
  });

  it("GET /courses/status/:childId —— 200 且课程字段齐全", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/courses/status/${childId}`, headers: auth() });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { records: Array<Record<string, unknown>> };
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.length).toBeGreaterThan(0);
    const row = body.records.find((r) => r.title === COURSE);
    expect(row, JSON.stringify(body.records.slice(0, 3))).toBeTruthy();
    expect(String(row!.topic)).toBe(TOPIC);
  });

  it("GET /assess/questions/:id/records —— 200 且按孩子分组（契约字段名未变）", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/assess/questions/q-1/records", headers: auth() });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { records?: Array<Record<string, unknown>> };
    const list = body.records ?? [];
    expect(list.length).toBe(1);
    expect(list[0]!.childName).toBe("珊珊");
    expect(list[0]!.neverAssessed).toBeFalsy(); // 考过 → 不是占位行
  });

  it("POST /exam/attempts —— 200 且一次写全孩子库三层 + 评测存档", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/exam/attempts",
      headers: auth(),
      payload: {
        childId,
        title: "路由冒烟考核",
        submittedAt: "2026-09-23T13:00:00.000Z",
        score: 18,
        perQuestion: [
          {
            questionId: "q-9",
            course: COURSE,
            courseId: courseUuid,
            knowledgePointId: kpId,
            question: "道之以德？",
            pointGot: 8,
            pointMax: 10,
            correct: false,
            aiComment: "再读一遍",
            asrText: "道之以德齐之以礼",
            audioFileId: "file-9",
            durationMs: 1500,
            questionType: "speech_recite",
            // SSE/评测结果（题级维度分）：persistExamResult 只对带 speech 对象的口语题写 speech_assessments
            speech: { overall: 82, pron: 80, accuracy: 85, integrity: 100, fluency: 78, prosody: 76 },
          },
        ],
        reinforcePlan: { [COURSE]: { planReviewAt: "2026-09-28", focus: ["为政以德"] } },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as { ok: boolean; id: string };
    expect(out.ok).toBe(true);
    expect(out.id).toMatch(/^exam_/);

    const kb = openKb(dataDir, parentId, childId);
    try {
      // 未传 scheduleId → 服务端按 attempt_id 补建计划（P0-a 前由 worker 兜底；现在提交即落）
      const plan = kb
        .prepare("SELECT id, status, attempt_id, score, done_at FROM exam_plans WHERE attempt_id = ?")
        .get(out.id) as Record<string, unknown> | undefined;
      expect(plan, "提交后应存在关联的考核计划行").toBeTruthy();
      const planId = String(plan!.id);
      expect(plan!.status).toBe("done");
      const detail = kb
        .prepare("SELECT question_id, point_got, point_max, correct, ai_comment, asr_text, audio_file_id, knowledge_point_name FROM exam_plan_courses WHERE plan_id = ?")
        .get(planId) as Record<string, unknown> | undefined;
      expect(detail?.question_id).toBe("q-9");
      expect(detail?.asr_text).toBe("道之以德齐之以礼");
      expect(detail?.audio_file_id).toBe("file-9"); // 题级富信息（旧主库 per_question 的能力已承接）
      expect(detail?.knowledge_point_name).toBe("为政以德"); // 知识点名快照
      const cr = kb.prepare("SELECT rate, point_got, point_max, topic_key FROM exam_course_results WHERE plan_id = ?").get(planId) as
        | Record<string, unknown>
        | undefined;
      expect(Number(cr?.rate)).toBeCloseTo(0.8, 6);
      expect(String(cr?.topic_key)).toBe(TOPIC);
      const speech = kb.prepare("SELECT COUNT(*) c FROM speech_assessments WHERE plan_id = ?").get(planId) as { c: number };
      expect(speech.c).toBe(1);
    } finally {
      kb.close();
    }
  });

  it("缺 token → 401（不是 500）", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/exam/attempts/${childId}` });
    expect(res.statusCode).toBe(401);
  });

  it("别人的孩子 → 403（不泄露、不报 500）", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/exam/attempts/${otherChildId}`, headers: auth() });
    expect(res.statusCode, res.body).toBe(403);
  });
});
