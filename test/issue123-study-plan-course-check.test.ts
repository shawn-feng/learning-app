/**
 * ISSUE-123 回归（2026-09-21）：学习计划的课程名必须是课程库真实存在的。
 *
 * 修复前：三条创建路径（agent 工具 / REST 路由 / recurrence 展开）对查不到的课程名一律
 * 落空 topic_key/course_uuid 照样插入——而学习域完成判定按 course_name 精确匹配 daily 记录，
 * 错名计划永远无法完成 → missed 顺延 + 拖累完成率扣分。
 * 修复后：
 * - parent_study_plan_create：查不到 → 整单拒绝（报不存在清单）；
 * - expandRecurrences（study 规则）：课程已不在库 → 跳过该条并告警（游标照常推进，不刷屏）；
 * - child_study_plan_create 原本就有硬校验（先例，不动）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { createPlanDomainTools } from "../server/src/agent/parent-plans";
import { expandRecurrences } from "../server/src/worker/plan-domain";
import type { WorkerTaskCtx } from "../server/src/worker/tasks";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue123-"));
const parentId = "parent-123";
const childId = "child-123";
const COURSE = "论语为政篇第一章";

const mainDb = openDb(dataDir);
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p123@test", new Date().toISOString(), new Date().toISOString());
mainDb
  .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(childId, parentId, "珊珊", new Date().toISOString(), new Date().toISOString());

// 家长库播种：真实课程「论语为政篇第一章」
let pl = openParentLib(dataDir, parentId);
pl.prepare("INSERT INTO topics (name, topic_key, method, progress, rules_json) VALUES ('lunyu', 'lunyu', '', '', '{}')").run();
pl.prepare("INSERT INTO courses (topic, title, sort_order) VALUES ('lunyu', ?, 1)").run(COURSE);
pl.close();

const tools = createPlanDomainTools({ db: mainDb, dataDir, parentId });
const createStudy = tools.find((t) => t.name === "parent_study_plan_create")!;

function toolText(r: { content: Array<{ type: string; text: string }> }): string {
  return r.content.map((c) => (c as { text: string }).text).join("");
}

function makeCtx(now: Date): WorkerTaskCtx {
  return { dataDir, mainDb, parentId, childId, auth: {}, schedulerConfig: {}, now, point: "" };
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

describe("ISSUE-123 parent_study_plan_create 课程名硬校验", () => {
  it("不存在的课程名 → 整单拒绝并报不存在清单", async () => {
    await expect(
      createStudy.execute("x", {
        childName: "珊珊",
        days: [{ date: "2026-09-25", content: ["论语为政篇第一章", "不存在的课程"] }],
      })
    ).rejects.toThrow(/不存在/);
    expect(pendingCount()).toBe(0); // 整单拒绝：真实课程也不落库
  });

  it("全部真实课程名 → 正常创建", async () => {
    const r = toolText(
      await createStudy.execute("x", {
        childName: "珊珊",
        days: [{ date: "2026-09-25", content: [COURSE, "复习：论语为政篇第一章"] }],
      })
    );
    expect(r).toContain(COURSE);
    // 新学 + 复习两行；topic_key/course_uuid 已反查（非空）
    const kb = openKb(dataDir, parentId, childId);
    try {
      const rows = kb
        .prepare("SELECT topic_key, course_uuid FROM study_plans WHERE substr(start_at,1,10)='2026-09-25'")
        .all() as Array<{ topic_key: string; course_uuid: string }>;
      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(row.topic_key).toBe("lunyu");
        expect(row.course_uuid).not.toBe("");
      }
    } finally {
      kb.close();
    }
  });
});

describe("ISSUE-123 recurrence 展开：课程已不在库 → 跳过+告警（游标照常推进）", () => {
  function seedRule(id: string, courseName: string): void {
    const kb = openKb(dataDir, parentId, childId);
    try {
      kb
        .prepare(
          "INSERT INTO plan_recurrences (id, parent_id, child_id, plan_type, payload_json, rule, enabled, last_expanded_date, start_date, end_date, created_at, updated_at) VALUES (?, ?, ?, 'study', ?, 'daily', 1, '', '2026-09-20', '', ?, ?)"
        )
        .run(id, parentId, childId, JSON.stringify({ course_name: courseName, mode: "new", creator: "parent" }), new Date().toISOString(), new Date().toISOString());
    } finally {
      kb.close();
    }
  }

  it("有效课程照常展开；无效课程跳过；两类规则游标都推进（次日不再重复处理）", async () => {
    seedRule("rec-valid", COURSE);
    seedRule("rec-stale", "已被删除的课程");
    const created = expandRecurrences(makeCtx(new Date(2026, 8, 25, 6, 0)));
    expect(created).toBe(1); // 只有有效课程落计划

    const kb = openKb(dataDir, parentId, childId);
    try {
      const plans = kb
        .prepare("SELECT course_name FROM study_plans WHERE origin='recurrence'")
        .all() as Array<{ course_name: string }>;
      expect(plans.map((p) => p.course_name)).toEqual([COURSE]);
      // 游标推进：同日再跑不重复展开
      const cur = kb
        .prepare("SELECT id, last_expanded_date FROM plan_recurrences ORDER BY id")
        .all() as Array<{ id: string; last_expanded_date: string }>;
      for (const row of cur) expect(row.last_expanded_date).toBe("2026-09-25");
    } finally {
      kb.close();
    }
    const created2 = expandRecurrences(makeCtx(new Date(2026, 8, 25, 8, 0)));
    expect(created2).toBe(0);
  });
});

function pendingCount(): number {
  const kb = openKb(dataDir, parentId, childId);
  try {
    return (kb.prepare("SELECT COUNT(*) c FROM study_plans WHERE status='pending'").get() as { c: number }).c;
  } finally {
    kb.close();
  }
}
