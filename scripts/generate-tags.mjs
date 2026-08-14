#!/usr/bin/env node
// 生成 tags 倒排索引（从教学资料 frontmatter tags 提取），并把新标签合并进 taxonomy
import fs from "fs";
import path from "path";

const CHILD_DIR = "C:/Users/79734/Documents/pi/data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674";
const LEARNING_DIR = path.join(CHILD_DIR, "learning");
const TAGS_DIR = path.join(CHILD_DIR, "tags");

// 提取 markdown frontmatter 的 tags（支持多行数组 和 空数组）
function extractTags(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return [];
  const fm = m[1];
  const tagBlock = fm.match(/^tags:\s*([\s\S]*?)(?=^[a-zA-Z\u4e00-\u9fa5]|^$)/m);
  if (!tagBlock) {
    // tags: [a, b] 单行
    const inline = fm.match(/^tags:\s*\[(.*)\]$/m);
    if (!inline) return [];
    return inline[1].split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
  }
  const body = tagBlock[1];
  // 多行数组：- 标签
  const items = body.match(/^-\s*(.+)$/gm);
  if (!items) return [];
  return items.map((l) => l.replace(/^-\s*/, "").trim().replace(/["']/g, "")).filter(Boolean);
}

// 主题目录 → 中文主题名
const TOPIC_NAMES = {
  lunyu: "论语", qianziwen: "千字文", xiaojing: "孝经",
  xiaozhuan: "小篆", taodi: "陶笛", hanzigong: "汉字宫",
  english: "英语", reading: "春风阅读",
};

// tag -> 关联课程列表
const tagIndex = {}; // tag -> [{course, topicDir, topicName}]

for (const topicDir of Object.keys(TOPIC_NAMES)) {
  const materials = path.join(LEARNING_DIR, topicDir, "materials");
  if (!fs.existsSync(materials)) continue;
  for (const f of fs.readdirSync(materials)) {
    if (!f.endsWith(".md")) continue;
    const content = fs.readFileSync(path.join(materials, f), "utf-8");
    const tags = extractTags(content);
    for (const tag of tags) {
      if (!tagIndex[tag]) tagIndex[tag] = [];
      tagIndex[tag].push({
        course: f.replace(".md", ""),
        topicDir,
        topicName: TOPIC_NAMES[topicDir],
      });
    }
  }
}

// 生成 tags/{tag}.md
fs.mkdirSync(TAGS_DIR, { recursive: true });
const sortedTags = Object.keys(tagIndex).sort();
let generated = 0;
for (const tag of sortedTags) {
  const courses = tagIndex[tag];
  const lines = [
    `# 标签：${tag}`,
    "",
    "## 关联知识点",
  ];
  for (const c of courses) {
    lines.push(`- ${c.topicName}·${c.course} (learning/${c.topicDir}/${c.topicDir}.md)`);
  }
  lines.push("", "## 关联生活事件", "");
  fs.writeFileSync(path.join(TAGS_DIR, `${tag}.md`), lines.join("\n"), "utf-8");
  generated++;
}

console.log(`✅ 生成 ${generated} 个标签倒排索引`);
console.log("\n标签列表：", sortedTags.join("、"));

// 合并新标签到 taxonomy（追加在对应维度，缺失的加到"其他"维度）
const taxPath = path.join(TAGS_DIR, "taxonomy.md");
let taxonomy = fs.existsSync(taxPath) ? fs.readFileSync(taxPath, "utf-8") : "";

const existingTags = new Set();
for (const line of taxonomy.split("\n")) {
  const m = line.match(/^- (\S+)：/);
  if (m) existingTags.add(m[1]);
}

const newTags = sortedTags.filter((t) => !existingTags.has(t));
if (newTags.length) {
  // 追加到「其他」维度（原 OpenClaw 标签，与预设词表不同）
  let otherSection = "\n## 其他\n\n";
  for (const t of newTags) {
    otherSection += `- ${t}：从原学习档案迁移的标签，释义待补\n`;
  }
  taxonomy += otherSection;
  fs.writeFileSync(taxPath, taxonomy, "utf-8");
  console.log(`\n合并 ${newTags.length} 个新标签到 taxonomy：${newTags.join("、")}`);
} else {
  console.log("\n无新标签需要合并");
}
