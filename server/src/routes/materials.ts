/**
 * Materials 端点（DESIGN-SPLIT §6）：
 *  - POST /materials/index   客户端带本地索引比对 → { updates, removed }
 *  - GET  /materials/content/:id  流式下载（base64url id，防穿越）
 *  - POST /materials/upload  multipart 单文件上传（可选 topic 前缀）
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
  encodeMaterialId,
  materialsRoot,
  scanMaterials,
  upsertMaterialFile,
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

/** 解析相对路径并校验落在材料根目录内（防目录穿越）。 */
function resolveSafe(root: string, relPosix: string): string {
  const abs = path.resolve(root, relPosix);
  if (!abs.startsWith(path.resolve(root) + path.sep)) {
    throw new ApiError(403, "非法路径");
  }
  return abs;
}

const TOPIC_KEY_RE = /^[a-zA-Z0-9_-]+$/;

export function registerMaterialsRoutes(app: FastifyInstance, deps: MaterialsDeps): void {
  // 客户端同步前先扫描磁盘，保证 updated_at 与磁盘一致（发布即时间戳）
  app.post("/api/v1/materials/index", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const body = (req.body ?? {}) as { client_index?: Record<string, string> };
    const clientIndex = body.client_index ?? {};

    scanMaterials(deps.db, deps.config.dataDir, parentId);
    const rows = deps.db
      .prepare(
        "SELECT id, path, type, size, updated_at FROM materials WHERE parent_id = ? ORDER BY path"
      )
      .all(parentId) as Array<{ id: string; path: string; type: string; size: number; updated_at: string }>;

    const updates = rows.filter((r) => clientIndex[r.id] !== r.updated_at);
    const known = new Set(rows.map((r) => r.id));
    const removed = Object.keys(clientIndex).filter((id) => !known.has(id));
    return { updates, removed };
  });

  app.get("/api/v1/materials/content/:id", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const { id } = req.params as { id: string };
    const row = deps.db
      .prepare("SELECT path, type, size FROM materials WHERE id = ? AND parent_id = ?")
      .get(id, parentId) as { path: string; type: string; size: number } | undefined;
    if (!row) return reply.code(404).send({ error: "材料不存在" });

    const root = materialsRoot(deps.config.dataDir, parentId);
    let abs: string;
    try {
      abs = resolveSafe(root, row.path);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
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
    const ext = path.extname(row.path).toLowerCase().replace(".", "");
    const contentType = MIME[ext] ?? "application/octet-stream";
    const size = row.size;
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
    const row = deps.db
      .prepare("SELECT path FROM materials WHERE id = ? AND parent_id = ?")
      .get(id, parentId) as { path: string } | undefined;
    if (!row) return reply.code(404).send({ error: "材料不存在" });
    const root = materialsRoot(deps.config.dataDir, parentId);
    let abs: string;
    try {
      abs = resolveSafe(root, row.path);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    deps.db.prepare("DELETE FROM materials WHERE id = ? AND parent_id = ?").run(id, parentId);
    // 磁盘文件删除失败不阻断（索引已删；孤儿文件由后续清理兜底）
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      /* 忽略 */
    }
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
    const root = materialsRoot(deps.config.dataDir, parentId);
    let abs: string;
    try {
      abs = resolveSafe(root, relPosix);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.renameSync(tmpPath, abs);
    const meta = upsertMaterialFile(deps.db, deps.config.dataDir, parentId, relPosix);
    return { material: { id: meta.id, path: meta.path, type: meta.type, size: meta.size, updated_at: meta.updated_at } };
  });

  // 材料列表（管理用；客户端同步走 index）
  app.get("/api/v1/materials/list", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    scanMaterials(deps.db, deps.config.dataDir, parentId);
    const rows = deps.db
      .prepare("SELECT id, path, type, size, updated_at FROM materials WHERE parent_id = ? ORDER BY path")
      .all(parentId);
    return { materials: rows };
  });
}
