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
  exam_mastery TEXT NOT NULL DEFAULT '',
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

-- ISSUE-025 重构（2026-09-04）：孩子 Todolist 从「一天一行 markdown」改为「一事一行」。
-- 每行 = 一条待办：source=parent（来自学习计划，由 gen 生成/stat 打勾，孩子只读）/ child（孩子自规划，孩子可增删）。
-- plan_id 关联主库 study_plan_items.id（家长规定项），stat 据此精确回写完成态。
-- status=pending|done；done_at=完成日期(YYYY-MM-DD，stat/recording 打勾写)；due_time=约定截止 HH:MM(孩子自规划可带)；
-- done_time=真实完成时刻(ISO，打勾时写，用于「是否按时」判定)；note=备注（顺延原因/孩子说明）。
CREATE TABLE IF NOT EXISTS todo_items (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL DEFAULT '',
  todo_date TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'child',
  plan_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  done_at TEXT NOT NULL DEFAULT '',
  due_time TEXT NOT NULL DEFAULT '',
  done_time TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todo_child_date ON todo_items(child_id, todo_date);
CREATE INDEX IF NOT EXISTS idx_todo_plan ON todo_items(plan_id);

-- ISSUE-025：每日完成统计（统计点 agent 打完勾后主进程解析落库，供「我的执行力」趋势）
CREATE TABLE IF NOT EXISTS child_todo_stats (
  date TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  parent_total INTEGER NOT NULL DEFAULT 0,
  parent_done INTEGER NOT NULL DEFAULT 0,
  self_total INTEGER NOT NULL DEFAULT 0,
  self_done INTEGER NOT NULL DEFAULT 0,
  rate REAL NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  updated TEXT NOT NULL DEFAULT ''
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
  // Todolist v2（2026-09-04）：child_todos(items_md) → todo_items(一事一行)。旧表不兼容直接 DROP。
  try {
    const oldSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='child_todos'").get() as
      | { sql?: string }
      | undefined)?.sql ?? "";
    if (oldSql.includes("items_md")) {
      db.exec("DROP TABLE IF EXISTS child_todos;");
    }
  } catch {
    // 忽略
  }
  db.exec(KB_SCHEMA_TABLES);
  ensureKbExamColumn(db);
  ensureTodoTimeColumns(db);
  db.exec(KB_SCHEMA_VIEWS);
  return db;
}

/** 孩子库 todo_items 时间列就地迁移（幂等）：加 due_time(约定截止 HH:MM)/done_time(真实完成时刻 ISO)。 */
function ensureTodoTimeColumns(db: DatabaseSync): void {
  let cols: string[] = [];
  try {
    cols = (db.prepare("PRAGMA table_info(todo_items)").all() as Array<{ name: string }>).map((c) => c.name);
  } catch {
    return; // todo_items 未建（无任何 todo 场景），忽略
  }
  if (!cols.includes("due_time")) {
    try { db.exec("ALTER TABLE todo_items ADD COLUMN due_time TEXT NOT NULL DEFAULT ''"); } catch { /* 忽略 */ }
  }
  if (!cols.includes("done_time")) {
    try { db.exec("ALTER TABLE todo_items ADD COLUMN done_time TEXT NOT NULL DEFAULT ''"); } catch { /* 忽略 */ }
  }
}

/** 孩子库考核列就地迁移（幂等）：courses.exam_mastery（考核掌握度，与引导 mastery 双轨）。 */
function ensureKbExamColumn(db: DatabaseSync): void {
  const cols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("exam_mastery")) {
    db.exec("ALTER TABLE courses ADD COLUMN exam_mastery TEXT NOT NULL DEFAULT ''");
  }
}
