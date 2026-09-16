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

export interface TableSpec {
  /** 库内真实表名 */
  table: string;
  label: string;
  /** 一句话用途（describe 输出） */
  desc: string;
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
    },
    {
      table: "courses",
      label: "课程",
      desc: "主题下的课程；主键 (topic, title)，topic 必须是 topics.name 已有值",
      ops: ["insert", "update", "delete"],
      rowLimit: 50,
      pk: ["topic", "title"],
      insertRequired: ["topic", "title"],
      refChecks: [{ column: "topic", refTable: "topics", refColumn: "name", desc: "主题不存在" }],
      columns: {
        topic: str("所属主题名（topics.name）", 100),
        title: str("课程名", 200),
        sort_order: { kind: "number", desc: "排序序号", int: true, min: 0, max: 100000 },
        status: str("学习状态标记（⬜/✅ 等）", 10, { notEmpty: false }),
        last_review: str("最近复习日期 YYYY-MM-DD", 20, { notEmpty: false }),
        review_count: { kind: "number", desc: "复习次数", int: true, min: 0, max: 100000 },
        material: str("资料路径/说明", 2000, { notEmpty: false }),
        send_material: str("下发资料说明", 2000, { notEmpty: false }),
        tags: str("标签（顿号分隔）", 500, { notEmpty: false }),
        lesson_method: str("课程教法", 8000, { notEmpty: false }),
        html_path: str("HTML 资料路径", 1000, { notEmpty: false }),
        teaching_copy: str("教学文稿", 20000, { notEmpty: false }),
        assess_rubric: str("考核评分标准", 8000, { notEmpty: false }),
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

function writeAudit(
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

/** LLM 传入值 → node:sqlite 可存类型（null/number/bigint/string/Uint8Array） */
function sqlVal(v: unknown): null | number | bigint | string {
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
  /** insert=要插入的行数组；update=要写入的列值对象 */
  rows?: Array<Record<string, unknown>>;
  /** update/delete 的等值条件（列名→值），必须命中登记列；delete/update 必填 */
  where?: Record<string, unknown>;
}

export interface WriteResult {
  ok: boolean;
  text: string;
  /** confirm 列命中提示（有则 agent 必须向家长复述） */
  confirmHints: string[];
}

function validateValue(col: string, c: ColumnSpec, v: unknown): string | null {
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

  // —— where 构造与影响行数预览（update/delete 必填；只允许登记列的等值条件）——
  let whereClauses: Array<{ col: string; value: null | number | bigint | string }> = [];
  if (req.op !== "insert") {
    const w = req.where ?? {};
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
  db.exec("BEGIN");
  try {
    let affected = 0;

    if (req.op === "insert") {
      const rows = Array.isArray(req.rows) ? req.rows : [];
      if (!rows.length) fail("insert 需要至少一行 rows");
      if (rows.length > spec.rowLimit) {
        fail(`一次最多插入 ${spec.rowLimit} 行，收到 ${rows.length} 行`);
      }
      for (const row of rows) {
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
            vals.push(col === "id" ? randomUUID() : null);
          }
        }
        for (const r of spec.refChecks ?? []) {
          const v = row[r.column];
          if (v === undefined || v === null || String(v) === "") continue; // 可空引用交由列校验/表约束兜底
          const hit = db.prepare(`SELECT 1 FROM ${r.refTable} WHERE ${r.refColumn} = ?`).get(sqlVal(v));
          if (!hit) fail(`${r.desc}：${r.column}=${String(v)}（须存在于 ${r.refTable}.${r.refColumn}）`);
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
        const sets = Object.entries(req.rows ?? {});
        if (!sets.length) fail("update 需要给出要写入的列值（rows 传对象）");
        for (const [col, value] of sets) {
          const c = spec.columns[col];
          if (!c) fail(`列 ${col} 未登记，不能写`);
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
      where: req.where ?? {},
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
    if (e instanceof ChannelError) return { ok: false, text: e.message, confirmHints: [] };
    return { ok: false, text: `执行失败（已回滚）：${String(e?.message || e)}`, confirmHints: [] };
  }
}

/** describe 的入口（供工具包装）：列出全部登记表或指定表的详情 */
export function findTableSpec(specs: TableSpec[], table: string): TableSpec | undefined {
  return specs.find((s) => s.table === table);
}
