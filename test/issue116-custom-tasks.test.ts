/**
 * ISSUE-116 回归（2026-09-19）：自定义定时任务——自然语言指令到点由服务端无头 agent 执行。
 *
 * 守住：
 * ① scheduler_tasks.instruction 列迁移（新建库 + 老库幂等补列）；
 * ② 触发判定 isCustomTaskDue（daily/weekly/once/interval 四频率 + last_fired_at 当日幂等 + 空指令不跑）；
 * ③ createRemindersTool 防重（source 标记滚动替换 + text+time+frequency 精确去重 + 播报链路兼容）；
 * ④ executeCustomTask / runCustomTasksTick 全链路（注入执行轮，免 LLM）：task_runs 记录、失败不丢、
 *    触发占位（同日不重跑）、异步不阻塞。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../server/src/db";
import { createRemindersTool } from "../server/src/worker/custom-task-tools";
import { executeCustomTask, isCustomTaskDue, runCustomTasksTick, type CustomTaskRow } from "../server/src/worker/custom-tasks";
import { takeDueReminders } from "../server/src/db/task-runs";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue116-"));
const parentId = "parent-116";
const childId = "child-116";

const mainDb = openDb(dataDir);
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p116@test", new Date().toISOString(), new Date().toISOString());
mainDb
  .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(childId, parentId, "珊珊", new Date().toISOString(), new Date().toISOString());

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

function seedCustomTask(overrides: Partial<CustomTaskRow> = {}): CustomTaskRow {
  const base: CustomTaskRow = {
    id: `task_${Math.random().toString(36).slice(2, 8)}`,
    parent_id: parentId,
    name: "每日天气播报",
    instruction: "查今天的天气，创建提醒任务：未来 7 天每天 07:00 播报当天天气",
    time: "06:00",
    frequency: "daily",
    weekday: null,
    interval_minutes: null,
    fire_at: null,
    last_fired_at: null,
    expired: 0,
    ...overrides,
  };
  mainDb
    .prepare(
      `INSERT INTO scheduler_tasks (id, parent_id, name, type, time, enabled, owner, frequency, instruction, weekday, interval_minutes, fire_at, last_fired_at, expired, created_at, updated_at)
       VALUES (?, ?, ?, 'custom', ?, 1, 'parent', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      base.id, parentId, base.name, base.time, base.frequency, base.instruction,
      base.weekday, base.interval_minutes, base.fire_at, base.last_fired_at, base.expired,
      new Date().toISOString(), new Date().toISOString()
    );
  mainDb
    .prepare("INSERT INTO scheduler_task_assignments (task_id, child_id, enabled, created_at) VALUES (?, ?, 1, ?)")
    .run(base.id, childId, new Date().toISOString());
  return base;
}

function toolText(r: { content: Array<{ type: string; text: string }> }): string {
  return r.content.map((c) => (c as { text: string }).text).join("");
}

describe("ISSUE-116 instruction 列迁移", () => {
  it("新建库：CREATE TABLE 带 instruction 列", () => {
    const cols = (mainDb.prepare("PRAGMA table_info(scheduler_tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("instruction");
  });

  it("老库：缺 instruction 列时 openDb 幂等补列", () => {
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue116-old-"));
    try {
      const raw = new DatabaseSync(path.join(oldDir, "server.sqlite"));
      // 模拟 ISSUE-116 之前的 scheduler_tasks（缺 instruction，但保留建索引所需列）
      raw.exec(`
        CREATE TABLE scheduler_tasks (
          id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
          time TEXT NOT NULL, extra_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
          owner TEXT NOT NULL DEFAULT 'parent', frequency TEXT NOT NULL DEFAULT 'daily', reminder_text TEXT,
          weekday INTEGER, interval_minutes INTEGER, voice INTEGER NOT NULL DEFAULT 1, fire_at TEXT,
          last_fired_at TEXT, expired INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
      `);
      raw.close();
      const db2 = openDb(oldDir);
      try {
        const cols = (db2.prepare("PRAGMA table_info(scheduler_tasks)").all() as Array<{ name: string }>).map((c) => c.name);
        expect(cols).toContain("instruction");
      } finally {
        db2.close();
      }
    } finally {
      try {
        fs.rmSync(oldDir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }
  });
});

describe("ISSUE-116 触发判定 isCustomTaskDue", () => {
  const base: CustomTaskRow = {
    id: "t1", parent_id: parentId, name: "n",
    instruction: "查天气",
    time: "06:00", frequency: "daily", weekday: null, interval_minutes: null,
    fire_at: null, last_fired_at: null, expired: 0,
  };

  it("daily：到点未跑 → 触发；跑过（同日）→ 不触发；未到点 → 不触发", () => {
    const at = new Date(2026, 8, 19, 6, 30); // 06:30
    expect(isCustomTaskDue(base, at)).toBe(true);
    expect(isCustomTaskDue({ ...base, last_fired_at: at.toISOString() }, at)).toBe(false);
    expect(isCustomTaskDue(base, new Date(2026, 8, 19, 5, 59))).toBe(false);
    // 次日恢复触发
    expect(isCustomTaskDue({ ...base, last_fired_at: at.toISOString() }, new Date(2026, 8, 20, 6, 30))).toBe(true);
  });

  it("weekly：周几不匹配 → 不触发", () => {
    const sat = new Date(2026, 8, 19); // 2026-09-19 是周六
    expect(sat.getDay()).toBe(6);
    expect(isCustomTaskDue({ ...base, frequency: "weekly", weekday: 6 }, new Date(2026, 8, 19, 7, 0))).toBe(true);
    expect(isCustomTaskDue({ ...base, frequency: "weekly", weekday: 1 }, new Date(2026, 8, 19, 7, 0))).toBe(false);
  });

  it("once：到点未过期 → 触发；已过期 → 不触发", () => {
    const now = new Date(2026, 8, 19, 12, 0);
    const fa = new Date(2026, 8, 19, 10, 0).toISOString();
    expect(isCustomTaskDue({ ...base, frequency: "once", fire_at: fa }, now)).toBe(true);
    expect(isCustomTaskDue({ ...base, frequency: "once", fire_at: fa, expired: 1 }, now)).toBe(false);
  });

  it("interval：距上次 ≥ 间隔 → 触发", () => {
    const now = new Date(2026, 8, 19, 12, 0);
    expect(isCustomTaskDue({ ...base, frequency: "interval", interval_minutes: 30, last_fired_at: new Date(2026, 8, 19, 11, 29).toISOString() }, now)).toBe(true);
    expect(isCustomTaskDue({ ...base, frequency: "interval", interval_minutes: 30, last_fired_at: new Date(2026, 8, 19, 11, 45).toISOString() }, now)).toBe(false);
  });

  it("指令为空 → 永不触发", () => {
    expect(isCustomTaskDue({ ...base, instruction: "  " }, new Date(2026, 8, 19, 12, 0))).toBe(false);
  });
});

describe("ISSUE-116 createRemindersTool 防重与播报兼容", () => {
  const taskId = "task_src_1";
  const tool = createRemindersTool(mainDb, parentId, childId, taskId);

  it("批量创建 7 条（未来 7 天各播一次 → once+fireAt）→ source 标记、分配孩子、到点播报链路", async () => {
    // 按工具引导的真实建模：「未来 7 天每天 07:00 各播一次」= 7 条 once（各自 fireAt），而非 daily（会每天全量重复播）
    const reminders = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(2026, 8, 19 + i);
      d.setHours(7, 0, 0, 0);
      return { text: `9月${19 + i}日天气：晴 20~28℃`, time: "07:00", frequency: "once", fireAt: d.toISOString() };
    });
    const r = toolText(await tool.execute("x", { reminders, replace: false }));
    expect(r).toContain("新建 7 条");
    const cnt = mainDb
      .prepare(`SELECT COUNT(*) AS c FROM scheduler_tasks WHERE parent_id = ? AND type = 'reminder' AND extra_json LIKE ?`)
      .get(parentId, `%"source_task":"${taskId}"%`) as { c: number };
    expect(cnt.c).toBe(7);
    // 播报链路兼容：09-19 07:01 只有「今天」这条到期（未来几天的一次性提醒不会提前播）
    const later = new Date(2026, 8, 19, 7, 1);
    const due = takeDueReminders(mainDb, parentId, childId, later);
    expect(due.length).toBe(1);
    expect(due[0]?.text).toContain("9月19日天气");
  });

  it("滚动替换：再次运行（replace 默认 true）→ 本源未播报旧提醒停用 + 新批创建", async () => {
    const reminders = [
      { text: `9月20日天气：多云 18~26℃`, time: "07:00" },
      { text: `9月21日天气：小雨 17~24℃`, time: "07:00" },
    ];
    const r = toolText(await tool.execute("x", { reminders })); // replace 缺省 = true
    expect(r).toContain("替换本源旧提醒 6 条");
    expect(r).toContain("新建 2 条");
    // 旧的 9月19日（未播报）已停用；新批启用
    const enabledTexts = mainDb
      .prepare(
        `SELECT t.reminder_text AS text FROM scheduler_tasks t
         WHERE t.parent_id = ? AND t.type = 'reminder' AND t.enabled = 1 AND t.expired = 0 AND t.extra_json LIKE ?`
      )
      .all(parentId, `%"source_task":"${taskId}"%`) as Array<{ text: string }>;
    expect(enabledTexts.map((x) => x.text)).toEqual(["9月20日天气：多云 18~26℃", "9月21日天气：小雨 17~24℃"]);
  });

  it("精确去重：同 text+time+frequency 已存在 → 跳过", async () => {
    const r = toolText(await tool.execute("x", { reminders: [{ text: "9月20日天气：多云 18~26℃", time: "07:00" }], replace: false }));
    expect(r).toContain("新建 0 条");
    expect(r).toContain("已存在");
  });
});

describe("ISSUE-116 执行链路（注入执行轮）", () => {
  it("executeCustomTask：成功 → task_runs ok + agent 摘要；失败 → task_runs error（不抛错）", async () => {
    const okTask = seedCustomTask();
    await executeCustomTask({ dataDir, db: mainDb }, parentId, childId, okTask, new Date(2026, 8, 19, 6, 0), {
      round: async (prompt) => {
        expect(prompt).toContain("查今天的天气");
        expect(prompt).toContain("珊珊");
        return "已创建未来 7 天的天气播报提醒。";
      },
    });
    const okRun = mainDb
      .prepare("SELECT status, message FROM task_runs WHERE task_id = ? ORDER BY finished_at DESC LIMIT 1")
      .get(okTask.id) as { status: string; message: string };
    expect(okRun.status).toBe("ok");
    expect(okRun.message).toContain("7 天的天气播报");

    const badTask = seedCustomTask({ name: "会失败的任务" });
    await executeCustomTask({ dataDir, db: mainDb }, parentId, childId, badTask, new Date(2026, 8, 19, 7, 0), {
      round: async () => {
        throw new Error("天气服务不可用");
      },
    });
    const badRun = mainDb
      .prepare("SELECT status, message FROM task_runs WHERE task_id = ? ORDER BY finished_at DESC LIMIT 1")
      .get(badTask.id) as { status: string; message: string };
    expect(badRun.status).toBe("error");
    expect(badRun.message).toContain("天气服务不可用");
  });

  it("runCustomTasksTick：到点触发占位（同 tick 再跑不重复）+ 执行异步落 task_runs", async () => {
    // 隔离：禁用此前用例遗留的 custom 任务，保证「到点任务」计数唯一
    mainDb.prepare("UPDATE scheduler_tasks SET enabled = 0 WHERE parent_id = ? AND type = 'custom'").run(parentId);
    const t = seedCustomTask({ time: "06:00" });
    const now = new Date(2026, 8, 19, 6, 10);
    const runs: Array<Promise<void>> = [];
    const fired = await runCustomTasksTick({ dataDir, db: mainDb }, now, {
      exec: async (...args) => {
        runs.push(executeCustomTask(...(args as Parameters<typeof executeCustomTask>)));
      },
    });
    expect(fired).toBe(1);
    // 占位：同日再 tick 不重复触发
    const fired2 = await runCustomTasksTick({ dataDir, db: mainDb }, new Date(2026, 8, 19, 6, 20), {
      exec: async () => undefined,
    });
    expect(fired2).toBe(0);
    const row = mainDb.prepare("SELECT last_fired_at FROM scheduler_tasks WHERE id = ?").get(t.id) as { last_fired_at: string };
    expect(row.last_fired_at).toBeTruthy();
    // 等异步执行完成 → task_runs 有记录
    await Promise.all(runs);
    const run = mainDb.prepare("SELECT COUNT(*) AS c FROM task_runs WHERE task_id = ?").get(t.id) as { c: number };
    expect(run.c).toBe(1);
  });

  it("未到点 / 未分配孩子 → 不触发", async () => {
    seedCustomTask({ time: "23:00" }); // 现在 06:10 → 未到点
    const noAssign = seedCustomTask({ time: "06:00" });
    mainDb.prepare("DELETE FROM scheduler_task_assignments WHERE task_id = ?").run(noAssign.id);
    const fired = await runCustomTasksTick({ dataDir, db: mainDb }, new Date(2026, 8, 19, 6, 10), {
      exec: async () => undefined,
    });
    expect(fired).toBe(0);
  });
});
