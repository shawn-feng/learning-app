#!/usr/bin/env node
// 迁移珊珊（饺子）的 OpenClaw 学习数据到新结构（LEARNING-DATA-REDESIGN）
// 数据源：
//   教学资料：C:/Users/79734/Documents/学习档案/知识/教学资料/{主题}/
//   进度文件：C:/Users/79734/Nutstore/1/workspace-jiaozi/memory/{topic}.md
//   记录资料：C:/Users/79734/Nutstore/1/workspace-jiaozi/memory/{learn|life|vocab}-*.md
// 运行：node scripts/migrate-jiaozi-data.mjs
import fs from "fs";
import path from "path";

const CHILD_ID = "1f050a7f-df8a-45b0-925a-1ffe2aa35674";
const CHILD_DIR = "C:/Users/79734/Documents/pi/data/children/" + CHILD_ID;
const SRC_MATERIALS = "C:/Users/79734/Documents/学习档案/知识/教学资料";
const SRC_MEMORY = "C:/Users/79734/Nutstore/1/workspace-jiaozi/memory";

// 进度文件名 → { 主题名, 教学资料目录名 }
const TOPICS = {
  "lunyu.md": { name: "论语", materials: "论语" },
  "qianziwen.md": { name: "千字文", materials: "千字文" },
  "xiaojing.md": { name: "孝经", materials: "孝经" },
  "xiaozhuan.md": { name: "小篆", materials: "小篆" },
  "taodi.md": { name: "陶笛", materials: "陶笛" },
  "hanzigong.md": { name: "汉字宫", materials: "汉字宫" },
  "english.md": { name: "英语", materials: "英语" },
  "reading.md": { name: "春风阅读", materials: "春风阅读" },
};

function readFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const obj = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) obj[kv[1]] = kv[2].trim();
  }
  return obj;
}

function mkdirp(d) {
  fs.mkdirSync(d, { recursive: true });
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return 0;
  mkdirp(dest);
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      n += copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
      n++;
    }
  }
  return n;
}

// 1. 迁移教学资料 → learning/{topic}/materials/（目录名用拼音，与进度文件一致）
function migrateMaterials() {
  let total = 0;
  for (const [file, meta] of Object.entries(TOPICS)) {
    const src = path.join(SRC_MATERIALS, meta.materials);
    const dir = file.replace(".md", "");
    const dest = path.join(CHILD_DIR, "learning", dir, "materials");
    const n = copyDir(src, dest);
    total += n;
    console.log(`  教学资料 ${meta.name}(${dir}): ${n} 文件`);
  }
  console.log(`教学资料共迁移 ${total} 文件`);
}

// 2. 迁移进度文件 → learning/{topic}/{topic}.md（进度文件放各自主题目录下）
function migrateProgress() {
  for (const [file, meta] of Object.entries(TOPICS)) {
    const src = path.join(SRC_MEMORY, file);
    if (!fs.existsSync(src)) {
      console.log(`  ⚠️ 缺进度文件 ${file}`);
      continue;
    }
    const dir = file.replace(".md", "");
    const dest = path.join(CHILD_DIR, "learning", dir, file);
    fs.copyFileSync(src, dest);
    console.log(`  进度文件 ${file} → learning/${dir}/${file}`);
  }
}

// 3. study-topics.md → learning/topics.md
function migrateTopics() {
  const progress = {};
  for (const [file] of Object.entries(TOPICS)) {
    const src = path.join(SRC_MEMORY, file);
    if (fs.existsSync(src)) {
      const fm = readFrontmatter(fs.readFileSync(src, "utf-8"));
      progress[file] = `${fm.learned ?? 0}/${fm.total ?? "?"}`;
    }
  }

  const lines = ["---", "topics:"];
  for (const [file, meta] of Object.entries(TOPICS)) {
    const dir = file.replace(".md", "");
    lines.push(
      `  - {name: ${meta.name}, file: ${dir}/${file}, method: learning/${dir}/method.md, progress: ${progress[file] ?? "?"}}`
    );
  }
  lines.push("---", "", "# 学习主题目录", "",
    "> 每个主题一条记录。frontmatter 的 topics 数组元素：{name, file, method, progress}。",
    "> 新增主题流程见 AGENTS.md 导航指令。", "",
    "| 主题 | 进度文件 | 教学方法 | 进度 |",
    "|------|---------|---------|------|");

  for (const [file, meta] of Object.entries(TOPICS)) {
    const dir = file.replace(".md", "");
    lines.push(`| ${meta.name} | ${dir}/${file} | learning/${dir}/method.md | ${progress[file] ?? "?"} |`);
  }

  const dest = path.join(CHILD_DIR, "learning", "topics.md");
  fs.writeFileSync(dest, lines.join("\n") + "\n", "utf-8");
  console.log("learning/topics.md 已生成（8 主题）");
}

// 4. study-rules.md → learning/rules.md（只与学习相关，放 learning 根目录）
function migrateRules() {
  const src = path.join(SRC_MEMORY, "study-rules.md");
  if (!fs.existsSync(src)) {
    console.log("  ⚠️ 缺 study-rules.md");
    return;
  }
  const dest = path.join(CHILD_DIR, "learning", "rules.md");
  fs.copyFileSync(src, dest);
  console.log("learning/rules.md 已生成");
}

// 5. 记录资料 → daily/{日期}.md（学习 + 生活 + 字词）
function migrateRecords() {
  const dailyDir = path.join(CHILD_DIR, "daily");
  mkdirp(dailyDir);

  const files = fs.readdirSync(SRC_MEMORY);
  const byDate = {}; // date -> { learn: [], life: [], vocab: [] }

  for (const f of files) {
    let type = null;
    let date = null;
    if (f.startsWith("learn-")) { type = "learn"; date = f.slice(6, 16); }
    else if (f.startsWith("life-")) { type = "life"; date = f.slice(5, 15); }
    else if (f.startsWith("vocab-")) { type = "vocab"; date = f.slice(6, 16); }
    else continue;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!byDate[date]) byDate[date] = { learn: [], life: [], vocab: [] };
    byDate[date][type].push(f);
  }

  let learnCount = 0, lifeCount = 0, vocabCount = 0;
  for (const [date, groups] of Object.entries(byDate)) {
    const sections = [];
    if (groups.learn.length) {
      const body = groups.learn.map((f) => stripTitle(fs.readFileSync(path.join(SRC_MEMORY, f), "utf-8"))).join("\n\n");
      sections.push("## 学习\n" + body);
      learnCount += groups.learn.length;
    }
    if (groups.life.length) {
      const body = groups.life.map((f) => stripTitle(fs.readFileSync(path.join(SRC_MEMORY, f), "utf-8"))).join("\n\n");
      sections.push("## 生活\n" + body);
      lifeCount += groups.life.length;
    }
    if (groups.vocab.length) {
      const body = groups.vocab.map((f) => stripTitle(fs.readFileSync(path.join(SRC_MEMORY, f), "utf-8"))).join("\n\n");
      sections.push("## 学习\n### 字词\n" + body);
      vocabCount += groups.vocab.length;
    }

    const dest = path.join(dailyDir, `${date}.md`);
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf-8") : "";
    const merged = mergeDaily(existing, sections.join("\n\n"));
    fs.writeFileSync(dest, merged, "utf-8");
  }

  console.log(`  学习记录 ${learnCount} 天，生活事件 ${lifeCount} 天，字词 ${vocabCount} 天`);
}

function stripTitle(content) {
  // 去掉开头的 "# ... 标题" 行
  return content.replace(/^#\s+.*\n/m, "").trim();
}

function mergeDaily(existing, newSections) {
  // 已有内容（如之前迁移的生活区块）与新内容合并，避免覆盖
  if (!existing.trim()) return newSections + "\n";
  // 简单处理：如果已有"## 学习"或"## 生活"，跳过重复；否则拼接
  // 迁移脚本场景简单，直接拼接
  return existing.trim() + "\n\n" + newSections + "\n";
}

// 主流程
console.log("=== 迁移珊珊（饺子）学习数据 ===");
console.log("目标目录:", CHILD_DIR, "\n");

console.log("[1/5] 迁移教学资料 → learning/{topic}/materials/");
migrateMaterials();

console.log("\n[2/5] 迁移进度文件 → learning/{topic}.md");
migrateProgress();

console.log("\n[3/5] 生成 learning/topics.md");
migrateTopics();

console.log("\n[4/5] 生成 meta/rules.md");
migrateRules();

console.log("\n[5/5] 合并记录 → daily/{日期}.md");
migrateRecords();

console.log("\n✅ 迁移完成");
