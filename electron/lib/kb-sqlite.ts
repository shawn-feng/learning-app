/**
 * 知识库 SQLite 层（ISSUE-023 P2 全量，schema v4）。
 *
 * 每孩子一个 `data/children/<childId>/kb.sqlite`，SQLite 为**唯一真源**（2026-08-20 拍板）：
 * 放弃 Obsidian 直读、不做双写、markdown 仅一次性迁移后归档不再维护。
 *
 * 表结构（v4，2026-08-21 修订）：
 *   daily_entries(date, block, title, raw, tags) —— daily 4 区块条目；raw 为唯一内容源，
 *     字段由 method.md 灵活设定；tags 列针对「生活」区块事件打标签（逗号分隔）
 *   courses(topic, title, sort_order, status, mastery, first_learned, last_review,
 *           review_count, material, send_material, tags) —— 每主题每课一行（进度明细）
 *   topic_progress —— **视图**（非表）：learned/total/next/updated 由 courses 实时计算
 *   topics(name, topic_key, method, progress, rules_json) —— 主题清单 + rules（type=必学/选学/复习 考核标注；
 *     daily 每日目标已停用 ISSUE-033，每天学什么由服务端学习计划 study_plans 决定；topic_key=纯拼音主题键=目录名）
 *   tags(tag, dimension, criteria) —— **标签定义表**（词表 + 判断标准），替代倒排索引
 *   meta(key, value) —— 迁移标记 / schema 版本
 *
 * 设计决策：
 *   - life/inquiries/tasks 月索引**不建表**：用 `WHERE block='生活' AND date LIKE '2026-08%'`
 *     直接查 daily_entries 代替（查询替代手工索引，无漂移）。
 *   - **标签体系（v4）**：不再维护「倒排索引」（tag_links 每关联一行），改为——
 *     ① `tags` 表只存**标签定义**（名字 + 维度 + 判断标准，家长维护，AI 打标签前查）；
 *     ② 标签**应用**直接落在数据行：daily 生活事件 → `daily_entries.tags`，课程 → `courses.tags`；
 *     ③ 反查「某标签关联了什么」用 `WHERE (',' || tags || ',') LIKE '%,标签,%'` 直接扫数据行
 *        （数据量小，查询替代索引；同时消灭倒排一致性问题）。
 *   - 进度明细化：learned/total/next/updated 都是计算值（视图），写入只需更新课程状态/时间字段。
 *   - 字段白名单已废弃：daily 字段由 method.md 灵活设定，代码只约束结构（区块、主键、状态值域）。
 *   - 写入路径：kb_insert / kb_update 直接写 SQLite；markdown 不再写。
 */

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { extractFrontmatter, parseFieldLine, splitBlocks, splitItems } from "./kb-parser.ts";

// ==================== 类型 ====================

/** 标签定义（tags 表一行）：词表 + 判断标准。 */
export interface TagDef {
  tag: string; // 标签名（如 诚实）
  dimension: string; // 维度（品格/关系/情绪/学习/其他）
  criteria: string; // 判断标准：什么类型的事件/课程打这个标签
}

export interface DailyEntry {
  date: string; // YYYY-MM-DD
  block: string; // 学习/生活/问答/任务
  title: string; // ### 条目标题
  raw: string; // 原始条目文本（### 标题行 + 字段行，唯一内容源）
  tags: string; // 标签（逗号分隔，如 诚实,亲情；生活事件打标）
}

/** 课程进度明细（courses 表一行）。字段语义由 method.md 约定，代码只映射通用进度骨架。 */
export interface CourseItem {
  topic: string; // 主题目录名（lunyu）
  title: string; // 课程名（论语先进篇第十九章）
  sortOrder: number; // 课程顺序（进度/next 计算依据）
  status: string; // 掌握状态：⬜ 未学 / ✅ 已学
  mastery: string; // 掌握度（method 定义语义，如 良好/熟练）
  firstLearned: string; // 首次学习时间 YYYY-MM-DD
  lastReview: string; // 最近复习时间 YYYY-MM-DD
  reviewCount: number; // 复习次数
  material: string; // 教学资料（路径指针或描述，method 决定写法）
  sendMaterial: string; // 要发送的学习资料（内容摘要或指针）
  tags: string; // 关联词表标签（逗号分隔，从 tags 定义表选）
  lessonMethod: string; // 每课教学方法全文（ISSUE-029，从父库快照拷贝）
  htmlPath: string; // 学习资料 html 地址（ISSUE-029，指向父库共享目录）
  teachingCopy: string; // 教学文案全文（ISSUE-029，由 materials/*.md 等文件入库，数据库唯一真源）
  examMastery: string; // 考核掌握度（学习考核功能，与 mastery 引导掌握度双轨）
  assessRubric: string; // 每课考核要点（学习考核，家长写，仅家长库真源，孩子经 parent_content 取）
}

export interface TopicProgress {
  topic: string; // 主题名（目录名，如 lunyu）
  learned: number; // 视图计算：status='✅' 的课程数
  total: number; // 视图计算：课程总数
  next: string; // 视图计算：第一个未完成课程
  updated: string; // 视图计算：最近活动日期（max(最近复习, 首次学习)）
  items: CourseItem[]; // 课程明细（按 sort_order）
}

// ==================== schema（v4） ====================

/** 表 DDL（不含视图——视图在迁移之后创建，避免与旧表同名冲突）。 */
const SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS daily_entries (
  date TEXT NOT NULL,
  block TEXT NOT NULL,
  title TEXT NOT NULL,
  raw TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (date, block, title)
);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_entries(date);
CREATE INDEX IF NOT EXISTS idx_daily_block ON daily_entries(block);

CREATE TABLE IF NOT EXISTS courses (
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '⬜',
  mastery TEXT NOT NULL DEFAULT '',
  exam_mastery TEXT NOT NULL DEFAULT '',
  first_learned TEXT NOT NULL DEFAULT '',
  last_review TEXT NOT NULL DEFAULT '',
  review_count INTEGER NOT NULL DEFAULT 0,
  material TEXT NOT NULL DEFAULT '',
  send_material TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  lesson_method TEXT NOT NULL DEFAULT '',
  html_path TEXT NOT NULL DEFAULT '',
  teaching_copy TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (topic, title)
);
CREATE INDEX IF NOT EXISTS idx_courses_topic ON courses(topic, sort_order);

CREATE TABLE IF NOT EXISTS topics (
  name TEXT PRIMARY KEY,
  topic_key TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  rules_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS tags (
  tag TEXT PRIMARY KEY,
  dimension TEXT NOT NULL DEFAULT '',
  criteria TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

/** 进度视图：learned/total/next/updated 全部实时计算（v3 起替代手工维护的 topic_progress 表）。 */
const SCHEMA_VIEWS = `
CREATE VIEW IF NOT EXISTS topic_progress AS
SELECT
  topic,
  COUNT(*) AS total,
  SUM(CASE WHEN status = '✅' THEN 1 ELSE 0 END) AS learned,
  COALESCE(
    (SELECT c2.title FROM courses c2 WHERE c2.topic = courses.topic AND c2.status != '✅'
     ORDER BY c2.sort_order, c2.title LIMIT 1),
    ''
  ) AS next,
  COALESCE(
    MAX(CASE WHEN last_review IN ('', '-') THEN NULL ELSE last_review END),
    MAX(CASE WHEN first_learned IN ('', '-') THEN NULL ELSE first_learned END),
    ''
  ) AS updated
FROM courses
GROUP BY topic;
`;

/** 打开（必要时创建）孩子的 kb.sqlite；调用方负责 close。 */
/** 把 topics 来源的各类「文件标识」归一化为纯拼音主题键（= courses.topic = 目录名）。
 * 兼容：目录路径 `hanzigong/hanzigong.md`、纯目录名 `hanzigong`、裸文件名 `hanzigong.md`。 */
export function normalizeTopicKey(raw: string): string {
  const seg = raw.split("/")[0].trim();
  return seg.replace(/\.md$/i, "");
}

/**
 * v5 → v6 就地迁移（ISSUE-052）：topics 表 `file` 列改名为 `topic_key`（纯拼音主题键），
 * 并把存量值归一化（剥 `dir/x.md` 路径、去末尾 .md），与 courses.topic / parent 库一致。
 * 幂等：通过列存在性判断，只在仍是 `file` 的库上执行一次。
 */
function ensureV6(db: DatabaseSync): void {
  const cols = (db.prepare("PRAGMA table_info(topics)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("file")) return; // 已是 v6（新库或已迁移）
  db.exec("ALTER TABLE topics RENAME COLUMN file TO topic_key");
  const rows = db.prepare("SELECT name, topic_key FROM topics").all() as unknown as Array<{ name: string; topic_key: string }>;
  const upd = db.prepare("UPDATE topics SET topic_key = ? WHERE name = ?");
  for (const r of rows) upd.run(normalizeTopicKey(r.topic_key), r.name);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("schema_version", "6");
}

/**
 * v6 → v7 就地迁移（学习考核）：courses 表加 `exam_mastery`（考核掌握度，与引导 mastery 双轨）。
 * 幂等：通过列存在性判断，只在缺少该列时执行一次。
 */
function ensureV7(db: DatabaseSync): void {
  const cols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
  if (cols.includes("exam_mastery")) return;
  db.exec("ALTER TABLE courses ADD COLUMN exam_mastery TEXT NOT NULL DEFAULT ''");
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("schema_version", "7");
}

export function openKbDb(childDir: string): DatabaseSync {
  const db = new DatabaseSync(path.join(childDir, "kb.sqlite"));
  // 并发写（如测试多文件并行、主进程与其它进程同库）时等待锁而不是立即报错
  db.exec("PRAGMA busy_timeout = 3000");
  db.exec(SCHEMA_TABLES);
  ensureV3(db);
  ensureV4(db, childDir);
  ensureV5(db);
  ensureV6(db);
  ensureV7(db);
  // 视图每次重建（廉价、幂等）：视图定义变更时无需迁移即可生效
  db.exec("DROP VIEW IF EXISTS topic_progress");
  db.exec(SCHEMA_VIEWS);
  return db;
}

// ==================== 英语课子会话数据层（ISSUE-029 终版任务2） ====================

/** courseKey 解析：格式 `<topic>:<title>`（topic=主题目录名，如 english）。非法格式返回 null。 */
export function parseCourseKey(courseKey: string): { topic: string; title: string } | null {
  const idx = courseKey.indexOf(":");
  if (idx <= 0 || idx >= courseKey.length - 1) return null;
  return { topic: courseKey.slice(0, idx), title: courseKey.slice(idx + 1) };
}

/** 某课的同步教学内容（英语子会话 systemPrompt 注入用——systemPromptOverride 是同步回调不能 await）。 */
export interface CourseLessonSync {
  topic: string;
  title: string;
  lessonMethod: string; // 每课教学方法全文
  teachingCopy: string; // 教学文案全文
  htmlPath: string; // 学习资料 html 地址
  material: string; // 教学资料说明
  sendMaterial: string; // 要发送的学习资料
}

/** 同步读取孩子库某课教学内容；查不到/库异常返回 null（降级为无课程注入，不阻断会话创建）。 */
export function getCourseLessonSync(childDir: string, topic: string, title: string): CourseLessonSync | null {
  let db: DatabaseSync | null = null;
  try {
    db = openKbDb(childDir);
    const row = db
      .prepare(
        "SELECT topic, title, lesson_method, teaching_copy, html_path, material, send_material FROM courses WHERE topic = ? AND title = ?"
      )
      .get(topic, title) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      topic: String(row.topic ?? topic),
      title: String(row.title ?? title),
      lessonMethod: String(row.lesson_method ?? ""),
      teachingCopy: String(row.teaching_copy ?? ""),
      htmlPath: String(row.html_path ?? ""),
      material: String(row.material ?? ""),
      sendMaterial: String(row.send_material ?? ""),
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * v4 → v5 就地迁移：courses 表加 `lesson_method`（每课教学方法全文）与 `html_path`（学习资料 html 地址）。
 * 幂等：通过列存在性判断，只在缺少这两列时执行一次。
 */
function ensureV5(db: DatabaseSync): void {
  const cols = (db.prepare("PRAGMA table_info(courses)").all() as Array<{ name: string }>).map((c) => c.name);
  if (cols.includes("lesson_method") && cols.includes("html_path") && cols.includes("teaching_copy")) return;
  if (!cols.includes("lesson_method")) {
    db.exec("ALTER TABLE courses ADD COLUMN lesson_method TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes("html_path")) {
    db.exec("ALTER TABLE courses ADD COLUMN html_path TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes("teaching_copy")) {
    db.exec("ALTER TABLE courses ADD COLUMN teaching_copy TEXT NOT NULL DEFAULT ''");
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("schema_version", "5");
}

/**
 * v2 → v3 就地迁移（不丢 SQLite 里迁移后新增的数据，因此不能靠重跑 markdown 全量导入）：
 *   1) daily_entries 去掉 fields_json 列（raw 是唯一内容源）
 *   2) 旧 topic_progress 表（items_json）展开为 courses 明细表
 *   3) 删旧 topic_progress 表（由视图替代）
 * 幂等：通过列/表存在性判断，只在 v2 库上执行一次。
 */
function ensureV3(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(daily_entries)").all() as Array<{ name: string }>;
  const hasFieldsJson = cols.some((c) => c.name === "fields_json");
  const oldProgressTable =
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'topic_progress'").all() as Array<{ name: string }>)
      .length > 0;
  if (!hasFieldsJson && !oldProgressTable) return; // 已是 v3（新库或已迁移）

  db.exec("BEGIN");
  try {
    if (hasFieldsJson) {
      db.exec("ALTER TABLE daily_entries RENAME TO daily_entries_v2");
      db.exec(
        "CREATE TABLE daily_entries (date TEXT NOT NULL, block TEXT NOT NULL, title TEXT NOT NULL, raw TEXT NOT NULL, PRIMARY KEY (date, block, title))"
      );
      db.exec("INSERT INTO daily_entries (date, block, title, raw) SELECT date, block, title, raw FROM daily_entries_v2");
      db.exec("DROP TABLE daily_entries_v2");
      db.exec("CREATE INDEX idx_daily_date ON daily_entries(date)");
      db.exec("CREATE INDEX idx_daily_block ON daily_entries(block)");
    }

    if (oldProgressTable) {
      const rows = db
        .prepare("SELECT topic, items_json FROM topic_progress")
        .all() as unknown as Array<{ topic: string; items_json: string }>;
      const insert = db.prepare(
        "INSERT OR REPLACE INTO courses (topic, title, sort_order, status, mastery, first_learned, last_review, review_count, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const r of rows) {
        let items: Array<{ title: string; fields: Record<string, string> }> = [];
        try {
          items = JSON.parse(r.items_json);
        } catch {
          items = [];
        }
        items.forEach((it, i) => {
          const f = it.fields || {};
          insert.run(
            r.topic,
            it.title,
            i,
            f["状态"] || "⬜",
            f["掌握度"] || "",
            f["首次学习"] || "",
            f["最近复习"] || f["上次复习"] || "",
            parseInt(f["复习次数"] || "0", 10) || 0,
            normalizeTags(f["tags"] || "")
          );
        });
      }
      db.exec("DROP TABLE topic_progress");
    }

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("schema_version", "3");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * v3 → v4 就地迁移：
 *   1) topics 加 rules_json 列，rules 表数据并入（rules.topic 目录名 ↔ topics.topic_key 目录名），删 rules 表
 *   2) daily_entries 加 tags 列，从存量 raw 的「- 标签：」行回填
 *   3) tag_links 倒排表 → tags 定义表（从归档 tags/taxonomy.md 导入；tag_links 里词表外的标签兜底收录），删 tag_links 表
 * 幂等：通过列/表存在性判断，只在 v3 库上执行一次。
 */
function ensureV4(db: DatabaseSync, childDir: string): void {
  const dailyCols = (db.prepare("PRAGMA table_info(daily_entries)").all() as Array<{ name: string }>).map((c) => c.name);
  const topicsCols = (db.prepare("PRAGMA table_info(topics)").all() as Array<{ name: string }>).map((c) => c.name);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
  const hasTagLinks = tables.includes("tag_links");
  const hasRules = tables.includes("rules");
  const isV4 = dailyCols.includes("tags") && topicsCols.includes("rules_json") && !hasTagLinks && !hasRules;
  if (isV4) return;

  db.exec("BEGIN");
  try {
    // 1) topics + rules_json
    if (!topicsCols.includes("rules_json")) {
      db.exec("ALTER TABLE topics ADD COLUMN rules_json TEXT NOT NULL DEFAULT '{}'");
      if (hasRules) {
        // rules.topic 是主题中文名（rules.md frontmatter 的 key，如 论语），直接匹配 topics.name
        db.exec(
          "UPDATE topics SET rules_json = COALESCE((SELECT r.rules_json FROM rules r WHERE r.topic = topics.name), '{}')"
        );
        db.exec("DROP TABLE rules");
      }
    }

    // 2) daily_entries + tags（从 raw 回填）
    if (!dailyCols.includes("tags")) {
      db.exec("ALTER TABLE daily_entries ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
      const rows = db.prepare("SELECT rowid, raw FROM daily_entries WHERE raw LIKE '%标签%'").all() as unknown as Array<{
        rowid: number;
        raw: string;
      }>;
      const update = db.prepare("UPDATE daily_entries SET tags = ? WHERE rowid = ?");
      for (const r of rows) {
        const tags = extractTagsFromRaw(r.raw);
        if (tags) update.run(tags, r.rowid);
      }
    }

    // 3) tag_links → tags 定义表
    if (hasTagLinks) {
      const insert = db.prepare("INSERT OR REPLACE INTO tags (tag, dimension, criteria) VALUES (?, ?, ?)");
      const seen = new Set<string>();
      for (const d of parseTaxonomyFile(path.join(childDir, "tags", "taxonomy.md"))) {
        insert.run(d.tag, d.dimension, d.criteria);
        seen.add(d.tag);
      }
      const oldTags = db.prepare("SELECT DISTINCT tag FROM tag_links").all() as unknown as Array<{ tag: string }>;
      for (const o of oldTags) {
        if (!seen.has(o.tag)) insert.run(o.tag, "", "");
      }
      db.exec("DROP TABLE tag_links");
    }

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("schema_version", "4");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ==================== 解析（纯函数，可单测） ====================

/** 从 raw 条目文本提取「- 标签：xxx」行的标签，归一化为逗号分隔（去方括号/空白）。无标签返回 ""。 */
export function extractTagsFromRaw(raw: string): string {
  const m = raw.match(/^- \*{0,2}标签\*{0,2}\s*[:：]\s*(.+)$/m);
  if (!m) return "";
  return normalizeTags(m[1]);
}

/** 标签字符串归一化：去方括号、去前导 #、按 逗号/顿号/空白 拆分、去空、逗号拼接。 */
export function normalizeTags(s: string): string {
  return s
    .trim()
    .replace(/^\[|\]$/g, "")
    .split(/[,，、\s]+/)
    .map((t) => t.trim().replace(/^#+/, ""))
    .filter(Boolean)
    .join(",");
}

/** 解析归档 tags/taxonomy.md → 标签定义（dimension = ## 区块，criteria 初始 = 释义）。 */
export function parseTaxonomy(text: string): TagDef[] {
  const defs: TagDef[] = [];
  const fm = extractFrontmatter(text);
  const bodyLines = (fm ? fm.body : text).split(/\r?\n/);
  for (const blk of splitBlocks(bodyLines)) {
    if (blk.title.startsWith("#") || blk.title === "") continue;
    const dimension = blk.title.trim();
    for (const line of blk.lines) {
      const m = /^-\s*([^：:]+?)\s*[：:]\s*(.*)$/.exec(line.trim());
      if (m) defs.push({ tag: m[1].trim(), dimension, criteria: m[2].trim() });
    }
  }
  return defs;
}

function parseTaxonomyFile(file: string): TagDef[] {
  if (!fs.existsSync(file)) return [];
  return parseTaxonomy(fs.readFileSync(file, "utf-8"));
}

/** 解析 daily/{date}.md 全部 4 区块条目。fields 不解析入库——raw 是唯一内容源；tags 从标签行提取。 */
export function parseDailyFile(date: string, text: string): DailyEntry[] {
  const entries: DailyEntry[] = [];
  const fm = extractFrontmatter(text);
  const bodyLines = (fm ? fm.body : text).split(/\r?\n/);
  for (const blk of splitBlocks(bodyLines)) {
    if (blk.title.startsWith("#") || blk.title === "") continue;
    for (const it of splitItems(blk.lines)) {
      const raw = it.lines.join("\n");
      entries.push({ date, block: blk.title, title: it.title, raw, tags: extractTagsFromRaw(raw) });
    }
  }
  return entries;
}

/** 解析 learning/{topic}/{topic}.md 进度文件为课程明细（v3：聚合数字不再入库，由视图计算）。 */
export function parseProgressFile(topic: string, text: string): CourseItem[] {
  const fm = extractFrontmatter(text);
  const bodyLines = (fm ? fm.body : text).split(/\r?\n/);
  const items: CourseItem[] = [];
  for (const it of splitItems(bodyLines)) {
    const fields: Record<string, string> = {};
    for (const line of it.lines) {
      if (line.trim().startsWith("###")) continue;
      const hit = parseFieldLine(line);
      if (hit) fields[hit.key] = hit.value;
    }
    items.push({
      topic,
      title: it.title,
      sortOrder: items.length,
      status: fields["状态"] || "⬜",
      mastery: fields["掌握度"] || "",
      firstLearned: fields["首次学习"] || "",
      lastReview: fields["最近复习"] || fields["上次复习"] || "",
      reviewCount: parseInt(fields["复习次数"] || "0", 10) || 0,
      material: fields["教学资料"] || "",
      sendMaterial: fields["学习资料"] || fields["要发送的学习资料"] || "",
      tags: normalizeTags(fields["tags"] || ""),
      lessonMethod: fields["课时方法"] || fields["每课教学方法"] || "",
      htmlPath: fields["html地址"] || fields["html_path"] || fields["学习资料地址"] || "",
      teachingCopy: fields["教学文案"] || "",
    });
  }
  return items;
}

/** tags 目录全部 *.md（排除 taxonomy.md）的 max mtime（ms）；目录不存在返回 0。 */
export function tagsDirMtime(tagsDir: string): number {
  if (!fs.existsSync(tagsDir)) return 0;
  let max = 0;
  for (const f of fs.readdirSync(tagsDir)) {
    if (!f.endsWith(".md") || f === "taxonomy.md") continue;
    max = Math.max(max, fs.statSync(path.join(tagsDir, f)).mtimeMs);
  }
  return max;
}

// ==================== 迁移（一次性导入存量 markdown） ====================

/**
 * 全量迁移：daily/ + learning 进度 + topics（含 rules）+ 标签定义 → SQLite（v4 结构）。
 * 幂等：先清空再导入（或按主键 REPLACE）。markdown 保留为归档，不再删除。
 * ⚠️ 仅用于首次建库/灾难恢复：SQLite 真源后重跑会覆盖丢失 SQLite 里迁移后新增的数据。
 */
export function migrateAllToSqlite(childDir: string): {
  daily: number;
  progress: number;
  topics: number;
  tags: number;
} {
  const db = openKbDb(childDir);
  try {
    db.exec("BEGIN");
    try {
      // 1) daily
      db.exec("DELETE FROM daily_entries");
      let dailyCount = 0;
      const dailyDir = path.join(childDir, "daily");
      if (fs.existsSync(dailyDir)) {
        const insert = db.prepare("INSERT OR REPLACE INTO daily_entries (date, block, title, raw, tags) VALUES (?, ?, ?, ?, ?)");
        for (const f of fs.readdirSync(dailyDir)) {
          const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
          if (!m) continue;
          const entries = parseDailyFile(m[1], fs.readFileSync(path.join(dailyDir, f), "utf-8"));
          for (const e of entries) {
            insert.run(e.date, e.block, e.title, e.raw, e.tags);
            dailyCount++;
          }
        }
      }

      // 2) learning/{topic}/{topic}.md 进度 → courses + topics.md（含 rules）
      db.exec("DELETE FROM courses");
      db.exec("DELETE FROM topics");
      let progressCount = 0;
      const learningDir = path.join(childDir, "learning");
      if (fs.existsSync(learningDir)) {
        for (const topicDir of fs.readdirSync(learningDir, { withFileTypes: true })) {
          if (!topicDir.isDirectory()) continue;
          const progressFile = path.join(learningDir, topicDir.name, `${topicDir.name}.md`);
          if (!fs.existsSync(progressFile)) continue;
          const items = parseProgressFile(topicDir.name, fs.readFileSync(progressFile, "utf-8"));
          const insert = db.prepare(
            "INSERT OR REPLACE INTO courses (topic, title, sort_order, status, mastery, first_learned, last_review, review_count, material, send_material, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          );
          for (const it of items) {
            insert.run(it.topic, it.title, it.sortOrder, it.status, it.mastery, it.firstLearned, it.lastReview, it.reviewCount, it.material, it.sendMaterial, it.tags);
          }
          progressCount++;
        }

        // topics.md frontmatter + rules.md frontmatter → topics 表（含 rules_json）
        const topicsFile = path.join(learningDir, "topics.md");
        const rulesFile = path.join(learningDir, "rules.md");
        if (fs.existsSync(topicsFile)) {
          const fm = extractFrontmatter(fs.readFileSync(topicsFile, "utf-8"));
          if (fm) {
            const re = /-\s*\{([^}]*)\}/g;
            let m: RegExpExecArray | null;
            const insert = db.prepare(
              "INSERT OR REPLACE INTO topics (name, topic_key, method, progress, rules_json) VALUES (?, ?, ?, ?, ?)"
            );
            while ((m = re.exec(fm.data)) !== null) {
              const kv: Record<string, string> = {};
              const re2 = /(\w+)\s*:\s*("([^"]*)"|([^,}]+))/g;
              let m2: RegExpExecArray | null;
              while ((m2 = re2.exec(m[1])) !== null) {
                kv[m2[1]] = (m2[3] !== undefined ? m2[3] : m2[4]).trim();
              }
              if (kv.name && kv.file) {
                // ISSUE-029：topics.method 存 method.md 全文（替代文件链接）。
                // 链接写法如 `learning/lunyu/method.md` 或 `lunyu/method.md`；读不到文件则退化为原值。
                let methodFull = "";
                const link = kv.method || "";
                const linkRel = link.replace(/^learning\//, "");
                const topicDirFromLink = linkRel.split("/")[0];
                const methodCandidates = [
                  path.join(learningDir, topicDirFromLink, "method.md"),
                  path.join(childDir, "learning", linkRel),
                  path.join(childDir, "learning", link),
                ];
                for (const cand of methodCandidates) {
                  if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
                    methodFull = fs.readFileSync(cand, "utf-8");
                    break;
                  }
                }
                insert.run(kv.name, normalizeTopicKey(kv.file), methodFull || link, kv.progress || "", "{}");
              }
            }
          }
        }
        // rules.md frontmatter → 回填 topics.rules_json（按目录名匹配）
        if (fs.existsSync(rulesFile)) {
          const fm = extractFrontmatter(fs.readFileSync(rulesFile, "utf-8"));
          if (fm) {
            const block = fm.data.match(/rules:\s*\n([\s\S]*?)(?=\n\S|$)/);
            if (block) {
              const re = /^\s*([^\s:{]+)\s*:\s*\{([^}]*)\}/gm;
              let m: RegExpExecArray | null;
              while ((m = re.exec(block[1])) !== null) {
                const kv: Record<string, string> = {};
                const re2 = /(\w+)\s*:\s*("([^"]*)"|([^,}]+))/g;
                let m2: RegExpExecArray | null;
                while ((m2 = re2.exec(m[2])) !== null) {
                  kv[m2[1]] = (m2[3] !== undefined ? m2[3] : m2[4]).trim();
                }
                // rules.md 的 key 是主题中文名（如 论语），匹配 topics.name
                db.prepare("UPDATE topics SET rules_json = ? WHERE name = ?").run(JSON.stringify(kv), m[1]);
              }
            }
          }
        }
      }

      // 3) 标签定义表（从 taxonomy.md 导入）
      db.exec("DELETE FROM tags");
      let tagsCount = 0;
      const insertTag = db.prepare("INSERT OR REPLACE INTO tags (tag, dimension, criteria) VALUES (?, ?, ?)");
      for (const d of parseTaxonomyFile(path.join(childDir, "tags", "taxonomy.md"))) {
        insertTag.run(d.tag, d.dimension, d.criteria);
        tagsCount++;
      }

      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("schema_version", "4");
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("last_full_migration", new Date().toISOString());
      db.exec("COMMIT");
      const topicsCount = (db.prepare("SELECT COUNT(*) AS c FROM topics").get() as { c: number }).c;
      return { daily: dailyCount, progress: progressCount, topics: topicsCount, tags: tagsCount };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.close();
  }
}

/** 该孩子是否有任何可迁移数据（避免测试残留目录建库）。 */
export function hasAnyKbData(childDir: string): boolean {
  const dailyDir = path.join(childDir, "daily");
  if (fs.existsSync(dailyDir) && fs.readdirSync(dailyDir).some((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))) return true;
  const learningDir = path.join(childDir, "learning");
  if (fs.existsSync(learningDir) && fs.existsSync(path.join(learningDir, "topics.md"))) return true;
  return tagsDirMtime(path.join(childDir, "tags")) > 0;
}

// ==================== 查询 ====================

export interface DailyQuery {
  date?: string; // 精确日期
  month?: string; // YYYY-MM 聚合
  block?: string; // 区块（学习/生活/问答/任务）
  title?: string; // 条目标题
  tag?: string; // 标签过滤（tags 列逗号分隔匹配）
  listOnly?: boolean; // 只回标题
}

/** 查询 daily 条目（唯一真源）。返回 raw 原文（无字段解析层）；支持 tag 过滤。 */
export function queryDaily(childDir: string, q: DailyQuery): DailyEntry[] {
  const db = openKbDb(childDir);
  try {
    const conds: string[] = [];
    const args: string[] = [];
    if (q.date) {
      conds.push("date = ?");
      args.push(q.date);
    } else if (q.month) {
      conds.push("date LIKE ?");
      args.push(q.month + "-%");
    }
    if (q.block) {
      conds.push("block = ?");
      args.push(q.block);
    }
    if (q.title) {
      conds.push("title = ?");
      args.push(q.title);
    }
    if (q.tag) {
      // 逗号包裹匹配，避免「学习」误中「复习」等部分匹配
      conds.push("(',' || tags || ',') LIKE ?");
      args.push(`%,${q.tag},%`);
    }
    const sql =
      `SELECT date, block, title, raw, tags FROM daily_entries` +
      (conds.length ? ` WHERE ${conds.join(" AND ")}` : "") +
      ` ORDER BY date, block, title`;
    return db.prepare(sql).all(...args) as unknown as DailyEntry[];
  } finally {
    db.close();
  }
}

/**
 * 主题键解析：把 agent / 工具可能传入的「中文名」或「拼音目录名」统一成 courses.topic 用的键。
 *   - 已是 courses.topic（拼音目录名，如 hanzigong）→ 原样返回
 *   - 匹配 topics.name（中文显示名，如 汉字宫）→ 返回其 topic_key（拼音目录名）
 *   - 否则原样返回（支持新建主题的拼音键直通）
 * 原因（主题键对齐）：topics.name 是中文显示名，courses.topic / topic_progress.topic 是拼音目录名，
 * 两者脱节会让 agent 拿中文名查进度/写课程时查不到、反复核对（如 珊珊会话里「汉字宫」查不到）。
 */
export function resolveTopicKeyUsingDb(db: DatabaseSync, input: string): string {
  if (!input) return input;
  const byKey = db.prepare("SELECT 1 FROM courses WHERE topic = ? LIMIT 1").get(input);
  if (byKey) return input;
  const byName = db.prepare("SELECT topic_key FROM topics WHERE name = ?").get(input) as { topic_key: string } | undefined;
  if (byName) return byName.topic_key;
  return input;
}

/** 查询主题进度（视图聚合 + courses 明细）。topic 缺省 = 全部主题；tag 可选（courses.tags 过滤）。
 * topic 接受拼音键（hanzigong）或中文名（汉字宫），自动解析为键。 */
export function queryTopicProgress(childDir: string, topic?: string, tag?: string): TopicProgress[] {
  const db = openKbDb(childDir);
  try {
    if (topic) topic = resolveTopicKeyUsingDb(db, topic);
    const agg = topic
      ? db.prepare("SELECT topic, learned, total, next, updated FROM topic_progress WHERE topic = ?").all(topic)
      : db.prepare("SELECT topic, learned, total, next, updated FROM topic_progress ORDER BY topic").all();
    let coursesSql = "SELECT * FROM courses";
    const conds: string[] = [];
    const args: string[] = [];
    if (topic) {
      conds.push("topic = ?");
      args.push(topic);
    }
    if (tag) {
      conds.push("(',' || tags || ',') LIKE ?");
      args.push(`%,${tag},%`);
    }
    if (conds.length) coursesSql += ` WHERE ${conds.join(" AND ")}`;
    coursesSql += " ORDER BY topic, sort_order, title";
    const courses = db.prepare(coursesSql).all(...args) as unknown as Array<Record<string, unknown>>;
    const courseMap = new Map<string, CourseItem[]>();
    for (const c of courses) {
      const t = String(c.topic);
      if (!courseMap.has(t)) courseMap.set(t, []);
      courseMap.get(t)!.push(rowToCourse(c));
    }
    return (agg as unknown as Array<{ topic: string; learned: number; total: number; next: string; updated: string }>).map((r) => ({
      topic: r.topic,
      learned: Number(r.learned) || 0,
      total: Number(r.total) || 0,
      next: r.next,
      updated: r.updated,
      items: courseMap.get(r.topic) || [],
    }));
  } finally {
    db.close();
  }
}

/**
 * 只取主题进度**聚合行**（learned/total/next/updated），不加载课程明细（items）。
 * 记录总结（summarizeDailyConversation）首轮注入用：给孩子可能只有几百课的论语，全量 courses
 * 明细（queryTopicProgress 非 listOnly）会把整张课程表塞进 LLM 上下文，这里只回主题级摘要，省 token。
 */
export function queryTopicSummary(childDir: string): Array<{ topic: string; learned: number; total: number; next: string; updated: string }> {
  const db = openKbDb(childDir);
  try {
    const rows = db.prepare("SELECT topic, learned, total, next, updated FROM topic_progress ORDER BY topic").all() as unknown as Array<{
      topic: string;
      learned: number;
      total: number;
      next: string;
      updated: string;
    }>;
    return rows.map((r) => ({
      topic: r.topic,
      learned: Number(r.learned) || 0,
      total: Number(r.total) || 0,
      next: r.next ?? "",
      updated: r.updated ?? "",
    }));
  } finally {
    db.close();
  }
}

function rowToCourse(r: Record<string, unknown>): CourseItem {
  return {
    topic: String(r.topic),
    title: String(r.title),
    sortOrder: Number(r.sort_order) || 0,
    status: String(r.status ?? "⬜"),
    mastery: String(r.mastery ?? ""),
    examMastery: String(r.exam_mastery ?? ""),
    firstLearned: String(r.first_learned ?? ""),
    lastReview: String(r.last_review ?? ""),
    reviewCount: Number(r.review_count) || 0,
    material: String(r.material ?? ""),
    sendMaterial:  String(r.send_material ?? ""),
    tags: String(r.tags ?? ""),
    lessonMethod: String(r.lesson_method ?? ""),
    htmlPath: String(r.html_path ?? ""),
    teachingCopy: String(r.teaching_copy ?? ""),
    examMastery: String(r.exam_mastery ?? ""),
    assessRubric: String(r.assess_rubric ?? ""),
  };
}

/** 单课「学习总结」条目（来自 daily_entries，block='学习'，唯一真源）。 */
export interface CourseDailySummary {
  date: string; // 日期 YYYY-MM-DD
  title: string; // daily 条目标题
  raw: string; // 完整条目原文（markdown）
  tags: string; // 标签（逗号分隔）
}

/**
 * 计算标题的「章节课时键」，用于把 courses 行关联到其 daily_entries 学习总结。
 *
 * 关联规则（无显式外键，靠标题对齐）：
 *  - 先去掉主题中文名（如「论语」）与「·」；
 *  - 优先从括号 `（…）` 内取章节课时标识（如「学而篇第三章」「为政篇第五章」），
 *    取不到再对整串取；
 *  - 取不到（非 篇/章/课 体系）则退化为去装饰后的归一化串。
 * 例：课程「论语学而篇第三章」↔ daily「论语·巧言令色（学而篇第三章）」→ 同键「学而篇第三章」。
 */
export function chapterKey(title: string, topicName: string): string {
  const norm = title.replace(topicName, "").replace(/·/g, "");
  const parens = [...norm.matchAll(/[（(]([^）)]*)[）)]/g)].map((m) => m[1]);
  const main = norm.replace(/[（(][^）)]*[）)]/g, "");
  for (const seg of [...parens, main]) {
    const hit = /.+?篇第[^章]*章/.exec(seg) || /.+?第[^章课]*[章课]/.exec(seg);
    if (hit) return hit[0];
  }
  return norm.replace(/[·（）()\s]/g, "");
}

/**
 * 查询某课程的学习总结：返回与该课程关联的全部 daily_entries（block='学习'）。
 * 关联靠标题章节课时键（见 chapterKey）；按日期升序，方便家长/孩子按时间看学习轨迹。
 *
 * @param topicName 主题中文名（如「论语」），用于归一化标题
 * @param courseTitle 课程名（courses.title）
 */
export function queryCourseDailySummaries(
  childDir: string,
  topicName: string,
  courseTitle: string
): CourseDailySummary[] {
  const db = openKbDb(childDir);
  try {
    const rows = db
      .prepare("SELECT date, title, raw, tags FROM daily_entries WHERE block = '学习' ORDER BY date")
      .all() as unknown as Array<{ date: string; title: string; raw: string; tags: string }>;
    const courseKey = chapterKey(courseTitle, topicName);
    return rows
      .filter((r) => chapterKey(r.title, topicName) === courseKey)
      .map((r) => ({ date: r.date, title: r.title, raw: r.raw, tags: r.tags }));
  } finally {
    db.close();
  }
}

/** 查询主题清单（topics 表，含 rules_json）。 */
export function queryTopicsMeta(childDir: string): Array<{ name: string; topicKey: string; method: string; progress: string; rules: Record<string, string> }> {
  const db = openKbDb(childDir);
  try {
    const rows = db.prepare("SELECT name, topic_key, method, progress, rules_json FROM topics ORDER BY name").all() as unknown as Array<{
      name: string;
      topic_key: string;
      method: string;
      progress: string;
      rules_json: string;
    }>;
    return rows.map((r) => {
      let rules: Record<string, string> = {};
      try {
        rules = JSON.parse(r.rules_json || "{}");
      } catch {
        rules = {};
      }
      return { name: r.name, topicKey: r.topic_key, method: r.method, progress: r.progress, rules };
    });
  } finally {
    db.close();
  }
}

/** 查询标签定义表（tag 缺省 = 全部）。 */
export function queryTags(childDir: string, tag?: string): TagDef[] {
  const db = openKbDb(childDir);
  try {
    const rows = tag
      ? db.prepare("SELECT tag, dimension, criteria FROM tags WHERE tag = ?").all(tag)
      : db.prepare("SELECT tag, dimension, criteria FROM tags ORDER BY dimension, tag").all();
    return rows as unknown as TagDef[];
  } finally {
    db.close();
  }
}

// ==================== 写入（kb_insert / kb_update 后端） ====================

/** 插入 daily 条目（kb_insert）。已有同主键条目时返回 false（不覆盖，daily 是历史）。tags 从 content 的「- 标签：」行自动解析。 */
export function insertDailyEntry(childDir: string, e: { date: string; block: string; title: string; content: string }): boolean {
  const db = openKbDb(childDir);
  try {
    const exists = db
      .prepare("SELECT 1 FROM daily_entries WHERE date = ? AND block = ? AND title = ?")
      .get(e.date, e.block, e.title);
    if (exists) return false;
    db.prepare("INSERT INTO daily_entries (date, block, title, raw, tags) VALUES (?, ?, ?, ?, ?)").run(
      e.date,
      e.block,
      e.title,
      e.content,
      extractTagsFromRaw(e.content)
    );
    return true;
  } finally {
    db.close();
  }
}

/**
 * 批量插入 daily 条目（kb_insert entries 批量用，2026-08-27）。
 * 单事务执行：逐条幂等（同主键 date+block+title 已存在则跳过，daily 是 append-only 历史不改），
 * 返回新增 / 跳过计数。content 无 `### 标题` 行的条目无法入库（标题是主键一部分），计入 skipped。
 */
export function insertDailyEntries(
  childDir: string,
  date: string,
  entries: Array<{ block: string; content: string }>
): { inserted: number; skipped: number } {
  const db = openKbDb(childDir);
  let inserted = 0;
  let skipped = 0;
  try {
    db.exec("BEGIN");
    const existsStmt = db.prepare("SELECT 1 FROM daily_entries WHERE date = ? AND block = ? AND title = ?");
    const insertStmt = db.prepare("INSERT INTO daily_entries (date, block, title, raw, tags) VALUES (?, ?, ?, ?, ?)");
    for (const e of entries) {
      const title = e.content.match(/^###\s+(.+)$/m)?.[1]?.trim() ?? "";
      if (!title || !e.block) {
        skipped++;
        continue;
      }
      if (existsStmt.get(date, e.block, title)) {
        skipped++;
        continue;
      }
      insertStmt.run(date, e.block, title, e.content, extractTagsFromRaw(e.content));
      inserted++;
    }
    db.exec("COMMIT");
    return { inserted, skipped };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 忽略回滚失败（库可能已处于非事务态）
    }
    throw err;
  } finally {
    db.close();
  }
}

/** 更新 daily 条目字段（kb_update）。直接改 raw 里对应字段行（`- 键：值` / `- **键**：值`），字段缺失时追加；field=标签 时同步 tags 列。 */
export function updateDailyField(childDir: string, e: { date: string; block: string; title: string; field: string; value: string }): boolean {
  const db = openKbDb(childDir);
  try {
    const row = db.prepare("SELECT raw FROM daily_entries WHERE date = ? AND block = ? AND title = ?").get(e.date, e.block, e.title) as
      | { raw: string }
      | undefined;
    if (!row) return false;
    let raw = row.raw;
    const fieldRe = new RegExp(`^- (\\*{0,2}${escapeRegExp(e.field)}\\*{0,2})\\s*[:：]\\s*.*$`, "m");
    if (fieldRe.test(raw)) {
      raw = raw.replace(fieldRe, `- $1：${e.value}`);
    } else {
      raw = `${raw}\n- ${e.field}：${e.value}`;
    }
    // 标签字段同步 tags 列（从更新后的 raw 重新提取）
    if (e.field === "标签") {
      db.prepare("UPDATE daily_entries SET raw = ?, tags = ? WHERE date = ? AND block = ? AND title = ?").run(
        raw,
        extractTagsFromRaw(raw),
        e.date,
        e.block,
        e.title
      );
    } else {
      db.prepare("UPDATE daily_entries SET raw = ? WHERE date = ? AND block = ? AND title = ?").run(raw, e.date, e.block, e.title);
    }
    return true;
  } finally {
    db.close();
  }
}

/** 进度条目字段 → courses 列名映射（kb_update progress 的 field 名白名单，供工具层描述/校验）。 */
export const COURSE_FIELD_MAP: Record<string, string> = {
  状态: "status",
  掌握状态: "status",
  掌握度: "mastery",
  首次学习: "first_learned",
  首次学习时间: "first_learned",
  最近复习: "last_review",
  复习时间: "last_review",
  上次复习: "last_review",
  复习次数: "review_count",
  教学资料: "material",
  学习资料: "send_material",
  要发送的学习资料: "send_material",
  tags: "tags",
  标签: "tags",
  课时方法: "lesson_method",
  每课教学方法: "lesson_method",
  html地址: "html_path",
  html_path: "html_path",
  学习资料地址: "html_path",
  教学文案: "teaching_copy",
  teaching_copy: "teaching_copy",
  考核掌握度: "exam_mastery",
  考核掌握: "exam_mastery",
  考核掌握情况: "exam_mastery",
};

/** 更新课程进度字段（kb_update）。item 必填（课程名）；value="+1" 时复习次数自增。 */
export function updateProgress(childDir: string, p: { topic: string; item: string; field: string; value: string }): boolean {
  const col = COURSE_FIELD_MAP[p.field];
  if (!col) {
    throw new Error(
      `progress 字段「${p.field}」不支持（合法: ${Object.keys(COURSE_FIELD_MAP).join(" / ")}；learned/next/updated 为视图自动计算，无需手动更新）`
    );
  }
  const db = openKbDb(childDir);
  try {
    p.topic = resolveTopicKeyUsingDb(db, p.topic);
    const exists = db.prepare("SELECT 1 FROM courses WHERE topic = ? AND title = ?").get(p.topic, p.item);
    if (!exists) return false;
    if (col === "review_count") {
      const delta = p.value === "+1" ? 1 : parseInt(p.value, 10);
      if (!Number.isFinite(delta) || delta < 0) return false;
      if (p.value === "+1") {
        db.prepare("UPDATE courses SET review_count = review_count + 1 WHERE topic = ? AND title = ?").run(p.topic, p.item);
      } else {
        db.prepare("UPDATE courses SET review_count = ? WHERE topic = ? AND title = ?").run(delta, p.topic, p.item);
      }
      return true;
    }
    // 标签字段归一化
    const val = col === "tags" ? normalizeTags(p.value) : p.value;
    db.prepare(`UPDATE courses SET ${col} = ? WHERE topic = ? AND title = ?`).run(val, p.topic, p.item);
    return true;
  } finally {
    db.close();
  }
}

/** 新增课程（kb_insert progress）。sort_order 自动取该主题最大 +1；已有同 (topic,title) 返回 false。 */
export function insertCourse(
  childDir: string,
  c: {
    topic: string;
    title: string;
    status?: string;
    mastery?: string;
    examMastery?: string;
    material?: string;
    sendMaterial?: string;
    tags?: string;
    lessonMethod?: string;
    htmlPath?: string;
    teachingCopy?: string;
  }
): boolean {
  const db = openKbDb(childDir);
  try {
    c.topic = resolveTopicKeyUsingDb(db, c.topic);
    const exists = db.prepare("SELECT 1 FROM courses WHERE topic = ? AND title = ?").get(c.topic, c.title);
    if (exists) return false;
    const max = db.prepare("SELECT MAX(sort_order) AS m FROM courses WHERE topic = ?").get(c.topic) as { m: number | null };
    db.prepare(
      "INSERT INTO courses (topic, title, sort_order, status, mastery, exam_mastery, material, send_material, tags, lesson_method, html_path, teaching_copy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      c.topic,
      c.title,
      (max.m ?? -1) + 1,
      c.status || "⬜",
      c.mastery || "",
      c.examMastery || "",
      c.material || "",
      c.sendMaterial || "",
      c.tags ? normalizeTags(c.tags) : "",
      c.lessonMethod || "",
      c.htmlPath || "",
      c.teachingCopy || ""
    );
    return true;
  } finally {
    db.close();
  }
}

// ==================== 渲染 ====================

/** TagDef[] → markdown（标签定义清单，按维度分组；AI 打标签前查此表）。 */
export function tagsToMarkdown(defs: TagDef[]): string {
  if (defs.length === 0) return "（无标签定义——请先由家长维护标签词表）";
  const byDim = new Map<string, TagDef[]>();
  for (const d of defs) {
    const dim = d.dimension || "未分组";
    if (!byDim.has(dim)) byDim.set(dim, []);
    byDim.get(dim)!.push(d);
  }
  const parts: string[] = ["# 标签定义（打标签前先查此表，只能从下表选择）"];
  for (const [dim, ds] of byDim) {
    parts.push("", `## ${dim}`);
    for (const d of ds) {
      parts.push(`- ${d.tag}${d.criteria ? `：${d.criteria}` : ""}`);
    }
  }
  return parts.join("\n").trim();
}

/** DailyEntry[] → markdown。listOnly 只回标题；否则直接输出 raw 原文（字段由 method 定义，保真）。 */
export function dailyToMarkdown(entries: DailyEntry[], listOnly?: boolean): string {
  if (entries.length === 0) return "（无记录）";
  const parts: string[] = [];
  let curDate = "";
  let curBlock = "";
  for (const e of entries) {
    if (e.date !== curDate) {
      parts.push(`# ${e.date}`);
      curDate = e.date;
      curBlock = "";
    }
    if (e.block !== curBlock) {
      parts.push("", `## ${e.block}`);
      curBlock = e.block;
    }
    if (listOnly) {
      parts.push(`- ${e.title}`);
    } else {
      parts.push("", e.raw.trim().startsWith("###") ? e.raw.trim() : `### ${e.title}\n${e.raw.trim()}`);
    }
  }
  return parts.join("\n").trim();
}

/** TopicProgress[] → markdown（视图聚合行 + 课程明细）。listOnly 只回课程名+状态，否则带全部进度字段。 */
export function progressToMarkdown(progress: TopicProgress[], listOnly?: boolean): string {
  if (progress.length === 0) return "（无主题进度）";
  const parts: string[] = [];
  for (const p of progress) {
    parts.push(`# ${p.topic}：已学 ${p.learned}/${p.total}，下一课「${p.next}」，最近更新 ${p.updated || "—"}`);
    if (listOnly) {
      parts.push(...p.items.map((it) => `- ${it.title}（${it.status}）`));
    } else {
      for (const it of p.items) {
        const bits: string[] = [];
        bits.push(`- 状态：${it.status}`);
        if (it.mastery) bits.push(`- 掌握度：${it.mastery}`);
        if (it.firstLearned) bits.push(`- 首次学习：${it.firstLearned}`);
        if (it.lastReview) bits.push(`- 最近复习：${it.lastReview}`);
        if (it.reviewCount > 0) bits.push(`- 复习次数：${it.reviewCount}`);
        if (it.material) bits.push(`- 教学资料：${it.material}`);
        if (it.sendMaterial) bits.push(`- 要发送的学习资料：${it.sendMaterial}`);
        if (it.tags) bits.push(`- tags：${it.tags}`);
        parts.push("", `### ${it.title}`, ...bits);
      }
    }
  }
  return parts.join("\n").trim();
}

// ==================== 工具函数 ====================

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
