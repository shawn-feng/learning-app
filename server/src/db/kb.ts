/**
 * 孩子知识库（每孩子一个文件，schema 平移自 electron/lib/kb-sqlite.ts v4）。
 * 路径：<dataDir>/kb/<parentId>/<childId>.sqlite —— 归属即路径，鉴权在路由层强制。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const KB_SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS daily_entries (
  date TEXT NOT NULL,
  block TEXT NOT NULL,
  title TEXT NOT NULL,
  raw TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (date, block, title)
);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_entries(date);
CREATE INDEX IF NOT EXISTS idx_daily_block ON daily_entries(block);

CREATE TABLE IF NOT EXISTS courses (
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '⬜',
  mastery TEXT NOT NULL DEFAULT '',
  first_learned TEXT NOT NULL DEFAULT '',
  last_review TEXT NOT NULL DEFAULT '',
  review_count INTEGER NOT NULL DEFAULT 0,
  material TEXT NOT NULL DEFAULT '',
  send_material TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  lesson_method TEXT NOT NULL DEFAULT '',
  html_path TEXT NOT NULL DEFAULT '',
  teaching_copy TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (topic, title)
);
CREATE INDEX IF NOT EXISTS idx_courses_topic ON courses(topic, sort_order);

CREATE TABLE IF NOT EXISTS topics (
  name TEXT PRIMARY KEY,
  topic_key TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  rules_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS tags (
  tag TEXT PRIMARY KEY,
  dimension TEXT NOT NULL DEFAULT '',
  criteria TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export const KB_SCHEMA_VIEWS = `
CREATE VIEW IF NOT EXISTS topic_progress AS
SELECT
  topic,
  COUNT(*) AS total,
  SUM(CASE WHEN status = '✅' THEN 1 ELSE 0 END) AS learned,
  COALESCE(
    (SELECT c2.title FROM courses c2 WHERE c2.topic = courses.topic AND c2.status != '✅'
     ORDER BY c2.sort_order, c2.title LIMIT 1),
    ''
  ) AS next,
  COALESCE(
    MAX(CASE WHEN last_review IN ('', '-') THEN NULL ELSE last_review END),
    MAX(CASE WHEN first_learned IN ('', '-') THEN NULL ELSE first_learned END),
    ''
  ) AS updated
FROM courses
GROUP BY topic;
`;

export function openKb(dataDir: string, parentId: string, childId: string): DatabaseSync {
  const dir = path.join(dataDir, "kb", parentId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, `${childId}.sqlite`));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(KB_SCHEMA_TABLES);
  db.exec(KB_SCHEMA_VIEWS);
  return db;
}
