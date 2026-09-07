// 口语评测路由（考核内口语/听说题判分引擎的 HTTP 入口）。
// 流程：孩子端录音 → files/upload 拿 audioFileId → POST /api/v1/assessment/speech
//   （服务端读 wav → 调 SSECP 声希引擎 → 存档 speech_assessments → 返回维度分）。
// 结果落服务端（唯一真源），家长端在考核结果结构内回放/查看。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { assessSpeech, type SsecpCreds } from "../assessment/ssecp.js";
import { coreTypeOf } from "../assessment/question-types.js";

interface AssessmentDeps {
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

function filesRoot(dataDir: string): string {
  return path.join(dataDir, "files");
}

function resolveSafe(root: string, relPosix: string): string {
  const abs = path.resolve(root, relPosix);
  if (!abs.startsWith(path.resolve(root) + path.sep)) throw new ApiError(403, "非法路径");
  return abs;
}

/** 读服务端 assessment-config.json 的 aliyun-kid / aliyun-ssecp 凭证（同一声希后端）。 */
function loadSsecpCreds(dataDir: string): SsecpCreds | null {
  const p = path.join(dataDir, "assessment-config.json");
  if (!fs.existsSync(p)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(p, "utf-8"));
    const prov = cfg.providers?.["aliyun-ssecp"] || cfg.providers?.["aliyun-kid"];
    if (prov?.appKey && prov?.appSecret) {
      return { appKey: prov.appKey, appSecret: prov.appSecret, userId: prov.userId || "pi-child" };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function registerAssessmentRoutes(app: FastifyInstance, deps: AssessmentDeps): void {
  // 口语评测：audioFileId + 题型 → 服务端调 SSECP → 存档 → 返回维度分
  app.post("/api/v1/assessment/speech", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const body = (req.body ?? {}) as {
      childId?: string;
      audioFileId?: string;
      questionType?: string;
      refText?: string;
      topic?: string;
      course?: string;
      isExam?: boolean;
      examAttemptId?: string;
    };
    const childId = (body.childId || "").trim();
    const audioFileId = (body.audioFileId || "").trim();
    const questionType = (body.questionType || "").trim();
    const refText = (body.refText || "").trim();
    if (!childId || !audioFileId || !questionType) {
      return reply.code(400).send({ error: "childId / audioFileId / questionType 必填" });
    }
    const owned = deps.db.prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?").get(childId, parentId);
    if (!owned) return reply.code(403).send({ error: "无权操作该孩子" });

    const coreType = coreTypeOf(questionType);
    if (!coreType) return reply.code(400).send({ error: `不支持的口语题型：${questionType}` });

    const creds = loadSsecpCreds(deps.config.dataDir);
    if (!creds) {
      return reply.code(503).send({ error: "未配置 SSECP 评测密钥（assessment-config.json 的 aliyun-kid / aliyun-ssecp）" });
    }

    const frow = deps.db
      .prepare("SELECT stored_path FROM files WHERE id = ? AND parent_id = ?")
      .get(audioFileId, parentId) as { stored_path: string } | undefined;
    if (!frow) return reply.code(404).send({ error: "音频文件不存在" });
    const abs = resolveSafe(filesRoot(deps.config.dataDir), path.join(parentId, frow.stored_path));
    if (!fs.existsSync(abs)) return reply.code(404).send({ error: "音频文件不存在" });
    const wav = fs.readFileSync(abs);

    let result;
    try {
      result = await assessSpeech(wav, { questionType, refText, creds, feedback: questionType === "cn_recitation" });
    } catch (e) {
      return reply.code(502).send({ error: `SSECP 评测失败：${(e as Error).message}` });
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    deps.db
      .prepare(
        `INSERT INTO speech_assessments
          (id, parent_id, child_id, topic_key, course_name, question_type, ref_text, audio_file_id,
           overall, pron, dimensions_json, detail_json, is_exam, exam_attempt_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        parentId,
        childId,
        body.topic || "",
        body.course || "",
        questionType,
        refText,
        audioFileId,
        result.overall,
        result.pron,
        JSON.stringify({ accuracy: result.accuracy, integrity: result.integrity, fluency: result.fluency, prosody: result.prosody }),
        JSON.stringify({ words: result.words, cnSyllables: result.cnSyllables, audioQuality: result.audioQuality }),
        body.isExam ? 1 : 0,
        body.examAttemptId || "",
        createdAt
      );

    return { assessmentId: id, result };
  });

  // 家长端：查某孩子口语评测记录（在考核结构内回放/审计）
  app.get("/api/v1/assessment/results/:childId", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const { childId } = req.params as { childId: string };
    const owned = deps.db.prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?").get(childId, parentId);
    if (!owned) return reply.code(403).send({ error: "无权操作该孩子" });
    const rows = deps.db
      .prepare(
        "SELECT id, question_type, ref_text, audio_file_id, overall, pron, dimensions_json, detail_json, is_exam, exam_attempt_id, created_at FROM speech_assessments WHERE child_id = ? ORDER BY created_at DESC LIMIT 200"
      )
      .all(childId);
    return { assessments: rows };
  });
}
