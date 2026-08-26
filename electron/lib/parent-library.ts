/**
 * 家长知识库（ISSUE-029）：教学主题与资料的统一管理库。
 *
 * 设计（2026-08-21 用户拍板）：
 *   - 父库 `data/parents/<parentId>/parent.sqlite` —— 教学主题的唯一真源；
 *   - `topics.method` 存 **method.md 全文**（不再存文件链接）；
 *   - `courses` 每课存 `lesson_method`（每课教学方法全文）+ `html_path`（学习资料 html 地址）；
 *   - html 资料文件放父库共享目录 `data/parents/<parentId>/materials/<topic>/*.html`，
 *     多孩子**共享同一份**（不按孩子复制）；
 *   - 家长把主题**分配**给孩子 = **快照拷贝**：topics/courses（含 lesson_method、html_path 指针）
 *     写入孩子 kb.sqlite；家长之后修改主题不影响已分配的孩子（重新分配才生效）。
 *
 * 当前为单家长应用，parentId 固定 `default`（未来可扩展多家长，所有函数均已参数化）。
 */

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "node:url";
import { getDataDir, getChildrenDir } from "./config";
import { buildAssetUrl } from "./media-protocol";
import { openKbDb, type CourseItem } from "./kb-sqlite";

export const DEFAULT_PARENT_ID = "default";

// ==================== 目录 ====================

export function getParentsDir(): string {
  return path.join(getDataDir(), "parents");
}

export function getParentDir(parentId: string = DEFAULT_PARENT_ID): string {
  const dir = path.join(getParentsDir(), parentId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 父库共享资料目录（html 文件唯一副本，多孩子共享）。 */
export function getParentMaterialsDir(parentId: string = DEFAULT_PARENT_ID): string {
  return path.join(getParentDir(parentId), "materials");
}

/** 家长聊天框上传文件的落盘目录（ISSUE-044 修正：家长聊天上传归到家长库 uploads，与孩子的 children/<id>/uploads 隔离）。 */
export function getParentUploadsDir(parentId: string = DEFAULT_PARENT_ID): string {
  return path.join(getParentDir(parentId), "uploads");
}

// ==================== 家长操作记录（activity-log.md，2026-08-24） ====================
// 家长 agent 对 app 的改动（新增/修改课程、写资料、调整配置等）记录到 markdown 文件，
// 便于家长回看「谁在什么时候改了什么」。位置：parents/{parentId}/activity-log.md。

export function getActivityLogPath(parentId: string = DEFAULT_PARENT_ID): string {
  return path.join(getParentDir(parentId), "activity-log.md");
}

/** 追加一条操作记录（首次自动创建表头；追加写，不覆盖历史）。 */
export function appendActivityLog(parentId: string, entry: string): void {
  const p = getActivityLogPath(parentId);
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (!fs.existsSync(p)) {
    fs.writeFileSync(
      p,
      "# 家长操作记录（activity-log）\n\n家长工作台助手对 app 的改动会记录在这里（新增/修改课程、写资料、调整配置等）。\n\n",
      "utf-8"
    );
  }
  fs.appendFileSync(p, `- ${ts}：${entry.trim()}\n`, "utf-8");
}

// ==================== schema（父库 v1） ====================

const PARENT_SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS topics (
  name TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  rules_json TEXT NOT NULL DEFAULT '{}'
);

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

const PARENT_SCHEMA_VIEWS = `
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

/** 打开（必要时创建）家长库 parent.sqlite；调用方负责 close。 */
export function openParentDb(parentId: string = DEFAULT_PARENT_ID): DatabaseSync {
  const db = new DatabaseSync(path.join(getParentDir(parentId), "parent.sqlite"));
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec(PARENT_SCHEMA_TABLES);
  ensureParentV2(db);
  ensureParentTags(db);
  // 视图已存在则跳过重建（避免每次打开都写锁；视图定义变更时才需要显式重建）
  const hasView = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'topic_progress'")
    .get();
  if (!hasView) {
    db.exec("DROP VIEW IF EXISTS topic_progress");
    db.exec(PARENT_SCHEMA_VIEWS);
  }
  return db;
}

/** 父库 v1 → v2 就地迁移：courses 加 teaching_copy（教学文案全文）列。幂等。 */
function ensureParentV2(db: DatabaseSync): void {
  const cols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("teaching_copy")) {
    db.exec("ALTER TABLE courses ADD COLUMN teaching_copy TEXT NOT NULL DEFAULT ''");
  }
}

// 受控标签词表（初版 20 个，四维）。家长给孩子课程打标签只能从本表选（ISSUE-045：选项从数据库获取）。
// 与 initChildKb 的 DEFAULT_TAGS 同源设计，父库独立维护一份便于后续家长自定义维度/标准。
const PARENT_DEFAULT_TAGS: Array<{ tag: string; dimension: string; criteria: string }> = [
  { tag: "诚实", dimension: "品格", criteria: "不撒谎，说真话" },
  { tag: "自律", dimension: "品格", criteria: "管住自己，该做什么就做什么" },
  { tag: "责任", dimension: "品格", criteria: "做好自己该做的事" },
  { tag: "坚持", dimension: "品格", criteria: "遇到困难不放弃" },
  { tag: "感恩", dimension: "品格", criteria: "感谢别人的帮助和付出" },
  { tag: "勇敢", dimension: "品格", criteria: "面对害怕的事不退缩" },
  { tag: "谦虚", dimension: "品格", criteria: "不自满，愿意向别人学习" },
  { tag: "亲情", dimension: "关系", criteria: "和家人之间的爱" },
  { tag: "友情", dimension: "关系", criteria: "和朋友之间的情谊" },
  { tag: "助人", dimension: "关系", criteria: "主动帮助别人" },
  { tag: "分享", dimension: "关系", criteria: "愿意和别人一起分享" },
  { tag: "礼貌", dimension: "关系", criteria: "对人友善、有礼" },
  { tag: "开心", dimension: "情绪", criteria: "高兴、愉快" },
  { tag: "难过", dimension: "情绪", criteria: "伤心、不开心" },
  { tag: "生气", dimension: "情绪", criteria: "发怒、不满" },
  { tag: "害怕", dimension: "情绪", criteria: "恐惧、担心" },
  { tag: "学习习惯", dimension: "学习", criteria: "按时学习、认真完成等好习惯" },
  { tag: "好奇心", dimension: "学习", criteria: "对新事物感兴趣、爱问为什么" },
  { tag: "专注", dimension: "学习", criteria: "专心做一件事" },
  { tag: "兴趣", dimension: "学习", criteria: "对某个领域的喜爱" },
];

/** 父库标签定义表播种（空表才种，幂等）。 */
function ensureParentTags(db: DatabaseSync): void {
  const cnt = (db.prepare("SELECT COUNT(*) AS c FROM tags").get() as { c: number }).c;
  if (cnt === 0) {
    const ins = db.prepare("INSERT OR IGNORE INTO tags (tag, dimension, criteria) VALUES (?, ?, ?)");
    for (const t of PARENT_DEFAULT_TAGS) ins.run(t.tag, t.dimension, t.criteria);
  }
}

/** 父库标签定义（tags 表一行）：词表 + 判断标准。 */
export interface ParentTagDef {
  tag: string;
  dimension: string;
  criteria: string;
}

/** 查询父库标签定义表（tag 缺省 = 全部，按维度、词序返回）。 */
export function queryParentTags(parentId: string = DEFAULT_PARENT_ID, tag?: string): ParentTagDef[] {
  const db = openParentDb(parentId);
  try {
    const rows = tag
      ? db.prepare("SELECT tag, dimension, criteria FROM tags WHERE tag = ?").all(tag)
      : db.prepare("SELECT tag, dimension, criteria FROM tags ORDER BY dimension, tag").all();
    return rows as unknown as ParentTagDef[];
  } finally {
    db.close();
  }
}

/** 新增 / 更新父库标签定义（家长自由新增标签写回定义表；INSERT OR REPLACE 语义）。 */
export function upsertParentTag(
  parentId: string = DEFAULT_PARENT_ID,
  tag: string,
  dimension = "",
  criteria = ""
): void {
  const db = openParentDb(parentId);
  try {
    db.prepare("INSERT OR REPLACE INTO tags (tag, dimension, criteria) VALUES (?, ?, ?)").run(tag, dimension, criteria);
  } finally {
    db.close();
  }
}

// ==================== 查询 ====================

export interface ParentTopic {
  name: string; // 主题中文名（如 论语）
  file: string; // 主题目录名（如 lunyu）
  method: string; // method.md 全文
  rules: Record<string, string>;
  learned: number;
  total: number;
  htmlCount: number; // 该主题父库已有 html 资料数
}

export function listParentTopics(parentId: string = DEFAULT_PARENT_ID): ParentTopic[] {
  const db = openParentDb(parentId);
  try {
    const rows = db.prepare("SELECT name, file, method, rules_json FROM topics ORDER BY name").all() as unknown as Array<{
      name: string;
      file: string;
      method: string;
      rules_json: string;
    }>;
    const agg = db.prepare("SELECT topic, learned, total FROM topic_progress").all() as unknown as Array<{
      topic: string;
      learned: number;
      total: number;
    }>;
    const aggMap = new Map(agg.map((a) => [a.topic, a]));
    return rows.map((r) => {
      let rules: Record<string, string> = {};
      try {
        rules = JSON.parse(r.rules_json || "{}");
      } catch {
        rules = {};
      }
      const topicDir = r.file.split("/")[0];
      const a = aggMap.get(topicDir);
      const materialsDir = path.join(getParentMaterialsDir(parentId), topicDir);
      let htmlCount = 0;
      if (fs.existsSync(materialsDir)) {
        htmlCount = fs.readdirSync(materialsDir).filter((f) => f.endsWith(".html") || f.endsWith(".htm")).length;
      }
      return {
        name: r.name,
        file: r.file,
        method: r.method,
        rules,
        learned: Number(a?.learned) || 0,
        total: Number(a?.total) || 0,
        htmlCount,
      };
    });
  } finally {
    db.close();
  }
}

export function listParentTopicCourses(parentId: string, topicDir: string): CourseItem[] {
  const db = openParentDb(parentId);
  try {
    const rows = db
      .prepare("SELECT * FROM courses WHERE topic = ? ORDER BY sort_order, title")
      .all(topicDir) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToParentCourse);
  } finally {
    db.close();
  }
}

function rowToParentCourse(r: Record<string, unknown>): CourseItem {
  return {
    topic: String(r.topic),
    title: String(r.title),
    sortOrder: Number(r.sort_order) || 0,
    status: String(r.status ?? "⬜"),
    mastery: String(r.mastery ?? ""),
    firstLearned: String(r.first_learned ?? ""),
    lastReview: String(r.last_review ?? ""),
    reviewCount: Number(r.review_count) || 0,
    material: String(r.material ?? ""),
    sendMaterial: String(r.send_material ?? ""),
    tags: String(r.tags ?? ""),
    lessonMethod: String(r.lesson_method ?? ""),
    htmlPath: String(r.html_path ?? ""),
    teachingCopy: String(r.teaching_copy ?? ""),
  };
}

/** 解析 html 相对路径（相对父库根，如 `materials/lunyu/论语为政篇第一章.html`）为绝对路径。 */
export function resolveParentMaterial(parentId: string, htmlPath: string): string {
  return path.join(getParentDir(parentId), htmlPath);
}

/**
 * 家长端写入/更新主题（由家长制作教学内容后调用，或迁移导入用）。
 * upsert 语义：topics 按 name 覆盖；courses 按 (topic,title) 覆盖 content 字段、
 * 但**不覆盖** status/mastery/first_learned/last_review/review_count（进度属于孩子，家长库只存内容）。
 */
export function upsertParentTopic(
  parentId: string,
  topic: { name: string; file: string; method: string; progress?: string; rules?: Record<string, string> },
  courses: Array<{
    title: string;
    sortOrder?: number;
    material?: string;
    sendMaterial?: string;
    tags?: string;
    lessonMethod?: string;
    htmlPath?: string;
    teachingCopy?: string;
  }>
): { topics: number; courses: number } {
  const db = openParentDb(parentId);
  try {
    db.exec("BEGIN");
    try {
      db.prepare(
        "INSERT INTO topics (name, file, method, progress, rules_json) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(name) DO UPDATE SET file = excluded.file, method = excluded.method, " +
          "progress = excluded.progress, rules_json = excluded.rules_json"
      ).run(topic.name, topic.file, topic.method, topic.progress || "", JSON.stringify(topic.rules || {}));

      const upsert = db.prepare(
        "INSERT INTO courses (topic, title, sort_order, status, mastery, first_learned, last_review, review_count, material, send_material, tags, lesson_method, html_path, teaching_copy) " +
          "VALUES (?, ?, ?, '⬜', '', '', '', 0, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(topic, title) DO UPDATE SET sort_order = excluded.sort_order, material = excluded.material, " +
          "send_material = excluded.send_material, tags = excluded.tags, lesson_method = excluded.lesson_method, html_path = excluded.html_path, teaching_copy = excluded.teaching_copy"
      );
      for (const c of courses) {
        upsert.run(topic.file.split("/")[0], c.title, c.sortOrder ?? 0, c.material || "", c.sendMaterial || "", c.tags || "", c.lessonMethod || "", c.htmlPath || "", c.teachingCopy || "");
      }
      const topics = (db.prepare("SELECT COUNT(*) AS c FROM topics").get() as { c: number }).c;
      const cnt = (db.prepare("SELECT COUNT(*) AS c FROM courses WHERE topic = ?").get(topic.file.split("/")[0]) as { c: number }).c;
      db.exec("COMMIT");
      return { topics, courses: cnt };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.close();
  }
}

/**
 * 分配主题给孩子（快照拷贝）：把家长库的 topics 行 + courses 内容字段拷贝进孩子 kb.sqlite。
 * - html 不复制（共享，孩子 courses.html_path 直接指向父库共享目录）；
 * - 孩子已有课程行（含进度）**不覆盖**（INSERT OR IGNORE 内容字段只填充新课程）；
 * - 幂等：重复分配不会丢孩子进度。
 *
 * @returns 拷贝的课程数 / 已存在的课程数
 */
export function allocateTopicToChild(
  parentId: string,
  childId: string,
  topicDir: string
): { copied: number; existing: number } {
  const childDir = path.join(getChildrenDir(), childId);
  const parentCourses = listParentTopicCourses(parentId, topicDir);
  const db = openParentDb(parentId);
  let topicRow: { name: string; method: string; rules_json: string } | undefined;
  try {
    topicRow = db.prepare("SELECT name, method, rules_json FROM topics WHERE file LIKE ?").get(`%${topicDir}%`) as
      | { name: string; method: string; rules_json: string }
      | undefined;
  } finally {
    db.close();
  }

  const childDb = openKbDb(childDir);
  try {
    childDb.exec("BEGIN");
    try {
      if (topicRow) {
        // 只记主题名/目录/规则，**不拷贝 method 全文**（孩子端经 parent_content 工具从家长库取，见 ISSUE-029）
        childDb
          .prepare(
            "INSERT INTO topics (name, file, method, progress, rules_json) VALUES (?, ?, '', '', ?) " +
              "ON CONFLICT(name) DO UPDATE SET file = excluded.file, method = '', rules_json = excluded.rules_json"
          )
          .run(topicRow.name, topicDir, topicRow.rules_json);
      }
      const existsCheck = childDb.prepare("SELECT 1 FROM courses WHERE topic = ? AND title = ?");
      const insertNew = childDb.prepare(
        "INSERT INTO courses (topic, title, sort_order, status, mastery, material, send_material, tags, lesson_method, html_path) " +
          "VALUES (?, ?, ?, '⬜', '', ?, ?, ?, ?, ?)"
      );
      const updateContent = childDb.prepare(
        "UPDATE courses SET sort_order = ?, material = ?, send_material = ?, tags = ?, lesson_method = ?, html_path = ? WHERE topic = ? AND title = ?"
      );
      let copied = 0;
      let existing = 0;
      for (const c of parentCourses) {
        if (existsCheck.get(topicDir, c.title)) {
          // 已存在（孩子有进度）：只补齐内容字段（不含 teaching_copy——孩子库不存教学文案），进度/掌握度原样保留
          updateContent.run(c.sortOrder, c.material, c.sendMaterial, c.tags, c.lessonMethod, c.htmlPath, topicDir, c.title);
          existing++;
        } else {
          insertNew.run(topicDir, c.title, c.sortOrder, c.material, c.sendMaterial, c.tags, c.lessonMethod, c.htmlPath);
          copied++;
        }
      }
      childDb.exec("COMMIT");
      return { copied, existing };
    } catch (e) {
      childDb.exec("ROLLBACK");
      throw e;
    }
  } finally {
    childDb.close();
  }
}

/** 孩子已分配的主题清单（读取孩子 kb.sqlite 的 topics 表；无库返回空）。用于孩子管理页展示「已添加的主题」。 */
export function listChildAllocatedTopics(
  childId: string
): Array<{ name: string; file: string; daily: string; type: string }> {
  const childDir = path.join(getChildrenDir(), childId);
  if (!fs.existsSync(path.join(childDir, "kb.sqlite"))) return [];
  const db = openKbDb(childDir);
  try {
    const rows = db.prepare("SELECT name, file, rules_json FROM topics ORDER BY file").all() as unknown as Array<{
      name: string;
      file: string;
      rules_json: string;
    }>;
    return rows.map((r) => {
      let daily = "";
      let type = "";
      try {
        const parsed = JSON.parse(r.rules_json || "{}") as { daily?: string; type?: string };
        daily = parsed.daily || "";
        type = parsed.type || "";
      } catch {
        /* 损坏的 rules_json 视为空 */
      }
      return { name: r.name, file: r.file.split("/")[0], daily, type };
    });
  } finally {
    db.close();
  }
}

/**
 * 设置孩子某主题的「每天学习量」（ISSUE-031）。
 * 写入孩子库 topics.rules_json 的 `daily` / `type` 字段；该字段随分配从父库带入快照，
 * 之后每孩子可独立修改，不影响父库默认值。幂等：主题不存在则忽略。
 */
export function setChildTopicDaily(
  childId: string,
  topicDir: string,
  daily: string,
  type: string
): boolean {
  const childDir = path.join(getChildrenDir(), childId);
  if (!fs.existsSync(path.join(childDir, "kb.sqlite"))) return false;
  const db = openKbDb(childDir);
  try {
    const row = db.prepare("SELECT rules_json FROM topics WHERE file LIKE ?").get(`%${topicDir}%`) as
      | { rules_json: string }
      | undefined;
    if (!row) return false;
    let parsed: { daily?: string; type?: string; [k: string]: unknown } = {};
    try {
      parsed = JSON.parse(row.rules_json || "{}");
    } catch {
      parsed = {};
    }
    parsed.daily = daily;
    parsed.type = type;
    db.prepare("UPDATE topics SET rules_json = ? WHERE file LIKE ?").run(
      JSON.stringify(parsed),
      `%${topicDir}%`
    );
    return true;
  } finally {
    db.close();
  }
}

// ==================== 孩子端「从家长库取内容」（ISSUE-029 专用工具后端） ====================

export type ParentContentType = "method" | "teachingCopy" | "htmlPath";

/**
 * 孩子端专用工具后端：从家长库取主题教学方法 / 课程教学文案 / 课程 html 资料路径。
 * 设计：孩子库**不冗余存** method 与 teaching_copy（分配时不再拷贝），需要时经本函数从家长库查；
 * htmlPath 也以家长库为准（返回家长库相对路径 `materials/<topic>/<file>.html`，可直接传给 display_content）。
 * **隔离约束**：先校验该孩子确实分配了这个主题（读孩子 topics 表），未分配一律拒绝，防越权读家长库。
 */
export function getParentContentForChild(
  childId: string,
  topicDir: string,
  type: ParentContentType,
  courseTitle?: string
): { found: boolean; content: string } {
  // 1) 校验分配
  const allocated = listChildAllocatedTopics(childId);
  if (!allocated.some((t) => t.file === topicDir)) {
    return { found: false, content: "" };
  }
  // 2) 从家长库查内容
  const db = openParentDb(DEFAULT_PARENT_ID);
  try {
    if (type === "method") {
      const row = db.prepare("SELECT method FROM topics WHERE file LIKE ?").get(`%${topicDir}%`) as
        | { method: string }
        | undefined;
      if (row?.method) return { found: true, content: row.method };
      return { found: false, content: "" };
    }
    // teachingCopy / htmlPath 都按课程查
    if (!courseTitle) return { found: false, content: "" };
    const row = db.prepare("SELECT teaching_copy, html_path FROM courses WHERE topic = ? AND title = ?").get(topicDir, courseTitle) as
      | { teaching_copy: string; html_path: string }
      | undefined;
    if (!row) return { found: false, content: "" };
    if (type === "teachingCopy") {
      if (row.teaching_copy) return { found: true, content: row.teaching_copy };
      return { found: false, content: "" };
    }
    // htmlPath：返回家长库相对路径，且校验文件真实存在（避免返回失效指针）
    if (row.html_path) {
      const abs = resolveParentMaterial(DEFAULT_PARENT_ID, row.html_path);
      if (fs.existsSync(abs)) return { found: true, content: row.html_path };
    }
    return { found: false, content: "" };
  } finally {
    db.close();
  }
}

// ==================== 课程管理（家长端增删改 + 资料上传） ====================

/**
 * 家长库课程 upsert（课程管理页用）：只写内容字段（lesson_method/html_path/material/send_material/tags/sort_order），
 * 进度字段一律 ⬜/空（进度属于孩子，家长库只存内容）。
 * 覆盖语义：**只覆盖传入的非空内容字段**（NULLIF-COALESCE），未传的字段保留旧值——
 * 避免「自动关联 html 资料」或「只改标题」时把其它字段清空。
 */
export function upsertParentCourse(
  parentId: string,
  topicDir: string,
  c: {
    title: string;
    sortOrder?: number;
    material?: string;
    sendMaterial?: string;
    tags?: string;
    lessonMethod?: string;
    htmlPath?: string;
    teachingCopy?: string;
  }
): boolean {
  const db = openParentDb(parentId);
  try {
    db.prepare(
      "INSERT INTO courses (topic, title, sort_order, status, mastery, first_learned, last_review, review_count, material, send_material, tags, lesson_method, html_path, teaching_copy) " +
        "VALUES (?, ?, ?, '⬜', '', '', '', 0, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(topic, title) DO UPDATE SET " +
        "sort_order = COALESCE(excluded.sort_order, courses.sort_order), " +
        "material = COALESCE(NULLIF(excluded.material, ''), courses.material), " +
        "send_material = COALESCE(NULLIF(excluded.send_material, ''), courses.send_material), " +
        "tags = COALESCE(NULLIF(excluded.tags, ''), courses.tags), " +
        "lesson_method = COALESCE(NULLIF(excluded.lesson_method, ''), courses.lesson_method), " +
        "html_path = COALESCE(NULLIF(excluded.html_path, ''), courses.html_path), " +
        "teaching_copy = COALESCE(NULLIF(excluded.teaching_copy, ''), courses.teaching_copy)"
    ).run(
      topicDir,
      c.title,
      c.sortOrder ?? 0,
      c.material || "",
      c.sendMaterial || "",
      c.tags || "",
      c.lessonMethod || "",
      c.htmlPath || "",
      c.teachingCopy || ""
    );
    return true;
  } finally {
    db.close();
  }
}

/** 删除家长库课程（同时不删共享 html 文件，避免其它主题/孩子引用失效）。 */
export function deleteParentCourse(parentId: string, topicDir: string, title: string): boolean {
  const db = openParentDb(parentId);
  try {
    const r = db.prepare("DELETE FROM courses WHERE topic = ? AND title = ?").run(topicDir, title);
    return r.changes > 0;
  } finally {
    db.close();
  }
}

/**
 * 调整家长库课程顺序（课程管理页「上移/下移」）：与相邻课程交换 sort_order。
 * direction: -1 上移 / 1 下移；越界或不存在返回 false。
 */
export function moveParentCourse(parentId: string, topicDir: string, title: string, direction: -1 | 1): boolean {
  const db = openParentDb(parentId);
  try {
    const rows = db
      .prepare("SELECT title, sort_order FROM courses WHERE topic = ? ORDER BY sort_order, title")
      .all(topicDir) as unknown as Array<{ title: string; sort_order: number }>;
    const idx = rows.findIndex((r) => r.title === title);
    const j = idx + direction;
    if (idx < 0 || j < 0 || j >= rows.length) return false;
    const a = rows[idx];
    const b = rows[j];
    const tmp = a.sort_order;
    db.prepare("UPDATE courses SET sort_order = ? WHERE topic = ? AND title = ?").run(b.sort_order, topicDir, a.title);
    db.prepare("UPDATE courses SET sort_order = ? WHERE topic = ? AND title = ?").run(tmp, topicDir, b.title);
    return true;
  } finally {
    db.close();
  }
}

/** 读取父库共享资料文件（课程详情「学习材料 html 渲染」用）：按相对父库根路径读文件，防目录穿越。 */
export function readParentMaterial(
  parentId: string,
  relPath: string
): { found: boolean; format: "html" | "md" | "other"; content: string; fileUrl: string } {
  const base = getParentDir(parentId);
  const resolved = path.resolve(base, relPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    return { found: false, format: "other", content: "", fileUrl: "" };
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return { found: false, format: "other", content: "", fileUrl: "" };
  }
  const ext = path.extname(resolved).toLowerCase();
  const format = ext === ".html" || ext === ".htm" ? "html" : ext === ".md" ? "md" : "other";
  let content = fs.readFileSync(resolved, "utf-8");
  let fileAbs = resolved;
  if (format === "html") {
    // 跟随 <meta http-equiv="refresh" url=...> 本地跳转（如英语 01-11/45-50 课指向 learn/*.html 的占位页），
    // 否则 srcDoc(about:blank/父源) 下相对跳转会导航到不存在地址导致整页空白。
    fileAbs = followHtmlRedirect(base, resolved, content);
    content = fs.readFileSync(fileAbs, "utf-8");
    // 把 html 内的相对资源引用(../xxx.css、images/..、同目录 js)改写为 asset:// 绝对地址，
    // 使 srcDoc(about:blank 来源)下的 css/图片/脚本能跨源加载本地文件（dev/prod 均生效）。
    const parts = fileAbs.split(path.sep);
    const pIdx = parts.indexOf("parents");
    const pid = pIdx >= 0 ? parts[pIdx + 1] : DEFAULT_PARENT_ID;
    const materialsRoot = path.join(base, "materials");
    const fileDir = path.relative(materialsRoot, path.dirname(fileAbs));
    content = rewriteHtmlAssetRefs(content, pid, fileDir);
  }
  return { found: true, format, content, fileUrl: pathToFileURL(fileAbs).href };
}

/**
 * 跟随 html 里的 <meta http-equiv="refresh" content="0; url=..."> 本地跳转，返回最终文件的绝对路径。
 * - 仅跟随**本地相对跳转**且目标必须在 `materials/` 内（防越权/防跳向 http）；
 * - 最多 8 跳、visited 防环；
 * - 无跳转/跳转目标无效时原样返回 startAbs。
 */
function followHtmlRedirect(base: string, startAbs: string, startContent: string): string {
  const matRoot = path.join(base, "materials");
  const visited = new Set<string>([startAbs]);
  let cur = startAbs;
  let content = startContent;
  for (let i = 0; i < 8; i++) {
    const target = extractRedirectTarget(content);
    if (!target) break;
    const clean = target.split(/[?#]/)[0];
    if (!clean) break;
    const targetAbs = path.resolve(path.dirname(cur), clean);
    if (targetAbs !== matRoot && !targetAbs.startsWith(matRoot + path.sep)) break; // 越界不跟
    if (visited.has(targetAbs)) break;
    if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) break;
    if (path.extname(targetAbs).toLowerCase() !== ".html") break;
    visited.add(targetAbs);
    cur = targetAbs;
    content = fs.readFileSync(targetAbs, "utf-8");
  }
  return cur;
}

/** 提取 <meta http-equiv="refresh" content="0; url=..."> 中的 url 目标；无则返回 null。 */
function extractRedirectTarget(html: string): string | null {
  const metaRe = /<meta[^>]*http-equiv=["']?refresh["']?[^>]*>/i;
  const m = html.match(metaRe);
  if (!m) return null;
  const c = m[0].match(/content=["']([^"']+)["']/i);
  if (!c) return null;
  const u = c[1].match(/url\s*=\s*([^\s"']+)/i);
  return u ? u[1] : null;
}

/**
 * 把 html 内 href/src 上的相对资源引用改写为 asset:// 绝对 URL，使其能在 srcDoc(about:blank
 * 来源)的沙盒 iframe 中跨源加载本地资料文件。
 *
 * - 跳过已绝对化的引用：含 scheme(http/https/media/data/...)、`//`、#锚点、data:/blob:/mailto:、以及绝对路径；
 * - 仅改写落在 `<materialsRoot>/<topic>/...` 之下的本地相对引用；
 * - fileDir 为 html 所在目录相对 materials 根（如 `english/12-yellow-01-...`），用于解析 `../` 上溯。
 */
function rewriteHtmlAssetRefs(html: string, parentId: string, fileDir: string): string {
  const RE = /(\b(?:href|src)\s*=\s*["'])([^"']+?)(["'])/gi;
  return html.replace(RE, (m, pre: string, val: string, post: string) => {
    const trimmed = val.trim();
    if (
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || // 任何 scheme（http/https/media/data…）
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:") ||
      trimmed.startsWith("mailto:") ||
      path.isAbsolute(trimmed)
    ) {
      return m;
    }
    // 拆分 query/hash（如有）并保留
    let core = trimmed;
    let suffix = "";
    const qIdx = core.search(/[?#]/);
    if (qIdx >= 0) {
      suffix = core.slice(qIdx);
      core = core.slice(0, qIdx);
    }
    let absFromMaterials: string;
    try {
      absFromMaterials = path.normalize(path.join(fileDir, core));
    } catch {
      return m;
    }
    const segs = absFromMaterials.split(path.sep).filter(Boolean);
    if (segs.length < 2) return m; // 需落在 主题/... 之下
    const topic = segs[0];
    const rest = segs.slice(1).join("/");
    return pre + buildAssetUrl(parentId, topic, rest) + suffix + post;
  });
}

/** 家长库某主题 materials 目录下的文件清单（html/md/其它，不含 media/ 子目录内容）。 */
export function listParentMaterials(parentId: string, topicDir: string): string[] {
  const dir = path.join(getParentMaterialsDir(parentId), topicDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

/** 上传的媒体扩展名（放入 materials/<topic>/media/ 子目录，供 html 的 media:// 引用）。 */
const MEDIA_EXTS = new Set([".mp3", ".mp4", ".webm", ".ogg", ".wav", ".m4a", ".aac", ".flac"]);

/**
 * 把外部文件复制进家长库共享资料目录（课程管理「上传资料」落盘）。
 * - 未指定 subDir：媒体 → `materials/<topicDir>/media/<file>`（html 用 `media://local/parent/<pid>/<topicDir>/media/<file>` 引用）；
 *   其它（html/md/pdf/图片…）→ `materials/<topicDir>/<file>`。
 * - 指定 subDir：全部文件（含媒体）→ `materials/<topicDir>/<subDir>/<file>`（不再按媒体分流）。
 * 返回保存后的相对路径（相对父库根），如 `materials/lunyu/xxx.html`。
 */
export function copyMaterialIntoParent(parentId: string, topicDir: string, srcPath: string, subDir?: string): string {
  const ext = path.extname(srcPath).toLowerCase();
  const fileName = path.basename(srcPath);
  const topicDirAbs = path.join(getParentMaterialsDir(parentId), topicDir);
  let targetDir: string;
  let relPrefix: string;
  if (subDir) {
    // 指定子目录：所有文件（含媒体）都进该子目录；防路径穿越
    const sub = path.normalize(subDir).replace(/\\/g, "/");
    if (sub.startsWith("..") || path.isAbsolute(sub) || sub.split("/").includes("..")) {
      throw new Error("非法子目录路径");
    }
    targetDir = path.join(topicDirAbs, sub);
    relPrefix = `materials/${topicDir}/${sub}`;
  } else {
    targetDir = MEDIA_EXTS.has(ext) ? path.join(topicDirAbs, "media") : topicDirAbs;
    relPrefix = `materials/${topicDir}${MEDIA_EXTS.has(ext) ? "/media" : ""}`;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const dst = path.join(targetDir, fileName);
  fs.copyFileSync(srcPath, dst);
  return `${relPrefix}/${fileName}`;
}

/** 学习资料树节点（供「学习资料管理」弹框分级展示）。relPath 为相对 materials/<topicDir>/ 的路径。 */
export interface ParentMaterialNode {
  name: string;
  relPath: string; // 相对 materials/<topicDir>/，如 `xxx.html`、`media/yyy.mp3`、`docs/1.pdf`
  isDir: boolean;
  ext?: string; // 文件时
  children?: ParentMaterialNode[]; // 目录时
}

/**
 * 列出某主题下全部学习资料（递归，含所有子目录），供「学习资料管理」弹框分级展示。
 * 返回树状结构：目录在前、文件在后，各自按名排序；每个目录带 children。
 */
export function listParentTopicMaterials(parentId: string, topicDir: string): ParentMaterialNode[] {
  const root = path.join(getParentMaterialsDir(parentId), topicDir);
  if (!fs.existsSync(root)) return [];
  function walk(dir: string, rel: string): ParentMaterialNode[] {
    const out: ParentMaterialNode[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const node: ParentMaterialNode = {
        name: e.name,
        relPath: rel ? `${rel}/${e.name}` : e.name,
        isDir: e.isDirectory(),
      };
      if (e.isDirectory()) {
        node.children = walk(path.join(dir, e.name), node.relPath);
      } else {
        node.ext = path.extname(e.name).toLowerCase();
      }
      out.push(node);
    }
    out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return out;
  }
  return walk(root, "");
}

/**
 * 删除某主题下的学习资料文件（「学习资料管理」弹框删除用）。
 * relPath 为相对 materials/<topicDir>/ 的路径（如 `xxx.html`、`media/yyy.mp3`、`docs/1.pdf`），
 * 严格限定在 materials/<topicDir>/ 内，杜绝路径穿越。
 */
export function deleteParentMaterial(parentId: string, topicDir: string, relPath: string): void {
  const base = path.join(getParentMaterialsDir(parentId), topicDir);
  const resolved = path.resolve(base, relPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("非法路径：超出主题资料目录");
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error("文件不存在");
  }
  fs.unlinkSync(resolved);
}

// ==================== 存量迁移（一次性） ====================

export interface MigrateStats {
  topics: number;
  htmlMoved: number;
  htmlSkippedShared: number;
  coursesUpdated: number;
  materialsDirsRemoved: number;
  teachingCopyBackfilled: number;
}

/**
 * 一次性存量迁移（2026-08-21 用户拍板「现在一次性迁移」）：
 *   1) 每个孩子的 learning/<topic>/method.md → topics.method 全文（父库 + 孩子库）；
 *   2) learning/<topic>/materials/*.html → 父库共享目录 materials/<topic>/（已存在则跳过，保持共享）；
 *   3) 孩子 courses 行按「课程名 = html 文件名」回填 html_path；
 *   4) 迁移后删除孩子目录下已清空的 materials 目录。
 *
 * ⚠️ 文件移动是破坏性操作：调用前必须先备份 data/ 目录；函数会先复制到父库、
 *    确认成功后才删除孩子侧文件（每文件独立 try/catch，失败不中断）。
 */
export function migrateChildrenToParent(parentId: string = DEFAULT_PARENT_ID): MigrateStats {
  const childrenDir = getChildrenDir();
  const stats: MigrateStats = { topics: 0, htmlMoved: 0, htmlSkippedShared: 0, coursesUpdated: 0, materialsDirsRemoved: 0, teachingCopyBackfilled: 0 };
  if (!fs.existsSync(childrenDir)) return stats;

  const parentMaterials = getParentMaterialsDir(parentId);

  for (const childId of fs.readdirSync(childrenDir)) {
    const childDir = path.join(childrenDir, childId);
    const learningDir = path.join(childDir, "learning");
    if (!fs.existsSync(learningDir)) continue;
    if (!fs.statSync(learningDir).isDirectory()) continue;

    for (const topicDirName of fs.readdirSync(learningDir, { withFileTypes: true })) {
      if (!topicDirName.isDirectory()) continue;
      const topicDir = topicDirName.name;
      const topicLearningDir = path.join(learningDir, topicDir);
      const methodFile = path.join(topicLearningDir, "method.md");
      const materialsDir = path.join(topicLearningDir, "materials");

      // 1) method.md → 父库 topics.method 全文（孩子库**不存** method，孩子端经 parent_content 工具取，见 ISSUE-029）
      if (fs.existsSync(methodFile)) {
        const methodFull = fs.readFileSync(methodFile, "utf-8");
        // 优先取孩子库已有的主题中文显示名（如 论语），避免退化为目录名
        let topicName = topicDir;
        const childDb0 = openKbDb(childDir);
        try {
          const t0 = childDb0.prepare("SELECT name FROM topics WHERE file LIKE ?").get(`%${topicDir}%`) as
            | { name: string }
            | undefined;
          if (t0) topicName = t0.name;
        } finally {
          childDb0.close();
        }
        const db = openParentDb(parentId);
        try {
          db.prepare(
            "INSERT INTO topics (name, file, method, progress, rules_json) VALUES (?, ?, ?, '', '{}') " +
              "ON CONFLICT(name) DO UPDATE SET file = excluded.file, method = excluded.method"
          ).run(topicName, topicDir, methodFull);
        } finally {
          db.close();
        }
        stats.topics++;
      }

      // 2) html → 父库共享目录（已存在则跳过）
      if (fs.existsSync(materialsDir)) {
        const targetTopicDir = path.join(parentMaterials, topicDir);
        fs.mkdirSync(targetTopicDir, { recursive: true });
        for (const f of fs.readdirSync(materialsDir)) {
          if (!f.endsWith(".html") && !f.endsWith(".htm")) continue;
          const src = path.join(materialsDir, f);
          const dst = path.join(targetTopicDir, f);
          try {
            if (fs.existsSync(dst)) {
              // 父库已有同名校本：保持共享，直接删除孩子侧（内容以父库为准）
              stats.htmlSkippedShared++;
              fs.rmSync(src, { force: true });
            } else {
              fs.copyFileSync(src, dst);
              fs.rmSync(src, { force: true });
              stats.htmlMoved++;
            }
          } catch (e) {
            console.error(`[parent-library] 迁移失败 ${src}:`, e);
          }
        }

        // 3) 孩子 courses 按「课程名 = html 文件名」回填 html_path
        const childDb = openKbDb(childDir);
        try {
          const update = childDb.prepare("UPDATE courses SET html_path = ? WHERE topic = ? AND title = ?");
          let updated = 0;
          for (const f of fs.readdirSync(targetTopicDir)) {
            if (!f.endsWith(".html") && !f.endsWith(".htm")) continue;
            const title = f.replace(/\.[^.]+$/, "");
            const hit = update.run(`materials/${topicDir}/${f}`, topicDir, title);
            if (hit.changes > 0) updated++;
          }
          stats.coursesUpdated += updated;

          // 把该主题的课程内容（无进度）同步进父库 courses —— 父库是内容真源
          const childRows = childDb
            .prepare("SELECT title, sort_order, material, send_material, tags, lesson_method, html_path, teaching_copy FROM courses WHERE topic = ?")
            .all(topicDir) as unknown as Array<{
            title: string;
            sort_order: number;
            material: string;
            send_material: string;
            tags: string;
            lesson_method: string;
            html_path: string;
            teaching_copy: string;
          }>;
          const parentDb = openParentDb(parentId);
          try {
            const t = parentDb.prepare("SELECT name, method FROM topics WHERE file LIKE ?").get(`%${topicDir}%`) as
              | { name: string; method: string }
              | undefined;
            const upsert = parentDb.prepare(
              "INSERT INTO courses (topic, title, sort_order, status, mastery, first_learned, last_review, review_count, material, send_material, tags, lesson_method, html_path, teaching_copy) " +
                "VALUES (?, ?, ?, '⬜', '', '', '', 0, ?, ?, ?, ?, ?, ?) " +
                "ON CONFLICT(topic, title) DO UPDATE SET sort_order = excluded.sort_order, material = excluded.material, " +
                "send_material = excluded.send_material, tags = excluded.tags, lesson_method = excluded.lesson_method, html_path = excluded.html_path, teaching_copy = excluded.teaching_copy"
            );
            for (const r of childRows) {
              upsert.run(topicDir, r.title, r.sort_order, r.material, r.send_material, r.tags, r.lesson_method, r.html_path, r.teaching_copy);
            }
          } finally {
            parentDb.close();
          }

          // 3.5) 教学文案入库：materials/<课程名>.md → courses.teaching_copy（父库 + 孩子库，数据库唯一真源）
          let teachingBackfilled = 0;
          for (const f of fs.readdirSync(materialsDir)) {
            if (!f.endsWith(".md")) continue;
            const title = f.replace(/\.md$/, "");
            const content = fs.readFileSync(path.join(materialsDir, f), "utf-8");
            // 只写**父库**（孩子库不存教学文案，孩子端经 parent_content 工具取，见 ISSUE-029）
            const parentDb2 = openParentDb(parentId);
            try {
              const parentHit = parentDb2
                .prepare("UPDATE courses SET teaching_copy = ? WHERE topic = ? AND title = ? AND (teaching_copy = '' OR teaching_copy IS NULL)")
                .run(content, topicDir, title);
              if (parentHit.changes > 0) teachingBackfilled++;
            } finally {
              parentDb2.close();
            }
          }
          if (teachingBackfilled > 0) {
            stats.teachingCopyBackfilled = (stats.teachingCopyBackfilled || 0) + teachingBackfilled;
          }
        } finally {
          childDb.close();
        }

        // 4) 清空的孩子 materials 目录删除（仅当已无 .html/.htm/.md 残留）
        const remain = fs.existsSync(materialsDir)
          ? fs.readdirSync(materialsDir).filter((f) => f.endsWith(".html") || f.endsWith(".htm") || f.endsWith(".md"))
          : [];
        if (remain.length === 0 && fs.existsSync(materialsDir)) {
          try {
            fs.rmSync(materialsDir, { recursive: true, force: true });
            stats.materialsDirsRemoved++;
          } catch (e) {
            console.error(`[parent-library] 删除孩子 materials 目录失败 ${materialsDir}:`, e);
          }
        }
      }
    }
  }
  return stats;
}
