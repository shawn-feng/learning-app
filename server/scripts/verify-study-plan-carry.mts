/**
 * ISSUE-033 P0b 验证 v2：runStudyPlanCarryTick 单元冒烟（tsx 直调源码，秒级，无需等 cron）。
 * 判定口径 v2（2026-09-03）：顺延依据 = 昨天 child_todos 里**未勾的 [家长] 行**（不再依赖 child_todo_stats）。
 * 场景：
 *  A 昨天 todo：「论语」已勾 [x]、「数学练习」未勾 [ ]，且今天已排「论语」 → 只顺延「数学练习」1 项（去重、跳过已完成）；
 *  B 昨天 todo 全勾（无未完成家长项）→ 不顺延；
 *  C 昨天没有任何 todolist → 不顺延（无完成信号可判，保守）；
 *  幂等：同一天重复 tick 不新增行。
 * 用法：cd server && npx tsx scripts/verify-study-plan-carry.mts
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { openKb } from "../src/db/kb.js";
import { runStudyPlanCarryTick } from "../src/worker/study-plan-carry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-carry-"));

function fail(msg: string): never {
  console.error("✗ FAIL:", msg);
  process.exit(1);
}
function log(...a: unknown[]): void {
  console.log("[carry-test]", ...a);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
  log("✓", msg);
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
const today = (() => {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
})();
const yesterday = shiftDate(today, -1);

// 1) 主库：家长 + 3 孩子 + 昨天/今天的排期行
const db = openDb(dataDir);
const nowIso = new Date().toISOString();
db.prepare("INSERT INTO parents (id, email, plan, created_at, updated_at) VALUES (?,?,?,?,?)").run(
  "parent-1",
  "p@t.local",
  "pro",
  nowIso,
  nowIso
);
for (const cid of ["childA", "childB", "childC"]) {
  db.prepare("INSERT INTO children (id, parent_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run(
    cid,
    "parent-1",
    cid,
    nowIso,
    nowIso
  );
}
const insertPlan = (childId: string, date: string, items: Array<{ text: string; topicKey?: string }>): void => {
  db.prepare(
    "INSERT INTO study_plan_items (id, parent_id, child_id, kind, date, content, origin, active, created_at, updated_at) VALUES (?, ?, ?, 'date', ?, ?, 'conversation', 1, ?, ?)"
  ).run(`id-${childId}-${date}`, "parent-1", childId, date, JSON.stringify(items), nowIso, nowIso);
};
insertPlan("childA", yesterday, [
  { text: "论语·先进篇 1-2 章", topicKey: "lunyu" },
  { text: "数学练习" },
]);
insertPlan("childA", today, [{ text: "论语·先进篇 1-2 章" }]); // 今天已排同 text → carry 应去重
insertPlan("childB", yesterday, [{ text: "英语 2 课" }]);
insertPlan("childC", yesterday, [{ text: "汉字宫 1 课" }]);

// 2) 孩子 kb：昨天 todolist（v2 判定真源 = 未勾 [家长] 行）
const putTodo = (childId: string, date: string, lines: string[]): void => {
  const kb = openKb(dataDir, "parent-1", childId);
  try {
    kb.prepare("INSERT INTO child_todos (date, items_md, updated) VALUES (?,?,?)").run(
      date,
      lines.join("\n"),
      nowIso
    );
  } finally {
    kb.close();
  }
};
// A：论语已完成 [x]、数学练习未完成 [ ] → 只顺延数学练习
putTodo("childA", yesterday, ["- [x] [家长] 论语·先进篇 1-2 章", "- [ ] [家长] 数学练习"]);
// B：全勾完成 → 不顺延
putTodo("childB", yesterday, ["- [x] [家长] 英语 2 课"]);
// C：昨天没有 todolist → 不顺延（不臆断没完成）

const todayTexts = (childId: string): string[] => {
  const rows = db
    .prepare("SELECT content, origin FROM study_plan_items WHERE child_id = ? AND date = ? AND active = 1")
    .all(childId, today) as Array<{ content: string; origin: string }>;
  const out: string[] = [];
  for (const r of rows) {
    const arr = JSON.parse(r.content) as Array<{ text: string }>;
    for (const it of arr) out.push(`${r.origin}:${it.text}`);
  }
  return out;
};

// 3) 首次 tick
await runStudyPlanCarryTick({ dataDir, db });

// A：顺延 1 项（数学练习），今天已有同 text 的论语不再重复
const aTexts = todayTexts("childA");
assert(
  aTexts.includes("conversation:论语·先进篇 1-2 章") && aTexts.includes("carry:数学练习") && aTexts.length === 2,
  `A 顺延去重后共 2 行（实际 ${JSON.stringify(aTexts)}）`
);
// B：昨天全勾完成 → 不顺延
const bTexts = todayTexts("childB");
assert(bTexts.length === 0, `B 已全部完成不顺延（实际 ${JSON.stringify(bTexts)}）`);
// C：昨天无 todolist → 不顺延
const cTexts = todayTexts("childC");
assert(cTexts.length === 0, `C 无 todolist 不顺延（实际 ${JSON.stringify(cTexts)}）`);

// 4) 幂等：同一天再跑一次不新增
await runStudyPlanCarryTick({ dataDir, db });
const aAfter = todayTexts("childA");
assert(aAfter.length === 2, `幂等：重复 tick 不新增（实际 ${aAfter.length} 行）`);

db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
log("全部通过 ✅");
