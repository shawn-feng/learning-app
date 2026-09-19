/**
 * kb_query progress 的 topic 入参解析回归（2026-09-19）：
 * 中文名「论语」曾因视图/courses.topic 存 topic_key 而原样匹配落空，返回「已学 0/0」的假结果。
 * 修复后中文名/topic_key 双兼容；本测试用真实孩子库 + 真实 RPC handler 验证全链路。
 */
import { describe, expect, it, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openKb } from "../server/src/db/kb";
import { resolveTopicInput } from "../server/src/worker/kb-tools";
import { queryHandlers } from "../server/src/routes/db";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-progress-"));
const parentId = "parent-progress";
const childId = "child-progress";
const mainDb = new DatabaseSync(":memory:");
mainDb.exec("CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '')");
mainDb.prepare("INSERT INTO children (id, parent_id, name) VALUES (?,?,?)").run(childId, parentId, "测试孩子");
const ctx = { dataDir, mainDb, parentId };

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL 句柄滞后 */
  }
});

function seed() {
  const db = openKb(dataDir, parentId, childId);
  db.exec("INSERT INTO topics (name, topic_key, learn_type) VALUES ('论语', 'lunyu', 'required')");
  const rows: Array<[string, string]> = [
    ["论语学而篇第一章", "✅"],
    ["论语学而篇第二章", "✅"],
    ["论语为政篇第一章", "⬜"],
  ];
  let i = 0;
  for (const [title, status] of rows) {
    db.prepare(
      "INSERT INTO courses (topic, topic_key, title, sort_order, status, last_review) VALUES ('lunyu','lunyu',?,?,?,?)"
    ).run(title, ++i, status, status === "✅" ? "2026-09-10" : "");
  }
  db.close();
}

describe("kb_query progress：topic 入参双兼容", () => {
  it("resolveTopicInput：key 精确 / name 精确 / 包含 / 不中回退", () => {
    const topics = [
      { name: "论语", topic_key: "lunyu" },
      { name: "千字文", topic_key: "qianziwen" },
    ];
    expect(resolveTopicInput(topics, "论语")).toBe("lunyu");
    expect(resolveTopicInput(topics, "lunyu")).toBe("lunyu");
    expect(resolveTopicInput(topics, "千字")).toBe("qianziwen");
    expect(resolveTopicInput(topics, "不存在")).toBe("不存在");
  });

  it("全链路：中文名查进度得到真实值（修复前为 0/0）", () => {
    seed();
    // 视图本身正确（key 语义）
    const agg = queryHandlers["kb.progress.list"](ctx, { child_id: childId }) as Array<any>;
    const lunyu = agg.find((p) => p.topic === "lunyu");
    expect(lunyu).toMatchObject({ learned: 2, total: 3 });
    // 修复点：resolveTopicInput 把「论语」解析成 lunyu 后，courses.list 命中
    const topics = queryHandlers["kb.topics.list"](ctx, { child_id: childId }) as Array<any>;
    const topicKey = resolveTopicInput(topics, "论语");
    const courses = queryHandlers["kb.courses.list"](ctx, { child_id: childId, topic: topicKey }) as Array<any>;
    expect(courses.length).toBe(3);
    expect(courses.every((c) => c.topic_key === "lunyu")).toBe(true);
    // 修复前行为对照：原样传中文名 → 0 行（证明根因与修复有效性）
    const before = queryHandlers["kb.courses.list"](ctx, { child_id: childId, topic: "论语" }) as Array<any>;
    expect(before.length).toBe(0);
  });
});
