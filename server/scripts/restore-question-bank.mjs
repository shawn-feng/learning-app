/**
 * 题库恢复 + 旧分类挂载（一次性运维脚本）。
 *
 * 背景：2026-09-14 seeding 前误清了 question_bank（09-09 批量建设的 3575 行，覆盖 489 门论语课）。
 * 恢复源：.workbuddy/tmp/rehearsal 的 parent.sqlite 快照（含原 created_at 与旧 course_category_questions 挂载）。
 *
 * 动作：
 *  1. 快照 question_bank 全量行 INSERT OR IGNORE 回当前库（保留原 id/created_at；与今日新 282 行无 id 冲突）。
 *  2. 对当前库**尚无知识点**的课程（即今日模板未覆盖的 lunyu 课程）：按快照旧分类
 *     （topic_categories.name）建知识点并挂载题目（seq/overview 沿用旧 ccq）。
 *     已有知识点的课程（今日 94 门 P0）只恢复题库行、不动挂载。
 *
 * 用法：node restore-question-bank.mjs [--dry-run]
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const SNAP = "C:\\Users\\79734\\Documents\\pi\\.workbuddy\\tmp\\rehearsal\\parents\\86a84278-c8ae-415e-8fbc-6140b1b7c88e\\parent.sqlite";
const CUR = "C:\\Users\\79734\\Documents\\pi\\server\\data\\parents\\86a84278-c8ae-415e-8fbc-6140b1b7c88e\\parent.sqlite";
const DRY = process.argv.includes("--dry-run");

const snap = new DatabaseSync(SNAP, { readOnly: true });
const cur = new DatabaseSync(CUR);

// ---- 1. 恢复 question_bank ----
const rows = snap
  .prepare("SELECT id, stem, answer, scoring, point_max, behavior, options, note, knowledge_summary, created_at, updated_at FROM question_bank")
  .all();
const insQ = cur.prepare(
  `INSERT OR IGNORE INTO question_bank (id, stem, answer, scoring, point_max, created_at, updated_at, behavior, note, knowledge_summary, options)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
let restored = 0;
for (const r of rows) {
  if (DRY) {
    restored += cur.prepare("SELECT COUNT(*) n FROM question_bank WHERE id = ?").get(r.id).n === 0 ? 1 : 0;
  } else {
    restored += insQ.run(
      r.id, r.stem, r.answer, r.scoring, r.point_max,
      r.created_at, r.updated_at,
      r.behavior ?? "generic", r.note ?? "", r.knowledge_summary ?? "", r.options ?? "[]"
    ).changes;
  }
}
console.log(`[restore] question_bank 恢复 ${restored}/${rows.length} 行${DRY ? "（dry-run）" : ""}`);

// ---- 2. 旧分类 → 知识点挂载（仅限当前库还没有知识点的课程） ----
const catById = new Map(snap.prepare("SELECT id, name FROM topic_categories").all().map((c) => [c.id, c.name]));
const byCourse = new Map();
for (const m of snap
  .prepare("SELECT course_id, category_id, question_id, seq, overview FROM course_category_questions ORDER BY course_id, seq")
  .all()) {
  if (!byCourse.has(m.course_id)) byCourse.set(m.course_id, []);
  byCourse.get(m.course_id).push(m);
}

const kpExists = cur.prepare("SELECT 1 FROM knowledge_points WHERE course_uuid = ? LIMIT 1");
const kpIdByName = cur.prepare("SELECT id FROM knowledge_points WHERE course_uuid = ? AND name = ?");
const maxKpSeq = cur.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM knowledge_points WHERE course_uuid = ?");
const insKp = cur.prepare("INSERT OR IGNORE INTO knowledge_points (id, course_uuid, name, detail, seq) VALUES (?, ?, ?, ?, ?)");
const qbExists = cur.prepare("SELECT 1 FROM question_bank WHERE id = ?");
const insMount = cur.prepare(
  "INSERT OR IGNORE INTO course_knowledge_questions (course_id, knowledge_point_id, question_id, seq, overview) VALUES (?, ?, ?, ?, ?)"
);

let coursesMounted = 0;
let skipHasKp = 0;
let skipQMissing = 0;
let kpsMade = 0;
let mountsMade = 0;

for (const [courseId, list] of byCourse) {
  if (kpExists.get(courseId)) {
    skipHasKp++;
    continue;
  }
  for (const m of list) {
    const catName = catById.get(m.category_id);
    if (!catName) continue;
    if (!qbExists.get(m.question_id)) {
      skipQMissing++;
      continue;
    }
    let kid = kpIdByName.get(courseId, catName)?.id;
    if (!kid) {
      kid = randomUUID().replaceAll("-", "");
      if (!DRY) insKp.run(kid, courseId, catName, "", maxKpSeq.get(courseId).n);
      kpsMade++;
    }
    if (!DRY) mountsMade += insMount.run(courseId, kid, m.question_id, m.seq ?? 0, m.overview ?? "").changes;
    else mountsMade++;
  }
  coursesMounted++;
}
console.log(
  `[restore] 挂载：${coursesMounted} 门课 · 新建知识点 ${kpsMade} 个 · 挂载 ${mountsMade} 条；` +
    `跳过（已有知识点）${skipHasKp} 门；缺题库行 ${skipQMissing} 条${DRY ? "（dry-run）" : ""}`
);

// ---- 3. 汇总 ----
const qb = cur.prepare("SELECT COUNT(*) n FROM question_bank").get().n;
const kp = cur.prepare("SELECT COUNT(*) n FROM knowledge_points").get().n;
const ckq = cur.prepare("SELECT COUNT(*) n FROM course_knowledge_questions").get().n;
const mountedCourses = cur.prepare("SELECT COUNT(DISTINCT course_uuid) n FROM knowledge_points").get().n;
console.log(`[restore] 当前库：question_bank=${qb}  knowledge_points=${kp}  course_knowledge_questions=${ckq}  有知识点的课程=${mountedCourses}`);
