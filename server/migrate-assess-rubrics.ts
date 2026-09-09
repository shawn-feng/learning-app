/**
 * 存量 rubric 迁移运行器（步骤4）：node/tsx 下执行。
 * 用法：
 *   npx tsx migrate-assess-rubrics.ts preview [--limit 5] [--topic lunyu] [--course 课程名]
 *   npx tsx migrate-assess-rubrics.ts run    [--topic lunyu] [--course 课程名]
 * 默认家长库：86a84278-…（唯一有 rubric 的库）。
 */
import path from "node:path";
import { openParentLib } from "./src/db/parent-lib.js";
import { migrateTopicRubrics, parseCourseRubric } from "./src/assess-migrate.js";
import { listCourseContent } from "./src/db/assess-content.js";

const PARENT = "86a84278-c8ae-415e-8fbc-6140b1b7c88e";
const mode = process.argv[2] === "run" ? "run" : "preview";
const topic = (() => {
  const i = process.argv.indexOf("--topic");
  return i >= 0 ? process.argv[i + 1] ?? "lunyu" : "lunyu";
})();
const course = (() => {
  const i = process.argv.indexOf("--course");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
const limit = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1]) || 5 : undefined;
})();

const db = openParentLib(path.resolve("data"), PARENT);
const rows = db
  .prepare(
    `SELECT c.title AS title, c.assess_rubric AS md FROM courses c
     WHERE c.topic = ? AND c.assess_rubric != ''
     AND NOT EXISTS (SELECT 1 FROM course_category_questions ccq JOIN courses c2 ON c2.uuid = ccq.course_id
                     WHERE c2.topic = c.topic AND c2.title = c.title)
     ORDER BY c.sort_order, c.title LIMIT 20`
  )
  .all(topic) as Array<{ title: string; md: string }>;
console.log(`家长=${PARENT.slice(0, 8)} topic=${topic} 待迁移(前20)=${rows.length} mode=${mode}`);

if (mode === "preview") {
  const list = course ? rows.filter((r) => r.title === course) : rows.slice(0, limit ?? 5);
  for (const r of list) {
    const res = parseCourseRubric(r.md);
    if (!res.ok) {
      console.log(`✗ ${r.title}: ${res.reason}`);
      continue;
    }
    const detail = res.items.map((i) => `${i.categoryName}×${i.questions.length}`).join(" ");
    console.log(`✓ ${r.title} | 背诵原文×${res.refTexts} | ${detail}`);
    for (const it of res.items) {
      const q0 = it.questions[0];
      console.log(`    [${it.categoryName}] ${String(q0?.stem || "").slice(0, 42)}… 答案=${String(q0?.answer || "").slice(0, 26)}`);
    }
  }
  db.close();
  console.log("预览结束（未写库）。确认后运行： npx tsx migrate-assess-rubrics.ts run --topic " + topic);
  process.exit(0);
}

const out = migrateTopicRubrics(db, topic, course);
console.log(JSON.stringify(out, null, 1));
// 抽样展示已迁移课程内容
const demo = course
  ? [course]
  : (db
      .prepare(
        `SELECT c.title FROM courses c WHERE c.topic=? AND EXISTS (
           SELECT 1 FROM course_category_questions ccq JOIN courses c2 ON c2.uuid=ccq.course_id
           WHERE c2.topic=c.topic AND c2.title=c.title) ORDER BY c.sort_order LIMIT 3`
      )
      .all(topic) as Array<{ title: string }>).map((r) => r.title);
for (const t of demo) {
  const content = listCourseContent(db, db.prepare("SELECT uuid FROM courses WHERE topic=? AND title=?").get(topic, t)?.uuid ?? "");
  console.log(
    `样例课「${t}」：` + content.items.map((i) => `${i.categoryName}(${i.questions.length})`).join(",")
  );
}
db.close();
