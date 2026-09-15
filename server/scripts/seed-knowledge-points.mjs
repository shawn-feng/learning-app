/**
 * 知识点 seeding 脚本（一次性运维工具，幂等可重复执行）。
 *
 * 目的：给题库为空的课程挂「知识点 + 题目」，使其成为结构化课程（考核直出题，不走 LLM）。
 * 数据来源（家长库既有列，无需人工新写内容）：
 *  - teaching_copy「原文吟诵/原文」段 → 背诵题 answer（精确原文，behavior=speech_recite，发音评测）
 *  - teaching_copy「白话翻译讲解」段 → 句意翻译题参考答案
 *  - teaching_copy「道理应用讲解」段 → 道理应用题参考答案
 *  - assess_rubric「考核知识点」条目 → 知识点 detail（有则用，无则模板）
 *
 * 每课最多生成 3 个知识点：
 *  1. 本章原文背诵（speech_recite；仅在提取到原文时建）
 *  2. 句意翻译（generic；仅在提取到白话翻译时建）
 *  3. 道理应用（generic；仅在提取到道理讲解时建）
 * 任一知识点都没建成的课记入 skipped（不强行挂空）。
 *
 * 幂等：按 (course_uuid, 知识点名) 去重，已存在即跳过该知识点；重复执行不产生重复行。
 *
 * 用法：
 *   node seed-knowledge-points.mjs --topics lunyu --include "学而篇,子路篇" [--dry-run]
 *   node seed-knowledge-points.mjs --topics xiaojing,qianziwen [--dry-run]
 *   node seed-knowledge-points.mjs --topics lunyu            # 全量（P1）
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

// ==================== 参数 ====================
const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? String(args[i + 1] ?? "") : undefined;
};
const TOPICS = (getArg("topics") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const INCLUDE = (getArg("include") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const DRY_RUN = args.includes("--dry-run");
const DB_PATH = getArg("db") ?? path.join(process.cwd(), "data", "parents");

if (!TOPICS.length) {
  console.error("用法：node seed-knowledge-points.mjs --topics <topic[,topic2]> [--include \"子串1,子串2\"] [--dry-run] [--db <parentsDir>]");
  process.exit(1);
}

// ==================== 家长库定位（--db 可直接指定 parent.sqlite 文件；否则枚举，唯一才自动选） ====================
function findParentDb() {
  if (DB_PATH.endsWith(".sqlite")) return DB_PATH;
  const found = [];
  const walk = (dir, depth = 0) => {
    if (depth > 2) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name === "parent.sqlite") found.push(p);
    }
  };
  walk(DB_PATH);
  if (found.length === 1) return found[0];
  if (!found.length) throw new Error(`在 ${DB_PATH} 下未找到 parent.sqlite`);
  console.error(`[seed] 找到多个家长库，请用 --db 明确指定其一：`);
  for (const p of found) console.error(`  ${p}`);
  process.exit(1);
}
const dbFile = findParentDb();
const db = new DatabaseSync(dbFile);
console.log(`[seed] 家长库：${dbFile}`);
if (DRY_RUN) console.log("[seed] DRY-RUN：只统计不写入");

// ==================== schema（与 assess-content.ts 保持一致，幂等） ====================
db.exec(`
CREATE TABLE IF NOT EXISTS question_bank (
  id TEXT PRIMARY KEY, stem TEXT NOT NULL, answer TEXT NOT NULL, scoring TEXT,
  point_max INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS knowledge_points (
  id TEXT PRIMARY KEY, course_uuid TEXT NOT NULL, name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE (course_uuid, name)
);
CREATE INDEX IF NOT EXISTS idx_kp_course ON knowledge_points(course_uuid);
CREATE TABLE IF NOT EXISTS course_knowledge_questions (
  course_id TEXT NOT NULL, knowledge_point_id TEXT NOT NULL, question_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, overview TEXT,
  PRIMARY KEY (course_id, knowledge_point_id, question_id)
);
`);
const qCols = db.prepare("PRAGMA table_info(question_bank)").all().map((c) => c.name);
if (!qCols.includes("behavior")) db.exec("ALTER TABLE question_bank ADD COLUMN behavior TEXT NOT NULL DEFAULT 'generic'");
if (!qCols.includes("options")) db.exec("ALTER TABLE question_bank ADD COLUMN options TEXT NOT NULL DEFAULT '[]'");
const cCols = db.prepare("PRAGMA table_info(courses)").all().map((c) => c.name);
if (!cCols.includes("uuid")) throw new Error("courses.uuid 缺失（请先启动一次 server 完成迁移）");

// ==================== 文本提取 ====================
const clean = (s) =>
  String(s ?? "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/^[*-]\s+/gm, "")
    .replace(/^\|\s*/gm, "")
    .replace(/\s*[:：]\s*$/, "")
    .trim();

/** 取 teaching_copy 里某个「## 小节」的正文（到下一个 ## 为止）。 */
function section(text, nameRegex) {
  const re = new RegExp(`^##\\s*.*(?:${nameRegex}).*$`, "m");
  const m = text.match(re);
  if (!m) return "";
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const next = rest.search(/^##\s/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

/** 从原文小节提取背诵原文：优先取 ### 行（原文逐条），去掉引号与装饰。 */
function extractReciteText(text) {
  const sec = section(text, "原文") || section(text, "吟诵");
  if (!sec) return "";
  let lines = sec
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const h3 = lines.filter((l) => l.startsWith("###")).map((l) => clean(l.replace(/^###\s*/, "")));
  if (h3.length) lines = h3;
  else lines = lines.filter((l) => !l.startsWith("#") && !l.startsWith("|") && !/^[-*\s]*$/.test(l)).map(clean);
  const joined = lines
    .filter(Boolean)
    .join("")
    .replace(/[“”"'‘’]/g, "")
    .trim();
  return joined;
}

/** 取小节正文的前 N 字（剥 markdown），作为参考答案。 */
function sectionDigest(text, nameRegex, max = 260) {
  const sec = clean(section(text, nameRegex));
  return sec.slice(0, max);
}

/** 从 assess_rubric「考核知识点」里找含关键词的条目作 detail；exclude 命中的行跳过。 */
function rubricDetail(rubric, keywords, exclude = []) {
  const sec = section(rubric ?? "", "考核知识点");
  if (!sec) return "";
  for (const line of sec.split("\n")) {
    const t = clean(line.replace(/^[-*\d.\s]+/, ""));
    if (!t || exclude.some((k) => t.includes(k))) continue;
    if (keywords.some((k) => t.includes(k))) return t;
  }
  return "";
}

// ==================== 主流程 ====================
const insKp = db.prepare("INSERT OR IGNORE INTO knowledge_points (id, course_uuid, name, detail, seq) VALUES (?, ?, ?, ?, ?)");
const kpIdByName = new Map(); // (courseUuid|name) -> id
function ensureKp(courseUuid, name, detail, seq) {
  const key = `${courseUuid}|${name}`;
  if (kpIdByName.has(key)) return kpIdByName.get(key);
  const row = db.prepare("SELECT id FROM knowledge_points WHERE course_uuid = ? AND name = ?").get(courseUuid, name);
  if (row) {
    kpIdByName.set(key, row.id);
    return row.id;
  }
  const id = randomUUID().replaceAll("-", "");
  if (!DRY_RUN) insKp.run(id, courseUuid, name, detail, seq);
  kpIdByName.set(key, id);
  return id;
}
const insQ = db.prepare(
  "INSERT INTO question_bank (id, stem, answer, scoring, point_max, behavior, options) VALUES (?, ?, ?, NULL, 10, ?, '[]')"
);
function addQuestion(courseUuid, kpId, overview, stem, answer, behavior) {
  if (DRY_RUN) return;
  const dup = db
    .prepare("SELECT 1 FROM course_knowledge_questions WHERE course_id = ? AND knowledge_point_id = ?")
    .get(courseUuid, kpId);
  if (dup) return; // 该知识点已挂题 → 幂等跳过
  const qid = randomUUID().replaceAll("-", "");
  insQ.run(qid, stem, answer, behavior);
  db.prepare(
    "INSERT INTO course_knowledge_questions (course_id, knowledge_point_id, question_id, seq, overview) VALUES (?, ?, ?, 0, ?)"
  ).run(courseUuid, kpId, qid, overview);
}

let ok = 0;
let skipped = 0;
const perTopic = {};
for (const topic of TOPICS) {
  let rows;
  if (INCLUDE.length) {
    rows = db
      .prepare(`SELECT uuid, title, teaching_copy, assess_rubric FROM courses WHERE topic = ? ORDER BY title`)
      .all(topic)
      .filter((r) => INCLUDE.some((inc) => String(r.title).includes(inc)));
  } else {
    rows = db.prepare("SELECT uuid, title, teaching_copy, assess_rubric FROM courses WHERE topic = ? ORDER BY title").all(topic);
  }
  for (const c of rows) {
    const tc = String(c.teaching_copy ?? "");
    const rubric = String(c.assess_rubric ?? "");
    const recite = extractReciteText(tc);
    const translate = sectionDigest(tc, "白话翻译");
    const moral = sectionDigest(tc, "道理应用|道理");
    const made = [];
    if (recite) {
      const kp = ensureKp(c.uuid, "本章原文背诵", rubricDetail(rubric, ["背诵"]) || "能正确、流利地背诵本章原文；发音评测自动评分，90 分通过。", 0);
      addQuestion(c.uuid, kp, "发音评测，90 分通过", "请背诵本章原文", recite, "speech_recite");
      made.push("背诵");
    }
    if (translate) {
      const kp = ensureKp(c.uuid, "句意翻译", rubricDetail(rubric, ["句子意思", "句意", "翻译", "意思"], ["读音"]) || "能用自己的话说出本章原文的意思。", 1);
      addQuestion(c.uuid, kp, "口述判分", "请用自己的话说一说，本章原文讲的是什么意思？", translate, "generic");
      made.push("句意");
    }
    if (moral) {
      const kp = ensureKp(c.uuid, "道理应用", rubricDetail(rubric, ["道理", "应用"]) || "能结合生活举例，说出本章教给我们的道理。", 2);
      addQuestion(c.uuid, kp, "口述判分", "学完这一章，你能结合自己的生活举个例子，说说它教给我们的道理吗？", moral, "generic");
      made.push("道理");
    }
    if (made.length) {
      ok++;
      perTopic[topic] = (perTopic[topic] ?? 0) + 1;
    } else {
      skipped++;
      console.log(`[seed] 跳过（无可提取内容）：${topic} / ${c.title}`);
    }
  }
}

console.log(`[seed] 完成：成功 ${ok} 门，跳过 ${skipped} 门${DRY_RUN ? "（dry-run 未写入）" : ""}`);
console.log(`[seed] 分主题：${JSON.stringify(perTopic)}`);
