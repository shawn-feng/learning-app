/**
 * 发音评测（服务端计算，凭证统一收归服务端，2026-09-13 由客户端 Electron 主进程迁移至此）：
 * - GET  /api/v1/assessment/config        取打码后的评测服务配置（绝不返回明文密钥）
 * - POST /api/v1/assessment/config        保存评测服务配置（AES-256-GCM 加密落 settings 表）
 * - POST /api/v1/assessment/assess        按 audioFileId 取已上传语音 → 转 16k wav → 评测 → 返回 SpeechAssessment
 * 鉴权：家长 JWT；childId 可选（考核流程必传并校验归属；设置页「测试」可不传）。语音复用 files 通道。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { assessAudio, toSpeechAssessment, loadAssessmentConfig, getMaskedAssessmentConfig, applyAssessmentConfigPatch } from "../assessment/index.js";

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

/** 按 fileId 从服务端 files 表取已上传音频字节（与 files.ts 读取逻辑一致，做路径穿越防护）。 */
function readAudioBytes(db: DatabaseSync, dataDir: string, parentId: string, fileId: string): Buffer {
  const row = db
    .prepare("SELECT stored_path FROM files WHERE id = ? AND parent_id = ?")
    .get(fileId, parentId) as { stored_path: string } | undefined;
  if (!row) throw new ApiError(404, "音频文件不存在");
  const root = path.join(dataDir, "files");
  const base = path.resolve(root, parentId);
  const abs = path.resolve(base, row.stored_path);
  if (!abs.startsWith(base + path.sep)) throw new ApiError(403, "非法路径");
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new ApiError(404, "音频文件不存在");
  return fs.readFileSync(abs);
}

export function registerAssessmentRoutes(app: FastifyInstance, deps: AssessmentDeps): void {
  const { config, db } = deps;

  // 取打码配置
  app.get("/api/v1/assessment/config", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const cfg = loadAssessmentConfig(db, parentId, config.dataDir);
    return { config: getMaskedAssessmentConfig(cfg) };
  });

  // 保存配置（加密落库）
  app.post("/api/v1/assessment/config", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as {
      enabled?: boolean;
      provider?: string;
      providers?: Record<string, Record<string, string>>;
    };
    const cfg = applyAssessmentConfigPatch(db, parentId, config.dataDir, {
      enabled: !!body.enabled,
      provider: body.provider,
      providers: body.providers,
    });
    return { config: getMaskedAssessmentConfig(cfg) };
  });

  // 评测：按 audioFileId 取语音 → 服务端计算 → 返回 SpeechAssessment
  app.post("/api/v1/assessment/assess", { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as {
      childId?: string;
      audioFileId?: string;
      refText?: string;
      provider?: string;
    };
    const childId = typeof body.childId === "string" ? body.childId.trim() : "";
    const fileId = typeof body.audioFileId === "string" ? body.audioFileId.trim() : "";
    if (!fileId) return reply.code(400).send({ error: "缺少 audioFileId" });
    if (childId) {
      try {
        assertChildOwned(db, parentId, childId);
      } catch (err) {
        if (handleAuthError(err, reply)) return;
        throw err;
      }
    }
    try {
      const audio = readAudioBytes(db, config.dataDir, parentId, fileId);
      const result = await assessAudio(db, parentId, config.dataDir, audio, {
        provider: (body.provider as "tencent-soe" | "aliyun-ssecp") || undefined,
        refText: body.refText || "",
      });
      const mapped = toSpeechAssessment(result);
      return { audioFileId: fileId, assessmentId: crypto.randomUUID(), result: mapped };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `发音评测失败：${msg}` });
    }
  });
}
