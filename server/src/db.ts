import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/**
 * 打开服务端主库并初始化 schema。
 * M1：parents；M2：+ children；M3：+ settings（家长配置，revision 随 meta.config_revision）。
 * 孩子 kb / agents / 父库 均为独立文件，见 db/kb.ts、db/agents.ts、db/parent-lib.ts。
 */
export function openDb(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(path.join(dataDir, "server.sqlite"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS parents (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      plan TEXT,
      cloud_token TEXT,
      license_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS children (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_children_parent ON children(parent_id);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL DEFAULT '{}',
      updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS materials (
      parent_id TEXT NOT NULL,
      id TEXT NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'other',
      size INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (parent_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_materials_parent ON materials(parent_id);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      child_id TEXT,
      original_name TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_id);
  `);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '6')").run();
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('config_revision', '0')").run();
  // 旧库迁移：children 表加 profile_json（孩子详情 + 密码哈希上云，2026-08-30）
  try {
    db.exec("ALTER TABLE children ADD COLUMN profile_json TEXT");
  } catch {
    // 已存在则忽略
  }
  // 旧库迁移：materials 主键从单列 id（base64url(路径)）升级为复合主键 (parent_id, id)。
  // 旧设计跨家长同路径冲突：ON CONFLICT 只更新 size/updated_at 不更新 parent_id，
  // 导致后上传家长按 parent_id 查询不到自己的材料（list 空、content 404，2026-08-30 修复）。
  try {
    const oldSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='materials'").get() as
      | { sql?: string }
      | undefined)?.sql ?? "";
    if (oldSql.includes("id TEXT PRIMARY KEY")) {
      db.exec(`
        ALTER TABLE materials RENAME TO materials_old;
        CREATE TABLE materials (
          parent_id TEXT NOT NULL,
          id TEXT NOT NULL,
          path TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'other',
          size INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (parent_id, id)
        );
        INSERT INTO materials (parent_id, id, path, type, size, updated_at)
          SELECT parent_id, id, path, type, size, updated_at FROM materials_old;
        DROP TABLE materials_old;
        CREATE INDEX IF NOT EXISTS idx_materials_parent ON materials(parent_id);
      `);
    }
  } catch {
    // 新库无旧表则忽略
  }
  return db;
}

/** 读取全局配置 revision（未设置返回 0）。 */
export function getConfigRevision(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'config_revision'").get() as
    | { value: string }
    | undefined;
  return Number(row?.value ?? 0);
}

/** 配置变更后 revision +1，返回新值。 */
export function bumpConfigRevision(db: DatabaseSync): number {
  const next = getConfigRevision(db) + 1;
  db.prepare("UPDATE meta SET value = ? WHERE key = 'config_revision'").run(String(next));
  return next;
}

export function dbHealth(db: DatabaseSync): boolean {
  try {
    db.prepare("SELECT 1 AS ok").get();
    return true;
  } catch {
    return false;
  }
}
