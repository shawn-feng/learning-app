/**
 * 计划域 S5 补充脚本（2026-09-10）：回填**孩子库 courses.uuid**。
 *
 * 背景：孩子库 courses.uuid 是课程真引用 —— course_progress 视图（掌握度/学习状态）、
 * 计划行 course_uuid、考核明细 exam_plan_courses 都靠它 join。存量孩子库课程行没有该值，
 * 而迁移脚本 migrate-plan-domain.mts 会顺带回填；若只想先补 uuid（不跑全量迁移），用本脚本。
 *
 * 匹配规则：优先 (topic, title) 精确命中家长库 courses.uuid；退化按 title 唯一命中。仅填空、不覆盖。
 *
 * 用法：node ../node_modules/tsx/dist/cli.mjs backfill-kb-course-uuid.mts <dataDir> [parentId] [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../src/db.js";
import { openKb } from "../src/db/kb.js";
import { openParentLib } from "../src/db/parent-lib.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [dataDir = "", onlyParent = ""] = args.filter((a) => !a.startsWith("--"));
if (!dataDir || !fs.existsSync(dataDir)) {
  console.error("用法：tsx backfill-kb-course-uuid.mts <dataDir> [parentId] [--dry-run]");
  process.exit(1);
}

const db = openDb(dataDir);
let matched = 0;
let unmatched = 0;
const samples: string[] = [];

try {
  const parents = (
    onlyParent
      ? [{ id: onlyParent }]
      : (db.prepare("SELECT id FROM parents").all() as Array<{ id: string }>)
  ).map((r) => r.id);

  for (const parentId of parents) {
    // 家长库课程 uuid 真源（openParentLib 内部已幂等回填 uuid 并建唯一索引）
    const uuidByKey = new Map<string, string>();
    const uuidByName = new Map<string, string>();
    const dupNames = new Set<string>();
    try {
      const pdb = openParentLib(dataDir, parentId);
      try {
        const courses = pdb.prepare("SELECT topic, title, uuid FROM courses").all() as Array<{
          topic: string;
          title: string;
          uuid: string | null;
        }>;
        for (const c of courses) {
          if (!c.uuid) continue;
          uuidByKey.set(`${c.topic}\u0000${c.title}`, String(c.uuid));
          const t = String(c.title || "");
          if (!t) continue;
          if (uuidByName.has(t)) dupNames.add(t);
          else uuidByName.set(t, String(c.uuid));
        }
      } finally {
        pdb.close();
      }
    } catch (e) {
      console.warn(`[skip] 家长 ${parentId} 家长库打开失败：${String((e as Error).message || e)}`);
      continue;
    }

    const kids = (
      db.prepare("SELECT id FROM children WHERE parent_id = ?").all(parentId) as Array<{ id: string }>
    ).map((r) => r.id);
    const kbRoot = path.join(dataDir, "kb", parentId);

    for (const childId of kids) {
      if (!fs.existsSync(path.join(kbRoot, `${childId}.sqlite`))) continue;
      let kb;
      try {
        kb = openKb(dataDir, parentId, childId);
      } catch (e) {
        console.warn(`[skip] 孩子 ${childId} 库打开失败：${String((e as Error).message || e)}`);
        continue;
      }
      try {
        const rows = kb.prepare("SELECT topic, title FROM courses WHERE uuid IS NULL OR uuid = ''").all() as Array<{
          topic: string;
          title: string;
        }>;
        if (!rows.length) continue;
        const upd = kb.prepare("UPDATE courses SET uuid = ? WHERE topic = ? AND title = ?");
        let hit = 0;
        kb.exec("BEGIN");
        try {
          for (const r of rows) {
            const title = String(r.title || "");
            // ① (topic,title) 精确 → ② title 唯一命中（同名跨主题歧义时跳过，避免张冠李戴）
            let uuid = uuidByKey.get(`${r.topic}\u0000${title}`) ?? "";
            if (!uuid && title && !dupNames.has(title)) uuid = uuidByName.get(title) ?? "";
            if (!uuid) {
              unmatched++;
              if (samples.length < 20) samples.push(`${parentId}/${childId}: ${r.topic}/${title}`);
              continue;
            }
            if (!dryRun) upd.run(uuid, r.topic, r.title);
            hit++;
            matched++;
          }
          kb.exec("COMMIT");
        } catch (e) {
          kb.exec("ROLLBACK");
          throw e;
        }
        console.log(`家长 ${parentId} / 孩子 ${childId}：待填 ${rows.length}，回填 ${hit}`);
      } finally {
        kb.close();
      }
    }
  }

  console.log(`\n${dryRun ? "[DRY-RUN] " : ""}合计：回填 ${matched}，未命中 ${unmatched}`);
  if (samples.length) {
    console.log("未命中样例（课程名与家长库不一致 / 同名歧义 / 课程已删）：");
    for (const s of samples) console.log("  - " + s);
  }
} finally {
  db.close();
}
