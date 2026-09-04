/**
 * 一次性数据迁移（2026-09-04，本地开发库）：
 * 学习计划 v1（study_plan_items.content JSON 一天多课）→ v2（一课一行 mode/status/done_at），
 * 并迁移孩子 kb 旧 child_todos（markdown 一天一行）→ 新 todo_items（一事一行）。
 *
 * 用法: node <tsx> scripts/migrate-study-plan-v2.mts <dataDir> [--dry]
 * 运行前自动备份 server.sqlite 与涉及的 child kb（.pre-v2mig-<ts>）。
 * 幂等：跑过(表已是 v2 结构 / child_todos 已删)即跳过。
 *
 * 判定：
 *  - mode：计划文本含「复习/温习」前缀 → review；否则 new（本地珊珊旧文本无前缀 → 全 new）。
 *  - 计划行 status/done_at：以 courses 当天活动为准。mode=new → first_learned==date 或 last_review==date；
 *    mode=review → last_review==date。满足即 status=done + done_at=date。
 *  - child_todos → todo_items：[家长] 行按 course_name 关联迁移后计划行(plan_id)；否则归 source 默认。
 *  - 汉字宫等 courses 表不存在的课：计划行保留 course_name、topic_key 空、status 保持 pending。
 */
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

const dataDir = process.argv[2];
const DRY = process.argv.includes("--dry");
if (!dataDir) {
  console.error("用法: migrate-study-plan-v2.mts <dataDir> [--dry]");
  process.exit(2);
}

function nowIso(): string {
  return new Date().toISOString();
}
function ts(): string {
  return new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
}
function backup(p: string, tag: string): void {
  if (DRY || !existsSync(p)) return;
  const bkp = `${p}.pre-v2mig-${tag}-${ts()}`;
  copyFileSync(p, bkp);
  console.log(`  备份 -> ${bkp}`);
}
function tableSql(db: DatabaseSync, name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as
    | { sql?: string }
    | undefined;
  return row?.sql ?? "";
}

/** 计划文本 → (courseName, mode)：剥动作前缀/尾部标注。 */
function splitPlanText(text: string): { courseName: string; mode: "new" | "review" } {
  const t = (text || "").trim();
  const revHead = /^(?:复习|温习)\s*[:：]?\s*(.+)$/.exec(t);
  if (revHead && revHead[1].trim()) return { courseName: revHead[1].trim(), mode: "review" };
  const actHead = /^(?:学习|预习|背诵|朗读|跟读|听读|挑战|巩固|掌握)\s*[:：]\s*(.+)$/.exec(t);
  if (actHead && actHead[1].trim()) return { courseName: actHead[1].trim(), mode: "new" };
  const revTail = /^(.*?)[（(](?:复习|温习|回看)[）)]\s*$/.exec(t);
  if (revTail && revTail[1].trim()) return { courseName: revTail[1].trim(), mode: "review" };
  return { courseName: t, mode: "new" };
}

function isLearnedOn(date: string, c: { first_learned: string; last_review: string }, mode: string): boolean {
  const learned = (c.first_learned || "").trim() === date;
  const reviewed = (c.last_review || "").trim() === date;
  if (mode === "review") return reviewed;
  return learned || reviewed;
}

// ======================================================================
console.log(`\n########## 学习计划 v2 迁移  dataDir=${dataDir}  ${DRY ? "(--dry)" : ""} ##########`);
const mainPath = join(dataDir, "server.sqlite");
if (!existsSync(mainPath)) {
  console.error(`找不到 ${mainPath}`);
  process.exit(1);
}
backup(mainPath, "main");
const main = new DatabaseSync(mainPath);
const mainPlanSql = tableSql(main, "study_plan_items");
const HAS_CONTENT = mainPlanSql.includes("content TEXT");

if (HAS_CONTENT) {
  console.log("\n=== A) study_plan_items: v1(content JSON) → v2(一课一行) ===");
  const oldRows = main
    .prepare(
      "SELECT id,parent_id,child_id,date,content,origin,active,created_at,updated_at FROM study_plan_items ORDER BY date,created_at"
    )
    .all() as Array<{
    id: string; parent_id: string; child_id: string; date: string; content: string;
    origin: string; active: number; created_at: string; updated_at: string;
  }>;
  console.log(`  旧格式计划行 ${oldRows.length}`);

  if (!DRY) {
    main.exec("DROP TABLE IF EXISTS study_plan_items");
    main.exec(`
      CREATE TABLE study_plan_items (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        date TEXT NOT NULL DEFAULT '',
        topic_key TEXT NOT NULL DEFAULT '',
        course_name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'new',
        origin TEXT NOT NULL DEFAULT 'conversation',
        status TEXT NOT NULL DEFAULT 'pending',
        done_at TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_study_plan_child ON study_plan_items(child_id, date);
      CREATE INDEX IF NOT EXISTS idx_study_plan_parent ON study_plan_items(parent_id, date);
    `);
    const ins = main.prepare(
      `INSERT INTO study_plan_items
        (id,parent_id,child_id,date,topic_key,course_name,mode,origin,status,done_at,active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    let inserted = 0;
    main.exec("BEGIN");
    for (const r of oldRows) {
      let items: Array<{ text?: string; topicKey?: string }> = [];
      try {
        const a = JSON.parse(r.content);
        items = Array.isArray(a) ? a : [];
      } catch {
        continue;
      }
      const seen = new Set<string>();
      for (const it of items) {
        if (!it || typeof it.text !== "string" || !it.text.trim()) continue;
        const { courseName, mode } = splitPlanText(it.text);
        if (!courseName) continue;
        const k = `${mode}\u0000${courseName}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const topicKey = typeof it.topicKey === "string" && it.topicKey ? it.topicKey : "";
        ins.run(randomUUID(), r.parent_id, r.child_id, r.date, topicKey, courseName, mode,
          r.origin, "pending", "", r.active ? 1 : 0, r.created_at || nowIso(), r.updated_at || nowIso());
        inserted++;
      }
    }
    main.exec("COMMIT");
    console.log(`  已转换 ${inserted} 条课程行`);
  }
} else {
  console.log("\n=== A) study_plan_items 已是 v2 结构，跳过 ===");
}

// ---- 读迁移后的 v2 plan 行（B 用） ----
const main2 = new DatabaseSync(mainPath);
const planRows = main2
  .prepare("SELECT id,parent_id,child_id,date,topic_key,course_name,mode,origin,status,active FROM study_plan_items WHERE active=1")
  .all() as Array<{
  id: string; parent_id: string; child_id: string; date: string; topic_key: string;
  course_name: string; mode: string; origin: string; status: string; active: number;
}>;
const planByChild = new Map<string, typeof planRows>();
for (const p of planRows) {
  if (!planByChild.has(p.child_id)) planByChild.set(p.child_id, []);
  planByChild.get(p.child_id)!.push(p);
}

// 发现所有含旧 child_todos 的孩子 kb（即便没有结构化计划，历史 todolist 也要迁移成 todo_items）
interface KbScan { childId: string; parentId: string; path: string; }
const kbFiles: KbScan[] = [];
{
  const kbRoot = join(dataDir, "kb");
  if (existsSync(kbRoot)) {
    for (const parentId of readdirSync(kbRoot)) {
      const pdir = join(kbRoot, parentId);
      if (!existsSync(pdir) || !isDirectory(pdir)) continue;
      for (const f of readdirSync(pdir)) {
        if (!f.endsWith(".sqlite")) continue;
        const childId = f.slice(0, -".sqlite".length);
        kbFiles.push({ childId, parentId, path: join(pdir, f) });
      }
    }
  }
}

let planDone = 0;
let todoTotal = 0;
console.log("\n=== B) 计划完成态回写 + child_todos → todo_items ===");
for (const { childId, parentId, path: kbPath } of kbFiles) {
  const plans = planByChild.get(childId) ?? [];
  // 该 child 在迁移后的 study_plan_items 里的计划行（无则用空数组）
  const effPlans = plans.length ? plans : [];

  backup(kbPath, "child");
  const kb = new DatabaseSync(kbPath);
  let hasTodoItems = !!tableSql(kb, "todo_items");
  const hasChildTodos = !!tableSql(kb, "child_todos");
  if (!hasTodoItems && hasChildTodos) {
    // kb.ts 的 CREATE TABLE IF NOT EXISTS 在服务端打开时建；此处脚本里若没有 todo_items 表则先建（复用 kb.ts schema）
    console.log(`  !! child ${childId} 缺 todo_items 表（服务端尚未打开过该 kb）——先建表`);
    if (!DRY) {
      kb.exec(`
        CREATE TABLE IF NOT EXISTS todo_items (
          id TEXT PRIMARY KEY,
          child_id TEXT NOT NULL DEFAULT '',
          todo_date TEXT NOT NULL,
          title TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'child',
          plan_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          done_at TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          sort INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_todo_child_date ON todo_items(child_id, todo_date);
        CREATE INDEX IF NOT EXISTS idx_todo_plan ON todo_items(plan_id);
      `);
    }
    hasTodoItems = true;
  }

  // courses map
  const courses: Record<string, { first_learned: string; last_review: string; topic: string }> = {};
  try {
    for (const c of kb.prepare("SELECT topic,title,first_learned,last_review FROM courses").all() as Array<{
      topic: string; title: string; first_learned: string; last_review: string;
    }>) {
      courses[c.title] = { first_learned: c.first_learned || "", last_review: c.last_review || "", topic: c.topic || "" };
    }
  } catch { /* ignore */ }

  if (!DRY && hasTodoItems) {
    // 1) 回写该 child 计划完成态（+ topic_key 补全）
    const upd = main2.prepare("UPDATE study_plan_items SET status=?,done_at=?,topic_key=?,updated_at=? WHERE id=?");
    for (const p of effPlans) {
      const c = courses[p.course_name];
      if (!c) continue;
      if (p.status !== "done" && isLearnedOn(p.date, c, p.mode)) {
        upd.run("done", p.date, p.topic_key || c.topic, nowIso(), p.id);
        planDone++;
      } else if (!p.topic_key && c.topic) {
        upd.run(p.status, "", c.topic, nowIso(), p.id);
      }
    }
  }

  // 2) child_todos → todo_items
  if (hasChildTodos && hasTodoItems) {
    const mdRows = kb.prepare("SELECT date,items_md FROM child_todos ORDER BY date").all() as Array<{ date: string; items_md: string }>;
    console.log(`  child ${childId}: child_todos ${mdRows.length} 天待迁移${effPlans.length ? `（关联 ${effPlans.length} 条计划行）` : "（无结构化计划）"}`);
    if (!DRY) {
      const ins = kb.prepare(
        `INSERT INTO todo_items
          (id,child_id,todo_date,title,source,plan_id,status,done_at,note,sort,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      kb.exec("BEGIN");
      const baseIso = nowIso();
      let childTodo = 0;
      for (const row of mdRows) {
        const { date, items_md } = row;
        if (!items_md || !items_md.trim()) continue;
        let sort = 0;
        for (const line of items_md.split("\n")) {
          const m = /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/.exec(line);
          if (!m) continue;
          const isDone = m[1].toLowerCase() === "x";
          const body = m[2].trim();
          if (!body) continue;
          const isParent = /\[家长\]/.test(body);
          const clean = body.replace(/^\[家长\]\s*/, "").replace(/（昨天没学完，今天补上）\s*$/, "").trim();
          if (!clean) continue;
          const { courseName } = splitPlanText(clean);
          // 关联计划：同 child、同 date、course_name 精确匹配
          const planMatch = effPlans.find((pl) => pl.date === date && pl.course_name === courseName);
          ins.run(randomUUID(), childId, date, courseName, isParent ? "parent" : "child",
            planMatch ? planMatch.id : "", isDone ? "done" : "pending",
            isDone ? date : "", isParent && !planMatch ? "家长安排(未关联计划)" : "", sort, baseIso, baseIso);
          sort++;
          childTodo++;
          todoTotal++;
        }
      }
      kb.exec("COMMIT");
      try { kb.exec("DROP TABLE IF EXISTS child_todos"); } catch { /* ignore */ }
      console.log(`    -> 写入 ${childTodo} 条 todo_items，已删 child_todos`);
    }
  } else if (!hasChildTodos) {
    console.log(`  child ${childId}: 无 child_todos，跳过`);
  }
  kb.close();
}

// ================= 汇总 =================
console.log("\n=== 迁移后 study_plan_items（date | mode | course | origin | status | topic）===");
const after = main2
  .prepare("SELECT date,course_name,mode,origin,status,done_at,topic_key FROM study_plan_items WHERE active=1 ORDER BY date,course_name")
  .all() as Array<Record<string, string>>;
for (const r of after) {
  console.log(`  ${r.date} [${r.mode}] ${r.course_name} | ${r.origin} | ${r.status}${r.done_at ? " @" + r.done_at : ""} | topic=${r.topic_key || "-"}`);
}
console.log(`  合计计划课程行 ${after.length}，完成 ${planDone}`);
main2.close();
console.log(DRY ? "\n(--dry：未写库--)" : "\n迁移完成");
