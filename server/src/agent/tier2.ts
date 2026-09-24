/**
 * Tier 2 灵活实体（F15a / C4）：entities(ns, data_json) 一行一实体 + namespaces 注册行。
 *
 * - 存储：复用单表 entities，零 DDL 零发版（每租户 sqlite 文件 × 动态建表的备份/漂移/迁移是灾难，
 *   设计稿 §4.5 已定案）；
 * - 过滤仍走 SQL 下沉：where 编译为 json_extract(data_json,'$.字段') = ? 参数化条件（C5 对 Tier 2 同样成立；
 *   node:sqlite 内置 JSON1，无需开关）；低频场景不做表达式索引（不够快再由 namespace 演进加）；
 * - 引用校验：refs 在应用层校验目标存在（SQLite 无法对 JSON 字段建 FK）；
 * - 演进规则：允许加字段（旧行 json_extract 返回 NULL 即自然缺省），禁止改类型/删字段/改名；
 * - 权限（设计稿红线 3/5）：运行期家长/孩子 agent 只有**只读消费**权；defineNamespace 是设计期执行器，
 *   不挂任何运行期 agent 工具（F15b 设计器 agent + 家长确认 UI 后才开放）；孩子侧 Tier 2 实体一律只读；
 * - 注册表真源：namespaces 行统一存**家长库**（Q3 结论：两库 schema 有意分形，不共享注册），
 *   scope 字段决定数据行落家长库还是各孩子库。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  coerceColumnsArg,
  coerceObjectArg,
  digitColHint,
  normalizeWriteRows,
  sqlVal,
  validateValue,
  writeAudit,
  renderRowsBudget,
  type ColumnSpec,
  type ReadableTableSpec,
  type TableSpec,
} from "./db-channel.js";

export const TIER2_ENTITIES_DDL = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  ns TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_entities_ns ON entities(ns);
`;

export const TIER2_NAMESPACES_DDL = `
CREATE TABLE IF NOT EXISTS namespaces (
  ns TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('parent','child')),
  label TEXT NOT NULL DEFAULT '',
  spec_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

/** 每次打开库即建（幂等）；namespaces 只在家长库 */
export function ensureTier2Schema(db: DatabaseSync, withNamespaces: boolean): void {
  db.exec(TIER2_ENTITIES_DDL);
  if (withNamespaces) db.exec(TIER2_NAMESPACES_DDL);
}

// ==================== namespace spec ====================

export interface NamespaceRef {
  /** data 字段 → Tier1 表.列：写侧校验值存在 */
  column: string;
  refTable: string;
  refColumn: string;
  desc?: string;
}

export interface NamespaceSpec {
  /** 数据字段定义（复用 ColumnSpec 语义；不含 id/created_at/updated_at 元列） */
  columns: Record<string, ColumnSpec>;
  insertRequired?: string[];
  /** 可过滤字段 ⊆ columns（json_extract 路径白名单；未登记字段不可作条件） */
  filterable?: string[];
  refs?: NamespaceRef[];
}

export interface NamespaceRow {
  ns: string;
  scope: "parent" | "child";
  label: string;
  spec: NamespaceSpec;
  version: number;
  /** active=生效（默认只返回这种）；pending=待家长确认；disabled=已停用 */
  status?: string;
}

const NS_NAME_RE = /^[a-z][a-z0-9_]{2,39}$/;
const KINDS = ["string", "number", "enum"];

function parseSpec(json: string): NamespaceSpec | null {
  try {
    const raw = JSON.parse(json) as NamespaceSpec;
    if (!raw || typeof raw !== "object" || !raw.columns || typeof raw.columns !== "object") return null;
    if (!Object.keys(raw.columns).length) return null;
    for (const [col, c] of Object.entries(raw.columns)) {
      if (!c || !KINDS.includes(c.kind) || typeof c.desc !== "string") return null;
      void col;
    }
    return raw;
  } catch {
    return null;
  }
}

/** 从家长库读 namespace 注册行（按 scope 过滤）。坏行跳过并告警，不阻塞其它 namespace。
 *  includePending=true 时附带待确认草案（数据管理 agent 的 describe 用；运行期读写面永远只认 active）。 */
export function loadNamespaces(
  pdb: DatabaseSync,
  scope: "parent" | "child",
  opts?: { includePending?: boolean }
): NamespaceRow[] {
  const statusSql = opts?.includePending ? "status IN ('active','pending')" : "status = 'active'";
  let rows: Array<Record<string, unknown>>;
  try {
    rows = pdb
      .prepare(`SELECT ns, scope, label, spec_json, version, status FROM namespaces WHERE ${statusSql} AND scope = ? ORDER BY ns`)
      .all(scope) as Array<Record<string, unknown>>;
  } catch {
    return []; // namespaces 表未建（老库未迁移）= 无 Tier 2
  }
  const out: NamespaceRow[] = [];
  for (const r of rows) {
    const spec = parseSpec(String(r.spec_json ?? "{}"));
    if (!spec) {
      console.warn(`[tier2] namespace ${r.ns} 的 spec_json 非法，已跳过`);
      continue;
    }
    out.push({
      ns: String(r.ns),
      scope: String(r.scope) as "parent" | "child",
      label: String(r.label ?? ""),
      spec,
      version: Number(r.version) || 1,
      status: String(r.status ?? "active"),
    });
  }
  return out;
}

export interface DefineNamespaceInput {
  ns: string;
  scope: "parent" | "child";
  label?: string;
  spec: NamespaceSpec;
}

/**
 * defineNamespace 执行器（设计期；F15b 才挂到设计器 agent + 家长确认 UI）。
 * 校验：命名规范 / 列定义 / filterable ⊆ columns / refs 目标表存在；
 * 演进：已存在时只允许**加字段**（同名字段类型必须一致），version 自增。
 * 返回 { ok, text }。
 */
export function defineNamespace(
  pdb: DatabaseSync,
  tier1Tables: Array<{ table: string }>,
  input: DefineNamespaceInput,
  opts?: { pending?: boolean }
): { ok: boolean; text: string } {
  const { ns, scope, spec } = input;
  const pending = opts?.pending === true;
  if (!NS_NAME_RE.test(ns)) {
    return { ok: false, text: `namespace 名 ${ns} 不合法（小写字母开头，3~40 位小写字母/数字/下划线）` };
  }
  const cols = spec.columns ?? {};
  const colNames = Object.keys(cols);
  if (!colNames.length) return { ok: false, text: "spec.columns 不能为空" };
  const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  for (const reserved of ["id", "created_at", "updated_at", "data"]) {
    if (reserved in cols) return { ok: false, text: `字段名 ${reserved} 是保留元列，不能用` };
  }
  for (const col of colNames) {
    // 字段名会成为 json_extract 路径与 SQL 别名的一部分，必须是无引号风险的标识符
    if (!FIELD_RE.test(col)) return { ok: false, text: `字段名 ${col} 不合法（字母/数字/下划线，字母或下划线开头，≤64 位）` };
  }
  for (const [col, c] of Object.entries(cols)) {
    if (!KINDS.includes(c.kind)) return { ok: false, text: `字段 ${col} 的 kind 非法（${KINDS.join("/")}）` };
    if (!c.desc?.trim()) return { ok: false, text: `字段 ${col} 缺 desc（模型靠它理解语义）` };
  }
  const filterable = spec.filterable ?? [];
  const badFilter = filterable.filter((f) => !(f in cols));
  if (badFilter.length) return { ok: false, text: `filterable 含未定义字段：${badFilter.join("、")}` };
  const t1 = new Set(tier1Tables.map((t) => t.table));
  for (const ref of spec.refs ?? []) {
    if (!(ref.column in cols)) return { ok: false, text: `refs 引用字段 ${ref.column} 未定义` };
    if (!t1.has(ref.refTable)) return { ok: false, text: `refs 目标表 ${ref.refTable} 未在 Tier 1 注册表登记` };
  }
  const json = JSON.stringify({ columns: cols, insertRequired: spec.insertRequired ?? [], filterable, refs: spec.refs ?? [] });
  pdb.exec("BEGIN");
  try {
    const existing = pdb.prepare("SELECT spec_json, version, status FROM namespaces WHERE ns = ?").get(ns) as
      | { spec_json: string; version: number; status: string }
      | undefined;
    if (existing) {
      if (pending) {
        pdb.exec("ROLLBACK");
        return {
          ok: false,
          text: `namespace ${ns} 已存在（${existing.status === "pending" ? "待确认草案" : existing.status === "active" ? "已生效" : "已停用"}）。` +
            `设计器只能新建场景；已有场景的调整请告知家长在「设置 → 自定义数据」处理，或换一个 ns 名。`,
        };
      }
      const old = parseSpec(existing.spec_json);
      if (!old) {
        pdb.exec("ROLLBACK");
        return { ok: false, text: `namespace ${ns} 已存在但旧 spec 损坏，需人工处理` };
      }
      // 演进规则：只允许加字段；同名字段 kind 必须一致（禁改类型/删字段）
      for (const [col, c] of Object.entries(old.columns)) {
        if (!(col in cols)) {
          pdb.exec("ROLLBACK");
          return { ok: false, text: `演进被拒：删除/改名已有字段 ${col} 不允许（改名=加新字段）` };
        }
        if (cols[col].kind !== c.kind) {
          pdb.exec("ROLLBACK");
          return { ok: false, text: `演进被拒：字段 ${col} 的 kind 不能改（${c.kind} → ${cols[col].kind}）` };
        }
      }
      pdb.prepare("UPDATE namespaces SET scope = ?, label = ?, spec_json = ?, version = version + 1, updated_at = datetime('now','localtime') WHERE ns = ?").run(
        scope,
        input.label ?? "",
        json,
        ns
      );
      pdb.exec("COMMIT");
      writeAudit(pdb, { table: `ns:${ns}`, op: "update", where: { ns }, rowCount: 1, summary: `defineNamespace 演进 ${ns}（v${existing.version + 1}）` });
      return { ok: true, text: `namespace ${ns} 已演进到 v${existing.version + 1}（只加字段）。` };
    }
    pdb.prepare(
      "INSERT INTO namespaces (ns, scope, label, spec_json, version, status) VALUES (?, ?, ?, ?, 1, ?)"
    ).run(ns, scope, input.label ?? "", json, pending ? "pending" : "active");
    pdb.exec("COMMIT");
    writeAudit(pdb, {
      table: `ns:${ns}`,
      op: "insert",
      where: { ns },
      rowCount: 1,
      summary: pending
        ? `defineNamespace 提交草案 ${ns}（scope=${scope}，待家长确认）`
        : `defineNamespace 新建 ${ns}（scope=${scope}）`,
    });
    return {
      ok: true,
      text: pending
        ? `草案 ns:${ns}（scope=${scope}，${colNames.length} 字段）已提交，**待家长在「设置 → 自定义数据」确认后生效**。` +
          `生效前任何 agent 都查不到也写不进这个实体。请告知家长去确认。`
        : `namespace ${ns} 已创建（scope=${scope}，${colNames.length} 字段）。`,
    };
  } catch (e) {
    try {
      pdb.exec("ROLLBACK");
    } catch {
      /* 已回滚 */
    }
    return { ok: false, text: `defineNamespace 失败：${(e as Error).message}` };
  }
}

// ==================== 生命周期：确认 / 拒绝 / 停用 / 启用（家长确认关，F15b） ====================

/** 确认草案：pending → active（再校验一次 spec 可解析）。 */
export function confirmNamespace(pdb: DatabaseSync, ns: string): { ok: boolean; text: string } {
  const row = pdb.prepare("SELECT status, spec_json FROM namespaces WHERE ns = ?").get(ns) as
    | { status: string; spec_json: string }
    | undefined;
  if (!row) return { ok: false, text: `namespace ${ns} 不存在` };
  if (row.status !== "pending") return { ok: false, text: `namespace ${ns} 状态为 ${row.status}，无需确认` };
  if (!parseSpec(row.spec_json)) return { ok: false, text: `namespace ${ns} 的 spec 损坏，请拒绝后重新提交` };
  pdb.prepare("UPDATE namespaces SET status = 'active', updated_at = datetime('now','localtime') WHERE ns = ?").run(ns);
  writeAudit(pdb, { table: `ns:${ns}`, op: "update", where: { ns, action: "confirm" }, rowCount: 1, summary: `家长确认生效 ${ns}` });
  return { ok: true, text: `ns:${ns} 已生效，所有 agent 立即可用。` };
}

/** 拒绝草案：pending → 删除该行。 */
export function rejectNamespace(pdb: DatabaseSync, ns: string): { ok: boolean; text: string } {
  const row = pdb.prepare("SELECT status FROM namespaces WHERE ns = ?").get(ns) as { status: string } | undefined;
  if (!row) return { ok: false, text: `namespace ${ns} 不存在` };
  if (row.status !== "pending") return { ok: false, text: `namespace ${ns} 不是待确认草案（当前 ${row.status}），不能拒绝；如需下线请停用` };
  pdb.prepare("DELETE FROM namespaces WHERE ns = ?").run(ns);
  writeAudit(pdb, { table: `ns:${ns}`, op: "delete", where: { ns, action: "reject" }, rowCount: 1, summary: `家长拒绝草案 ${ns}` });
  return { ok: true, text: `草案 ns:${ns} 已拒绝并删除。` };
}

/** 停用/启用已生效的 namespace（停用后 loadNamespaces 不再返回，运行期 agent 立即不可见）。 */
export function setNamespaceStatus(
  pdb: DatabaseSync,
  ns: string,
  status: "active" | "disabled"
): { ok: boolean; text: string } {
  const row = pdb.prepare("SELECT status FROM namespaces WHERE ns = ?").get(ns) as { status: string } | undefined;
  if (!row) return { ok: false, text: `namespace ${ns} 不存在` };
  if (row.status === "pending") return { ok: false, text: `namespace ${ns} 是待确认草案，请先确认或拒绝` };
  if (row.status === status) return { ok: true, text: `ns:${ns} 已经是 ${status} 状态。` };
  pdb.prepare("UPDATE namespaces SET status = ?, updated_at = datetime('now','localtime') WHERE ns = ?").run(status, ns);
  writeAudit(pdb, {
    table: `ns:${ns}`,
    op: "update",
    where: { ns, action: status },
    rowCount: 1,
    summary: `家长${status === "disabled" ? "停用" : "启用"} ${ns}`,
  });
  return { ok: true, text: `ns:${ns} 已${status === "disabled" ? "停用" : "启用"}。` };
}

// ==================== 读 ====================

const NS_META_COLS = ["id", "created_at", "updated_at"] as const;
const T2_READ_DEFAULT_LIMIT = 50;
const T2_READ_MAX_LIMIT = 200;

/** JSON 路径字面量：字段名已在 defineNamespace 校验为安全标识符；用单引号（该 SQLite 构建禁用双引号字符串兜底） */
const jsonPath = (field: string): string => `json_extract(data_json, '$.${field}')`;

function nsColSql(ns: NamespaceRow, col: string): string | null {
  if ((NS_META_COLS as readonly string[]).includes(col)) return col;
  if (col === "data") return "data_json";
  if (col in ns.spec.columns) return `${jsonPath(col)} AS "${col}"`;
  return null;
}

/** Tier 2 受控读（语义与 executeRead 对齐：预算/截断/countOnly/自愈） */
export function tier2Read(db: DatabaseSync, ns: NamespaceRow, req: { columns?: unknown; where?: unknown; orderBy?: string; orderDesc?: boolean; limit?: number; offset?: number; countOnly?: boolean }): { ok: boolean; text: string } {
  // ISSUE-133：字符串化参数先归一
  const whereArg = coerceObjectArg(req.where, "where");
  if (whereArg.error) return { ok: false, text: whereArg.error };
  const colsArg = coerceColumnsArg(req.columns);
  if (colsArg.error) return { ok: false, text: colsArg.error };
  const reqCols = colsArg.value;
  const dataCols = Object.keys(ns.spec.columns);
  const allCols = [...NS_META_COLS, "data", ...dataCols];
  let cols = ["id", "data", "created_at", "updated_at"];
  if (reqCols?.length) {
    const unknown = reqCols.filter((c) => !nsColSql(ns, c));
    if (unknown.length) {
      return { ok: false, text: `字段未登记不可读：${unknown.join("、")}。ns:${ns.ns} 可用字段：${allCols.join("、")}` };
    }
    cols = reqCols;
  }
  const whereEntries = Object.entries(whereArg.value).filter(([, v]) => v !== undefined && v !== null && String(v) !== "");
  const whereSqlParts: string[] = [];
  const whereVals: Array<null | number | bigint | string> = [];
  for (const [col, value] of whereEntries) {
    if ((NS_META_COLS as readonly string[]).includes(col)) {
      whereSqlParts.push(`${col} = ?`);
      whereVals.push(sqlVal(value));
    } else if (col in ns.spec.columns) {
      whereSqlParts.push(`${jsonPath(col)} = ?`);
      whereVals.push(sqlVal(value));
    } else {
      return { ok: false, text: `where 条件字段 ${col} 未登记。ns:${ns.ns} 可用字段：${allCols.join("、")}` };
    }
  }
  const whereSql = whereSqlParts.length ? ` AND ${whereSqlParts.join(" AND ")}` : "";
  let orderSql = "";
  if (req.orderBy) {
    // ORDER BY 不能用带 AS 的 SELECT 别名表达式，用裸 json 路径
    const ob = (NS_META_COLS as readonly string[]).includes(req.orderBy)
      ? req.orderBy
      : req.orderBy in ns.spec.columns
        ? jsonPath(req.orderBy)
        : null;
    if (!ob) return { ok: false, text: `排序字段 ${req.orderBy} 未登记（可用：${allCols.join("、")}）` };
    orderSql = ` ORDER BY ${ob} ${req.orderDesc ? "DESC" : "ASC"}`;
  }
  const limit = Math.max(1, Math.min(Number(req.limit) || T2_READ_DEFAULT_LIMIT, T2_READ_MAX_LIMIT));
  const offset = Math.max(0, Math.floor(Number(req.offset) || 0));

  if (req.countOnly) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM entities WHERE ns = ?${whereSql}`).get(ns.ns, ...whereVals) as { n: number }).n;
    return { ok: true, text: `ns:${ns.ns}（${ns.label}）：命中 ${n} 行。` };
  }

  const selectSql = cols.map((c) => nsColSql(ns, c)).join(", ");
  const sql = `SELECT ${selectSql} FROM entities WHERE ns = ?${whereSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`;
  const rawRows = db.prepare(sql).all(ns.ns, ...whereVals) as Array<Record<string, unknown>>;
  if (!rawRows.length) {
    // F2 自愈：空结果给可过滤字段的实际取值样例
    const samples: string[] = [];
    for (const [col] of whereEntries) {
      if (col in ns.spec.columns) {
        try {
          const vals = db
            .prepare(`SELECT DISTINCT ${jsonPath(col)} FROM entities WHERE ns = ? AND ${jsonPath(col)} IS NOT NULL LIMIT 5`)
            .all(ns.ns) as Array<Record<string, unknown>>;
          samples.push(`${col} 实际取值样例：${vals.map((r) => JSON.stringify(Object.values(r)[0])).join("、") || "（无非空值）"}`);
        } catch {
          /* 忽略 */
        }
      }
    }
    return { ok: true, text: `ns:${ns.ns}（${ns.label}）：查询结果为空。${samples.length ? `\n${samples.join("\n")}` : ""}` };
  }
  const rows = rawRows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    if (typeof out.data === "string") {
      try {
        out.data = JSON.parse(out.data);
      } catch {
        /* 保持原文 */
      }
    }
    return out;
  });
  const [body, truncated, returned] = renderRowsBudget(rows);
  if (truncated) {
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM entities WHERE ns = ?${whereSql}`).get(ns.ns, ...whereVals) as { n: number }).n;
    return {
      ok: true,
      text: `ns:${ns.ns}（${ns.label}）：已返前 ${returned} 行 / 共 ${total} 行（超字符预算截断）。请收窄 where 或用 columns 选字段。\n${body}`,
    };
  }
  return { ok: true, text: `ns:${ns.ns}（${ns.label}）：${rows.length} 行\n${body}` };
}

/** Tier 2 单 namespace 的 describe 输出（§6.3：Tier 2 元数据出口） */
export function describeNamespace(ns: NamespaceRow): string {
  const statusText = ns.status === "pending" ? "【待家长确认——生效前任何 agent 不可见】" : ns.status === "disabled" ? "【已停用】" : "";
  const lines = [
    `## ns:${ns.ns}（${ns.label}）【Tier 2 灵活实体 · scope=${ns.scope} · v${ns.version}】${statusText}`,
    `存于 entities(ns='${ns.ns}')，data_json 一行一实体；家长侧用 parent_db_read 以 table="ns:${ns.ns}" 读取（孩子侧当前无通用读工具，见 ISSUE-142）。`,
    "字段：",
  ];
  for (const [col, c] of Object.entries(ns.spec.columns)) {
    const kind = c.kind === "enum" ? `枚举 ${c.enumValues?.join("/") ?? ""}` : c.kind + (c.maxLen ? `(≤${c.maxLen}字)` : "");
    lines.push(`- ${col}：${kind}，${c.desc}${ns.spec.insertRequired?.includes(col) ? "（insert 必填）" : ""}${c.confirm ? "（⚠写入后须复述）" : ""}`);
  }
  if (ns.spec.refs?.length) {
    lines.push(`引用校验：${ns.spec.refs.map((r) => `${r.column} 须存在于 ${r.refTable}.${r.refColumn}`).join("；")}`);
  }
  lines.push(`可过滤：${(ns.spec.filterable ?? []).join("、") || "（无，仅元列 id/created_at/updated_at 可条件）"}`);
  lines.push("元列：id / created_at / updated_at / data（整行 JSON）");
  return lines.join("\n");
}

/** Tier 2 → 只读面（并入注册表清单 / prompt 元数据） */
export function tier2AsReadable(rows: NamespaceRow[]): ReadableTableSpec[] {
  return rows.map((ns) => ({
    table: `ns:${ns.ns}`,
    label: ns.label || ns.ns,
    desc: `灵活实体（Tier 2，v${ns.version}）：${Object.keys(ns.spec.columns).join("、")}`,
    columns: Object.fromEntries(
      Object.entries(ns.spec.columns).map(([col, c]) => [col, `${c.kind}：${c.desc}`])
    ),
  }));
}

/** Tier 2 → 写面描述（仅 scope=parent 且显式 writable 时并入；当前 v1 家长可写、孩子只读） */
export function tier2AsTableSpecs(rows: NamespaceRow[]): TableSpec[] {
  return rows.map((ns) => ({
    table: `ns:${ns.ns}`,
    label: ns.label || ns.ns,
    desc: `灵活实体（Tier 2）`,
    ops: ["insert", "update", "delete"] as Array<"insert" | "update" | "delete">,
    rowLimit: 50,
    pk: ["id"],
    serverGenerated: ["id"],
    columns: ns.spec.columns,
  }));
}

// ==================== 写（仅家长侧工具接入；孩子侧 Tier 2 一律只读） ====================

export interface Tier2WriteRequest {
  op: "insert" | "update" | "delete";
  /** insert=行数组（字段=spec.columns）；update=要写的字段值对象。
   *  ISSUE-122：两种形状执行器都兼容（数组 update 取首元素、对象 insert 视为单行）。
   *  ISSUE-133：也兼容被整串 JSON 序列化的字符串形态。 */
  rows?: unknown;
  /** update/delete 必填：id 或可过滤字段等值条件（同样兼容字符串化 JSON） */
  where?: unknown;
}

/** refs 应用层校验：value 必须存在于 Tier1 表.列（SQLite 无法对 JSON 字段建 FK） */
function checkNsRefs(db: DatabaseSync, ns: NamespaceRow, merged: Record<string, unknown>): string | null {
  for (const ref of ns.spec.refs ?? []) {
    if (!(ref.column in merged)) continue;
    const v = merged[ref.column];
    if (v === null || v === undefined || v === "") continue;
    try {
      const hit = db.prepare(`SELECT 1 FROM ${ref.refTable} WHERE ${ref.refColumn} = ?`).get(sqlVal(v));
      if (!hit) {
        return `引用校验失败：字段 ${ref.column} 的值 ${JSON.stringify(v)} 在 ${ref.refTable}.${ref.refColumn} 中不存在`;
      }
    } catch {
      return `引用校验失败：目标表 ${ref.refTable} 不可达`;
    }
  }
  return null;
}

/** Tier 2 受控写（事务 + 审计，语义对齐 executeWrite；where 条件字段须在 filterable ∪ {id}） */
export function tier2Write(db: DatabaseSync, ns: NamespaceRow, req: Tier2WriteRequest): { ok: boolean; text: string } {
  const spec = ns.spec;
  const colNames = Object.keys(spec.columns);
  const filterable = new Set([...(spec.filterable ?? []), "id"]);
  const fail = (text: string) => ({ ok: false, text });
  // ISSUE-133：字符串化参数先归一
  const whereArg = coerceObjectArg(req.where, "where");
  if (whereArg.error) return fail(whereArg.error);
  const whereEntries = Object.entries(whereArg.value).filter(([, v]) => v !== undefined && v !== null && String(v) !== "");

  if (req.op !== "insert" && !whereEntries.length) return fail("update/delete 必须带 where 等值条件（防全表操作）");
  for (const [col] of whereEntries) {
    if (!filterable.has(col)) {
      return fail(`where 条件字段 ${col} 不允许（update/delete 条件字段限 id 与 filterable：${[...filterable].join("、")}）`);
    }
  }

  const whereSql = whereEntries.length
    ? ` AND ${whereEntries
        .map(([c]) => (c === "id" ? "id = ?" : `json_extract(data_json, '$.${c}') = ?`))
        .join(" AND ")}`
    : "";
  const whereVals = whereEntries.map(([, v]) => sqlVal(v));
  const confirmHints: string[] = [];

  db.exec("BEGIN");
  try {
    let affected = 0;
    if (req.op === "insert") {
      const { list, error } = normalizeWriteRows("insert", req.rows);
      if (error) return withRollback(error);
      const rows = list;
      if (!rows.length) return withRollback("insert 需要至少一行 rows");
      if (rows.length > 50) return withRollback("一次最多插入 50 行");
      const ins = db.prepare(
        "INSERT INTO entities (id, ns, data_json) VALUES (?, ?, ?)"
      );
      for (const raw of rows) {
        const merged: Record<string, unknown> = {};
        for (const [col, value] of Object.entries(raw)) {
          const c = spec.columns[col];
          if (!c) return withRollback(`字段 ${col} 未登记。ns:${ns.ns} 可用字段：${colNames.join("、")}`);
          const err = validateValue(col, c, value);
          if (err) return withRollback(err);
          if (c.confirm) confirmHints.push(c.desc);
          merged[col] = value;
        }
        for (const col of spec.insertRequired ?? []) {
          const v = merged[col];
          if (v === undefined || v === null || String(v).trim() === "") {
            return withRollback(`insert 必填字段 ${col} 缺失`);
          }
        }
        const refErr = checkNsRefs(db, ns, merged);
        if (refErr) return withRollback(refErr);
        ins.run(randomUUID(), ns.ns, JSON.stringify(merged));
        affected++;
      }
    } else {
      // 预览影响行数（与 executeWrite 同语义：先 COUNT 再执行）
      const cntRow = db
        .prepare(`SELECT COUNT(*) AS n FROM entities WHERE ns = ?${whereSql}`)
        .get(ns.ns, ...whereVals) as { n: number };
      if (cntRow.n === 0) return withRollback("where 未命中任何行（可用字段取值请先 read 确认）");
      if (cntRow.n > 50) return withRollback(`where 命中 ${cntRow.n} 行，超过单次 50 行熔断`);
      if (req.op === "update") {
        const { values, error } = normalizeWriteRows("update", req.rows);
        if (error) return withRollback(error);
        const sets = Object.entries(values);
        if (!sets.length) return withRollback("update 需要提供要写入的字段值对象（rows）");
        for (const [col, value] of sets) {
          const c = spec.columns[col];
          if (!c) return withRollback(`字段 ${col} 未登记。ns:${ns.ns} 可用字段：${colNames.join("、")}${digitColHint(col)}`);
          const err = validateValue(col, c, value);
          if (err) return withRollback(err);
          if (c.confirm) confirmHints.push(c.desc);
        }
        // 引用校验针对「改后」的行：先取出命中行合并新值再校验
        const hitRows = db
          .prepare(`SELECT id, data_json FROM entities WHERE ns = ?${whereSql}`)
          .all(ns.ns, ...whereVals) as Array<{ id: string; data_json: string }>;
        for (const h of hitRows) {
          let old: Record<string, unknown> = {};
          try {
            old = JSON.parse(h.data_json || "{}");
          } catch {
            /* 坏行当空 */
          }
          const refErr = checkNsRefs(db, ns, { ...old, ...Object.fromEntries(sets) });
          if (refErr) return withRollback(refErr);
        }
        const setSql = sets
          .map(([c]) => `data_json = json_set(data_json, '$.${c}', json(?))`)
          .join(", ");
        db.prepare(
          `UPDATE entities SET ${setSql}, updated_at = datetime('now','localtime') WHERE ns = ?${whereSql}`
        ).run(...sets.map(([, v]) => JSON.stringify(v)), ns.ns, ...whereVals);
      } else {
        db.prepare(`DELETE FROM entities WHERE ns = ?${whereSql}`).run(ns.ns, ...whereVals);
      }
      affected = cntRow.n;
    }

    writeAudit(db, {
      table: `ns:${ns.ns}`,
      op: req.op,
      where: whereArg.value,
      rowCount: affected,
      summary: `agent ${req.op} ns:${ns.ns}：${affected} 行`,
    });
    db.exec("COMMIT");
    let text = `${req.op} ns:${ns.ns} 成功：影响 ${affected} 行。`;
    if (confirmHints.length) {
      text += `\n\n⚠️ 本次写入了敏感字段（${[...new Set(confirmHints)].join("；")}），请向家长逐条复述改动内容。`;
    }
    text += `\n（已写入审计 db_audit，可在家长操作记录中追溯）`;
    return { ok: true, text };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 已回滚 */
    }
    return { ok: false, text: `执行失败（已回滚）：${(e as Error).message}` };
  }

  function withRollback(text: string): { ok: boolean; text: string } {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 已回滚 */
    }
    return fail(text);
  }
}
