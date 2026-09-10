/**
 * 计划域 S1（2026-09-10）：回填 study_plan_items.course_uuid。
 * 按 (topic_key, course_name) 从家长库 courses.uuid 对账，仅填空（不覆盖已有值）。
 * 用法：node ../node_modules/tsx/dist/cli.mjs backfill-plan-course-uuid.mts <dataDir> [parentId] [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../src/db.js";
import { openParentLib } from "../src/db/parent-lib.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [dataDir = "", onlyParent = ""] = args.filter((a) => !a.startsWith("--"));
if (!dataDir || !fs.existsSync(dataDir)) {
  console.error("用法：tsx backfill-plan-course-uuid.mts <dataDir> [parentId] [--dry-run]");
  process.exit(1);
}

const db = openDb(dataDir);
try {
  const rows = db
    .prepare(
      `SELECT id, parent_id, topic_key, course_name FROM study_plan_items
       WHERE (course_uuid IS NULL OR course_uuid = '') ${onlyParent ? "AND parent_id = ?" : ""}
       ORDER BY parent_id, date`
    )
    .all(...(onlyParent ? [onlyParent] : [])) as Array<{
    id: string;
    parent_id: string;
    topic_key: string;
    course_name: string;
  }>;

  if (!rows.length) {
    console.log("没有待回填的 study_plan_items 行，结束。");
    process.exit(0);
  }

  // 按家长分组
  const byParent = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byParent.get(r.parent_id) ?? [];
    arr.push(r);
    byParent.set(r.parent_id, arr);
  }

  let matched = 0;
  let unmatched = 0;
  const unmatchedSamples: string[] = [];
  const upd = db.prepare("UPDATE study_plan_items SET course_uuid = ?, updated_at = ? WHERE id = ?");
  const now = new Date().toISOString();

  for (const [parentId, list] of byParent) {
    let uuidByName = new Map<string, string>();
    try {
      const pdb = openParentLib(dataDir, parentId);
      try {
        const courses = pdb.prepare("SELECT topic, title, uuid FROM courses").all() as Array<{
          topic: string;
          title: string;
          uuid: string | null;
        }>;
        uuidByName = new Map(
          courses.filter((c) => c.uuid).map((c) => [`${c.topic}\u0000${c.title}`, String(c.uuid)])
        );
      } finally {
        pdb.close();
      }
    } catch (e) {
      console.warn(`[skip] 家长 ${parentId} 家长库打开失败：${String((e as Error).message || e)}`);
      unmatched += list.length;
      continue;
    }

    for (const r of list) {
      const uuid = uuidByName.get(`${r.topic_key}\u0000${r.course_name}`);
      if (uuid) {
        matched++;
        if (!dryRun) upd.run(uuid, now, r.id);
      } else {
        unmatched++;
        if (unmatchedSamples.length < 20) unmatchedSamples.push(`${r.topic_key}/${r.course_name}`);
      }
    }
    console.log(`家长 ${parentId}: 待填 ${list.length} 行，命中 ${list.filter((r) => uuidByName.has(`${r.topic_key}\u0000${r.course_name}`)).length}`);
  }

  console.log(`\n${dryRun ? "[DRY-RUN] " : ""}合计：命中 ${matched}，未命中 ${unmatched}（共 ${rows.length}）`);
  if (unmatchedSamples.length) {
    console.log("未命中样例（课程名与家长库不一致或课程已删）：");
    for (const s of unmatchedSamples) console.log("  - " + s);
  }
} finally {
  db.close();
}
