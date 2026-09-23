/**
 * ISSUE-134 回归（2026-09-23）：工具参数「被模型序列化成字符串」的统一还原层。
 *
 * 背景：`mimo-v2.5` 无法表达 JSON Schema 的 `anyOf`——凡联合类型属性一律退化成 JSON 字符串
 * （生产实测 `parent_db_write.rows` 26/26），深长嵌套数组（`items`/`days`）也会被整串序列化；
 * 而 SDK 校验只做标量转换、不做 string→结构 解析 ⇒ 校验在**执行器之前**硬失败。
 *
 * 修复：用 SDK 官方钩子 `prepareArguments`（校验前调用）在 `tool-kit.ts` 里统一还原。
 * 本测试分两部分：
 *   A. 单元——还原规则表（含**误伤防护**：内容形如 JSON 的普通文本字段必须原样）；
 *   B. 集成——真实工具对象 + SDK 同款两步（prepareArguments → Value.Convert + Check）+ 真执行/真校验。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { coerceToolArgs, defineTool } from "../server/src/agent/tool-kit";
import { createDataAgentTools, createParentAgentTools } from "../server/src/agent/parent-tools";
import { createPlanDomainTools } from "../server/src/agent/parent-plans";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";

// ==================== A. 单元：还原规则表 ====================

/** 与 parent_db_write 同构：rows = 行数组 | 列值对象（anyOf 联合）；where 的值是 Unknown */
const writeSchema = Type.Object({
  table: Type.String(),
  op: Type.Union([Type.Literal("insert"), Type.Literal("update"), Type.Literal("delete")]),
  rows: Type.Optional(
    Type.Union([Type.Array(Type.Record(Type.String(), Type.Unknown())), Type.Record(Type.String(), Type.Unknown())])
  ),
  where: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/** 与 parent_upsert_course_content 同构：深长嵌套数组 + 普通文本字段（answer） */
const quizSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      knowledgePoint: Type.String(),
      questions: Type.Array(Type.Object({ stem: Type.String(), answer: Type.String() })),
    })
  ),
  note: Type.Optional(Type.String()),
});

const coerce = (schema: unknown, args: Record<string, unknown>) => coerceToolArgs(schema, args) as Record<string, unknown>;

describe("ISSUE-134 A. 还原规则（只动 schema 期望 object/array 的位置）", () => {
  it("① rows 字符串（数组写法）→ 还原成真数组", () => {
    const out = coerce(writeSchema, { table: "t", op: "update", rows: '[{"status":"done","result":"done"}]' });
    expect(Array.isArray(out.rows)).toBe(true);
    expect((out.rows as any)[0].status).toBe("done");
  });

  it("② rows 字符串（对象写法）→ 还原成真对象", () => {
    const out = coerce(writeSchema, { table: "t", op: "update", rows: '{"status":"done"}' });
    expect(Array.isArray(out.rows)).toBe(false);
    expect(out.rows).toEqual({ status: "done" });
  });

  it("③ 真数组 / 真对象 → 值不变（零干扰）", () => {
    const arr = [{ a: 1 }];
    const obj = { a: 1 };
    expect(coerce(writeSchema, { table: "t", op: "update", rows: arr }).rows).toEqual(arr);
    expect(coerce(writeSchema, { table: "t", op: "update", rows: obj }).rows).toEqual(obj);
  });

  it("④ 字符串但不是合法 JSON → 抛可读中文原因（模型看得懂）", () => {
    expect(() => coerce(writeSchema, { table: "t", op: "update", rows: '[{"status":' })).toThrow(/不是合法 JSON/);
    expect(() => coerce(writeSchema, { table: "t", op: "update", rows: '[{"status":' })).toThrow(/直接/);
  });

  it("⑤ 普通文字（非 JSON 形态）→ 原样交回校验层（不猜、不改）", () => {
    const out = coerce(writeSchema, { table: "t", op: "update", rows: "done" });
    expect(out.rows).toBe("done");
  });

  it("⑥ 深长嵌套：items 字符串 + 内层 questions 也字符串 → 两层都还原", () => {
    const raw = { items: '[{"knowledgePoint":"背诵","questions":"[{\\"stem\\":\\"背\\",\\"answer\\":\\"子曰\\"}]"}]' };
    const out = coerce(quizSchema, raw);
    expect(Array.isArray(out.items)).toBe(true);
    const qs = (out.items as any)[0].questions;
    expect(Array.isArray(qs)).toBe(true);
    expect(qs[0].answer).toBe("子曰");
  });

  it("⑦ 误伤防护：answer 是「内容形如 JSON 的普通文本」→ 一个字不动", () => {
    const answer = '{"dims":[{"dim":"a","score":6}]}';
    const out = coerce(quizSchema, { items: [{ knowledgePoint: "x", questions: [{ stem: "s", answer }] }] });
    expect((out.items as any)[0].questions[0].answer).toBe(answer);
  });

  it("⑧ 误伤防护：顶层 note 是 JSON 文本 → 原样", () => {
    const out = coerce(quizSchema, { items: [{ knowledgePoint: "x", questions: [{ stem: "s", answer: "a" }] }], note: '{"a":1}' });
    expect(out.note).toBe('{"a":1}');
  });

  it("⑨ 误伤防护：where 的值是 Type.Unknown → 即便形如 JSON 也不解析", () => {
    const out = coerce(writeSchema, { table: "t", op: "update", where: { id: "x", raw: '{"a":1}' } });
    expect(out.where).toEqual({ id: "x", raw: '{"a":1}' });
  });

  it("⑩ 不改入参、返回新对象、不新增缺省键", () => {
    const raw = { table: "t", op: "update", rows: '[{"a":1}]' };
    const out = coerce(writeSchema, raw);
    expect(out).not.toBe(raw);
    expect(raw.rows).toBe('[{"a":1}]'); // 模型原始输出保持不变（jsonl 里仍如实落盘）
    expect("where" in out).toBe(false);
  });

  it("⑪ 包装器 defineTool 会注入 prepareArguments（且保留原有字段）", () => {
    const t = defineTool({
      name: "t_demo",
      label: "demo",
      description: "d",
      parameters: writeSchema,
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
    });
    expect(typeof (t as any).prepareArguments).toBe("function");
    expect(t.name).toBe("t_demo");
    const prepared = (t as any).prepareArguments({ table: "t", op: "update", rows: '[{"a":1}]' });
    expect(Array.isArray(prepared.rows)).toBe(true);
  });
});

// ==================== B. 集成：真实工具 + SDK 同款两步 ====================

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue134-"));
const parentId = "parent-134";
const childId = "child-134";
const now = new Date().toISOString();

const mainDb = openDb(dataDir);
mainDb.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(parentId, "p134@test", now, now);
mainDb
  .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(childId, parentId, "珊珊", now, now);

const kb = openKb(dataDir, parentId, childId);
const pdb = openParentLib(dataDir, parentId);

kb.prepare(
  `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,recurrence_id,
     start_at,due_at,status,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
   VALUES ('plan-134',?,?, 'lunyu','u-1','论语学而篇','new','parent','conversation','','',
     '2026-09-23 00:00:00','2026-09-23 23:59:59','pending','','','required',1,0,1,?,?)`
).run(parentId, childId, now, now);

pdb.prepare("INSERT INTO topics (name, topic_key, method, progress, rules_json) VALUES ('论语','lunyu','','','{}')").run();
pdb
  .prepare(
    "INSERT INTO courses (topic, title, uuid, sort_order, material, send_material, tags, lesson_method, html_path, teaching_copy, assess_rubric) VALUES ('lunyu','内容测试课','u-content-134',2,'','','','','','','')"
  )
  .run();

const deps = {
  db: mainDb,
  dataDir,
  parentId,
  workspaceDir: path.join(dataDir, "ws"),
  agentDir: path.join(dataDir, "agent"),
  auth: {},
};
const parentTools = createParentAgentTools(deps);
// 计划域工具（学习/生活/考核计划、重复规则）由独立构造器提供，注册在 parent-registry.ts
const planTools = createPlanDomainTools({ db: mainDb, dataDir, parentId });
const dataTools = createDataAgentTools(deps);
const allTools = [...parentTools, ...planTools, ...dataTools];
const tool = (name: string) => {
  const t = allTools.find((x) => x.name === name);
  if (!t) throw new Error(`工具不存在：${name}`);
  return t as unknown as {
    name: string;
    parameters: unknown;
    prepareArguments?: (args: unknown) => Record<string, unknown>;
    execute: (id: string, args: any) => Promise<any>;
  };
};

/** 复刻 SDK `agent-loop.js:403-404` 的两步：prepareArguments → Value.Convert + Check */
function sdkSteps(name: string, rawArgs: Record<string, unknown>) {
  const t = tool(name);
  const prepared = t.prepareArguments ? t.prepareArguments(rawArgs) : rawArgs;
  const args = structuredClone(prepared);
  Value.Convert(t.parameters as any, args);
  const v = Compile(t.parameters as any);
  const ok = v.Check(args);
  return { ok, errors: ok ? [] : v.Errors(args).map((e) => `${e.instancePath || "root"}: ${e.message}`), args };
}

const runTool = async (name: string, rawArgs: Record<string, unknown>): Promise<string> => {
  const t = tool(name);
  const step = sdkSteps(name, rawArgs);
  expect(step.errors, `${name} 参数校验应通过`).toEqual([]);
  const r = await t.execute("call-134", step.args);
  return r.content.map((c: { text: string }) => c.text).join("\n");
};

afterAll(() => {
  for (const d of [kb, pdb, mainDb]) {
    try {
      d.close();
    } catch {
      /* 忽略 */
    }
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL 句柄滞后，忽略 */
  }
});

describe("ISSUE-134 B. 全部工具都挂上了还原层", () => {
  it("⑫ 三个构造器（家长/计划域/数据管理）的每个工具都有 prepareArguments", () => {
    expect(allTools.length).toBeGreaterThan(20);
    const missing = allTools.filter((t) => typeof (t as any).prepareArguments !== "function").map((t) => t.name);
    expect(missing).toEqual([]);
  });
});

describe("ISSUE-134 B. 生产故障形态：字符串化参数现在能真正执行", () => {
  it("⑬ 用户原始场景：parent_db_write rows 字符串 → 校验过 + 计划真被改成 done/done", async () => {
    const text = await runTool("parent_db_write", {
      table: "study_plans",
      child: "珊珊",
      op: "update",
      rows: '[{"status":"done","result":"done"}]',
      where: { id: "plan-134" },
    });
    expect(text).toContain("update study_plans 成功");
    const row = kb.prepare("SELECT status,result FROM study_plans WHERE id='plan-134'").get() as any;
    expect(row).toMatchObject({ status: "done", result: "done" });
  });

  it("⑭ 整课替换 items 字符串 → 校验过 + 知识点/题/挂载真落库", async () => {
    const text = await runTool("parent_upsert_course_content", {
      topic: "lunyu",
      title: "内容测试课",
      items: JSON.stringify([
        { knowledgePoint: "背诵", detail: "能逐字背诵", questions: [{ stem: "背诵本章原文", answer: "子曰：学而时习之" }] },
      ]),
    });
    expect(text).toContain("已写入课程");
    expect((pdb.prepare("SELECT COUNT(*) c FROM knowledge_points").get() as any).c).toBeGreaterThan(0);
    expect((pdb.prepare("SELECT COUNT(*) c FROM question_bank").get() as any).c).toBeGreaterThan(0);
  });

  it("⑮ 非法 JSON → 走可读原因（不再是一句 must be object）", async () => {
    let msg = "";
    try {
      const t = tool("parent_db_write");
      const prepared = t.prepareArguments!({
        table: "study_plans",
        child: "珊珊",
        op: "update",
        rows: '[{"status":',
        where: { id: "plan-134" },
      });
      prepared.toString();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("不是合法 JSON");
  });
});

describe("ISSUE-134 B. 逐参数补丁漏掉的那批参数（本次一次覆盖）", () => {
  it("⑯ parent_study_plan_create：days 字符串 + 内层 content 也字符串 → 校验通过", () => {
    const step = sdkSteps("parent_study_plan_create", {
      childName: "珊珊",
      days: '[{"date":"2026-09-23","content":"[\\"论语学而篇\\"]"}]',
    });
    expect(step.errors).toEqual([]);
    const days = step.args.days as any;
    expect(Array.isArray(days)).toBe(true);
    expect(Array.isArray(days[0].content)).toBe(true);
  });

  it("⑰ parent_exam_plan_create：courses 字符串 + methodSpec 字符串（内层 require/exclude 也是字符串）→ 校验通过", () => {
    const step = sdkSteps("parent_exam_plan_create", {
      childName: "珊珊",
      scheduledAt: "2026-09-23",
      courses: '["论语学而篇"]',
      methodSpec: '{"require":"{\\"背诵\\":1}","exclude":"[\\"典故\\"]","recitePass":90}',
    });
    expect(step.errors).toEqual([]);
    const ms = step.args.methodSpec as any;
    expect(ms.require).toEqual({ 背诵: 1 });
    expect(ms.exclude).toEqual(["典故"]);
  });

  it("⑱ parent_sync_courses_to_child：titles 字符串 → 校验通过", () => {
    const step = sdkSteps("parent_sync_courses_to_child", { child: "珊珊", titles: '["论语学而篇"]' });
    expect(step.errors).toEqual([]);
    expect(step.args.titles).toEqual(["论语学而篇"]);
  });

  it("⑲ parent_recurrence_create：courses 字符串 → 校验通过", () => {
    const step = sdkSteps("parent_recurrence_create", {
      childName: "珊珊",
      planType: "study",
      rule: "daily",
      courses: '["论语学而篇"]',
    });
    expect(step.errors).toEqual([]);
    expect(step.args.courses).toEqual(["论语学而篇"]);
  });
});
