/**
 * 注册表漂移检测（可复用）：注册表声明的列 vs 库内真实 schema。
 *
 * 用途：注册表（db-channel.ts）是通用数据 API 的**唯一真源**，一旦它与真实库漂移，
 * agent 就会出现「查不到 / 猜列名 / 调用必报错」三类症状。本脚本把漂移打成一张清单，
 * 放在 CI 或发版前跑。
 *
 * 运行：npm run probe:registry-drift   （或 npx tsx probe-registry-drift.ts）
 * 退出码：有漂移 = 1（可用于门禁）；无漂移 = 0
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  parentLibTableRegistry,
  parentReadableRegistry,
  childKbReadableRegistry,
  childKbWritableRegistry,
} from "./src/agent/db-channel.js";
// 探针用「打开即迁移」的入口开库：注册表服务的是运行时（每次 open 都会做幂等迁移），
// 量「迁移后的 schema」才和运行时一致；顺带把存量库批量迁移一遍（等价于一次迁移清扫）。
import { openParentLib } from "./src/db/parent-lib.js";
import { openKb } from "./src/db/kb.js";

const DATA = join(process.cwd(), "data");
type Spec = { table: string; columns: Record<string, string> };

interface Finding {
  db: string;
  mode: "读" | "写";
  table: string;
  missing: string[]; // 库里真实存在、注册表未登记
  phantom: string[]; // 注册表登记、库里不存在（调用必报错）
  realCount: number;
  declaredCount: number;
}

const findings: Finding[] = [];
const uncovered: Array<{ db: string; tables: string[] }> = [];

function realColumns(db: DatabaseSync, table: string): string[] | undefined {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.length ? rows.map((r) => r.name) : undefined;
  } catch {
    return undefined;
  }
}

function check(db: DatabaseSync, dbName: string, mode: "读" | "写", specs: Spec[], declaredTables: Set<string>) {
  for (const s of specs) {
    // 只读列（服务端生成 id/uuid/时间戳/系统域 JSON）也是注册表声明的一部分：写面不开放但真实存在
    const ro = (s as Spec & { readOnlyColumns?: Record<string, string> }).readOnlyColumns ?? {};
    const declared = [...Object.keys(s.columns), ...Object.keys(ro)];
    const real = realColumns(db, s.table);
    if (!real) {
      findings.push({ db: dbName, mode, table: s.table, missing: [], phantom: ["<表不存在>"], realCount: 0, declaredCount: declared.length });
      continue;
    }
    const missing = real.filter((c) => !declared.includes(c));
    const phantom = declared.filter((c) => !real.includes(c));
    if (missing.length || phantom.length) {
      findings.push({ db: dbName, mode, table: s.table, missing, phantom, realCount: real.length, declaredCount: declared.length });
    }
  }
  const all = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  // 基建表不要求登记：meta=迁移游标；db_audit=通道审计；entities/namespaces=Tier 2 灵活实体（F15a，数据驱动不进代码注册表）
  const INFRA = new Set(["meta", "db_audit", "entities", "namespaces"]);
  const un = all.map((r) => r.name).filter((n) => !declaredTables.has(n) && !n.startsWith("sqlite_") && !INFRA.has(n));
  if (un.length) uncovered.push({ db: dbName, tables: un });
}

/** Tier 2 注册行校验（F15a）：spec_json 可解析、字段定义完整、refs 目标表在 Tier 1 注册表内 */
function checkNamespaces(db: DatabaseSync, tier1Tables: Set<string>): string[] {
  const problems: string[] = [];
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = db.prepare("SELECT ns, scope, spec_json FROM namespaces").all() as Array<Record<string, unknown>>;
  } catch {
    return problems; // 表未建 = 无 Tier 2
  }
  for (const r of rows) {
    const ns = String(r.ns);
    let spec: { columns?: Record<string, unknown>; filterable?: string[]; refs?: Array<{ column: string; refTable: string }> };
    try {
      spec = JSON.parse(String(r.spec_json ?? "{}"));
    } catch {
      problems.push(`namespace ${ns}：spec_json 不是合法 JSON`);
      continue;
    }
    if (!spec.columns || !Object.keys(spec.columns).length) {
      problems.push(`namespace ${ns}：columns 为空`);
      continue;
    }
    for (const [col, c] of Object.entries(spec.columns ?? {})) {
      const cc = c as { kind?: string; desc?: string };
      if (!cc?.kind || !cc?.desc) problems.push(`namespace ${ns}：字段 ${col} 缺 kind/desc`);
    }
    for (const f of spec.filterable ?? []) {
      if (!(f in (spec.columns ?? {}))) problems.push(`namespace ${ns}：filterable 字段 ${f} 未定义`);
    }
    for (const ref of spec.refs ?? []) {
      if (!tier1Tables.has(ref.refTable)) problems.push(`namespace ${ns}：refs 目标表 ${ref.refTable} 未在 Tier 1 登记`);
    }
  }
  return problems;
}

// —— 家长库：同一套代码注册表作用在 N 个家长库，取第一个报详情、其余只计数 ——
const parentsDir = join(DATA, "parents");
const parentDbs: string[] = [];
if (existsSync(parentsDir)) {
  for (const pid of readdirSync(parentsDir)) {
    const f = join(parentsDir, pid, "parent.sqlite");
    if (existsSync(f)) parentDbs.push(f);
  }
}
let parentChecked = 0;
const parentDeclared = new Set([...parentReadableRegistry(), ...parentLibTableRegistry()].map((s) => s.table));
const nsProblems: string[] = [];
const seenNs = new Set<string>();
for (const f of parentDbs) {
  const pid = f.split(sep).slice(-2)[0];
  const db = openParentLib(DATA, pid);
  check(db, "家长库", "读", parentReadableRegistry(), parentDeclared);
  check(db, "家长库", "写", parentLibTableRegistry(), parentDeclared);
  for (const p of checkNamespaces(db, new Set(parentLibTableRegistry().map((s) => s.table)))) {
    if (!seenNs.has(p)) {
      seenNs.add(p);
      nsProblems.push(p);
    }
  }
  db.close();
  parentChecked++;
}

// —— 孩子库：取最大（数据最全）的一个 ——
const found: Array<{ path: string; size: number }> = [];
(function walk(dir: string, depth = 0) {
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
    else if (n.endsWith(".sqlite")) found.push({ path: f, size: st.size });
  }
})(join(DATA, "kb"));
found.sort((a, b) => b.size - a.size);

let childChecked = 0;
const childDeclared = new Set([...childKbReadableRegistry(), ...childKbWritableRegistry()].map((s) => s.table));
for (const t of found) {
  // kb/<parentId>/<childId>.sqlite → openKb（打开即迁移）
  const rel = t.path.slice(DATA.length + 1).split(/[\\/]/);
  if (rel.length < 3) continue;
  const db = openKb(DATA, rel[1], rel[2].replace(/\.sqlite$/, ""));
  check(db, "孩子库", "读", childKbReadableRegistry(), childDeclared);
  check(db, "孩子库", "写", childKbWritableRegistry(), childDeclared);
  db.close();
  childChecked++;
  break; // schema 由同一份建表 SQL 生成，抽一个代表即可
}

// —— 输出 ——
const out: string[] = [];
out.push(`# 注册表漂移检测`);
out.push(`家长库 ${parentChecked} 个（同一份代码注册表，下列为按库去重后的差异）｜孩子库检查 ${childChecked} 个（取最大）`);
out.push("");

// 按 (mode, table) 去重
const seen = new Set<string>();
for (const f of findings) {
  const key = `${f.mode}|${f.table}|${f.missing.join(",")}|${f.phantom.join(",")}`;
  if (seen.has(key)) continue;
  seen.add(key);
  out.push(`[${f.db}·${f.mode}] ${f.table}：注册表 ${f.declaredCount} 列 / 实际 ${f.realCount} 列`);
  if (f.phantom.length) out.push(`    ❌ 注册表有、库里无（**调用必报错**）：${f.phantom.join(", ")}`);
  if (f.missing.length) out.push(`    ⚠ 库里有、注册表未登记（查不到/写不进）：${f.missing.join(", ")}`);
}
out.push("");
if (nsProblems.length) {
  out.push("## Tier 2 namespace 注册行问题");
  for (const p of nsProblems) out.push(`- ${p}`);
  out.push("");
}
for (const u of uncovered) {
  const key = u.tables.join(",");
  if (seen.has(`uncovered|${key}`)) continue;
  seen.add(`uncovered|${key}`);
  out.push(`[${u.db}] 未被注册表覆盖的表：${u.tables.join(", ")}`);
}

const text = out.join("\n");
writeFileSync(join(process.cwd(), "registry-drift.txt"), text, "utf8");
console.log(`registry-drift.txt written: ${findings.length || nsProblems.length ? "有漂移" : "无漂移"}`);
process.exitCode = findings.length || uncovered.length || nsProblems.length ? 1 : 0;
