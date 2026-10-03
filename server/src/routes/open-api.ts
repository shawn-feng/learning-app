/**
 * 开放 API（API Key 鉴权）：第三方系统（首个：ESP32-S3 硬件）以与 app 内聊天框相同的能力
 * 调用服务端 agent。设计：docs/开放API-设计方案-2026-09-28.md
 *
 * - POST /api/v1/open/agent/chat      同步聚合：chunked NDJSON 快照流（progress* → final）
 * - POST /api/v1/open/agent/prompt    提交一轮（立即返回，增量走 /stream）
 * - GET  /api/v1/open/agent/stream    SSE 事件流（与 app 完全同协议，Last-Event-ID 重放）
 * - POST /api/v1/open/agent/abort     中止当前一轮
 * - GET  /api/v1/open/agent/status    会话忙闲（{busy}）
 * - GET  /api/v1/open/agent/history   当天会话历史（含 thinking/tool 块）
 * - POST /api/v1/open/files/upload    附件上传（multipart，file 字段）
 * - POST /api/v1/open/files/raw       附件上传（裸流 body，?filename=&kind=，ESP32 友好）
 *
 * 鉴权：Authorization: Bearer laxk_… 或 X-API-Key: laxk_…。只存 sha256；
 * 鉴权先按 prefix 定位候选再 timingSafeEqual 比较；日志只打 prefix，绝不落完整 Key。
 * 会话：复用孩子的**主会话**（与 app 互见，同一 busy 红线：一轮未结束 → 409）。
 * 超时：chat 由 runTurn 收口（默认 240s，timed_out 返回部分回复）；onTimeout 仿飞书 abort 解除 busy。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { hashApiKey } from "./apikeys.js";
import {
  AgentStreamHub,
  agentStreamHub,
} from "../agent/stream-hub.js";
import {
  abortSession,
  disposeSession,
  hasSession,
  isChildBusy,
  openChildSession,
  submitChildPrompt,
  type AgentSessionDeps,
} from "../agent/session-registry.js";
import { getCaps, parseCaps, registerCaps } from "../agent/caps.js";
import { runTurn, type TurnProgress } from "../agent/turn-runner.js";
import { resolveStoredFileAbs, safeExt, uploadsWriteRoot } from "./files.js";
import { getServerSecret } from "../crypto.js";
import { transcribeWithFallback, TranscribeError } from "../asr/transcribe.js";
import { toWav16k } from "../assessment/audio.js";
import { synthesizeReply } from "../tts/index.js";
import { logInfo } from "../log.js";

interface OpenApiDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

interface OpenAuth {
  parentId: string;
  keyId: string;
  /** Key 上绑定的默认对话孩子（生成时选定；空 = 请求必须带 child_id） */
  keyChildId: string;
}

/** 附件标记类型（与服务端 agent 侧 upload-ref / 客户端 attachment-ref 的标记格式逐字一致） */
const MARKER_KIND: Record<OpenAttachmentKind, string> = { image: "图片", file: "文件", audio: "音频" };
type OpenAttachmentKind = "image" | "file" | "audio";
interface OpenAttachment {
  kind: OpenAttachmentKind;
  name: string;
  ref: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE_LIMIT_PER_MIN = 30;
const RAW_UPLOAD_BODY_LIMIT = 51 * 1024 * 1024; // 50MB 内容 + 头部余量（Fastify bodyLimit 超限 → 413）

// —— 简版限流：每 Key 固定窗口（内存），30 次/分钟 → 429 ——
const rateBuckets = new Map<string, { win: number; n: number }>();
function checkRateLimit(keyId: string): boolean {
  const now = Date.now();
  const b = rateBuckets.get(keyId);
  if (!b || now - b.win >= 60_000) {
    rateBuckets.set(keyId, { win: now, n: 1 });
    return true;
  }
  b.n += 1;
  return b.n <= RATE_LIMIT_PER_MIN;
}

function authError(reply: any, err: unknown): boolean {
  if (err instanceof ApiError) {
    reply.code(err.status).send({ error: err.message });
    return true;
  }
  return false;
}

/** API Key 鉴权：Bearer / X-API-Key 二选一。按 prefix 定位候选 + timingSafeEqual 比对 hash。 */
function authApiKey(req: { headers: Record<string, string | string[] | undefined> }, db: DatabaseSync): OpenAuth {
  const header = req.headers.authorization;
  let key = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!key) {
    const alt = req.headers["x-api-key"];
    key = (Array.isArray(alt) ? alt[0] : alt) ?? "";
  }
  key = key.trim();
  if (!key.startsWith("laxk_")) throw new ApiError(401, "缺少或非法 API Key");
  const hash = hashApiKey(key);
  const prefix = key.slice(0, 12);
  const candidates = db
    .prepare("SELECT id, parent_id, key_hash, child_id, revoked_at FROM api_keys WHERE prefix = ?")
    .all(prefix) as Array<{ id: string; parent_id: string; key_hash: string; child_id: string; revoked_at: string | null }>;
  let hit: (typeof candidates)[number] | null = null;
  const given = Buffer.from(hash, "hex");
  for (const c of candidates) {
    try {
      if (!c.revoked_at && c.key_hash.length === hash.length && crypto.timingSafeEqual(Buffer.from(c.key_hash, "hex"), given)) {
        hit = c;
        break;
      }
    } catch {
      /* 长度异常的脏数据跳过 */
    }
  }
  if (!hit) throw new ApiError(401, "API Key 无效或已吊销");
  // 用量登记（同步 SQLite，单行 UPDATE 成本可忽略）
  db.prepare("UPDATE api_keys SET last_used_at = ?, request_count = request_count + 1 WHERE id = ?").run(
    new Date().toISOString(),
    hit.id
  );
  return { parentId: hit.parent_id, keyId: hit.id, keyChildId: hit.child_id };
}

/** 解析本轮对话孩子：请求 child_id 覆盖 Key 默认绑定；归属红线（children.parent_id）强制。 */
function resolveChildId(db: DatabaseSync, auth: OpenAuth, reqChildId: unknown): string {
  const childId = String(reqChildId ?? "").trim() || auth.keyChildId;
  if (!childId) throw new ApiError(400, "该 Key 未绑定默认孩子：请求必须带 child_id（或在设置页重新生成绑定）");
  const owned = db.prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?").get(childId, auth.parentId);
  if (!owned) throw new ApiError(403, "无权访问该孩子的数据");
  return childId;
}

/** caps 能力协商：语义与 app 的 /agent/:childId/stream?caps= 完全一致（变化 → 重建会话）。 */
function applyCaps(parentId: string, childId: string, raw: unknown): void {
  if (raw === undefined || raw === null) return;
  const streamKey = AgentStreamHub.key(parentId, childId);
  const prev = getCaps(streamKey).raw;
  const next = parseCaps(raw);
  registerCaps(streamKey, next);
  if (prev !== next.raw && hasSession(parentId, childId)) {
    disposeSession(parentId, childId);
  }
}

/** 组装 prompt：text 在前、附件标记每个一行（与客户端 ParentChatPanel 的 parts.join("\\n") 逐字一致）。 */
function buildPrompt(text: string, attachments: unknown): string {
  const parts: string[] = [];
  if (text.trim()) parts.push(text.trim());
  if (attachments !== undefined && attachments !== null) {
    if (!Array.isArray(attachments)) throw new ApiError(400, "attachments 必须是数组");
    for (const a of attachments) {
      const kind = String((a as any)?.kind ?? "") as OpenAttachmentKind;
      if (!(kind in MARKER_KIND)) throw new ApiError(400, `附件 kind 非法（image|file|audio）：${kind}`);
      const name = String((a as any)?.name ?? "attachment").trim().slice(0, 200) || "attachment";
      const ref = String((a as any)?.ref ?? "").trim();
      const ok = UUID_RE.test(ref) || (ref.startsWith("files/") && UUID_RE.test(ref.slice("files/".length)));
      if (!ok) throw new ApiError(400, `附件 ref 非法（应为上传接口返回的 files/<id>）：${ref.slice(0, 40)}`);
      parts.push(`【附件${MARKER_KIND[kind]}：${name}|${ref}】`);
    }
  }
  const prompt = parts.join("\n").trim();
  if (!prompt) throw new ApiError(400, "text 与 attachments 不能同时为空");
  return prompt;
}

const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp",
  wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg",
  webm: "audio/webm", amr: "audio/amr",
};

/** kind 省略时按扩展名猜（ESP32 只传 filename 也能得到正确标记类型）。 */
function inferKind(filename: string): OpenAttachmentKind {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "bmp", "webp"].includes(ext)) return "image";
  if (["wav", "mp3", "m4a", "aac", "ogg", "opus", "webm", "amr"].includes(ext)) return "audio";
  return "file";
}

/** 解析 tts 开关：true/1/on（不区分大小写）为开；缺省关。 */
function parseTtsFlag(raw: unknown): boolean {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "on";
}

/** 解析采样率（Hz）：8k~192k 合法整数，否则 undefined。用于 tts_rate（TTS 输出重采样）等。 */
function parseSampleRate(raw: unknown): number | undefined {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 8000 || n > 192000) return undefined;
  return n;
}

/** 解析 timeout_ms：5000~600000 夹取，缺省 240s。 */
function parseTimeoutMs(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(Math.max(n, 5_000), 600_000) : 240_000;
}

/** 落盘 + files 表登记（Buffer 直写）。语音消息原始录音与 TTS 回复音频共用。 */
function saveOpenFileBuffer(
  config: ServerConfig,
  db: DatabaseSync,
  parentId: string,
  childId: string,
  originalName: string,
  mime: string,
  data: Buffer
): { id: string; ref: string; size: number } {
  const id = crypto.randomUUID();
  const storedPath = `${id}${safeExt(originalName)}`;
  const root = uploadsWriteRoot(config.dataDir, parentId, childId || null);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, storedPath), data);
  db.prepare(
    "INSERT INTO files (id, parent_id, child_id, original_name, stored_path, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, parentId, childId || null, originalName, storedPath, mime, data.length, new Date().toISOString());
  return { id, ref: `files/${id}`, size: data.length };
}

/**
 * 一轮结束后合成回复音频（tts 开启时）：edge-tts（免费零配置），落 files 通道供设备经
 * GET /open/files/:id 下载。失败不吞本轮结果——返回 { audio_error } 由调用方并入 final 行。
 * rate 传入时（设备固定 48k 编解码配置等场景）输出重采样为该采样率的 16bit 单声道 WAV，
 * 否则 edge-tts 原生 24kHz MP3。
 */
async function synthReplyAudio(
  config: ServerConfig,
  db: DatabaseSync,
  parentId: string,
  childId: string,
  replyText: string,
  voice?: string,
  rate?: number
): Promise<{ audio?: Record<string, unknown>; audio_error?: string }> {
  try {
    const r = await synthesizeReply(replyText, { voice, sampleRate: rate }, config.dataDir);
    const ext = r.mime === "audio/wav" ? ".wav" : ".mp3";
    const saved = saveOpenFileBuffer(
      config, db, parentId, childId,
      `reply-${Date.now()}${ext}`, r.mime, r.buffer
    );
    return {
      audio: {
        ref: saved.ref,
        url: `/api/v1/open/files/${saved.id}`,
        mime: r.mime,
        size: saved.size,
        voice: r.voice,
        ...(rate ? { sample_rate: rate } : {}),
      },
    };
  } catch (err) {
    return { audio_error: (err as Error).message };
  }
}

export function registerOpenApiRoutes(app: FastifyInstance, deps: OpenApiDeps): void {
  const agentDeps: AgentSessionDeps = { db: deps.db, dataDir: deps.config.dataDir };
  // ASR 兜底 key 解封用（settings auth 封套 AES-GCM），进程内只解一次
  const serverSecret = getServerSecret(deps.config.dataDir);

  // 裸流上传的内容类型解析（不影响 JSON / multipart 既有解析）；text/* 一并放行（文本附件直传）
  app.addContentTypeParser(
    /^(application\/octet-stream|audio\/[^\s;]+|image\/[^\s;]+|video\/[^\s;]+|text\/[^\s;]+)$/i,
    { parseAs: "buffer", bodyLimit: RAW_UPLOAD_BODY_LIMIT },
    (_req, body, done) => done(null, body)
  );

  // —— 同步聚合（NDJSON 快照流）——
  app.post("/api/v1/open/agent/chat", async (req, reply) => {
    let auth: OpenAuth;
    try {
      auth = authApiKey(req, deps.db);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
    const body = (req.body ?? {}) as {
      text?: string; attachments?: unknown; child_id?: string; caps?: string; timeout_ms?: number;
      tts?: unknown; voice?: string; tts_rate?: number;
    };
    let childId: string;
    let prompt: string;
    let ttsOn = false;
    let ttsRate: number | undefined;
    try {
      childId = resolveChildId(deps.db, auth, body.child_id);
      applyCaps(auth.parentId, childId, body.caps);
      if (!checkRateLimit(auth.keyId)) throw new ApiError(429, "请求过于频繁（每分钟 30 次），请稍候重试");
      prompt = buildPrompt(String(body.text ?? ""), body.attachments);
      ttsOn = parseTtsFlag(body.tts);
      ttsRate = parseSampleRate(body.tts_rate);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
    // busy 先查快路径（409 普通 JSON）；竞态漏网时由 runTurn 的 final 行兜底
    if (isChildBusy(auth.parentId, childId)) {
      return reply.code(409).send({ error: "busy：上一轮还在回答，请稍候" });
    }
    const timeoutMs = parseTimeoutMs(body.timeout_ms);
    const streamKey = AgentStreamHub.key(auth.parentId, childId);
    const startedAt = Date.now();

    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    // ⚠️ 监听 reply.raw（ServerResponse）而非 req.raw：POST body 被 Fastify 解析消费后，
    // IncomingMessage 的 "close" 会立即触发（Node ≥13 语义），把 closed 置真会丢掉全部输出。
    // ServerResponse 的 "close" 才是「客户端断开/响应终止」的正确信号。
    reply.raw.on("close", () => {
      closed = true;
    });
    const writeLine = (obj: unknown) => {
      if (closed || reply.raw.writableEnded) return;
      try {
        reply.raw.write(`${JSON.stringify(obj)}\n`);
      } catch {
        /* 客户端断开：轮次继续跑（共享会话语义），输出丢弃 */
      }
    };
    let lastWriteAt = 0;
    let lastToolsSig = "";
    const writeProgress = (p: TurnProgress) => {
      const sig = JSON.stringify(p.tools);
      const now = Date.now();
      // 工具状态变化立即推；thinking/text 秒级节流
      if (sig === lastToolsSig && now - lastWriteAt < 1_000) return;
      lastWriteAt = now;
      lastToolsSig = sig;
      writeLine({ type: "progress", thinking: p.thinking, tools: p.tools, text: p.text });
    };

    let result;
    try {
      result = await runTurn(
        () => submitChildPrompt(agentDeps, auth.parentId, childId, prompt),
        streamKey,
        timeoutMs,
        writeProgress,
        // 超时先中止本轮（释放 busy），与飞书渠道同款兜底
        async () => {
          try {
            await abortSession(auth.parentId, childId);
          } catch {
            /* 忽略 */
          }
        }
      );
    } catch (err) {
      // runTurn 抛异常（如会话建立失败）：头已发出，以 final 行收口，不留悬挂连接
      result = { ok: false, reply: "", error: (err as Error)?.message ?? String(err), progress: null };
    }
    const final: Record<string, unknown> = { type: "final", ok: result.ok };
    if (result.ok) {
      final.reply = result.reply;
      final.thinking = result.progress?.thinking ?? "";
      final.tools = result.progress?.tools ?? [];
      final.duration_ms = Date.now() - startedAt;
    } else {
      final.error = result.error ?? "agent 出错";
      final.thinking = result.progress?.thinking ?? "";
      final.tools = result.progress?.tools ?? [];
    }
    if (result.timedOut) final.timed_out = true;
    // tts 开启：合成回复音频随 final 行下发（失败不吞本轮结果，audio_error 说明原因）
    if (ttsOn && result.ok && result.reply) {
      const tts = await synthReplyAudio(deps.config, deps.db, auth.parentId, childId, result.reply, body.voice, ttsRate);
      Object.assign(final, tts);
    }
    writeLine(final);
    reply.raw.end();
    return reply;
  });

  // —— 语音消息（音频→ASR 转录→对话→可选 TTS）——
  // 与「上传的音频文件附件」的区别：本端点收到的音频是**一句消息本身**，服务端只对它做 ASR
  // 转录并以其文本发起一轮对话（与 app 内语音输入同语义）；要给 agent 传"音频文件"仍走
  // /open/files/upload + attachments（kind=audio，仅存档引用，不做转录）。
  app.post("/api/v1/open/agent/voice", async (req, reply) => {
    let auth: OpenAuth;
    try {
      auth = authApiKey(req, deps.db);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
    const query = (req.query ?? {}) as {
      filename?: string; child_id?: string; tts?: unknown; voice?: string; timeout_ms?: unknown;
      fmt?: string; sample_rate?: unknown; channels?: unknown; tts_rate?: unknown;
    };
    const ctype = String(req.headers["content-type"] ?? "");
    let audioBuf: Buffer | null = null;
    let originalName = String(query.filename ?? "").trim() || "voice.wav";
    let inputMime = "audio/wav";
    let reqChildId = "";
    let ttsRaw: unknown = query.tts;
    let voiceRaw: unknown = query.voice;
    let timeoutRaw: unknown = query.timeout_ms;
    let ttsRateRaw: unknown = query.tts_rate;
    let fmtRaw: unknown = query.fmt;
    let sampleRateRaw: unknown = query.sample_rate;
    let channelsRaw: unknown = query.channels;
    if (ctype.includes("multipart/")) {
      // 扫描全部 part（字段可能排在文件后——ISSUE-165 的教训）
      const fields = new Map<string, string>();
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (!audioBuf) {
            const chunks: Buffer[] = [];
            for await (const chunk of part.file) chunks.push(Buffer.from(chunk));
            audioBuf = Buffer.concat(chunks);
            originalName = String(part.filename ?? "").trim() || originalName;
            inputMime = String(part.mimetype ?? "") || inputMime;
          }
        } else {
          fields.set(part.fieldname, String(part.value ?? ""));
        }
      }
      reqChildId = fields.get("child_id") ?? "";
      ttsRaw = fields.get("tts") ?? ttsRaw;
      voiceRaw = fields.get("voice") ?? voiceRaw;
      timeoutRaw = fields.get("timeout_ms") ?? timeoutRaw;
      ttsRateRaw = fields.get("tts_rate") ?? ttsRateRaw;
      fmtRaw = fields.get("fmt") ?? fmtRaw;
      sampleRateRaw = fields.get("sample_rate") ?? sampleRateRaw;
      channelsRaw = fields.get("channels") ?? channelsRaw;
      if (fields.get("filename")) originalName = String(fields.get("filename"));
    } else {
      // 裸流：query 携带参数，body 即音频字节
      if (Buffer.isBuffer(req.body) && req.body.length > 0) audioBuf = req.body;
      if (query.child_id) reqChildId = String(query.child_id);
      inputMime = MIME_BY_EXT[originalName.toLowerCase().split(".").pop() ?? ""] ?? "audio/wav";
    }
    if (!audioBuf || audioBuf.length === 0) {
      logInfo("openapi", "voice rejected", { status: 400, error: "缺少音频数据", ip: req.ip, contentType: ctype || "(none)", query: req.url });
      return reply.code(400).send({ error: "缺少音频数据（multipart file 字段，或裸流 body + ?filename=）" });
    }
    // 输入格式：fmt=pcm 表示**裸 PCM**（s16le，无文件头——嵌入式直传），必须给 sample_rate；
    // 缺省 auto = 自描述格式（wav/webm/opus/mp3/amr…），ffmpeg 按内容探测。
    const isRawPcm = String(fmtRaw ?? "").trim().toLowerCase() === "pcm";
    const pcmSampleRate = parseSampleRate(sampleRateRaw);
    const pcmChannelsRaw = Number(channelsRaw);
    const pcmChannels = Number.isInteger(pcmChannelsRaw) && pcmChannelsRaw >= 1 && pcmChannelsRaw <= 8 ? pcmChannelsRaw : 1;
    if (isRawPcm && !pcmSampleRate) {
      logInfo("openapi", "voice rejected", { status: 400, error: "fmt=pcm 缺 sample_rate", ip: req.ip, audioBytes: audioBuf.length, contentType: ctype });
      return reply.code(400).send({ error: "fmt=pcm 时必须提供 sample_rate（录音采样率，如 48000）" });
    }

    let childId: string;
    let ttsOn = false;
    let voice: string | undefined;
    let timeoutMs: number;
    let ttsRate: number | undefined;
    try {
      childId = resolveChildId(deps.db, auth, reqChildId);
      if (!checkRateLimit(auth.keyId)) throw new ApiError(429, "请求过于频繁（每分钟 30 次），请稍候重试");
      if (isChildBusy(auth.parentId, childId)) throw new ApiError(409, "busy：上一轮还在回答，请稍候");
      ttsOn = parseTtsFlag(ttsRaw);
      voice = String(voiceRaw ?? "").trim() || undefined;
      timeoutMs = parseTimeoutMs(timeoutRaw);
      ttsRate = parseSampleRate(ttsRateRaw);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }

    // —— ASR 阶段（流未开始：普通 JSON 错误语义）——
    // ffmpeg 转码 16k 单声道 wav：自描述格式自动探测；裸 PCM 按 sample_rate/channels 解读。
    // ffmpeg 缺失属服务端环境问题 → 502。非 2xx 一律落日志（远端排障靠它，不必猜）。
    const tArrive = Date.now();
    let tConvertDone = 0;
    let tAsrDone = 0;
    const vlog = (status: number, error: string) =>
      logInfo("openapi", "voice rejected", {
        status,
        error,
        ip: req.ip,
        audioBytes: audioBuf?.length ?? 0,
        contentType: ctype || "(none)",
        fmt: isRawPcm ? `pcm@${pcmSampleRate}Hz/${pcmChannels}ch` : "auto",
        tts: ttsOn,
      });
    let wav: Buffer;
    try {
      wav = await toWav16k(audioBuf, isRawPcm ? { inputFormat: "s16le", sampleRate: pcmSampleRate, channels: pcmChannels } : {});
      tConvertDone = Date.now();
    } catch (err) {
      const msg = (err as Error).message;
      const status = /未找到可用的 ffmpeg/.test(msg) ? 502 : 400;
      vlog(status, `convert: ${msg}`);
      return reply.code(status).send({ error: `音频转换失败：${msg}` });
    }
    let transcript: string;
    try {
      transcript = (await transcribeWithFallback(deps.db, serverSecret, auth.parentId, wav)).text;
      tAsrDone = Date.now();
    } catch (err) {
      if (err instanceof TranscribeError) {
        vlog(err.status, `asr: ${err.message}`);
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
    if (!transcript.trim()) {
      return reply.code(400).send({ error: "没有识别到语音内容" });
    }
    // 原始录音存档（files 通道，best effort 不阻断对话；可用 GET /open/files/:id 回放）
    try {
      saveOpenFileBuffer(deps.config, deps.db, auth.parentId, childId, originalName, inputMime, audioBuf);
    } catch {
      /* 存档失败不影响对话 */
    }

    // —— 对话阶段（NDJSON 快照流，与 /chat 同协议；prompt = 转录文本）——
    const streamKey = AgentStreamHub.key(auth.parentId, childId);
    const startedAt = Date.now();
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    // ⚠️ 监听 reply.raw 而非 req.raw（POST body 被消费后 req.raw 的 close 立即触发，会丢输出）
    reply.raw.on("close", () => {
      closed = true;
    });
    const writeLine = (obj: unknown) => {
      if (closed || reply.raw.writableEnded) return;
      try {
        reply.raw.write(`${JSON.stringify(obj)}\n`);
      } catch {
        /* 客户端断开：轮次继续跑（共享会话语义），输出丢弃 */
      }
    };
    let lastWriteAt = 0;
    let lastToolsSig = "";
    const writeProgress = (p: TurnProgress) => {
      const sig = JSON.stringify(p.tools);
      const now = Date.now();
      if (sig === lastToolsSig && now - lastWriteAt < 1_000) return;
      lastWriteAt = now;
      lastToolsSig = sig;
      writeLine({ type: "progress", thinking: p.thinking, tools: p.tools, text: p.text });
    };

    let result;
    try {
      // 语音渠道注入口语短回复指令（对齐微信桥的 channelText 模式）：设备靠电池/窄带供电，
      // 长 markdown 回复既拉长 turn 段又拉长 TTS——上一线实测 215 字清单回复让单轮冲到 15.4s，
      // 超过设备 HTTP 读超时直接断流。final.transcript 仍是纯转录文本，指令只影响本轮回复风格。
      const voiceChannelPrompt =
        `（这条消息来自语音设备。回复要求：口语化短句、控制在一两句、尽量不超过 60 字；` +
        `不要 markdown 表格/标题/加粗/列表符号，不要 emoji，多行用换行即可。）\n\n${transcript}`;
      result = await runTurn(
        () => submitChildPrompt(agentDeps, auth.parentId, childId, voiceChannelPrompt),
        streamKey,
        timeoutMs,
        writeProgress,
        async () => {
          try {
            await abortSession(auth.parentId, childId);
          } catch {
            /* 忽略 */
          }
        }
      );
    } catch (err) {
      result = { ok: false, reply: "", error: (err as Error)?.message ?? String(err), progress: null };
    }
    const final: Record<string, unknown> = { type: "final", ok: result.ok, transcript };
    if (result.ok) {
      final.reply = result.reply;
      final.thinking = result.progress?.thinking ?? "";
      final.tools = result.progress?.tools ?? [];
      final.duration_ms = Date.now() - startedAt;
    } else {
      final.error = result.error ?? "agent 出错";
      final.thinking = result.progress?.thinking ?? "";
      final.tools = result.progress?.tools ?? [];
    }
    if (result.timedOut) final.timed_out = true;
    const tTurnDone = Date.now();
    if (!result.ok) {
      logInfo("openapi", "voice turn failed", { ip: req.ip, error: final.error, transcript, audioBytes: audioBuf.length });
    }
    if (ttsOn && result.ok && result.reply) {
      const tts = await synthReplyAudio(deps.config, deps.db, auth.parentId, childId, result.reply, voice, ttsRate);
      Object.assign(final, tts);
    }
    // 分阶段耗时（转码/ASR/对话轮/TTS），逐请求落日志便于端到端延迟归因
    {
      const tTtsDone = Date.now();
      logInfo("openapi", "voice timing", {
        ip: req.ip,
        audioBytes: audioBuf.length,
        convertMs: tConvertDone - tArrive,
        asrMs: tAsrDone - tConvertDone,
        turnMs: tTurnDone - tAsrDone,
        ttsMs: ttsOn ? tTtsDone - tTurnDone : 0,
        totalMs: tTtsDone - tArrive,
        ok: result.ok,
      });
    }
    writeLine(final);
    reply.raw.end();
    return reply;
  });

  // —— 文件下载（API Key 鉴权）：TTS 回复音频 / 设备上传的附件回放 ——
  app.get("/api/v1/open/files/:id", async (req, reply) => {
    let auth: OpenAuth;
    try {
      auth = authApiKey(req, deps.db);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
    try {
      const { id } = req.params as { id: string };
      const row = deps.db
        .prepare("SELECT stored_path, mime, size, child_id FROM files WHERE id = ? AND parent_id = ?")
        .get(id, auth.parentId) as
        | { stored_path: string; mime: string; size: number; child_id: string | null }
        | undefined;
      if (!row) return reply.code(404).send({ error: "文件不存在" });
      const abs = resolveStoredFileAbs(deps.config.dataDir, auth.parentId, row.child_id, row.stored_path);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return reply.code(404).send({ error: "文件不存在" });
      }
      reply.header("Content-Type", row.mime || "application/octet-stream");
      reply.header("Content-Length", String(row.size));
      reply.header("Cache-Control", "no-store");
      return reply.send(fs.createReadStream(abs));
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
  });

  // —— 提交一轮（立即返回；增量走 /stream）——
  app.post("/api/v1/open/agent/prompt", async (req, reply) => {
    let auth: OpenAuth;
    try {
      auth = authApiKey(req, deps.db);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
    const body = (req.body ?? {}) as { text?: string; attachments?: unknown; child_id?: string; caps?: string };
    let childId: string;
    let prompt: string;
    try {
      childId = resolveChildId(deps.db, auth, body.child_id);
      applyCaps(auth.parentId, childId, body.caps);
      if (!checkRateLimit(auth.keyId)) throw new ApiError(429, "请求过于频繁（每分钟 30 次），请稍候重试");
      prompt = buildPrompt(String(body.text ?? ""), body.attachments);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
    const result = await submitChildPrompt(agentDeps, auth.parentId, childId, prompt);
    if (!result.ok) {
      return reply.code(result.error?.startsWith("busy") ? 409 : 500).send({ error: result.error });
    }
    return { ok: true };
  });

  // —— SSE 事件流（与 app 同协议：hello/Last-Event-ID 重放/keepalive）——
  app.get("/api/v1/open/agent/stream", async (req, reply) => {
    let auth: OpenAuth;
    try {
      auth = authApiKey(req, deps.db);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
    const query = (req.query ?? {}) as { child_id?: string; caps?: string; lastEventId?: string };
    let childId: string;
    try {
      childId = resolveChildId(deps.db, auth, query.child_id);
      applyCaps(auth.parentId, childId, query.caps);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
    const key = AgentStreamHub.key(auth.parentId, childId);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (id: number | string, type: string, data: unknown) => {
      reply.raw.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send(agentStreamHub.lastEventId(key), "hello", { childId, caps: query.caps ?? "", ts: Date.now() });
    const lastId = Number(req.headers["last-event-id"] ?? query.lastEventId ?? 0) || 0;
    if (lastId > 0) {
      for (const e of agentStreamHub.replayAfter(key, lastId)) send(e.id, e.type, e.data);
    }
    const unsubscribe = agentStreamHub.subscribe(key, (e) => send(e.id, e.type, e.data));
    const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), 15000);
    req.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return reply;
  });

  // —— 中止当前一轮 ——
  app.post("/api/v1/open/agent/abort", async (req, reply) => {
    let auth: OpenAuth;
    try {
      auth = authApiKey(req, deps.db);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
    try {
      const childId = resolveChildId(deps.db, auth, (req.body as any)?.child_id);
      const aborted = await abortSession(auth.parentId, childId);
      return { ok: true, aborted: aborted > 0 };
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
  });

  // —— 会话忙闲 ——
  app.get("/api/v1/open/agent/status", async (req, reply) => {
    let auth: OpenAuth;
    try {
      auth = authApiKey(req, deps.db);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
    try {
      const childId = resolveChildId(deps.db, auth, (req.query as any)?.child_id);
      return { busy: isChildBusy(auth.parentId, childId), child_id: childId };
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
  });

  // —— 当天会话历史（冷路径复用 openChildSession 的跨天裁决，与 app /open 同语义）——
  app.get("/api/v1/open/agent/history", async (req, reply) => {
    let auth: OpenAuth;
    try {
      auth = authApiKey(req, deps.db);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
    try {
      const childId = resolveChildId(deps.db, auth, (req.query as any)?.child_id);
      const messages = await openChildSession(agentDeps, auth.parentId, childId);
      return { messages };
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
  });

  // —— 附件上传（multipart）：file 字段 + 可选 child_id 字段 ——
  app.post("/api/v1/open/files/upload", async (req, reply) => {
    let auth: OpenAuth;
    try {
      auth = authApiKey(req, deps.db);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
    let tmpPath = "";
    let originalName = "";
    let mime = "application/octet-stream";
    let reqChildId = "";
    try {
      const tmpDir = path.join(deps.config.dataDir, "tmp");
      fs.mkdirSync(tmpDir, { recursive: true });
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === "field") {
          if (part.fieldname === "child_id") reqChildId = String(part.value ?? "").trim();
          continue;
        }
        originalName = String(part.filename ?? "");
        mime = String(part.mimetype ?? "application/octet-stream");
        tmpPath = path.join(tmpDir, `${crypto.randomUUID()}.upload`);
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(tmpPath);
          part.file.on("error", reject);
          out.on("error", reject);
          out.on("finish", resolve);
          part.file.pipe(out);
        });
      }
    } catch (err) {
      if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      return reply.code(400).send({ error: `multipart 解析失败：${(err as Error).message}` });
    }
    if (!originalName || !tmpPath) return reply.code(400).send({ error: "缺少文件" });
    return saveUpload(deps, auth, reqChildId, originalName, mime, tmpPath, reply);
  });

  // —— 附件上传（裸流）：ESP32 友好。?filename=rec.wav&kind=audio（kind 省略按扩展名猜） ——
  app.post("/api/v1/open/files/raw", async (req, reply) => {
    let auth: OpenAuth;
    try {
      auth = authApiKey(req, deps.db);
    } catch (err) {
      if (authError(reply, err)) return;
      throw err;
    }
    const query = (req.query ?? {}) as { filename?: string; kind?: string; child_id?: string };
    const filename = String(query.filename ?? "").trim();
    if (!filename) return reply.code(400).send({ error: "filename 必填（query 参数）" });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return reply.code(400).send({ error: "缺少原始 body（Content-Type 须为 application/octet-stream / audio/* / image/* 等）" });
    }
    const mime = MIME_BY_EXT[filename.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";
    const tmpPath = path.join(deps.config.dataDir, "tmp", `${crypto.randomUUID()}.upload`);
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, buf);
    return saveUpload(deps, auth, query.child_id ?? "", filename, mime, tmpPath, reply);
  });

  /** 落盘 + files 表登记 + 返回 ref 与现成标记（chat 接口 attachments[].ref 直接用）。 */
  function saveUpload(
    d: OpenApiDeps,
    auth: OpenAuth,
    reqChildId: string,
    originalName: string,
    mime: string,
    tmpPath: string,
    reply: any
  ) {
    let childId = "";
    try {
      childId = resolveChildId(d.db, auth, reqChildId);
    } catch (err) {
      fs.unlinkSync(tmpPath);
      if (authError(reply, err)) return;
      throw err;
    }
    const id = crypto.randomUUID();
    const storedPath = `${id}${safeExt(originalName)}`;
    const root = uploadsWriteRoot(d.config.dataDir, auth.parentId, childId || null);
    fs.mkdirSync(root, { recursive: true });
    const abs = path.join(root, storedPath);
    fs.renameSync(tmpPath, abs);
    const size = fs.statSync(abs).size;
    const createdAt = new Date().toISOString();
    d.db
      .prepare(
        "INSERT INTO files (id, parent_id, child_id, original_name, stored_path, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, auth.parentId, childId || null, originalName, storedPath, mime, size, createdAt);
    const kind = inferKind(originalName);
    return reply.send({
      file: { id, parent_id: auth.parentId, child_id: childId || null, original_name: originalName, mime, size, created_at: createdAt },
      ref: `files/${id}`,
      marker: `【附件${MARKER_KIND[kind]}：${originalName}|files/${id}】`,
    });
  }
}
