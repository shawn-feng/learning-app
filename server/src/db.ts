import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import crypto from "node:crypto";

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
      type TEXT NOT NULL,             -- recording | todo_gen | todo_stat | auto_new_session | reminder
      time TEXT NOT NULL,             -- HH:mm（daily/weekly/interval 用；once 也填目标时刻便于展示）
      extra_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      -- ISSUE-047：孩子端 agent 自建定时提醒 + 频率 + 语音
      owner TEXT NOT NULL DEFAULT 'parent',   -- parent | child（孩子 agent 创建则为 child）
      frequency TEXT NOT NULL DEFAULT 'daily', -- once | daily | weekly | interval
      reminder_text TEXT,             -- 到点语音播报的提醒内容（reminder 类型用）
      weekday INTEGER,                -- weekly：0=周日..6=周六
      interval_minutes INTEGER,       -- interval：每隔 N 分钟
      voice INTEGER NOT NULL DEFAULT 1, -- 1=语音播报 0=仅通知
      fire_at TEXT,                   -- once：目标触发时间 ISO（<=now 即到期）
      last_fired_at TEXT,             -- 上次触发时间（daily/weekly 按「今天是否触发过」、interval 按间隔去重）
      expired INTEGER NOT NULL DEFAULT 0, -- once 触发后置 1，不再触发
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
    -- 学习计划（ISSUE-033 重构 2026-09-04）：家长对话制定 → 「每天学什么」排期（服务端为数据真源）。
    -- 每行 = 一门课的排期（不再 content JSON 数组塞多课）。mode 区分 学/复习；status/done_at 由 stat 在孩子当天
    -- 实际学/复习完对应课程后写入（家长面板与 carry 都直接读这两列，精确匹配，不靠文本前缀）。
    -- date=执行日期；origin=conversation（家长对话落库）| carry（服务端把昨日未完成顺延写为当天行）。
    CREATE TABLE IF NOT EXISTS study_plan_items (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      date TEXT NOT NULL DEFAULT '',
      topic_key TEXT NOT NULL DEFAULT '',
      course_name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'new',
      origin TEXT NOT NULL DEFAULT 'conversation',
      status TEXT NOT NULL DEFAULT 'pending',
      done_at TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_study_plan_child ON study_plan_items(child_id, date);
    CREATE INDEX IF NOT EXISTS idx_study_plan_parent ON study_plan_items(parent_id, date);
  `);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '10')").run();
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('config_revision', '0')").run();
  // 学习计划 v2 就地迁移（须在 meta 表建好后跑；不 DROP 旧数据，改成展开 content JSON → 一课一行）
  migrateStudyPlanV2(db);
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
  // 旧库迁移：scheduler_tasks 扩列（ISSUE-047 孩子端自建提醒 + 频率 + 语音，2026-09-04）
  try {
    const stCols = (db.prepare("PRAGMA table_info(scheduler_tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    const stAdd: Record<string, string> = {
      owner: "TEXT NOT NULL DEFAULT 'parent'",
      frequency: "TEXT NOT NULL DEFAULT 'daily'",
      reminder_text: "TEXT",
      weekday: "INTEGER",
      interval_minutes: "INTEGER",
      voice: "INTEGER NOT NULL DEFAULT 1",
      fire_at: "TEXT",
      last_fired_at: "TEXT",
      expired: "INTEGER NOT NULL DEFAULT 0",
    };
    for (const [col, def] of Object.entries(stAdd)) {
      if (!stCols.includes(col)) {
        db.exec(`ALTER TABLE scheduler_tasks ADD COLUMN ${col} ${def}`);
      }
    }
  } catch {
    // 新库无旧表则忽略
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

/**
 * 学习计划 v1→v2 就地迁移（2026-09-04）：若 study_plan_items 仍是旧结构（含 content JSON 一天多课），
 * 展开成「一课一行」新结构。不 DROP 旧数据（保住家长排期）。幂等：成功后写 meta study_plan_v2_migrated=1。
 * 只做结构性展开：mode 由「复习/温习」前缀判定；status 一律留 pending——启动后 worker stat 会按 courses
 * 当天活动把当天真正学完的课回写 done。孩子 kb 的旧 child_todos 迁移走 scripts/migrate-study-plan-v2.mts。
 */
function migrateStudyPlanV2(db: DatabaseSync): void {
  try {
    const oldPlanSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='study_plan_items'").get() as
      | { sql?: string }
      | undefined)?.sql ?? "";
    const done =
      (db.prepare("SELECT value FROM meta WHERE key='study_plan_v2_migrated'").get() as { value?: string } | undefined)
        ?.value === "1";
    if (!oldPlanSql.includes("content TEXT") || done) return;
    const oldRows = db
      .prepare(
        "SELECT id,parent_id,child_id,date,content,origin,active,created_at,updated_at FROM study_plan_items"
      )
      .all() as Array<{
      id: string; parent_id: string; child_id: string; date: string; content: string;
      origin: string; active: number; created_at: string; updated_at: string;
    }>;
    const now = new Date().toISOString();
    db.exec("BEGIN");
    db.exec("DROP TABLE IF EXISTS study_plan_items");
    db.exec(`
      CREATE TABLE IF NOT EXISTS study_plan_items (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        date TEXT NOT NULL DEFAULT '',
        topic_key TEXT NOT NULL DEFAULT '',
        course_name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'new',
        origin TEXT NOT NULL DEFAULT 'conversation',
        status TEXT NOT NULL DEFAULT 'pending',
        done_at TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_study_plan_child ON study_plan_items(child_id, date);
      CREATE INDEX IF NOT EXISTS idx_study_plan_parent ON study_plan_items(parent_id, date);
    `);
    const ins = db.prepare(
      `INSERT INTO study_plan_items
        (id,parent_id,child_id,date,topic_key,course_name,mode,origin,status,done_at,active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    let n = 0;
    for (const r of oldRows) {
      let items: Array<{ text?: string; topicKey?: string }> = [];
      try {
        const a = JSON.parse(r.content);
        items = Array.isArray(a) ? a : [];
      } catch {
        continue;
      }
      const seen = new Set<string>();
      for (const it of items) {
        if (!it || typeof it.text !== "string" || !it.text.trim()) continue;
        const t = it.text.trim();
        const rev = /^(?:复习|温习)\s*[:：]?\s*(.+)$/.exec(t);
        const course = rev ? rev[1].trim() : t.replace(/^[^：:]{1,4}[:：]\s*/, "").trim();
        if (!course) continue;
        const mode = rev ? "review" : "new";
        const k = `${mode}\u0000${course}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const topicKey = typeof it.topicKey === "string" && it.topicKey ? it.topicKey : "";
        ins.run(
          crypto.randomUUID(), r.parent_id, r.child_id, r.date, topicKey, course, mode,
          r.origin, "pending", "", r.active ? 1 : 0, r.created_at || now, r.updated_at || now
        );
        n++;
      }
    }
    db.exec("COMMIT");
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('study_plan_v2_migrated', '1')").run();
    console.log(`[db] study_plan_items v1→v2 就地转换 ${n} 条课程行（完成态待 stat 回写）`);
  } catch (e) {
    console.error("[db] study_plan_items 迁移失败：", (e as Error).message);
  }
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
