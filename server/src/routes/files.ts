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

/**
 * Web 前端 Phase 0（附加式）：GET 二进制路由的宽松认证——Authorization 头优先，无头时回退
 * ?token= query（浏览器 <img>/<audio>/<video> 标签无法携带自定义请求头）。
 * 复用 verifySession；仅限 GET 路由使用，POST/DELETE 仍走 authParent（只认头）。
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

function filesRoot(dataDir: string): string {
  return path.join(dataDir, "files");
}

/**
 * P2 归并后的 stored 文件物理解析（新根优先、旧根永久兜底，存量不迁移）：
 *  - 新根（写入点）：家长 `workspaces/<pid>/uploads/<stored>`；孩子 `workspaces/<pid>/<cid>/uploads/<stored>`；
 *  - 旧根（只读兜底）：`files/<pid>/<stored>`（2026-09-22 前的全部存量）。
 * stored_path 服务端生成（uuid.ext），child_id 来自 files 表行。
 */
export function resolveStoredFileAbs(
  dataDir: string,
  parentId: string,
  childId: string | null,
  storedPath: string
): string {
  const newRoot = childId
    ? path.join(dataDir, "workspaces", parentId, childId, "uploads")
    : path.join(dataDir, "workspaces", parentId, "uploads");
  const candidates = [path.join(newRoot, storedPath), path.join(filesRoot(dataDir), parentId, storedPath)];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

/** P2 写入根：按 scope 落盘（家长/孩子各自 uploads 子区）。 */
function uploadsWriteRoot(dataDir: string, parentId: string, childId: string | null): string {
  return childId
    ? path.join(dataDir, "workspaces", parentId, childId, "uploads")
    : path.join(dataDir, "workspaces", parentId, "uploads");
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
    // ISSUE-131 P2：按 scope 落盘到 workspaces/<pid>/{uploads|<cid>/uploads}；files 表登记不变
    const root = uploadsWriteRoot(deps.config.dataDir, parentId, childId || null);
    fs.mkdirSync(root, { recursive: true });
    let abs: string;
    try {
      abs = resolveSafe(root, storedPath);
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
      // Web 前端 Phase 0：GET 二进制路由额外接受 ?token= query 认证（带头时优先用头，行为不变）
      parentId = authParentFlexible(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const { id } = req.params as { id: string };
    const row = deps.db
      .prepare("SELECT stored_path, mime, size, child_id FROM files WHERE id = ? AND parent_id = ?")
      .get(id, parentId) as { stored_path: string; mime: string; size: number; child_id: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: "文件不存在" });
    // P2：新根优先、旧根兜底（存量不迁移）
    const abs = resolveStoredFileAbs(deps.config.dataDir, parentId, row.child_id, row.stored_path);
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
      .prepare("SELECT stored_path, child_id FROM files WHERE id = ? AND parent_id = ?")
      .get(id, parentId) as { stored_path: string; child_id: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: "文件不存在" });
    const abs = resolveStoredFileAbs(deps.config.dataDir, parentId, row.child_id, row.stored_path);
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
