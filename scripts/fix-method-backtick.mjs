// 修复 method.md 里替换 frontmatter 步骤后残留的双反引号
import fs from "fs";
import path from "path";

const dir = "C:/Users/79734/Documents/pi/data/children";
let fixed = 0;
for (const cid of fs.readdirSync(dir)) {
  const ld = path.join(dir, cid, "learning");
  if (!fs.existsSync(ld)) continue;
  for (const t of fs.readdirSync(ld)) {
    const f = path.join(ld, t, "method.md");
    if (!fs.existsSync(f)) continue;
    let text = fs.readFileSync(f, "utf-8");
    const before = text;
    // 「value:"熟练"}``」→「value:"熟练"}」；「value:"✅"}``」→「value:"✅"}」
    text = text.replace(/value:"熟练"\}``/g, 'value:"熟练"}`');
    text = text.replace(/value:"✅"\}``/g, 'value:"✅"}`');
    if (text !== before) {
      fs.writeFileSync(f, text, "utf-8");
      fixed++;
      console.log("修复: " + t);
    }
  }
}
console.log("修复 " + fixed + " 个文件");
