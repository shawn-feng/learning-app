/**
 * 一次性审计：注册表声明的列 vs 数据库真实 schema（家长库 + 孩子库）。
 * 目的：验证「注册表是不是唯一真源」——若两边漂移，说明手写登记已经失真。
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  parentLibTableRegistry,
  parentReadableRegistry,
  childKbReadableRegistry,
  childKbWritableRegistry,
} from "./src/agent/db-channel.js";

const DATA = join(process.cwd(), "data");
const out: string[] = [];
const p = (...a: unknown[]) => out.push(a.map(String).join(" "));

function realColumns(db: DatabaseSync, table: string): string[] | null {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.length) return null;
    return rows.map((r) => r.name);
  } catch {
    return null;
  }
}

function diff(label: string, declared: string[], real: string[] | null) {
  if (!real) {
    p(`  ❌ 表不存在于库中：${label}`);
    return;
  }
  const missing = real.filter((c) => !declared.includes(c));
  const phantom = declared.filter((c) => !real.includes(c));
  if (!missing.length && !phantom.length) {
    p(`  ✅ ${label}：注册表与实际完全一致（${real.length} 列）`);
  } else {
    p(`  ⚠ ${label}：注册表 ${declared.length} 列 / 实际 ${real.length} 列`);
    if (missing.length) p(`      实际有但注册表没登记（写不进/查不到）：${missing.join(", ")}`);
    if (phantom.length) p(`      注册表有但库里不存在（调用必报错）：${phantom.join(", ")}`);
  }
}

// ============ 家长库 ============
const parentsDir = join(DATA, "parents");
p("=".repeat(70));
p("家长库（parent.sqlite）");
p("=".repeat(70));
if (existsSync(parentsDir)) {
  for (const pid of readdirSync(parentsDir)) {
    const f = join(parentsDir, pid, "parent.sqlite");
    if (!existsSync(f)) continue;
    p(`\n【家长 ${pid}】`);
    const db = new DatabaseSync(f);
    for (const s of parentLibTableRegistry()) {
      diff(`(写) ${s.table}`, Object.keys(s.columns), realColumns(db, s.table));
    }
    for (const s of parentReadableRegistry()) {
      diff(`(读) ${s.table}`, Object.keys(s.columns), realColumns(db, s.table));
    }
    // 库里有、但注册表完全没登记的表
    const all = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const declared = new Set(parentLibTableRegistry().map((s) => s.table));
    const uncovered = all.map((r) => r.name).filter((n) => !declared.has(n) && !n.startsWith("sqlite_"));
    p(`  · 库内未被注册表覆盖的表：${uncovered.join(", ") || "（无）"}`);
    db.close();
  }
}

// ============ 孩子库 ============
const kbDir = join(DATA, "kb");
p("\n" + "=".repeat(70));
p("孩子库（kb.sqlite）");
p("=".repeat(70));

interface Found { path: string; size: number; childId: string }
const found: Found[] = [];
function walk(dir: string, depth = 0) {
  if (depth > 3 || !existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(f, depth + 1);
    else if (n.endsWith(".sqlite")) found.push({ path: f, size: st.size, childId: n.replace(/\.sqlite$/, "") });
  }
}
walk(kbDir);
found.sort((a, b) => b.size - a.size);
p(`\n发现 ${found.length} 个孩子库；取最大的 1 个做 schema 比对。`);

if (found.length) {
  const target = found[0];
  p(`\n【孩子库 ${target.childId}】size=${target.size}`);
  const db = new DatabaseSync(target.path);
  const readSpecs = childKbReadableRegistry();
  const writeSpecs = childKbWritableRegistry();
  for (const s of readSpecs) {
    diff(`(读) ${s.table}`, Object.keys(s.columns), realColumns(db, s.table));
  }
  for (const s of writeSpecs) {
    diff(`(写) ${s.table}`, Object.keys(s.columns), realColumns(db, s.table));
  }
  const all = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  const declared = new Set([...readSpecs.map((s) => s.table), ...writeSpecs.map((s) => s.table)]);
  const uncovered = all.map((r) => r.name).filter((n) => !declared.has(n) && !n.startsWith("sqlite_"));
  p(`  · 库内未被注册表覆盖的表：${uncovered.join(", ") || "（无）"}`);
  // tags 是否有数据
  for (const t of uncovered) {
    try {
      const c = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      p(`      ${t}: ${c.n} 行`);
    } catch {}
  }
  db.close();
}

import { writeFileSync } from "node:fs";
writeFileSync(join(process.cwd(), "registry-audit.out.txt"), out.join("\n"), "utf8");
console.log("done");
