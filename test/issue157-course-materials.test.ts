/**
 * ISSUE-157 回归：进度页课程详情「学习资料」tab 的服务端聚合 op（kb.displays.course_materials）。
 *
 * 覆盖：
 * ① display_contents 登记按 标题/文件名 stem/路径含课程名 匹配到该课；materials 行正文读文件真源（新鲜）；
 * ② 家长库 courses.html_path 显式配置的资料无条件收录（排登记之后）、文件存在才带正文；
 * ③ 同 path 去重（跨会话 child_key 多行只留最新）；无关课程登记不混入；
 * ④ 归属校验：别人的 childId 直接 403。
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

const COURSE = "论语先进篇第十三章";
const TOPIC = "lunyu";

function seed(): void {
  // 孩子库：课程行 + 两条展示登记（一条本课、一条别的课）+ workspace 登记一条（带正文）
  const kb = openKb(dataDir, parentId, childId);
  try {
    kb.prepare("INSERT OR IGNORE INTO courses (topic, topic_key, title, sort_order) VALUES (?, ?, ?, 1)").run(TOPIC, TOPIC, COURSE);
    kb.prepare(
      "INSERT INTO display_contents (child_key, path, title, source, content, ts) VALUES ('main', ?, ?, 'materials', '', 1000)"
    ).run(`${TOPIC}/${COURSE}.html`, COURSE);
    kb.prepare(
      "INSERT INTO display_contents (child_key, path, title, source, content, ts) VALUES ('main', ?, ?, 'materials', '', 900)"
    ).run("qianziwen/别的课.html", "别的课");
    kb.prepare(
      "INSERT INTO display_contents (child_key, path, title, source, content, ts) VALUES ('course:english:unit1', ?, ?, 'workspace', ?, 800)"
    ).run("outputs/本章小游戏.html", `${COURSE}·互动页`, "<html>小游戏正文</html>");
    kb.close();
  } catch (e) {
    throw e;
  }
  // 材料真源文件（登记 materials 行的正文从这里读）
  const dir = path.join(dataDir, "materials", parentId, TOPIC);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${COURSE}.html`), "<html>最新课程正文</html>", "utf-8");
  // 家长库：courses.html_path 显式配置（另一份补充资料，文件也要存在）
  const pl = openParentLib(dataDir, parentId);
  try {
    pl.prepare("INSERT INTO topics (name, topic_key) VALUES ('论语', 'lunyu')").run();
    pl.prepare("INSERT INTO courses (topic, title, html_path) VALUES (?, ?, ?)").run(TOPIC, COURSE, `${TOPIC}/${COURSE}-补充.html`);
    pl.close();
  } catch (e) {
    try {
      pl.close();
    } catch {
      /* 忽略 */
    }
    throw e;
  }
  fs.writeFileSync(path.join(dir, `${COURSE}-补充.html`), "<html>补充资料正文</html>", "utf-8");
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

describe("ISSUE-157 kb.displays.course_materials", () => {
  it("① 登记匹配 + materials 正文读文件真源 + workspace 正文随登记返回", () => {
    seed();
    const items = queryHandlers["kb.displays.course_materials"](ctx, {
      child_id: childId,
      topic: TOPIC,
      title: COURSE,
    }) as Array<{ id: string; filePath: string; content: string; source: string; title: string }>;
    // 三条：materials 登记 + workspace 登记 + html_path 补充；「别的课」不混入
    expect(items.length).toBe(3);
    expect(items.map((i) => i.filePath)).toEqual([
      `${TOPIC}/${COURSE}.html`, // 登记 ts 降序：materials 在前
      "outputs/本章小游戏.html", // workspace（标题含课程名匹配）
      `${TOPIC}/${COURSE}-补充.html`, // html_path 收录在最后
    ]);
    // materials 正文来自文件真源（非登记时的空串）
    expect(items[0]!.content).toBe("<html>最新课程正文</html>");
    expect(items[0]!.source).toBe("materials");
    // workspace 正文来自登记行
    expect(items[1]!.content).toBe("<html>小游戏正文</html>");
    expect(items[1]!.source).toBe("workspace");
    // html_path 补充资料
    expect(items[2]!.content).toBe("<html>补充资料正文</html>");
    expect(items[2]!.time).toBe("课程资料");
  });

  it("② 同 path 跨会话去重（只留最新一行）", () => {
    const kb = openKb(dataDir, parentId, childId);
    try {
      kb.prepare(
        "INSERT INTO display_contents (child_key, path, title, source, content, ts) VALUES ('course:lunyu:x', ?, ?, 'materials', '', 500)"
      ).run(`${TOPIC}/${COURSE}.html`, COURSE);
    } finally {
      kb.close();
    }
    const items = queryHandlers["kb.displays.course_materials"](ctx, {
      child_id: childId,
      topic: TOPIC,
      title: COURSE,
    }) as Array<{ filePath: string }>;
    expect(items.filter((i) => i.filePath === `${TOPIC}/${COURSE}.html`).length).toBe(1);
  });

  it("③ 别的 childId 直接 403（归属校验）", () => {
    expect(() =>
      queryHandlers["kb.displays.course_materials"](ctx, { child_id: "别人家孩子", topic: TOPIC, title: COURSE })
    ).toThrow(/无权访问/);
  });
});
