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

/** 递归收集目录下所有文件（相对 posix 路径）。
 * ⚠️ 不用 fs.readdirSync(recursive)：recursive 模式**不跟随目录符号链接**，会漏掉
 * 软链目录（如 english → ChildWeb/english-learner，2026-08-29 部署踩坑）。
 * 这里手写 walk：statSync follow 文件/目录软链接；realpath 去重防环。
 */
function walkFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue; // 目录不可达（坏链）跳过
    }
    if (seen.has(real)) continue; // 防环（软链接指回祖先）
    seen.add(real);
    let names: string[];
    try {
      names = fs.readdirSync(dir, { encoding: "utf-8" });
    } catch {
      continue; // 单目录不可读不中断整体扫描
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs); // follow 符号链接
      } catch {
        continue; // 坏链跳过
      }
      if (st.isDirectory()) {
        stack.push(abs);
      } else if (st.isFile()) {
        out.push(path.relative(root, abs).split(path.sep).join("/"));
      }
    }
  }
  return out;
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
    const rels = walkFilesRecursive(root);
    for (const posix of rels) {
      const abs = path.join(root, posix);
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
