/**
 * 考核内容结构化数据层（题库 / 知识点 / 课程-知识点-题目挂载）。
 * 模型（2026-09-11 知识点制）：
 * - 表全在家长库 parent.sqlite；内容全孩子共享；只有 method_spec 按孩子区分；
 * - **每课的考核要点 = 该课的知识点**（knowledge_points.name + detail 详细描述）；
 * - 课程挂知识点、知识点挂题目（course_knowledge_questions），不再有「考核类别」；
 * - 题目本身无主题/课程，语义由"挂到哪个（课,知识点）"决定，可跨课复用；
 * - 背诵/朗读题：stem 为任务描述、answer=标准原文(refText)、scoring 空，行为以题级 behavior 为准；
 * - 未挂题的课：出题方按知识点详情走 LLM 出题（旧 assess_rubric 已废弃，不再参与考核）。
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { buildPathQuery, parentLibPaths } from "../agent/db-channel.js";

/** F10-b：取一条已登记路径（JOIN 链唯一真源在注册表）；找不到 = 注册表被破坏，直接抛错暴露问题 */
function registeredPath(name: string) {
  const p = parentLibPaths().find((x) => x.name === name);
  if (!p) throw new Error(`路径 ${name} 未在注册表登记（db-channel.parentLibPaths）`);
  return p;
}

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

-- 知识点（每课的考核要点）：挂在课下，name=知识点名、detail=详细描述（教学内容/考核要点）。
CREATE TABLE IF NOT EXISTS knowledge_points (
  id          TEXT PRIMARY KEY,
  course_uuid TEXT NOT NULL,
  name        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  seq         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (course_uuid, name)
);
CREATE INDEX IF NOT EXISTS idx_kp_course ON knowledge_points(course_uuid);

-- 课程 ↔ 知识点 ↔ 题目挂载：课程挂到知识点，知识点再挂对应题目。
CREATE TABLE IF NOT EXISTS course_knowledge_questions (
  course_id          TEXT NOT NULL,
  knowledge_point_id TEXT NOT NULL,
  question_id        TEXT NOT NULL,
  seq                INTEGER NOT NULL DEFAULT 0,
  overview           TEXT,
  PRIMARY KEY (course_id, knowledge_point_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_ckq_course ON course_knowledge_questions(course_id);
CREATE INDEX IF NOT EXISTS idx_ckq_kp     ON course_knowledge_questions(knowledge_point_id);
`;

/** 就地迁移（幂等）：courses.uuid、topics.method_spec、题库扩展列、知识点 detail 列 + 旧类别数据迁移。每次 openParentLib 时调用。 */
export function ensureAssessContentSchema(db: DatabaseSync): void {
  const cCols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cCols.includes("uuid")) db.exec("ALTER TABLE courses ADD COLUMN uuid TEXT");
  db.exec("UPDATE courses SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL OR uuid = ''");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_uuid ON courses(uuid)");

  const tCols = (db.prepare("PRAGMA table_info(topics)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!tCols.includes("method_spec")) db.exec("ALTER TABLE topics ADD COLUMN method_spec TEXT NOT NULL DEFAULT '{}'");

  db.exec(ASSESS_CONTENT_TABLES);

  // 题库题级扩展：behavior=题级行为（speech_recite/speech_read/generic）、note=备注、
  // knowledge_summary=知识点概要（展示/预留）、options=选择题选项 JSON [{key,text}]（[]=非选择题）。
  const qCols = (db.prepare("PRAGMA table_info(question_bank)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!qCols.includes("behavior")) db.exec("ALTER TABLE question_bank ADD COLUMN behavior TEXT NOT NULL DEFAULT 'generic'");
  if (!qCols.includes("note")) db.exec("ALTER TABLE question_bank ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  if (!qCols.includes("knowledge_summary")) db.exec("ALTER TABLE question_bank ADD COLUMN knowledge_summary TEXT NOT NULL DEFAULT ''");
  if (!qCols.includes("options")) db.exec("ALTER TABLE question_bank ADD COLUMN options TEXT NOT NULL DEFAULT '[]'");

  // 知识点 detail 列（存量库补列；新建库由 CREATE TABLE 直接带上）
  const kpCols = (db.prepare("PRAGMA table_info(knowledge_points)").all() as Array<{ name: string }>).map((c) => c.name);
  if (kpCols.length && !kpCols.includes("detail")) {
    db.exec("ALTER TABLE knowledge_points ADD COLUMN detail TEXT NOT NULL DEFAULT ''");
  }

  // 旧「考核类别」数据一次性迁移（幂等，meta 游标）：旧 course_category_questions 里已关联知识点的
  // 挂载行复制到 course_knowledge_questions；未关联知识点的行（纯类别挂载）随表废弃。
  const migrated =
    (db.prepare("SELECT value FROM meta WHERE key='ckq_migrated'").get() as { value?: string } | undefined)?.value === "1";
  if (!migrated) {
    const hasCcq = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='course_category_questions'")
      .get();
    if (hasCcq) {
      db.exec(`
        INSERT OR IGNORE INTO course_knowledge_questions (course_id, knowledge_point_id, question_id, seq, overview)
          SELECT ccq.course_id, ccq.knowledge_point_id, ccq.question_id,
                 COALESCE(ccq.seq, 0), COALESCE(ccq.overview, '')
          FROM course_category_questions ccq
          WHERE ccq.knowledge_point_id IS NOT NULL AND ccq.knowledge_point_id != '';
      `);
      const n = (db.prepare("SELECT COUNT(*) AS c FROM course_knowledge_questions").get() as { c: number }).c;
      console.log(`[assess-content] 类别制→知识点制迁移完成：course_knowledge_questions 现有 ${n} 行`);
    }
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('ckq_migrated', '1')").run();
    // 旧表退役（已关联知识点的数据已迁；纯类别挂载数据随模型废弃；不再有任何代码路径引用）
    db.exec("DROP TABLE IF EXISTS course_category_questions");
    db.exec("DROP TABLE IF EXISTS topic_categories");
  }
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

export interface QuestionRow {
  id: string;
  stem: string;
  answer: string;
  scoring: string | null; // JSON 字符串（dims/special）或自由文本；背诵朗读类为 null
  pointMax: number;
  /** 题级行为真源：speech_recite / speech_read / generic */
  behavior: string;
  note: string;
  knowledgeSummary: string;
  /** 选择题选项 [{key,text}]；[] = 非选择题 */
  options: QuestionOption[];
}
export interface CourseContentItem {
  knowledgePointId: string;
  knowledgePointName: string;
  /** 知识点详情（该课考核要点的一部分） */
  detail: string;
  /** 该知识点在本课的补充说明（可空） */
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

// ==================== 知识点 ====================

export interface KnowledgePointRow {
  id: string;
  courseUuid: string;
  name: string;
  detail: string;
  seq: number;
}

/** 某课全部知识点（按 seq,rowid 排序）。 */
export function listKnowledgePoints(db: DatabaseSync, courseUuid: string): KnowledgePointRow[] {
  const rows = db
    .prepare(
      "SELECT id, course_uuid AS courseUuid, name, detail, seq FROM knowledge_points WHERE course_uuid = ? ORDER BY seq, rowid"
    )
    .all(courseUuid) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    courseUuid: String(r.courseUuid),
    name: String(r.name),
    detail: String(r.detail ?? ""),
    seq: Number(r.seq) || 0,
  }));
}

/** 某主题下全部课程的知识点（含课程上下文；供家长 agent 列表与 method-spec 校验）。 */
export function listTopicKnowledgePoints(
  db: DatabaseSync,
  topic: string
): Array<KnowledgePointRow & { courseTitle: string }> {
  // F10-b：JOIN 链走注册表路径 topic_knowledge_points（结果键为裸列名）
  const { sql, params } = buildPathQuery(registeredPath("topic_knowledge_points"), {
    where: { "courses.topic": topic },
    orderBy: "courses.sort_order, courses.title, knowledge_points.seq",
    limit: 500,
  });
  const rows = db
    .prepare(sql)
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    courseUuid: String(r.course_uuid),
    name: String(r.name),
    detail: String(r.detail ?? ""),
    seq: Number(r.seq) || 0,
    courseTitle: String(r.title),
  }));
}

/** 按 (course_uuid, name) 查；没有则创建。name 先 trim；给 detail 时写入（已有 detail 且新值不同则更新）。 */
export function getOrCreateKnowledgePoint(
  db: DatabaseSync,
  courseUuid: string,
  name: string,
  detail = ""
): KnowledgePointRow {
  const n = String(name || "").trim();
  if (!n) throw new Error("知识点名称不能为空");
  const d = String(detail || "").trim();
  const row = db
    .prepare("SELECT id, course_uuid AS courseUuid, name, detail, seq FROM knowledge_points WHERE course_uuid = ? AND name = ?")
    .get(courseUuid, n) as KnowledgePointRow | undefined;
  if (row) {
    if (d && d !== String(row.detail ?? "")) {
      db.prepare("UPDATE knowledge_points SET detail = ? WHERE id = ?").run(d, row.id);
      return { ...row, detail: d };
    }
    return row;
  }
  const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM knowledge_points WHERE course_uuid = ?").get(courseUuid) as { next: number }).next;
  const id = randomUUID();
  db.prepare("INSERT INTO knowledge_points (id, course_uuid, name, detail, seq) VALUES (?, ?, ?, ?, ?)").run(id, courseUuid, n, d, seq);
  return { id, courseUuid, name: n, detail: d, seq };
}

// ==================== 题库 ====================

/** 题库列表上限（ISSUE-074：家长需要看到全量；生产 3575+ 条，2000 会静默截断。曾修过一次，F10-b 重构时回归，勿再降回小值） */
export const BANK_LIST_LIMIT = 10000;

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

// ==================== 课程 ↔ 知识点 ↔ 题目 ====================

export function getCourseUuid(db: DatabaseSync, topic: string, title: string): string | undefined {
  const r = db.prepare("SELECT uuid FROM courses WHERE topic = ? AND title = ?").get(topic, title) as { uuid?: string } | undefined;
  return r?.uuid || undefined;
}

/** 整课替换该课挂的内容（事务）。items 顺序即知识点展示顺序；同知识点多题按数组序分配 seq。 */
export function replaceCourseContent(
  db: DatabaseSync,
  courseUuid: string,
  items: Array<{
    knowledgePointId: string;
    overview: string;
    questionIds: string[];
  }>
): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM course_knowledge_questions WHERE course_id = ?").run(courseUuid);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO course_knowledge_questions (course_id, knowledge_point_id, question_id, seq, overview) VALUES (?, ?, ?, ?, ?)"
    );
    for (const item of items) {
      item.questionIds.forEach((qid, i) => {
        ins.run(courseUuid, item.knowledgePointId, qid, i, item.overview || "");
      });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 某课全部挂载内容（知识点→题），按挂载顺序输出。 */
export function listCourseContent(db: DatabaseSync, courseUuid: string): CourseContent {
  // F10-b：JOIN 链走注册表路径 course_content_rows；rowid 保挂载插入序（replaceCourseContent 按展示序写入）
  const { sql, params } = buildPathQuery(registeredPath("course_content_rows"), {
    where: { "course_knowledge_questions.course_id": courseUuid },
    orderBy: "course_knowledge_questions.rowid",
    limit: 500,
  });
  const rows = db
    .prepare(sql)
    .all(...params) as Array<{
    knowledge_point_id: string;
    name: string;
    detail: string;
    overview: string;
    seq: number;
    question_id: string;
    stem: string;
    answer: string;
    scoring: string | null;
    point_max: number;
    behavior: string;
    note: string;
    knowledge_summary: string;
    options: string;
  }>;
  const items: CourseContentItem[] = [];
  const byKp = new Map<string, CourseContentItem>();
  for (const r of rows) {
    let item = byKp.get(r.knowledge_point_id);
    if (!item) {
      item = {
        knowledgePointId: r.knowledge_point_id,
        knowledgePointName: r.name,
        detail: r.detail ?? "",
        overview: r.overview,
        questions: [],
      };
      byKp.set(r.knowledge_point_id, item);
      items.push(item);
    }
    item.questions.push({
      id: r.question_id,
      stem: r.stem,
      answer: r.answer,
      scoring: r.scoring,
      pointMax: r.point_max,
      seq: r.seq,
      behavior: r.behavior || "generic",
      note: r.note ?? "",
      knowledgeSummary: r.knowledge_summary ?? "",
      options: parseOptions(r.options),
    });
  }
  return { courseId: courseUuid, items };
}

/** 全量题目列表（家长「题库」浏览）：带所属 主题/课程/知识点 上下文与行为。 */
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
  contexts: Array<{ topic: string; course: string; knowledgePoint: string; courseUuid: string; knowledgePointId: string }>;
}> {
  const qs = db
    .prepare(
      `SELECT id, stem, answer, scoring, point_max AS pointMax, behavior, note, knowledge_summary AS knowledgeSummary, options FROM question_bank ORDER BY rowid DESC LIMIT ${BANK_LIST_LIMIT}`
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
  const ctx = (() => {
    // F10-b：挂载反查走注册表路径 bank_question_contexts（kp/courses 均 LEFT JOIN，与原语义一致；
    // ISSUE-132 起带 courseUuid/knowledgePointId，供客户端挂载管理直接引用）
    const { sql, params } = buildPathQuery(registeredPath("bank_question_contexts"), {
      orderBy: "course_knowledge_questions.rowid",
      limit: 5000,
    });
    const rows = db.prepare(sql).all(...params) as Array<{
      question_id: string;
      knowledge_point_id: string | null;
      topic: string | null;
      title: string | null;
      uuid: string | null;
      name: string | null;
    }>;
    return rows.map((c) => ({
      qid: c.question_id,
      topic: c.topic ?? "",
      course: c.title ?? "",
      knowledgePoint: c.name ?? "",
      courseUuid: c.uuid ?? "",
      knowledgePointId: c.knowledge_point_id ?? "",
    }));
  })();
  const ctxMap = new Map<string, Array<{ topic: string; course: string; knowledgePoint: string; courseUuid: string; knowledgePointId: string }>>();
  for (const c of ctx) {
    const arr = ctxMap.get(c.qid) || [];
    arr.push({ topic: c.topic, course: c.course, knowledgePoint: c.knowledgePoint, courseUuid: c.courseUuid, knowledgePointId: c.knowledgePointId });
    ctxMap.set(c.qid, arr);
  }
  return qs.map((q) => ({ ...q, options: parseOptions(q.options), contexts: ctxMap.get(q.id) || [] }));
}

// ==================== 题库管理（ISSUE-132：维度 facets + 挂载增删 + 删题） ====================

export interface BankFacets {
  topics: Array<{ name: string; topicKey: string }>;
  courses: Array<{ topic: string; title: string; uuid: string }>;
  knowledgePoints: Array<{ id: string; courseUuid: string; name: string; detail: string }>;
}

/** 主题/课程/知识点 三维全量（含还没有挂题的课程与知识点），供题库级联筛选与挂载选择。 */
export function listBankFacets(db: DatabaseSync): BankFacets {
  const topics = db
    .prepare("SELECT name, topic_key AS topicKey FROM topics ORDER BY name")
    .all() as Array<{ name: string; topicKey: string }>;
  const courses = db
    .prepare("SELECT topic, title, uuid FROM courses WHERE uuid IS NOT NULL AND uuid != '' ORDER BY topic, sort_order, title")
    .all() as Array<{ topic: string; title: string; uuid: string }>;
  const knowledgePoints = db
    .prepare("SELECT id, course_uuid AS courseUuid, name, detail FROM knowledge_points ORDER BY course_uuid, seq, rowid")
    .all() as Array<{ id: string; courseUuid: string; name: string; detail: string }>;
  return { topics, courses, knowledgePoints };
}

/** 把一道题库题挂到某课的某知识点下。课程可按 uuid（courseId）或 topic+title 定位；
 *  知识点可按 id（须属于该课）或名称（不存在则创建）定位。返回定位结果与是否新挂。 */
export function linkQuestionToKnowledgePoint(
  db: DatabaseSync,
  input: {
    questionId: string;
    courseId?: string;
    topic?: string;
    title?: string;
    knowledgePointId?: string;
    knowledgePointName?: string;
    knowledgePointDetail?: string;
    overview?: string;
  }
): { courseId: string; knowledgePointId: string; knowledgePointName: string; questionId: string; linked: boolean } {
  const qid = String(input.questionId || "").trim();
  if (!qid) throw new Error("缺少 questionId");
  if (!getQuestion(db, qid)) throw new Error(`题库题不存在：${qid}`);

  const uuid = input.courseId
    ? input.courseId
    : getCourseUuid(db, String(input.topic || ""), String(input.title || ""));
  if (!uuid) throw new Error("课程不存在：需要 courseId 或 topic+title（请先在课程库创建该课）");
  const courseRow = db.prepare("SELECT topic, title FROM courses WHERE uuid = ?").get(uuid) as
    | { topic: string; title: string }
    | undefined;
  if (!courseRow) throw new Error(`课程不存在：${uuid}`);

  let kpId = String(input.knowledgePointId || "").trim();
  let kpName = "";
  if (kpId) {
    const row = db.prepare("SELECT id, name FROM knowledge_points WHERE id = ? AND course_uuid = ?").get(kpId, uuid) as
      | { id: string; name: string }
      | undefined;
    if (!row) throw new Error(`知识点不存在或不属于该课：${kpId}`);
    kpName = row.name;
  } else {
    kpId = getOrCreateKnowledgePoint(db, uuid, String(input.knowledgePointName || ""), String(input.knowledgePointDetail || "")).id;
    kpName = String(input.knowledgePointName || "").trim();
  }

  const r = db
    .prepare("INSERT OR IGNORE INTO course_knowledge_questions (course_id, knowledge_point_id, question_id, seq, overview) VALUES (?, ?, ?, ?, ?)")
    .run(uuid, kpId, qid, 0, String(input.overview || ""));
  if (Number(r.changes) > 0) {
    // 首次挂载才占一个序号（同知识点下按挂载顺序展示）
    const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM course_knowledge_questions WHERE course_id = ? AND knowledge_point_id = ?").get(uuid, kpId) as { next: number }).next;
    db.prepare("UPDATE course_knowledge_questions SET seq = ? WHERE course_id = ? AND knowledge_point_id = ? AND question_id = ?").run(seq, uuid, kpId, qid);
  }
  return {
    courseId: uuid,
    knowledgePointId: kpId,
    knowledgePointName: kpName,
    questionId: qid,
    linked: Number(r.changes) > 0,
  };
}

/** 移除一道题在「某课某知识点」下的一处挂载（题目本身保留在题库）。 */
export function unlinkQuestionFromKnowledgePoint(
  db: DatabaseSync,
  input: { questionId: string; courseId: string; knowledgePointId: string }
): { removed: boolean } {
  const r = db
    .prepare("DELETE FROM course_knowledge_questions WHERE question_id = ? AND course_id = ? AND knowledge_point_id = ?")
    .run(String(input.questionId), String(input.courseId), String(input.knowledgePointId));
  return { removed: Number(r.changes) > 0 };
}

/** 从题库删除一道题（事务：先清全部挂载行，再删题目行）。考核历史存的是逐题快照，不受影响。 */
export function deleteBankQuestion(db: DatabaseSync, id: string): { deleted: boolean; mountsRemoved: number } {
  const exists = db.prepare("SELECT id FROM question_bank WHERE id = ?").get(id);
  if (!exists) return { deleted: false, mountsRemoved: 0 };
  db.exec("BEGIN");
  try {
    const m = db.prepare("DELETE FROM course_knowledge_questions WHERE question_id = ?").run(id);
    db.prepare("DELETE FROM question_bank WHERE id = ?").run(id);
    db.exec("COMMIT");
    return { deleted: true, mountsRemoved: Number(m.changes) };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
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
