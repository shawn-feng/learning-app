// P2 迁移一致性校验：SQLite vs markdown 存量计数对比
import { openKbDb, parseDailyFile, parseProgressFile, parseTagFile } from "../electron/lib/kb-sqlite.ts";
import fs from "fs";
import path from "path";

const childDir = "C:/Users/79734/Documents/pi/data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674";

// SQLite 侧
const db = openKbDb(childDir);
const dbDaily = (db.prepare("SELECT COUNT(*) AS c FROM daily_entries").get()).c;
const dbBlocks = db.prepare("SELECT block, COUNT(*) AS c FROM daily_entries GROUP BY block").all();
const dbProgress = (db.prepare("SELECT COUNT(*) AS c FROM topic_progress").get()).c;
const dbTopics = (db.prepare("SELECT COUNT(*) AS c FROM topics").get()).c;
const dbRules = (db.prepare("SELECT COUNT(*) AS c FROM rules").get()).c;
const dbTags = (db.prepare("SELECT COUNT(*) AS c FROM tag_links").get()).c;
db.close();

// markdown 侧
let mdDaily = 0;
const mdBlockCount = {};
const dailyDir = path.join(childDir, "daily");
for (const f of fs.readdirSync(dailyDir)) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  if (!m) continue;
  const entries = parseDailyFile(m[1], fs.readFileSync(path.join(dailyDir, f), "utf-8"));
  mdDaily += entries.length;
  for (const e of entries) mdBlockCount[e.block] = (mdBlockCount[e.block] || 0) + 1;
}
let mdProgress = 0;
const learningDir = path.join(childDir, "learning");
for (const t of fs.readdirSync(learningDir, { withFileTypes: true })) {
  if (!t.isDirectory()) continue;
  const pf = path.join(learningDir, t.name, `${t.name}.md`);
  if (fs.existsSync(pf)) mdProgress++;
}
let mdTags = 0;
const tagsDir = path.join(childDir, "tags");
for (const f of fs.readdirSync(tagsDir)) {
  if (!f.endsWith(".md") || f === "taxonomy.md") continue;
  mdTags += parseTagFile(f.replace(/\.md$/, ""), fs.readFileSync(path.join(tagsDir, f), "utf-8")).length;
}

console.log("=== daily 条目 ===\n  SQLite:", dbDaily, "| markdown:", mdDaily, "|", dbDaily === mdDaily ? "✅ 一致" : "❌ 不一致");
console.log("  SQLite 按区块:", JSON.stringify(dbBlocks));
console.log("  markdown 按区块:", JSON.stringify(mdBlockCount));
console.log("=== 进度主题 ===\n  SQLite:", dbProgress, "| markdown:", mdProgress, "|", dbProgress === mdProgress ? "✅ 一致" : "❌ 不一致");
console.log("=== topics 登记 ===\n  SQLite:", dbTopics);
console.log("=== rules 登记 ===\n  SQLite:", dbRules);
console.log("=== tags 倒排 ===\n  SQLite:", dbTags, "| markdown:", mdTags, "|", dbTags === mdTags ? "✅ 一致" : "❌ 不一致");
