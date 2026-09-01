/**
 * 恢复本机 8788 开发库 lunyu 课程被导入覆盖的字段（一次性修复，2026-09-01）。
 * 背景：scripts/import-lunyu-exam.mjs 用 parent_lib.courses.upsert（全字段覆盖）写 assess_rubric，
 * 未传的 teaching_copy / html_path / status 等字段被覆盖为空 → 家长页课程管理「教学文案大量缺失」。
 * 数据源：201 生产库导出的 lunyu-courses-restore.json（512 行，teaching_copy/html_path 完整）。
 * 恢复策略：按 (topic,title) 匹配 UPDATE 除 assess_rubric 外的全部字段；不 INSERT、不动 assess_rubric。
 * 用法：node scripts/restore-lunyu-teaching.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PARENT_DIR = path.join(root, "server", "data", "parents", "86a84278-c8ae-415e-8fbc-6140b1b7c88e");
const DB = path.join(PARENT_DIR, "parent.sqlite");
const SRC = path.join(root, "server", "data", "lunyu-courses-restore.json");

const { DatabaseSync } = require("node:sqlite");
const rows = JSON.parse(fs.readFileSync(SRC, "utf-8"));
const db = new DatabaseSync(DB);
db.exec("PRAGMA busy_timeout = 10000");

const upd = db.prepare(
  `UPDATE courses SET
     sort_order = ?, status = ?, mastery = ?, first_learned = ?, last_review = ?,
     review_count = ?, material = ?, send_material = ?, tags = ?, lesson_method = ?,
     html_path = ?, teaching_copy = ?
   WHERE topic = ? AND title = ?`
);

let matched = 0;
for (const r of rows) {
  const res = upd.run(
    r.sort_order ?? 0,
    r.status ?? "⬜",
    r.mastery ?? "",
    r.first_learned ?? "",
    r.last_review ?? "",
    r.review_count ?? 0,
    r.material ?? "",
    r.send_material ?? "",
    r.tags ?? "",
    r.lesson_method ?? "",
    r.html_path ?? "",
    r.teaching_copy ?? "",
    "lunyu",
    r.title
  );
  if (res.changes > 0) matched++;
}

// 验证
const total = db.prepare("SELECT COUNT(*) n FROM courses WHERE topic='lunyu'").get().n;
const tc = db.prepare("SELECT COUNT(*) n FROM courses WHERE topic='lunyu' AND teaching_copy!=''").get().n;
const hp = db.prepare("SELECT COUNT(*) n FROM courses WHERE topic='lunyu' AND html_path!=''").get().n;
const rub = db.prepare("SELECT COUNT(*) n FROM courses WHERE topic='lunyu' AND assess_rubric!=''").get().n;
console.log(`恢复 UPDATE 匹配: ${matched}/${rows.length}`);
console.log(`恢复后 lunyu: 总数=${total} | teaching_copy 非空=${tc} | html_path 非空=${hp} | assess_rubric 非空=${rub}`);
db.close();
