/**
 * 家长 agent 计划域工具冒烟（parent-plans.ts）：
 * 临时环境构造 孩子 + 家长库课程 + kb 三张计划表，逐工具验证核心语义与防重/错误路径。
 * 不调 LLM、不碰真实数据。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPlanDomainTools, PLAN_DOMAIN_TOOL_NAMES } from "../src/agent/parent-plans.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [OK]   ${name}${detail ? ` — ${detail.slice(0, 80)}` : ""}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail.slice(0, 160)}` : ""}`);
  }
}

async function text(p: any, params: any): Promise<string> {
  const r = await p.execute("check", params);
  return r?.content?.map((c: any) => c.text).join("") ?? "";
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-tools-"));
const PID = "p1";
const CID = "c1";

// 主库：children（同服务端 schema 的最小列集）
const db = new DatabaseSync(path.join(tmp, "server.sqlite"));
db.exec("CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT, created_at TEXT DEFAULT '')");
db.prepare("INSERT INTO children (id, parent_id, name) VALUES (?, ?, ?)").run(CID, PID, "珊珊");
db.exec("CREATE TABLE exam_schedules (id TEXT PRIMARY KEY, parent_id TEXT, child_id TEXT, kind TEXT, freq TEXT, scheduled_at TEXT, scope TEXT, status TEXT, created_at TEXT)");

// 家长库：用 openParentLib 本身建库（走完整 schema 初始化，与生产一致），再插 courses
import { openParentLib } from "../src/db/parent-lib.js";
{
  const pdb = openParentLib(tmp, PID);
  pdb.prepare("INSERT INTO courses (topic, title, uuid) VALUES (?, ?, ?)").run("lunyu", "论语学而篇第一章", "uuid-1");
  pdb.prepare("INSERT INTO courses (topic, title, uuid) VALUES (?, ?, ?)").run("lunyu", "论语学而篇第二章", "uuid-2");
  pdb.close();
}

// 孩子 kb：study_plans / life_plans / topics / courses / topic_progress（与服务端 schema 对齐的最小列集）
const kbPath = path.join(tmp, "kb", PID, `${CID}.sqlite`);
fs.mkdirSync(path.dirname(kbPath), { recursive: true });
const kb = new DatabaseSync(kbPath);
kb.exec(`CREATE TABLE study_plans (
  id TEXT PRIMARY KEY, parent_id TEXT, child_id TEXT, topic_key TEXT, course_uuid TEXT, course_name TEXT,
  mode TEXT, creator TEXT, origin TEXT, carry_from TEXT, recurrence_id TEXT,
  start_at TEXT, due_at TEXT, status TEXT, result TEXT, done_at TEXT,
  task_type TEXT, count_in_rate INTEGER, points INTEGER, active INTEGER, created_at TEXT, updated_at TEXT)`);
kb.exec(`CREATE TABLE life_plans (
  id TEXT PRIMARY KEY, parent_id TEXT, child_id TEXT, title TEXT, creator TEXT, origin TEXT, carry_from TEXT,
  recurrence_id TEXT, start_at TEXT, due_at TEXT, status TEXT, result TEXT, done_at TEXT,
  task_type TEXT, count_in_rate INTEGER, points INTEGER, active INTEGER, created_at TEXT, updated_at TEXT)`);
kb.exec("CREATE TABLE topics (name TEXT, topic_key TEXT, method TEXT DEFAULT '', progress TEXT DEFAULT '', rules_json TEXT DEFAULT '{}')");
kb.exec(`CREATE TABLE courses (
  topic TEXT, title TEXT, sort_order INTEGER DEFAULT 0, status TEXT DEFAULT '', last_review TEXT DEFAULT '',
  review_count INTEGER DEFAULT 0, material TEXT DEFAULT '', send_material TEXT DEFAULT '', tags TEXT DEFAULT '',
  lesson_method TEXT DEFAULT '', html_path TEXT DEFAULT '', teaching_copy TEXT DEFAULT '')`);
kb.exec("CREATE TABLE topic_progress (topic TEXT PRIMARY KEY, learned INTEGER DEFAULT 0, total INTEGER DEFAULT 0, next TEXT DEFAULT '', updated TEXT DEFAULT '')");
kb.prepare("INSERT INTO topics (name, topic_key) VALUES (?, ?)").run("论语", "lunyu");
kb.prepare("INSERT INTO courses (topic, title, status) VALUES (?, ?, ?)").run("lunyu", "论语学而篇第一章", "");
kb.prepare("INSERT INTO courses (topic, title, status) VALUES (?, ?, ?)").run("lunyu", "论语学而篇第二章", "");
kb.prepare("INSERT INTO topic_progress (topic, learned, total) VALUES (?, ?, ?)").run("lunyu", 0, 2);
kb.close();

const tools = createPlanDomainTools({ db, dataDir: tmp, parentId: PID });
const byName = new Map<string, any>(tools.map((t) => [t.name, t]));
console.log(`工具共 ${byName.size} 个：${[...byName.keys()].join(", ")}`);
check("工具表与导出名一致", byName.size === 8 && PLAN_DOMAIN_TOOL_NAMES.every((n) => byName.has(n)));

console.log("\nA. 名单与课程结构");
check("A1 parent_list_children", (await text(byName.get("parent_list_children"), {})).includes("珊珊"));
check("A2 study_plan_sources 全主题", (await text(byName.get("study_plan_sources"), { childName: "珊珊" })).includes("lunyu"));
await check(
  "A3 study_plan_sources 找不到主题 → 报错列可选",
  (async () => {
    try {
      await text(byName.get("study_plan_sources"), { childName: "珊珊", topic: "不存在" });
      return false;
    } catch (e) {
      return String((e as Error).message).includes("找不到主题");
    }
  })(),
  ""
);

console.log("\nB. 学习计划 create / list / get");
{
  const r1 = await text(byName.get("study_plan_create"), {
    childName: "珊珊",
    days: [
      { date: "2026-09-14", content: ["论语学而篇第一章", "复习：论语学而篇第二章"] },
      { date: "2026-09-15", content: ["论语学而篇第二章"] },
    ],
  });
  check("B1 create 两天（含复习前缀）", r1.includes("2026-09-14") && r1.includes("复习"));
  const r2 = await text(byName.get("study_plan_create"), {
    childName: "珊珊",
    days: [{ date: "2026-09-14", content: ["论语学而篇第一章"] }],
  });
  check("B2 同日同课重复 → 跳过", r2.includes("跳过"));
  const kbd = new DatabaseSync(kbPath);
  const row = kbd.prepare("SELECT topic_key, course_uuid, mode FROM study_plans WHERE course_name = ? AND mode='review'").get("论语学而篇第二章") as any;
  const rows2 = kbd.prepare("SELECT COUNT(*) n FROM study_plans WHERE course_name = '论语学而篇第二章'").get() as any;
  console.log(`  [DBG] review row = ${JSON.stringify(row)}`);
  check("B3 topic_key/uuid 反查入库 + 复习行独立", row?.topic_key === "lunyu" && row?.course_uuid === "uuid-2" && row?.mode === "review" && rows2?.n === 2);
  kbd.close();
  const r3 = await text(byName.get("study_plan_list"), { childName: "珊珊" });
  check("B4 list 含行 id 与完成态", r3.includes("2026-09-14") && r3.includes("复习"));
  const r4 = await text(byName.get("study_plan_get"), { childName: "珊珊", date: "2026-09-14" });
  check("B5 get 某天聚合", r4.includes("2026-09-14") && r4.includes("论语学而篇第一章"));
}

console.log("\nC. 学习计划 update（delete / reschedule / setmode）");
{
  const listText = await text(byName.get("study_plan_list"), { childName: "珊珊" });
  const m = /- ([0-9a-f]{8})\S*｜2026-09-15｜/.exec(listText);
  const shortId = m?.[1] ?? "";
  const r1 = await text(byName.get("study_plan_update"), { childName: "珊珊", act: "reschedule", id: shortId, date: "2026-09-16" });
  check("C1 reschedule（截短 id）", r1.includes("2026-09-16"));
  const kbd = new DatabaseSync(kbPath);
  const moved = kbd.prepare("SELECT start_at FROM study_plans WHERE course_name = '论语学而篇第二章' AND mode='new'").get() as any;
  check("C2 库内日期已改", String(moved?.start_at ?? "").startsWith("2026-09-16"));
  kbd.close();
  const r2 = await text(byName.get("study_plan_update"), { childName: "珊珊", act: "setmode", id: shortId, mode: "review" });
  check("C3 setmode → review", r2.includes("复习"));
  const r3 = await text(byName.get("study_plan_update"), { childName: "珊珊", act: "delete", id: shortId });
  check("C4 delete", r3.includes("已删除"));
  const kbd2 = new DatabaseSync(kbPath);
  const left = kbd2.prepare("SELECT COUNT(*) n FROM study_plans WHERE course_name = '论语学而篇第二章' AND mode='new'").get() as any;
  check("C5 库内行已删", left?.n === 0);
  kbd2.close();
}

console.log("\nD. 生活计划（防重）与考核排期");
{
  const r1 = await text(byName.get("parent_plan_create"), {
    childName: "珊珊",
    days: [{ date: "2026-09-14", title: "每天整理书包", time: "20:30" }],
  });
  check("D1 生活计划创建（必须完成项）", r1.includes("整理书包") && r1.includes("20:30"));
  const r2 = await text(byName.get("parent_plan_create"), {
    childName: "珊珊",
    days: [{ date: "2026-09-14", title: "每天整理书包" }],
  });
  check("D2 同天同标题 → 跳过", r2.includes("跳过"));
  const kbd = new DatabaseSync(kbPath);
  const lp = kbd.prepare("SELECT creator, task_type, due_at FROM life_plans WHERE title = '每天整理书包'").get() as any;
  check("D3 creator=parent / task_type=required / 截止 20:30", lp?.creator === "parent" && lp?.task_type === "required" && String(lp?.due_at).includes("20:30"));
  kbd.close();
  const r3 = await text(byName.get("exam_schedule_create"), {
    childName: "珊珊",
    scheduledAt: "2026-09-20",
    courses: ["论语学而篇第一章"],
    note: "只考背诵",
  });
  check("D4 考核排期创建", r3.includes("2026-09-20") && r3.includes("论语学而篇第一章"));
  const mdb = new DatabaseSync(path.join(tmp, "server.sqlite"));
  const es = mdb.prepare("SELECT kind, child_id FROM exam_schedules WHERE child_id = ?").get(CID) as any;
  check("D5 库内 kind=custom / 归属正确", es?.kind === "custom" && es?.child_id === CID);
  mdb.close();
}

console.log("\nE. 错误路径");
{
  try {
    await text(byName.get("study_plan_get"), { childName: "不存在" });
    check("E1 找不到孩子 → 报错", false);
  } catch (e) {
    check("E1 找不到孩子 → 报错", String((e as Error).message).includes("找不到孩子"));
  }
  try {
    await text(byName.get("exam_schedule_create"), { childName: "珊珊", scheduledAt: "2026-09-21", courses: [] });
    check("E2 考核无课程 → 拒绝并要求确认", false);
  } catch (e) {
    check("E2 考核无课程 → 拒绝并要求确认", String((e as Error).message).includes("具体课程"));
  }
  try {
    await text(byName.get("parent_plan_create"), { childName: "珊珊", days: [{ date: "2026-09-14", title: "x", time: "25:00" }] });
    check("E3 生活计划 time 非法 → 拒绝", false);
  } catch (e) {
    check("E3 生活计划 time 非法 → 拒绝", String((e as Error).message).includes("HH:mm"));
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
