/**
 * ISSUE-130 回归：家长端孩子详情「计划」tab 的多日三域聚合（collectPlanRange）。
 *
 * 覆盖四点：
 * ① 物化行按窗口逐日入桶（跨天窗口行多天出现，同 /plans/today 口径）；owner=creator 分组依据随行透传；
 * ② plan_recurrences 未来命中日**虚拟展开**（daily/weekly/起止界/exam 规则跳过/virtual 标记）；
 * ③ 当天已有同 recurrence_id 物化行 → 虚拟行让位（不重复）；
 * ④ days 越界夹取（0/负/超大 → 合法范围），from 决定起点。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { collectPlanRange } from "../server/src/db/plans-range";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue130-"));
const parentId = "parent-130";
const childId = "child-130";

const mainDb = openDb(dataDir);
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p130@test", new Date().toISOString(), new Date().toISOString());
mainDb
  .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(childId, parentId, "珊珊", new Date().toISOString(), new Date().toISOString());

const now = new Date().toISOString();
const p = (n: number) => String(n).padStart(2, "0");
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();
const dayN = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function kb() {
  return openKb(dataDir, parentId, childId);
}

// ① 物化行：study 逐日两行（今天/明天，owner=parent/child 各一）+ 一行跨今天到后天的窗口
function seedMaterialized(): void {
  const k = kb();
  try {
    k.prepare(
      `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,recurrence_id,
         start_at,due_at,status,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,'conversation','','',?,?,'pending','','',?,1,0,1,?,?)`
    ).run("s-parent", parentId, childId, "lunyu", "", "论语学而篇第一章", "new", "parent", dayStart(today), dayEnd(today), "required", now, now);
    k.prepare(
      `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,recurrence_id,
         start_at,due_at,status,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,'conversation','','',?,?,'pending','','',?,1,0,1,?,?)`
    ).run("s-child", parentId, childId, "lunyu", "", "自主朗读一篇", "new", "child", dayStart(dayN(1)), dayEnd(dayN(1)), "required", now, now);
    // 跨两天窗口（start=今天 00:00，due=后天 23:59：两天都应出现）
    k.prepare(
      `INSERT INTO life_plans (id,parent_id,child_id,title,creator,origin,carry_from,recurrence_id,start_at,due_at,status,result,done_at,
         task_type,count_in_rate,points,active,created_at,updated_at)
       VALUES (?,?,?,?,'child','conversation','','',?,?,'pending','','',?,1,0,1,?,?)`
    ).run("l-span", parentId, childId, "整理书桌", dayStart(today), dayEnd(dayN(2)), "optional", now, now);
  } finally {
    k.close();
  }
}
const dayStart = (d: string) => `${d} 00:00:00`;
const dayEnd = (d: string) => `${d} 23:59:59`;

// ②/③ 重复规则：daily 生活规则（parent）+ weekly 学习规则（child，命中明天）+ exam 规则（应跳过）
function seedRecurrences(): void {
  const k = kb();
  try {
    k.prepare(
      `INSERT INTO plan_recurrences (id,parent_id,child_id,plan_type,payload_json,rule,weekday,start_date,end_date,last_expanded_date,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,'','',1,?,?)`
    ).run(
      "r-daily",
      parentId,
      childId,
      "life",
      JSON.stringify({ title: "睡前刷牙", creator: "parent", task_type: "required", points: 0 }),
      "daily",
      null,
      today,
      now,
      now
    );
    const tomorrowDow = new Date(`${dayN(1)}T12:00:00`).getDay();
    k.prepare(
      `INSERT INTO plan_recurrences (id,parent_id,child_id,plan_type,payload_json,rule,weekday,start_date,end_date,last_expanded_date,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,'','',1,?,?)`
    ).run(
      "r-weekly",
      parentId,
      childId,
      "study",
      JSON.stringify({ title: "英语口语十分钟", course_name: "英语口语十分钟", topic_key: "english", mode: "new", creator: "child" }),
      "weekly",
      tomorrowDow,
      today,
      now,
      now
    );
    k.prepare(
      `INSERT INTO plan_recurrences (id,parent_id,child_id,plan_type,payload_json,rule,weekday,start_date,end_date,last_expanded_date,enabled,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,'','',1,?,?)`
    ).run(
      "r-exam",
      parentId,
      childId,
      "exam",
      JSON.stringify({ title: "不该展开的考核" }),
      "daily",
      null,
      today,
      now,
      now
    );
  } finally {
    k.close();
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

describe("ISSUE-130 collectPlanRange 多日三域聚合", () => {
  it("① 物化行按窗口逐日入桶；owner（creator）随行透传", () => {
    seedMaterialized();
    const r = collectPlanRange(dataDir, parentId, childId, today, 3);
    expect(r.from).toBe(today);
    expect(r.days.length).toBe(3);
    const d0 = r.days[0]!;
    const d1 = r.days[1]!;
    // 今天：study(parent) + 跨窗 life(child)
    expect(d0.items.map((i) => i.planId).sort()).toEqual(["l-span", "s-parent"]);
    const sp = d0.items.find((i) => i.planId === "s-parent")!;
    expect(sp.kind).toBe("study");
    expect(sp.owner).toBe("parent");
    expect(sp.title).toBe("论语学而篇第一章");
    const ls = d0.items.find((i) => i.planId === "l-span")!;
    expect(ls.owner).toBe("child");
    expect(ls.kind).toBe("life");
    // 明天：study(child) + 跨窗 life 继续
    expect(d1.items.map((i) => i.planId).sort()).toEqual(["l-span", "s-child"]);
    expect(d1.items.find((i) => i.planId === "s-child")!.owner).toBe("child");
  });

  it("② 重复规则未来命中日虚拟展开（daily/weekly 命中、exam 跳过、virtual 标记）", () => {
    seedRecurrences();
    const r = collectPlanRange(dataDir, parentId, childId, today, 3);
    const d1 = r.days[1]!;
    // daily 生活规则（parent）每天都应在
    const dailyLife = d1.items.filter((i) => i.planId === "virtual:r-daily");
    expect(dailyLife.length).toBe(1);
    expect(dailyLife[0]!.owner).toBe("parent");
    expect(dailyLife[0]!.virtual).toBe(true);
    expect(dailyLife[0]!.title).toBe("睡前刷牙");
    // weekly 学习规则的 weekday=明天的 day-of-week → 明天必命中；今天仅当与明天同 dow 才命中
    const weeklyToday = r.days[0]!.items.filter((i) => i.planId === "virtual:r-weekly");
    const weeklyTomorrow = d1.items.filter((i) => i.planId === "virtual:r-weekly");
    const tomorrowHit = new Date(`${dayN(1)}T12:00:00`).getDay() === new Date(`${today}T12:00:00`).getDay();
    expect(weeklyTomorrow.length).toBe(1);
    expect(weeklyToday.length).toBe(tomorrowHit ? 1 : 0);
    if (weeklyTomorrow.length) {
      expect(weeklyTomorrow[0]!.owner).toBe("child");
      expect(weeklyTomorrow[0]!.kind).toBe("study");
    }
    // exam 规则任何一天都不展开
    for (const d of r.days) {
      expect(d.items.some((i) => i.title === "不该展开的考核")).toBe(false);
    }
  });

  it("③ 当天已有同 recurrence_id 物化行 → 虚拟行让位", () => {
    const k = kb();
    try {
      // worker 已把 r-daily 物化成今天的生活计划行
      k.prepare(
        `INSERT INTO life_plans (id,parent_id,child_id,title,creator,origin,carry_from,recurrence_id,start_at,due_at,status,result,done_at,
           task_type,count_in_rate,points,active,created_at,updated_at)
         VALUES (?,?,?,?,'parent','recurrence','','r-daily',?,?,'pending','','','required',1,0,1,?,?)`
      ).run("l-materialized", parentId, childId, "睡前刷牙", dayStart(today), dayEnd(today), now, now);
    } finally {
      k.close();
    }
    const r = collectPlanRange(dataDir, parentId, childId, today, 3);
    const todayVirtual = r.days[0]!.items.filter((i) => i.planId === "virtual:r-daily");
    expect(todayVirtual.length).toBe(0); // 今天让位给真实行
    // 明天仍虚拟展开（worker 尚未物化）
    expect(r.days[1]!.items.some((i) => i.planId === "virtual:r-daily")).toBe(true);
    // 真实行今天在桶里且 virtual 未标记
    const mat = r.days[0]!.items.find((i) => i.planId === "l-materialized")!;
    expect(mat.virtual).toBeUndefined();
  });

  it("④ days 越界夹取（0/负/超大）+ from 偏移生效", () => {
    const zero = collectPlanRange(dataDir, parentId, childId, today, 0);
    expect(zero.days.length).toBe(14); // 0/NaN → 缺省 14
    const neg = collectPlanRange(dataDir, parentId, childId, today, -5);
    expect(neg.days.length).toBe(1); // 负数夹取到下限 1
    const big = collectPlanRange(dataDir, parentId, childId, dayN(7), 999);
    expect(big.days.length).toBe(31);
    expect(big.days[0]!.date).toBe(dayN(7));
    expect(big.from).toBe(dayN(7));
  });
});
