/**
 * 家长知识库（教学主题/资料统一管理，schema 平移自 electron/lib/parent-library.ts v1）。
 * 路径：<dataDir>/parents/<parentId>/parent.sqlite —— 家长维度，鉴权即家长身份。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { ensureAssessContentSchema } from "./assess-content.js";
import { ensureTier2Schema } from "../agent/tier2.js";

export const PARENT_SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS topics (
  name TEXT PRIMARY KEY,
  topic_key TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  assess_method TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  rules_json TEXT NOT NULL DEFAULT '{}'
);

-- 2026-09-18 库域分工：courses = 纯课程内容表；学习进度/状态（status/last_review/review_count）
-- 已删——进度真源在孩子库 courses（每个孩子各自的状态），家长端进度聚合实时读孩子库。
CREATE TABLE IF NOT EXISTS courses (
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
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

export function openParentLib(dataDir: string, parentId: string): DatabaseSync {
  const dir = path.join(dataDir, "parents", parentId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "parent.sqlite"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(PARENT_SCHEMA_TABLES);
  ensureParentColumns(db);
  ensureAssessContentSchema(db); // 考核内容结构化 v2：courses.uuid/topics.method_spec/三张新表（幂等）
  dropLegacyCourseColumns(db); // 2026-09-18 库域分工：status/last_review/review_count 下线（进度真源在孩子库）
  // topic_progress 视图随进度字段一起退役（建立在 status/last_review 上）；家长端进度改读孩子库聚合
  db.exec("DROP VIEW IF EXISTS topic_progress;");
  ensureTier2Schema(db, true); // Tier 2 灵活实体：entities + namespaces 注册行（F15a，幂等）
  return db;
}

/**
 * 家长库 courses 旧列下线（幂等）：2026-09-10 删 mastery/first_learned；
 * 2026-09-18 库域分工删 status/last_review/review_count（学习进度/状态，真源=孩子库 courses）。
 * 先删依赖这些列的 topic_progress 视图（openParentLib 尾部统一 DROP，本函数只在删列前兜底）。
 */
function dropLegacyCourseColumns(db: DatabaseSync): void {
  let cols: string[] = [];
  try {
    cols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
  } catch {
    return;
  }
  const targets = ["mastery", "first_learned", "status", "last_review", "review_count"].filter((c) =>
    cols.includes(c)
  );
  if (!targets.length) return;
  db.exec("DROP VIEW IF EXISTS topic_progress;");
  for (const c of targets) {
    try {
      db.exec(`ALTER TABLE courses DROP COLUMN ${c}`);
      console.log(`[parent-lib] courses 删列 ${c}（2026-09-10 计划域 / 2026-09-18 库域分工）`);
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
