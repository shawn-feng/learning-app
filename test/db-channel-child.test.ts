/**
 * ISSUE-105 方案 B P2：孩子受控数据通道回归用例。
 * 覆盖：通用读（表/列白名单、等值 where、排序、行数上限）、孩子写白名单
 *（daily_entries 可增改删、redemption_requests 仅 insert + child_id 强制 + 不变量）。
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  childKbAdminWriteSpecs,
  childKbReadableRegistry,
  childKbWritableRegistry,
  describeChildTables,
  executeRead,
  executeWrite,
} from "../server/src/agent/db-channel";

const SCHEMA = `
CREATE TABLE study_plans (
  id TEXT PRIMARY KEY, parent_id TEXT NOT NULL DEFAULT '', child_id TEXT NOT NULL DEFAULT '',
  topic_key TEXT NOT NULL DEFAULT '', course_uuid TEXT NOT NULL DEFAULT '', course_name TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'new', creator TEXT NOT NULL DEFAULT 'parent', origin TEXT NOT NULL DEFAULT 'conversation',
  carry_from TEXT NOT NULL DEFAULT '', recurrence_id TEXT NOT NULL DEFAULT '', start_at TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', result TEXT NOT NULL DEFAULT '',
  done_at TEXT NOT NULL DEFAULT '', task_type TEXT NOT NULL DEFAULT 'required', count_in_rate INTEGER NOT NULL DEFAULT 1,
  points INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE exam_plans (
  id TEXT PRIMARY KEY, parent_id TEXT NOT NULL DEFAULT '', child_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '', creator TEXT NOT NULL DEFAULT 'parent', kind TEXT NOT NULL DEFAULT 'fixed',
  freq TEXT NOT NULL DEFAULT '', scope_json TEXT NOT NULL DEFAULT '{}', origin TEXT NOT NULL DEFAULT 'conversation',
  recurrence_id TEXT NOT NULL DEFAULT '', start_at TEXT NOT NULL DEFAULT '', due_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', attempt_id TEXT NOT NULL DEFAULT '', score REAL,
  result TEXT NOT NULL DEFAULT '', done_at TEXT NOT NULL DEFAULT '', task_type TEXT NOT NULL DEFAULT 'required',
  count_in_rate INTEGER NOT NULL DEFAULT 1, points INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE life_plans (
  id TEXT PRIMARY KEY, parent_id TEXT NOT NULL DEFAULT '', child_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL, creator TEXT NOT NULL DEFAULT 'parent', origin TEXT NOT NULL DEFAULT 'conversation',
  carry_from TEXT NOT NULL DEFAULT '', recurrence_id TEXT NOT NULL DEFAULT '', start_at TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', result TEXT NOT NULL DEFAULT '',
  done_at TEXT NOT NULL DEFAULT '', task_type TEXT NOT NULL DEFAULT 'required', count_in_rate INTEGER NOT NULL DEFAULT 1,
  points INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE daily_entries (
  date TEXT NOT NULL, block TEXT NOT NULL, title TEXT NOT NULL, raw TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (date, block, title)
);
CREATE TABLE topics (name TEXT PRIMARY KEY, topic_key TEXT NOT NULL, method TEXT NOT NULL DEFAULT '', assess_method TEXT NOT NULL DEFAULT '', progress TEXT NOT NULL DEFAULT '', rules_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE courses (
  topic TEXT NOT NULL, title TEXT NOT NULL, uuid TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '⬜', last_review TEXT NOT NULL DEFAULT '', review_count INTEGER NOT NULL DEFAULT 0,
  material TEXT NOT NULL DEFAULT '', send_material TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
  lesson_method TEXT NOT NULL DEFAULT '', html_path TEXT NOT NULL DEFAULT '', teaching_copy TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (topic, title)
);
CREATE TABLE tags (tag TEXT PRIMARY KEY, dimension TEXT NOT NULL DEFAULT '', criteria TEXT NOT NULL DEFAULT '');
CREATE TABLE mistake_book (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('wrong_question','unknown_word','weak_point')),
  content TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'conversation',
  source_ref TEXT NOT NULL DEFAULT '',
  question_id TEXT NOT NULL DEFAULT '',
  course_ref TEXT NOT NULL DEFAULT '',
  knowledge_point_id TEXT NOT NULL DEFAULT '',
  knowledge_point_name TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','mastered','dismissed')),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  mastered_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE display_contents (
  child_key TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  PRIMARY KEY (child_key, path)
);
CREATE TABLE reward_configs (
  child_id TEXT PRIMARY KEY, todo_tiers_json TEXT NOT NULL DEFAULT '[]', exam_tiers_json TEXT NOT NULL DEFAULT '[]',
  todo_gate_parent_min_rate REAL NOT NULL DEFAULT 1.0, exam_gate_parent_min_score REAL NOT NULL DEFAULT 0.9,
  child_no_deduct INTEGER NOT NULL DEFAULT 1, optional_points INTEGER NOT NULL DEFAULT 5, updated TEXT NOT NULL DEFAULT ''
);
CREATE TABLE points_ledger (
  id TEXT PRIMARY KEY, child_id TEXT NOT NULL, ts TEXT NOT NULL, biz_date TEXT NOT NULL, type TEXT NOT NULL,
  amount INTEGER NOT NULL, balance_after INTEGER NOT NULL DEFAULT 0, reason_code TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '', rate REAL, meta_json TEXT NOT NULL DEFAULT '', source_table TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '', operator TEXT NOT NULL DEFAULT 'system', created_at TEXT NOT NULL
);
CREATE TABLE points_balance (child_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL DEFAULT '');
CREATE TABLE redemption_items (
  id TEXT PRIMARY KEY, child_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, cost INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'inapp', payload_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
  updated TEXT NOT NULL DEFAULT ''
);
CREATE TABLE redemption_requests (
  id TEXT PRIMARY KEY, child_id TEXT NOT NULL, item_id TEXT NOT NULL DEFAULT '', custom_desc TEXT NOT NULL DEFAULT '',
  cost INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', parent_id TEXT NOT NULL DEFAULT '',
  fulfilled_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
`;

function freshKb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO study_plans (id, child_id, course_name, status, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
  ).run("sp1", "child-1", "学而篇", "pending", "2026-09-16");
  db.prepare("INSERT INTO points_balance (child_id, balance) VALUES (?, ?)").run("child-1", 120);
  db.prepare("INSERT INTO redemption_items (id, child_id, name, cost) VALUES (?, ?, ?, ?)").run(
    "item1",
    "child-1",
    "多看 20 分钟动画",
    50
  );
  db.prepare(
    "INSERT INTO mistake_book (id, kind, content, detail, source, status, first_seen, last_seen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("m1", "wrong_question", "应用题：鸡兔同笼", "卡在设未知数", "conversation", "open", "2026-09-20", "2026-09-21", "2026-09-20", "2026-09-21");
  db.prepare(
    "INSERT INTO mistake_book (id, kind, content, detail, source, status, first_seen, last_seen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("m2", "unknown_word", "鬻", "yù，卖", "lookup", "mastered", "2026-09-15", "2026-09-16", "2026-09-15", "2026-09-18");
  return db;
}

describe("child db read", () => {
  it("查询计划表（where + 排序 + 列裁剪）", () => {
    const db = freshKb();
    const r = executeRead(db, childKbReadableRegistry(), {
      table: "study_plans",
      columns: ["course_name", "status"],
      where: { status: "pending" },
      orderBy: "due_at",
      orderDesc: true,
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("course_name");
    expect(r.text).toContain("学而篇");
    expect(r.text).not.toContain("scope_json"); // 列裁剪生效
    db.close();
  });

  it("错题本可读：open 过滤 + last_seen 倒序 + 只读列（count）在读面（ISSUE-114）", () => {
    const db = freshKb();
    const specs = childKbReadableRegistry();
    const r = executeRead(db, specs, {
      table: "mistake_book",
      where: { status: "open" },
      orderBy: "last_seen",
      orderDesc: true,
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("鸡兔同笼");
    expect(r.text).not.toContain("鬻"); // mastered 已过滤
    expect(r.text).toContain("count"); // 只读列在读面可见
    db.close();
  });

  it("管理口径写错题本：status 可纠错，服务端维护列（count）拒写（ISSUE-114 + ISSUE-128）", () => {
    const db = freshKb();
    const specs = childKbAdminWriteSpecs();
    const dismiss = executeWrite(db, specs, {
      table: "mistake_book",
      op: "update",
      rows: { status: "dismissed" },
      where: { id: "m1" },
    });
    expect(dismiss.ok).toBe(true);
    const row = db.prepare("SELECT status FROM mistake_book WHERE id = 'm1'").get() as any;
    expect(row.status).toBe("dismissed");
    const bad = executeWrite(db, specs, {
      table: "mistake_book",
      op: "update",
      rows: { count: 99 },
      where: { id: "m1" },
    });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("未登记");
    db.close();
  });

  it("未登记表 / 未登记列 / 不可读 where 列均拒绝", () => {
    const db = freshKb();
    const specs = childKbReadableRegistry();
    const badTable = executeRead(db, specs, { table: "question_bank" });
    expect(badTable.ok).toBe(false);
    const badCol = executeRead(db, specs, { table: "study_plans", columns: ["password"] });
    expect(badCol.ok).toBe(false);
    expect(badCol.text).toContain("未登记");
    const badWhere = executeRead(db, specs, { table: "study_plans", where: { hack: "1" } });
    expect(badWhere.ok).toBe(false);
    db.close();
  });

  it("limit 上限 200 封顶；空结果友好提示", () => {
    const db = freshKb();
    const specs = childKbReadableRegistry();
    const empty = executeRead(db, specs, { table: "points_ledger" });
    expect(empty.ok).toBe(true);
    expect(empty.text).toContain("为空");
    const r = executeRead(db, specs, { table: "points_balance", limit: 9999 });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("200 行");
    db.close();
  });
});

describe("child db write whitelist", () => {
  it("daily_entries 增改删；日期格式不变量拦截", () => {
    const db = freshKb();
    const specs = childKbWritableRegistry();
    const ins = executeWrite(db, specs, {
      table: "daily_entries",
      op: "insert",
      rows: [{ date: "2026-09-16", block: "学习", title: "学而篇朗读", raw: "读了三遍" }],
    });
    expect(ins.ok).toBe(true);
    const badDate = executeWrite(db, specs, {
      table: "daily_entries",
      op: "insert",
      rows: [{ date: "明天", block: "学习", title: "x", raw: "y" }],
    });
    expect(badDate.ok).toBe(false);
    expect(badDate.text).toContain("YYYY-MM-DD");
    const badBlock = executeWrite(db, specs, {
      table: "daily_entries",
      op: "insert",
      rows: [{ date: "2026-09-17", block: "游戏", title: "x", raw: "y" }],
    });
    expect(badBlock.ok).toBe(false);
    expect(badBlock.text).toContain("只能是");
    const upd = executeWrite(db, specs, {
      table: "daily_entries",
      op: "update",
      rows: { raw: "读了五遍" },
      where: { date: "2026-09-16", block: "学习", title: "学而篇朗读" },
    });
    expect(upd.ok).toBe(true);
    const raw = (db.prepare("SELECT raw FROM daily_entries").get() as any).raw;
    expect(raw).toBe("读了五遍");
    db.close();
  });

  it("redemption_requests 仅 insert；child_id 强制覆盖为会话孩子", () => {
    const db = freshKb();
    const specs = childKbWritableRegistry();
    const updAttempt = executeWrite(db, specs, {
      table: "redemption_requests",
      op: "update",
      rows: { status: "approved" },
      where: { id: "x" },
    });
    expect(updAttempt.ok).toBe(false);
    expect(updAttempt.text).toContain("不允许 update");

    const ins = executeWrite(db, specs, {
      table: "redemption_requests",
      op: "insert",
      rows: [{ child_id: "别人家孩子", item_id: "item1", cost: 50 }],
      force: { child_id: "child-1" },
    });
    expect(ins.ok).toBe(true);
    const row = db.prepare("SELECT child_id, status FROM redemption_requests").get() as any;
    expect(row.child_id).toBe("child-1"); // 强制覆盖（工具层负责，注册表允许该列仅为通过校验）
    expect(row.status).toBe("pending");
    db.close();
  });

  it("兑换申请必须有 item_id 或 custom_desc；行数熔断生效", () => {
    const db = freshKb();
    const specs = childKbWritableRegistry();
    const noRef = executeWrite(db, specs, {
      table: "redemption_requests",
      op: "insert",
      rows: [{ child_id: "child-1", cost: 10 }],
    });
    expect(noRef.ok).toBe(false);
    expect(noRef.text).toContain("之一");
    const many = executeWrite(db, specs, {
      table: "redemption_requests",
      op: "insert",
      rows: Array.from({ length: 6 }, (_, i) => ({ child_id: "child-1", custom_desc: `奖励${i}`, cost: 1 })),
    });
    expect(many.ok).toBe(false);
    expect(many.text).toContain("最多插入");
    db.close();
  });

  it("考核/积分表不在写白名单", () => {
    const db = freshKb();
    const r = executeWrite(db, childKbWritableRegistry(), {
      table: "points_balance",
      op: "update",
      rows: { balance: 999999 },
      where: { child_id: "child-1" },
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("没有登记");
    db.close();
  });
});

describe("child describe", () => {
  it("清单区分只读/可写；单表详情含列含义", () => {
    const all = describeChildTables(childKbReadableRegistry(), childKbWritableRegistry());
    expect(all).toContain("可读表");
    expect(all).toContain("child_db_read");
    expect(all).toContain("child_db_write");
    const exam = describeChildTables(childKbReadableRegistry(), childKbWritableRegistry(), "exam_plans");
    expect(exam).toContain("只读");
    const req = describeChildTables(childKbReadableRegistry(), childKbWritableRegistry(), "redemption_requests");
    expect(req).toContain("insert");
  });
});
