import fs from "fs";
import path from "path";
import { app } from "electron";
import { getChildDir, getSkillsDir } from "./config";
import type { ChildProfile } from "./child-auth";
import { openKbDb } from "./kb-sqlite";

// 受控标签词表（初版 20 个，四维）。记录生活事件 / 给知识点打标签只能从本表选。
// ISSUE-032：不再落 taxonomy.md 文件，改为初始化时写入孩子库 tags 表（SQLite 唯一真源）。
const DEFAULT_TAGS: Array<{ tag: string; dimension: string; criteria: string }> = [
  { tag: "诚实", dimension: "品格", criteria: "不撒谎，说真话" },
  { tag: "自律", dimension: "品格", criteria: "管住自己，该做什么就做什么" },
  { tag: "责任", dimension: "品格", criteria: "做好自己该做的事" },
  { tag: "坚持", dimension: "品格", criteria: "遇到困难不放弃" },
  { tag: "感恩", dimension: "品格", criteria: "感谢别人的帮助和付出" },
  { tag: "勇敢", dimension: "品格", criteria: "面对害怕的事不退缩" },
  { tag: "谦虚", dimension: "品格", criteria: "不自满，愿意向别人学习" },
  { tag: "亲情", dimension: "关系", criteria: "和家人之间的爱" },
  { tag: "友情", dimension: "关系", criteria: "和朋友之间的情谊" },
  { tag: "助人", dimension: "关系", criteria: "主动帮助别人" },
  { tag: "分享", dimension: "关系", criteria: "愿意和别人一起分享" },
  { tag: "礼貌", dimension: "关系", criteria: "对人友善、有礼" },
  { tag: "开心", dimension: "情绪", criteria: "高兴、愉快" },
  { tag: "难过", dimension: "情绪", criteria: "伤心、不开心" },
  { tag: "生气", dimension: "情绪", criteria: "发怒、不满" },
  { tag: "害怕", dimension: "情绪", criteria: "恐惧、担心" },
  { tag: "学习习惯", dimension: "学习", criteria: "按时学习、认真完成等好习惯" },
  { tag: "好奇心", dimension: "学习", criteria: "对新事物感兴趣、爱问为什么" },
  { tag: "专注", dimension: "学习", criteria: "专心做一件事" },
  { tag: "兴趣", dimension: "学习", criteria: "对某个领域的喜爱" },
];

/** 初始化空 kb.sqlite 并写入默认标签词表（ISSUE-032：SQLite 唯一真源，替代 taxonomy.md）。 */
export function initChildKb(childDir: string): void {
  const db = openKbDb(childDir);
  try {
    const cnt = (db.prepare("SELECT COUNT(*) AS c FROM tags").get() as { c: number }).c;
    if (cnt === 0) {
      const ins = db.prepare(
        "INSERT OR IGNORE INTO tags (tag, dimension, criteria) VALUES (?, ?, ?)"
      );
      for (const t of DEFAULT_TAGS) ins.run(t.tag, t.dimension, t.criteria);
    }
  } finally {
    db.close();
  }
}


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

  // ISSUE-032：SQLite 唯一真源，只建最小目录集，不再建文件时代的废弃目录/模板
  //（daily/learning/life/inquiries/tasks/outputs/tags、study-topics.md、study-rules.md、
  // life-events.md、tags/taxonomy.md、learning/topics.md、learning/rules.md）。
  fs.mkdirSync(childDir, { recursive: true });
  fs.mkdirSync(path.join(childDir, ".pi", "agent", "sessions"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(childDir, ".pi", "skills"), { recursive: true });

  fs.writeFileSync(
    path.join(childDir, "profile.json"),
    JSON.stringify(profile, null, 2),
    "utf-8"
  );

  // 初始化空 kb.sqlite（建表 + 幂等迁移）并写入默认标签词表
  initChildKb(childDir);

  fs.writeFileSync(
    path.join(childDir, ".pi", "agent", "settings.json"),
    JSON.stringify(buildChildSettings(), null, 2),
    "utf-8"
  );

  // ISSUE-033：AGENTS 纯 SQLite（data/agents.sqlite）——新建孩子不写任何 AGENTS 物理文件，
  // 开会话时 buildChildPrompt 经 resolveChildAgents 实时取「SQLite 用户版本 / 代码默认」。

  initSharedSkills();
}

export function initSharedSkills(): void {
  const skillsDir = getSkillsDir();
  // 打包后 resources 位于 process.resourcesPath；开发态位于项目根目录
  const templatesBase = app.isPackaged
    ? process.resourcesPath
    : process.cwd();
  const templatesDir = path.join(templatesBase, "templates", "skills");

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
