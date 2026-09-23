/**
 * 家长 agent 受控数据通道（ISSUE-105 方案 B，P1）。
 *
 * 目标：终结「一个新场景加一个工具」——对单表数据的简单读写，由**表注册表**声明、
 * 两个通用工具（describe / write）执行；agent 永远不写 SQL 字符串，只给表名/操作/行数据。
 *
 * 安全模型（详见 ISSUE-105 权限矩阵）：
 * - 连接不经过参数：db 由调用方（parent-tools.ts）按 token 解出的 parentId 打开 parent.sqlite；
 * - 列白名单：未在本模块登记的列不可读写（id/时间戳/迁移列天然挡在外面）；
 * - update/delete 必须带 where（等值条件，且全部命中登记列），先 SELECT 预览影响行数再执行；
 * - 行数熔断 rowLimit；全部走事务；每笔写留 db_audit 审计（家长库内，随库备份）；
 * - confirm 列：写入成功后提示 agent 必须向家长复述（如 question_bank.answer）。
 *
 * 本模块刻意**不依赖 agent 框架**（纯函数 + DatabaseSync），便于 vitest 直测。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { embeddedColumn } from "./embeddings.js";

// ==================== 注册表类型 ====================

export type ColumnKind = "string" | "number" | "enum";

export interface ColumnSpec {
  kind: ColumnKind;
  desc: string;
  maxLen?: number;
  min?: number;
  max?: number;
  int?: boolean;
  enumValues?: string[];
  /** 不允许空串/纯空白 */
  notEmpty?: boolean;
  /** 写入成功后要求 agent 向家长复述（影响判定结果的字段） */
  confirm?: boolean;
}

export interface RefCheck {
  /** 本表列 → 目标表.列：insert/update 时校验值在目标表存在 */
  column: string;
  refTable: string;
  refColumn: string;
  desc: string;
}

/** 读侧可见的关系边（F13）：由 refChecks 派生，读写共用同一份关系声明 */
export interface RefEdge {
  column: string;
  refTable: string;
  refColumn: string;
  desc: string;
  /** 关系基数提示（校验不依赖） */
  kind?: "many-to-one" | "one-to-many";
}

export interface TableSpec {
  /** 库内真实表名 */
  table: string;
  label: string;
  /** 一句话用途（describe 输出） */
  desc: string;
  /** 允许的写操作；空数组 = 纯只读表（F14：读面登记 ≠ 开放写） */
  ops: Array<"insert" | "update" | "delete">;
  /** 单次调用影响行数上限 */
  rowLimit: number;
  /** 主键列（insert 必填说明 / where 提示用）；主键由服务端生成时放 serverGenerated */
  pk: string[];
  /** 服务端生成的列（insert 时 agent 给了也忽略） */
  serverGenerated?: string[];
  /** insert 必填列 */
  insertRequired?: string[];
  /** 跨表引用校验（insert/update） */
  refChecks?: RefCheck[];
  /** insert 前的跨列校验，返回错误文案或 null */
  insertInvariant?: (row: Record<string, unknown>) => string | null;
  /** update 时自动 touch updated_at 列（仅 question_bank 有此列） */
  touchUpdatedAt?: boolean;
  columns: Record<string, ColumnSpec>;
  /** 只读列（服务端生成 id/uuid/时间戳/系统域 JSON）：读面可见，写面拒绝（F14 补漂移列用） */
  readOnlyColumns?: Record<string, string>;
}

/** 读侧可见表声明（派生自 TableSpec，含只读列与关系边） */
export interface ReadableTableSpec {
  table: string;
  label: string;
  desc: string;
  /** 可读列 → 含义（写列 + 只读列合并） */
  columns: Record<string, string>;
  /** 关系边（F13） */
  refs?: RefEdge[];
  /** 该表参与的命名路径名（反向索引，F10 填充） */
  paths?: string[];
}

/** TableSpec[] → 只读面（单一派生真源：家长库与孩子库共用，消灭手写第二份） */
export function readableFromSpecs(specs: TableSpec[]): ReadableTableSpec[] {
  return specs.map((s) => ({
    table: s.table,
    label: s.label,
    desc: s.desc,
    columns: {
      ...(s.readOnlyColumns ?? {}),
      ...Object.fromEntries(
        Object.entries(s.columns).map(([col, c]) => {
          const kind =
            c.kind === "enum" ? `枚举 ${c.enumValues!.join("/")}` : c.kind + (c.maxLen ? `(≤${c.maxLen}字)` : "");
          const flags = [c.notEmpty === false ? "可空" : "必填", c.confirm ? "⚠写入后须向家长复述" : ""]
            .filter(Boolean)
            .join("，");
          return [col, `${kind}：${c.desc}（${flags}）`];
        })
      ),
    },
    refs: s.refChecks?.map((r) => ({ column: r.column, refTable: r.refTable, refColumn: r.refColumn, desc: r.desc })),
  }));
}

// ==================== 家长内容库（parent.sqlite）首批登记表 ====================

const str = (desc: string, maxLen = 4000, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({
  kind: "string",
  desc,
  maxLen,
  notEmpty: true,
  ...extra,
});

export function parentLibTableRegistry(): TableSpec[] {
  return [
    {
      table: "topics",
      label: "教学主题",
      desc: "主题目录（如 lunyu 论语）；topic_key 是各处引用的主题标识",
      ops: ["insert", "update", "delete"],
      rowLimit: 20,
      pk: ["name"],
      insertRequired: ["name", "topic_key"],
      columns: {
        name: str("主题名（主键，如 论语）", 100),
        topic_key: str("主题标识（如 lunyu，小写字母/数字）", 60),
        method: str("学习方法描述", 8000, { notEmpty: false }),
        assess_method: str("考核方法描述", 8000, { notEmpty: false }),
        progress: str("学习进度备注", 2000, { notEmpty: false }),
        rules_json: str("规则 JSON 文本（不确定别改）", 8000, { notEmpty: false, confirm: true }),
      },
      readOnlyColumns: {
        method_spec: "考核方法 spec JSON（按孩子区分，系统域，经考核设置流程写入）",
      },
    },
    {
      table: "courses",
      label: "课程",
      desc: "主题下的课程（纯课程内容）；主键 (topic, title)，topic 存主题标识（=topics.topic_key）；学习进度在孩子库，这里没有 status 字段",
      ops: ["insert", "update", "delete"],
      rowLimit: 50,
      pk: ["topic", "title"],
      insertRequired: ["topic", "title"],
      // F13 修正：courses.topic 实际存 topic_key（实测 1317/1317 命中），旧声明 topics.name 全部误拒
      refChecks: [{ column: "topic", refTable: "topics", refColumn: "topic_key", desc: "主题不存在" }],
      columns: {
        topic: str("所属主题标识（=topics.topic_key）", 100),
        title: str("课程名", 200),
        sort_order: { kind: "number", desc: "排序序号", int: true, min: 0, max: 100000 },
        material: str("资料路径/说明", 2000, { notEmpty: false }),
        send_material: str("下发资料说明", 2000, { notEmpty: false }),
        tags: str("标签（顿号分隔）", 500, { notEmpty: false }),
        lesson_method: str("课程教法", 8000, { notEmpty: false }),
        html_path: str("HTML 资料路径", 1000, { notEmpty: false }),
        teaching_copy: str("教学文稿", 20000, { notEmpty: false }),
        assess_rubric: str("考核评分标准", 8000, { notEmpty: false }),
      },
      readOnlyColumns: {
        uuid: "课程 uuid（服务端生成；知识点/挂载桥/计划表引用它）",
      },
    },
    {
      table: "tags",
      label: "标签",
      desc: "全局标签维度定义",
      ops: ["insert", "update", "delete"],
      rowLimit: 20,
      pk: ["tag"],
      insertRequired: ["tag"],
      columns: {
        tag: str("标签名（主键）", 100),
        dimension: str("所属维度", 100, { notEmpty: false }),
        criteria: str("打标标准", 2000, { notEmpty: false }),
      },
    },
    {
      table: "question_bank",
      label: "题库题",
      desc: "题库真源；一道题可被多课/多知识点挂载，改动全局生效",
      ops: ["insert", "update", "delete"],
      rowLimit: 100,
      pk: ["id"],
      serverGenerated: ["id"],
      insertRequired: ["stem", "answer"],
      insertInvariant: (row) => {
        const behavior = String(row.behavior ?? "generic");
        if (behavior !== "generic" && !String(row.answer ?? "").trim()) {
          return "behavior 为背诵/朗读题时 answer 必填（标准原文）";
        }
        return null;
      },
      touchUpdatedAt: true,
      columns: {
        stem: str("题干", 2000),
        answer: str("标准答案；背诵/朗读题为原文", 8000, { confirm: true }),
        scoring: str("评分说明或 JSON", 4000, { notEmpty: false }),
        point_max: { kind: "number", desc: "满分（缺省 10）", int: true, min: 1, max: 1000 },
        behavior: {
          kind: "enum",
          desc: "题目行为",
          enumValues: ["generic", "speech_recite", "speech_read"],
        },
        note: str("备注", 2000, { notEmpty: false }),
        knowledge_summary: str("知识点概要", 500, { notEmpty: false }),
        options: str(
          '选择题选项 JSON 文本，如 [{"key":"A","text":"..."}]；非选择题保持 []',
          8000,
          { notEmpty: false, confirm: true }
        ),
      },
      readOnlyColumns: {
        id: "题目 id（服务端生成；挂载桥引用它）",
        created_at: "创建时间",
        updated_at: "更新时间",
      },
    },
    {
      table: "knowledge_points",
      label: "知识点",
      desc: "每课的考核要点； UNIQUE(course_uuid, name)，course_uuid 必须是 courses.uuid 已有值",
      ops: ["insert", "update", "delete"],
      rowLimit: 100,
      pk: ["id"],
      serverGenerated: ["id"],
      insertRequired: ["course_uuid", "name"],
      refChecks: [
        { column: "course_uuid", refTable: "courses", refColumn: "uuid", desc: "课程不存在（course_uuid 须取自 courses.uuid）" },
      ],
      columns: {
        course_uuid: str("所属课程 uuid（courses.uuid）", 64),
        name: str("知识点名", 200),
        detail: str("知识点详情（教学内容/考核要点）", 8000, { notEmpty: false }),
        seq: { kind: "number", desc: "展示顺序", int: true, min: 0, max: 100000 },
      },
      readOnlyColumns: {
        id: "知识点 id（服务端生成；挂载桥引用它）",
      },
    },
    {
      table: "course_knowledge_questions",
      label: "课程-知识点-题目挂载",
      desc: "把题挂到知识点下；复合主键 (course_id, knowledge_point_id, question_id)，重复插入=冲突报错",
      ops: ["insert", "update", "delete"],
      rowLimit: 200,
      pk: ["course_id", "knowledge_point_id", "question_id"],
      insertRequired: ["course_id", "knowledge_point_id", "question_id"],
      refChecks: [
        { column: "course_id", refTable: "courses", refColumn: "uuid", desc: "课程不存在" },
        { column: "knowledge_point_id", refTable: "knowledge_points", refColumn: "id", desc: "知识点不存在" },
        { column: "question_id", refTable: "question_bank", refColumn: "id", desc: "题库题不存在" },
      ],
      columns: {
        course_id: str("课程 uuid", 64),
        knowledge_point_id: str("知识点 id", 64),
        question_id: str("题库题 id", 64),
        seq: { kind: "number", desc: "该知识点下展示顺序", int: true, min: 0, max: 100000 },
        overview: str("挂载说明", 2000, { notEmpty: false }),
      },
    },
  ];
}

// ==================== 审计 ====================

const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS db_audit (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  table_name TEXT NOT NULL,
  op TEXT NOT NULL,
  where_json TEXT NOT NULL DEFAULT '{}',
  row_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT ''
);
`;

function ensureAudit(db: DatabaseSync): void {
  db.exec(AUDIT_SCHEMA);
}

export function writeAudit(
  db: DatabaseSync,
  entry: { table: string; op: string; where: Record<string, unknown>; rowCount: number; summary: string }
): void {
  ensureAudit(db);
  db.prepare("INSERT INTO db_audit (id, table_name, op, where_json, row_count, summary) VALUES (?, ?, ?, ?, ?, ?)").run(
    randomUUID(),
    entry.table,
    entry.op,
    JSON.stringify(entry.where),
    entry.rowCount,
    entry.summary
  );
}

// ==================== 内部控制流 ====================

/** write 过程中的受控失败：抛出以保证事务统一 ROLLBACK */
class ChannelError extends Error {}

function fail(text: string): never {
  throw new ChannelError(text);
}

/** 本地时间 YYYY-MM-DD HH:MM:SS（serverGenerated 时间戳列的填充值） */
function localDatetime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** LLM 传入值 → node:sqlite 可存类型（null/number/bigint/string/Uint8Array） */
export function sqlVal(v: unknown): null | number | bigint | string {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "bigint") return v as string | number | bigint;
  if (t === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

// ==================== describe ====================

export function describeTables(specs: TableSpec[], table?: string): string {
  const list = table ? specs.filter((s) => s.table === table) : specs;
  if (!list.length) {
    return (
      `没有登记名为「${table}」的表。可用的表：\n` +
      specs.map((s) => `- ${s.table}（${s.label}）：${s.desc}`).join("\n")
    );
  }
  const out: string[] = [];
  for (const s of list) {
    out.push(`## ${s.table}（${s.label}）\n${s.desc}\n允许操作：${s.ops.join(" / ")}；单次最多影响 ${s.rowLimit} 行`);
    out.push(`主键：${s.pk.join(" + ")}`);
    if (s.serverGenerated?.length) out.push(`服务端自动生成的列（插入时无需给，给了也忽略）：${s.serverGenerated.join("、")}`);
    out.push("列：");
    for (const [col, c] of Object.entries(s.columns)) {
      const kind = c.kind === "enum" ? `枚举 ${c.enumValues!.join("/")}` : c.kind + (c.maxLen ? `(≤${c.maxLen}字)` : "");
      const flags = [c.notEmpty === false ? "可空" : "必填", c.confirm ? "⚠️写入后须向家长复述" : ""].filter(Boolean).join("，");
      out.push(`- ${col}：${kind}，${c.desc}（${flags}）`);
    }
    if (s.insertRequired?.length) out.push(`insert 必填：${s.insertRequired.join("、")}`);
    if (s.refChecks?.length) out.push(`引用校验：${s.refChecks.map((r) => `${r.column} 须存在于 ${r.refTable}.${r.refColumn}`).join("；")}`);
  }
  return out.join("\n\n");
}

// ==================== write ====================

export interface WriteRequest {
  table: string;
  op: "insert" | "update" | "delete";
  /** insert=要插入的行数组；update=要写入的列值对象（{列: 新值}）。
   *  ISSUE-122：两种形状执行器都兼容——历史上 schema 只许数组、说明却要求 update 传对象，
   *  自相矛盾导致 update 恒报「列 0 未登记」（数组下标被当列名）。
   *  ISSUE-133：类型放宽为 unknown——工具 schema 已放行「JSON 字符串」分支，执行器入口统一归一。 */
  rows?: unknown;
  /** update/delete 的等值条件（列名→值），必须命中登记列；delete/update 必填 */
  where?: unknown;
  /** 服务端强制列值（insert 时覆盖 agent 传的同名列，如孩子身份），绕不过 */
  force?: Record<string, unknown>;
}

// ==================== ISSUE-133：JSON 字符串参数归一 ====================

/**
 * ISSUE-133（2026-09-22）：参数被**整串 JSON 序列化**后的兼容解析。
 *
 * 现场：模型把 `rows` 传成字符串 `"[{\"status\":\"done\",\"result\":\"done\"}]"`。
 * 为什么在**校验层**就硬失败：SDK（`pi-ai/dist/utils/validation.js`）先跑 TypeBox 的
 * `Value.Convert`，而它只做标量转换（"20"→20、"true"→true），**不会**把字符串 parse 回
 * 对象/数组；于是 `rows: must be array / must be object / must match a schema in anyOf`
 * 三条一起报，工具连执行器都没进——模型只看到一句 schema 报错，无法自愈重试。
 *
 * 治本两层（与 ISSUE-122 同思路：纯 schema 修复不够，执行器兜底才是治本）：
 * ① 工具 schema 显式接受 string 分支（见 tool-shapes.ts）→ 校验放行；
 * ② 执行器入口统一 parse 回结构（本函数）→ 语义不受影响，parse 不了给可读原因，绝不静默。
 */
export function parseJsonArg(raw: unknown, label: string): { value: unknown; error?: string } {
  if (typeof raw !== "string") return { value: raw };
  const s = raw.trim();
  if (!s) return { value: undefined };
  try {
    return { value: JSON.parse(s) };
  } catch {
    return {
      value: undefined,
      error:
        `${label} 收到的是字符串但不是合法 JSON：${s.slice(0, 120)}${s.length > 120 ? "…" : ""}\n` +
        "请把对象/数组**直接**作为参数结构传入，不要传 JSON 序列化后的文本。",
    };
  }
}

/** 归一「{列: 值} 对象」类参数（where / rows 的 update 形状）。支持字符串化形态。 */
export function coerceObjectArg(raw: unknown, label: string): { value: Record<string, unknown>; error?: string } {
  const parsed = parseJsonArg(raw, label);
  if (parsed.error) return { value: {}, error: parsed.error };
  const v = parsed.value;
  if (v === undefined || v === null) return { value: {} };
  if (typeof v !== "object" || Array.isArray(v)) {
    return { value: {}, error: `${label} 应为 {列: 值} 对象，收到：${JSON.stringify(v).slice(0, 120)}` };
  }
  return { value: v as Record<string, unknown> };
}

/** 归一字符串数组类参数（columns）。支持字符串化形态。 */
export function coerceColumnsArg(raw: unknown): { value?: string[]; error?: string } {
  const parsed = parseJsonArg(raw, "columns");
  if (parsed.error) return { error: parsed.error };
  const v = parsed.value;
  if (v === undefined || v === null) return {};
  if (!Array.isArray(v)) return { error: `columns 应为字符串数组，收到：${JSON.stringify(v).slice(0, 120)}` };
  return { value: v.map((x) => String(x)) };
}

/** 归一数组类参数（元素类型不限，如整课替换的 items）。支持字符串化形态。 */
export function coerceArrayArg(raw: unknown, label: string): { value: unknown[]; error?: string } {
  const parsed = parseJsonArg(raw, label);
  if (parsed.error) return { value: [], error: parsed.error };
  const v = parsed.value;
  if (v === undefined || v === null) return { value: [] };
  if (!Array.isArray(v)) return { value: [], error: `${label} 应为数组，收到：${JSON.stringify(v).slice(0, 120)}` };
  return { value: v };
}

/**
 * ISSUE-122：rows 形状归一。insert 期望行数组、update 期望列值对象；两种实际形状都容忍：
 * - 数组：insert 原样；update 取首元素（多元素=一次改多行，拒绝并提示按 where 逐条）；
 * - 对象：insert 视为单行；update 原样。
 * 纯 schema 修复不够（历史会话/调用方已习惯传数组），执行器双向兼容才是治本。
 */
export function normalizeWriteRows(
  op: "insert" | "update" | "delete",
  rows: unknown
): { list: Array<Record<string, unknown>>; values: Record<string, unknown>; error?: string } {
  // ISSUE-133：字符串化形态先解析回结构（否则会被当成列名/下标处理）
  const parsed = parseJsonArg(rows, "rows");
  if (parsed.error) return { list: [], values: {}, error: parsed.error };
  rows = parsed.value;
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (op === "insert") {
    if (Array.isArray(rows)) return { list: rows as Array<Record<string, unknown>>, values: {} };
    if (isObj(rows)) return { list: [rows], values: rows };
    return { list: [], values: {} };
  }
  if (Array.isArray(rows)) {
    if (rows.length === 0) return { list: [], values: {} };
    if (rows.length > 1 || !isObj(rows[0])) {
      return {
        list: [],
        values: {},
        error: "update 的 rows 应为 {列: 值} 对象（一次只改一行；多行请按 where 逐条调用）",
      };
    }
    return { list: [], values: rows[0] };
  }
  return { list: [], values: isObj(rows) ? rows : {} };
}

/** 「列 N 未登记」且 N 为纯数字 → rows 被按数组下标解析过的自愈提示（ISSUE-122 ③）。 */
export function digitColHint(col: string): string {
  return /^\d+$/.test(col) ? "（rows 被按数组下标解析成列名——update 的 rows 应为 {列: 值} 对象，insert 为行数组）" : "";
}

export interface WriteResult {
  ok: boolean;
  text: string;
  /** confirm 列命中提示（有则 agent 必须向家长复述） */
  confirmHints: string[];
  /** ISSUE-111：引用校验落空的（目标表, 目标列, 值）——调用方可用向量候选追加提示（只提示不代入） */
  missedRef?: { refTable: string; refColumn: string; value: unknown };
}

export function validateValue(col: string, c: ColumnSpec, v: unknown): string | null {
  if (v === null || v === undefined) {
    return c.notEmpty === false ? null : `列 ${col} 不允许空值`;
  }
  if (c.kind === "number") {
    const n = Number(v);
    if (!Number.isFinite(n)) return `列 ${col} 需要数字，收到：${JSON.stringify(v)}`;
    if (c.int && !Number.isInteger(n)) return `列 ${col} 需要整数`;
    if (c.min != null && n < c.min) return `列 ${col} 不能小于 ${c.min}`;
    if (c.max != null && n > c.max) return `列 ${col} 不能大于 ${c.max}`;
    return null;
  }
  const s = String(v);
  if (c.notEmpty !== false && !s.trim()) return `列 ${col} 不允许空串`;
  if (c.maxLen && s.length > c.maxLen) return `列 ${col} 超长（≤${c.maxLen} 字）`;
  if (c.kind === "enum" && !c.enumValues!.includes(s)) return `列 ${col} 只能是 ${c.enumValues!.join(" / ")}，收到：${s}`;
  return null;
}

/** 执行受控写。db 由调用方打开（家长库），事务 + 审计都在此完成。 */
export function executeWrite(db: DatabaseSync, specs: TableSpec[], req: WriteRequest): WriteResult {
  const spec = specs.find((s) => s.table === req.table);
  if (!spec) {
    return { ok: false, text: `没有登记名为「${req.table}」的表，不能写。可用：${specs.map((s) => s.table).join("、")}`, confirmHints: [] };
  }
  if (!spec.ops.includes(req.op)) {
    return { ok: false, text: `表 ${req.table} 不允许 ${req.op}（允许：${spec.ops.join("/")}）`, confirmHints: [] };
  }

  // ISSUE-133：字符串化参数先归一（schema 已放行 string 分支，这里还原结构）
  const whereArg = coerceObjectArg(req.where, "where");
  if (whereArg.error) return { ok: false, text: whereArg.error, confirmHints: [] };
  const rowsArg = parseJsonArg(req.rows, "rows");
  if (rowsArg.error) return { ok: false, text: rowsArg.error, confirmHints: [] };

  // —— where 构造与影响行数预览（update/delete 必填；只允许登记列的等值条件）——
  let whereClauses: Array<{ col: string; value: null | number | bigint | string }> = [];
  if (req.op !== "insert") {
    const w = whereArg.value;
    const entries = Object.entries(w).filter(([, v]) => v !== undefined && v !== null && String(v) !== "");
    if (!entries.length) return { ok: false, text: `${req.op} 必须带 where 等值条件（防全表操作）`, confirmHints: [] };
    for (const [col, value] of entries) {
      const c = spec.columns[col] ?? (spec.serverGenerated?.includes(col) ? undefined : null);
      if (c === null) return { ok: false, text: `where 条件列 ${col} 未登记，不能作为条件`, confirmHints: [] };
      if (c) {
        const err = validateValue(col, c, value);
        if (err) return { ok: false, text: err, confirmHints: [] };
      }
      whereClauses.push({ col, value: sqlVal(value) });
    }
  }

  const confirmHints: string[] = [];
  let missedRef: WriteResult["missedRef"];
  db.exec("BEGIN");
  try {
    let affected = 0;

    if (req.op === "insert") {
      const { list, error } = normalizeWriteRows("insert", rowsArg.value);
      if (error) fail(error);
      const rows = list;
      if (!rows.length) fail("insert 需要至少一行 rows（行数组 [{列:值},…]；单行也可直接传 {列:值} 对象）");
      if (rows.length > spec.rowLimit) {
        fail(`一次最多插入 ${spec.rowLimit} 行，收到 ${rows.length} 行`);
      }
      for (const rawRow of rows) {
        // 服务端强制列（如孩子身份）最后覆盖，agent 传什么都不生效
        const row = { ...rawRow, ...(req.force ?? {}) };
        // 跨列校验先于逐列校验：比如「背诵题必须有 answer」的提示比「answer 不允许空串」更有用
        if (spec.insertInvariant) {
          const invErr = spec.insertInvariant(row);
          if (invErr) fail(invErr);
        }
        const cols: string[] = [];
        const vals: Array<null | number | bigint | string> = [];
        for (const [col, value] of Object.entries(row)) {
          if (spec.serverGenerated?.includes(col)) continue; // 服务端生成列：忽略 agent 给的值
          const c = spec.columns[col];
          if (!c) fail(`列 ${col} 未登记，不能写（用 db_describe 查看可用列）`);
          const err = validateValue(col, c, value);
          if (err) fail(err);
          if (c.confirm) confirmHints.push(c.desc);
          cols.push(col);
          vals.push(sqlVal(value));
        }
        for (const col of spec.insertRequired ?? []) {
          const given = row[col];
          if (given === undefined || (typeof given === "string" && !given.trim())) {
            fail(`insert 缺必填列 ${col}`);
          }
          if (!cols.includes(col)) {
            cols.push(col);
            vals.push(sqlVal(row[col]));
          }
        }
        for (const col of spec.serverGenerated ?? []) {
          if (!cols.includes(col)) {
            cols.push(col);
            vals.push(col === "id" ? randomUUID() : localDatetime());
          }
        }
        for (const r of spec.refChecks ?? []) {
          const v = row[r.column];
          if (v === undefined || v === null || String(v) === "") continue; // 可空引用交由列校验/表约束兜底
          const hit = db.prepare(`SELECT 1 FROM ${r.refTable} WHERE ${r.refColumn} = ?`).get(sqlVal(v));
          if (!hit) {
            // ISSUE-111：记录落空引用（调用方可附向量候选；只提示不代入）
            missedRef = { refTable: r.refTable, refColumn: r.refColumn, value: v };
            fail(`${r.desc}：${r.column}=${String(v)}（须存在于 ${r.refTable}.${r.refColumn}）`);
          }
        }
        const placeholders = cols.map(() => "?").join(", ");
        db.prepare(`INSERT INTO ${spec.table} (${cols.join(", ")}) VALUES (${placeholders})`).run(...vals);
        affected++;
      }
    } else {
      const whereSql = whereClauses.map((w) => `${w.col} = ?`).join(" AND ");
      const whereVals = whereClauses.map((w) => w.value);
      const cntRow = db
        .prepare(`SELECT COUNT(*) AS n FROM ${spec.table} WHERE ${whereSql}`)
        .get(...whereVals) as { n: number };
      if (cntRow.n === 0) {
        fail(`where 条件没有命中任何行（${whereSql}），未执行`);
      }
      if (cntRow.n > spec.rowLimit) {
        fail(`where 条件命中 ${cntRow.n} 行，超过单次上限 ${spec.rowLimit} 行；请缩小条件（如按主键逐条）`);
      }
      if (req.op === "update") {
        const { values, error } = normalizeWriteRows("update", rowsArg.value);
        if (error) fail(error);
        const sets = Object.entries(values);
        if (!sets.length) fail("update 需要给出要写入的列值（rows 传 {列: 值} 对象）");
        for (const [col, value] of sets) {
          const c = spec.columns[col];
          if (!c) {
            // F2 自愈：写列名错直接回可写列清单；纯数字列名附加形状自愈提示（ISSUE-122 ③）
            fail(`列 ${col} 未登记，不能写。${spec.table} 可写列：${Object.keys(spec.columns).join("、")}${digitColHint(col)}`);
          }
          const err = validateValue(col, c, value);
          if (err) fail(err);
          if (c.confirm) confirmHints.push(c.desc);
        }
        const setSql = sets.map(([c]) => `${c} = ?`).join(", ");
        const touch = spec.touchUpdatedAt ? `, updated_at = datetime('now')` : "";
        db.prepare(`UPDATE ${spec.table} SET ${setSql}${touch} WHERE ${whereSql}`).run(
          ...sets.map(([, v]) => sqlVal(v)),
          ...whereVals
        );
      } else {
        db.prepare(`DELETE FROM ${spec.table} WHERE ${whereSql}`).run(...whereVals);
      }
      affected = cntRow.n;
    }

    writeAudit(db, {
      table: spec.table,
      op: req.op,
      where: whereArg.value,
      rowCount: affected,
      summary: `agent ${req.op} ${spec.table}：${affected} 行`,
    });
    db.exec("COMMIT");

    let text = `${req.op} ${spec.table} 成功：影响 ${affected} 行。`;
    if (confirmHints.length) {
      text += `\n\n⚠️ 本次写入了敏感字段（${[...new Set(confirmHints)].join("；")}），请向家长逐条复述改动内容。`;
    }
    text += `\n（已写入审计 db_audit，可在家长操作记录中追溯）`;
    return { ok: true, text, confirmHints };
  } catch (e: any) {
    db.exec("ROLLBACK");
    if (e instanceof ChannelError) return { ok: false, text: e.message, confirmHints: [], missedRef };
    return { ok: false, text: `执行失败（已回滚）：${String(e?.message || e)}`, confirmHints: [] };
  }
}

/** describe 的入口（供工具包装）：列出全部登记表或指定表的详情 */
export function findTableSpec(specs: TableSpec[], table: string): TableSpec | undefined {
  return specs.find((s) => s.table === table);
}

// ==================== 命名路径（F10/C2）：注册表承载关联查询，模型只选路径名 ====================

export interface RegistryPath {
  /** 路径名（模型可见、可调用） */
  name: string;
  label: string;
  desc: string;
  /** 结果主体表（SELECT 基准表） */
  select: string;
  /** 跳链：按序 JOIN。on 语义 = 本表列 → 已出现表.列；别名即表名（一条路径内表名不得重复）。
   *  optional=true 时用 LEFT JOIN（允许链上无挂载的行也存在，如未挂知识点的题） */
  hops: Array<{ table: string; on: Record<string, string>; optional?: boolean }>;
  /** 允许作为 where 条件的列（全限定名 "表.列"；含中间表——Q1 由此消解） */
  filterable: string[];
  /** 允许返回的列（全限定名），缺省返回集 */
  returns: string[];
  /** 单次返回行数上限 */
  rowLimit: number;
}

export interface PathReadRequest {
  path: string;
  /** ISSUE-133：类型放宽，buildPathQuery 内部归一（兼容 JSON 字符串形态） */
  columns?: unknown;
  where?: unknown;
  orderBy?: string;
  orderDesc?: boolean;
  limit?: number;
  /** 跳过前 N 行（配合 limit/orderBy 分页拉全量） */
  offset?: number;
  countOnly?: boolean;
}

/** 校验路径注册项本身良构（表名不重复、on 引用已出现的表、returns 裸列名不冲突） */
function assertPathValid(p: RegistryPath): void {
  const seen = new Set([p.select]);
  for (const hop of p.hops) {
    if (seen.has(hop.table)) throw new Error(`路径 ${p.name}：表 ${hop.table} 在链中重复（暂不支持自连接）`);
    seen.add(hop.table);
    for (const [col, ref] of Object.entries(hop.on)) {
      const refTable = ref.split(".")[0];
      if (!seen.has(refTable)) throw new Error(`路径 ${p.name}：hop ${hop.table}.${col} 引用了链上未出现的表 ${refTable}`);
    }
  }
  // SELECT 结果键是裸列名（SQLite 对 table.column 只取 column），重名会互相覆盖
  const bare = p.returns.map((r) => r.split(".")[1] ?? r);
  if (new Set(bare).size !== bare.length) {
    throw new Error(`路径 ${p.name}：returns 存在重复的裸列名（${bare.join(",")}），结果行会互相覆盖`);
  }
}

/** 把路径编译成参数化 SQL（F10-b：领域模块共用同一编译器，JOIN 链只有注册表一份真源）。
 *  where 键必须是 filterable 全限定名；columns 必须是 returns 子集；
 *  orderBy 支持逗号分隔多列（每列须 ∈ returns ∪ filterable，或主体表 .rowid 特例——保挂载插入序）。 */
export function buildPathQuery(
  path: RegistryPath,
  req: Omit<PathReadRequest, "path">
): { sql: string; params: Array<null | number | bigint | string>; selectCols: string[]; limit: number } {
  assertPathValid(path);
  // ISSUE-133：字符串化参数先在编译器入口归一（任何调用方都受益；不合法则抛出，由上层转成可读文案）
  const whereArg = coerceObjectArg(req.where, "where");
  if (whereArg.error) throw new Error(whereArg.error);
  const colsArg = coerceColumnsArg(req.columns);
  if (colsArg.error) throw new Error(colsArg.error);
  const reqCols = colsArg.value;
  const whereEntries = Object.entries(whereArg.value).filter(([, v]) => v !== undefined && v !== null && String(v) !== "");
  for (const [col] of whereEntries) {
    if (!path.filterable.includes(col)) {
      throw new Error(`where 条件列 ${col} 不在路径 ${path.name} 的可过滤列内（可用：${path.filterable.join("、")}）`);
    }
  }
  const selectCols = reqCols?.length ? [...reqCols] : [...path.returns];
  const unknownCols = selectCols.filter((c) => !path.returns.includes(c));
  if (unknownCols.length) {
    throw new Error(`返回列不在路径 ${path.name} 的 returns 内：${unknownCols.join("、")}（可用：${path.returns.join("、")}）`);
  }
  if (req.orderBy) {
    for (const token of req.orderBy.split(",").map((t) => t.trim()).filter(Boolean)) {
      if (token === `${path.select}.rowid`) continue;
      if (!path.returns.includes(token) && !path.filterable.includes(token)) {
        throw new Error(`排序列 ${token} 不在路径 ${path.name} 的可用列内`);
      }
    }
  }
  const joinSql = path.hops
    .map((h) => `${h.optional ? "LEFT JOIN" : "JOIN"} ${h.table} ON ${Object.entries(h.on).map(([c, ref]) => `${h.table}.${c} = ${ref}`).join(" AND ")}`)
    .join(" ");
  const whereSql = whereEntries.length ? ` WHERE ${whereEntries.map(([c]) => `${c} = ?`).join(" AND ")}` : "";
  const orderSql = req.orderBy ? ` ORDER BY ${req.orderBy} ${req.orderDesc ? "DESC" : "ASC"}` : "";
  const params = whereEntries.map(([, v]) => sqlVal(v));
  const limit = Math.max(1, Math.min(Number(req.limit) || 20, path.rowLimit, READ_MAX_LIMIT));
  if (req.countOnly) {
    return { sql: `SELECT COUNT(*) AS n FROM ${path.select} ${joinSql}${whereSql}`.replace(/\s+/g, " "), params, selectCols, limit };
  }
  const offset = Math.max(0, Math.floor(Number(req.offset) || 0));
  const pageSql = ` LIMIT ${limit} OFFSET ${offset}`;
  const sql = `SELECT ${selectCols.join(", ")} FROM ${path.select} ${joinSql}${whereSql}${orderSql}${pageSql}`.replace(/\s+/g, " ");
  return { sql, params, selectCols, limit };
}

/** 路径读执行器：与 executeRead 同级出口（预算/截断/自愈语义一致） */
export function executePathRead(db: DatabaseSync, paths: RegistryPath[], req: PathReadRequest): { ok: boolean; text: string } {
  const path = paths.find((p) => p.name === req.path);
  if (!path) {
    return { ok: false, text: `没有登记名为「${req.path}」的路径。可用：${paths.map((p) => p.name).join("、")}` };
  }
  // ISSUE-133：字符串化参数由 buildPathQuery 统一归一（失败抛出→下面 catch 转成可读文案）
  let built: ReturnType<typeof buildPathQuery>;
  try {
    built = buildPathQuery(path, req);
  } catch (e) {
    return { ok: false, text: (e as Error).message };
  }
  if (req.countOnly) {
    const n = (db.prepare(built.sql).get(...built.params) as { n: number }).n;
    return { ok: true, text: `路径 ${path.name}（${path.label}）：命中 ${n} 行。` };
  }
  const rows = db.prepare(built.sql).all(...built.params) as Array<Record<string, unknown>>;
  if (!rows.length) {
    return { ok: true, text: `路径 ${path.name}（${path.label}）：查询结果为空。可过滤列：${path.filterable.join("、")}` };
  }
  const [body, truncated, returned] = renderRowsBudget(rows);
  if (truncated) {
    const total = (db.prepare(buildPathQuery(path, { ...req, countOnly: true }).sql).get(...built.params) as { n: number }).n;
    return {
      ok: true,
      text: `路径 ${path.name}（${path.label}）：已返前 ${returned} 行 / 共 ${total} 行（超字符预算截断）。请收窄 where 或用 columns 选列。\n${body}`,
    };
  }
  return {
    ok: true,
    text:
      `路径 ${path.name}（${path.label}）：${rows.length} 行` +
      (rows.length >= built.limit ? `（已达单次上限；拉全量请带 orderBy + offset 翻页）` : "") +
      `\n${body}`,
  };
}

/** 家长库命名路径登记（先注册高频路径，R1：按需增长） */
export function parentLibPaths(): RegistryPath[] {
  return [
    {
      name: "topic_questions",
      label: "某主题下的全部题",
      desc: "主题→课程→知识点→挂载→题 的多跳关联",
      select: "question_bank",
      hops: [
        { table: "course_knowledge_questions", on: { question_id: "question_bank.id" } },
        { table: "knowledge_points", on: { id: "course_knowledge_questions.knowledge_point_id" } },
        { table: "courses", on: { uuid: "knowledge_points.course_uuid" } },
      ],
      filterable: ["courses.topic", "courses.title", "knowledge_points.name", "question_bank.behavior"],
      returns: [
        "question_bank.id",
        "question_bank.behavior",
        "question_bank.stem",
        "question_bank.answer",
        "question_bank.options",
        "courses.topic",
        "courses.title",
        "knowledge_points.name",
      ],
      rowLimit: 200,
    },
    {
      name: "topic_knowledge_points",
      label: "某主题下全部课程的知识点",
      desc: "主题→课程→知识点；供家长 agent 列知识点与 method-spec 校验",
      select: "knowledge_points",
      hops: [{ table: "courses", on: { uuid: "knowledge_points.course_uuid" } }],
      filterable: ["courses.topic", "courses.title"],
      returns: [
        "knowledge_points.id",
        "knowledge_points.course_uuid",
        "knowledge_points.name",
        "knowledge_points.detail",
        "knowledge_points.seq",
        "courses.title",
        "courses.topic",
        "courses.sort_order",
      ],
      rowLimit: 500,
    },
    {
      name: "course_content_rows",
      label: "某课的挂载内容行（知识点→题）",
      desc: "课程→知识点→题 的挂载明细（含 overview）；整课替换前核对现状用",
      select: "course_knowledge_questions",
      hops: [
        { table: "knowledge_points", on: { id: "course_knowledge_questions.knowledge_point_id" } },
        { table: "question_bank", on: { id: "course_knowledge_questions.question_id" } },
      ],
      filterable: ["course_knowledge_questions.course_id", "knowledge_points.name"],
      returns: [
        "course_knowledge_questions.knowledge_point_id",
        "knowledge_points.name",
        "knowledge_points.detail",
        "course_knowledge_questions.overview",
        "course_knowledge_questions.seq",
        "course_knowledge_questions.question_id",
        "question_bank.stem",
        "question_bank.answer",
        "question_bank.scoring",
        "question_bank.point_max",
        "question_bank.behavior",
        "question_bank.note",
        "question_bank.knowledge_summary",
        "question_bank.options",
      ],
      rowLimit: 500,
    },
    {
      name: "bank_question_contexts",
      label: "题库题的主题/课程/知识点上下文",
      desc: "挂载桥反查每道题归属（未挂载的题不出现在结果里）",
      select: "course_knowledge_questions",
      hops: [
        { table: "knowledge_points", on: { id: "course_knowledge_questions.knowledge_point_id" }, optional: true },
        { table: "courses", on: { uuid: "knowledge_points.course_uuid" }, optional: true },
      ],
      filterable: ["knowledge_points.name"],
      returns: [
        "course_knowledge_questions.question_id",
        "course_knowledge_questions.knowledge_point_id",
        "courses.topic",
        "courses.title",
        "courses.uuid",
        "knowledge_points.name",
      ],
      rowLimit: 5000,
    },
  ];
}

/** 把路径名反向索引进读面（ReadableTableSpec.paths） */
export function applyPathIndex(readSpecs: ReadableTableSpec[], paths: RegistryPath[]): ReadableTableSpec[] {
  const byTable = new Map<string, string[]>();
  for (const p of paths) {
    const tables = [p.select, ...p.hops.map((h) => h.table)];
    for (const t of new Set(tables)) {
      const arr = byTable.get(t) ?? [];
      arr.push(p.name);
      byTable.set(t, arr);
    }
  }
  return readSpecs.map((s) => (byTable.has(s.table) ? { ...s, paths: byTable.get(s.table) } : s));
}

// ==================== 孩子库（kb.sqlite）登记（F14：单一真源，读面派生） ====================

/** 孩子库表紧凑声明 → 完整 TableSpec。ops=[] = 纯只读（F14 治理红线：登记 ≠ 开放写） */
interface KbTableDef {
  table: string;
  label: string;
  desc: string;
  columns: Record<string, string>;
  /** 主键列（where 提示用） */
  pk?: string[];
  /** 只读列（历史/系统管理列） */
  readOnlyColumns?: Record<string, string>;
}

const kbTable = (d: KbTableDef): TableSpec => ({
  table: d.table,
  label: d.label,
  desc: d.desc,
  ops: [],
  rowLimit: 0,
  pk: d.pk ?? [],
  columns: Object.fromEntries(
    Object.entries(d.columns).map(([col, desc]) => [col, str(desc, 20000, { notEmpty: false })])
  ),
  readOnlyColumns: d.readOnlyColumns,
});

const R = (s: string) => s;

/** 孩子库全部登记表（完整列清单；漂移由 probe:registry-drift 把关） */
export function childKbTableSpecs(): TableSpec[] {
  return (
    [
    {
      table: "study_plans",
      label: "学习计划",
      desc: "家长/系统排的学习课程任务；我自己的学习安排",
      pk: ["id"],
      columns: {
        id: R("计划 id"), parent_id: R("归属家长 id"), child_id: R("孩子 id"), topic_key: R("主题标识"),
        course_uuid: R("课程 uuid（courses.uuid 真引用）"), course_name: R("课程名"), mode: R("new=新学/review=复习"),
        creator: R("创建人 parent/child"), origin: R("来源 conversation/carry/recurrence"), carry_from: R("顺延自哪天"),
        recurrence_id: R("重复规则 id"), start_at: R("开始时间"), due_at: R("截止时间"),
        status: R("pending/started/done/cancelled"), result: R("结果备注"),
        result_summary: R("本次学习的结果概要（课程级；ISSUE-135 掌握闭环）"), done_at: R("完成时间"),
        task_type: R("required=必须/optional=加分"), count_in_rate: R("1=计入完成率"), points: R("完成可得积分"),
        active: R("1=有效"), created_at: R("创建时间"), updated_at: R("更新时间"),
      },
    },
    {
      table: "exam_plans",
      label: "考核计划",
      desc: "考核安排（只读！考核的开始/完成只能由考核流程写）",
      pk: ["id"],
      columns: {
        id: R("计划 id"), parent_id: R("归属家长 id"), child_id: R("孩子 id"), title: R("考核标题"),
        creator: R("创建人 parent/child"), kind: R("fixed=固定档/custom=自定义"), freq: R("重复频率"),
        scope_json: R("考核范围 JSON"), origin: R("来源"), recurrence_id: R("重复规则 id"),
        start_at: R("考核日期"), due_at: R("截止"), status: R("pending/started/done"), attempt_id: R("成绩记录 id"),
        retake: R("当天重考标准（自然语言，空=不重考；ISSUE-115）"),
        score: R("得分"), result: R("结果备注"), done_at: R("完成时间"),
        task_type: R("required/optional"), count_in_rate: R("1=计入得分率"), points: R("积分"),
        active: R("1=有效"), created_at: R("创建时间"), updated_at: R("更新时间"),
      },
    },
    {
      table: "exam_plan_courses",
      label: "考核明细（逐题）",
      desc: "一行一题：这次考核这门课考了哪些题、每题得几分、孩子答了什么、老师怎么评（ISSUE-135 P0-a 起含题级富字段）",
      pk: ["id"],
      columns: {
        id: R("行 id"), plan_id: R("考核计划 id（exam_plans.id）"), course_uuid: R("课程 uuid"), course_name: R("课程名"),
        knowledge_point_id: R("知识点 id（逻辑引用家长库）"), knowledge_point_name: R("知识点名快照"),
        question_id: R("题库题 id（逻辑引用）"), question_text: R("题干"), ref_text: R("背诵/朗读原文"),
        point_got: R("该题得分"), point_max: R("该题满分"), correct: R("1=对/0=错/NULL 未判"),
        ai_comment: R("AI 评语"), asr_text: R("孩子回答的语音转写"), audio_file_id: R("录音引用（听原音）"),
        duration_ms: R("答题用时毫秒"), behavior: R("题级行为 speech_recite/speech_read/generic"),
        seq: R("顺序"), created_at: R("创建时间"),
      },
      readOnlyColumns: { category_id: "旧考核类别 id（2026-09-11 知识点制前残留，仅历史行有值）" },
    },
    {
      table: "exam_course_results",
      label: "课程每次考核结果概要",
      desc: "一行 = 一次考核 × 一门课（ISSUE-135 §3.5）：Σ得分/Σ满分/得分率 + 课程结果概要 + 复习重点；课程进度与「最近一次考核」口径的直接读入",
      pk: ["id"],
      columns: {
        id: R("行 id"), parent_id: R("归属家长 id"), child_id: R("孩子 id"), plan_id: R("考核计划 id"),
        attempt_ref: R("本次提交溯源 id"), topic_key: R("主题标识"), course_uuid: R("课程 uuid"), course_name: R("课程名"),
        exam_at: R("本次考核时间"), point_got: R("该课本次 Σ得分"), point_max: R("该课本次 Σ满分"),
        rate: R("该课本次得分率 0~1"), question_count: R("本次该课题数"), course_summary: R("课程结果概要"),
        plan_review_at: R("复习到期"), focus_json: R("复习重点 JSON 数组"),
        created_at: R("创建时间"), updated_at: R("更新时间"),
      },
    },
    {
      table: "knowledge_point_records",
      label: "知识点掌握情况流水",
      desc: "一行 = 某知识点在某次学习/考核计划里的一次情况（source 区分 study/exam；ISSUE-135 §3.1）。查某知识点全部历史：按 knowledge_point_id 过滤后按 record_at 排序",
      pk: ["id"],
      columns: {
        id: R("行 id"), parent_id: R("归属家长 id"), child_id: R("孩子 id"), source: R("study=学习 / exam=考核"),
        plan_id: R("来源计划 id（study_plans.id / exam_plans.id）"), knowledge_point_id: R("知识点 id（逻辑引用家长库）"),
        knowledge_point_name: R("知识点名快照"), topic_key: R("主题标识"), course_uuid: R("课程 uuid"), course_name: R("课程名"),
        record_at: R("发生时间"), outcome: R("solid=扎实 / partial=一般 / weak=薄弱"),
        point_got: R("该知识点本次得分（学习为空）"), point_max: R("满分"), rate: R("得分率"),
        summary: R("本次情况描述"), detail_json: R("困难点/亮点/题目 id JSON"),
        source_ref: R("溯源引用"), created_at: R("创建时间"),
      },
    },
    {
      table: "knowledge_point_progress",
      label: "知识点累计掌握",
      desc: "一行 = 一个知识点的累计掌握（ISSUE-135 §3.2，由每日分析任务汇总）：档位 + 累计自然语言叙述 + 学/考次数",
      pk: ["child_id", "knowledge_point_id"],
      columns: {
        parent_id: R("归属家长 id"), child_id: R("孩子 id"), knowledge_point_id: R("知识点 id"),
        knowledge_point_name: R("知识点名快照"), course_uuid: R("课程 uuid"), course_name: R("课程名"),
        level: R("not_started/learning/needs_review/mastered"), mastery_desc: R("累计掌握叙述（最开始→中间→最新）"),
        study_count: R("学习次数"), exam_count: R("考核次数"), last_outcome: R("最近一次档位"), last_rate: R("最近一次得分率"),
        first_at: R("首次记录时间"), last_at: R("最近记录时间"), updated_at: R("更新时间"),
      },
    },
    {
      table: "speech_assessments",
      label: "口语评测存档（题级）",
      desc: "考核内口语/听说题的发音评测维度分存档（ISSUE-135 D13：按 (plan_id,course_uuid,question_id) 与考核明细关联；同一题多行 = 多次评测）",
      pk: ["id"],
      columns: {
        id: R("行 id"), parent_id: R("归属家长 id"), child_id: R("孩子 id"),
        plan_id: R("考核计划 id"), course_uuid: R("课程 uuid"), question_id: R("题库题 id"), attempt_ref: R("提交溯源 id"),
        topic_key: R("主题标识"), course_name: R("课程名"), question_type: R("题型"),
        ref_text: R("参考原文"), audio_file_id: R("录音引用"), overall: R("总分"), pron: R("发音分"),
        dimensions_json: R("维度分 JSON（准确/完整/流利/韵律/音质）"), detail_json: R("原始评测结果 JSON"),
        is_exam: R("1=考核内评测"), created_at: R("创建时间"),
      },
    },
    {
      table: "life_plans",
      label: "生活计划",
      desc: "生活任务（家长的必须完成项 + 我自己创建的加分项）",
      pk: ["id"],
      columns: {
        id: R("计划 id"), parent_id: R("归属家长 id"), child_id: R("孩子 id"), title: R("事项"),
        creator: R("parent/child"), origin: R("来源 conversation/carry/recurrence"), carry_from: R("顺延自哪天"),
        recurrence_id: R("重复规则 id"), start_at: R("开始"), due_at: R("截止"),
        status: R("pending/started/done/cancelled"), result: R("结果备注"), done_at: R("完成时间"),
        task_type: R("required/optional"), count_in_rate: R("1=计入完成率"), points: R("积分"),
        active: R("1=有效"), created_at: R("创建时间"), updated_at: R("更新时间"),
      },
    },
    {
      table: "daily_entries",
      label: "日常记录",
      desc: "每天的学习/生活/问答/任务记录（我自己的日常本）",
      pk: ["date", "block", "title"],
      columns: {
        date: R("日期 YYYY-MM-DD"), block: R("学习/生活/问答/任务"), title: R("标题"), raw: R("内容"), tags: R("标签"),
        plan_id: R("关联生活计划 id"), plan_outcome: R("done/missed/unknown"),
      },
    },
    {
      table: "topics",
      label: "学习主题",
      desc: "我在学的主题目录（learn_type：required=必学 / optional=选学 / review=复习）",
      columns: { name: R("主题名"), topic_key: R("主题标识"), learn_type: R("required/optional/review"), rules_json: R("孩子级规则 JSON") },
    },
    {
      table: "courses",
      label: "课程",
      desc: "主题下的课程与我的学习状态（教学内容在家长库，这里只有进度）",
      columns: {
        topic: R("主题名"), topic_key: R("主题标识"), title: R("课程名"), uuid: R("课程 uuid"),
        sort_order: R("排序"), status: R("学习状态标记"),
        last_review: R("最近学习/复习时间"), review_count: R("复习次数"), tags: R("标签"),
        mastery_level: R("掌握档位 not_started/learning/needs_review/mastered（ISSUE-135，分析任务写）"),
        mastery_desc: R("累计掌握叙述（最开始→中间→最新；ISSUE-135）"),
        teaching_advice: R("下次教学建议（ISSUE-135；只增补，不改家长手写教学方法）"),
        mastery_updated_at: R("上述三列刷新时间（ISSUE-135）"),
      },
    },
    {
      table: "reward_configs",
      label: "积分规则",
      desc: "家长定的积分/兑换规则（只读）",
      pk: ["child_id"],
      columns: {
        child_id: R("孩子 id"), todo_tiers_json: R("每日任务积分档位 JSON"), exam_tiers_json: R("考核积分档位 JSON"),
        todo_gate_parent_min_rate: R("家长确认门槛：任务完成率下限"), exam_gate_parent_min_score: R("家长确认门槛：考核得分下限"),
        optional_points: R("加分项单条积分"), child_no_deduct: R("是否不扣分"), updated: R("更新时间"),
      },
    },
    {
      table: "points_ledger",
      label: "积分流水",
      desc: "每笔积分的来龙去脉（只读；积分只能由系统流程产生）",
      pk: ["id"],
      columns: {
        id: R("流水 id"), child_id: R("孩子 id"), ts: R("时间"), biz_date: R("业务日期"), type: R("类型"),
        amount: R("变动值"), balance_after: R("变动后余额"), reason_code: R("原因码"), reason: R("原因"),
        rate: R("当日完成率"), meta_json: R("附加信息 JSON"), source_table: R("来源表"), source_id: R("来源 id"),
        operator: R("操作方 system/parent"), created_at: R("创建时间"),
      },
    },
    {
      table: "points_balance",
      label: "积分余额",
      desc: "当前积分余额（只读）",
      pk: ["child_id"],
      columns: { child_id: R("孩子 id"), balance: R("余额"), updated: R("更新时间") },
    },
    {
      table: "redemption_items",
      label: "兑换商品",
      desc: "家长发布的可兑换奖励（只读）",
      pk: ["id"],
      columns: {
        id: R("商品 id"), child_id: R("限定孩子（空=通用）"), name: R("名称"), cost: R("所需积分"),
        kind: R("类型"), payload_json: R("附加信息 JSON"), enabled: R("1=上架"), updated: R("更新时间"),
      },
    },
    {
      table: "redemption_requests",
      label: "我的兑换申请",
      desc: "我提交的兑换申请及审批状态（新增申请请用 child_db_write）",
      pk: ["id"],
      columns: {
        id: R("申请 id"), child_id: R("孩子 id"), item_id: R("商品 id"), custom_desc: R("自定义奖励描述"),
        cost: R("消耗积分"), status: R("pending/approved/rejected/fulfilled"), parent_id: R("审批家长 id"),
        created_at: R("申请时间"), fulfilled_at: R("发放时间"),
      },
    },
    {
      table: "reward_daily_stats",
      label: "每日积分统计",
      desc: "每天计划完成率与结算积分（只读）",
      pk: ["child_id", "date", "source", "owner"],
      columns: {
        child_id: R("孩子 id"), date: R("日期"), source: R("todo/exam"), owner: R("parent/child"),
        required_total: R("必须项总数"), required_done: R("已完成"), optional_done: R("加分项完成数"),
        missed_count: R("错过数"), cancelled_count: R("取消数"), rate: R("完成率"), tier: R("档位"),
        gate_ok: R("是否过家长确认门槛"), points_awarded: R("结算积分"), settled_at: R("结算时间"), updated: R("更新时间"),
      },
    },
    {
      table: "plan_recurrences",
      label: "重复规则",
      desc: "周期任务的重复规则（只读；展开由系统做）",
      pk: ["id"],
      columns: {
        id: R("规则 id"), parent_id: R("归属家长 id"), child_id: R("孩子 id"), plan_type: R("life/study/exam"),
        payload_json: R("规则内容 JSON"), rule: R("daily/weekly"), weekday: R("周几"),
        start_date: R("开始日期"), end_date: R("结束日期"), last_expanded_date: R("上次展开日期"),
        enabled: R("1=启用"), created_at: R("创建时间"), updated_at: R("更新时间"),
      },
    },
    {
      table: "tags",
      label: "标签定义",
      desc: "课程标签的维度与打标标准（家长维护）",
      pk: ["tag"],
      columns: { tag: R("标签名"), dimension: R("所属维度"), criteria: R("打标标准") },
    },
    {
      table: "mistake_book",
      label: "错题/生字本",
      desc: "孩子学习漏洞档案：口述错题/查词生字/考核错题/薄弱点结构化沉淀，复习闭环真源（ISSUE-114）。查询建议 status=open 按 last_seen 倒序；count 越大=反复出现=越未掌握",
      pk: ["id"],
      columns: {
        id: R("条目 id"), kind: R("wrong_question=错题/unknown_word=生字/weak_point=薄弱点"),
        content: R("题干摘要或字词（与 kind+course_ref 联合去重）"), detail: R("正解/释义/卡住点/讲解要点"),
        source: R("conversation=口述/lookup=查词/exam=考核"), source_ref: R("来源引用（attempt id / 会话日期 / 课程）"),
        question_id: R("题库题 id（逻辑引用，错题重做经此取原题；空=无原题）"), course_ref: R("课程标识（可空）"),
        knowledge_point_id: R("知识点 id（逻辑引用家长库，跨库无 FK）"), knowledge_point_name: R("知识点名称快照（防家长侧改删后悬挂）"),
        status: R("open=待掌握/mastered=已掌握/dismissed=不算"),
        created_at: R("创建时间"), updated_at: R("更新时间"),
      },
      readOnlyColumns: {
        count: "重复出现次数（重复=未掌握的证据；服务端 upsert 维护，直改破坏遗忘曲线语义）",
        first_seen: "首次出现时间（服务端维护）",
        last_seen: "最近出现时间（服务端维护）",
        mastered_at: "标掌握时间（空=未掌握过）",
      },
    },
    {
      table: "display_contents",
      label: "展示登记",
      desc: "会话展示内容登记（agent 推送资料/报表后按 (会话, path) 记一条，会话重进回填左侧列表、重置即清；内部表，一般无需读；ISSUE-113）",
      pk: ["child_key", "path"],
      columns: {
        child_key: R("会话键（孩子/家长会话标识）"), path: R("展示路径"), title: R("标题"),
        source: R("来源类型"), content: R("内容快照"), ts: R("推送时间戳"),
      },
    },
    ] as KbTableDef[]
  ).map(kbTable);
}

/** 孩子库只读面（由 childKbTableSpecs 派生，F14 起不再手写第二份） */
export function childKbReadableRegistry(): ReadableTableSpec[] {
  return readableFromSpecs(childKbTableSpecs());
}

/** 孩子可写白名单：只有日常记录与兑换申请（考核/积分/计划状态机绝不开放，见 ISSUE-105 矩阵）。
 *  ⚠️ 仅用于**孩子 agent 自己**的写面；家长 db 通道（parent_db_write + child）2026-09-21 起按
 *  管理口径开放全表，见 childKbAdminWriteSpecs。 */
export function childKbWritableRegistry(): TableSpec[] {
  return [
    {
      table: "daily_entries",
      label: "日常记录",
      desc: "记一条日常（学习/生活/问答/任务）；主键 (date, block, title)，重复插入=冲突报错（改内容请用 update）",
      ops: ["insert", "update", "delete"],
      rowLimit: 30,
      pk: ["date", "block", "title"],
      insertRequired: ["date", "block", "title", "raw"],
      insertInvariant: (row) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date ?? ""))) return "date 必须是 YYYY-MM-DD 格式";
        return null;
      },
      columns: {
        date: str("日期 YYYY-MM-DD", 10),
        block: { kind: "enum", desc: "记录分类", enumValues: ["学习", "生活", "问答", "任务"] },
        title: str("标题（同日同分类下唯一）", 200),
        raw: str("内容正文", 20000),
        tags: str("标签（空格/顿号分隔，可空）", 500, { notEmpty: false }),
      },
      readOnlyColumns: {
        plan_id: "关联生活计划 id（系统 recording 流程写入，agent 不写）",
        plan_outcome: "done/missed/unknown（系统流程写入，agent 不写）",
      },
    },
    {
      table: "redemption_requests",
      label: "兑换申请",
      desc: "提交兑换申请（只能新增；审批/发放由家长与系统处理）",
      ops: ["insert"],
      rowLimit: 5,
      pk: ["id"],
      serverGenerated: ["id", "created_at"],
      insertRequired: ["cost"],
      insertInvariant: (row) => {
        const hasItem = String(row.item_id ?? "").trim() !== "";
        const hasDesc = String(row.custom_desc ?? "").trim() !== "";
        if (!hasItem && !hasDesc) return "兑换申请需要 item_id（兑换商品）或 custom_desc（自定义奖励）之一";
        return null;
      },
      refChecks: [
        { column: "item_id", refTable: "redemption_items", refColumn: "id", desc: "兑换商品不存在" },
      ],
      columns: {
        child_id: str("孩子 id（服务端强制为本孩子，无需传，传了也会被覆盖）", 64, { notEmpty: false }),
        item_id: str("兑换商品 id（redemption_items.id，与 custom_desc 二选一）", 64, { notEmpty: false }),
        custom_desc: str("自定义奖励描述（与 item_id 二选一）", 500, { notEmpty: false }),
        cost: { kind: "number", desc: "消耗积分（应等于商品 cost）", int: true, min: 0, max: 1000000 },
      },
      readOnlyColumns: {
        id: "申请 id（服务端生成）",
        status: "pending/approved/rejected/fulfilled（审批流程维护）",
        parent_id: "审批家长 id（审批流程维护）",
        fulfilled_at: "发放时间（发放流程维护）",
        created_at: "申请时间（服务端生成）",
      },
    },
  ];
}

/**
 * ISSUE-105 修订（2026-09-21 用户拍板）：家长 db 通道按**管理口径**开放孩子库全部登记表——
 * `parent_db_write` + child 参数走本规格（childKbTableSpecs 全量 + 全 ops）。
 * 与孩子 agent 自己的写面（childKbWritableRegistry，两表白名单）划清边界：
 * - 列级校验/行数熔断（50）/事务/审计照旧；readOnlyColumns（如 daily_entries.plan_id）仍不可写；
 * - ⚠️ 状态机表（study_plans/exam_plans/points_ledger 等）直写会绕过受控流程——审计追责 + 工具描述风险提示兜底；
 * - insert 需自带 id/时间戳（specs 未配 serverGenerated）。
 */
export function childKbAdminWriteSpecs(): TableSpec[] {
  return childKbTableSpecs().map((s) => ({
    ...s,
    ops: ["insert", "update", "delete"],
    rowLimit: 50,
  }));
}

/**
 * 家长内容库「可读面」派生：从写登记表（parentLibTableRegistry）直接映射出只读面，
 * 避免两份列清单各写一遍、互相漂移。读与写共用同一套列定义（单一真源）。
 * 服务端的统一读原语 parent_db_read 走这张表（ISSUE-110 盲区修复：家长侧此前只有写，没有通用读）。
 */
export function parentReadableRegistry(): ReadableTableSpec[] {
  return readableFromSpecs(parentLibTableRegistry());
}

/** 家长库 describe：可读表清单 + 可写表详情（统一读工具 parent_db_read 用）。 */
export function describeParentTables(readSpecs: ReadableTableSpec[], writeSpecs: TableSpec[], table?: string): string {
  if (table) {
    const w = writeSpecs.find((s) => s.table === table);
    if (w) return describeTables(writeSpecs, table);
    const r = readSpecs.find((s) => s.table === table);
    if (!r) {
      return `没有登记名为「${table}」的表。可读/写表：\n` + writeSpecs.map((s) => `- ${s.table}（${s.label}）：${s.desc}`).join("\n");
    }
    return `## ${r.table}（${r.label}）【可读】\n${r.desc}\n列：\n${Object.entries(r.columns).map(([c, d]) => `- ${c}：${d}`).join("\n")}`;
  }
  return (
    "可读表（用 parent_db_read 查询）：\n" +
    readSpecs.map((s) => `- ${s.table}（${s.label}）：${s.desc}`).join("\n") +
    "\n\n可写表（用 parent_db_write，允许操作见单表详情）：\n" +
    writeSpecs.map((s) => `- ${s.table}（${s.label}）：允许 ${s.ops.join("/")}`).join("\n")
  );
}

/** 通用受控读：等值 where + 列裁剪 + 排序 + 行数上限（全部参数化，无自由 SQL）。
 *  F1：返回体按字符预算截断（SQL 下沉 ≠ 结果不进上下文）；F6：countOnly 走 SELECT COUNT(*)。 */
export interface ReadRequest {
  table: string;
  /** 缺省=全部可读列（ISSUE-133：类型放宽，executeRead 内部归一，兼容 JSON 字符串形态） */
  columns?: unknown;
  where?: unknown;
  /** 排序列（须在可读列内），缺省不加 ORDER BY */
  orderBy?: string;
  /** 缺省正序；orderBy 给了才生效 */
  orderDesc?: boolean;
  limit?: number;
  /** 跳过前 N 行（配合 limit/orderBy 分页拉全量；分页必须带 orderBy，否则顺序不稳定） */
  offset?: number;
  /** true=只返回命中行数（同套 where 编译 SELECT COUNT(*)，F6） */
  countOnly?: boolean;
}

const READ_DEFAULT_LIMIT = 50;
const READ_MAX_LIMIT = 200;
/** F1 默认返回体字符预算；单列超长截断阈值 */
const READ_BUDGET_CHARS = 40_000;
const CELL_MAX_CHARS = 4_000;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…〔超长截断，单列上限 ${n} 字〕` : s);

/** 行数组 → 预算内的文本（超预算按行截断；单列超长先裁剪）。返回 [文本, 是否截断, 实际返回行数] */
export function renderRowsBudget(
  rows: Array<Record<string, unknown>>,
  budget = READ_BUDGET_CHARS
): [string, boolean, number] {
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cell: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      cell[k] = typeof v === "string" ? clip(v, CELL_MAX_CHARS) : v;
    }
    const line = JSON.stringify(cell);
    if (used + line.length > budget && i > 0) {
      return [lines.join("\n"), true, i];
    }
    lines.push(line);
    used += line.length + 1;
  }
  return [lines.join("\n"), false, rows.length];
}

export function executeRead(db: DatabaseSync, specs: ReadableTableSpec[], req: ReadRequest): { ok: boolean; text: string; missedEmbedded?: { table: string; column: string; value: unknown }[] } {
  const spec = specs.find((s) => s.table === req.table);
  if (!spec) {
    return { ok: false, text: `没有登记名为「${req.table}」的可读表。可用：${specs.map((s) => s.table).join("、")}` };
  }
  // ISSUE-133：字符串化参数先归一（where/columns 被整串 JSON 序列化时同样会撞 SDK 校验）
  const whereArg = coerceObjectArg(req.where, "where");
  if (whereArg.error) return { ok: false, text: whereArg.error };
  const colsArg = coerceColumnsArg(req.columns);
  if (colsArg.error) return { ok: false, text: colsArg.error };
  const reqCols = colsArg.value;
  const allCols = Object.keys(spec.columns);
  let cols = allCols;
  if (reqCols?.length) {
    const unknown = reqCols.filter((c) => !spec.columns[c]);
    if (unknown.length) {
      // F2 自愈：列名错直接回可用列清单，一次往返内纠正
      return { ok: false, text: `列未登记不可读：${unknown.join("、")}。${spec.table} 可用列：${allCols.join("、")}` };
    }
    cols = reqCols;
  }
  const whereEntries = Object.entries(whereArg.value).filter(([, v]) => v !== undefined && v !== null && String(v) !== "");
  for (const [col] of whereEntries) {
    if (!spec.columns[col]) {
      return { ok: false, text: `where 条件列 ${col} 不可读。${spec.table} 可用列：${allCols.join("、")}` };
    }
  }
  let orderSql = "";
  if (req.orderBy) {
    if (!spec.columns[req.orderBy]) return { ok: false, text: `排序列 ${req.orderBy} 不可读（可用：${allCols.join("、")}）` };
    orderSql = ` ORDER BY ${req.orderBy} ${req.orderDesc ? "DESC" : "ASC"}`;
  }
  const limit = Math.max(1, Math.min(Number(req.limit) || READ_DEFAULT_LIMIT, READ_MAX_LIMIT));
  const offset = Math.max(0, Math.floor(Number(req.offset) || 0));
  const whereSql = whereEntries.length ? ` WHERE ${whereEntries.map(([c]) => `${c} = ?`).join(" AND ")}` : "";
  const whereVals = whereEntries.map(([, v]) => sqlVal(v));

  if (req.countOnly) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${spec.table}${whereSql}`).get(...whereVals) as { n: number }).n;
    return { ok: true, text: `${spec.label}（${spec.table}）：命中 ${n} 行。` };
  }

  const pageSql = ` LIMIT ${limit} OFFSET ${offset}`;
  const sql = `SELECT ${cols.join(", ")} FROM ${spec.table}${whereSql}${orderSql}${pageSql}`;
  const rows = db.prepare(sql).all(...whereVals) as Array<Record<string, unknown>>;
  if (!rows.length) {
    // F2 自愈：空结果时给条件列的实际取值样例，帮 agent 一次纠正值选错
    // ISSUE-111：登记了向量的列同时记入 missedEmbedded，调用方可附向量候选（只提示不代入）
    const missedEmbedded: Array<{ table: string; column: string; value: unknown }> = [];
    for (const [col, value] of whereEntries) {
      if (embeddedColumn(spec.table, col)) missedEmbedded.push({ table: spec.table, column: col, value });
    }
    const samples: string[] = [];
    for (const [col] of whereEntries) {
      try {
        const vals = db
          .prepare(`SELECT DISTINCT ${col} FROM ${spec.table} WHERE ${col} IS NOT NULL AND ${col} != '' LIMIT 5`)
          .all() as Array<Record<string, unknown>>;
        samples.push(`${col} 实际取值样例：${vals.map((r) => JSON.stringify(Object.values(r)[0])).join("、") || "（无非空值）"}`);
      } catch {
        /* 样例失败不阻塞 */
      }
    }
    return {
      ok: true,
      text: `${spec.label}（${spec.table}）：查询结果为空。${samples.length ? `\n${samples.join("\n")}` : ""}`,
      missedEmbedded: missedEmbedded.length ? missedEmbedded : undefined,
    };
  }
  const [body, truncated, returned] = renderRowsBudget(rows);
  if (truncated) {
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${spec.table}${whereSql}`).get(...whereVals) as { n: number }).n;
    return {
      ok: true,
      text:
        `${spec.label}（${spec.table}）：已返前 ${returned} 行 / 共 ${total} 行（返回体超 ${READ_BUDGET_CHARS} 字预算被截断）。` +
        `取全文请收窄 where、用 columns 选列或减小 limit。\n${body}`,
    };
  }
  const orderNote = req.orderBy ? `，排序 ${req.orderBy}（翻页时排序键必须一致）` : "";
  const header =
    offset > 0
      ? `${spec.label}（${spec.table}）：第 ${offset + 1} ~ ${offset + rows.length} 行${orderNote}（单次最多 ${limit} 行）`
      : `${spec.label}（${spec.table}）：${rows.length} 行（最多返回 ${limit} 行${rows.length === limit ? `；未拉完可用 orderBy + offset 翻页${orderNote}` : ""}）`;
  return {
    ok: true,
    text: `${header}\n${body}`,
  };
}

/** 孩子侧 describe：可读表清单 + 可写表详情 */
export function describeChildTables(readSpecs: ReadableTableSpec[], writeSpecs: TableSpec[], table?: string): string {
  if (table) {
    const w = writeSpecs.find((s) => s.table === table);
    if (w) return describeTables(writeSpecs, table);
    const r = readSpecs.find((s) => s.table === table);
    if (!r) {
      return `没有登记名为「${table}」的表。可读表：\n` + readSpecs.map((s) => `- ${s.table}（${s.label}）：${s.desc}`).join("\n");
    }
    return `## ${r.table}（${r.label}）【只读】\n${r.desc}\n列：\n${Object.entries(r.columns).map(([c, d]) => `- ${c}：${d}`).join("\n")}`;
  }
  return (
    "可读表（用 child_db_read 查询）：\n" +
    readSpecs.map((s) => `- ${s.table}（${s.label}）：${s.desc}`).join("\n") +
    "\n\n可写表（用 child_db_write，允许操作见单表详情）：\n" +
    writeSpecs.map((s) => `- ${s.table}（${s.label}）：允许 ${s.ops.join("/")}`).join("\n")
  );
}
