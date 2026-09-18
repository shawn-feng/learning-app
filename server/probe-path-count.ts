/**
 * 一次性：核验「命名路径 topic_questions」的口径（设计稿用数据）。
 * 路径：courses.topic → courses.uuid → knowledge_points.course_uuid → course_knowledge_questions → question_bank
 */
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(process.cwd(), "data", "parents");
const out: string[] = [];

function toU8(p: string) {
  writeFileSync(join(process.cwd(), "path-count.out.txt"), out.join("\n"), "utf8");
}

// 找出题量最大的家长库
let best: { p: string; n: number } | null = null;
for (const pid of readdirSync(ROOT)) {
  const f = join(ROOT, pid, "parent.sqlite");
  if (!existsSync(f)) continue;
  const db = new DatabaseSync(f, { readOnly: true });
  const n = (db.prepare("SELECT COUNT(*) AS n FROM courses").get() as { n: number }).n;
  db.close();
  if (!best || n > best.n) best = { p: f, n };
}
if (!best) {
  out.push("无家长库");
  toU8("path-count.out.txt");
  process.exit(1);
}
out.push(`样本家长库：${best.p}（courses ${best.n} 行）`);

const db = new DatabaseSync(best.p, { readOnly: true });

out.push("\n【topics】");
for (const r of db.prepare("SELECT name, topic_key FROM topics").all() as Array<{ name: string; topic_key: string }>) {
  const c = db.prepare("SELECT COUNT(*) AS n FROM courses WHERE topic = ?").get(r.topic_key) as { n: number };
  out.push(`  name=${r.name}  topic_key=${r.topic_key}  该主题课程数=${c.n}`);
}

out.push("\n【courses.topic 值域 vs topics 两列】");
const distinct = db.prepare("SELECT topic, COUNT(*) AS n FROM courses GROUP BY topic ORDER BY n DESC").all() as Array<{
  topic: string;
  n: number;
}>;
for (const d of distinct) {
  const byKey = db.prepare("SELECT COUNT(*) AS n FROM topics WHERE topic_key = ?").get(d.topic) as { n: number };
  const byName = db.prepare("SELECT COUNT(*) AS n FROM topics WHERE name = ?").get(d.topic) as { n: number };
  out.push(`  courses.topic='${d.topic}' 行=${d.n}  命中 topics.topic_key=${byKey.n}  命中 topics.name=${byName.n}`);
}

out.push("\n【命名路径 topic_questions 口径】");
const pathSql = `
SELECT COUNT(*) AS q_n,
       COUNT(DISTINCT c.uuid) AS course_n,
       COUNT(DISTINCT kp.id) AS kp_n
  FROM question_bank q
  JOIN course_knowledge_questions ckq ON ckq.question_id = q.id
  JOIN knowledge_points kp              ON kp.id = ckq.knowledge_point_id
  JOIN courses c                        ON c.uuid = kp.course_uuid
`;
const total = db.prepare(pathSql).get() as { q_n: number; course_n: number; kp_n: number };
out.push(`  全库：题 ${total.q_n} 条 / 涉及课程 ${total.course_n} 门 / 知识点 ${total.kp_n} 个`);

const lunyuSql = `
SELECT COUNT(*) AS q_n,
       COUNT(DISTINCT c.uuid) AS course_n,
       COUNT(DISTINCT kp.id) AS kp_n
  FROM courses c
  JOIN knowledge_points kp              ON kp.course_uuid = c.uuid
  JOIN course_knowledge_questions ckq   ON ckq.knowledge_point_id = kp.id
  JOIN question_bank q                  ON q.id = ckq.question_id
 WHERE c.topic = 'lunyu'
`;
const lunyu = db.prepare(lunyuSql).get() as { q_n: number; course_n: number; kp_n: number };
out.push(`  where courses.topic='lunyu'：题 ${lunyu.q_n} 条 / 涉及课程 ${lunyu.course_n} 门 / 知识点 ${lunyu.kp_n} 个`);

out.push("\n【对比：现状分步查询要几次】");
for (const [label, sql] of [
  ["① courses where topic='lunyu'（限 200）", "SELECT COUNT(*) AS n FROM courses WHERE topic='lunyu'"],
  ["② kp where course_uuid in (该主题课程)", "SELECT COUNT(*) AS n FROM knowledge_points kp JOIN courses c ON c.uuid=kp.course_uuid AND c.topic='lunyu'"],
  ["③ ckq where course_id in (该主题课程)", "SELECT COUNT(*) AS n FROM course_knowledge_questions ckq JOIN courses c ON c.uuid=ckq.course_id AND c.topic='lunyu'"],
  ["④ question_bank 全表（探值域用）", "SELECT COUNT(*) AS n FROM question_bank"],
] as Array<[string, string]>) {
  out.push(`  ${label} → ${(db.prepare(sql).get() as { n: number }).n} 行`);
}

db.close();
toU8("path-count.out.txt");
console.log(out.join("\n"));
