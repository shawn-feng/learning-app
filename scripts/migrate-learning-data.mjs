#!/usr/bin/env node
// 学习数据结构迁移脚本（一次性）：为现有孩子补齐新目录结构，
// 并把旧文件（life-events.md / daily-logs / study-topics.md / study-rules.md）搬运到新位置。
// 运行：node scripts/migrate-learning-data.mjs
import fs from "fs";
import path from "path";

const dataDir = path.join(process.cwd(), "data");
const childrenDir = path.join(dataDir, "children");

const TODAY = new Date().toISOString().slice(0, 10);

const TAXONOMY = `---
dimensions: [品格, 关系, 情绪, 学习]
updated: ${TODAY}
---

# 标签词表

> 记录生活事件、给知识点打标签时，只能从本词表选择；无法归类时打 \`其他\`。
> 家长可增删标签，增删后同步维护对应的 tags/{tag}.md 倒排索引。

## 品格

- 诚实：不撒谎，说真话
- 自律：管住自己，该做什么就做什么
- 责任：做好自己该做的事
- 坚持：遇到困难不放弃
- 感恩：感谢别人的帮助和付出
- 勇敢：面对害怕的事不退缩
- 谦虚：不自满，愿意向别人学习

## 关系

- 亲情：和家人之间的爱
- 友情：和朋友之间的情谊
- 助人：主动帮助别人
- 分享：愿意和别人一起分享
- 礼貌：对人友善、有礼

## 情绪

- 开心：高兴、愉快
- 难过：伤心、不开心
- 生气：发怒、不满
- 害怕：恐惧、担心

## 学习

- 学习习惯：按时学习、认真完成等好习惯
- 好奇心：对新事物感兴趣、爱问为什么
- 专注：专心做一件事
- 兴趣：对某个领域的喜爱
`;

const TOPICS = `---
topics: []
---

# 学习主题目录

> 每个主题一条记录。frontmatter 的 topics 数组元素：{name, file, method, progress}。
> 新增主题流程见 AGENTS.md 导航指令：在此加条目 + 创建 learning/{topic}/method.md + learning/{topic}/materials/。

| 主题 | 主题文件 | 教学方法 | 进度 |
|------|---------|---------|------|
`;

const RULES = `---
rules: {}
---

# 每日目标量

| 主题 | 每日量 | 复习要求 | 类型（必学/兴趣） |
|------|--------|---------|------|
`;

const PROGRESS = `# 跨天累积进度

> 记录跨天累积的学习状态（总进度、掌握度汇总等）。
`;

function ensureDirs(childDir) {
  for (const d of [
    "daily",
    "learning",
    "life",
    "inquiries",
    "tasks",
    "outputs",
    "tags",
  ]) {
    fs.mkdirSync(path.join(childDir, d), { recursive: true });
  }
}

function writeIfMissing(filePath, content) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, "utf-8");
    return true;
  }
  return false;
}

// 解析 life-events.md 的「## 日期」区块，返回 { "YYYY-MM-DD": [行, ...] }
function parseLifeEvents(content) {
  const result = {};
  let currentDate = null;
  for (const line of content.split("\n")) {
    const m = line.match(/^##\s+(\d{4}-\d{2}-\d{2})/);
    if (m) {
      currentDate = m[1];
      result[currentDate] = [];
    } else if (currentDate && line.trim().startsWith("-")) {
      result[currentDate].push(line.trim());
    }
  }
  return result;
}

function migrateLifeEvents(childDir) {
  const src = path.join(childDir, "life-events.md");
  if (!fs.existsSync(src)) return;
  const content = fs.readFileSync(src, "utf-8");
  const byDate = parseLifeEvents(content);

  for (const [date, lines] of Object.entries(byDate)) {
    if (!lines.length) continue;
    const month = date.slice(0, 7);
    const dailyPath = path.join(childDir, "daily", `${date}.md`);
    const lifeIndexPath = path.join(childDir, "life", `${month}.md`);

    // 追加到 daily 的「生活」区块
    let daily = fs.existsSync(dailyPath)
      ? fs.readFileSync(dailyPath, "utf-8")
      : "";
    if (!daily.includes("## 生活")) {
      daily += "\n## 生活\n";
    }
    for (const line of lines) {
      daily += `${line}  <!-- 迁移自 life-events.md，待 recording 补标签 -->\n`;
    }
    fs.writeFileSync(dailyPath, daily, "utf-8");

    // 追加 life 索引行
    let idx = fs.existsSync(lifeIndexPath)
      ? fs.readFileSync(lifeIndexPath, "utf-8")
      : "";
    if (!idx.includes(date)) {
      idx += `## ${date} 生活事件（迁移）\n`;
      for (const line of lines) {
        idx += `- ${line.replace(/^- /, "")}\n`;
      }
      idx += `- 关联: daily/${date}.md#生活\n`;
    }
    fs.writeFileSync(lifeIndexPath, idx, "utf-8");
  }
}

function migrateDailyLogs(childDir) {
  const srcDir = path.join(childDir, "daily-logs");
  if (!fs.existsSync(srcDir)) return;
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith(".md")) continue;
    const srcPath = path.join(srcDir, f);
    const destPath = path.join(childDir, "daily", f);
    if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function migrateChild(childDir) {
  ensureDirs(childDir);

  writeIfMissing(path.join(childDir, "tags", "taxonomy.md"), TAXONOMY);
  writeIfMissing(path.join(childDir, "learning", "topics.md"), TOPICS);

  // learning/rules.md：优先从 study-rules.md 迁移，否则用空模板
  const rulesPath = path.join(childDir, "learning", "rules.md");
  if (!fs.existsSync(rulesPath)) {
    const oldRules = path.join(childDir, "study-rules.md");
    const content = fs.existsSync(oldRules)
      ? fs.readFileSync(oldRules, "utf-8")
      : RULES;
    fs.writeFileSync(rulesPath, content, "utf-8");
  }

  migrateLifeEvents(childDir);
  migrateDailyLogs(childDir);
}

let migrated = 0;
if (!fs.existsSync(childrenDir)) {
  console.log("无 children 目录，无需迁移");
} else {
  for (const child of fs.readdirSync(childrenDir)) {
    const childDir = path.join(childrenDir, child);
    if (!fs.existsSync(path.join(childDir, "profile.json"))) continue;
    migrateChild(childDir);
    migrated++;
    console.log(`✅ 迁移完成：${child}`);
  }
}
console.log(`共迁移 ${migrated} 个孩子。`);
