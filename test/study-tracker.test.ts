import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { openKbDb } from "../electron/lib/kb-sqlite.ts";
import { runStudyTracker } from "../electron/lib/study-tracker.ts";

// study-tracker 纯代码实现：node:sqlite 读写，不依赖 electron，无需打桩。
// 用临时目录隔离，不碰真实孩子库。

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-tracker-test-"));
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 沙箱 safe-delete 可能拦截 rmSync（已知环境问题），残留临时目录不影响结果
  }
});

/** 造一个孩子库：论语（必学 daily=2，今日学 1 课）+ 陶笛（选学，今日学 1 课）。 */
function seed(learnedToday: number) {
  const db = openKbDb(tmpDir);
  try {
    db.prepare("INSERT INTO topics (name, file, rules_json) VALUES (?, ?, ?)").run(
      "论语",
      "lunyu/lunyu.md",
      JSON.stringify({ daily: "2", type: "必学" })
    );
    db.prepare("INSERT INTO topics (name, file, rules_json) VALUES (?, ?, ?)").run(
      "陶笛",
      "taodi/taodi.md",
      JSON.stringify({ type: "选学" })
    );
    for (let i = 1; i <= learnedToday; i++) {
      db.prepare(
        "INSERT INTO courses (topic, title, sort_order, status, first_learned) VALUES (?, ?, ?, ?, ?)"
      ).run(`lunyu`, `论语学而篇第${i}章`, i, "✅", "2026-08-23");
    }
    db.prepare(
      "INSERT INTO courses (topic, title, sort_order, status, first_learned) VALUES (?, ?, ?, ?, ?)"
    ).run("taodi", "陶笛入门", 1, "✅", "2026-08-23");
  } finally {
    db.close();
  }
}

describe("runStudyTracker（代码版每日达标评估）", () => {
  it("必学主题按 今日新增 >= 每日目标 判定达标；选学不参与", () => {
    seed(1); // 论语今日 1 课，目标 2 课 → 未达标
    const r = runStudyTracker(tmpDir, "2026-08-23");

    const lunyu = r.topics.find((t) => t.dir === "lunyu")!;
    expect(lunyu.required).toBe(true);
    expect(lunyu.daily).toBe(2);
    expect(lunyu.todayLearned).toBe(1);
    expect(lunyu.done).toBe(false);

    const taodi = r.topics.find((t) => t.dir === "taodi")!;
    expect(taodi.required).toBe(false);
    expect(taodi.todayLearned).toBe(1);
    expect(taodi.done).toBe(false); // 选学不判定

    expect(r.requiredCount).toBe(1);
    expect(r.passCount).toBe(0);
    expect(r.doneRatio).toBeCloseTo(0.5, 5); // min(1,2)/2
    expect(r.markdown).toContain("论语");
    expect(r.markdown).toContain("还差 1 课");
    expect(r.markdown).toContain("陶笛");
  });

  it("今日新增达到目标即达标，完成度=1", () => {
    const db = openKbDb(tmpDir);
    try {
      // 再补 1 课今天学的论语 → 今日 2 课，达到 daily=2
      db.prepare(
        "INSERT INTO courses (topic, title, sort_order, status, first_learned) VALUES (?, ?, ?, ?, ?)"
      ).run("lunyu", "论语学而篇第3章", 3, "✅", "2026-08-23");
    } finally {
      db.close();
    }
    const r = runStudyTracker(tmpDir, "2026-08-23");
    const lunyu = r.topics.find((t) => t.dir === "lunyu")!;
    expect(lunyu.todayLearned).toBe(2);
    expect(lunyu.done).toBe(true);
    expect(r.passCount).toBe(1);
    expect(r.doneRatio).toBeCloseTo(1, 5);
  });

  it("评估报告写入 learning/tracker-latest.md（latest 快照）", () => {
    const p = path.join(tmpDir, "learning", "tracker-latest.md");
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, "utf-8")).toContain("2026-08-23 学习评估");
  });

  it("today 参数注入生效：非当天 first_learned 不计入今日新增", () => {
    const db = openKbDb(tmpDir);
    try {
      db.prepare(
        "INSERT INTO courses (topic, title, sort_order, status, first_learned) VALUES (?, ?, ?, ?, ?)"
      ).run("lunyu", "论语学而篇第4章", 4, "✅", "2026-08-01");
    } finally {
      db.close();
    }
    // 用另一个日期评估：8/01 当天学的只有 1 课（第4章），8/23 学的 2 课不算
    const r = runStudyTracker(tmpDir, "2026-08-01");
    const lunyu = r.topics.find((t) => t.dir === "lunyu")!;
    expect(lunyu.todayLearned).toBe(1);
  });
});
