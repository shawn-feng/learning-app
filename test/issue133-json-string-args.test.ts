/**
 * ISSUE-133 回归（2026-09-22）：数据通道参数被**整串 JSON 序列化**时的兼容。
 *
 * 用户现场：`parent_db_write` 调 update，rows 传成字符串 `"[{\"status\":\"done\"}]"`，
 * 工具参数校验在**执行器之前**就硬失败：
 *   Validation failed for tool "parent_db_write":
 *   - rows: must be array / - rows: must be object / - rows: must match a schema in anyOf
 * 根因两层：① 模型把 anyOf 联合参数（数组/对象）整体序列化成字符串；
 * ② SDK `validateToolArguments` 只跑 TypeBox `Value.Convert`（标量转换），不做 string→结构 解析。
 *
 * 修复两层：① 工具 schema 为 rows/where/columns 显式加 string 分支（放行校验）；
 * ② 执行器入口 `parseJsonArg` / `coerceObjectArg` / `coerceColumnsArg` 把字符串 parse 回结构，
 *    parse 不了回可读中文原因（绝不静默）。
 *
 * **2026-09-25（ISSUE-144 P6）改口径**：`parent_db_write` / `parent_db_read` 两把通用通道工具已整组退场，
 * 消费者不再存在——但**契约本身没退**：
 * - ① 底层执行器（`executeWrite` / `executeRead` / `tier2Write`）仍然吃字符串形态 → 本文件按**执行器级**验证；
 * - ② 仍在工具面上的复合参数（`parent_upsert_course_content.items`，实测 17% 被字符串化）→ 仍按
 *   **真实工具对象 + SDK 同款校验步骤**验证（⑦ 段）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { createParentAgentTools } from "../server/src/agent/parent-tools";
import {
  executePathRead,
  executeRead,
  executeWrite,
  childKbReadableRegistry,
  childKbAdminWriteSpecs,
  parentReadableRegistry,
  parentLibTableRegistry,
  type RegistryPath,
  type WriteRequest,
} from "../server/src/agent/db-channel";
import { tier2Read, tier2Write, type NamespaceRow } from "../server/src/agent/tier2";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue133-"));
const parentId = "parent-133";
const childId = "child-133";
const now = new Date().toISOString();

const mainDb = openDb(dataDir);
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p133@test", now, now);
mainDb
  .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(childId, parentId, "珊珊", now, now);

const kb = openKb(dataDir, parentId, childId);
const pdb = openParentLib(dataDir, parentId);

/** 用户现场那条学习计划（与 ISSUE-128 同构） */
kb.prepare(
  `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,recurrence_id,
     start_at,due_at,status,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
   VALUES ('ba4180ab',?,?, 'lunyu','u-1','论语学而篇','new','parent','conversation','','',
     '2026-09-22 00:00:00','2026-09-22 23:59:59','pending','','','required',1,0,1,?,?)`
).run(parentId, childId, now, now);

// 家长库播种一个主题 + 两门课（路径/通用读用）
pdb
  .prepare("INSERT INTO topics (name, topic_key, method, progress, rules_json) VALUES ('论语','lunyu','','','{}')")
  .run();
pdb
  .prepare(
    "INSERT INTO courses (topic, title, sort_order, material, send_material, tags, lesson_method, html_path, teaching_copy, assess_rubric) VALUES ('lunyu','学而篇',1,'','','','','','','')"
  )
  .run();
// 整课替换（parent_upsert_course_content）要求课程带 uuid 锚点
pdb
  .prepare(
    "INSERT INTO courses (topic, title, uuid, sort_order, material, send_material, tags, lesson_method, html_path, teaching_copy, assess_rubric) VALUES ('lunyu','内容测试课','u-content-1',2,'','','','','','','')"
  )
  .run();

/**
 * ISSUE-144 P6 之后：通用通道的那两把工具已不在工具面上，这里改测**它当年直调的执行器**
 * （`executeWrite` + 孩子库管理写规格）——字符串归一化契约在同一个函数里，覆盖等价。
 */
const kbAdminSpecs = childKbAdminWriteSpecs();
const writeKb = (req: WriteRequest) => executeWrite(kb, kbAdminSpecs, req);
/** 家长库写面（tier1）——与孩子库写面同构，用于列校验那条。 */
const writeParent = (req: WriteRequest) => executeWrite(pdb, parentLibTableRegistry(), req);

/**
 * 复刻 SDK `validateToolArguments` 的校验步骤（pi-ai/dist/utils/validation.js）：
 * schema 带 TypeBox Kind 符号时只跑 `Value.Convert`（标量转换）→ `Compile(schema).Check(args)`。
 * 返回 false 即「报错现场」——工具执行器根本没机会跑。
 */
function sdkValidate(schema: unknown, rawArgs: Record<string, unknown>): { ok: boolean; errors: string[] } {
  const args = structuredClone(rawArgs);
  Value.Convert(schema as any, args);
  const v = Compile(schema as any);
  if (v.Check(args)) return { ok: true, errors: [] };
  return { ok: false, errors: v.Errors(args).map((e) => `${e.instancePath || "root"}: ${e.message}`) };
}

const runTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const t = tool(name);
  const check = sdkValidate(t.parameters, args);
  expect(check.errors, `工具 ${name} 参数校验应通过`).toEqual([]);
  const r = await t.execute("call-1", args);
  return r.content.map((c: { text: string }) => c.text).join("\n");
};

const planRow = () => kb.prepare("SELECT status, result FROM study_plans WHERE id='ba4180ab'").get() as any;

afterAll(() => {
  for (const db of [kb, pdb, mainDb]) {
    try {
      db.close();
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

describe("ISSUE-133 ①：schema 放行字符串形态（不再在执行器之前硬失败）", () => {
  it("通用通道已退场：家长工具面不含 parent_db_*，但不影响 items 的 string 分支", () => {
    const names = createParentAgentTools({
      db: mainDb,
      dataDir,
      parentId,
      workspaceDir: path.join(dataDir, "ws"),
      agentDir: path.join(dataDir, "agent"),
      auth: {},
    }).map((t: any) => t.name);
    expect(names.filter((n: string) => n.startsWith("parent_db_"))).toEqual([]);
    // 仍在工具面上的复合参数（items）必须留 string 分支——见 ⑦ 段实测
    const content = createParentAgentTools({
      db: mainDb,
      dataDir,
      parentId,
      workspaceDir: path.join(dataDir, "ws"),
      agentDir: path.join(dataDir, "agent"),
      auth: {},
    }).find((t: any) => t.name === "parent_upsert_course_content") as any;
    expect(JSON.stringify(content.parameters)).toContain('"type":"string"');
  });
});

describe("ISSUE-133 ②：报错现场原样重放——字符串化 rows 能写进去（执行器级）", () => {
  it("① 用户原始调用：rows 传 JSON 字符串 → 计划被改为 done/done", () => {
    const r = writeKb({
      table: "study_plans",
      op: "update",
      rows: '[{"status":"done","result":"done"}]',
      where: { id: "ba4180ab" },
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("update study_plans 成功");
    expect(planRow()).toMatchObject({ status: "done", result: "done" });
  });

  it("② rows 与 where 同时被字符串化 → 同样成功", () => {
    const r = writeKb({
      table: "study_plans",
      op: "update",
      rows: '{"result":"done-2"}',
      where: '{"id":"ba4180ab"}',
    });
    expect(r.ok).toBe(true);
    expect(planRow().result).toBe("done-2");
  });

  it("③ insert：rows 传字符串化行数组 → 插入成功", () => {
    const r = writeKb({
      table: "study_plans",
      op: "insert",
      rows: JSON.stringify([
        {
          id: "plan-133-insert",
          parent_id: parentId,
          child_id: childId,
          topic_key: "lunyu",
          course_uuid: "u-1",
          course_name: "新增计划",
          mode: "new",
          creator: "parent",
          origin: "conversation",
          start_at: "2026-09-22 00:00:00",
          due_at: "2026-09-22 23:59:59",
          status: "pending",
          result: "",
          task_type: "required",
          count_in_rate: 1,
          points: 0,
          active: 1,
          created_at: now,
          updated_at: now,
        },
      ]),
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("insert study_plans 成功");
    expect(kb.prepare("SELECT 1 FROM study_plans WHERE id='plan-133-insert'").get()).toBeTruthy();
  });

  it("④ 字符串但不是合法 JSON → 回可读原因，且数据未变", () => {
    const before = planRow();
    const r = writeKb({
      table: "study_plans",
      op: "update",
      rows: '[{"result":',
      where: { id: "ba4180ab" },
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("不是合法 JSON");
    expect(r.text).toContain("不要传 JSON 序列化后的文本");
    expect(planRow()).toEqual(before);
  });
});

describe("ISSUE-133 ③：原有形态零回归（ISSUE-122 双向兼容保持）", () => {
  it("⑤ update rows 真对象 / 真数组仍成功", () => {
    const t1 = writeKb({ table: "study_plans", op: "update", rows: { result: "obj" }, where: { id: "ba4180ab" } });
    expect(t1.ok).toBe(true);
    expect(planRow().result).toBe("obj");

    const t2 = writeKb({ table: "study_plans", op: "update", rows: [{ result: "arr" }], where: { id: "ba4180ab" } });
    expect(t2.ok).toBe(true);
    expect(planRow().result).toBe("arr");
  });

  it("⑥ 列校验不受影响（未登记列仍拒绝）", () => {
    const r = writeParent({ table: "courses", op: "update", rows: '{"not_a_column":1}', where: { title: "学而篇" } });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("未登记");
  });
});

describe("ISSUE-133 ④：读侧同样归一（底层执行器）", () => {
  it("⑧ executeRead 单测：字符串化 where/columns", () => {
    const r = executeRead(pdb, parentReadableRegistry(), {
      table: "courses",
      where: '{"topic":"lunyu"}',
      columns: '["title"]',
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("学而篇");
  });

  it("⑨ executePathRead 单测：字符串化 where/columns", () => {
    const p: RegistryPath = {
      name: "issue133_courses",
      label: "课程",
      desc: "测试路径",
      select: "courses",
      hops: [],
      filterable: ["courses.topic"],
      returns: ["courses.topic", "courses.title"],
      rowLimit: 50,
    };
    const r = executePathRead(pdb, [p], { path: "issue133_courses", where: '{"courses.topic":"lunyu"}', columns: '["courses.title"]' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("学而篇");
  });

  it("⑩ 空结果自愈（字符串化 where 命中 0 行）→ 不再是校验硬失败", () => {
    const r = executeRead(pdb, parentReadableRegistry(), { table: "courses", where: '{"topic":"不存在的主题"}' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("为空");
  });
});

describe("ISSUE-133 ⑤：Tier 2 灵活实体同构修复", () => {
  const ns: NamespaceRow = {
    ns: "issue133test",
    scope: "parent",
    label: "测试实体",
    version: 1,
    spec: {
      columns: {
        name: { kind: "text", desc: "名称" },
        note: { kind: "text", desc: "备注", notEmpty: false },
      },
      insertRequired: ["name"],
      filterable: ["name"],
    },
  };

  it("⑪ tier2 insert/update/read：rows/where/columns 字符串化全通", () => {
    expect(tier2Write(pdb, ns, { op: "insert", rows: '{"name":"实体A","note":"old"}' }).ok).toBe(true);
    expect(tier2Write(pdb, ns, { op: "update", rows: '{"note":"new"}', where: '{"name":"实体A"}' }).ok).toBe(true);
    const read = tier2Read(pdb, ns, { where: '{"name":"实体A"}', columns: '["data"]' });
    expect(read.ok).toBe(true);
    expect(read.text).toContain("new");
  });

  it("⑫ tier2 非法 JSON 字符串 → 可读原因", () => {
    const r = tier2Write(pdb, ns, { op: "update", rows: "{bad", where: { name: "实体A" } });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("不是合法 JSON");
  });
});

describe("ISSUE-133 ⑥：孩子侧工具同款兜底", () => {
  it("⑬ child 读规格下 executeRead 也吃字符串形态", () => {
    const r = executeRead(kb, childKbReadableRegistry(), {
      table: "study_plans",
      where: '{"status":"done"}',
      columns: '["course_name"]',
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("论语学而篇");
  });
});

/**
 * 之所以不止修 rows：翻本机会话 jsonl 实测（20 个会话 / 550 次工具调用）——
 * `parent_upsert_course_content.items` 69 次调用里 **12 次**被模型写成 JSON 字符串
 * （09-14/15 连续「items.0: must be object」，模型重试 6 次仍照旧）；
 * 而扁平 map（`parent_db_read.where` 0/35）与标量数组（`parent_exam_plan_create.courses` 0/37）从不犯。
 * 即：**模型对「深层嵌套 + 长内容」的复合参数会整串序列化**，属同一类事故。
 */
describe("ISSUE-133 ⑦：整课替换 items（实测 17% 被字符串化）", () => {
  const pTools = createParentAgentTools({
    db: mainDb,
    dataDir,
    parentId,
    workspaceDir: path.join(dataDir, "ws"),
    agentDir: path.join(dataDir, "agent"),
    auth: {},
  });
  const contentTool = () => {
    const t = pTools.find((x) => x.name === "parent_upsert_course_content");
    if (!t) throw new Error("工具不存在：parent_upsert_course_content");
    return t as { parameters: unknown; execute: (id: string, args: any) => Promise<any> };
  };
  const runContent = async (args: Record<string, unknown>): Promise<string> => {
    const t = contentTool();
    const check = sdkValidate(t.parameters, args);
    expect(check.errors, "items 参数校验应通过").toEqual([]);
    const r = await t.execute("call-c1", args);
    return r.content.map((c: { text: string }) => c.text).join("\n");
  };
  const oneItem = [
    {
      knowledgePoint: "背诵",
      detail: "能逐字背诵本章原文",
      questions: [{ stem: "背诵本章原文", answer: "子曰：学而时习之", behavior: "speech_recite" }],
    },
  ];

  it("⑭ items 传 JSON 字符串 → 校验通过 + 知识点与题真落库", async () => {
    const text = await runContent({ topic: "lunyu", title: "内容测试课", items: JSON.stringify(oneItem) });
    expect(text).toContain("已写入课程");
    const kp = pdb.prepare("SELECT COUNT(*) c FROM knowledge_points").get() as { c: number };
    const qb = pdb.prepare("SELECT COUNT(*) c FROM question_bank").get() as { c: number };
    const mount = pdb.prepare("SELECT COUNT(*) c FROM course_knowledge_questions").get() as { c: number };
    expect(kp.c).toBeGreaterThan(0);
    expect(qb.c).toBeGreaterThan(0);
    expect(mount.c).toBeGreaterThan(0);
  });

  it("⑮ 真数组 items 零回归（原调用形态）", async () => {
    const text = await runContent({ topic: "lunyu", title: "内容测试课", items: oneItem });
    expect(text).toContain("已写入课程");
  });

  it("⑯ 非法 JSON 字符串 items → 可读原因（不再是一句 must be object）", async () => {
    // 该工具沿用「校验失败抛 Error」的既有约定（SDK 会把消息回给模型），所以这里断言抛出的文案
    const err = await runContent({ topic: "lunyu", title: "内容测试课", items: '[{"knowledgePoint":' }).catch(
      (e: Error) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("不是合法 JSON");
    expect((err as Error).message).toContain("不要传 JSON 序列化后的文本");
  });
});
