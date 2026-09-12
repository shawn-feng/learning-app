/**
 * 考核 agent 路由（P3）：把「出题 / 判分」两条 LLM 链路暴露给客户端（P4 切换后的调用点）。
 *
 * - POST /api/v1/exam/agent/generate  { childId, topicName, courseTitle, childName? } → { questions }
 * - POST /api/v1/exam/agent/grade     { childId, answers } → { perQuestion, overall }
 *
 * 设计要点：
 *  - **输入只给标识**（孩子/主题/课程名），课程配置（知识点详情、主题考核方法、背诵语料）
 *    一律由服务端从真源取（`fetchCoursesWithKnowledgePoints`），客户端不再拼装教学内容；
 *    这也是把「学什么、考什么」的口径留在服务端的直接结果。
 *  - 判分口径用服务端 `buildScoringPrompt()`（唯一真源），不接受客户端传入的 prompt —— 
 *    否则家长可编辑的评分口径会被客户端版本覆盖，出现「同一份答案两台机器给分不同」。
 *  - 鉴权：家长 JWT + `children.parent_id` 归属校验。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { buildScoringPrompt, fetchCoursesWithKnowledgePoints } from "./exam.js";
import { scoreExamAttempt, generateCourseQuestions, type ExamAnswerIn, type ExamEngineDeps } from "../agent/exam-engine.js";

interface ExamAgentDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

function authParent(
  req: { headers: Record<string, string | string[] | undefined> },
  secret: string
): string {
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

export function registerExamAgentRoutes(app: FastifyInstance, deps: ExamAgentDeps): void {
  app.post("/api/v1/exam/agent/generate", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as { childId?: string; topicName?: string; courseTitle?: string; childName?: string };
    const childId = String(body.childId ?? "").trim();
    const courseTitle = String(body.courseTitle ?? "").trim();
    const topicName = String(body.topicName ?? "").trim();
    if (!childId || !courseTitle) return reply.code(400).send({ error: "childId 与 courseTitle 必填" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    // 课程配置从真源取（知识点详情 + 主题考核方法）；找不到该课 → 明确报错而非空跑 LLM
    const courses = fetchCoursesWithKnowledgePoints(deps.config.dataDir, parentId, childId, [courseTitle]);
    const course = courses[0];
    if (!course) {
      return reply.code(404).send({ error: `孩子库中找不到课程「${courseTitle}」（请核对课程名，或先用课程列表接口）` });
    }
    const engineDeps: ExamEngineDeps = {
      dataDir: deps.config.dataDir,
      db: deps.db,
      parentId,
      childId,
      childName: String(body.childName ?? "").trim() || undefined,
    };
    try {
      const questions = await generateCourseQuestions(engineDeps, topicName || course.topic, {
        title: course.title,
        assessMethod: course.assessMethod,
        knowledgePoints: course.knowledgePoints,
      });
      return { ok: true, questions };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.post("/api/v1/exam/agent/grade", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as { childId?: string; answers?: ExamAnswerIn[] };
    const childId = String(body.childId ?? "").trim();
    const answers = Array.isArray(body.answers) ? body.answers : [];
    if (!childId) return reply.code(400).send({ error: "childId 必填" });
    if (!answers.length) return reply.code(400).send({ error: "answers 必填（非空数组）" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    try {
      const result = await scoreExamAttempt(
        { dataDir: deps.config.dataDir, db: deps.db, parentId, childId },
        buildScoringPrompt(),
        answers
      );
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // 客户端可用它核对判分口径（只读展示，避免家长误以为客户端版本才是真源）
  app.get("/api/v1/exam/agent/scoring-prompt", async (req, reply) => {
    try {
      authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    return { scoringPrompt: buildScoringPrompt() };
  });
}
