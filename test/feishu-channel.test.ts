/**
 * 飞书渠道纯逻辑回归：content 文本提取 / 绑定查找（channel 隔离）/ 待确认请求 upsert 语义。
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { __test, feishuBindingLookup } from "../server/src/channels/feishu";

const { extractText } = __test;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE wechat_bindings (
      id TEXT PRIMARY KEY, wechat_id TEXT NOT NULL UNIQUE, channel TEXT NOT NULL DEFAULT 'wechat',
      role TEXT NOT NULL, parent_id TEXT NOT NULL, child_id TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE wechat_bind_requests (
      id TEXT PRIMARY KEY, wechat_id TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'wechat',
      sample_text TEXT NOT NULL DEFAULT '', first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', decided_at TEXT
    );
    CREATE UNIQUE INDEX ux_req ON wechat_bind_requests(channel, wechat_id);
  `);
  db.prepare(
    "INSERT INTO wechat_bindings (id, wechat_id, channel, role, parent_id, child_id, label, created_at, updated_at) VALUES ('b1','ou_feishu_1','feishu','parent','p1','','妈妈',datetime('now'),datetime('now'))"
  ).run();
  return db;
}

describe("feishu extractText", () => {
  it("解析 content JSON 并去掉 @占位", () => {
    expect(extractText('{"text":"@_user_1 今天计划如何"}')).toBe("今天计划如何");
    expect(extractText("{}")).toBe("");
    expect(extractText("not-json")).toBe("");
  });
});

describe("feishu binding lookup", () => {
  it("按 channel=feishu 精确匹配：只命中 feishu 行，微信行/未知 id 不误命中", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO wechat_bindings (id, wechat_id, channel, role, parent_id, child_id, label, created_at, updated_at) VALUES ('b2','wxid_other','wechat','child','p1','c1','微信号',datetime('now'),datetime('now'))"
    ).run();
    const hit = feishuBindingLookup(db, "ou_feishu_1");
    expect(hit?.role).toBe("parent"); // 命中 feishu 行
    expect(feishuBindingLookup(db, "wxid_other")).toBeUndefined(); // feishu 查询不会命中 wechat 行
    db.close();
  });
});

describe("bind request upsert（feishu 渠道）", () => {
  it("同 id 重复消息只保留一条 pending；拒绝后不复活", () => {
    const db = freshDb();
    const upsert = (sample: string) =>
      db
        .prepare(
          `INSERT INTO wechat_bind_requests (id, wechat_id, channel, sample_text, first_seen, last_seen, status)
           VALUES (?,?, 'feishu', ?,?,?,'pending')
           ON CONFLICT(channel, wechat_id) DO UPDATE SET
             sample_text=excluded.sample_text, last_seen=excluded.last_seen,
             status=CASE WHEN wechat_bind_requests.status='pending' THEN 'pending' ELSE wechat_bind_requests.status END`
        )
        .run(`id-${Math.random()}`, "ou_x", sample, "2026-09-17 10:00:00", "2026-09-17 10:00:00");
    upsert("第一句");
    upsert("第二句");
    const rows = db.prepare("SELECT wechat_id, sample_text, status FROM wechat_bind_requests").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].sample_text).toBe("第二句");
    expect(rows[0].status).toBe("pending");
    db.prepare("UPDATE wechat_bind_requests SET status='rejected'").run();
    upsert("第三句");
    const after = db.prepare("SELECT sample_text, status FROM wechat_bind_requests").get() as any;
    expect(after.status).toBe("rejected"); // 不复活
    expect(after.sample_text).toBe("第三句"); // 但活跃样本仍刷新
    db.close();
  });
});
