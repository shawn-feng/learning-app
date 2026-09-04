/**
 * 学习计划 v2（2026-09-04 一课一行/一事一行）端到端冒烟：纯本地 temp 数据，验证
 * gen(计划→todo_items 家长项) → stat(学完回写 plan.status/done + 勾 todo + 写 child_todo_stats)
 * → carry(昨天 pending 顺延到今天) 全链 + 完成态判定（new 看 first_learned / review 看 last_review）。
 * 用法：node ../node_modules/tsx/dist/cli.mjs verify-study-plan-v2.mts
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../src/db.js";
import { openKb } from "../src/db/kb.js";
import { runTodoGenServer, runTodoStatServer } from "../src/worker/tasks.js";
import { runStudyPlanCarryTick } from "../src/worker/study-plan-carry.js";
import { formatLocalDate } from "../src/worker/kb-tools.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-v2-smoke-"));
const PARENT = "p-v2-test", CHILD = "c-v2-test";
const main = openDb(dir);

let fails = 0;
function assert(cond: unknown, label: string, extra?: unknown) {
  const ok = !!cond;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && extra !== undefined ? " :: " + JSON.stringify(extra) : ""}`);
}
function q<T>(sql: string, ...args: unknown[]): T {
  return (args.length ? main.prepare(sql).all(...(args as never)) : main.prepare(sql).all()) as T;
}
function q1<T>(sql: string, ...args: unknown[]): T {
  return (args.length ? main.prepare(sql).get(...(args as never)) : main.prepare(sql).get()) as T;
}

// 造家长 + 孩子
const now = new Date().toISOString();
main.prepare("INSERT INTO parents (id, email, created_at, updated_at) VALUES (?,?,?,?)").run(PARENT, "p@t", now, now);
main.prepare("INSERT INTO children (id, parent_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run(CHILD, PARENT, "测试娃", now, now);
// 孩子 kb：建表 + 课程
const kb = openKb(dir, PARENT, CHILD);
kb.prepare("INSERT INTO courses (topic, title, sort_order, status, first_learned, last_review, review_count) VALUES (?,?,?,?,?,?,?)")
  .run("lunyu", "论语学而篇第一章", 1, "✅", "", "", 2); // 已学 → 复习目标
kb.prepare("INSERT INTO courses (topic, title, sort_order, status) VALUES (?,?,?,?)").run("lunyu", "论语先进篇第二章", 2, "⬜");
// 空 child_kb 需有 today entries 由 stat 判 daily（此处直接跳过该门，见 stat 说明）
kb.close();

const today = formatLocalDate(new Date());

// 造今天两条计划：新学先进篇第二章 + 复习学而篇第一章
main.prepare(
  "INSERT INTO study_plan_items (id, parent_id, child_id, date, topic_key, course_name, mode, origin, status, done_at, active, created_at, updated_at) " +
    "VALUES (?,?,?,?,?,?,?, 'conversation','pending','',1,?,?)"
).run("plan-new", PARENT, CHILD, today, "lunyu", "论语先进篇第二章", "new", now, now);
main.prepare(
  "INSERT INTO study_plan_items (id, parent_id, child_id, date, topic_key, course_name, mode, origin, status, done_at, active, created_at, updated_at) " +
    "VALUES (?,?,?,?,?,?,?, 'conversation','pending','',1,?,?)"
).run("plan-rev", PARENT, CHILD, today, "lunyu", "论语学而篇第一章", "review", now, now);

const ctxBase = { dataDir: dir, mainDb: main, parentId: PARENT, childId: CHILD, auth: {}, schedulerConfig: {}, now: new Date(), point: "" } as never;
const ctx = () => ({ ...ctxBase, now: new Date() }) as never;

// ---------- gen：计划 → 今日家长 todo_items（todo_items 存孩子 kb，经 kb.todo.addParent 写入） ----------
await (runTodoGenServer as (c: unknown) => Promise<void>)(ctx());
const pkb = openKb(dir, PARENT, CHILD);
const todayRows = pkb.prepare("SELECT id, title, source, plan_id, status, note FROM todo_items WHERE todo_date=? ORDER BY sort").all(today) as Array<Record<string, string>>;
assert(todayRows.length === 2, "gen 生成 2 条家长 todo", todayRows);
assert(todayRows.some((r) => r.plan_id === "plan-new" && r.title === "论语先进篇第二章"), "todo: 新学先进篇第二章");
assert(todayRows.some((r) => r.plan_id === "plan-rev" && r.title === "论语学而篇第一章" && r.note === "复习"), "todo: 复习学而篇第一章(note=复习)");

// 幂等：再跑一次 gen 不新增
await (runTodoGenServer as (c: unknown) => Promise<void>)(ctx());
const cnt2 = pkb.prepare("SELECT COUNT(*) c FROM todo_items WHERE todo_date=?").get(today) as { c: number };
assert(cnt2.c === 2, "gen 幂等：不重复新增", cnt2);

// ---------- 模拟 recording：孩子学了先进篇第二章（首次学习=今天） & 复习了学而篇第一章（最近复习=今天） ----------
pkb.prepare("UPDATE courses SET first_learned=?, status='✅' WHERE title='论语先进篇第二章'").run(today);
pkb.prepare("UPDATE courses SET last_review=? WHERE title='论语学而篇第一章'").run(today);
pkb.prepare("INSERT INTO daily_entries (date, block, title, raw) VALUES (?, '学习', ?, ?)").run(today, "论语先进篇第二章", "今天学了第二章。");
pkb.close();

// ---------- stat：学完回写 plan 完成态 + 勾 todo + 写 stats ----------
await (runTodoStatServer as (c: unknown) => Promise<boolean>)(ctx());
const planNew = q1<{ status: string; done_at: string }>("SELECT status, done_at FROM study_plan_items WHERE id='plan-new'");
assert(planNew.status === "done" && planNew.done_at === today, "stat 回写 plan-new: status=done/done_at=today", planNew);
const planRev = q1<{ status: string }>("SELECT status FROM study_plan_items WHERE id='plan-rev'");
assert(planRev.status === "done", "stat 回写 plan-rev(review): done", planRev);
const pkb2 = openKb(dir, PARENT, CHILD);
const doneTodos = pkb2.prepare("SELECT id,status FROM todo_items WHERE todo_date=? AND source='parent' AND status='done'").all(today);
assert(doneTodos.length === 2, "stat 勾选今日家长 todo 为 done", doneTodos);
const statsRow = pkb2.prepare("SELECT total,done,parent_total,parent_done,self_total FROM child_todo_stats WHERE date=?").get(today);
assert(statsRow && (statsRow as any).total === 2 && (statsRow as any).parent_total === 2 && (statsRow as any).parent_done === 2, "child_todo_stats 写入(2 家长项全完成)", statsRow);
pkb2.close();

// ---------- carry：把「昨天」一条 pending 排期顺延到今天 ----------
const yesterday = formatLocalDate(new Date(new Date().setDate(new Date().getDate() - 1)));
main.prepare(
  "INSERT INTO study_plan_items (id, parent_id, child_id, date, topic_key, course_name, mode, origin, status, done_at, active, created_at, updated_at) " +
    "VALUES (?,?,?,?,?,?,?, 'conversation','pending','',1,?,?)"
).run("plan-yday", PARENT, CHILD, yesterday, "lunyu", "论语子路篇第七章", "new", now, now);
// carry tick 只认「date=昨天」，需用与 worker_state 一致的 yesterday 语义
const carryDeps = { dataDir: dir, db: main };
await (runStudyPlanCarryTick as (d: unknown) => Promise<void>)(carryDeps);
const carryToday = q<Array<{ origin: string; course_name: string; date: string }>>(
  "SELECT origin, course_name, date FROM study_plan_items WHERE course_name='论语子路篇第七章'"
);
assert(carryToday.some((r) => r.origin === "carry" && r.date === today), "carry: 昨天 pending 已顺延到今天 origin=carry", carryToday);
const ydayStatus = q1<{ status: string; active: number }>("SELECT status, active FROM study_plan_items WHERE id='plan-yday'");
assert(ydayStatus.status === "carried" && ydayStatus.active === 0, "carry: 昨天原行置 carried+停用", ydayStatus);

// cleanup
try { main.prepare("DROP TABLE IF EXISTS study_plan_items").run(); } catch { /* 无关 */ }
main.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }

console.log(fails === 0 ? "\nALL PASS (study-plan v2)" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
