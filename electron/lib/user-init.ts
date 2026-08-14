import fs from "fs";
import path from "path";
import { getChildDir, getSkillsDir } from "./config";
import type { ChildProfile } from "./child-auth";
import { writeAgentsMd } from "./pi-session";

const STUDY_TOPICS_TEMPLATE = `---
topics: {}
---

# 学习主题目录

| 主题 | 教学技能 | 主题文件 |
|------|---------|---------|
`;

const STUDY_RULES_TEMPLATE = `---
rules: {}
---

# 每日目标量

| 主题 | 每日量 | 复习要求 | 类型 |
|------|--------|---------|------|
`;

// 受控标签词表（初版 20 个，四维）。记录生活事件 / 给知识点打标签只能从本表选。
const TAXONOMY_TEMPLATE = `---
dimensions: [品格, 关系, 情绪, 学习]
updated: {DATE}
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

export function buildTaxonomyMd(): string {
  const today = new Date().toISOString().slice(0, 10);
  return TAXONOMY_TEMPLATE.replace("{DATE}", today);
}

// learning 总入口（主题→进度文件→method 指针）。替代旧 study-topics.md。
const LEARNING_TOPICS_TEMPLATE = `---
topics: []
---

# 学习主题目录

> 每个主题一条记录。frontmatter 的 topics 数组元素：{name, file, method, progress}。
> file 指向该主题目录下的进度文件（如 lunyu/lunyu.md）。
> 新增主题流程见 AGENTS.md 导航指令：在此加条目 + 创建 learning/{topic}/{topic}.md + method.md + materials/。

| 主题 | 进度文件 | 教学方法 | 进度 |
|------|---------|---------|------|
`;

// learning/rules.md：每日学习目标量（只与学习相关，放 learning 根目录）。
const LEARNING_RULES_TEMPLATE = `---
rules: {}
---

# 每日目标量

| 主题 | 每日量 | 复习要求 | 类型（必学/兴趣） |
|------|--------|---------|------|
`;

export function buildChildSettings(): Record<string, unknown> {
  return {
    skills: [getSkillsDir()],
    defaultProjectTrust: "always",
    compaction: {
      enabled: true,
      reserveTokens: 8192,
      keepRecentTokens: 10000,
    },
  };
}

export async function initChildDirectory(
  childId: string,
  profile: ChildProfile
): Promise<void> {
  const childDir = getChildDir(childId);

  fs.mkdirSync(childDir, { recursive: true });
  fs.mkdirSync(path.join(childDir, ".pi", "agent", "sessions"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(childDir, ".pi", "skills"), { recursive: true });
  fs.mkdirSync(path.join(childDir, "daily-logs"), { recursive: true });

  // 新目录结构：daily 单一真相源 + learning + life/inquiries/tasks 索引 + tags 倒排 + outputs
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

  fs.writeFileSync(
    path.join(childDir, "profile.json"),
    JSON.stringify(profile, null, 2),
    "utf-8"
  );

  fs.writeFileSync(
    path.join(childDir, "study-topics.md"),
    STUDY_TOPICS_TEMPLATE,
    "utf-8"
  );

  fs.writeFileSync(
    path.join(childDir, "study-rules.md"),
    STUDY_RULES_TEMPLATE,
    "utf-8"
  );

  fs.writeFileSync(
    path.join(childDir, "life-events.md"),
    "# 生活事件记录\n\n",
    "utf-8"
  );

  fs.writeFileSync(
    path.join(childDir, "tags", "taxonomy.md"),
    buildTaxonomyMd(),
    "utf-8"
  );

  fs.writeFileSync(
    path.join(childDir, "learning", "topics.md"),
    LEARNING_TOPICS_TEMPLATE,
    "utf-8"
  );

  fs.writeFileSync(
    path.join(childDir, "learning", "rules.md"),
    LEARNING_RULES_TEMPLATE,
    "utf-8"
  );

  fs.writeFileSync(
    path.join(childDir, ".pi", "agent", "settings.json"),
    JSON.stringify(buildChildSettings(), null, 2),
    "utf-8"
  );

  writeAgentsMd(childId, profile);

  initSharedSkills();
}

export function initSharedSkills(): void {
  const skillsDir = getSkillsDir();
  const templatesDir = path.join(process.cwd(), "templates", "skills");

  if (!fs.existsSync(templatesDir)) return;

  for (const entry of fs.readdirSync(templatesDir)) {
    const srcPath = path.join(templatesDir, entry);
    const destPath = path.join(skillsDir, entry);

    if (!fs.existsSync(destPath)) {
      copyDir(srcPath, destPath);
    }
  }
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
