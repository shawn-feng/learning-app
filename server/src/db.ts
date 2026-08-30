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
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      path TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'other',
      size INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
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
