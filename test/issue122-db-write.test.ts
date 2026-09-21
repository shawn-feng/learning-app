/**
 * ISSUE-122 回归（2026-09-21）：parent_db_write / child_db_write / tier2Write 的 rows 形状归一。
 *
 * 修复前：工具 schema 强制 rows 为数组、update 执行器却对 rows 做 Object.entries 期望对象——
 * LLM 只能传数组 → 列名变成下标 "0" → 恒报「列 0 未登记」，update 语义整体不可用。
 * 修复后：执行器双向兼容（update 数组取首元素/多元素拒绝；insert 对象视为单行），
 * schema 改 Type.Union 双形状，纯数字列名报错附形状自愈提示。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openParentLib } from "../server/src/db/parent-lib";
import { executeWrite, parentLibTableRegistry, digitColHint, type WriteRequest } from "../server/src/agent/db-channel";
import { tier2Write, type NamespaceRow } from "../server/src/agent/tier2";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue122-"));
const parentId = "parent-122";
const db = openParentLib(dataDir, parentId);
const specs = parentLibTableRegistry();

// courses.topic 有引用校验（→ topics.topic_key）：先播种主题
db.prepare("INSERT INTO topics (name, topic_key, method, progress, rules_json) VALUES ('论语', 'lunyu', '', '', '{}')").run();

afterAll(() => {
  try {
    db.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

function seedCourse(title: string): void {
  db.prepare(
    "INSERT INTO courses (topic, title, sort_order, material, send_material, tags, lesson_method, html_path, teaching_copy, assess_rubric) VALUES ('lunyu', ?, 1, '', '', '', '', '', '', '')"
  ).run(title);
}

const reg = (r: WriteRequest) => executeWrite(db, specs, r);

describe("ISSUE-122 executeWrite update：rows 双向兼容", () => {
  seedCourse("旧课程名");

  it("① 事故原始形态：update rows 传**数组**（单元素）→ 不再报「列 0 未登记」，正常更新", () => {
    const r = reg({ table: "courses", op: "update", rows: [{ title: "新课程名" }] as any, where: { title: "旧课程名" } });
    expect(r.ok).toBe(true);
    const row = db.prepare("SELECT title FROM courses WHERE title = ?").get("新课程名");
    expect(row).toBeTruthy();
  });

  it("② update rows 传对象（文档语义）→ 正常更新", () => {
    const r = reg({ table: "courses", op: "update", rows: { title: "新课程名2" }, where: { title: "新课程名" } });
    expect(r.ok).toBe(true);
    const row = db.prepare("SELECT title FROM courses WHERE title = ?").get("新课程名2");
    expect(row).toBeTruthy();
  });

  it("③ update rows 多元素数组 → 拒绝（一次只改一行）", () => {
    const r = reg({ table: "courses", op: "update", rows: [{ title: "a" }, { title: "b" }] as any, where: { title: "新课程名2" } });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("一次只改一行");
  });

  it("④ 未登记列 + 纯数字列名 → 报错附数组下标自愈提示", () => {
    const r = reg({ table: "courses", op: "update", rows: { "0": { title: "x" } } as any, where: { title: "新课程名2" } });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("列 0 未登记");
    expect(r.text).toContain("数组下标");
    expect(digitColHint("0")).toContain("数组下标");
    expect(digitColHint("title")).toBe("");
  });
});

describe("ISSUE-122 executeWrite insert：数组主路径不变 + 对象兼容", () => {
  it("⑤ insert 行数组（原路径）→ 多行插入", () => {
    const r = reg({
      table: "courses",
      op: "insert",
      rows: [
        { topic: "lunyu", title: "课A" },
        { topic: "lunyu", title: "课B" },
      ],
      where: {},
    });
    expect(r.ok).toBe(true);
    const n = db.prepare("SELECT COUNT(*) c FROM courses WHERE topic='lunyu' AND title IN ('课A','课B')").get() as { c: number };
    expect(n.c).toBe(2);
  });

  it("⑥ insert 单行对象（新兼容）→ 视为单行", () => {
    const r = reg({ table: "courses", op: "insert", rows: { topic: "lunyu", title: "课C" } as any, where: {} });
    expect(r.ok).toBe(true);
    const row = db.prepare("SELECT title FROM courses WHERE title = ?").get("课C");
    expect(row).toBeTruthy();
  });
});

describe("ISSUE-122 tier2Write 同构修复", () => {
  const ns: NamespaceRow = {
    ns: "issue122test",
    scope: "parent",
    label: "测试实体",
    version: 1,
    spec: {
      columns: {
        name: { kind: "text", desc: "名称" },
        note: { kind: "text", desc: "备注", notEmpty: false },
      },
      insertRequired: ["name"],
      filterable: ["name"],
    },
  };
  const whereName = (name: string) => ({ name });

  it("⑦ tier2 update rows 数组（事故形态）→ 正常更新；对象同效", () => {
    const ins = tier2Write(db, ns, { op: "insert", rows: [{ name: "实体A", note: "old" }] });
    expect(ins.ok).toBe(true);
    const r1 = tier2Write(db, ns, { op: "update", rows: [{ note: "new1" }] as any, where: whereName("实体A") });
    expect(r1.ok).toBe(true);
    const r2 = tier2Write(db, ns, { op: "update", rows: { note: "new2" }, where: whereName("实体A") });
    expect(r2.ok).toBe(true);
    const row = db
      .prepare("SELECT data_json FROM entities WHERE ns = ? ORDER BY updated_at DESC LIMIT 1")
      .get(ns.ns) as { data_json: string };
    expect(JSON.parse(row.data_json).note).toBe("new2");
  });

  it("⑧ tier2 update 多元素数组 → 拒绝", () => {
    const r = tier2Write(db, ns, { op: "update", rows: [{ note: "a" }, { note: "b" }] as any, where: whereName("实体A") });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("一次只改一行");
  });
});
