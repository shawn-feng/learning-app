/**
 * 家长知识库（教学主题/资料统一管理，schema 平移自 electron/lib/parent-library.ts v1）。
 * 路径：<dataDir>/parents/<parentId>/parent.sqlite —— 家长维度，鉴权即家长身份。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { ensureAssessContentSchema } from "./assess-content.js";

export const PARENT_SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS topics (
  name TEXT PRIMARY KEY,
  topic_key TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  assess_method TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  rules_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS courses (
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '⬜',
  -- 2026-09-10 计划域：mastery/first_learned 已删除（掌握度=最近一次考核；学习状态=最近学习时间）
  last_review TEXT NOT NULL DEFAULT '',
  review_count INTEGER NOT NULL DEFAULT 0,
  material TEXT NOT NULL DEFAULT '',
  send_material TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  lesson_method TEXT NOT NULL DEFAULT '',
  html_path TEXT NOT NULL DEFAULT '',
  teaching_copy TEXT NOT NULL DEFAULT '',
  assess_rubric TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (topic, title)
);
CREATE INDEX IF NOT EXISTS idx_parent_courses_topic ON courses(topic, sort_order);

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

export const PARENT_SCHEMA_VIEWS = `
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
    ''
  ) AS updated
FROM courses
GROUP BY topic;
`;

export function openParentLib(dataDir: string, parentId: string): DatabaseSync {
  const dir = path.join(dataDir, "parents", parentId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "parent.sqlite"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(PARENT_SCHEMA_TABLES);
  ensureParentColumns(db);
  ensureAssessContentSchema(db); // 考核内容结构化 v2：courses.uuid/topics.method_spec/三张新表（幂等）
  dropLegacyCourseColumns(db); // 2026-09-10：mastery/first_learned 下线（先于建视图）
  db.exec(PARENT_SCHEMA_VIEWS);
  return db;
}

/**
 * 家长库 courses 旧列下线（幂等，2026-09-10 计划域）：删 mastery / first_learned。
 * 先删依赖 first_learned 的 topic_progress 视图，删列后由 PARENT_SCHEMA_VIEWS 重建。
 */
function dropLegacyCourseColumns(db: DatabaseSync): void {
  let cols: string[] = [];
  try {
    cols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
  } catch {
    return;
  }
  const targets = ["mastery", "first_learned"].filter((c) => cols.includes(c));
  if (!targets.length) return;
  db.exec("DROP VIEW IF EXISTS topic_progress;");
  for (const c of targets) {
    try {
      db.exec(`ALTER TABLE courses DROP COLUMN ${c}`);
      console.log(`[parent-lib] courses 删列 ${c}（2026-09-10 计划域）`);
    } catch {
      /* 忽略：版本不支持则保留（读取侧已不使用） */
    }
  }
}

/** 家长库考核列就地迁移（幂等）：topics.assess_method（考核方法说明）、courses.assess_rubric（每课考核要点）。 */
function ensureParentColumns(db: DatabaseSync): void {
  const tCols = (db.prepare("PRAGMA table_info(topics)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!tCols.includes("assess_method")) {
    db.exec("ALTER TABLE topics ADD COLUMN assess_method TEXT NOT NULL DEFAULT ''");
  }
  const cCols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cCols.includes("assess_rubric")) {
    db.exec("ALTER TABLE courses ADD COLUMN assess_rubric TEXT NOT NULL DEFAULT ''");
  }
}
