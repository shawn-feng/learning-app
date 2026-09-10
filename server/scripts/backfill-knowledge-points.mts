/**
 * 知识点存量回填（2026-09-10 拍板：知识点建实体，题目经挂载关系关联）。
 * 对每个家长库：把课程下题目的非空 knowledge_summary 文本去重生成 knowledge_points，
 * 再按文本精确匹配回填 course_category_questions.knowledge_point_id（仅填空，不覆盖已有值）。
 * 用法：node ../node_modules/tsx/dist/cli.mjs backfill-knowledge-points.mts <dataDir> [parentId]
 *   <dataDir> 必填（如 /opt/learning-server/data）；[parentId] 缺省 = 遍历 dataDir/parents/* 全部家长。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openParentLib } from "../src/db/parent-lib.js";

const dataDir = process.argv[2] || "";
if (!dataDir || !fs.existsSync(dataDir)) {
  console.error("用法：tsx backfill-knowledge-points.mts <dataDir> [parentId]  （dataDir 必须存在）");
  process.exit(1);
}
const onlyParent = process.argv[3] || "";

const parentsDir = path.join(dataDir, "parents");
const parentIds = onlyParent
  ? [onlyParent]
  : fs.existsSync(parentsDir)
    ? fs.readdirSync(parentsDir).filter((d) => fs.existsSync(path.join(parentsDir, d, "parent.sqlite")))
    : [];
if (!parentIds.length) {
  console.log("没有找到任何家长库，结束。");
  process.exit(0);
}

let totalCourses = 0;
let totalKpCreated = 0;
let totalLinked = 0;

for (const parentId of parentIds) {
  const db = openParentLib(dataDir, parentId); // 打开即确保 knowledge_points 表 + ccq.knowledge_point_id 列
  try {
    // 有挂载且未关联知识点的课程
    const courses = db
      .prepare(
        `SELECT DISTINCT ccq.course_id AS uuid
         FROM course_category_questions ccq
         JOIN question_bank qb ON qb.id = ccq.question_id
         WHERE ccq.knowledge_point_id IS NULL AND TRIM(COALESCE(qb.knowledge_summary, '')) != ''`
      )
      .all() as Array<{ uuid: string }>;

    for (const { uuid } of courses) {
      const rows = db
        .prepare(
          `SELECT ccq.rowid AS rid, TRIM(qb.knowledge_summary) AS ks
           FROM course_category_questions ccq
           JOIN question_bank qb ON qb.id = ccq.question_id
           WHERE ccq.course_id = ? AND ccq.knowledge_point_id IS NULL AND TRIM(COALESCE(qb.knowledge_summary, '')) != ''`
        )
        .all(uuid) as Array<{ rid: number; ks: string }>;

      // 概要文本 → 知识点 id（同课去重；超长名截断）
      const kpIdByName = new Map<string, string>();
      const nameOf = (s: string) => (s.length > 50 ? s.slice(0, 47) + "…" : s);
      for (const r of rows) {
        const name = nameOf(r.ks);
        if (kpIdByName.has(name)) continue;
        let id: string;
        const exist = db.prepare("SELECT id FROM knowledge_points WHERE course_uuid = ? AND name = ?").get(uuid, name);
        if (exist) {
          id = String((exist as { id: string }).id);
        } else {
          const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM knowledge_points WHERE course_uuid = ?").get(uuid) as { next: number }).next;
          id = randomUUID();
          db.prepare("INSERT INTO knowledge_points (id, course_uuid, name, seq) VALUES (?, ?, ?, ?)").run(id, uuid, name, seq);
          totalKpCreated++;
        }
        kpIdByName.set(name, id);
      }

      const upd = db.prepare("UPDATE course_category_questions SET knowledge_point_id = ? WHERE rowid = ?");
      for (const r of rows) {
        const id = kpIdByName.get(nameOf(r.ks));
        if (!id) continue;
        upd.run(id, r.rid);
        totalLinked++;
      }
      totalCourses++;
    }
    console.log(`家长 ${parentId}: 处理课程 ${courses.length} 门`);
  } finally {
    db.close();
  }
}

console.log(`完成：${totalCourses} 门课，新建知识点 ${totalKpCreated} 个，回填关联 ${totalLinked} 条。`);
