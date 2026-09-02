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
    -- 会话 jsonl 增量同步（方案B 阶段①）：行级索引供家长回顾；child_id 全局唯一，
    -- 归属校验在路由层（children.parent_id）强制，故不重复存 parent_id。
    CREATE TABLE IF NOT EXISTS session_messages (
      child_id TEXT NOT NULL,
      file TEXT NOT NULL,
      line_index INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      date TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      tool_calls TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (child_id, file, line_index)
    );
    CREATE INDEX IF NOT EXISTS idx_session_messages_date ON session_messages(child_id, date, ts);
    -- 每个会话文件的同步游标（幂等 append 的权威记录，客户端权威冲突 → REPLACE by line_index）
    CREATE TABLE IF NOT EXISTS session_files (
      child_id TEXT NOT NULL,
      file TEXT NOT NULL,
      synced_bytes INTEGER NOT NULL DEFAULT 0,
      line_count INTEGER NOT NULL DEFAULT 0,
      updated TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (child_id, file)
    );
    -- 服务端无头 worker 的定时任务去重游标（每 child 每 task 一天一次）
    CREATE TABLE IF NOT EXISTS worker_state (
      child_id TEXT NOT NULL,
      task TEXT NOT NULL,
      last_run TEXT NOT NULL DEFAULT '',
      last_key TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (child_id, task)
    );
    -- 定时任务管理（新模型）：任务定义（先创建）→ 分配给孩子（再分配）→ 执行结果（task_runs）
    CREATE TABLE IF NOT EXISTS scheduler_tasks (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,             -- recording | todo_gen | todo_stat | auto_new_session
      time TEXT NOT NULL,             -- HH:mm
      extra_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_parent ON scheduler_tasks(parent_id);
    CREATE TABLE IF NOT EXISTS scheduler_task_assignments (
      task_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, child_id)
    );
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      task_id TEXT,
      task_name TEXT NOT NULL DEFAULT '',
      task_type TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      point TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ok',   -- ok | skip | error
      message TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_runs_parent ON task_runs(parent_id, date);
    -- 学习考核（EXAM-REQUIREMENTS.md）：每次考核一条记录（孩子端判分后客户端上报，服务端只存结果）。
    -- per_question 逐题明细(JSON)：qid/course/question/audioPath/asrText/startedAt/answeredAt/durationMs/pointGot/pointMax/correct/aiComment
    -- course_mastery(JSON)：{"<course>": {correct,total,rate}}；reinforce_plan(JSON)：{"<course>": {planReviewAt, focus[], aiSuggestion?}}
    CREATE TABLE IF NOT EXISTS exam_attempts (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      submitted_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'grading',
      score REAL NOT NULL DEFAULT 0,
      per_question TEXT NOT NULL DEFAULT '[]',
      course_mastery TEXT NOT NULL DEFAULT '{}',
      reinforce_plan TEXT NOT NULL DEFAULT '{}',
      wrong_questions TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_exam_attempts_child ON exam_attempts(child_id, submitted_at);
    -- 学习考核 v2（EXAM-REQUIREMENTS §14）：考核排期（固定频率生成 + 家长自定义），
    -- kind=fixed(固定频率) | custom(家长对话生成)；scope JSON：custom= {topics[],courses[],note}，fixed= {}；
    -- status=pending(待考核) | started(进行中) | done(已完成) | expired(过期未考)；attempt_id 关联 exam_attempts。
    CREATE TABLE IF NOT EXISTS exam_schedules (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fixed',
      freq TEXT NOT NULL DEFAULT '',
      scheduled_at TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_exam_schedules_child ON exam_schedules(child_id, scheduled_at);
  `);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '8')").run();
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('config_revision', '0')").run();
  // 旧库迁移：children 表加 profile_json（孩子详情 + 密码哈希上云，2026-08-30）
  try {
    db.exec("ALTER TABLE children ADD COLUMN profile_json TEXT");
  } catch {
    // 已存在则忽略
  }
  // 旧库迁移：exam_attempts 加 schedule_id（考核 v2 排期关联回填，2026-09-01）
  try {
    const examCols = (db.prepare("PRAGMA table_info(exam_attempts)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!examCols.includes("schedule_id")) {
      db.exec("ALTER TABLE exam_attempts ADD COLUMN schedule_id TEXT NOT NULL DEFAULT ''");
    }
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
