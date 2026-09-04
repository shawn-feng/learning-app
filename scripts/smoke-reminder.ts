import { DatabaseSync } from "node:sqlite";
import { createReminderTask, takeDueReminders, listChildReminders, type ReminderInput } from "../server/src/db/task-runs";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE scheduler_tasks (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      time TEXT NOT NULL,
      extra_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      owner TEXT NOT NULL DEFAULT 'parent',
      frequency TEXT NOT NULL DEFAULT 'daily',
      reminder_text TEXT,
      weekday INTEGER,
      interval_minutes INTEGER,
      voice INTEGER NOT NULL DEFAULT 1,
      fire_at TEXT,
      last_fired_at TEXT,
      expired INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE scheduler_task_assignments (
      task_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, child_id)
    );
  `);
  return db;
}

const PID = "p1";
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ FAIL: " + name); }
}

// 每个 case 用独立的 (db, childId)，杜绝跨 case 任务串扰 / 时钟日期边界问题
function caseCtx(tag: string) {
  const db = makeDb();
  const CID = `c_${tag}`;
  const base = (over: Partial<ReminderInput>): ReminderInput => ({
    parentId: PID, childId: CID, name: "t", text: "提醒", time: "09:00",
    frequency: "daily", voice: true, ...over,
  });
  return { db, CID, base };
}

console.log("[1] daily: 当天首次到期，同日二次不再触发");
{
  const { db, CID, base } = caseCtx("1");
  const id = createReminderTask(db, base({ name: "喝水", frequency: "daily", time: "09:00" }));
  const now = new Date(Date.now() + 60_000);
  const d1 = takeDueReminders(db, PID, CID, now);
  check("daily 首次到期返回 1 条", d1.length === 1 && d1[0].text === "提醒");
  const d2 = takeDueReminders(db, PID, CID, now);
  check("daily 同日二次不再触发", d2.length === 0);
  const list = listChildReminders(db, PID, CID);
  check("list 含 owner=child", list.find((r) => r.id === id)?.owner === "child");
}

console.log("[2] weekly: 仅匹配 weekday 当天");
{
  const { db, CID, base } = caseCtx("2");
  const fri = 5;
  const id = createReminderTask(db, base({ frequency: "weekly", weekday: fri, time: "09:00" }));
  const today = new Date();
  const diff = (fri - today.getDay() + 7) % 7;
  const asFriday = new Date(today);
  asFriday.setDate(today.getDate() + diff);
  asFriday.setHours(10, 0, 0, 0);
  const ok = takeDueReminders(db, PID, CID, asFriday);
  check("weekly 周五到期", ok.some((r) => r.id === id));
  const asThu = new Date(asFriday); asThu.setDate(asFriday.getDate() - 1);
  const no = takeDueReminders(db, PID, CID, asThu);
  check("weekly 周四不触发", !no.some((r) => r.id === id));
}

console.log("[3] interval: 首次 created+31min 才触发（created 时刻不立即触发）");
{
  const { db, CID, base } = caseCtx("3");
  const id = createReminderTask(db, base({ frequency: "interval", intervalMinutes: 30, time: "00:00" }));
  const row3 = (db.prepare("SELECT last_fired_at FROM scheduler_tasks WHERE id=?").get(id) as any);
  check("interval 创建时 last_fired_at 已置为创建时刻", row3.last_fired_at != null);
  const now0 = new Date();
  const d0 = takeDueReminders(db, PID, CID, now0);
  check("interval 刚创建不触发", d0.length === 0);
  const later = new Date(Date.now() + 31 * 60_000);
  const d1 = takeDueReminders(db, PID, CID, later);
  check("interval +31min 触发", d1.some((r) => r.id === id));
  const d2 = takeDueReminders(db, PID, CID, new Date(later.getTime() + 1_000));
  check("interval 间隔内不重复", d2.length === 0);
}

console.log("[4] once: fireAt 过期触发一次后置 expired");
{
  const { db, CID, base } = caseCtx("4");
  const past = new Date(Date.now() - 60_000).toISOString();
  const id = createReminderTask(db, base({ frequency: "once", fireAt: past, time: "00:00" }));
  const now = new Date();
  const d1 = takeDueReminders(db, PID, CID, now);
  check("once 过去时间触发", d1.some((r) => r.id === id));
  const d2 = takeDueReminders(db, PID, CID, now);
  check("once 触发后 expired 不再触发", d2.length === 0);
  const row = (db.prepare("SELECT expired FROM scheduler_tasks WHERE id=?").get(id) as any);
  check("once expired=1", row.expired === 1);
}

console.log("[5] voice=false → due.voice=false（仅响铃）");
{
  const { db, CID, base } = caseCtx("5");
  const id = createReminderTask(db, base({ frequency: "daily", time: "09:00", voice: false }));
  const now = new Date(); now.setHours(23, 0, 0, 0);
  const d = takeDueReminders(db, PID, CID, now);
  check("voice=false 下发 voice=false", d.find((r) => r.id === id)?.voice === false);
}

console.log("[6] disabled 任务不触发");
{
  const { db, CID, base } = caseCtx("6");
  const id = createReminderTask(db, base({ frequency: "daily", time: "09:00" }));
  db.prepare("UPDATE scheduler_tasks SET enabled=0 WHERE id=?").run(id);
  const now = new Date(); now.setHours(23, 0, 0, 0);
  const d = takeDueReminders(db, PID, CID, now);
  check("disabled 不触发", !d.some((r) => r.id === id));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
