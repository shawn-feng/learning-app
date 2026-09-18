/**
 * 通用实体数据 API 升级回归（2026-09-18 方案落地）：
 * - WP1/F13：refs 进读面（readableFromSpecs 派生）、courses.topic 引用修正（topics.topic_key）
 * - WP2/F14：孩子库读面派生化（补列/无幽灵列/tags 登记/死表不登记）
 * - WP3/F1+F6：读返回体字节预算、单列截断、countOnly、自愈式错误（列名错给可用列/空结果给取值样例）
 * - WP5/F15a：Tier 2（entities+namespaces、defineNamespace 演进规则、json_extract 下沉过滤、refs 应用层校验、审计）
 * - WP6/F10：命名路径（topic_questions 多跳、中间表过滤、非法路径/列拒绝、countOnly）
 * - WP4/F7：registry-prompt 元数据块（含 Tier 2 行）
 * - WP8/F10-b：assess-content 三处 JOIN 收编后行为不变
 * 用真实 openParentLib 文件库做夹具（含 Tier 2 schema）。
 */
import { describe, expect, it, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openParentLib } from "../server/src/db/parent-lib";
import {
  executeRead,
  executeWrite,
  executePathRead,
  buildPathQuery,
  parentLibTableRegistry,
  parentReadableRegistry,
  childKbReadableRegistry,
  childKbTableSpecs,
  readableFromSpecs,
  parentLibPaths,
  applyPathIndex,
  type RegistryPath,
} from "../server/src/agent/db-channel";
import {
  defineNamespace,
  loadNamespaces,
  tier2Read,
  tier2Write,
  describeNamespace,
} from "../server/src/agent/tier2";
import { buildDataChannelBlocks, buildChildSelfBlock } from "../server/src/agent/registry-prompt";
import {
  listTopicKnowledgePoints,
  listCourseContent,
  listAllBankQuestions,
  saveQuestion,
  getOrCreateKnowledgePoint,
  replaceCourseContent,
} from "../server/src/db/assess-content";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-channel-v2-"));
const parentId = "parent-v2";

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL 句柄滞后，忽略 */
  }
});

let libSeq = 0;
/** 搭一个真实家长库（每个用例独立 lib，避免状态泄漏）+ 种子：论语主题/2 课/2 知识点/2 题/挂载 */
function freshParentLib(): DatabaseSync {
  const pid = `${parentId}-${++libSeq}`;
  const db = openParentLib(dataDir, pid);
  db.prepare("INSERT OR IGNORE INTO topics (name, topic_key, method) VALUES (?, ?, ?)").run("论语", "lunyu", "诵读法");
  db.prepare(
    "INSERT OR IGNORE INTO courses (topic, title, uuid, sort_order, material, teaching_copy) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("lunyu", "学而篇", "u-xueer", 1, "学而材料", "学而文案".repeat(1200));
  db.prepare(
    "INSERT OR IGNORE INTO courses (topic, title, uuid, sort_order, material, teaching_copy) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("lunyu", "为政篇", "u-weizheng", 2, "为政材料", "为政文案");
  const q1 = saveQuestion(db, { stem: "学而时习之下一句？", answer: "不亦说乎" });
  const q2 = saveQuestion(db, { stem: "有朋自远方来下一句？", answer: "不亦乐乎" });
  const k1 = getOrCreateKnowledgePoint(db, "u-xueer", "背诵", "原文背诵");
  const k2 = getOrCreateKnowledgePoint(db, "u-weizheng", "句意", "白话释义");
  replaceCourseContent(db, "u-xueer", [{ knowledgePointId: k1.id, overview: "重点", questionIds: [q1] }]);
  replaceCourseContent(db, "u-weizheng", [{ knowledgePointId: k2.id, overview: "", questionIds: [q2] }]);
  return db;
}

describe("WP1/F13：关系真源与读面派生", () => {
  it("courses.topic 的引用校验指向 topics.topic_key（按 key 写入不再误拒）", () => {
    const db = freshParentLib();
    const r = executeWrite(db, parentLibTableRegistry(), {
      table: "courses",
      op: "insert",
      rows: [{ topic: "lunyu", title: "雍也篇", sort_order: 3 }],
    });
    expect(r.ok).toBe(true);
    // 乱写的 topic 仍被拒
    const bad = executeWrite(db, parentLibTableRegistry(), {
      table: "courses",
      op: "insert",
      rows: [{ topic: "不存在主题", title: "X" }],
    });
    expect(bad.ok).toBe(false);
    db.close();
  });

  it("readableFromSpecs 派生读面带 refs 与只读列（courses.uuid 可读、写面仍拒绝 uuid）", () => {
    const read = parentReadableRegistry();
    const courses = read.find((s) => s.table === "courses")!;
    expect(courses.columns.uuid).toBeTruthy(); // F14 补漂移列
    expect(courses.refs?.some((r) => r.refTable === "topics" && r.refColumn === "topic_key")).toBe(true);
    // 只读列不可写（id 是 serverGenerated 会被静默忽略，不在此列）
    const db = freshParentLib();
    const bad = executeWrite(db, parentLibTableRegistry(), {
      table: "question_bank",
      op: "insert",
      rows: [{ stem: "s", answer: "a", created_at: "2020-01-01" }],
    });
    expect(bad.ok).toBe(false);
    db.close();
  });
});

describe("WP2/F14：孩子库读面派生", () => {
  it("派生读面：补齐列、无幽灵列、tags 已登记、废弃表不出现", () => {
    const specs = childKbReadableRegistry();
    const byTable = new Map(specs.map((s) => [s.table, s]));
    const study = byTable.get("study_plans")!;
    for (const col of ["course_uuid", "recurrence_id", "count_in_rate", "origin", "carry_from", "result"]) {
      expect(study.columns[col]).toBeTruthy();
    }
    const topics = byTable.get("topics")!;
    expect(topics.columns.learn_type).toBeTruthy();
    expect(topics.columns.assess_method).toBeUndefined(); // 幽灵列已消灭
    expect(byTable.get("tags")).toBeTruthy();
    expect(byTable.get("todo_items")).toBeUndefined();
    // 派生面与 readableFromSpecs 单一真源一致
    expect(specs.length).toBe(readableFromSpecs(childKbTableSpecs()).length);
  });
});

describe("WP3/F1+F6：读预算 / countOnly / 自愈", () => {
  it("countOnly 走 COUNT(*)，不返回行", () => {
    const db = freshParentLib();
    const r = executeRead(db, parentReadableRegistry(), { table: "courses", where: { topic: "lunyu" }, countOnly: true });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("命中 2 行");
    expect(r.text).not.toContain("teaching_copy");
    db.close();
  });

  it("返回体超字符预算：按行截断 + 提示已返/共行数", () => {
    const db = freshParentLib();
    // 造 60 门课，每门 teaching_copy ~1.2 万字符 → 单行就超单列上限，多行远超 4 万预算
    for (let i = 0; i < 60; i++) {
      db.prepare(
        "INSERT OR IGNORE INTO courses (topic, title, uuid, sort_order, teaching_copy) VALUES (?, ?, ?, ?, ?)"
      ).run("lunyu", `批量课${i}`, `u-bulk-${i}`, 10 + i, "长".repeat(600));
    }
    const r = executeRead(db, parentReadableRegistry(), { table: "courses", where: { topic: "lunyu" }, limit: 200 });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("已返前");
    expect(r.text).toContain("共 62 行");
    expect(r.text).toContain("预算被截断");
    db.close();
  });

  it("单列超长截断并标注", () => {
    const db = freshParentLib();
    const r = executeRead(db, parentReadableRegistry(), {
      table: "courses",
      columns: ["title", "teaching_copy"],
      where: { title: "学而篇" },
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("超长截断");
    db.close();
  });

  it("自愈：列名错回可用列；空结果给条件列取值样例", () => {
    const db = freshParentLib();
    const badCol = executeRead(db, parentReadableRegistry(), { table: "courses", columns: ["nope"] });
    expect(badCol.ok).toBe(false);
    expect(badCol.text).toContain("可用列");
    expect(badCol.text).toContain("teaching_copy");
    const empty = executeRead(db, parentReadableRegistry(), { table: "courses", where: { topic: "math" } });
    expect(empty.ok).toBe(true);
    expect(empty.text).toContain("为空");
    expect(empty.text).toContain("topic 实际取值样例");
    expect(empty.text).toContain("lunyu");
    db.close();
  });
});

describe("WP5/F15a：Tier 2 灵活实体", () => {
  const NS_SPEC = {
    columns: {
      date: { kind: "string" as const, desc: "打卡日期 YYYY-MM-DD" },
      course_uuid: { kind: "string" as const, desc: "关联课程" },
      done: { kind: "number" as const, desc: "1=完成" },
      note: { kind: "string" as const, desc: "备注" },
    },
    insertRequired: ["date"],
    filterable: ["date", "course_uuid", "done"],
    refs: [{ column: "course_uuid", refTable: "courses", refColumn: "uuid" }],
  };

  function nsDb() {
    const db = freshParentLib();
    const r = defineNamespace(db, parentLibTableRegistry(), {
      ns: "habit_check",
      scope: "parent",
      label: "习惯打卡",
      spec: NS_SPEC,
    });
    expect(r.ok).toBe(true);
    return db;
  }

  it("defineNamespace：校验命名/字段/filterable/refs 目标", () => {
    const db = freshParentLib();
    expect(defineNamespace(db, parentLibTableRegistry(), { ns: "Bad-Name", scope: "parent", spec: NS_SPEC }).ok).toBe(false);
    expect(
      defineNamespace(db, parentLibTableRegistry(), { ns: "empty_ns", scope: "parent", spec: { columns: {} } }).ok
    ).toBe(false);
    expect(
      defineNamespace(db, parentLibTableRegistry(), {
        ns: "bad_filter",
        scope: "parent",
        spec: { columns: { a: { kind: "string", desc: "x" } }, filterable: ["ghost"] },
      }).ok
    ).toBe(false);
    expect(
      defineNamespace(db, parentLibTableRegistry(), {
        ns: "bad_ref",
        scope: "parent",
        spec: { columns: { a: { kind: "string", desc: "x" } }, refs: [{ column: "a", refTable: "ghost_table" }] },
      }).ok
    ).toBe(false);
    db.close();
  });

  it("演进规则：加字段 OK（version+1）、删字段/改类型被拒", () => {
    const db = nsDb();
    const evolved = defineNamespace(db, parentLibTableRegistry(), {
      ns: "habit_check",
      scope: "parent",
      label: "习惯打卡",
      spec: { ...NS_SPEC, columns: { ...NS_SPEC.columns, mood: { kind: "string", desc: "心情" } } },
    });
    expect(evolved.ok).toBe(true);
    expect(evolved.text).toContain("v2");
    const dropped = defineNamespace(db, parentLibTableRegistry(), {
      ns: "habit_check",
      scope: "parent",
      spec: {
        columns: { date: NS_SPEC.columns.date, done: NS_SPEC.columns.done },
        insertRequired: ["date"],
        filterable: ["date"],
      },
    });
    expect(dropped.ok).toBe(false);
    expect(dropped.text).toContain("不允许");
    const retyped = defineNamespace(db, parentLibTableRegistry(), {
      ns: "habit_check",
      scope: "parent",
      spec: {
        columns: {
          ...NS_SPEC.columns,
          done: { kind: "string", desc: "完成" }, // 只改类型，字段集不变
        },
        insertRequired: ["date"],
        filterable: ["date", "course_uuid", "done"],
        refs: NS_SPEC.refs,
      },
    });
    expect(retyped.ok).toBe(false);
    expect(retyped.text).toContain("kind");
    db.close();
  });

  it("写：insert 校验必填/未知字段/refs；update 与 delete 按 filterable 条件；审计落库", () => {
    const db = nsDb();
    const ns = loadNamespaces(db, "parent").find((n) => n.ns === "habit_check")!;
    expect(ns).toBeTruthy();

    const okIns = tier2Write(db, ns, { op: "insert", rows: [{ date: "2026-09-18", course_uuid: "u-xueer", done: 1, note: "打卡" }] });
    expect(okIns.ok, okIns.text).toBe(true);
    expect(okIns.text).toContain("影响 1 行");

    const missing = tier2Write(db, ns, { op: "insert", rows: [{ done: 1 }] });
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("date");

    const unknown = tier2Write(db, ns, { op: "insert", rows: [{ date: "2026-09-18", ghost: 1 }] });
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("ghost");

    const badRef = tier2Write(db, ns, { op: "insert", rows: [{ date: "2026-09-19", course_uuid: "u-none" }] });
    expect(badRef.ok).toBe(false);
    expect(badRef.text).toContain("引用校验");

    const updated = tier2Write(db, ns, { op: "update", rows: { note: "改过了" }, where: { date: "2026-09-18" } });
    expect(updated.ok, updated.text).toBe(true);
    expect(updated.text).toContain("影响 1 行");

    const deleted = tier2Write(db, ns, { op: "delete", where: { date: "2026-09-18" } });
    expect(deleted.ok).toBe(true);

    const noWhere = tier2Write(db, ns, { op: "delete" });
    expect(noWhere.ok).toBe(false);

    const audit = db.prepare("SELECT COUNT(*) AS n FROM db_audit WHERE table_name = 'ns:habit_check'").get() as { n: number };
    expect(audit.n).toBeGreaterThanOrEqual(3);
    db.close();
  });

  it("读：json_extract 下沉过滤 + countOnly + 空结果自愈样例", () => {
    const db = nsDb();
    const ns = loadNamespaces(db, "parent").find((n) => n.ns === "habit_check")!;
    tier2Write(db, ns, { op: "insert", rows: [{ date: "2026-09-17", done: 1 }, { date: "2026-09-18", done: 0 }] });
    const r = tier2Read(db, ns, { where: { done: 1 } });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("2026-09-17");
    expect(r.text).not.toContain("2026-09-18}");
    const cnt = tier2Read(db, ns, { where: { done: 0 }, countOnly: true });
    expect(cnt.text).toContain("命中 1 行");
    const empty = tier2Read(db, ns, { where: { date: "2020-01-01" } });
    expect(empty.text).toContain("date 实际取值样例");
    // describeNamespace 输出字段清单
    const d = describeNamespace(ns);
    expect(d).toContain("course_uuid");
    expect(d).toContain("Tier 2");
    db.close();
  });

  it("孩子 scope：loadNamespaces(child) 不含 parent scope 的 ns", () => {
    const db = nsDb();
    expect(loadNamespaces(db, "child")).toHaveLength(0);
    expect(loadNamespaces(db, "parent").length).toBe(1);
    db.close();
  });
});

describe("WP6/F10：命名路径", () => {
  it("topic_questions：一次拿到 主题→课程→知识点→挂载→题", () => {
    const db = freshParentLib();
    const r = executePathRead(db, parentLibPaths(), {
      path: "topic_questions",
      where: { "courses.topic": "lunyu" },
      columns: ["question_bank.stem", "question_bank.answer", "courses.title", "knowledge_points.name"],
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("学而时习之下一句");
    expect(r.text).toContain("学而篇");
    expect(r.text).toContain("背诵");
    // 中间表过滤（Q1 消解）：按知识点名过滤
    const byKp = executePathRead(db, parentLibPaths(), {
      path: "topic_questions",
      where: { "courses.topic": "lunyu", "knowledge_points.name": "句意" },
      columns: ["question_bank.stem"],
    });
    expect(byKp.ok).toBe(true);
    expect(byKp.text).toContain("有朋自远方来");
    expect(byKp.text).not.toContain("学而时习之下一句");
    // countOnly
    const cnt = executePathRead(db, parentLibPaths(), { path: "topic_questions", where: { "courses.topic": "lunyu" }, countOnly: true });
    expect(cnt.text).toContain("命中 2 行");
    db.close();
  });

  it("非法路径 / 白名单外列 / returns 裸列名冲突 均拒绝", () => {
    const db = freshParentLib();
    const badPath = executePathRead(db, parentLibPaths(), { path: "hack_join" });
    expect(badPath.ok).toBe(false);
    const badCol = executePathRead(db, parentLibPaths(), { path: "topic_questions", where: { "users.pw": "x" } });
    expect(badCol.ok).toBe(false);
    expect(badCol.text).toContain("可过滤列");
    const badReturn = executePathRead(db, parentLibPaths(), {
      path: "topic_questions",
      columns: ["question_bank.id", "users.pw"],
    });
    expect(badReturn.ok).toBe(false);
    // 注册期自检：returns 裸列名重复
    const dup: RegistryPath = {
      name: "dup_test",
      label: "",
      desc: "",
      select: "courses",
      hops: [{ table: "topics", on: { topic_key: "courses.topic" } }],
      filterable: [],
      returns: ["courses.topic", "topics.topic"],
      rowLimit: 10,
    };
    expect(() => buildPathQuery(dup, {})).toThrow(/裸列名/);
    db.close();
  });

  it("applyPathIndex：读面带路径反向索引", () => {
    const indexed = applyPathIndex(parentReadableRegistry(), parentLibPaths());
    const qb = indexed.find((s) => s.table === "question_bank")!;
    expect(qb.paths).toContain("topic_questions");
    const ckq = indexed.find((s) => s.table === "course_knowledge_questions")!;
    expect(ckq.paths).toContain("course_content_rows");
  });
});

describe("WP4/F7：元数据块", () => {
  it("家长/孩子两侧块包含表清单、路径与 Tier 2 行", () => {
    const pid = `${parentId}-wp4-${++libSeq}`;
    const db = openParentLib(dataDir, pid);
    defineNamespace(db, parentLibTableRegistry(), { ns: "habit_check", scope: "parent", label: "习惯打卡", spec: {
      columns: { date: { kind: "string", desc: "日期" } },
    } });
    db.close();
    const blocks = buildDataChannelBlocks(dataDir, pid);
    expect(blocks.parentBlock).toContain("question_bank");
    expect(blocks.parentBlock).toContain("topic_questions");
    expect(blocks.parentBlock).toContain("ns:habit_check");
    expect(blocks.parentBlock).toContain("topic→topics.topic_key");
    expect(blocks.childBlock).toContain("study_plans");
    expect(blocks.childBlock).toContain("redemption_requests");
    const self = buildChildSelfBlock(dataDir, pid);
    expect(self).toContain("points_ledger");
  });
});

describe("WP8/F10-b：assess-content 收编后行为不变", () => {
  it("listTopicKnowledgePoints / listCourseContent / listAllBankQuestions", () => {
    const db = freshParentLib();
    const kps = listTopicKnowledgePoints(db, "lunyu");
    expect(kps.length).toBe(2);
    expect(kps.map((k) => k.courseTitle)).toEqual(["学而篇", "为政篇"]);
    expect(kps[0].courseUuid).toBe("u-xueer");

    const content = listCourseContent(db, "u-xueer");
    expect(content.items.length).toBe(1);
    expect(content.items[0].knowledgePointName).toBe("背诵");
    expect(content.items[0].overview).toBe("重点");
    expect(content.items[0].questions[0].stem).toContain("学而时习之");
    expect(content.items[0].questions[0].options).toEqual([]);

    const all = listAllBankQuestions(db);
    expect(all.length).toBe(2);
    const xueer = all.find((q) => q.stem.includes("学而时习之"))!;
    expect(xueer.contexts.length).toBe(1);
    expect(xueer.contexts[0]).toMatchObject({ topic: "lunyu", course: "学而篇", knowledgePoint: "背诵" });
    db.close();
  });
});
