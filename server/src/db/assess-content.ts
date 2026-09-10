/**
 * 考核内容结构化 v2 数据层（题库 / 主题类别 / 课-类-题关系）。
 * 设计依据：DESIGN-course-assess-structured-2026-09-09.md（v2 三表归一，ISSUE-067）。
 *
 * 约定：
 * - 三张新表 + courses.uuid + topics.method_spec，全在家长库 parent.sqlite；
 * - 内容 (course) 全孩子共享；只有 method_spec 按孩子区分；
 * - 题目本身无类型/主题/课程，语义由"挂到哪个 (课,类别)"决定，可跨课复用；
 * - 背诵/朗读题：stem 为任务描述、answer=标准原文(refText)、scoring 空，行为由类别 behavior 决定；
 * - 兼容红线：本模块不改 assess_rubric，未挂内容(无关系行)的课继续走旧整文路径。
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

// ==================== Schema（幂等） ====================

export const ASSESS_CONTENT_TABLES = `
CREATE TABLE IF NOT EXISTS question_bank (
  id         TEXT PRIMARY KEY,
  stem       TEXT NOT NULL,
  answer     TEXT NOT NULL,
  scoring    TEXT,
  point_max  INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topic_categories (
  id        TEXT PRIMARY KEY,
  topic_id  TEXT NOT NULL,
  name      TEXT NOT NULL,
  behavior  TEXT NOT NULL DEFAULT 'generic',
  UNIQUE (topic_id, name)
);

CREATE TABLE IF NOT EXISTS course_category_questions (
  course_id   TEXT NOT NULL,
  category_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0,
  overview    TEXT,
  PRIMARY KEY (course_id, category_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_ccq_course   ON course_category_questions(course_id);
CREATE INDEX IF NOT EXISTS idx_ccq_category ON course_category_questions(category_id);
`;

/** 就地迁移（幂等）：courses.uuid、topics.method_spec、三张新表。每次 openParentLib 时调用。 */
export function ensureAssessContentSchema(db: DatabaseSync): void {
  const cCols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cCols.includes("uuid")) db.exec("ALTER TABLE courses ADD COLUMN uuid TEXT");
  db.exec("UPDATE courses SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL OR uuid = ''");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_uuid ON courses(uuid)");

  const tCols = (db.prepare("PRAGMA table_info(topics)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!tCols.includes("method_spec")) db.exec("ALTER TABLE topics ADD COLUMN method_spec TEXT NOT NULL DEFAULT '{}'");

  db.exec(ASSESS_CONTENT_TABLES);

  // 题库题级扩展（2026-09-10）：behavior 从「类别」下移到「题目」（同类别可有口述/背诵多种题）；
  // note=备注、knowledge_summary=知识点概要（可空，供向量检索）。
  const qCols = (db.prepare("PRAGMA table_info(question_bank)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!qCols.includes("behavior")) db.exec("ALTER TABLE question_bank ADD COLUMN behavior TEXT NOT NULL DEFAULT 'generic'");
  if (!qCols.includes("note")) db.exec("ALTER TABLE question_bank ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  if (!qCols.includes("knowledge_summary")) db.exec("ALTER TABLE question_bank ADD COLUMN knowledge_summary TEXT NOT NULL DEFAULT ''");
  // 选择题选项（2026-09-10）：JSON 数组 [{key:"A",text:"…"}]，[] = 非选择题。展示给孩子的选项。
  if (!qCols.includes("options")) db.exec("ALTER TABLE question_bank ADD COLUMN options TEXT NOT NULL DEFAULT '[]'");
}

/** 解析题库题 options 文本 → 数组（容错：非法/空返回 []）。 */
export function parseOptions(raw: string | null | undefined): Array<{ key: string; text: string }> {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((o) => o && typeof o.text === "string") : [];
  } catch {
    return [];
  }
}
export type QuestionOption = { key: string; text: string };

// ==================== 类型 ====================

export interface CategoryRow {
  id: string;
  topicId: string;
  name: string;
  behavior: string;
}
export interface QuestionRow {
  id: string;
  stem: string;
  answer: string;
  scoring: string | null; // JSON 字符串（dims/special），背诵朗读类为 null
  pointMax: number;
  /** 题级行为（2026-09-10 起真源）：speech_recite / speech_read / generic */
  behavior: string;
  note: string;
  knowledgeSummary: string;
  /** 选择题选项 [{key,text}]；[] = 非选择题 */
  options: QuestionOption[];
}
export interface CourseContentItem {
  categoryId: string;
  categoryName: string;
  behavior: string; // 类别行为（兼容保留；判题以题级 q.behavior 为准）
  overview: string;
  questions: Array<{
    id: string;
    stem: string;
    answer: string;
    scoring: string | null;
    pointMax: number;
    seq: number;
    behavior: string;
    note: string;
    knowledgeSummary: string;
    options: QuestionOption[];
  }>;
}
export interface CourseContent {
  courseId: string;
  items: CourseContentItem[];
}

// ==================== 主题类别 ====================

export function listCategories(db: DatabaseSync, topicId: string): CategoryRow[] {
  const raw = db
    .prepare("SELECT id, topic_id, name, behavior FROM topic_categories WHERE topic_id = ? ORDER BY rowid")
    .all(topicId) as Array<Record<string, unknown>>;
  return raw.map((r) => ({ id: String(r.id), topicId: String(r.topic_id), name: String(r.name), behavior: String(r.behavior) }));
}

/** 按 (topic_id,name) 查；没有则创建。behavior 只在新建时生效。 */
export function getOrCreateCategory(db: DatabaseSync, topicId: string, name: string, behavior = "generic"): CategoryRow {
  const row = db
    .prepare("SELECT id, topic_id AS topicId, name, behavior FROM topic_categories WHERE topic_id = ? AND name = ?")
    .get(topicId, name) as CategoryRow | undefined;
  if (row) return row;
  const id = randomUUID();
  db.prepare("INSERT INTO topic_categories (id, topic_id, name, behavior) VALUES (?, ?, ?, ?)").run(
    id,
    topicId,
    name,
    behavior
  );
  return { id, topicId, name, behavior };
}

// ==================== 题库 ====================

/** 新增或整题更新（id 存在则覆盖题干/答案/评分/分值/行为/备注/知识点概要）。返回题目 id。 */
export function saveQuestion(
  db: DatabaseSync,
  q: {
    id?: string;
    stem: string;
    answer: string;
    scoring?: string | null;
    pointMax?: number;
    behavior?: string;
    note?: string;
    knowledgeSummary?: string;
    /** 选择题选项 [{key,text}]（缺省 = 保留原值/非选择题） */
    options?: QuestionOption[] | null;
  }
): string {
  const id = q.id ?? randomUUID();
  const pointMax = q.pointMax ?? 10;
  const scoring = q.scoring ?? null;
  const behavior = q.behavior ?? "generic";
  const note = q.note ?? "";
  const knowledgeSummary = q.knowledgeSummary ?? "";
  const exists = db.prepare("SELECT id FROM question_bank WHERE id = ?").get(id);
  if (exists) {
    const cur =
      q.options === undefined
        ? null
        : JSON.stringify(Array.isArray(q.options) ? q.options : []);
    if (cur === null) {
      db.prepare(
        "UPDATE question_bank SET stem = ?, answer = ?, scoring = ?, point_max = ?, behavior = ?, note = ?, knowledge_summary = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(q.stem, q.answer, scoring, pointMax, behavior, note, knowledgeSummary, id);
    } else {
      db.prepare(
        "UPDATE question_bank SET stem = ?, answer = ?, scoring = ?, point_max = ?, behavior = ?, note = ?, knowledge_summary = ?, options = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(q.stem, q.answer, scoring, pointMax, behavior, note, knowledgeSummary, cur, id);
    }
  } else {
    const opts = JSON.stringify(Array.isArray(q.options) ? q.options : []);
    db.prepare(
      "INSERT INTO question_bank (id, stem, answer, scoring, point_max, behavior, note, knowledge_summary, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, q.stem, q.answer, scoring, pointMax, behavior, note, knowledgeSummary, opts);
  }
  return id;
}

export function getQuestion(db: DatabaseSync, id: string): QuestionRow | undefined {
  const r = db
    .prepare(
      "SELECT id, stem, answer, scoring, point_max AS pointMax, behavior, note, knowledge_summary AS knowledgeSummary, options FROM question_bank WHERE id = ?"
    )
    .get(id) as (Omit<QuestionRow, "options"> & { options: string }) | undefined;
  return r ? { ...r, options: parseOptions(r.options) } : undefined;
}

// ==================== 课程 ↔ 类别 ↔ 题目 ====================

export function getCourseUuid(db: DatabaseSync, topic: string, title: string): string | undefined {
  const r = db.prepare("SELECT uuid FROM courses WHERE topic = ? AND title = ?").get(topic, title) as { uuid?: string } | undefined;
  return r?.uuid || undefined;
}

/** 整课替换该课挂的内容（事务）。items 顺序即类别展示顺序；同类别多题按数组序分配 seq。 */
export function replaceCourseContent(
  db: DatabaseSync,
  courseUuid: string,
  items: Array<{ categoryId: string; overview: string; questionIds: string[] }>
): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM course_category_questions WHERE course_id = ?").run(courseUuid);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO course_category_questions (course_id, category_id, question_id, seq, overview) VALUES (?, ?, ?, ?, ?)"
    );
    for (const item of items) {
      item.questionIds.forEach((qid, i) => {
        ins.run(courseUuid, item.categoryId, qid, i, item.overview || "");
      });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 某课全部挂载内容（类别→题），按挂载顺序输出。 */
export function listCourseContent(db: DatabaseSync, courseUuid: string): CourseContent {
  const rows = db
    .prepare(
      `SELECT ccq.category_id AS cid, tc.name AS cname, tc.behavior AS behavior, ccq.overview AS overview,
              ccq.question_id AS qid, ccq.seq AS seq,
              qb.stem AS stem, qb.answer AS answer, qb.scoring AS scoring, qb.point_max AS pointMax,
              qb.behavior AS qbehavior, qb.note AS qnote, qb.knowledge_summary AS qks, qb.options AS qopts
       FROM course_category_questions ccq
       JOIN topic_categories tc ON tc.id = ccq.category_id
       JOIN question_bank qb    ON qb.id = ccq.question_id
       WHERE ccq.course_id = ?
       ORDER BY ccq.rowid`
    )
    .all(courseUuid) as Array<{
    cid: string;
    cname: string;
    behavior: string;
    overview: string;
    qid: string;
    seq: number;
    stem: string;
    answer: string;
    scoring: string | null;
    pointMax: number;
    qbehavior: string;
    qnote: string;
    qks: string;
    qopts: string;
  }>;
  const items: CourseContentItem[] = [];
  const byCat = new Map<string, CourseContentItem>();
  for (const r of rows) {
    let item = byCat.get(r.cid);
    if (!item) {
      item = { categoryId: r.cid, categoryName: r.cname, behavior: r.behavior, overview: r.overview, questions: [] };
      byCat.set(r.cid, item);
      items.push(item);
    }
    item.questions.push({
      id: r.qid,
      stem: r.stem,
      answer: r.answer,
      scoring: r.scoring,
      pointMax: r.pointMax,
      seq: r.seq,
      behavior: r.qbehavior || r.behavior || "generic",
      note: r.qnote ?? "",
      knowledgeSummary: r.qks ?? "",
      options: parseOptions(r.qopts),
    });
  }
  return { courseId: courseUuid, items };
}

/** 全量题目列表（家长「题库」浏览）：带所属 主题/课程/类别 上下文与行为。 */
export function listAllBankQuestions(db: DatabaseSync): Array<{
  id: string;
  stem: string;
  answer: string;
  scoring: string | null;
  pointMax: number;
  behavior: string;
  note: string;
  knowledgeSummary: string;
  options: QuestionOption[];
  contexts: Array<{ topic: string; course: string; category: string }>;
}> {
  const qs = db
    .prepare(
      `SELECT id, stem, answer, scoring, point_max AS pointMax, behavior, note, knowledge_summary AS knowledgeSummary, options FROM question_bank ORDER BY rowid DESC LIMIT 2000`
    )
    .all() as Array<{
    id: string;
    stem: string;
    answer: string;
    scoring: string | null;
    pointMax: number;
    behavior: string;
    note: string;
    knowledgeSummary: string;
    options: string;
  }>;
  const ctx = db
    .prepare(
      `SELECT ccq.question_id AS qid, c.topic AS topic, c.title AS course, tc.name AS category
       FROM course_category_questions ccq
       JOIN courses c ON c.uuid = ccq.course_id
       JOIN topic_categories tc ON tc.id = ccq.category_id
       ORDER BY ccq.rowid`
    )
    .all() as Array<{ qid: string; topic: string; course: string; category: string }>;
  const ctxMap = new Map<string, Array<{ topic: string; course: string; category: string }>>();
  for (const c of ctx) {
    const arr = ctxMap.get(c.qid) || [];
    arr.push({ topic: c.topic, course: c.course, category: c.category });
    ctxMap.set(c.qid, arr);
  }
  return qs.map((q) => ({ ...q, options: parseOptions(q.options), contexts: ctxMap.get(q.id) || [] }));
}

// ==================== 考核方法 method_spec ====================

export function getMethodSpec(db: DatabaseSync, topicId: string): Record<string, unknown> {
  const r = db.prepare("SELECT method_spec FROM topics WHERE topic_key = ?").get(topicId) as { method_spec?: string } | undefined;
  try {
    return JSON.parse(r?.method_spec || "{}");
  } catch {
    return {};
  }
}

export function saveMethodSpec(db: DatabaseSync, topicId: string, spec: Record<string, unknown>): void {
  const json = JSON.stringify(spec ?? {});
  const r = db.prepare("UPDATE topics SET method_spec = ? WHERE topic_key = ?").run(json, topicId);
  if (r.changes === 0) {
    db.prepare("INSERT INTO topics (name, topic_key, method_spec) VALUES (?, ?, ?)").run(topicId, topicId, json);
  }
}
