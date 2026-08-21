// v4 补丁：真实库已跑过 ensureV4（rules 匹配用了错误的目录名、tags 回填未去 # 前缀），
// 此处从归档重新回填：① topics.rules_json（rules.md frontmatter，按中文名匹配）；② daily.tags 重新归一化。
import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { extractTagsFromRaw } from "../electron/lib/kb-sqlite.ts";
import { extractFrontmatter } from "../electron/lib/kb-parser.ts";

const childDir = "C:/Users/79734/Documents/pi/data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674";
const db = new DatabaseSync(path.join(childDir, "kb.sqlite"));
db.exec("PRAGMA busy_timeout = 3000");

// 1) rules_json 回填（从 rules.md frontmatter，key = 中文名）
const rulesFile = path.join(childDir, "learning", "rules.md");
if (fs.existsSync(rulesFile)) {
  const fm = extractFrontmatter(fs.readFileSync(rulesFile, "utf-8"));
  if (fm) {
    const block = fm.data.match(/rules:\s*\n([\s\S]*?)(?=\n\S|$)/);
    if (block) {
      const re = /^\s*([^\s:{]+)\s*:\s*\{([^}]*)\}/gm;
      let m;
      let n = 0;
      while ((m = re.exec(block[1])) !== null) {
        const kv = {};
        const re2 = /(\w+)\s*:\s*("([^"]*)"|([^,}]+))/g;
        let m2;
        while ((m2 = re2.exec(m[2])) !== null) {
          kv[m2[1]] = (m2[3] !== undefined ? m2[3] : m2[4]).trim();
        }
        const r = db.prepare("UPDATE topics SET rules_json = ? WHERE name = ?").run(JSON.stringify(kv), m[1].trim());
        if (r.changes > 0) n++;
      }
      console.log("rules_json 回填:", n, "个主题");
    }
  }
}

// 2) daily.tags 重新归一化（去 # 前缀等）
const rows = db.prepare("SELECT rowid, raw FROM daily_entries WHERE tags != ''").all();
const update = db.prepare("UPDATE daily_entries SET tags = ? WHERE rowid = ?");
let n = 0;
for (const r of rows) {
  const tags = extractTagsFromRaw(r.raw);
  if (tags !== r.tags) {
    update.run(tags, r.rowid);
    n++;
  }
}
console.log("daily.tags 归一化:", n, "行");

// 3) courses.tags 归一化（存量 progress tags 若有 # 前缀）
const crows = db.prepare("SELECT rowid, tags FROM courses WHERE tags != ''").all();
const cupdate = db.prepare("UPDATE courses SET tags = ? WHERE rowid = ?");
let cn = 0;
for (const r of crows) {
  const clean = r.tags.trim().replace(/^\[|\]$/g, "").split(/[,，、\s]+/).map((t) => t.trim().replace(/^#+/, "")).filter(Boolean).join(",");
  if (clean !== r.tags) {
    cupdate.run(clean, r.rowid);
    cn++;
  }
}
console.log("courses.tags 归一化:", cn, "行");
db.close();
