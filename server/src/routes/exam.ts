/**
 * 学习考核（EXAM-REQUIREMENTS.md）——服务端：内容真源 + 存储，不跑判分 LLM。
 * - GET  /api/v1/exam/config/:childId   考核配置下发（周期内学/复习过的知识点 + assess_method/assess_rubric + 判分 prompt）
 * - POST /api/v1/exam/attempts          提交一次考核结果（客户端判分后上报；语音经 /files/upload 先行上传，这里引用 fileId）
 * - GET  /api/v1/exam/attempts/:childId 家长查询考核记录列表（按时间倒序）
 * - GET  /api/v1/exam/course-records/:childId 每课程考核记录表（最近考核/掌握/难点/亮点/计划复习）
 * 鉴权：家长 JWT；childId 必须归属该家长。语音大文件复用 files 通道（child_id 关联）。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { openKb } from "../db/kb.js";
import { openParentLib } from "../db/parent-lib.js";

interface ExamDeps {
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

/**
 * 判分 prompt（服务端单一真源，客户端判分 session 用此 prompt 执行）。
 * 客户端拿到后拼入本场考核的题目与孩子答案；rubric 为家长写的 assess_rubric。
 */
export const SCORING_PROMPT = `你是孩子的学习考核评估老师。下面给你：1) 每道主观题的考核要点(rubric)；2) 孩子对每道题的口头回答(ASR 转写文本，可能有语音识别误差，请结合题意合理理解)；3) 每题用时。
请逐题评估并输出严格的 JSON（不要输出其它文字），格式：
{
  "perQuestion": [
    {
      "qid": "题号",
      "pointGot": 分数(0~pointMax 的整数),
      "correct": true|false,
      "aiComment": "评语：答到了哪些要点、遗漏或理解错误在哪，30~60字"
    }
  ],
  "courseMastery": { "<课程名>": { "correct": 答对题数, "total": 该课程题数, "rate": 正确率(0~1, 两位小数) } },
  "reinforcePlan": {
    "<课程名>": {
      "planReviewAt": "建议复习日期 YYYY-MM-DD（按掌握度与今天推算，薄弱1-2天后、良好3-5天后）",
      "focus": ["考核发现的问题1", "问题2"],
      "aiSuggestion": "一句复习建议"
    }
  },
  "score": 总分(0~100 一位小数),
  "overall": "整体评估一句话"
}
评分标准：按 rubric 逐要点给分；pointMax 由题目给定，答到要点得分、明显错误或答非所问给低分；正确率=得分达到该题 60% 以上视为 correct。请客观、对低龄孩子语气温和、鼓励为主。`;

function rowToAttempt(r: Record<string, unknown>): Record<string, unknown> {
  const parse = (s: unknown, fb: unknown): unknown => {
    if (typeof s !== "string" || !s) return fb;
    try {
      return JSON.parse(s);
    } catch {
      return fb;
    }
  };
  return {
    id: String(r.id),
    childId: String(r.child_id),
    topic: String(r.topic ?? ""),
    title: String(r.title ?? ""),
    startedAt: String(r.started_at ?? ""),
    submittedAt: String(r.submitted_at ?? ""),
    status: String(r.status ?? "grading"),
    score: Number(r.score) || 0,
    perQuestion: parse(r.per_question, []),
    courseMastery: parse(r.course_mastery, {}),
    reinforcePlan: parse(r.reinforce_plan, {}),
    wrongQuestions: parse(r.wrong_questions, []),
  };
}

/** 考核掌握度等级（与引导 mastery 双轨；写入孩子 kb courses.exam_mastery）。 */
function masteryLevel(rate: number): string {
  if (rate >= 0.9) return "熟练";
  if (rate >= 0.7) return "良好";
  if (rate >= 0.5) return "学习中";
  return "薄弱";
}

export function registerExamRoutes(app: FastifyInstance, deps: ExamDeps): void {
  // ===== 考核配置下发（客户端出卷/判分所需：知识点 + rubric + 判分 prompt） =====
  app.get("/api/v1/exam/config/:childId", async (req, reply) => {
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
    const kb = openKb(deps.config.dataDir, parentId, childId);
    const parent = openParentLib(deps.config.dataDir, parentId);
    try {
      // 只下发「写了考核方法说明」的主题；每主题下只带「学/复习过」的课程（考核对象=周期内学过的知识点）
      const topics = parent
        .prepare("SELECT name, topic_key, assess_method FROM topics WHERE assess_method != '' ORDER BY topic_key")
        .all() as Array<{ name: string; topic_key: string; assess_method: string }>;
      const out = [];
      for (const t of topics) {
        const learned = kb
          .prepare(
            "SELECT title, first_learned, last_review, mastery FROM courses WHERE topic = ? AND (first_learned != '' OR last_review != '' OR status = '✅') ORDER BY sort_order, title"
          )
          .all(t.topic_key) as Array<{ title: string; first_learned: string; last_review: string; mastery: string }>;
        if (learned.length === 0) continue;
        const rubrics = parent
          .prepare("SELECT title, assess_rubric FROM courses WHERE topic = ? AND assess_rubric != ''")
          .all(t.topic_key) as Array<{ title: string; assess_rubric: string }>;
        const rubricMap = new Map(rubrics.map((r) => [r.title, r.assess_rubric]));
        out.push({
          topicKey: t.topic_key,
          name: t.name,
          assessMethod: t.assess_method,
          courses: learned.map((c) => ({
            title: c.title,
            firstLearned: c.first_learned ?? "",
            lastReview: c.last_review ?? "",
            mastery: c.mastery ?? "",
            assessRubric: rubricMap.get(c.title) ?? "",
          })),
        });
      }
      return { topics: out, scoringPrompt: SCORING_PROMPT };
    } finally {
      kb.close();
      parent.close();
    }
  });

  // ===== 提交一次考核结果（客户端判分后上报；语音 fileId 由 /files/upload 先行拿到） =====
  app.post("/api/v1/exam/attempts", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as {
      childId?: string;
      topic?: string;
      title?: string;
      startedAt?: string;
      submittedAt?: string;
      status?: string;
      score?: number;
      perQuestion?: unknown;
      courseMastery?: unknown;
      reinforcePlan?: unknown;
      wrongQuestions?: unknown;
    };
    const childId = typeof body.childId === "string" ? body.childId.trim() : "";
    if (!childId) return reply.code(400).send({ error: "缺少 childId" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const now = new Date().toISOString();
    const id = `exam_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    deps.db
      .prepare(
        `INSERT INTO exam_attempts (
           id, parent_id, child_id, topic, title, started_at, submitted_at, status, score,
           per_question, course_mastery, reinforce_plan, wrong_questions, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        parentId,
        childId,
        String(body.topic ?? ""),
        String(body.title ?? ""),
        String(body.startedAt ?? ""),
        String(body.submittedAt ?? now),
        body.status === "done" ? "done" : "grading",
        Number(body.score) || 0,
        JSON.stringify(body.perQuestion ?? []),
        JSON.stringify(body.courseMastery ?? {}),
        JSON.stringify(body.reinforcePlan ?? {}),
        JSON.stringify(body.wrongQuestions ?? []),
        now
      );
    // 掌握度双轨：把本次课程聚合率回写孩子 kb courses.exam_mastery（引导 mastery 不动）
    const cm = body.courseMastery as Record<string, { rate?: number }> | null;
    if (cm && typeof cm === "object") {
      const kb = openKb(deps.config.dataDir, parentId, childId);
      try {
        const topic = String(body.topic ?? "");
        for (const [course, m] of Object.entries(cm)) {
          const rate = typeof m?.rate === "number" ? m.rate : 0;
          const level = masteryLevel(rate);
          kb.prepare("UPDATE courses SET exam_mastery = ? WHERE topic = ? AND title = ?").run(
            level,
            topic,
            course
          );
        }
      } finally {
        kb.close();
      }
    }
    return { ok: true, id };
  });

  // ===== 家长查询考核记录列表（倒序；limit 默认 50） =====
  app.get("/api/v1/exam/attempts/:childId", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    const limit = Math.min(200, Math.max(1, Number((req.query as { limit?: string }).limit) || 50));
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const rows = deps.db
      .prepare("SELECT * FROM exam_attempts WHERE child_id = ? ORDER BY submitted_at DESC LIMIT ?")
      .all(childId, limit) as Array<Record<string, unknown>>;
    return { attempts: rows.map(rowToAttempt) };
  });

  // ===== 每课程考核记录表（家长端：最近考核/掌握/难点/亮点/计划复习时间+重点） =====
  app.get("/api/v1/exam/course-records/:childId", async (req, reply) => {
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
    const rows = deps.db
      .prepare("SELECT id, submitted_at, per_question, course_mastery, reinforce_plan FROM exam_attempts WHERE child_id = ? ORDER BY submitted_at ASC")
      .all(childId) as Array<Record<string, unknown>>;
    const records = new Map<
      string,
      {
        course: string;
        attempts: number;
        lastAssessAt: string;
        correct: number;
        total: number;
        rate: number;
        difficulties: string[];
        highlights: string[];
        planReviewAt: string;
        focus: string[];
      }
    >();
    for (const row of rows) {
      let pq: Array<Record<string, unknown>> = [];
      try {
        pq = JSON.parse(String(row.per_question ?? "[]"));
      } catch {
        pq = [];
      }
      let rp: Record<string, { planReviewAt?: string; focus?: string[] }> = {};
      try {
        rp = JSON.parse(String(row.reinforce_plan ?? "{}"));
      } catch {
        rp = {};
      }
      const submittedAt = String(row.submitted_at ?? "");
      for (const q of pq) {
        const course = String(q.course ?? "");
        if (!course) continue;
        let rec = records.get(course);
        if (!rec) {
          rec = {
            course,
            attempts: 0,
            lastAssessAt: "",
            correct: 0,
            total: 0,
            rate: 0,
            difficulties: [],
            highlights: [],
            planReviewAt: "",
            focus: [],
          };
          records.set(course, rec);
        }
        rec.attempts = 1; // 记录参与场次数（有题即算）
        if (submittedAt > rec.lastAssessAt) rec.lastAssessAt = submittedAt;
        const got = Number(q.pointGot) || 0;
        const max = Number(q.pointMax) || 0;
        const isCorrect = got >= max * 0.6;
        rec.total += 1;
        if (isCorrect) rec.correct += 1;
        const comment = String(q.aiComment ?? "");
        if (!isCorrect && comment) rec.difficulties.push(comment);
        if (isCorrect && got === max && comment) rec.highlights.push(comment);
        const plan = rp[course];
        if (plan) {
          rec.planReviewAt = String(plan.planReviewAt ?? rec.planReviewAt);
          if (Array.isArray(plan.focus) && plan.focus.length) rec.focus = plan.focus.map(String);
        }
      }
    }
    const out = Array.from(records.values()).map((r) => ({
      course: r.course,
      attempts: r.attempts,
      lastAssessAt: r.lastAssessAt,
      correct: r.correct,
      total: r.total,
      rate: r.total ? Math.round((r.correct / r.total) * 1000) / 1000 : 0,
      difficulties: r.difficulties.slice(-3),
      highlights: r.highlights.slice(-3),
      planReviewAt: r.planReviewAt,
      focus: r.focus,
    }));
    // 掌握度等级（来自最近聚合率）
    return { records: out };
  });
}
