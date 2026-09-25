/**
 * ISSUE-149 回归（2026-09-25）：跨日期计划被提前 missed/顺延，且顺延行与已排期行同名重复。
 *
 * 生产事故（201，2026-09-25 06:26）：家长 09-24 通过对话排「2026-09-24学校作业」24~27 号，
 * 工具只能逐天落 4 行单日排期；25 日 06:26 stat tick 的 expireAndCarry 把 24 号行判 missed 并
 * 无条件复制 carry 行到 25 号——与已排好的 25 号行同名并存，且 24 号完成率 -10。
 *
 * 修复（三层）：
 * ① 创建侧：四个创建工具支持 `endDate` 跨日期行（start=首日 00:00:00 / due=末日 23:59:59）；
 * ② 顺延侧：expireAndCarry 目标日已有同身份 pending 行 → 只置 missed 不复制；
 * ③ 结算侧：computeGroupStats 跨日期行只在「完成日或到期日」进分子分母（单日行口径不变、cancelled 不进分母）。
 *
 * 每个用例组用独立孩子（独立 KB 文件），避免行/统计互相污染。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { createPlanDomainTools } from "../server/src/agent/parent-plans";
import { runPlanStat } from "../server/src/worker/plan-domain";
import type { WorkerTaskCtx } from "../server/src/worker/tasks";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue149-"));
const parentId = "parent-149";
const COURSE = "学校作业";

const mainDb = openDb(dataDir);
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p149@test", new Date().toISOString(), new Date().toISOString());

let pl = openParentLib(dataDir, parentId);
pl.prepare("INSERT INTO topics (name, topic_key, method, progress, rules_json) VALUES ('schoolwork', 'schoolwork', '', '', '{}')").run();
pl.prepare("INSERT INTO courses (topic, title, sort_order) VALUES ('schoolwork', ?, 1)").run(COURSE);
pl.close();

/** 每个用例组一个独立孩子（独立 KB 文件） */
let childSeq = 0;
function makeChild(): string {
  const childId = `child-149-${++childSeq}`;
  mainDb
    .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(childId, parentId, `孩子${childSeq}`, new Date().toISOString(), new Date().toISOString());
  openKb(dataDir, parentId, childId).close(); // 初始化 schema
  return childId;
}

const tools = createPlanDomainTools({ db: mainDb, dataDir, parentId });
const createStudy = tools.find((t) => t.name === "parent_study_plan_create")!;
const createLife = tools.find((t) => t.name === "parent_life_plan_create")!;

function makeCtx(childId: string, now: Date): WorkerTaskCtx {
  return { dataDir, mainDb, parentId, childId, auth: {}, schedulerConfig: {}, now, point: "" };
}

/** 生产事故同款时刻：06:26 首个 stat tick（Mac mini 唤醒后第一跑） */
const ctx0925 = (c: string) => makeCtx(c, new Date(2026, 8, 25, 6, 26, 0));
const ctx0926 = (c: string) => makeCtx(c, new Date(2026, 8, 26, 6, 26, 0));
const ctx0928 = (c: string) => makeCtx(c, new Date(2026, 8, 28, 6, 26, 0));

function seedStudyRow(
  childId: string,
  opts: { start: string; due: string; course?: string; status?: string; creator?: string }
): string {
  const kb = openKb(dataDir, parentId, childId);
  try {
    const id = crypto.randomUUID();
    kb.prepare(
      `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,recurrence_id,
         start_at,due_at,status,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
       VALUES (?,?,?,'schoolwork','',?,?,'parent','conversation','','',?,?,?,'','','required',1,0,1,?,?)`
    ).run(
      id, parentId, childId, opts.course ?? COURSE, opts.creator ?? "new",
      opts.start, opts.due, opts.status ?? "pending",
      new Date().toISOString(), new Date().toISOString()
    );
    return id;
  } finally {
    kb.close();
  }
}

function seedLifeRow(childId: string, opts: { start: string; due: string; title: string }): string {
  const kb = openKb(dataDir, parentId, childId);
  try {
    const id = crypto.randomUUID();
    kb.prepare(
      `INSERT INTO life_plans (id,parent_id,child_id,title,creator,origin,carry_from,recurrence_id,start_at,due_at,status,result,done_at,
         task_type,count_in_rate,points,active,created_at,updated_at)
       VALUES (?,?,?,?,?,'conversation','','',?,?,'pending','','', 'required',1,0,1,?,?)`
    ).run(id, parentId, childId, opts.title, "parent", opts.start, opts.due, new Date().toISOString(), new Date().toISOString());
    return id;
  } finally {
    kb.close();
  }
}

function planRows(childId: string): Array<{ id: string; course_name: string; start_at: string; due_at: string; status: string; origin: string; carry_from: string }> {
  const kb = openKb(dataDir, parentId, childId);
  try {
    return kb
      .prepare("SELECT id, course_name, start_at, due_at, status, origin, carry_from FROM study_plans ORDER BY created_at")
      .all() as never;
  } finally {
    kb.close();
  }
}

function lifeCount(childId: string, title: string): number {
  const kb = openKb(dataDir, parentId, childId);
  try {
    return (kb.prepare("SELECT COUNT(*) AS n FROM life_plans WHERE title = ?").get(title) as { n: number }).n;
  } finally {
    kb.close();
  }
}

function statOf(childId: string, date: string, source = "todo", owner = "parent"):
  | { total: number; done: number; missed: number; rate: number }
  | undefined {
  const kb = openKb(dataDir, parentId, childId);
  try {
    return kb
      .prepare(
        "SELECT required_total AS total, required_done AS done, missed_count AS missed, rate FROM reward_daily_stats WHERE child_id = ? AND date = ? AND source = ? AND owner = ?"
      )
      .get(childId, date, source, owner) as { total: number; done: number; missed: number; rate: number } | undefined;
  } finally {
    kb.close();
  }
}

/** 模拟孩子在某天学了某课（daily 学习记录，标题=课程名） */
function learnOn(childId: string, date: string, title = COURSE): void {
  const kb = openKb(dataDir, parentId, childId);
  try {
    kb.prepare("INSERT INTO daily_entries (date, block, title, raw) VALUES (?, '学习', ?, '')").run(date, title);
  } finally {
    kb.close();
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

describe("ISSUE-149 ① 创建侧：endDate 跨日期行", () => {
  const c = makeChild();

  it("parent_study_plan_create + endDate → 一条行，窗口=首日 00:00:00 ~ 末日 23:59:59", async () => {
    await createStudy.execute("x", {
      childName: "孩子1",
      days: [{ date: "2026-09-24", content: [COURSE], endDate: "2026-09-27" }],
    });
    const rows = planRows(c);
    expect(rows.length).toBe(1);
    expect(rows[0]!.start_at).toBe("2026-09-24 00:00:00");
    expect(rows[0]!.due_at).toBe("2026-09-27 23:59:59");
    expect(rows[0]!.origin).toBe("conversation");
  });

  it("endDate + 多项 content → 拒绝（跨日期一次只能一项）", async () => {
    await expect(
      createStudy.execute("x", {
        childName: "孩子1",
        days: [{ date: "2026-09-24", content: [COURSE, "数学作业"], endDate: "2026-09-27" }],
      })
    ).rejects.toThrow(/只能排一项/);
  });

  it("endDate 早于 date → 拒绝", async () => {
    await expect(
      createStudy.execute("x", {
        childName: "孩子1",
        days: [{ date: "2026-09-24", content: [COURSE], endDate: "2026-09-23" }],
      })
    ).rejects.toThrow(/不能早于/);
  });

  it("parent_life_plan_create + endDate（带 time）→ 截止=结束日 time；不带 time=23:59:59", async () => {
    await createLife.execute("x", {
      childName: "孩子1",
      days: [
        { date: "2026-09-24", title: "完成手抄报", endDate: "2026-09-27", time: "20:30" },
        { date: "2026-10-01", title: "整理书架", endDate: "2026-10-03" },
      ],
    });
    const kb = openKb(dataDir, parentId, c);
    try {
      const rows = kb
        .prepare("SELECT title, start_at, due_at FROM life_plans WHERE creator = 'parent' ORDER BY start_at")
        .all() as Array<{ title: string; start_at: string; due_at: string }>;
      expect(rows.length).toBe(2);
      expect(rows[0]!.title).toBe("完成手抄报");
      expect(rows[0]!.due_at).toBe("2026-09-27 20:30:00");
      expect(rows[1]!.due_at).toBe("2026-10-03 23:59:59");
    } finally {
      kb.close();
    }
  });
});

describe("ISSUE-149 ② worker 判定：跨日期行中间日不判 missed、结束日后才顺延", () => {
  it("生产事故场景：24~27 的行在 25 日 06:26 tick 保持 pending，不 missed、不复制", () => {
    const c = makeChild();
    const id = seedStudyRow(c, { start: "2026-09-24 00:00:00", due: "2026-09-27 23:59:59" });
    const out = runPlanStat(ctx0925(c));
    const rows = planRows(c);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.status).toBe("pending");
    expect(out.missed).toBe(0);
    expect(out.carried).toBe(0);
  });

  it("结束日过后（28 日 tick）→ missed + carry 复制到当天", () => {
    const c = makeChild();
    seedStudyRow(c, { start: "2026-09-24 00:00:00", due: "2026-09-27 23:59:59" });
    runPlanStat(ctx0925(c)); // 中间日先过一拍（幂等，顺带验证）
    runPlanStat(ctx0928(c));
    const rows = planRows(c);
    expect(rows.length).toBe(2);
    const orig = rows.find((r) => r.origin !== "carry")!;
    const carry = rows.find((r) => r.origin === "carry")!;
    expect(orig.status).toBe("missed");
    expect(carry.carry_from).toBe(orig.id);
    expect(carry.start_at).toBe("2026-09-28 00:00:00");
    expect(carry.due_at).toBe("2026-09-28 23:59:59");
    expect(carry.status).toBe("pending");
  });

  it("窗口内完成即 done（25 日学 → 25 日 tick 判 done，不 missed 不顺延）", () => {
    const c = makeChild();
    const id = seedStudyRow(c, { start: "2026-09-24 00:00:00", due: "2026-09-27 23:59:59" });
    learnOn(c, "2026-09-25");
    runPlanStat(ctx0925(c));
    const rows = planRows(c);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.status).toBe("done");
  });
});

describe("ISSUE-149 ③ 结算归属：跨日期行只在完成日/到期日进分子分母", () => {
  it("25 日 tick 结算 24 日：跨日期行不进 24 日分母（生产事故里此处误扣 -10）", () => {
    const c = makeChild();
    seedStudyRow(c, { start: "2026-09-24 00:00:00", due: "2026-09-27 23:59:59" });
    runPlanStat(ctx0925(c));
    expect(statOf(c, "2026-09-24")).toBeUndefined();
    expect(statOf(c, "2026-09-25")).toBeUndefined(); // 实时分母也不含进行中的跨日期行
  });

  it("25 日完成 → 26 日 tick 结算 25 日：done 只计入完成日", () => {
    const c = makeChild();
    seedStudyRow(c, { start: "2026-09-24 00:00:00", due: "2026-09-27 23:59:59" });
    learnOn(c, "2026-09-25");
    runPlanStat(ctx0926(c));
    const s25 = statOf(c, "2026-09-25")!;
    expect(s25.total).toBe(1);
    expect(s25.done).toBe(1);
    expect(s25.rate).toBeCloseTo(1, 6);
    expect(statOf(c, "2026-09-26")).toBeUndefined(); // 已完成的跨日期行不再进后续天的分母
  });

  it("从未完成 → 只有到期日（27 日）计 missed；24/25 日全空", () => {
    const c = makeChild();
    seedStudyRow(c, { start: "2026-09-24 00:00:00", due: "2026-09-27 23:59:59" });
    runPlanStat(ctx0925(c));
    runPlanStat(ctx0926(c));
    expect(statOf(c, "2026-09-24")).toBeUndefined();
    expect(statOf(c, "2026-09-25")).toBeUndefined();
    runPlanStat(ctx0928(c)); // 28 日 tick：expireAndCarry 置 missed 后结算 27 日
    const s27 = statOf(c, "2026-09-27")!;
    expect(s27.total).toBe(1);
    expect(s27.missed).toBe(1);
    expect(s27.done).toBe(0);
  });

  it("单日行行为不变：到期次日照旧 missed + carry，归属日照旧计入", () => {
    const c = makeChild();
    seedStudyRow(c, { start: "2026-09-24 00:00:00", due: "2026-09-24 23:59:59" });
    const out = runPlanStat(ctx0925(c));
    expect(out.missed).toBe(1);
    expect(out.carried).toBe(1);
    const s24 = statOf(c, "2026-09-24")!;
    expect(s24.total).toBe(1);
    expect(s24.missed).toBe(1);
  });

  it("cancelled 行不计入分母（与「取消 = 不计分母」的路由口径对齐）", () => {
    const c = makeChild();
    seedStudyRow(c, { start: "2026-09-24 00:00:00", due: "2026-09-24 23:59:59", status: "cancelled" });
    runPlanStat(ctx0925(c));
    expect(statOf(c, "2026-09-24")).toBeUndefined();
  });
});

describe("ISSUE-149 顺延防重：目标日已有同身份 pending → 只 missed 不复制", () => {
  it("study：同 creator+topic+course+mode 的 pending 行已覆盖目标日 → carried=0、无新增行", () => {
    const c = makeChild();
    const expired = seedStudyRow(c, { start: "2026-09-24 00:00:00", due: "2026-09-24 23:59:59" });
    const scheduled = seedStudyRow(c, { start: "2026-09-25 00:00:00", due: "2026-09-25 23:59:59" });
    const out = runPlanStat(ctx0925(c));
    expect(out.missed).toBe(1);
    expect(out.carried).toBe(0);
    const rows = planRows(c);
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.id === expired)!.status).toBe("missed");
    expect(rows.find((r) => r.id === scheduled)!.status).toBe("pending");
  });

  it("life：同 creator+title 的 pending 行已覆盖目标日 → 不复制", () => {
    const c = makeChild();
    seedLifeRow(c, { start: "2026-09-24 00:00:00", due: "2026-09-24 23:59:59", title: "整理书包" });
    seedLifeRow(c, { start: "2026-09-25 00:00:00", due: "2026-09-25 23:59:59", title: "整理书包" });
    const out = runPlanStat(ctx0925(c));
    expect(out.missed).toBe(1);
    expect(out.carried).toBe(0);
    expect(lifeCount(c, "整理书包")).toBe(2);
  });

  it("身份不同（不同课程）不误伤：照常复制", () => {
    const c = makeChild();
    seedStudyRow(c, { start: "2026-09-24 00:00:00", due: "2026-09-24 23:59:59", course: "语文作业" });
    seedStudyRow(c, { start: "2026-09-25 00:00:00", due: "2026-09-25 23:59:59", course: "数学作业" });
    const out = runPlanStat(ctx0925(c));
    expect(out.missed).toBe(1);
    expect(out.carried).toBe(1); // 语文的顺延照常落，数学是另一件事
    const rows = planRows(c);
    expect(rows.length).toBe(3);
  });
});
