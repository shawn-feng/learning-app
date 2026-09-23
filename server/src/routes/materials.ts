/**
 * Materials 端点（DESIGN-SPLIT §6，ISSUE-131 P2 后无索引表形态）：
 *  - POST /materials/index   客户端带本地索引比对 → { updates, removed }（现场双根 walk diff）
 *  - GET  /materials/content/:id  流式下载（base64url id，防穿越；新根优先旧根兜底）
 *  - POST /materials/upload  multipart 单文件上传（可选 topic 前缀；写新根）
 *  - GET  /materials/list    现场 walk（管理用）
 *  - DELETE /materials/:id   删文件（新/旧根哪里有删哪里）
 * 索引表已删（决策 1）：磁盘即真源，列表=walk，无索引漂移。
 */
import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import {
  decodeMaterialId,
  diffMaterialIndex,
  encodeMaterialId,
  inferType,
  listMaterialsMeta,
  materialsRoot,
  resolveMaterialFile,
} from "../db/materials.js";

interface MaterialsDeps {
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

/**
 * Web 前端 Phase 0（附加式）：GET 二进制路由的宽松认证——Authorization 头优先，无头时回退
 * ?token= query（浏览器 <img>/<audio>/<video> 标签与 iframe 无法携带自定义请求头）。
 * 复用 verifySession；仅限 GET 路由使用，POST/DELETE 仍走 authParent（只认头，防 token 泄入变更类日志）。
 */
function authParentFlexible(
  req: { headers: Record<string, string | string[] | undefined>; query?: unknown },
  secret: string
): string {
  const header = req.headers.authorization;
  let token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) {
    const q = (req.query ?? {}) as { token?: unknown };
    token = typeof q.token === "string" ? q.token.trim() : "";
  }
  if (!token) throw new ApiError(401, "缺少 session token");
  try {
    return verifySession(token, secret).parent_id;
  } catch {
    throw new ApiError(401, "session 无效或已过期，请重新登录");
  }
}

const TOPIC_KEY_RE = /^[a-zA-Z0-9_-]+$/;

export function registerMaterialsRoutes(app: FastifyInstance, deps: MaterialsDeps): void {
  // 客户端同步：现场 walk diff（无索引表）
  app.post("/api/v1/materials/index", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const body = (req.body ?? {}) as { client_index?: Record<string, string> };
    const { updates, removed } = diffMaterialIndex(
      deps.config.dataDir,
      parentId,
      body.client_index ?? {}
    );
    return { updates, removed };
  });

  app.get("/api/v1/materials/content/:id", async (req, reply) => {
    let parentId: string;
    try {
      // Web 前端 Phase 0：GET 二进制路由额外接受 ?token= query 认证（带头时优先用头，行为不变）
      parentId = authParentFlexible(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const { id } = req.params as { id: string };
    let relPath = "";
    try {
      relPath = decodeMaterialId(id);
    } catch {
      return reply.code(400).send({ error: "材料 id 非法" });
    }
    if (!relPath || relPath.includes("..") || path.isAbsolute(relPath) || /[\\]/.test(relPath)) {
      return reply.code(403).send({ error: "非法材料路径" });
    }

    // ── 观测日志（2026-09-08：诊断「display_content 30s 超时 / 偶发 200 空体」）──
    const diagFile = path.join(deps.config.dataDir, "_materials-content.log");
    const logLine = (o: Record<string, unknown>) => {
      try {
        fs.appendFileSync(diagFile, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
      } catch {
        /* 日志失败不阻断 */
      }
    };
    const t0 = Date.now();
    const base = { id, parentId, path: relPath, range: req.headers.range || "" };
    req.log.info(base, "materials/content start");
    logLine({ ev: "start", ...base });
    let done = false;
    const logFinish = (tag: string, extra: Record<string, unknown> = {}) => {
      if (done) return;
      done = true;
      const info = { id, parentId, path: relPath, tag, ms: Date.now() - t0, status: reply.raw.statusCode, bytes: (reply.raw as unknown as { bytesWritten?: number }).bytesWritten ?? 0, ...extra };
      req.log.info(info, "materials/content done");
      logLine({ ev: "done", ...info });
    };
    reply.raw.once("finish", () => logFinish("finish"));
    reply.raw.once("close", () => logFinish("close"));

    // 新根优先、旧根兜底（存量不迁移）
    const abs = resolveMaterialFile(deps.config.dataDir, parentId, relPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return reply.code(404).send({ error: "材料文件不存在" });
    }
    // 正确 MIME（按扩展名；远程代理渲染依赖它，图片/音视频错误类型会导致 iframe 加载失败）
    const MIME: Record<string, string> = {
      html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
      css: "text/css", js: "text/javascript", json: "application/json",
      md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
      mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
      aac: "audio/aac", flac: "audio/flac",
      mp4: "video/mp4", webm: "video/webm",
      pdf: "application/pdf",
    };
    const ext = path.extname(relPath).toLowerCase().replace(".", "");
    const contentType = MIME[ext] ?? "application/octet-stream";
    // ⚠️ 2026-09-08 根治：Content-Length/Range 一律以**真实文件 stat** 为准，绝不用索引 size——
    const realStat = fs.statSync(abs);
    const size = realStat.size;
    reply.header("Content-Type", contentType);
    reply.header("Accept-Ranges", "bytes");
    reply.header("Cache-Control", "no-store");

    // Range 支持（audio/video seek、iframe 资源加载均依赖）
    const range = typeof req.headers.range === "string" ? req.headers.range : "";
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (start >= size || start > end) {
        return reply.code(416).header("Content-Range", `bytes */${size}`).send();
      }
      end = Math.min(end, size - 1);
      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
      reply.header("Content-Length", String(end - start + 1));
      return reply.send(fs.createReadStream(abs, { start, end }));
    }
    reply.header("Content-Length", String(size));
    return reply.send(fs.createReadStream(abs));
  });

  app.delete("/api/v1/materials/:id", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const { id } = req.params as { id: string };
    let relPath = "";
    try {
      relPath = decodeMaterialId(id);
    } catch {
      return reply.code(400).send({ error: "材料 id 非法" });
    }
    if (!relPath || relPath.includes("..") || path.isAbsolute(relPath) || /[\\]/.test(relPath)) {
      return reply.code(403).send({ error: "非法材料路径" });
    }
    // 新/旧根哪里有删哪里（存量兼容；无索引行要清）
    let deleted = false;
    for (const abs of [
      path.join(materialsRoot(deps.config.dataDir, parentId), relPath),
      path.join(deps.config.dataDir, "materials", parentId, relPath),
    ]) {
      try {
        if (fs.existsSync(abs)) {
          fs.rmSync(abs, { force: true });
          deleted = true;
        }
      } catch {
        /* 单根删除失败不阻断另一个 */
      }
    }
    if (!deleted) return reply.code(404).send({ error: "材料不存在" });
    return { ok: true };
  });

  app.post("/api/v1/materials/upload", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    // 注意：multipart 迭代中必须立即消费 file 流（pipe 完成），否则 busboy 等待数据排空而死锁。
    // 先写临时文件，循环结束拿到 topic/filename 后再改名到最终路径。
    const tmpDir = path.join(deps.config.dataDir, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    let tmpPath = "";
    let filename = "";
    let topic = "";
    let subDir = "";

    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === "field") {
        if (part.fieldname === "topic") topic = String(part.value ?? "").trim();
        if (part.fieldname === "subDir") subDir = String(part.value ?? "").trim();
        continue;
      }
      if (part.type === "file") {
        filename = path.basename(String(part.filename ?? ""));
        tmpPath = path.join(tmpDir, `${crypto.randomUUID()}.upload`);
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(tmpPath);
          part.file.on("error", reject);
          out.on("error", reject);
          out.on("finish", resolve);
          part.file.pipe(out);
        });
      }
    }
    if (!filename) return reply.code(400).send({ error: "缺少文件" });
    if (topic && !TOPIC_KEY_RE.test(topic)) {
      return reply.code(400).send({ error: "topic 仅允许字母/数字/_/-" });
    }
    // subDir（可选，如 media/）：拼进相对路径；防穿越校验
    if (subDir && (subDir.includes("..") || path.isAbsolute(subDir) || /[\\]/.test(subDir))) {
      return reply.code(400).send({ error: "非法子目录路径" });
    }
    const relPosix = topic ? (subDir ? `${topic}/${subDir}/${filename}` : `${topic}/${filename}`) : filename;
    // P2：只写新根（workspaces/<pid>/materials）
    const root = materialsRoot(deps.config.dataDir, parentId);
    const abs = path.join(root, relPosix);
    if (!abs.startsWith(path.resolve(root) + path.sep) && path.resolve(abs) !== path.resolve(root)) {
      return reply.code(403).send({ error: "非法路径" });
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.renameSync(tmpPath, abs);
    const stat = fs.statSync(abs);
    return {
      material: {
        id: encodeMaterialId(relPosix),
        path: relPosix,
        type: inferType(relPosix),
        size: stat.size,
        updated_at: stat.mtime.toISOString(),
      },
    };
  });

  // 材料列表（管理用；客户端同步走 index）——现场双根 walk
  app.get("/api/v1/materials/list", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    return { materials: listMaterialsMeta(deps.config.dataDir, parentId) };
  });
}
