/**
 * 无 GUI 冒烟测试：验证「统一数据 API」对孩子库（kb.sqlite）的通用读能力。
 * 直接调用 childKbReadableRegistry + executeRead（与 parent_db_read 传 child 时同链路），
 * 不经过 agent 框架。运行：node --import tsx probe-child-read.ts（或 tsx probe-child-read.ts）。
 */
import fs from "node:fs";
import path from "node:path";
import { openKb } from "./src/db/kb.js";
import { childKbReadableRegistry, executeRead } from "./src/agent/db-channel.js";

const dataDir = "C:\\Users\\79734\\Documents\\pi\\server\\data";
const parentId = "86a84278-c8ae-415e-8fbc-6140b1b7c88e";

const kbDir = path.join(dataDir, "kb", parentId);
const childIds = fs
  .readdirSync(kbDir)
  .filter((f) => f.endsWith(".sqlite") && f !== "parent.sqlite")
  .map((f) => f.replace(/\.sqlite$/, ""));

const specs = childKbReadableRegistry();
const out: string[] = [];
out.push(`=== 孩子库统一读：共 ${childIds.length} 个孩子库 ===`);
out.push("可读登记表（parent_db_read 传 child 即可查，无需专用工具）：");
out.push(specs.map((s) => `- ${s.table}（${s.label}）`).join("\n"));

const rowsPerChild: string[] = [];
let best = { childId: childIds[0] ?? "", n: -1 };
for (const childId of childIds) {
  const db = openKb(dataDir, parentId, childId);
  try {
    const counts: Record<string, number> = {};
    for (const t of ["study_plans", "exam_plans", "daily_entries", "points_ledger", "courses"]) {
      try {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n?: number };
        counts[t] = Number(r?.n ?? 0);
      } catch {
        counts[t] = -1;
      }
    }
    const total = counts.study_plans + counts.exam_plans + counts.daily_entries + counts.points_ledger;
    rowsPerChild.push(
      `- ${childId}：study_plans=${counts.study_plans} exam_plans=${counts.exam_plans} daily_entries=${counts.daily_entries} points_ledger=${counts.points_ledger} courses=${counts.courses}`
    );
    if (total > best.n) best = { childId, n: total };
  } finally {
    db.close();
  }
}
out.push("\n=== 各孩子库关键表行数 ===");
out.push(rowsPerChild.join("\n"));

out.push(`\n=== 演示：对数据最多的孩子库（${best.childId}）用统一读 API 查询 ===`);
const db = openKb(dataDir, parentId, best.childId);
try {
  out.push("\n--- ① study_plans 前 3 行（全列）---");
  out.push(executeRead(db, specs, { table: "study_plans", limit: 3 }).text);
  out.push("\n--- ② study_plans where status='pending'（等值过滤，SQL 在库内执行）---");
  out.push(executeRead(db, specs, { table: "study_plans", where: { status: "pending" }, limit: 3 }).text);
  out.push("\n--- ③ points_ledger 按时间倒序前 3 行 ---");
  out.push(executeRead(db, specs, { table: "points_ledger", orderBy: "ts", orderDesc: true, limit: 3 }).text);
  out.push("\n--- ④ daily_entries 前 3 行 ---");
  out.push(executeRead(db, specs, { table: "daily_entries", limit: 3 }).text);
} finally {
  db.close();
}

const outPath = path.join(process.cwd(), "probe-child-read.out.txt");
fs.writeFileSync(outPath, out.join("\n"), "utf8");
console.log(`written: ${outPath}`);
