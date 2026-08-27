/**
 * Materials 索引（DESIGN-SPLIT §6）：内容存服务端磁盘 <dataDir>/materials/<parentId>/，
 * 索引以磁盘 mtime 为 updated_at（发布即时间戳，D11：无版本切换/回滚）。
 * id = base64url(相对路径)（URL 安全，content/:id 解码后校验防穿越）。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface MaterialMeta {
  id: string;
  path: string;
  type: string;
  size: number;
  updated_at: string;
}

const TYPE_MAP: Record<string, string> = {
  html: "html",
  htm: "html",
  css: "css",
  js: "js",
  json: "json",
  md: "text",
  txt: "text",
  pdf: "other",
  mp4: "video",
  webm: "video",
  mp3: "audio",
  wav: "audio",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "image",
};

export function materialsRoot(dataDir: string, parentId: string): string {
  return path.join(dataDir, "materials", parentId);
}

export function inferType(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase().replace(".", "");
  return TYPE_MAP[ext] ?? "other";
}

export function encodeMaterialId(relPath: string): string {
  return Buffer.from(relPath, "utf-8").toString("base64url");
}

export function decodeMaterialId(id: string): string {
  return Buffer.from(id, "base64url").toString("utf-8");
}

/** 扫描磁盘材料目录，与索引表同步（新增/更新/删除）；返回该家长材料清单。 */
export function scanMaterials(
  db: DatabaseSync,
  dataDir: string,
  parentId: string
): MaterialMeta[] {
  const root = materialsRoot(dataDir, parentId);
  const found: MaterialMeta[] = [];

  if (fs.existsSync(root)) {
    const entries = fs.readdirSync(root, { recursive: true, encoding: "utf-8" }) as string[];
    for (const rel of entries) {
      const abs = path.join(root, rel);
      if (!fs.statSync(abs).isFile()) continue;
      const posix = rel.split(path.sep).join("/");
      const stat = fs.statSync(abs);
      const updatedAt = stat.mtime.toISOString();
      found.push({
        id: encodeMaterialId(posix),
        path: posix,
        type: inferType(posix),
        size: stat.size,
        updated_at: updatedAt,
      });
      db.prepare(
        `INSERT INTO materials (id, parent_id, path, type, size, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           size = excluded.size,
           updated_at = excluded.updated_at`
      ).run(encodeMaterialId(posix), parentId, posix, inferType(posix), stat.size, updatedAt);
    }
  }

  // 删除磁盘上已不存在的索引行
  const existing = new Set(found.map((f) => f.path));
  const dbRows = db
    .prepare("SELECT path FROM materials WHERE parent_id = ?")
    .all(parentId) as Array<{ path: string }>;
  for (const row of dbRows) {
    if (!existing.has(row.path)) {
      db.prepare("DELETE FROM materials WHERE parent_id = ? AND path = ?").run(parentId, row.path);
    }
  }
  return found;
}

/** 单文件落盘后更新索引（上传路径）。 */
export function upsertMaterialFile(
  db: DatabaseSync,
  dataDir: string,
  parentId: string,
  relPosix: string
): MaterialMeta {
  const abs = path.join(materialsRoot(dataDir, parentId), relPosix);
  const stat = fs.statSync(abs);
  const updatedAt = stat.mtime.toISOString();
  db.prepare(
    `INSERT INTO materials (id, parent_id, path, type, size, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       size = excluded.size,
       updated_at = excluded.updated_at`
  ).run(encodeMaterialId(relPosix), parentId, relPosix, inferType(relPosix), stat.size, updatedAt);
  return {
    id: encodeMaterialId(relPosix),
    path: relPosix,
    type: inferType(relPosix),
    size: stat.size,
    updated_at: updatedAt,
  };
}
