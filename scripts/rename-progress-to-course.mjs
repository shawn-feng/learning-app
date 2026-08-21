// 工具参数重命名：kb_insert/kb_update 的 table 值 "progress" → "course"（消除「操作 progress 表」误解；
// 实际数据一直在 courses 表，progress 是旧参数名）。不碰 kb_query 的 query:"progress"（查询语义）。
import fs from "fs";
import path from "path";

const files = new Set([
  "C:/Users/79734/Documents/pi/data/shared/skills/recording/SKILL.md",
  "C:/Users/79734/Documents/pi/electron/lib/pi-session.ts",
  "C:/Users/79734/Documents/pi/test/kb-lint-method.test.ts",
  "C:/Users/79734/Documents/pi/test/kb-tools.test.ts",
  "C:/Users/79734/Documents/pi/test/kb-sqlite.test.ts",
]);

const childrenDir = "C:/Users/79734/Documents/pi/data/children";
for (const cid of fs.readdirSync(childrenDir)) {
  const ld = path.join(childrenDir, cid, "learning");
  if (!fs.existsSync(ld)) continue;
  for (const t of fs.readdirSync(ld)) {
    const f = path.join(ld, t, "method.md");
    if (fs.existsSync(f)) files.add(f);
  }
}

let changed = 0;
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  let text = fs.readFileSync(f, "utf-8");
  const orig = text;
  // 1) table:"progress" / table: "progress" → table:"course"
  text = text.replace(/table:\s*"progress"/g, 'table:"course"');
  // 2) 「kb_update progress」措辞 → 「kb_update course」（recording / AGENTS 模板）
  text = text.replace(/kb_update progress/g, "kb_update course");
  if (text !== orig) {
    fs.writeFileSync(f, text, "utf-8");
    console.log("已更新: " + f.replace("C:/Users/79734/Documents/pi/", ""));
    changed++;
  }
}
console.log("共更新 " + changed + " 个文件");
