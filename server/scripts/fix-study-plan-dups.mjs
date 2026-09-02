/**
 * 学习计划存量重复行修复（2026-09-02，一次性问题）。
 * 背景：旧版 create 客户端「分多次追加同一天」时每次都新建了含完整清单的行 → 同日多行重复展示。
 * 修复：对 study_plan_items 里 active=1 的行按 (child_id, kind, date, origin) 分组——
 *   保留最早行，内容 = 全组行内文本的有序去重并集（行按 created_at 升序、行内按原顺序），其余行删除。
 * 用法：node scripts/fix-study-plan-dups.mjs <sqlite 路径>（缺省 server/data/server.sqlite）
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbPath = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "server.sqlite");
const db = new DatabaseSync(dbPath);

const groups = db
  .prepare("SELECT child_id, kind, date, origin, COUNT(*) n FROM study_plan_items WHERE active = 1 GROUP BY child_id, kind, date, origin HAVING n > 1")
  .all();
console.log("重复分组数:", groups.length);

let removed = 0;
for (const g of groups) {
  const rows = db
    .prepare("SELECT id, content, created_at FROM study_plan_items WHERE child_id = ? AND kind = ? AND date = ? AND origin = ? AND active = 1 ORDER BY created_at ASC")
    .all(g.child_id, g.kind, g.date, g.origin);
  if (rows.length <= 1) continue;
  const kept = rows[0];
  const seen = new Set();
  const merged = [];
  for (const r of rows) {
    let arr = [];
    try { arr = JSON.parse(r.content); } catch { arr = []; }
    for (const it of Array.isArray(arr) ? arr : []) {
      const t = typeof it?.text === "string" ? it.text.trim() : "";
      if (!t || seen.has(t)) continue;
      seen.add(t);
      merged.push({ text: t, topicKey: typeof it?.topicKey === "string" ? it.topicKey : undefined });
    }
  }
  db.prepare("UPDATE study_plan_items SET content = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(merged), new Date().toISOString(), kept.id);
  for (const r of rows.slice(1)) {
    db.prepare("DELETE FROM study_plan_items WHERE id = ?").run(r.id);
    removed++;
  }
  console.log(`merge ${g.child_id.slice(0, 8)} ${g.date} ${g.origin}: ${rows.length} 行 → 1 行（${merged.length} 项）`);
}
db.close();
console.log("删除重复行:", removed);
