/**
 * ISSUE-105 方案 B P1：家长受控数据通道（db-channel）回归用例。
 * 内存库 + 真实表结构（与 parent-lib.ts / assess-content.ts 的建表语句同口径）。
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  describeTables,
  executeWrite,
  parentLibTableRegistry,
} from "../server/src/agent/db-channel";

const SCHEMA = `
CREATE TABLE topics (
  name TEXT PRIMARY KEY,
  topic_key TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  assess_method TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  rules_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE courses (
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '⬜',
  last_review TEXT NOT NULL DEFAULT '',
  review_count INTEGER NOT NULL DEFAULT 0,
  material TEXT NOT NULL DEFAULT '',
  send_material TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  lesson_method TEXT NOT NULL DEFAULT '',
  html_path TEXT NOT NULL DEFAULT '',
  teaching_copy TEXT NOT NULL DEFAULT '',
  assess_rubric TEXT NOT NULL DEFAULT '',
  uuid TEXT,
  PRIMARY KEY (topic, title)
);
CREATE TABLE tags (
  tag TEXT PRIMARY KEY,
  dimension TEXT NOT NULL DEFAULT '',
  criteria TEXT NOT NULL DEFAULT ''
);
CREATE TABLE question_bank (
  id TEXT PRIMARY KEY,
  stem TEXT NOT NULL,
  answer TEXT NOT NULL,
  scoring TEXT,
  point_max INTEGER NOT NULL DEFAULT 10,
  behavior TEXT NOT NULL DEFAULT 'generic',
  note TEXT NOT NULL DEFAULT '',
  knowledge_summary TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE knowledge_points (
  id TEXT PRIMARY KEY,
  course_uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE (course_uuid, name)
);
CREATE TABLE course_knowledge_questions (
  course_id TEXT NOT NULL,
  knowledge_point_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  overview TEXT,
  PRIMARY KEY (course_id, knowledge_point_id, question_id)
);
`;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  // 造一条课程（uuid 供引用校验）
  db.prepare("INSERT INTO courses (topic, title, uuid) VALUES (?, ?, ?)").run("论语", "学而篇", "course-uuid-1");
  return db;
}

describe("db-channel describe", () => {
  it("列出全部登记表", () => {
    const out = describeTables(parentLibTableRegistry());
    for (const t of ["topics", "courses", "tags", "question_bank", "knowledge_points", "course_knowledge_questions"]) {
      expect(out).toContain(t);
    }
  });

  it("单表详情含列说明与 confirm 标记", () => {
    const out = describeTables(parentLibTableRegistry(), "question_bank");
    expect(out).toContain("题干");
    expect(out).toContain("须向家长复述");
    expect(out).toContain("insert 必填：stem、answer");
  });

  it("未知表给出可用清单", () => {
    const out = describeTables(parentLibTableRegistry(), "nope");
    expect(out).toContain("没有登记");
    expect(out).toContain("question_bank");
  });
});

describe("db-channel write", () => {
  it("insert 题库题：服务端生成 id、touch updated_at", () => {
    const db = freshDb();
    const r = executeWrite(db, parentLibTableRegistry(), {
      table: "question_bank",
      op: "insert",
      rows: [{ stem: "学而时习之，下一句？", answer: "不亦说乎", point_max: 10 }],
    });
    expect(r.ok).toBe(true);
    const row = db.prepare("SELECT id, stem, point_max, updated_at FROM question_bank").all() as any[];
    expect(row.length).toBe(1);
    expect(row[0].id).toBeTruthy();
    expect(row[0].point_max).toBe(10);
    expect(row[0].updated_at).toBeTruthy();
    db.close();
  });

  it("insert 缺必填列 / 未知列 / 未登记表 均拒绝", () => {
    const db = freshDb();
    const specs = parentLibTableRegistry();
    const missing = executeWrite(db, specs, { table: "question_bank", op: "insert", rows: [{ stem: "只有题干" }] });
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("answer");
    const unknownCol = executeWrite(db, specs, {
      table: "question_bank",
      op: "insert",
      rows: [{ stem: "s", answer: "a", hack_col: "x" }],
    });
    expect(unknownCol.ok).toBe(false);
    expect(unknownCol.text).toContain("未登记");
    const unknownTable = executeWrite(db, specs, { table: "children", op: "insert", rows: [{ id: "1" }] });
    expect(unknownTable.ok).toBe(false);
    db.close();
  });

  it("背诵题没有 answer 被 insertInvariant 拦下", () => {
    const db = freshDb();
    const r = executeWrite(db, parentLibTableRegistry(), {
      table: "question_bank",
      op: "insert",
      rows: [{ stem: "背诵学而篇", answer: "", behavior: "speech_recite" }],
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("标准原文");
    db.close();
  });

  it("引用校验：知识点挂到不存在的课程被拒", () => {
    const db = freshDb();
    const r = executeWrite(db, parentLibTableRegistry(), {
      table: "knowledge_points",
      op: "insert",
      rows: [{ course_uuid: "nope", name: "考点1" }],
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("course_uuid");
    db.close();
  });

  it("多行 insert 中途失败 → 整体回滚（无半提交）", () => {
    const db = freshDb();
    const r = executeWrite(db, parentLibTableRegistry(), {
      table: "tags",
      op: "insert",
      rows: [
        { tag: "好标签", dimension: "d" },
        { tag: "坏标签", hack: 1 },
      ],
    });
    expect(r.ok).toBe(false);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM tags").get() as any).n;
    expect(n).toBe(0);
    db.close();
  });

  it("update 必须带 where；未知列不可改；改动 confirm 列返回复述提示", () => {
    const db = freshDb();
    const specs = parentLibTableRegistry();
    db.prepare("INSERT INTO question_bank (id, stem, answer) VALUES (?, ?, ?)").run("q1", "旧题干", "旧答案");
    const noWhere = executeWrite(db, specs, {
      table: "question_bank",
      op: "update",
      rows: { stem: "新题干" },
    });
    expect(noWhere.ok).toBe(false);
    expect(noWhere.text).toContain("where");
    const badCol = executeWrite(db, specs, {
      table: "question_bank",
      op: "update",
      rows: { created_at: "2020-01-01" },
      where: { id: "q1" },
    });
    expect(badCol.ok).toBe(false);
    const good = executeWrite(db, specs, {
      table: "question_bank",
      op: "update",
      rows: { stem: "新题干", answer: "新答案" },
      where: { id: "q1" },
    });
    expect(good.ok).toBe(true);
    expect(good.confirmHints.length).toBeGreaterThan(0);
    expect(good.text).toContain("复述");
    const row = db.prepare("SELECT stem, answer FROM question_bank WHERE id = ?").get("q1") as any;
    expect(row.stem).toBe("新题干");
    expect(row.answer).toBe("新答案");
    db.close();
  });

  it("delete 未命中 / 命中超限 均拒绝", () => {
    const db = freshDb();
    const specs = parentLibTableRegistry();
    const miss = executeWrite(db, specs, { table: "tags", op: "delete", where: { tag: "不存在" } });
    expect(miss.ok).toBe(false);
    expect(miss.text).toContain("没有命中");
    for (let i = 0; i < 21; i++) {
      db.prepare("INSERT INTO tags (tag, dimension) VALUES (?, ?)").run(`t${i}`, "同维");
    }
    const over = executeWrite(db, specs, { table: "tags", op: "delete", where: { dimension: "同维" } });
    expect(over.ok).toBe(false);
    expect(over.text).toContain("上限");
    const n = (db.prepare("SELECT COUNT(*) AS n FROM tags").get() as any).n;
    expect(n).toBe(21);
    db.close();
  });

  it("成功写入留审计记录", () => {
    const db = freshDb();
    executeWrite(db, parentLibTableRegistry(), {
      table: "question_bank",
      op: "insert",
      rows: [{ stem: "s", answer: "a" }],
    });
    const audits = db.prepare("SELECT * FROM db_audit").all() as any[];
    expect(audits.length).toBe(1);
    expect(audits[0].table_name).toBe("question_bank");
    expect(audits[0].op).toBe("insert");
    expect(audits[0].row_count).toBe(1);
    db.close();
  });
});
