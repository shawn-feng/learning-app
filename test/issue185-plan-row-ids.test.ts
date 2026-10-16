/**
 * ISSUE-185 回归（2026-10-16）：家长 agent 拿不到**完整行 id** → 撤不掉考核（及学习/生活计划）。
 *
 * 现场：`exam_plans` 自定义考核 id = `ep_<Date.now()>_<rand6>`，同一天建的场次前 8 位完全一样
 * （珊珊/闻闻当天全是 `ep_17921…`）。旧实现：
 *   ① 列表只回 `id.slice(0, 8)` → agent 手里没有唯一标识；
 *   ② 定位用 `rows.find(id === want || id.startsWith(want))` → 取第一条，**可能撤错行**。
 * 修复：列表回**完整 id**；定位改 `resolveRowById`（精确优先；前缀撞多行 → 报错并列出候选，不猜）。
 *
 * 覆盖：
 * ① `parent_exam_plan_list` 输出完整 id（含同日同前缀的两场），且不再出现「取前 8 位」口径；
 * ② `parent_exam_plan_cancel` 传公共前缀 → 抛歧义错误 + 列出两条完整候选，且**一行都没被取消**；
 * ③ 传完整 id → 只取消目标那一行，另一行仍 pending；
 * ④ 学习计划同款：`parent_study_plan_list` 回完整 id，`parent_study_plan_update` 前缀歧义拒绝；
 * ⑤ 孩子侧同款（同一 `resolveRowById`）：`child_exam_plan_list` 回完整 id、`child_exam_plan_update` 前缀歧义拒绝。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { createPlanDomainTools } from "../server/src/agent/parent-plans";
import { createChildExamPlanListTool, createChildExamPlanUpdateTool } from "../server/src/agent/plan-tools";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue185-"));
const parentId = "parent-185";
const childId = "child-185";
const DAY = "2026-10-16";
/** 同一天（同一毫秒量级）建的两场考核：前 8 位相同，只在尾部可区分 */
const EP_PREFIX = "ep_17921";
const EP_A = `${EP_PREFIX}_aaaaaa`;
const EP_B = `${EP_PREFIX}_bbbbbb`;
const SP_PREFIX = "sp_17921";
const SP_A = `${SP_PREFIX}_aaaaaa`;
const SP_B = `${SP_PREFIX}_bbbbbb`;

const mainDb = openDb(dataDir);
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p185@test", new Date().toISOString(), new Date().toISOString());
mainDb
  .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(childId, parentId, "珊珊", new Date().toISOString(), new Date().toISOString());

const kb = openKb(dataDir, parentId, childId);
try {
  const insEp = kb.prepare(
    `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,scope_json,start_at,due_at,status,created_at,updated_at)
     VALUES (?,?,?,?,'parent','custom','{}',?,?,'pending',?,?)`
  );
  const now = `${DAY} 10:00:00`;
  insEp.run(EP_A, parentId, childId, "字词考核", `${DAY} 00:00:00`, `${DAY} 23:59:59`, now, now);
  insEp.run(EP_B, parentId, childId, "背诵考核", `${DAY} 00:00:00`, `${DAY} 23:59:59`, now, now);
  const insSp = kb.prepare(
    `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_name,mode,start_at,due_at,status,created_at,updated_at)
     VALUES (?,?,?,'lunyu',?,'new',?,?,'pending',?,?)`
  );
  insSp.run(SP_A, parentId, childId, "论语学而篇第一章", `${DAY} 00:00:00`, `${DAY} 23:59:59`, now, now);
  insSp.run(SP_B, parentId, childId, "论语为政篇第一章", `${DAY} 00:00:00`, `${DAY} 23:59:59`, now, now);
} finally {
  kb.close();
}

const tools = createPlanDomainTools({ db: mainDb, dataDir, parentId });
const examList: any = tools.find((t) => t.name === "parent_exam_plan_list")!;
const examCancel: any = tools.find((t) => t.name === "parent_exam_plan_cancel")!;
const planList: any = tools.find((t) => t.name === "parent_study_plan_list")!;
const planUpdate: any = tools.find((t) => t.name === "parent_study_plan_update")!;

function toolText(r: { content: Array<{ type: string; text: string }> }): string {
  return r.content.map((c) => (c as { text: string }).text).join("");
}

function examStatus(id: string): string {
  const db = openKb(dataDir, parentId, childId);
  try {
    return (db.prepare("SELECT status FROM exam_plans WHERE id = ?").get(id) as { status: string }).status;
  } finally {
    db.close();
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

describe("ISSUE-185 计划行 id 给全值 + 前缀歧义防护", () => {
  it("① 考核列表给完整 id（同日同前缀的两场都能区分）", async () => {
    const text = toolText(await examList.execute("x", { childName: "珊珊" }));
    expect(text).toContain(EP_A);
    expect(text).toContain(EP_B);
    expect(text).not.toContain("行 id 取前 8 位");
    // 旧实现只回 `ep_17921`，两行在输出里不可区分 → 这条断言就是当时的现场
    expect(text).not.toMatch(/^- ep_17921｜/m);
  });

  it("② 只传公共前缀 → 歧义报错 + 列出候选，且不取消任何一行", async () => {
    await expect(examCancel.execute("x", { childName: "珊珊", id: EP_PREFIX })).rejects.toThrow(/前缀.*匹配到 2 行/);
    try {
      await examCancel.execute("x", { childName: "珊珊", id: EP_PREFIX });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(EP_A);
      expect(msg).toContain(EP_B);
    }
    expect(examStatus(EP_A)).toBe("pending");
    expect(examStatus(EP_B)).toBe("pending");
  });

  it("③ 传完整 id → 精确取消目标行，另一行不动", async () => {
    const text = toolText(await examCancel.execute("x", { childName: "珊珊", id: EP_A }));
    expect(text).toContain("字词考核");
    expect(examStatus(EP_A)).toBe("cancelled");
    expect(examStatus(EP_B)).toBe("pending");
  });

  it("④ 学习计划同款：列表给完整 id，更新按前缀撞多行被拒", async () => {
    const text = toolText(await planList.execute("x", { childName: "珊珊" }));
    expect(text).toContain(SP_A);
    expect(text).toContain(SP_B);
    expect(text).not.toContain("行 id 取前 8 位");
    await expect(
      planUpdate.execute("x", { childName: "珊珊", act: "setmode", id: SP_PREFIX, mode: "review" })
    ).rejects.toThrow(/前缀.*匹配到 2 行/);
    // 完整 id 照常可用
    const okText = toolText(await planUpdate.execute("x", { childName: "珊珊", act: "setmode", id: SP_B, mode: "review" }));
    expect(okText).toContain("复习");
  });

  it("⑤ 孩子侧同款：列表给完整 id，前缀撞多行被拒", async () => {
    // 另建两条孩子自请考核（creator=child），前缀同样只差尾部
    const CH_A = "ep_17921_cccccc";
    const CH_B = "ep_17921_dddddd";
    const db = openKb(dataDir, parentId, childId);
    try {
      const ins = db.prepare(
        `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,scope_json,start_at,due_at,status,created_at,updated_at)
         VALUES (?,?,?,?,'child','custom','{}',?,?,'pending',?,?)`
      );
      const now = `${DAY} 11:00:00`;
      ins.run(CH_A, parentId, childId, "自请考核A", `${DAY} 00:00:00`, `${DAY} 23:59:59`, now, now);
      ins.run(CH_B, parentId, childId, "自请考核B", `${DAY} 00:00:00`, `${DAY} 23:59:59`, now, now);
    } finally {
      db.close();
    }
    const kidDeps = { dataDir, parentId, childId };
    const kidList: any = createChildExamPlanListTool(kidDeps);
    const kidUpdate: any = createChildExamPlanUpdateTool(kidDeps);
    const text = toolText(await kidList.execute("x", { date: DAY }));
    expect(text).toContain(CH_A);
    expect(text).toContain(CH_B);
    await expect(kidUpdate.execute("x", { act: "delete", id: "ep_17921" })).rejects.toThrow(/前缀.*匹配到/);
    // 两条自请考核仍在
    const db2 = openKb(dataDir, parentId, childId);
    try {
      const n = (db2.prepare("SELECT COUNT(*) AS c FROM exam_plans WHERE creator='child' AND active=1").get() as { c: number }).c;
      expect(n).toBe(2);
    } finally {
      db2.close();
    }
  });
});
