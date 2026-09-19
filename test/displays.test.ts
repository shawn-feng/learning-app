/**
 * ISSUE-113：孩子会话展示登记（display_contents）回归。
 * display_content 推送后登记 → 重进 /open 回填（ts 升序）→ /reset 或新会话清空；
 * 同 path 重复展示就地更新（对齐客户端 ISSUE-021 移到最新位置语义）。
 */
import { describe, expect, it, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openKb } from "../server/src/db/kb";
import { registerDisplay, clearDisplayLog, listDisplays } from "../server/src/db/displays";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "displays-"));
const parentId = "parent-disp";
const childId = "child-disp";

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL 句柄滞后 */
  }
});

function entry(path: string, title: string, ts: number, source = "materials", content = "") {
  return { path, title, source, content, ts };
}

describe("ISSUE-113：展示登记", () => {
  it("register/upsert：同 path 就地更新 ts（最新位置），list 按 ts 升序返回 Material 形状", () => {
    registerDisplay(dataDir, parentId, childId, "main", entry("lunyu/a.html", "资料A", 1000));
    registerDisplay(dataDir, parentId, childId, "main", entry("lunyu/b.html", "资料B", 2000));
    // 同 path 重复展示 → 移到最新
    registerDisplay(dataDir, parentId, childId, "main", entry("lunyu/a.html", "资料A·新", 3000));

    const out = listDisplays(dataDir, parentId, childId, "main", 20);
    expect(out.map((m) => m.title)).toEqual(["资料B", "资料A·新"]); // 升序=出现顺序（A 已移到最后）
    expect(out[1]).toMatchObject({
      id: expect.stringContaining("dsp-"),
      format: "html",
      filePath: "lunyu/a.html",
    });
  });

  it("limit：取最新 N 条且保持升序", () => {
    registerDisplay(dataDir, parentId, childId, "main-limit", entry("lunyu/b2.html", "资料B2", 2000));
    registerDisplay(dataDir, parentId, childId, "main-limit", entry("lunyu/a2.html", "资料A2", 1000));
    registerDisplay(dataDir, parentId, childId, "main-limit", entry("lunyu/c2.html", "资料C2", 4000));
    const out = listDisplays(dataDir, parentId, childId, "main-limit", 2);
    // 最新两条是 A2(1000 最早，被截) 之外——按 ts 取最新 2 条 C2(4000)/B2(2000)，升序返回
    expect(out.map((m) => m.title)).toEqual(["资料B2", "资料C2"]);
  });

  it("会话种类隔离：course 会话登记与 main 互不可见；clear 单种类/全量", () => {
    registerDisplay(dataDir, parentId, childId, "course:yingyu:第1课", entry("yingyu/l1.html", "英语L1", 5000, "workspace", "<html>1</html>"));
    expect(listDisplays(dataDir, parentId, childId, "main", 20).map((m) => m.title)).not.toContain("英语L1");
    // workspace 来源直接带 content（客户端刷新链路不覆盖 outputs 类）
    const course = listDisplays(dataDir, parentId, childId, "course:yingyu:第1课", 20);
    expect(course[0].content).toBe("<html>1</html>");
    // 单种类清空
    clearDisplayLog(dataDir, parentId, childId, "course:yingyu:第1课");
    expect(listDisplays(dataDir, parentId, childId, "course:yingyu:第1课", 20)).toHaveLength(0);
    expect(listDisplays(dataDir, parentId, childId, "main", 20).length).toBeGreaterThan(0);
    // 全量清空
    clearDisplayLog(dataDir, parentId, childId);
    expect(listDisplays(dataDir, parentId, childId, "main", 20)).toHaveLength(0);
  });

  it("display_contents 表随 openKb 幂等创建", async () => {
    const { DISPLAY_DDL } = await import("../server/src/db/kb");
    const db = openKb(dataDir, parentId, childId);
    const cols = (db.prepare("PRAGMA table_info(display_contents)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["child_key", "path", "title", "source", "content", "ts"]));
    expect(() => db.exec(DISPLAY_DDL)).not.toThrow();
    db.close();
  });
});
