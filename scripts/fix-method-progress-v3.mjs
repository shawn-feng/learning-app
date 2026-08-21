// method.md 批量更新（schema v3）：移除「手动更新进度 frontmatter」步骤，
// 改为「learned/total/next/updated 视图自动计算」；「读 frontmatter next」改为「next 自动计算」。
import fs from "fs";
import path from "path";

const childrenDir = "C:/Users/79734/Documents/pi/data/children";
let changed = 0;

for (const childId of fs.readdirSync(childrenDir)) {
  const learningDir = path.join(childrenDir, childId, "learning");
  if (!fs.existsSync(learningDir)) continue;
  for (const topic of fs.readdirSync(learningDir)) {
    const f = path.join(learningDir, topic, "method.md");
    if (!fs.existsSync(f)) continue;
    let text = fs.readFileSync(f, "utf-8");
    const orig = text;

    // 1) 整段替换「；frontmatter 用 …（learned +1）。示例：…，再 …value:"283"}」
    //    保留第一个「掌握度」示例，topic 从示例中捕获。
    text = text.replace(
      /；frontmatter 用[^\n]*?value:"283"\}/g,
      '；learned/total/next/updated 由系统自动计算（视图），**不要手动更新**。示例：`kb_update {table:"progress", topic:"<主题目录名>", item:"<课程名>", field:"掌握度", value:"熟练"}`'
    );

    // 2) 读 frontmatter next 的各类表述 → next 自动计算
    text = text.replace(/读 `learning\/[^`]+` 的 frontmatter `next` 字段确定下一课/g, "下一课 `next` 由系统自动计算（get_progress / 顶部概览），直接使用，不要读文件");
    text = text.replace(/读 `learning\/[^`]+` 的 frontmatter `next` 字段/g, "下一课 `next` 由系统自动计算（get_progress / 顶部概览），直接使用，不要读文件");
    text = text.replace(/读 frontmatter `next` 字段确定当前篇目/g, "下一课 `next` 由系统自动计算（get_progress / 顶部概览），直接使用，不要读文件");
    text = text.replace(/读 frontmatter `next` 字段确定下一课/g, "下一课 `next` 由系统自动计算（get_progress / 顶部概览），直接使用，不要读文件");
    text = text.replace(/frontmatter `next` 字段确定下一课/g, "下一课 `next` 由系统自动计算（get_progress / 顶部概览），直接使用，不要读文件");

    if (text !== orig) {
      fs.writeFileSync(f, text, "utf-8");
      console.log("已更新: " + childId + "/learning/" + topic + "/method.md");
      changed++;
    }
  }
}

console.log("共更新 " + changed + " 个 method.md");
