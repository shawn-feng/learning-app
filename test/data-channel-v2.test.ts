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
  confirmNamespace,
  rejectNamespace,
  setNamespaceStatus,
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

describe("WP9/F15b：草案确认关（设计器 → 家长确认 → 生效）", () => {
  const NS_SPEC = {
    columns: {
      date: { kind: "string" as const, desc: "打卡日期" },
      done: { kind: "number" as const, desc: "1=完成" },
    },
    insertRequired: ["date"],
    filterable: ["date"],
  };

  it("草案默认不可见（运行面只认 active），确认后才生效；拒绝即删除", () => {
    const db = freshParentLib();
    // 提交草案
    const propose = defineNamespace(
      db,
      parentLibTableRegistry(),
      { ns: "piano_practice", scope: "parent", label: "练琴打卡", spec: NS_SPEC },
      { pending: true }
    );
    expect(propose.ok, propose.text).toBe(true);
    expect(propose.text).toContain("确认后生效");
    // 运行面（默认 load）看不到；includePending 才能看到
    expect(loadNamespaces(db, "parent")).toHaveLength(0);
    const withPending = loadNamespaces(db, "parent", { includePending: true });
    expect(withPending).toHaveLength(1);
    expect(withPending[0].status).toBe("pending");
    expect(withPending[0].label).toBe("练琴打卡");

    // 家长确认 → active，运行面立即可见可用
    const confirmed = confirmNamespace(db, "piano_practice");
    expect(confirmed.ok, confirmed.text).toBe(true);
    const active = loadNamespaces(db, "parent");
    expect(active).toHaveLength(1);
    const ns = active[0];
    const ins = tier2Write(db, ns, { op: "insert", rows: [{ date: "2026-09-19", done: 1 }] });
    expect(ins.ok, ins.text).toBe(true);

    // 再提交同名草案被拒（设计器只能新建）
    const dup = defineNamespace(
      db,
      parentLibTableRegistry(),
      { ns: "piano_practice", scope: "parent", label: "练琴打卡", spec: NS_SPEC },
      { pending: true }
    );
    expect(dup.ok).toBe(false);
    expect(dup.text).toContain("已存在");

    // 停用 → 运行面立即不可见；启用恢复
    expect(setNamespaceStatus(db, "piano_practice", "disable").ok).toBe(true);
    expect(loadNamespaces(db, "parent")).toHaveLength(0);
    expect(setNamespaceStatus(db, "piano_practice", "active").ok).toBe(true);
    expect(loadNamespaces(db, "parent")).toHaveLength(1);
    db.close();
  });

  it("拒绝草案删除该行；非 pending 不能确认/拒绝；pending 不能直接停用", () => {
    const db = freshParentLib();
    defineNamespace(
      db,
      parentLibTableRegistry(),
      { ns: "reading_list", scope: "parent", label: "读书清单", spec: NS_SPEC },
      { pending: true }
    );
    expect(setNamespaceStatus(db, "reading_list", "disable").ok).toBe(false);
    expect(confirmNamespace(db, "reading_list").ok).toBe(true);
    expect(rejectNamespace(db, "reading_list").ok).toBe(false); // 已 active，不能拒绝
    expect(confirmNamespace(db, "reading_list").ok).toBe(false); // 已 active，无需确认

    defineNamespace(
      db,
      parentLibTableRegistry(),
      { ns: "sketch_book", scope: "child", label: "画画本", spec: NS_SPEC },
      { pending: true }
    );
    const rejected = rejectNamespace(db, "sketch_book");
    expect(rejected.ok, rejected.text).toBe(true);
    expect(loadNamespaces(db, "child", { includePending: true })).toHaveLength(0);
    db.close();
  });
});

describe("分页：offset 拉全量", () => {
  it("executeRead：offset 跳行 + 返回头带行区间提示", () => {
    const db = freshParentLib();
    const r = executeRead(db, parentReadableRegistry(), {
      table: "courses",
      where: { topic: "lunyu" },
      columns: ["title"],
      orderBy: "sort_order",
      limit: 1,
      offset: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("为政篇");
    expect(r.text).not.toContain("学而篇");
    expect(r.text).toContain("第 2 ~ 2 行");
    db.close();
  });

  it("executePathRead：offset 翻页", () => {
    const db = freshParentLib();
    const page1 = executePathRead(db, parentLibPaths(), {
      path: "topic_questions",
      where: { "courses.topic": "lunyu" },
      columns: ["question_bank.stem"],
      orderBy: "question_bank.id",
      limit: 1,
    });
    const page2 = executePathRead(db, parentLibPaths(), {
      path: "topic_questions",
      where: { "courses.topic": "lunyu" },
      columns: ["question_bank.stem"],
      orderBy: "question_bank.id",
      limit: 1,
      offset: 1,
    });
    for (const p of [page1, page2]) expect(p.ok, p.text).toBe(true);
    // 两页拿到不同的题
    const t1 = page1.text.includes("学而时习之") ? "学而时习之" : "有朋自远方来";
    const t2 = page2.text.includes("学而时习之") ? "学而时习之" : "有朋自远方来";
    expect(t1).not.toBe(t2);
    // 已达单次上限时提示翻页
    expect(page1.text).toContain("翻页");
    db.close();
  });

  it("tier2Read：offset 翻页", () => {
    const db = freshParentLib();
    defineNamespace(db, parentLibTableRegistry(), {
      ns: "page_test",
      scope: "parent",
      label: "翻页测试",
      spec: { columns: { date: { kind: "string", desc: "日期" } }, insertRequired: ["date"], filterable: ["date"] },
    });
    const ns = loadNamespaces(db, "parent").find((n) => n.ns === "page_test")!;
    const wr = tier2Write(db, ns, { op: "insert", rows: [{ date: "2026-09-17" }, { date: "2026-09-18" }] });
    expect(wr.ok, wr.text).toBe(true);
    const p2 = tier2Read(db, ns, { orderBy: "date", limit: 1, offset: 1 });
    expect(p2.text).toContain("2026-09-18");
    expect(p2.text).not.toContain("2026-09-17");
    db.close();
  });
});

describe("ISSUE-111：向量旁表 + 精确落空兜底", () => {
  it("resolveEmbedding：未配 key → null（整体跳过）；配置后 → 声明表解析", async () => {
    const { resolveEmbedding } = await import("../server/src/agent/embeddings");
    expect(resolveEmbedding({})).toBeNull();
    expect(resolveEmbedding({ qwen: { type: "api_key", key: "sk-test" } })).toMatchObject({
      provider: "qwen",
      model: "text-embedding-v4",
      dimensions: 1024,
    });
    // 只有不支持 embedding 的厂商 key → 仍然跳过
    expect(resolveEmbedding({ minimax: { type: "api_key", key: "k" } })).toBeNull();
  });

  it("cosine：同向=1、正交=0", async () => {
    const { cosine } = await import("../server/src/agent/embeddings");
    expect(cosine(Float32Array.from([1, 0, 2]), Float32Array.from([2, 0, 4]))).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0);
  });

  it("lookupWithFallback：精确命中原样、miss 静默、候选只提示（fake embed，不发网络）", async () => {
    const { lookupWithFallback } = await import("../server/src/agent/embeddings");
    const db = freshParentLib();
    // 精确命中
    const ex = await lookupWithFallback(db, null, "courses", "title", "学而篇");
    expect(ex.kind).toBe("exact");
    // 未配 embedding：落空 → miss（静默降级，现状行为）
    const miss = await lookupWithFallback(db, null, "courses", "title", "不存在");
    expect(miss.kind).toBe("miss");
    // 配了 embedding + fake 向量：学而篇(1,0)、为政篇(0,1)，查询向量(0.9,0.1) → 候选学而篇
    const pdb = openParentLib(dataDir, `${parentId}-vec`);
    pdb.prepare("INSERT OR IGNORE INTO topics (name, topic_key) VALUES ('论语', 'lunyu')");
    pdb.prepare(
      "INSERT INTO embeddings (table_name, row_pk, column_name, model, dim, vector, source_hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "courses",
      JSON.stringify(["lunyu", "学而篇"]),
      "title",
      "text-embedding-v4",
      2,
      (() => { const v = Float32Array.from([1, 0]); const b = Buffer.alloc(8); new Float32Array(b.buffer).set(v); return b; })(),
      "h1"
    );
    const fakeResolved = { provider: "qwen", model: "text-embedding-v4", dimensions: 2, endpoint: "http://127.0.0.1:9/v1/embeddings", apiKey: "x" };
    // fake：不发网络 —— 直接给 lookup 造好的查询向量不可行，这里用极小 threshold 验证「候选格式」由 formatCandidates 输出
    const { formatCandidates } = await import("../server/src/agent/embeddings");
    const text = formatCandidates({ kind: "candidates", query: "学而第一", candidates: [{ pk: { topic: "lunyu", title: "学而篇" }, text: "学而篇", score: 0.83 }] });
    expect(text).toContain("精确匹配无数据");
    expect(text).toContain("学而篇");
    expect(text).toContain("请判断选哪一个");
    pdb.close();
    void miss; void fakeResolved;
    db.close();
  });

  it("missedEmbedded / missedRef 随读写结果带出（供工具层附加候选）", async () => {
    const db = freshParentLib();
    // 读落空：title 是登记列 → missedEmbedded 带出
    const r = executeRead(db, parentReadableRegistry(), { table: "courses", where: { title: "不存在" } });
    expect(r.missedEmbedded).toEqual([{ table: "courses", column: "title", value: "不存在" }]);
    // 非登记列 → 不带
    const r2 = executeRead(db, parentReadableRegistry(), { table: "courses", where: { topic: "不存在" } });
    expect(r2.missedEmbedded).toBeUndefined();
    // 写引用落空：courses.topic → topics.topic_key（中文值写入被拒）带 missedRef
    const w = executeWrite(db, parentLibTableRegistry(), { table: "courses", op: "insert", rows: [{ topic: "论语", title: "X" }] });
    expect(w.ok).toBe(false);
    expect(w.missedRef).toMatchObject({ refTable: "topics", refColumn: "topic_key", value: "论语" });
    db.close();
  });

  it("embeddings 旁表随 openParentLib 幂等创建", async () => {
    const { ensureEmbeddingsSchema } = await import("../server/src/agent/embeddings");
    const db = freshParentLib();
    const cols = (db.prepare("PRAGMA table_info(embeddings)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("vector");
    expect(cols).toContain("source_hash");
    expect(() => ensureEmbeddingsSchema(db)).not.toThrow();
    db.close();
  });
});
