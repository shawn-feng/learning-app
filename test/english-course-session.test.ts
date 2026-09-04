import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 纯 node 环境没有 electron；config.ts 顶部 `import { app } from "electron"` 需打桩。
vi.mock("electron", () => ({ app: undefined }));

import {
  parseCourseKey,
  getCourseLessonSync,
  openKbDb,
} from "../electron/lib/kb-sqlite";
import { walkJsonlFiles } from "../electron/lib/session-sync";

// ISSUE-029 任务2（英语课独立子会话）：纯逻辑单元测试。
// 所有临时产物放 os.tmpdir()，不碰真实 data/（避免沙箱 EPERM）。

const tmpRoots: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "english-course-test-"));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言结果 */
    }
  }
});

describe("parseCourseKey：courseKey（<topic>:<title>）解析", () => {
  it("解析 english:12-yellow-01-Unit1-hello-story", () => {
    expect(parseCourseKey("english:12-yellow-01-Unit1-hello-story")).toEqual({
      topic: "english",
      title: "12-yellow-01-Unit1-hello-story",
    });
  });

  it("title 本身含冒号时按第一个冒号切分（title 保留完整剩余部分）", () => {
    expect(parseCourseKey("english:a:b:c")).toEqual({ topic: "english", title: "a:b:c" });
  });

  it("非法格式返回 null（无冒号 / 空 topic / 空 title）", () => {
    expect(parseCourseKey("no-colon")).toBeNull();
    expect(parseCourseKey(":title")).toBeNull();
    expect(parseCourseKey("english:")).toBeNull();
    expect(parseCourseKey("")).toBeNull();
  });
});

describe("getCourseLessonSync：同步读取孩子库课程教学内容", () => {
  it("读出 lesson_method / teaching_copy / html_path 等字段", () => {
    const childDir = makeTmpDir();
    const db = openKbDb(childDir);
    try {
      db.prepare(
        "INSERT INTO courses (topic, title, lesson_method, teaching_copy, html_path, material, send_material) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "english",
        "12-yellow-01-Unit1-hello-story",
        "跟读+对话+单词卡",
        "Hello/Walk/Jump 词表与句式",
        "english/12-yellow-01-Unit1-hello-story/learn/vocabulary.html",
        "剧集动画",
        "单词卡"
      );
    } finally {
      db.close();
    }
    const lesson = getCourseLessonSync(childDir, "english", "12-yellow-01-Unit1-hello-story");
    expect(lesson).not.toBeNull();
    expect(lesson!.topic).toBe("english");
    expect(lesson!.lessonMethod).toBe("跟读+对话+单词卡");
    expect(lesson!.teachingCopy).toContain("Hello/Walk/Jump");
    expect(lesson!.htmlPath).toContain("learn/vocabulary.html");
  });

  it("课程不存在 / 库异常时返回 null（降级不阻断会话创建）", () => {
    const childDir = makeTmpDir();
    expect(getCourseLessonSync(childDir, "english", "not-exist")).toBeNull();
    // 不存在的 childDir 也应安全返回 null
    expect(getCourseLessonSync(path.join(os.tmpdir(), "no-such-dir-xyz"), "english", "x")).toBeNull();
  });
});

describe("walkJsonlFiles：session-sync 递归扫描课程子会话目录", () => {
  it("递归收集根目录 + 课程子目录的 .jsonl（posix 相对路径），忽略其他文件", () => {
    const root = makeTmpDir();
    fs.writeFileSync(path.join(root, "main.jsonl"), "{}");
    const sub = path.join(root, "english-12-yellow-01");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "sess-a.jsonl"), "{}");
    fs.writeFileSync(path.join(sub, "note.txt"), "skip");
    const nested = path.join(sub, "deeper");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "sess-b.jsonl"), "{}");

    const out: string[] = [];
    walkJsonlFiles(root, out);
    const rel = out.sort();
    expect(rel).toEqual([
      "english-12-yellow-01/deeper/sess-b.jsonl",
      "english-12-yellow-01/sess-a.jsonl",
      "main.jsonl",
    ]);
  });

  it("不存在的目录不抛错、返回空", () => {
    const out: string[] = [];
    expect(() => walkJsonlFiles(path.join(os.tmpdir(), "no-such-dir-xyz"), out)).not.toThrow();
    expect(out).toEqual([]);
  });
});
