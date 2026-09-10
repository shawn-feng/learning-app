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
  uuid TEXT,
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

/**
 * 计划域 + 积分域（2026-09-10 重构，设计见 DESIGN-plan-domain-rewrite / DESIGN-reward-points）。
 * 全部在孩子库（孩子的记录：计划/考核成绩/生活/daily/统计同库，便于建视图与本地结算）。
 * - study_plans/exam_plans/life_plans：三张计划表，统一字段形态；creator=parent|child 即"必须完成项/加分项"。
 * - exam_plan_courses：考核范围（课程+知识点）→ 开考抽题后回填题目与得分（计划期不固化题目，保留随机抽题）。
 * - plan_recurrences：重复规则（自动排期展开成计划行）。
 * - reward_configs/reward_daily_stats/points_ledger/points_balance/redemption_*：积分域。
 */
export const KB_PLAN_SCHEMA_TABLES = `
-- ===== 学习计划（一行 = 一次学习任务，一课一行）=====
CREATE TABLE IF NOT EXISTS study_plans (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL DEFAULT '',
  child_id TEXT NOT NULL DEFAULT '',
  topic_key TEXT NOT NULL DEFAULT '',
  course_uuid TEXT NOT NULL DEFAULT '',
  course_name TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'new',
  creator TEXT NOT NULL DEFAULT 'parent',
  origin TEXT NOT NULL DEFAULT 'conversation',
  carry_from TEXT NOT NULL DEFAULT '',
  recurrence_id TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT NOT NULL DEFAULT '',
  done_at TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL DEFAULT 'required',
  count_in_rate INTEGER NOT NULL DEFAULT 1,
  points INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sp_child_window ON study_plans(child_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_sp_course ON study_plans(course_uuid);
CREATE INDEX IF NOT EXISTS idx_sp_creator ON study_plans(child_id, creator, active);

-- ===== 考核计划（场次头）=====
CREATE TABLE IF NOT EXISTS exam_plans (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL DEFAULT '',
  child_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL DEFAULT 'parent',
  kind TEXT NOT NULL DEFAULT 'fixed',
  freq TEXT NOT NULL DEFAULT '',
  scope_json TEXT NOT NULL DEFAULT '{}',
  origin TEXT NOT NULL DEFAULT 'conversation',
  recurrence_id TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_id TEXT NOT NULL DEFAULT '',
  score REAL,
  result TEXT NOT NULL DEFAULT '',
  done_at TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL DEFAULT 'required',
  count_in_rate INTEGER NOT NULL DEFAULT 1,
  points INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ep_child_window ON exam_plans(child_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_ep_creator ON exam_plans(child_id, creator, active);

-- ===== 考核计划课程明细（范围 → 开考回填结果）=====
CREATE TABLE IF NOT EXISTS exam_plan_courses (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  course_uuid TEXT NOT NULL DEFAULT '',
  course_name TEXT NOT NULL DEFAULT '',
  category_id TEXT NOT NULL DEFAULT '',
  knowledge_point_id TEXT NOT NULL DEFAULT '',
  question_id TEXT NOT NULL DEFAULT '',
  point_got REAL,
  point_max REAL,
  score REAL,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_epc_plan ON exam_plan_courses(plan_id, course_uuid);
CREATE INDEX IF NOT EXISTS idx_epc_kp ON exam_plan_courses(knowledge_point_id);

-- ===== 生活计划 =====
CREATE TABLE IF NOT EXISTS life_plans (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL DEFAULT '',
  child_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  creator TEXT NOT NULL DEFAULT 'parent',
  origin TEXT NOT NULL DEFAULT 'conversation',
  recurrence_id TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT NOT NULL DEFAULT '',
  done_at TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL DEFAULT 'required',
  count_in_rate INTEGER NOT NULL DEFAULT 1,
  points INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lp_child_window ON life_plans(child_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_lp_creator ON life_plans(child_id, creator, active);

-- ===== 排期（重复规则，自动排期用）=====
CREATE TABLE IF NOT EXISTS plan_recurrences (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL DEFAULT '',
  child_id TEXT NOT NULL DEFAULT '',
  plan_type TEXT NOT NULL DEFAULT 'life',
  payload_json TEXT NOT NULL DEFAULT '{}',
  rule TEXT NOT NULL DEFAULT 'daily',
  weekday INTEGER,
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  last_expanded_date TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recur_child ON plan_recurrences(child_id, enabled);

-- ===== 积分域 =====
CREATE TABLE IF NOT EXISTS reward_configs (
  child_id TEXT PRIMARY KEY,
  todo_tiers_json TEXT NOT NULL DEFAULT '[]',
  exam_tiers_json TEXT NOT NULL DEFAULT '[]',
  todo_gate_parent_min_rate REAL NOT NULL DEFAULT 1.0,
  exam_gate_parent_min_score REAL NOT NULL DEFAULT 0.9,
  child_no_deduct INTEGER NOT NULL DEFAULT 1,
  optional_points INTEGER NOT NULL DEFAULT 5,
  updated TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS reward_daily_stats (
  child_id TEXT NOT NULL,
  date TEXT NOT NULL,
  source TEXT NOT NULL,
  owner TEXT NOT NULL,
  required_total INTEGER NOT NULL DEFAULT 0,
  required_done INTEGER NOT NULL DEFAULT 0,
  optional_done INTEGER NOT NULL DEFAULT 0,
  missed_count INTEGER NOT NULL DEFAULT 0,
  cancelled_count INTEGER NOT NULL DEFAULT 0,
  rate REAL NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT '',
  gate_ok INTEGER,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  settled_at TEXT NOT NULL DEFAULT '',
  updated TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (child_id, date, source, owner)
);

CREATE TABLE IF NOT EXISTS points_ledger (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  biz_date TEXT NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL DEFAULT 0,
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  rate REAL,
  meta_json TEXT NOT NULL DEFAULT '',
  source_table TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_once
  ON points_ledger(child_id, biz_date, type, source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_ledger_child_date ON points_ledger(child_id, biz_date);

CREATE TABLE IF NOT EXISTS points_balance (
  child_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  updated TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS redemption_items (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  cost INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'inapp',
  payload_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  updated TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS redemption_requests (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL,
  item_id TEXT NOT NULL DEFAULT '',
  custom_desc TEXT NOT NULL DEFAULT '',
  cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  parent_id TEXT NOT NULL DEFAULT '',
  fulfilled_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rr_child ON redemption_requests(child_id, status);
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

/** 课程进度视图（2026-09-10 计划域）：掌握度=最近一次考核；学习状态=最近学习时间（只报时间）。 */
export const KB_PLAN_SCHEMA_VIEWS = `
CREATE VIEW IF NOT EXISTS course_progress AS
SELECT c.topic, c.title, c.uuid AS course_uuid,
  (SELECT MAX(p.done_at) FROM exam_plans p
     JOIN exam_plan_courses ec ON ec.plan_id = p.id AND ec.course_uuid = c.uuid
    WHERE p.status = 'done') AS lastExamAt,
  (SELECT ROUND(SUM(ec.point_got) * 1.0 / NULLIF(SUM(ec.point_max), 0), 4)
     FROM exam_plan_courses ec JOIN exam_plans p ON p.id = ec.plan_id
    WHERE ec.course_uuid = c.uuid AND p.status = 'done'
    GROUP BY ec.plan_id ORDER BY MAX(p.done_at) DESC LIMIT 1) AS lastExamRate,
  (SELECT MAX(s.done_at) FROM study_plans s
    WHERE s.course_uuid = c.uuid AND s.status = 'done') AS lastLearnedAt
FROM courses c;
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
  ensureCourseUuidColumn(db);
  db.exec(KB_PLAN_SCHEMA_TABLES); // 计划域 + 积分域（2026-09-10）
  ensureDailyPlanColumns(db);
  db.exec(KB_SCHEMA_VIEWS);
  db.exec(KB_PLAN_SCHEMA_VIEWS);
  return db;
}

/** 孩子库 courses 加 uuid（幂等）：课程真引用，供计划表/考核明细/课程进度视图 join。 */
function ensureCourseUuidColumn(db: DatabaseSync): void {
  try {
    const cols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("uuid")) {
      db.exec("ALTER TABLE courses ADD COLUMN uuid TEXT");
    }
  } catch {
    /* courses 不存在则忽略 */
  }
}

/** daily_entries 加 plan_id / plan_outcome（幂等）：生活计划证据（recording 写）+ 学习计划回写（stat 写）。 */
function ensureDailyPlanColumns(db: DatabaseSync): void {
  try {
    const cols = (db.prepare("PRAGMA table_info(daily_entries)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("plan_id")) db.exec("ALTER TABLE daily_entries ADD COLUMN plan_id TEXT NOT NULL DEFAULT ''");
    if (!cols.includes("plan_outcome")) db.exec("ALTER TABLE daily_entries ADD COLUMN plan_outcome TEXT NOT NULL DEFAULT ''");
  } catch {
    /* daily_entries 不存在则忽略 */
  }
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
