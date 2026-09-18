/**
 * 2026-09-18 库域分工（P1）回归用例：
 * - 孩子库：courses 纯进度表（教学字段副本删除、topic_key 真引用回填）、topics 分配表（learn_type 回填）；
 * - 家长库：courses 纯内容表（status/last_review/review_count 删除、topic_progress 视图退役）；
 * - RPC 语义：kb.courses.get 教学内容实时读家长库、parent_lib.progress.list 跨孩子聚合、
 *   kb.topics.upsert learn_type（含 rules_json.type 中文推导、老参数兼容）。
 * 用真实文件库 + 真实 openKb/openParentLib 迁移链路（不是内存库）。
 */
import { describe, expect, it, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { execHandlers, queryHandlers } from "../server/src/routes/db";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-domain-split-"));
const parentId = "parent-it";

afterAll(() => {
  // Windows：SQLite WAL 句柄释放可能滞后，清理失败不作为测试失败（临时目录由系统回收）
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

function colNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function ctxFor(mainDb: DatabaseSync): { dataDir: string; mainDb: DatabaseSync; parentId: string } {
  return { dataDir, mainDb, parentId };
}

/** 造一个「2026-09-18 之前」结构的孩子库：courses 带教学字段、topics 带 method/progress、无 topic_key/learn_type */
function seedOldChildKb(childId: string): void {
  const dir = path.join(dataDir, "kb", parentId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, `${childId}.sqlite`));
  db.exec(`
    CREATE TABLE courses (
      topic TEXT NOT NULL, title TEXT NOT NULL, uuid TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT '⬜',
      last_review TEXT NOT NULL DEFAULT '', review_count INTEGER NOT NULL DEFAULT 0,
      material TEXT NOT NULL DEFAULT '', send_material TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '', lesson_method TEXT NOT NULL DEFAULT '',
      html_path TEXT NOT NULL DEFAULT '', teaching_copy TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (topic, title)
    );
    CREATE TABLE topics (
      name TEXT PRIMARY KEY, topic_key TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT '', progress TEXT NOT NULL DEFAULT '',
      rules_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO topics (name, topic_key, method, progress, rules_json)
      VALUES ('论语', 'lunyu', '旧教法', '旧进度', '{"type":"选学"}');
    INSERT INTO topics (name, topic_key, method, progress, rules_json)
      VALUES ('英语', 'english', '', '', '{}');
    INSERT INTO courses (topic, title, uuid, sort_order, status, last_review, review_count, material, html_path, teaching_copy, lesson_method, send_material, tags)
      VALUES ('lunyu', '第一课', 'u-1', 1, '✅', '2026-09-01', 2, '旧资料', 'lunyu/lesson-01.html', '旧文案', '旧课法', '旧发送', '经典');
  `);
  db.close();
}

/** 造一个旧结构家长库：courses 带进度字段 */
function seedOldParentLib(): void {
  const dir = path.join(dataDir, "parents", parentId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "parent.sqlite"));
  db.exec(`
    CREATE TABLE topics (
      name TEXT PRIMARY KEY, topic_key TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT '', assess_method TEXT NOT NULL DEFAULT '',
      progress TEXT NOT NULL DEFAULT '', rules_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE courses (
      topic TEXT NOT NULL, title TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '⬜', last_review TEXT NOT NULL DEFAULT '',
      review_count INTEGER NOT NULL DEFAULT 0,
      material TEXT NOT NULL DEFAULT '', send_material TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '', lesson_method TEXT NOT NULL DEFAULT '',
      html_path TEXT NOT NULL DEFAULT '', teaching_copy TEXT NOT NULL DEFAULT '',
      assess_rubric TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (topic, title)
    );
    CREATE VIEW topic_progress AS SELECT topic, COUNT(*) AS total FROM courses GROUP BY topic;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO topics (name, topic_key) VALUES ('论语', 'lunyu');
    INSERT INTO courses (topic, title, sort_order, status, last_review, review_count, material, html_path, teaching_copy)
      VALUES ('lunyu', '第一课', 1, '✅', '2026-09-01', 9, '资料', 'lunyu/lesson-01.html', '教学文案');
  `);
  db.close();
}

/** 最小主库（children 归属校验用）+ 两个孩子 */
function seedMainDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '')");
  db.prepare("INSERT INTO children (id, parent_id, name) VALUES (?, ?, ?)").run("child-a", parentId, "大哥");
  db.prepare("INSERT INTO children (id, parent_id, name) VALUES (?, ?, ?)").run("child-b", parentId, "二哥");
  return db;
}

describe("库域分工 P1：存量库迁移", () => {
  it("孩子库：教学字段删除、topic_key 回填、learn_type 从 rules_json.type 迁移、进度字段保留", () => {
    seedOldChildKb("child-a");
    const kb = openKb(dataDir, parentId, "child-a");
    try {
      const cCols = colNames(kb, "courses");
      for (const gone of ["material", "send_material", "lesson_method", "html_path", "teaching_copy", "mastery", "first_learned"]) {
        expect(cCols).not.toContain(gone);
      }
      expect(cCols).toContain("topic_key");
      expect(cCols).toContain("status");
      expect(cCols).toContain("last_review");
      const course = kb.prepare("SELECT topic_key, status, last_review, review_count FROM courses WHERE title = '第一课'").get() as any;
      expect(course.topic_key).toBe("lunyu");
      expect(course.status).toBe("✅");
      expect(course.last_review).toBe("2026-09-01");
      expect(course.review_count).toBe(2);

      const tCols = colNames(kb, "topics");
      expect(tCols).not.toContain("method");
      expect(tCols).not.toContain("progress");
      expect(tCols).toContain("learn_type");
      const lunyu = kb.prepare("SELECT learn_type FROM topics WHERE topic_key = 'lunyu'").get() as any;
      expect(lunyu.learn_type).toBe("optional"); // 选学
      const english = kb.prepare("SELECT learn_type FROM topics WHERE topic_key = 'english'").get() as any;
      expect(english.learn_type).toBe("required"); // 缺省必学

      // 视图正常重建可用
      expect(kb.prepare("SELECT COUNT(*) AS n FROM topic_progress").get()).toBeTruthy();
      expect(kb.prepare("SELECT COUNT(*) AS n FROM course_progress").get()).toBeTruthy();
    } finally {
      kb.close();
    }
  });

  it("家长库：status/last_review/review_count 删除、topic_progress 视图退役、内容字段保留", () => {
    seedOldParentLib();
    const lib = openParentLib(dataDir, parentId);
    try {
      const cols = colNames(lib, "courses");
      for (const gone of ["status", "last_review", "review_count", "mastery", "first_learned"]) {
        expect(cols).not.toContain(gone);
      }
      for (const kept of ["material", "send_material", "lesson_method", "html_path", "teaching_copy", "assess_rubric", "uuid"]) {
        expect(cols).toContain(kept);
      }
      const views = lib.prepare("SELECT name FROM sqlite_master WHERE type='view'").all() as Array<{ name: string }>;
      expect(views.map((v) => v.name)).not.toContain("topic_progress");
      const row = lib.prepare("SELECT material, html_path FROM courses WHERE title = '第一课'").get() as any;
      expect(row.material).toBe("资料");
    } finally {
      lib.close();
    }
  });

  it("迁移幂等：重复 openKb/openParentLib 不报错不丢数据", () => {
    expect(() => openKb(dataDir, parentId, "child-a")).not.toThrow();
    const kb = openKb(dataDir, parentId, "child-a");
    expect((kb.prepare("SELECT COUNT(*) AS n FROM courses").get() as any).n).toBe(1);
    kb.close();
    expect(() => openParentLib(dataDir, parentId)).not.toThrow();
  });
});

describe("库域分工 P1：RPC 语义", () => {
  const mainDb = seedMainDb();
  const ctx = ctxFor(mainDb);

  it("kb.topics.upsert：learn_type 直写 + 未传时由 rules_json.type 推导（老客户端兼容）", () => {
    execHandlers["kb.topics.upsert"](ctx, { child_id: "child-a", name: "论语", topic_key: "lunyu", learn_type: "required", rules_json: "{}" });
    execHandlers["kb.topics.upsert"](ctx, { child_id: "child-a", name: "英语", topic_key: "english", method: "", progress: "", rules_json: '{"type":"复习"}' });
    const rows = queryHandlers["kb.topics.list"](ctx, { child_id: "child-a" }) as Array<any>;
    const lunyu = rows.find((r) => r.topic_key === "lunyu");
    const english = rows.find((r) => r.topic_key === "english");
    expect(lunyu.learn_type).toBe("required");
    expect(english.learn_type).toBe("review"); // 中文「复习」→ review
    expect(lunyu.method).toBeUndefined(); // 列已不存在
  });

  it("kb.courses.upsert/insert：教学字段参数被忽略、topic_key 自动解析、进度字段正常", () => {
    // 老客户端带教学字段调用（应为兼容不报错、不入库）
    execHandlers["kb.courses.upsert"](ctx, {
      child_id: "child-a", topic: "lunyu", title: "第二课", sort_order: 2, status: "⬜",
      material: "不该入库", html_path: "x.html", teaching_copy: "x", lesson_method: "x", send_material: "x", tags: "经典",
    });
    const kb = openKb(dataDir, parentId, "child-a");
    try {
      const row = kb.prepare("SELECT topic_key, status, tags FROM courses WHERE title = '第二课'").get() as any;
      expect(row.topic_key).toBe("lunyu");
      expect(row.tags).toBe("经典");
      const cols = colNames(kb, "courses");
      expect(cols).not.toContain("material");
      expect(cols).not.toContain("html_path");
    } finally {
      kb.close();
    }
  });

  it("kb.courses.get：教学内容实时读家长库，孩子库只判分配；响应 shape 不变", () => {
    const r = queryHandlers["kb.courses.get"](ctx, { child_id: "child-a", topic: "lunyu", title: "第一课" }) as any;
    expect(r).not.toBeNull();
    expect(r.topic).toBe("lunyu");
    expect(r.teaching_copy).toBe("教学文案"); // 家长库真源
    expect(r.html_path).toBe("lunyu/lesson-01.html");
    // 未分配的课 → null（与旧行为一致）
    const miss = queryHandlers["kb.courses.get"](ctx, { child_id: "child-a", topic: "lunyu", title: "不存在的课" });
    expect(miss).toBeNull();
  });

  it("parent_lib.progress.list：跨孩子聚合孩子库 topic_progress", () => {
    // child-b 也学 lunyu：构造 child-b 的进度行
    const kbB = openKb(dataDir, parentId, "child-b");
    kbB.exec("INSERT INTO topics (name, topic_key) VALUES ('论语', 'lunyu')");
    kbB.exec(
      "INSERT INTO courses (topic, topic_key, title, status, last_review) VALUES ('lunyu', 'lunyu', '第一课', '⬜', '')"
    );
    kbB.close();

    const rows = queryHandlers["parent_lib.progress.list"](ctx, {}) as Array<any>;
    const lunyu = rows.find((r) => r.topic === "lunyu");
    expect(lunyu).toBeTruthy();
    // child-a ✅(1) + child-b ⬜(0) = 1；total 取最大：child-a 有两课(第一课+第二课)=2
    expect(lunyu.learned).toBe(1);
    expect(lunyu.total).toBe(2);
  });

  it("parent_lib.courses.upsert：老调用方带 status/last_review 参数兼容（忽略不报错）", () => {
    expect(() =>
      execHandlers["parent_lib.courses.upsert"](ctx, {
        topic: "lunyu", title: "第三课", sort_order: 3, status: "✅", last_review: "2026-09-02", review_count: 5, material: "m",
      })
    ).not.toThrow();
    const rows = queryHandlers["parent_lib.courses.list"](ctx, { topic: "lunyu" }) as Array<any>;
    const c3 = rows.find((r) => r.title === "第三课");
    expect(c3).toBeTruthy();
    expect(c3.material).toBe("m");
    expect(c3.status).toBeUndefined(); // 列已不存在
  });
});
