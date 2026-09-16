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

/** 本地时间 YYYY-MM-DD HH:MM:SS（serverGenerated 时间戳列的填充值） */
function localDatetime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
  /** 服务端强制列值（insert 时覆盖 agent 传的同名列，如孩子身份），绕不过 */
  force?: Record<string, unknown>;
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

// ==================== 孩子库（kb.sqlite）登记（P2）：可读 / 可写 ====================

/** 可读表声明：列 → 含义（孩子 agent 的通用查询面） */
export interface ReadableTableSpec {
  table: string;
  label: string;
  desc: string;
  columns: Record<string, string>;
}

const R = (s: string) => s;

export function childKbReadableRegistry(): ReadableTableSpec[] {
  return [
    {
      table: "study_plans",
      label: "学习计划",
      desc: "家长/系统排的学习课程任务；我自己的学习安排",
      columns: {
        id: R("计划 id"), topic_key: R("主题标识"), course_name: R("课程名"), mode: R("new=新学/review=复习"),
        creator: R("创建人 parent/child"), start_at: R("开始时间"), due_at: R("截止时间"),
        status: R("pending/started/done/cancelled"), done_at: R("完成时间"), task_type: R("required=必须/optional=加分"),
        points: R("完成可得积分"), active: R("1=有效"),
      },
    },
    {
      table: "exam_plans",
      label: "考核计划",
      desc: "考核安排（只读！考核的开始/完成只能由考核流程写）",
      columns: {
        id: R("计划 id"), title: R("考核标题"), kind: R("fixed=固定档/custom=自定义"), freq: R("重复频率"),
        start_at: R("考核日期"), due_at: R("截止"), status: R("pending/started/done"), attempt_id: R("成绩记录 id"),
        score: R("得分"), done_at: R("完成时间"), points: R("积分"), scope_json: R("考核范围 JSON"),
      },
    },
    {
      table: "exam_plan_courses",
      label: "考核课程明细",
      desc: "每场考核计划的课程/知识点/题目范围与得分明细",
      columns: {
        plan_id: R("考核计划 id"), course_name: R("课程名"), knowledge_point_id: R("知识点 id"),
        question_id: R("题目 id"), point_got: R("得分"), point_max: R("满分"), seq: R("顺序"),
      },
    },
    {
      table: "life_plans",
      label: "生活计划",
      desc: "生活任务（家长的必须完成项 + 我自己创建的加分项）",
      columns: {
        id: R("计划 id"), title: R("事项"), creator: R("parent/child"), start_at: R("开始"), due_at: R("截止"),
        status: R("pending/started/done/cancelled"), task_type: R("required/optional"), points: R("积分"),
        active: R("1=有效"), done_at: R("完成时间"),
      },
    },
    {
      table: "daily_entries",
      label: "日常记录",
      desc: "每天的学习/生活/问答/任务记录（我自己的日常本）",
      columns: { date: R("日期 YYYY-MM-DD"), block: R("学习/生活/问答/任务"), title: R("标题"), raw: R("内容"), tags: R("标签") },
    },
    {
      table: "topics",
      label: "学习主题",
      desc: "我在学的主题目录",
      columns: { name: R("主题名"), topic_key: R("主题标识"), method: R("学习方法"), assess_method: R("考核方法") },
    },
    {
      table: "courses",
      label: "课程",
      desc: "主题下的课程与学习状态",
      columns: {
        topic: R("主题名"), title: R("课程名"), uuid: R("课程 uuid"), status: R("学习状态标记"),
        last_review: R("最近学习/复习时间"), review_count: R("复习次数"),
      },
    },
    {
      table: "reward_configs",
      label: "积分规则",
      desc: "家长定的积分/兑换规则（只读）",
      columns: {
        todo_tiers_json: R("每日任务积分档位 JSON"), exam_tiers_json: R("考核积分档位 JSON"),
        optional_points: R("加分项单条积分"), child_no_deduct: R("是否不扣分"),
      },
    },
    {
      table: "points_ledger",
      label: "积分流水",
      desc: "每笔积分的来龙去脉（只读；积分只能由系统流程产生）",
      columns: {
        biz_date: R("业务日期"), type: R("类型"), amount: R("变动值"), balance_after: R("变动后余额"),
        reason: R("原因"), source_table: R("来源表"), source_id: R("来源 id"), ts: R("时间"),
      },
    },
    {
      table: "points_balance",
      label: "积分余额",
      desc: "当前积分余额（只读）",
      columns: { balance: R("余额"), updated: R("更新时间") },
    },
    {
      table: "redemption_items",
      label: "兑换商品",
      desc: "家长发布的可兑换奖励（只读）",
      columns: { id: R("商品 id"), name: R("名称"), cost: R("所需积分"), kind: R("类型"), enabled: R("1=上架") },
    },
    {
      table: "redemption_requests",
      label: "我的兑换申请",
      desc: "我提交的兑换申请及审批状态（新增申请请用 child_db_write）",
      columns: {
        item_id: R("商品 id"), custom_desc: R("自定义奖励描述"), cost: R("消耗积分"), status: R("pending/approved/rejected/fulfilled"),
        created_at: R("申请时间"), fulfilled_at: R("发放时间"),
      },
    },
    {
      table: "reward_daily_stats",
      label: "每日积分统计",
      desc: "每天计划完成率与结算积分（只读）",
      columns: {
        date: R("日期"), source: R("todo/exam"), required_total: R("必须项总数"), required_done: R("已完成"),
        rate: R("完成率"), tier: R("档位"), points_awarded: R("结算积分"),
      },
    },
    {
      table: "plan_recurrences",
      label: "重复规则",
      desc: "周期任务的重复规则（只读；展开由系统做）",
      columns: { plan_type: R("life/study/exam"), rule: R("daily/weekly"), weekday: R("周几"), enabled: R("1=启用") },
    },
  ];
}

/** 孩子可写白名单：只有日常记录与兑换申请（考核/积分/计划状态机绝不开放，见 ISSUE-105 矩阵） */
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
    },
  ];
}

/** 通用受控读：等值 where + 列裁剪 + 排序 + 行数上限（全部参数化，无自由 SQL） */
export interface ReadRequest {
  table: string;
  /** 缺省=全部可读列 */
  columns?: string[];
  where?: Record<string, unknown>;
  /** 排序列（须在可读列内），缺省不加 ORDER BY */
  orderBy?: string;
  /** 缺省正序；orderBy 给了才生效 */
  orderDesc?: boolean;
  limit?: number;
}

const READ_DEFAULT_LIMIT = 50;
const READ_MAX_LIMIT = 200;

export function executeRead(db: DatabaseSync, specs: ReadableTableSpec[], req: ReadRequest): { ok: boolean; text: string } {
  const spec = specs.find((s) => s.table === req.table);
  if (!spec) {
    return { ok: false, text: `没有登记名为「${req.table}」的可读表。可用：${specs.map((s) => s.table).join("、")}` };
  }
  let cols = Object.keys(spec.columns);
  if (req.columns?.length) {
    const unknown = req.columns.filter((c) => !spec.columns[c]);
    if (unknown.length) return { ok: false, text: `列未登记不可读：${unknown.join("、")}（用 child_db_describe 查看可用列）` };
    cols = req.columns;
  }
  const whereEntries = Object.entries(req.where ?? {}).filter(([, v]) => v !== undefined && v !== null && String(v) !== "");
  for (const [col] of whereEntries) {
    if (!spec.columns[col]) return { ok: false, text: `where 条件列 ${col} 不可读，不能作为条件` };
  }
  let orderSql = "";
  if (req.orderBy) {
    if (!spec.columns[req.orderBy]) return { ok: false, text: `排序列 ${req.orderBy} 不可读` };
    orderSql = ` ORDER BY ${req.orderBy} ${req.orderDesc ? "DESC" : "ASC"}`;
  }
  const limit = Math.max(1, Math.min(Number(req.limit) || READ_DEFAULT_LIMIT, READ_MAX_LIMIT));
  const whereSql = whereEntries.length ? ` WHERE ${whereEntries.map(([c]) => `${c} = ?`).join(" AND ")}` : "";
  const sql = `SELECT ${cols.join(", ")} FROM ${spec.table}${whereSql}${orderSql} LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...whereEntries.map(([, v]) => sqlVal(v)));
  if (!rows.length) return { ok: true, text: `${spec.label}（${spec.table}）：查询结果为空。` };
  return {
    ok: true,
    text: `${spec.label}（${spec.table}）：${rows.length} 行（最多返回 ${limit} 行）\n${rows.map((r) => JSON.stringify(r)).join("\n")}`,
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
