/**
 * ISSUE-157 + 反馈（2026-09-27）回归：进度页课程详情「学习资料」tab 的数据源 op
 * （kb.courses.html_material——按用户拍板收窄为**只取课程配置的 html_path**，无展示登记聚合）。
 *
 * 覆盖：
 * ① html_path 配置存在 → 返回 {path,title,content}，正文读文件真源（新根优先/旧根兜底）；
 * ② 未配置 html_path / 课程不在孩子库 → null（前端空态）；
 * ③ 沙箱形状：path 含 .. / 盘符 / 裸文件名 → null；归属校验：别人的 childId → 403。
 */
import { describe, expect, it, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { queryHandlers } from "../server/src/routes/db";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue157-"));
const parentId = "parent-157";
const childId = "child-157";
const mainDb = new DatabaseSync(":memory:");
mainDb.exec(
  "CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '')"
);
mainDb.prepare("INSERT INTO children (id, parent_id, name) VALUES (?,?,?)").run(childId, parentId, "测试孩子");
const ctx = { dataDir, mainDb, parentId };

const COURSE = "05·音标拼读";
const TOPIC = "english";

function seed(htmlPath: string): void {
  const kb = openKb(dataDir, parentId, childId);
  try {
    kb.prepare("INSERT OR IGNORE INTO courses (topic, topic_key, title, sort_order) VALUES (?, ?, ?, 1)").run(TOPIC, TOPIC, COURSE);
  } finally {
    kb.close();
  }
  const pl = openParentLib(dataDir, parentId);
  try {
    pl.prepare("INSERT OR IGNORE INTO topics (name, topic_key) VALUES ('英语', 'english')").run();
    // REPLACE：同一测试库内重复 seed 同一门课时以最新 html_path 为准
    pl.prepare("INSERT OR REPLACE INTO courses (topic, title, html_path) VALUES (?, ?, ?)").run(TOPIC, COURSE, htmlPath);
    pl.close();
  } catch (e) {
    try {
      pl.close();
    } catch {
      /* 忽略 */
    }
    throw e;
  }
}

afterAll(() => {
  try {
    mainDb.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL 句柄滞后，忽略 */
  }
});

describe("ISSUE-157 kb.courses.html_material（只取 html_path）", () => {
  it("① 配置了 html_path → 返回路径+正文（文件真源直读）；materials/ 前缀归一", () => {
    seed(`materials/${TOPIC}/${COURSE}.html`);
    const dir = path.join(dataDir, "workspaces", parentId, "materials", TOPIC);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${COURSE}.html`), "<html>课程资料正文</html>", "utf-8");
    const item = queryHandlers["kb.courses.html_material"](ctx, { child_id: childId, topic: TOPIC, title: COURSE }) as {
      path: string;
      title: string;
      content: string;
    };
    expect(item.path).toBe(`${TOPIC}/${COURSE}.html`); // materials/ 前缀剥掉
    expect(item.title).toBe(COURSE);
    expect(item.content).toBe("<html>课程资料正文</html>");
  });

  it("② 未配置 html_path / 课程不在孩子库 → null", () => {
    seed("");
    expect(queryHandlers["kb.courses.html_material"](ctx, { child_id: childId, topic: TOPIC, title: COURSE })).toBeNull();
    expect(
      queryHandlers["kb.courses.html_material"](ctx, { child_id: childId, topic: TOPIC, title: "不存在的课" })
    ).toBeNull();
  });

  it("③ 沙箱形状（.. / 盘符 / 裸文件名）→ null；别人的 childId → 403", () => {
    for (const bad of ["../escape.html", "C:\\x\\y.html", "bare.html"]) {
      expect(queryHandlers["kb.courses.html_material"](ctx, { child_id: childId, topic: TOPIC, title: bad })).toBeNull();
    }
    expect(() => queryHandlers["kb.courses.html_material"](ctx, { child_id: "别人家孩子", topic: TOPIC, title: COURSE })).toThrow(
      /无权访问/
    );
  });
});
