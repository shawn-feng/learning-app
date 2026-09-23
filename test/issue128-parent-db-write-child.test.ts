/**
 * ISSUE-105 修订回归（2026-09-21）：家长 db 通道按管理口径开放孩子库**全部登记表**。
 *
 * 用户原始场景：parent_db_write + child 改孩子库 study_plans.course_name——
 * 修复前撞两表白名单（「没有登记名为 study_plans 的表」）；修复后（childKbAdminWriteSpecs）直接可改。
 * 同时守住：孩子 agent 自己的写面（childKbWritableRegistry）**不变**（study_plans 仍不可写）；
 * 状态机表 insert 需自带 id/时间戳；列校验/审计语义不变。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { executeWrite, childKbAdminWriteSpecs, childKbWritableRegistry, type WriteRequest } from "../server/src/agent/db-channel";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue128-"));
const parentId = "parent-128";
const childId = "child-128";

const mainDb = openDb(dataDir);
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p128@test", new Date().toISOString(), new Date().toISOString());
mainDb
  .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(childId, parentId, "珊珊", new Date().toISOString(), new Date().toISOString());

// 孩子库（openKb 建全量表）+ 播种一条学习计划（用户原始场景）
const kb = openKb(dataDir, parentId, childId);
kb
  .prepare(
    `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,recurrence_id,
       start_at,due_at,status,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
     VALUES ('plan-128',?,?, 'lunyu','u-1','错名课程','new','parent','conversation','','','2026-09-21 00:00:00','2026-09-21 23:59:59','pending','','','required',1,0,1,?,?)`
  )
  .run(parentId, childId, new Date().toISOString(), new Date().toISOString());

const adminSpecs = childKbAdminWriteSpecs();
const now = new Date().toISOString();

afterAll(() => {
  try {
    kb.close();
  } catch {
    /* 忽略 */
  }
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

describe("ISSUE-105 修订：家长 db 通道孩子库全表管理口径", () => {
  it("① 用户原始场景：update study_plans.course_name → 直接可改", () => {
    const r = executeWrite(kb, adminSpecs, {
      table: "study_plans",
      op: "update",
      rows: { course_name: "论语子罕篇第十二章" },
      where: { id: "plan-128" },
    } as WriteRequest);
    expect(r.ok).toBe(true);
    const row = kb.prepare("SELECT course_name FROM study_plans WHERE id='plan-128'").get() as { course_name: string };
    expect(row.course_name).toBe("论语子罕篇第十二章");
  });

  it("② 状态机表 insert（自带 id/时间戳）→ 可用", () => {
    const r = executeWrite(kb, adminSpecs, {
      table: "exam_plans",
      op: "insert",
      rows: [
        {
          id: "ep_manual_1",
          parent_id: parentId,
          child_id: childId,
          title: "手工补录考核",
          creator: "parent",
          kind: "custom",
          start_at: "2026-09-21 00:00:00",
          due_at: "2026-09-21 23:59:59",
          status: "pending",
          task_type: "required",
          created_at: now,
          updated_at: now,
        },
      ],
      where: {},
    });
    expect(r.ok).toBe(true);
  });

  it("③ 未登记列仍拒绝（列校验语义不变）", () => {
    const r = executeWrite(kb, adminSpecs, {
      table: "study_plans",
      op: "update",
      rows: { not_a_column: 1 },
      where: { id: "plan-128" },
    } as WriteRequest);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("未登记");
  });

  it("④ 孩子 agent 自己的写面不变：childKbWritableRegistry 下 study_plans 仍不可写", () => {
    const r = executeWrite(kb, childKbWritableRegistry(), {
      table: "study_plans",
      op: "update",
      rows: { course_name: "x" },
      where: { id: "plan-128" },
    } as WriteRequest);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("没有登记名为「study_plans」的表");
  });

  it("⑤ 管理规格覆盖全部登记表且带全 ops", () => {
    const tables = adminSpecs.map((s) => s.table);
    for (const t of ["study_plans", "exam_plans", "exam_plan_courses", "life_plans", "points_ledger", "reward_configs", "plan_recurrences"]) {
      expect(tables).toContain(t);
    }
    for (const s of adminSpecs) {
      expect(s.ops).toEqual(["insert", "update", "delete"]);
      expect(s.rowLimit).toBe(50);
    }
  });
});
