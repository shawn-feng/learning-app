/**
 * 大文件通道（DESIGN-SPLIT S2/D10）：录音 / 图片 / 视频存服务端磁盘
 * data/files/<parentId>/<id><ext>（uuid 文件名防冲突/穿越），files 表记录元数据。
 * 复用 M4 教训：multipart 迭代中立即 pipe 消费 file 流，否则 busboy 死锁。
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";

interface FilesDeps {
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

/** 扩展名白名单化（防路径注入），如 ".mp4" / "" */
function safeExt(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

function resolveSafe(root: string, relPosix: string): string {
  const abs = path.resolve(root, relPosix);
  if (!abs.startsWith(path.resolve(root) + path.sep)) {
    throw new ApiError(403, "非法路径");
  }
  return abs;
}

export function registerFilesRoutes(app: FastifyInstance, deps: FilesDeps): void {
  // 上传：multipart（file + 可选 child_id）
  app.post("/api/v1/files/upload", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const tmpDir = path.join(deps.config.dataDir, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    let tmpPath = "";
    let originalName = "";
    let mime = "application/octet-stream";
    let childId = "";

    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === "field") {
        if (part.fieldname === "child_id") childId = String(part.value ?? "").trim();
        continue;
      }
      if (part.type === "file") {
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
    }
    if (!originalName || !tmpPath) return reply.code(400).send({ error: "缺少文件" });
    if (childId) {
      const owned = deps.db
        .prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?")
        .get(childId, parentId);
      if (!owned) return reply.code(403).send({ error: "无权关联该孩子" });
    }

    const id = crypto.randomUUID();
    const ext = safeExt(originalName);
    const storedPath = `${id}${ext}`;
    const root = filesRoot(deps.config.dataDir);
    const parentDir = path.join(root, parentId);
    fs.mkdirSync(parentDir, { recursive: true });
    let abs: string;
    try {
      abs = resolveSafe(root, path.join(parentId, storedPath));
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    fs.renameSync(tmpPath, abs);
    const size = fs.statSync(abs).size;
    const createdAt = new Date().toISOString();
    deps.db
      .prepare(
        "INSERT INTO files (id, parent_id, child_id, original_name, stored_path, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, parentId, childId || null, originalName, storedPath, mime, size, createdAt);
    return { file: { id, parent_id: parentId, child_id: childId || null, original_name: originalName, mime, size, created_at: createdAt } };
  });

  // 下载：流式 + 归属校验
  app.get("/api/v1/files/:id", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const { id } = req.params as { id: string };
    const row = deps.db
      .prepare("SELECT stored_path, mime, size FROM files WHERE id = ? AND parent_id = ?")
      .get(id, parentId) as { stored_path: string; mime: string; size: number } | undefined;
    if (!row) return reply.code(404).send({ error: "文件不存在" });
    const abs = resolveSafe(filesRoot(deps.config.dataDir), path.join(parentId, row.stored_path));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return reply.code(404).send({ error: "文件不存在" });
    }
    reply.header("Content-Type", row.mime || "application/octet-stream");
    reply.header("Content-Length", String(row.size));
    reply.header("Cache-Control", "no-store");
    return reply.send(fs.createReadStream(abs));
  });

  // 删除：仅删记录 + 磁盘文件（限 files 根内）
  app.delete("/api/v1/files/:id", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const { id } = req.params as { id: string };
    const row = deps.db
      .prepare("SELECT stored_path FROM files WHERE id = ? AND parent_id = ?")
      .get(id, parentId) as { stored_path: string } | undefined;
    if (!row) return reply.code(404).send({ error: "文件不存在" });
    const abs = resolveSafe(filesRoot(deps.config.dataDir), path.join(parentId, row.stored_path));
    deps.db.prepare("DELETE FROM files WHERE id = ?").run(id);
    // 磁盘文件删除失败不阻断：记录已删即可，孤儿文件由后续清理兜底
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (err) {
      req.log.warn({ err }, "删除文件失败（记录已删除）");
    }
    return { ok: true };
  });

  // 列表（管理用）
  app.get("/api/v1/files/list", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const rows = deps.db
      .prepare("SELECT id, child_id, original_name, mime, size, created_at FROM files WHERE parent_id = ? ORDER BY created_at DESC")
      .all(parentId);
    return { files: rows };
  });
}
