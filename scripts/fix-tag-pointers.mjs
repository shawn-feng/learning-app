// 修复 tags 倒排的失效 learning 指针（SPEC P5 历史遗留：旧 learning/taodi.md → learning/taodi/taodi.md）
import { openKbDb } from "../electron/lib/kb-sqlite.ts";
import fs from "fs";
import path from "path";

const childDir = "C:/Users/79734/Documents/pi/data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674";
const db = openKbDb(childDir);
const links = db.prepare("SELECT tag, kind, title, pointer FROM tag_links WHERE pointer LIKE 'learning/%'").all();
let fixed = 0;
let broken = 0;
for (const l of links) {
  const rel = l.pointer.replace(/^learning\//, "");
  const exists = fs.existsSync(path.join(childDir, "learning", rel));
  if (exists) continue;
  // 尝试主题目录形式：learning/{topic}/{topic}.md
  const topic = rel.replace(/\.md$/, "").split("/")[0];
  const dirForm = `learning/${topic}/${topic}.md`;
  if (fs.existsSync(path.join(childDir, dirForm))) {
    db.prepare("UPDATE tag_links SET pointer = ? WHERE tag = ? AND kind = ? AND title = ?").run(dirForm, l.tag, l.kind, l.title);
    console.log(`修复: ${l.tag} | ${l.pointer} → ${dirForm} | ${l.title}`);
    fixed++;
  } else {
    console.log(`仍失效: ${l.tag} | ${l.pointer} | ${l.title}`);
    broken++;
  }
}
db.close();
console.log(`完成：修复 ${fixed} 条，仍失效 ${broken} 条。`);
