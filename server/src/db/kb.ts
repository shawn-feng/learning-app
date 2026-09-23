/**
 * 孩子知识库（每孩子一个文件，schema 平移自 electron/lib/kb-sqlite.ts v4）。
 * 路径：<dataDir>/kb/<parentId>/<childId>.sqlite —— 归属即路径，鉴权在路由层强制。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { ensureTier2Schema } from "../agent/tier2.js";

/** 展示登记（ISSUE-113）：display_content 推送后按 (会话种类, path) upsert 一条，
 *  会话重进时回填左侧资料列表（按 ts 升序=出现顺序），/reset 或跨天新会话时清空。 */
/** 错题/生字本（ISSUE-114）：单表 kind 区分（错题/生字/薄弱点），
 *  去重 UNIQUE(content,kind,course_ref) 落空 count+1（重复出现=未掌握的证据）；
 *  knowledge_point_id 为逻辑引用（家长库跨文件无 FK）+ name 快照防悬挂；
 *  错题是孩子私有学习数据——题库只被 question_id 引用，永不反向写入。 */
export const MISTAKE_DDL = `
CREATE TABLE IF NOT EXISTS mistake_book (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('wrong_question','unknown_word','weak_point')),
  content TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'conversation',
  source_ref TEXT NOT NULL DEFAULT '',
  question_id TEXT NOT NULL DEFAULT '',
  course_ref TEXT NOT NULL DEFAULT '',
  knowledge_point_id TEXT NOT NULL DEFAULT '',
  knowledge_point_name TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','mastered','dismissed')),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  mastered_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mistake_dedup ON mistake_book(content, kind, course_ref);
`;

export const DISPLAY_DDL = `
CREATE TABLE IF NOT EXISTS display_contents (
  child_key TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  PRIMARY KEY (child_key, path)
);`;

const KB_SCHEMA_TABLES = `
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

-- 2026-09-18 库域分工：courses = 纯学习进度表（教学字段真源在家长库，副本已删）；
-- topic_key 为真引用（→ topics.topic_key），topic 保留作显示名。
CREATE TABLE IF NOT EXISTS courses (
  topic TEXT NOT NULL,
  topic_key TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  uuid TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '⬜',
  -- 2026-09-10 计划域：mastery/exam_mastery/first_learned 已删除
  -- 掌握度 = course_progress 视图（最近一次考核）；学习状态 = 最近学习时间（last_review 语义扩展）
  last_review TEXT NOT NULL DEFAULT '',
  review_count INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '',
  -- ISSUE-135 P0（2026-09-23）掌握闭环：课程级掌握 + 教学建议，由每日 progressAnalysis 任务（第 3 环）写入。
  -- ⚠️ 列名必须避开 dropLegacyCourseColumns 的删除名单（mastery / exam_mastery / first_learned），
  -- 那三个是 2026-09-10 重构主动废弃的旧口径列，若同名会在每次开库时被误删。
  -- 比率与时间不在此重复存：lastExamRate/lastExamAt/lastLearnedAt 由 course_progress 视图实时算。
  mastery_level TEXT NOT NULL DEFAULT '',      -- not_started | learning | needs_review | mastered
  mastery_desc TEXT NOT NULL DEFAULT '',       -- 累计掌握叙述（最开始 → 中间 → 最新）
  teaching_advice TEXT NOT NULL DEFAULT '',    -- 下次教学建议（只增补，从不回写家长手写的方法字段）
  mastery_updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (topic, title)
);
CREATE INDEX IF NOT EXISTS idx_courses_topic ON courses(topic, sort_order);
CREATE INDEX IF NOT EXISTS idx_courses_topic_key ON courses(topic_key);

-- 2026-09-18：topics = 孩子的主题分配表（name/topic_key 关联家长库 + learn_type 必学/选学 + 孩子级规则）；
-- 教学方法 method / 主题进度 progress 已删（真源在家长库 / topic_progress 视图）
CREATE TABLE IF NOT EXISTS topics (
  name TEXT PRIMARY KEY,
  topic_key TEXT NOT NULL,
  learn_type TEXT NOT NULL DEFAULT 'required',
  rules_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS tags (
  tag TEXT PRIMARY KEY,
  dimension TEXT NOT NULL DEFAULT '',
  criteria TEXT NOT NULL DEFAULT ''
);

-- 2026-09-10 计划域重构：todo_items / child_todo_stats 已下线（todolist 动态查三张计划表；统计落 reward_daily_stats）。
-- 旧库中的这两张表不主动删除，供 migrate-plan-domain.mts 迁移读取，迁完即弃用。

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
  -- ISSUE-135 §3.4（D7）：本次学习的结果概要（课程层面；知识点级明细落 knowledge_point_records）。
  -- exam_plans 不加同类列——一次考核跨多门课，课程级概要按 (计划, 课程) 落 exam_course_results。
  result_summary TEXT NOT NULL DEFAULT '',
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

-- ===== 考核计划（一行 = 一条考核计划，进「今日计划」）=====
-- ISSUE-135 P0-a（2026-09-23）起：一次考核的结果分三层落在孩子库——
--   exam_plan_courses（逐题明细）/ exam_course_results（每课概要）/ knowledge_point_records（知识点情况）；
--   主库 exam_attempts 已废弃（逐题富信息原只存在主库该表，经确认放弃，见 ISSUE-135 §8.4）。
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
  -- ISSUE-115（2026-09-19）：当天重考标准（家长自然语言，如「错两题以上当天原题重考」）。
  -- ''=不重考；有值=评分结束后按该标准经 LLM 生成当天重考计划（服务端强制生成的计划本字段为 ''，防连环重考）。
  retake TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL DEFAULT 'required',
  count_in_rate INTEGER NOT NULL DEFAULT 1,
  points INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ep_child_window ON exam_plans(child_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_ep_creator ON exam_plans(child_id, creator, active);

-- 2026-09-14 kind 收敛（幂等迁移）：exam_plans.kind 只有 custom / fixed 两值；
-- 旧孩子自请行 kind='self' 统一归并为 'custom'（建单人由 creator='child' 区分）。
UPDATE exam_plans SET kind = 'custom' WHERE kind = 'self';

-- ===== 考核明细表（一行一题：本次考核这门课考了哪些题、每题得几分、孩子答了什么、老师怎么评）=====
-- ISSUE-135 §3.6：结构保持**逐题**（不收敛为一课一行）；P0-a 补题级富字段（承接原主库
-- exam_attempts.per_question，否则三处「考核记录」界面与「听原音」会失数据），并删除与
-- point_got 重复、全仓只写不读的 score 列（D12：得分率一律用显式 rate 表达）。
CREATE TABLE IF NOT EXISTS exam_plan_courses (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  course_uuid TEXT NOT NULL DEFAULT '',
  course_name TEXT NOT NULL DEFAULT '',
  knowledge_point_id TEXT NOT NULL DEFAULT '',
  knowledge_point_name TEXT NOT NULL DEFAULT '',
  question_id TEXT NOT NULL DEFAULT '',
  question_text TEXT NOT NULL DEFAULT '',
  ref_text TEXT NOT NULL DEFAULT '',
  point_got REAL,
  point_max REAL,
  correct INTEGER,                                   -- 1/0/NULL
  ai_comment TEXT NOT NULL DEFAULT '',
  asr_text TEXT NOT NULL DEFAULT '',
  audio_file_id TEXT NOT NULL DEFAULT '',            -- 录音引用（听原音）
  duration_ms INTEGER NOT NULL DEFAULT 0,
  behavior TEXT NOT NULL DEFAULT '',                 -- 题级行为：speech_recite / speech_read / generic
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

/**
 * ISSUE-135（2026-09-23）掌握闭环 —— 结果记录与累计表（全部在孩子库）。
 * - exam_course_results：课程**每次**考核的结果概要（一行 = 考核计划 × 课程）；第 3 环分析任务的直接读入。
 * - knowledge_point_records：知识点掌握情况流水（学习/考核同表，`source` 分类）；第 2 环产出。
 * - knowledge_point_progress：知识点**累计**掌握（自然语言叙述 + 档位 + 计数）；第 3 环产出。
 * - speech_assessments：题级口语评测存档（D13：从主库搬入孩子库 + 补 plan_id/course_uuid/question_id 关联）。
 * 知识点 id 是家长库 `knowledge_points.id` 的跨文件逻辑引用（无 FK），带 name 快照防悬挂 —— 与 mistake_book 同模式。
 */
export const KB_MASTERY_TABLES = `
-- ===== 课程每次考核结果概要（D7/D11）=====
CREATE TABLE IF NOT EXISTS exam_course_results (
  id             TEXT PRIMARY KEY,
  parent_id      TEXT NOT NULL DEFAULT '',
  child_id       TEXT NOT NULL,
  plan_id        TEXT NOT NULL,                 -- exam_plans.id（一次考核）
  attempt_ref    TEXT NOT NULL DEFAULT '',      -- 迁移溯源：旧主库 exam_attempts.id（新数据为空）
  topic_key      TEXT NOT NULL DEFAULT '',
  course_uuid    TEXT NOT NULL,
  course_name    TEXT NOT NULL DEFAULT '',
  exam_at        TEXT NOT NULL DEFAULT '',      -- 本次考核时间
  point_got      REAL NOT NULL DEFAULT 0,       -- 该课本次 Σ得分
  point_max      REAL NOT NULL DEFAULT 0,       -- 该课本次 Σ满分
  rate           REAL,                          -- 该课本次得分率 0~1（仍按实测值回填；显示层再换算百分数）
  question_count INTEGER NOT NULL DEFAULT 0,    -- 本次该课考了几道题
  course_summary TEXT NOT NULL DEFAULT '',      -- 课程结果概要（可重算）
  plan_review_at TEXT NOT NULL DEFAULT '',      -- 复习到期（承接旧 reinforce_plan.planReviewAt）
  focus_json     TEXT NOT NULL DEFAULT '[]',    -- 复习重点（承接旧 reinforce_plan.focus[]）
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (plan_id, course_uuid)
);
CREATE INDEX IF NOT EXISTS idx_ecr_child  ON exam_course_results(child_id, exam_at);
CREATE INDEX IF NOT EXISTS idx_ecr_course ON exam_course_results(course_uuid, exam_at);
CREATE INDEX IF NOT EXISTS idx_ecr_plan   ON exam_course_results(plan_id);

-- ===== 知识点掌握情况流水（§3.1，学习与考核同表）=====
CREATE TABLE IF NOT EXISTS knowledge_point_records (
  id                   TEXT PRIMARY KEY,
  parent_id            TEXT NOT NULL DEFAULT '',
  child_id             TEXT NOT NULL DEFAULT '',
  source               TEXT NOT NULL CHECK (source IN ('study','exam')),
  plan_id              TEXT NOT NULL DEFAULT '',          -- study_plans.id / exam_plans.id
  knowledge_point_id   TEXT NOT NULL,                     -- 家长库 knowledge_points.id
  knowledge_point_name TEXT NOT NULL DEFAULT '',          -- 快照防悬挂
  topic_key            TEXT NOT NULL DEFAULT '',
  course_uuid          TEXT NOT NULL DEFAULT '',
  course_name          TEXT NOT NULL DEFAULT '',
  record_at            TEXT NOT NULL DEFAULT '',
  outcome              TEXT NOT NULL DEFAULT '',          -- solid | partial | weak
  point_got            REAL,                              -- 考核：该知识点本次得分（学习 NULL）
  point_max            REAL,
  rate                 REAL,
  summary              TEXT NOT NULL DEFAULT '',          -- 本次情况描述
  detail_json          TEXT NOT NULL DEFAULT '{}',        -- 困难点/亮点/题目 id 列表
  source_ref           TEXT NOT NULL DEFAULT '',          -- 迁移溯源：旧 exam_attempts.id / daily 日期
  created_at           TEXT NOT NULL,
  UNIQUE (source, plan_id, course_uuid, knowledge_point_id)   -- 幂等
);
CREATE INDEX IF NOT EXISTS idx_kpr_kp     ON knowledge_point_records(knowledge_point_id, record_at);
CREATE INDEX IF NOT EXISTS idx_kpr_link   ON knowledge_point_records(plan_id, course_uuid);
CREATE INDEX IF NOT EXISTS idx_kpr_plan   ON knowledge_point_records(source, plan_id);
CREATE INDEX IF NOT EXISTS idx_kpr_course ON knowledge_point_records(course_uuid, record_at);
CREATE INDEX IF NOT EXISTS idx_kpr_child  ON knowledge_point_records(child_id, record_at);

-- ===== 知识点累计掌握（§3.2，第 3 环产出）=====
CREATE TABLE IF NOT EXISTS knowledge_point_progress (
  parent_id            TEXT NOT NULL DEFAULT '',
  child_id             TEXT NOT NULL,
  knowledge_point_id   TEXT NOT NULL,
  knowledge_point_name TEXT NOT NULL DEFAULT '',
  course_uuid          TEXT NOT NULL DEFAULT '',
  course_name          TEXT NOT NULL DEFAULT '',
  level                TEXT NOT NULL DEFAULT 'learning',  -- not_started|learning|needs_review|mastered
  mastery_desc         TEXT NOT NULL DEFAULT '',          -- 累计自然语言（最开始→中间→最新）
  study_count          INTEGER NOT NULL DEFAULT 0,
  exam_count           INTEGER NOT NULL DEFAULT 0,
  last_outcome         TEXT NOT NULL DEFAULT '',
  last_rate            REAL,
  first_at             TEXT NOT NULL DEFAULT '',
  last_at              TEXT NOT NULL DEFAULT '',
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (child_id, knowledge_point_id)
);

-- ===== 题级口语评测存档（D13：从主库搬入，与考核明细按 (plan_id,course_uuid,question_id) 关联）=====
CREATE TABLE IF NOT EXISTS speech_assessments (
  id              TEXT PRIMARY KEY,
  parent_id       TEXT NOT NULL DEFAULT '',
  child_id        TEXT NOT NULL,
  plan_id         TEXT NOT NULL DEFAULT '',   -- exam_plans.id
  course_uuid     TEXT NOT NULL DEFAULT '',
  question_id     TEXT NOT NULL DEFAULT '',   -- 关联 exam_plan_courses.question_id
  attempt_ref     TEXT NOT NULL DEFAULT '',   -- 迁移溯源：旧 exam_attempts.id
  topic_key       TEXT NOT NULL DEFAULT '',
  course_name     TEXT NOT NULL DEFAULT '',
  question_type   TEXT NOT NULL DEFAULT '',
  ref_text        TEXT NOT NULL DEFAULT '',
  audio_file_id   TEXT NOT NULL DEFAULT '',
  overall         REAL NOT NULL DEFAULT 0,
  pron            REAL NOT NULL DEFAULT 0,
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  detail_json     TEXT NOT NULL DEFAULT '{}',
  is_exam         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_speech_child    ON speech_assessments(child_id, created_at);
CREATE INDEX IF NOT EXISTS idx_speech_question ON speech_assessments(plan_id, course_uuid, question_id);
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
    ''
  ) AS updated
FROM courses
GROUP BY topic;
`;

/** 课程进度视图（2026-09-10 计划域；ISSUE-135 P0-a 改数据源）：掌握度=最近一次考核；学习状态=最近学习时间（只报时间）。
 *  数据源改为 exam_course_results（课程每次考核概要，单表直读，不必再按逐题明细 GROUP BY）；
 *  比率与时间只在视图算、不落列，避免与 courses 的四列掌握叙述重复存。
 *  ⚠️ 视图定义变更必须 DROP 后重建——`CREATE VIEW IF NOT EXISTS` 对已存在的旧视图是空操作。 */
export const KB_PLAN_SCHEMA_VIEWS = `
DROP VIEW IF EXISTS course_progress;
CREATE VIEW course_progress AS
SELECT c.topic, c.title, c.uuid AS course_uuid,
  (SELECT MAX(r.exam_at) FROM exam_course_results r WHERE r.course_uuid = c.uuid AND r.exam_at != '') AS lastExamAt,
  (SELECT r.rate FROM exam_course_results r
    WHERE r.course_uuid = c.uuid ORDER BY r.exam_at DESC, r.created_at DESC LIMIT 1) AS lastExamRate,
  (SELECT MAX(s.done_at) FROM study_plans s
    WHERE s.course_uuid = c.uuid AND s.status = 'done') AS lastLearnedAt
FROM courses c;
`;

export function openKb(dataDir: string, parentId: string, childId: string): DatabaseSync {
  const dir = path.join(dataDir, "kb", parentId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, `${childId}.sqlite`));
  db.exec("PRAGMA journal_mode = WAL;");
  // 2026-09-10 计划域重构：child_todos 是更早 v2（2026-09-04）的 Todolist 表，已被 todolist v2 → todo_items 替代，
  // 本次再迁入 todo_items → 三张计划表（学习/考核/生活）+ reward_daily_stats 之后，child_todos 也彻底不再需要。
  // 旧表若存在则直接 DROP（迁移幂等）。
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
  // 2026-09-18 库域分工迁移（幂等）：老库补 topic_key / learn_type 列——必须先于 schema 建索引，
  // 否则 CREATE INDEX idx_courses_topic_key 在缺列的老库上直接报错
  ensureCourseDomainColumns(db);
  db.exec(KB_SCHEMA_TABLES);
  ensureCourseMasteryColumns(db); // ISSUE-135 P0：courses 加掌握四列（必须在 dropLegacyCourseColumns 之前补列，且列名不得进其删除名单）
  dropLegacyCourseColumns(db); // mastery/exam_mastery/first_learned + 教学字段副本（material/lesson_method 等，真源在家长库）
  dropLegacyTopicColumns(db); // topics.method / topics.progress（教学方法真源家长库；进度看 topic_progress 视图）
  ensureCourseUuidColumn(db);
  backfillCourseTopicKey(db); // topic_key 回填：courses.topic → topics（name/topic_key 双匹配），孤儿行回退自身
  backfillTopicLearnType(db); // learn_type 回填：rules_json.type（必学/选学/复习）→ 枚举
  db.exec(KB_PLAN_SCHEMA_TABLES); // 计划域 + 积分域（2026-09-10）
  ensureDailyPlanColumns(db);
  ensureExamRetakeColumn(db); // ISSUE-115：exam_plans 加 retake（幂等，2026-09-19）
  ensureStudyPlanResultSummary(db); // ISSUE-135 P0：study_plans 加 result_summary
  ensureExamPlanCourseColumns(db); // ISSUE-135 P0-a：考核明细补题级富字段
  dropLegacyExamPlanCourseScore(db); // ISSUE-135 P0-a：删与 point_got 重复、只写不读的 score 列
  db.exec(KB_MASTERY_TABLES); // ISSUE-135：考核结果概要 / 知识点流水与累计 / 口语评测存档（幂等）
  dedupeLegacyExamPlanCourses(db); // ISSUE-135 §8.5①：老明细重复行清理（meta 游标，只跑一次）
  // 2026-09-18 F14：todo_items / child_todo_stats 是 2026-09-10 计划域重构后的废弃死表
  //（数据已迁三张计划表 + reward_daily_stats），不再登记进任何读面，直接 DROP（幂等）
  db.exec("DROP TABLE IF EXISTS todo_items;");
  db.exec("DROP TABLE IF EXISTS child_todo_stats;");
  ensureTier2Schema(db, false); // Tier 2 灵活实体数据行（scope=child 的 namespace 注册在家长库，F15a，幂等）
  db.exec(DISPLAY_DDL); // 展示登记（ISSUE-113，幂等）
  db.exec(MISTAKE_DDL); // 错题/生字本（ISSUE-114，幂等）
  db.exec(KB_SCHEMA_VIEWS);
  db.exec(KB_PLAN_SCHEMA_VIEWS);
  return db;
}

/**
 * 2026-09-18 库域分工（幂等）：courses 加 topic_key（真引用 → topics.topic_key）、topics 加 learn_type
 * （required=必学 / optional=选学 / review=复习，缺省 required）。只加列不回填——回填在 schema/删列之后统一做。
 */
function ensureCourseDomainColumns(db: DatabaseSync): void {
  try {
    const cCols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
    if (cCols.length && !cCols.includes("topic_key")) {
      db.exec("ALTER TABLE courses ADD COLUMN topic_key TEXT NOT NULL DEFAULT ''");
    }
  } catch {
    /* courses 不存在则忽略（新库由 CREATE TABLE 直接带上） */
  }
  try {
    const tCols = (db.prepare("PRAGMA table_info(topics)").all() as Array<{ name: string }>).map((c) => c.name);
    if (tCols.length && !tCols.includes("learn_type")) {
      db.exec("ALTER TABLE topics ADD COLUMN learn_type TEXT NOT NULL DEFAULT 'required'");
    }
  } catch {
    /* topics 不存在则忽略 */
  }
}

/** topic_key 回填（幂等）：按 topics.name 或 topics.topic_key 匹配 courses.topic；两处都没有时回退 topic 自身。 */
function backfillCourseTopicKey(db: DatabaseSync): void {
  try {
    const cols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("topic_key")) return;
    db.exec(`
      UPDATE courses SET topic_key = COALESCE(
        (SELECT t.topic_key FROM topics t WHERE t.name = courses.topic OR t.topic_key = courses.topic LIMIT 1),
        topic)
      WHERE topic_key = '' OR topic_key IS NULL
    `);
  } catch {
    /* 忽略 */
  }
}

/** learn_type 回填（幂等）：老数据把主题类型存在 rules_json.type（必学/选学/复习），迁到专列；只迁仍为缺省的行。 */
function backfillTopicLearnType(db: DatabaseSync): void {
  const zhMap: Record<string, string> = { 必学: "required", 选学: "optional", 复习: "review" };
  try {
    const rows = db.prepare("SELECT name, learn_type, rules_json FROM topics").all() as Array<{
      name: string;
      learn_type: string;
      rules_json: string;
    }>;
    for (const r of rows) {
      if (r.learn_type && r.learn_type !== "required") continue; // 已显式设置过，不覆盖
      let type = "";
      try {
        type = String(JSON.parse(r.rules_json || "{}")?.type ?? "");
      } catch {
        continue;
      }
      const mapped = zhMap[type] ?? (["required", "optional", "review"].includes(type) ? type : "");
      if (mapped && mapped !== r.learn_type) {
        db.prepare("UPDATE topics SET learn_type = ? WHERE name = ?").run(mapped, r.name);
      }
    }
  } catch {
    /* topics 不存在则忽略 */
  }
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

/** ISSUE-115（幂等）：exam_plans 加 retake（当天重考标准）。新建库由 CREATE TABLE 直接带上，老库这里补列。 */
function ensureExamRetakeColumn(db: DatabaseSync): void {
  try {
    const cols = (db.prepare("PRAGMA table_info(exam_plans)").all() as Array<{ name: string }>).map((c) => c.name);
    if (cols.length && !cols.includes("retake")) {
      db.exec("ALTER TABLE exam_plans ADD COLUMN retake TEXT NOT NULL DEFAULT ''");
    }
  } catch {
    /* exam_plans 不存在则忽略 */
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
  // 2026-09-10 收口修复：早期 life_plans 建表漏了 carry_from（/plans/today 与「顺延」标签都依赖），
  // 已建的老库这里幂等补列；新建库由上面的 CREATE TABLE 直接带上。
  try {
    const lpCols = (db.prepare("PRAGMA table_info(life_plans)").all() as Array<{ name: string }>).map((c) => c.name);
    if (lpCols.length && !lpCols.includes("carry_from")) {
      db.exec("ALTER TABLE life_plans ADD COLUMN carry_from TEXT NOT NULL DEFAULT ''");
    }
  } catch {
    /* life_plans 不存在则忽略 */
  }
}

/**
 * 孩子库 courses 旧列下线（幂等）：2026-09-10 删 mastery/exam_mastery/first_learned；
 * 2026-09-18 库域分工再删教学字段副本 material/send_material/lesson_method/html_path/teaching_copy
 * —— 教学内容真源在家长库，孩子端经 kb.courses.get / parent_content 实时读。
 */
function dropLegacyCourseColumns(db: DatabaseSync): void {
  let cols: string[] = [];
  try {
    cols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
  } catch {
    return; // courses 不存在则忽略
  }
  const targets = [
    "mastery",
    "exam_mastery",
    "first_learned",
    "material",
    "send_material",
    "lesson_method",
    "html_path",
    "teaching_copy",
  ].filter((c) => cols.includes(c));
  if (!targets.length) return;
  db.exec("DROP VIEW IF EXISTS topic_progress;");
  for (const c of targets) {
    try {
      db.exec(`ALTER TABLE courses DROP COLUMN ${c}`);
      console.log(`[kb] courses 删列 ${c}（2026-09-10 计划域 / 2026-09-18 库域分工：真源在家长库）`);
    } catch {
      /* SQLite 版本不支持 DROP COLUMN 则保留（读取侧已不使用） */
    }
  }
}

/**
 * ISSUE-135 P0（幂等）：courses 加掌握四列。新建库由 CREATE TABLE 直接带上，老库这里补列。
 * ⚠️ 与 dropLegacyCourseColumns 的删除名单**不得重名**：那三个旧口径列（mastery/exam_mastery/first_learned）
 * 会在每次开库时被幂等删掉，若复用同名，分析任务刚写的掌握度下次启动就没了。
 */
function ensureCourseMasteryColumns(db: DatabaseSync): void {
  let cols: string[] = [];
  try {
    cols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
  } catch {
    return; // courses 不存在则忽略
  }
  if (!cols.length) return;
  const add: Array<[string, string]> = [
    ["mastery_level", "TEXT NOT NULL DEFAULT ''"],
    ["mastery_desc", "TEXT NOT NULL DEFAULT ''"],
    ["teaching_advice", "TEXT NOT NULL DEFAULT ''"],
    ["mastery_updated_at", "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [col, def] of add) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE courses ADD COLUMN ${col} ${def}`);
  }
}

/** ISSUE-135 P0（幂等）：study_plans 加 result_summary（本次学习的结果概要）。 */
function ensureStudyPlanResultSummary(db: DatabaseSync): void {
  try {
    const cols = (db.prepare("PRAGMA table_info(study_plans)").all() as Array<{ name: string }>).map((c) => c.name);
    if (cols.length && !cols.includes("result_summary")) {
      db.exec("ALTER TABLE study_plans ADD COLUMN result_summary TEXT NOT NULL DEFAULT ''");
    }
  } catch {
    /* study_plans 不存在则忽略 */
  }
}

/** ISSUE-135 P0-a（幂等）：考核明细表补题级富字段（承接原主库 exam_attempts.per_question，三处考核界面靠它们回放）。 */
function ensureExamPlanCourseColumns(db: DatabaseSync): void {
  let cols: string[] = [];
  try {
    cols = (db.prepare("PRAGMA table_info(exam_plan_courses)").all() as Array<{ name: string }>).map((c) => c.name);
  } catch {
    return; // 表不存在则忽略
  }
  if (!cols.length) return;
  const add: Array<[string, string]> = [
    ["knowledge_point_name", "TEXT NOT NULL DEFAULT ''"],
    ["question_text", "TEXT NOT NULL DEFAULT ''"],
    ["ref_text", "TEXT NOT NULL DEFAULT ''"],
    ["correct", "INTEGER"],
    ["ai_comment", "TEXT NOT NULL DEFAULT ''"],
    ["asr_text", "TEXT NOT NULL DEFAULT ''"],
    ["audio_file_id", "TEXT NOT NULL DEFAULT ''"],
    ["duration_ms", "INTEGER NOT NULL DEFAULT 0"],
    ["behavior", "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [col, def] of add) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE exam_plan_courses ADD COLUMN ${col} ${def}`);
  }
}

/** ISSUE-135 P0-a（幂等）：删 exam_plan_courses.score —— 与该题 point_got 完全重复、全仓只写不读（D12）。 */
function dropLegacyExamPlanCourseScore(db: DatabaseSync): void {
  try {
    const cols = (db.prepare("PRAGMA table_info(exam_plan_courses)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("score")) return;
    db.exec("ALTER TABLE exam_plan_courses DROP COLUMN score");
    console.log("[kb] exam_plan_courses 删列 score（ISSUE-135：与 point_got 重复、只写不读）");
  } catch {
    /* SQLite 版本不支持 DROP COLUMN 则保留（读取侧已不使用） */
  }
}

/**
 * ISSUE-135 §8.5①（一次性，meta 游标防重跑）：老明细表有重复行 —— 旧数据的行数是其逐题数的 **2 倍**
 * （如 sch_1788400121 20 行 / 逐题 10 题）。根因是旧数据 question_id 为空导致去重键失效。
 * 按 (plan_id, course_uuid, question_id, seq) 去重，每组保留 rowid 最小的一行。
 */
function dedupeLegacyExamPlanCourses(db: DatabaseSync): void {
  try {
    const done = (db.prepare("SELECT value FROM meta WHERE key='issue135_epc_dedup'").get() as { value?: string } | undefined)?.value;
    if (done === "1") return;
    const before = (db.prepare("SELECT COUNT(*) AS c FROM exam_plan_courses").get() as { c: number }).c;
    db.exec(`
      DELETE FROM exam_plan_courses
       WHERE rowid NOT IN (
         SELECT MIN(rowid) FROM exam_plan_courses
         GROUP BY plan_id, course_uuid, question_id, seq
       );
    `);
    const after = (db.prepare("SELECT COUNT(*) AS c FROM exam_plan_courses").get() as { c: number }).c;
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('issue135_epc_dedup', '1')").run();
    if (before !== after) {
      console.log(`[kb] exam_plan_courses 去重（ISSUE-135 §8.5①）：${before} → ${after} 行`);
    }
  } catch {
    /* 表不存在/meta 未就绪则跳过 */
  }
}

/** 孩子库 topics 旧列下线（幂等，2026-09-18）：method（教学方法，真源家长库）/ progress（见 topic_progress 视图）。 */
function dropLegacyTopicColumns(db: DatabaseSync): void {
  let cols: string[] = [];
  try {
    cols = (db.prepare("PRAGMA table_info(topics)").all() as Array<{ name: string }>).map((c) => c.name);
  } catch {
    return; // topics 不存在则忽略
  }
  for (const c of ["method", "progress"].filter((x) => cols.includes(x))) {
    try {
      db.exec(`ALTER TABLE topics DROP COLUMN ${c}`);
      console.log(`[kb] topics 删列 ${c}（2026-09-18 库域分工：真源在家长库/进度视图）`);
    } catch {
      /* SQLite 版本不支持 DROP COLUMN 则保留（读取侧已不使用） */
    }
  }
}
