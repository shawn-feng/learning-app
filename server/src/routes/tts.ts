/**
 * TTS 路由（客户端朗读合成上收服务端，ISSUE-174 续）。
 *
 * 背景：app 客户端朗读原在本地用 edge-tts 合成，2026-10-12 实测被微软 403 拒绝（静默无声音）；
 * 且管理端「语音合成模型」（minimax-speech-*，家长 TokenHub 托管 Key）只能在服务端调用
 * （Key 全程不出服务端）。客户端朗读统一改调本路由：
 *   - builtin 渠道 → TokenHub 合成（管理端默认模型，失败自动回落 edge-tts）；
 *   - custom / off 渠道 → edge-tts（免费，不烧家长配额，朗读不因停用 AI 而失声）。
 *
 *   POST /api/v1/tts/synthesize   { text, rate?, volume? } → 二进制音频（24kHz MP3，
 *                                 与客户端渲染层 Blob type audio/mpeg 对齐）
 * 用量：TokenHub 真实合成记 token_usage（slot=tts）→ 配额面板「语音合成」分类；
 * 缓存命中/edge 不记（无官方计费）。开放 API 语音回复走 tts/index.ts 同一分发，共用缓存。
 */
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "../config.js";
import { getServerSecret } from "../crypto.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { readVoiceChannel, getTokenHubKey } from "../asr/config.js";
import { recordTtsTokenUsage } from "../db/token-usage.js";
import { synthesizeReply } from "../tts/index.js";

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

/** 朗读文本上限（一次朗读一段/一屏，超长直接拒，防滥用烧配额） */
const TTS_TEXT_MAX_CHARS = 5000;

export function registerTtsRoutes(app: FastifyInstance, deps: Deps): void {
  app.post("/api/v1/tts/synthesize", async (req: any, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as { text?: unknown; rate?: unknown; volume?: unknown };
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      reply.code(400).send({ error: "朗读文本为空" });
      return;
    }
    if (text.length > TTS_TEXT_MAX_CHARS) {
      reply.code(400).send({ error: `朗读文本过长（>${TTS_TEXT_MAX_CHARS} 字符）` });
      return;
    }
    const rate = typeof body.rate === "string" ? body.rate : undefined;
    const volume = typeof body.volume === "string" ? body.volume : undefined;

    // 语音渠道跟随 AI 模型三态（与 ASR/开放 API 同语义）：仅 builtin 注入家长 Key（用 TokenHub）
    const tokenhubApiKey =
      readVoiceChannel(deps.db, parentId) === "builtin"
        ? getTokenHubKey(deps.db, getServerSecret(deps.config.dataDir), parentId)
        : "";
    try {
      const r = await synthesizeReply(text, { rate, volume, tokenhubApiKey }, deps.config.dataDir);
      if (r.usage && r.model) {
        try {
          recordTtsTokenUsage(deps.db, parentId, r.model, r.usage);
        } catch {
          /* 统计落库失败不影响音频返回 */
        }
      }
      reply.type(r.mime).send(r.buffer);
    } catch (err) {
      reply.code(502).send({ error: (err as Error).message });
    }
  });
}
