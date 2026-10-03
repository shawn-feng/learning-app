/**
 * ASR 路由（ISSUE-165：语音识别凭证配置上收服务端）。
 *
 *   GET  /api/v1/asr/config    打码配置回显（{ config, stored }；stored=服务端是否已有落库值，
 *                              客户端据此做本机 voice-config.json 一次性导入）
 *   PUT  /api/v1/asr/config    补丁保存（apiKey「空值或含 *」= 未修改，其余覆盖）
 *   POST /api/v1/asr/transcribe 转录：multipart file（客户端已转好的 16k wav）+ 可选 provider
 *                              （设置页「测试该服务」单通道验证，不做 fallback）
 *
 * 转录回退顺序与语义逐字对齐旧客户端 transcribeAudio：默认服务优先、其余已配置通道依次尝试；
 * 「没有识别到语音」属语义错误，直接短路不回退。兜底 key 由服务端从同家长 auth 封套解析。
 */
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "../config.js";
import { getServerSecret } from "../crypto.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import {
  readAsrConfig,
  writeAsrConfig,
  applyAsrConfigPatch,
  maskAsrConfig,
  getTranscribeCandidates,
  type AsrProviderId,
} from "../asr/config.js";
import { transcribeWithFallback, TranscribeError } from "../asr/transcribe.js";

interface Deps {
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

function handleAuthError(err: unknown, reply: any): boolean {
  if (err instanceof ApiError) {
    reply.code(err.status).send({ error: err.message });
    return true;
  }
  return false;
}

export function registerAsrRoutes(app: FastifyInstance, deps: Deps): void {
  const secret = getServerSecret(deps.config.dataDir);

  app.get("/api/v1/asr/config", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { cfg, stored } = readAsrConfig(deps.db, secret, parentId);
    const masked = maskAsrConfig(cfg);
    // 展示语义沿用客户端 getMaskedConfig：任一通道可用即视为已启用
    const anyConfigured = getTranscribeCandidates(deps.db, secret, parentId, cfg).length > 0;
    masked.enabled = cfg.enabled || anyConfigured;
    return { config: masked, stored };
  });

  app.put("/api/v1/asr/config", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const patch = (req.body ?? {}) as {
      enabled?: boolean;
      provider?: AsrProviderId;
      providers?: Record<string, Record<string, string>>;
    };
    const { cfg } = readAsrConfig(deps.db, secret, parentId);
    applyAsrConfigPatch(cfg, patch);
    writeAsrConfig(deps.db, secret, parentId, cfg);
    return { config: maskAsrConfig(cfg), stored: true };
  });

  app.post("/api/v1/asr/transcribe", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }

    let wav: Buffer | null = null;
    let onlyProvider = "";
    // 扫描全部 part（不能见 file 就 break：字段可能排在文件后面——FormData 附加顺序不保证）
    for await (const part of req.parts()) {
      if (part.type === "file" && !wav) {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(Buffer.from(chunk));
        wav = Buffer.concat(chunks);
      } else if (part.type === "field" && part.fieldname === "provider") {
        onlyProvider = String(part.value ?? "").trim();
      }
    }
    if (!wav || wav.length === 0) return reply.code(400).send({ error: "缺少音频数据" });

    // 聚合转录链已提取为共享模块（开放 API 语音消息同源复用）；此处映射回原响应形态
    try {
      const { text } = await transcribeWithFallback(deps.db, secret, parentId, wav, { onlyProvider });
      return { text };
    } catch (err) {
      if (err instanceof TranscribeError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });
}
