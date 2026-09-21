/**
 * ISSUE-121 回归（2026-09-21）：自定义考核取名 + 同日多场。
 *
 * 拍板落地：
 * ① 考核要有名字——parent_exam_plan_create 加 name 参数，落库到 exam_plans.title（不再硬编码「自定义考核」）；
 * ② 同日多场——去重守卫从「同日一条」收窄为「同日同名」（与孩子自请 child_exam_plan_create 的同日同名语义对齐）；
 *    不同名的未考计划同天并存，孩子端考核页按列表展示（todayOpen.map，无单条假设）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { getCourseUuid, getOrCreateKnowledgePoint, saveQuestion, replaceCourseContent } from "../server/src/db/assess-content";
import { createPlanDomainTools } from "../server/src/agent/parent-plans";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue121-"));
const parentId = "parent-121";
const childId = "child-121";
const COURSE = "论语为政篇第一章";

const mainDb = openDb(dataDir);
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p121@test", new Date().toISOString(), new Date().toISOString());
mainDb
  .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(childId, parentId, "珊珊", new Date().toISOString(), new Date().toISOString());

function seedContent(): void {
  let pl = openParentLib(dataDir, parentId);
  pl.prepare("INSERT INTO topics (name, topic_key, method, progress, rules_json) VALUES ('lunyu', 'lunyu', '', '', '{}')").run();
  pl.prepare("INSERT INTO courses (topic, title, sort_order) VALUES ('lunyu', ?, 1)").run(COURSE);
  pl.close();
  pl = openParentLib(dataDir, parentId); // 重开触发 uuid 回填
  const uuid = getCourseUuid(pl, "lunyu", COURSE);
  if (!uuid) throw new Error("seed 失败：course uuid 未生成");
  const kp = getOrCreateKnowledgePoint(pl, uuid, "背诵", "背诵原文");
  const qid = saveQuestion(pl, { stem: "背诵本章原文", answer: "为政以德，譬如北辰，居其所而众星共之", pointMax: 10 });
  replaceCourseContent(pl, uuid, [{ knowledgePointId: kp.id, overview: "", questionIds: [qid] }]);
  pl.close();
  const kb = openKb(dataDir, parentId, childId);
  try {
    kb.prepare("INSERT INTO courses (topic, topic_key, title) VALUES ('lunyu', 'lunyu', ?)").run(COURSE);
  } finally {
    kb.close();
  }
}

function toolText(r: { content: Array<{ type: string; text: string }> }): string {
  return r.content.map((c) => (c as { text: string }).text).join("");
}

const tools = createPlanDomainTools({ db: mainDb, dataDir, parentId });
const createExam = tools.find((t) => t.name === "parent_exam_plan_create")!;
const DAY = "2026-09-25";

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

describe("ISSUE-121 自定义考核取名 + 同日多场", () => {
  it("① 带 name 创建 → 落库 exam_plans.title（不再硬编码「自定义考核」）", async () => {
    seedContent();
    const r = toolText(
      await createExam.execute("x", {
        childName: "珊珊",
        scheduledAt: DAY,
        courses: [COURSE],
        name: "语文背诵考核",
      })
    );
    expect(r).toContain("语文背诵考核");
    const kb = openKb(dataDir, parentId, childId);
    try {
      const row = kb
        .prepare("SELECT title, status FROM exam_plans WHERE kind='custom' AND creator='parent' AND substr(start_at,1,10)=?")
        .get(DAY) as { title: string; status: string };
      expect(row.title).toBe("语文背诵考核");
      expect(row.status).toBe("pending");
    } finally {
      kb.close();
    }
  });

  it("② 同日同名 → 跳过（同名去重），不新建", async () => {
    const before = pendingCount(DAY);
    const r = toolText(
      await createExam.execute("x", { childName: "珊珊", scheduledAt: DAY, courses: [COURSE], name: "语文背诵考核" })
    );
    expect(r).toContain("同名");
    expect(pendingCount(DAY)).toBe(before);
  });

  it("③ 同日不同名 → 并存（一天多场）", async () => {
    const r = toolText(
      await createExam.execute("x", { childName: "珊珊", scheduledAt: DAY, courses: [COURSE], name: "数学口算周测" })
    );
    expect(r).toContain("数学口算周测");
    const kb = openKb(dataDir, parentId, childId);
    try {
      const titles = kb
        .prepare("SELECT title FROM exam_plans WHERE kind='custom' AND creator='parent' AND status='pending' AND substr(start_at,1,10)=? ORDER BY created_at")
        .all(DAY) as Array<{ title: string }>;
      expect(titles.map((t) => t.title)).toEqual(["语文背诵考核", "数学口算周测"]);
    } finally {
      kb.close();
    }
  });

  it("④ 不带 name → 缺省「自定义考核」；与具名考核互不干扰", async () => {
    const r = toolText(await createExam.execute("x", { childName: "珊珊", scheduledAt: DAY, courses: [COURSE] }));
    expect(r).toContain("自定义考核");
    const r2 = toolText(
      await createExam.execute("x", { childName: "珊珊", scheduledAt: DAY, courses: [COURSE], name: "自定义考核" })
    );
    expect(r2).toContain("同名");
    expect(pendingCount(DAY)).toBe(3);
  });
});

function pendingCount(day: string): number {
  const kb = openKb(dataDir, parentId, childId);
  try {
    return (kb
      .prepare("SELECT COUNT(*) AS c FROM exam_plans WHERE kind='custom' AND creator='parent' AND status='pending' AND substr(start_at,1,10)=?")
      .get(day) as { c: number }).c;
  } finally {
    kb.close();
  }
}
