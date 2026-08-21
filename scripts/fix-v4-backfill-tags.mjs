// v4 标签补全：把历史 daily/courses 用过的、但不在 tags 定义表的标签补进定义表
// （dimension=历史，criteria 待家长完善）——保持历史可检索，不破坏历史数据。
import { DatabaseSync } from "node:sqlite";
import path from "path";
import { normalizeTags } from "../electron/lib/kb-sqlite.ts";

const childDir = "C:/Users/79734/Documents/pi/data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674";
const db = new DatabaseSync(path.join(childDir, "kb.sqlite"));
db.exec("PRAGMA busy_timeout = 3000");

const defs = new Set(db.prepare("SELECT tag FROM tags").all().map((r) => r.tag));
const used = new Set();

for (const r of db.prepare("SELECT tags FROM daily_entries WHERE tags != ''").all()) {
  for (const t of normalizeTags(r.tags).split(",")) if (t) used.add(t);
}
for (const r of db.prepare("SELECT tags FROM courses WHERE tags != ''").all()) {
  for (const t of normalizeTags(r.tags).split(",")) if (t) used.add(t);
}

const missing = [...used].filter((t) => !defs.has(t)).sort();
const insert = db.prepare("INSERT OR IGNORE INTO tags (tag, dimension, criteria) VALUES (?, ?, ?)");
for (const t of missing) {
  insert.run(t, "历史", "历史记录沿用标签，释义待家长完善");
}
console.log("补入标签定义:", missing.length, "个");
console.log(JSON.stringify(missing));
db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')").run();
db.close();
