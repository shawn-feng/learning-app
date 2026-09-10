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
  knowledge_point_id TEXT,
  PRIMARY KEY (course_id, category_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_ccq_course   ON course_category_questions(course_id);
CREATE INDEX IF NOT EXISTS idx_ccq_category ON course_category_questions(category_id);

-- 知识点（2026-09-10 拍板建实体）：挂在课下，题目经挂载关系（ccq）关联到课内知识点。
-- 关联落点在挂载关系而非题目——同一题挂到不同课可关联各自课的知识点（与"题目语义随挂载"约定一致）。
CREATE TABLE IF NOT EXISTS knowledge_points (
  id          TEXT PRIMARY KEY,
  course_uuid TEXT NOT NULL,
  name        TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (course_uuid, name)
);
CREATE INDEX IF NOT EXISTS idx_kp_course ON knowledge_points(course_uuid);
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
  // 知识点实体（2026-09-10 拍板）：存量库补 ccq.knowledge_point_id 列（knowledge_points 表由 ASSESS_CONTENT_TABLES 幂等建）
  const ccqCols = (db.prepare("PRAGMA table_info(course_category_questions)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!ccqCols.includes("knowledge_point_id")) db.exec("ALTER TABLE course_category_questions ADD COLUMN knowledge_point_id TEXT");
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
    /** 挂载关联的知识点（2026-09-10 知识点实体）；空串=未关联 */
    knowledgePointId: string;
    knowledgePointName: string;
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

// ==================== 知识点 ====================

export interface KnowledgePointRow {
  id: string;
  courseUuid: string;
  name: string;
  seq: number;
}

/** 某课全部知识点（按 seq,rowid 排序）。 */
export function listKnowledgePoints(db: DatabaseSync, courseUuid: string): KnowledgePointRow[] {
  const rows = db
    .prepare("SELECT id, course_uuid AS courseUuid, name, seq FROM knowledge_points WHERE course_uuid = ? ORDER BY seq, rowid")
    .all(courseUuid) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: String(r.id), courseUuid: String(r.courseUuid), name: String(r.name), seq: Number(r.seq) || 0 }));
}

/** 按 (course_uuid, name) 查；没有则创建。name 先 trim。 */
export function getOrCreateKnowledgePoint(db: DatabaseSync, courseUuid: string, name: string): KnowledgePointRow {
  const n = String(name || "").trim();
  if (!n) throw new Error("知识点名称不能为空");
  const row = db
    .prepare("SELECT id, course_uuid AS courseUuid, name, seq FROM knowledge_points WHERE course_uuid = ? AND name = ?")
    .get(courseUuid, n) as KnowledgePointRow | undefined;
  if (row) return row;
  const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM knowledge_points WHERE course_uuid = ?").get(courseUuid) as { next: number }).next;
  const id = randomUUID();
  db.prepare("INSERT INTO knowledge_points (id, course_uuid, name, seq) VALUES (?, ?, ?, ?)").run(id, courseUuid, n, seq);
  return { id, courseUuid, name: n, seq };
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

/** 整课替换该课挂的内容（事务）。items 顺序即类别展示顺序；同类别多题按数组序分配 seq。
 *  questions[i].knowledgePointId 可空（未关联知识点）。 */
export function replaceCourseContent(
  db: DatabaseSync,
  courseUuid: string,
  items: Array<{
    categoryId: string;
    overview: string;
    questionIds: string[];
    /** 与 questionIds 等长的知识点 id（null=未关联）；缺省视为全空 */
    knowledgePointIds?: Array<string | null>;
  }>
): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM course_category_questions WHERE course_id = ?").run(courseUuid);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO course_category_questions (course_id, category_id, question_id, seq, overview, knowledge_point_id) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const item of items) {
      item.questionIds.forEach((qid, i) => {
        const kpId = item.knowledgePointIds?.[i] ?? null;
        ins.run(courseUuid, item.categoryId, qid, i, item.overview || "", kpId || null);
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
              qb.behavior AS qbehavior, qb.note AS qnote, qb.knowledge_summary AS qks, qb.options AS qopts,
              kp.id AS kpid, kp.name AS kpname
       FROM course_category_questions ccq
       JOIN topic_categories tc ON tc.id = ccq.category_id
       JOIN question_bank qb    ON qb.id = ccq.question_id
       LEFT JOIN knowledge_points kp ON kp.id = ccq.knowledge_point_id
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
    kpid: string | null;
    kpname: string | null;
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
      knowledgePointId: r.kpid ?? "",
      knowledgePointName: r.kpname ?? "",
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
  contexts: Array<{ topic: string; course: string; category: string; knowledgePoint: string }>;
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
      `SELECT ccq.question_id AS qid, c.topic AS topic, c.title AS course, tc.name AS category,
              COALESCE(kp.name, '') AS knowledgePoint
       FROM course_category_questions ccq
       JOIN courses c ON c.uuid = ccq.course_id
       JOIN topic_categories tc ON tc.id = ccq.category_id
       LEFT JOIN knowledge_points kp ON kp.id = ccq.knowledge_point_id
       ORDER BY ccq.rowid`
    )
    .all() as Array<{ qid: string; topic: string; course: string; category: string; knowledgePoint: string }>;
  const ctxMap = new Map<string, Array<{ topic: string; course: string; category: string; knowledgePoint: string }>>();
  for (const c of ctx) {
    const arr = ctxMap.get(c.qid) || [];
    arr.push({ topic: c.topic, course: c.course, category: c.category, knowledgePoint: c.knowledgePoint });
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
