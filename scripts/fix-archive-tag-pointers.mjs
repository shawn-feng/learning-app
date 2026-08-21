// 修复归档 tags/*.md 中失效 learning 指针（旧 learning/taodi.md → learning/taodi/taodi.md）
import fs from "fs";
import path from "path";

const tagsDir = "C:/Users/79734/Documents/pi/data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674/tags";
const topics = ["taodi", "xiaozhuan", "hanzigong", "qianziwen", "reading"];

let changed = 0;
for (const f of fs.readdirSync(tagsDir)) {
  if (!f.endsWith(".md") || f === "taxonomy.md") continue;
  const p = path.join(tagsDir, f);
  const text = fs.readFileSync(p, "utf-8");
  let updated = text;
  for (const t of topics) {
    updated = updated.split(`learning/${t}.md`).join(`learning/${t}/${t}.md`);
  }
  if (updated !== text) {
    fs.writeFileSync(p, updated, "utf-8");
    changed++;
    console.log(`updated: ${f}`);
  }
}
console.log(`完成：更新 ${changed} 个归档 tags 文件。`);
