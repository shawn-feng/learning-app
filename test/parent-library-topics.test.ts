/**
 * parent_library_topics / parent_library_courses 口径修正回归（2026-09-27，用户实测反馈）。
 *
 * 背景：家长 agent 问「论语的学习进度」时，parent_library_topics 把**名下孩子**的进度跨孩子合计
 * （珊珊 315 + 闻闻 195 = 510），而 parent_child_mastery_report 是按孩子口径（珊珊 315/512）——
 * 两个工具给出的「已学」对不上，agent 把两个数一起报了出来。另外该工具没有 topic 参数
 * （家长点名主题也得全量拉回），且每行附带主题教学方法全文（token 炸弹）。
 *
 * 本文件钉住：
 * ① 默认输出**按孩子分列**（珊珊 315/512 · 闻闻 195/512），不出现合计数 510；
 * ② 输出**不含教学方法全文**（方法走 parent_content(type=method)，进度清单是 token 炸弹现场）；
 * ③ topic 过滤（topic_key 或中文名）只出该主题；不存在的主题明确报错；
 * ④ child 过滤只出该孩子的数字；名下不存在的孩子报错并列出候选；
 * ⑤ coursesTool 带 child → 按孩子口径（✅已完成/进行中），不带 child → 名下合计（旧行为，口径已注明）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { createParentAgentTools } from "../server/src/agent/parent-tools";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pl-topics-"));
const parentId = "parent-plt";
const SHAN = "child-plt-shan";
const WEN = "child-plt-wen";
const METHOD = "【场景英语教学法】把课文对话搬进可交互的真实场景……（很长的一段方法全文）";

const mainDb = openDb(dataDir);
{
  const now = new Date().toISOString();
  mainDb.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(parentId, "plt@test", now, now);
  for (const [id, name] of [
    [SHAN, "珊珊"],
    [WEN, "闻闻"],
  ] as const) {
    mainDb.prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, parentId, name, now, now);
  }
}
{
  const lib = openParentLib(dataDir, parentId);
  lib.prepare("INSERT INTO topics (name, topic_key, method) VALUES (?, ?, ?)").run("论语", "lunyu", "论语教学方法全文占位");
  lib.prepare("INSERT INTO topics (name, topic_key, method) VALUES (?, ?, ?)").run("场景英语", "changjingyingyu", METHOD);
  lib.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 1)").run("lunyu", "论语课01");
  lib.close();
}
// 孩子库：topic_progress 是视图（由 courses 派生）——用课程行播种。
// 珊珊 10 门课 7 门 ✅（7/10）、闻闻 10 门 5 门 ✅（5/10）→ 旧合计口径会给出 12/10 这种荒谬数。
{
  const seed = (childId: string, done: number) => {
    const kb = openKb(dataDir, parentId, childId);
    try {
      kb.prepare("INSERT INTO topics (name, topic_key, learn_type) VALUES ('论语','lunyu','required')").run();
      const ins = kb.prepare(
        "INSERT INTO courses (topic, topic_key, title, sort_order, status, last_review) VALUES ('lunyu','lunyu',?,?,'✅','2026-09-24')"
      );
      const insOpen = kb.prepare(
        "INSERT INTO courses (topic, topic_key, title, sort_order, status, last_review) VALUES ('lunyu','lunyu',?,?,'⬜','')"
      );
      for (let i = 1; i <= 10; i++) {
        const title = `论语课${String(i).padStart(2, "0")}`;
        (i <= done ? ins : insOpen).run(title, i);
      }
    } finally {
      kb.close();
    }
  };
  seed(SHAN, 7);
  seed(WEN, 5);
}

afterAll(() => {
  try {
    mainDb.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟释放 */
  }
});

const tools = createParentAgentTools({
  db: mainDb,
  dataDir,
  parentId,
  workspaceDir: path.join(dataDir, "ws"),
  agentDir: path.join(dataDir, "agent"),
  auth: {},
});
const tool = (name: string) => {
  const t = tools.find((x: any) => x.name === name) as any;
  if (!t) throw new Error(`找不到工具 ${name}`);
  return t;
};
const text = async (name: string, params: Record<string, unknown>) => {
  const r = await tool(name).execute("t", params);
  return (r?.content ?? []).map((c: any) => c.text).join("");
};

describe("parent_library_topics：按孩子分列 + topic/child 过滤", () => {
  it("① 无参数：每主题按孩子分列，不出现跨孩子合计数 510", async () => {
    const out = await text("parent_library_topics", {});
    expect(out).toContain("- 论语（lunyu）：珊珊 7/10 · 闻闻 5/10");
    expect(out).toContain("- 场景英语（changjingyingyu）：珊珊 0/0 · 闻闻 0/0");
    expect(out).not.toContain("12/10"); // 旧合计口径会给出 12/10 这种荒谬数
  });

  it("② 输出不含教学方法全文（方法走 parent_content(type=method)）", async () => {
    const out = await text("parent_library_topics", {});
    expect(out).not.toContain(METHOD);
    expect(out).not.toContain("论语教学方法全文占位");
    expect(out).not.toContain("｜方法：");
  });

  it("③ topic 过滤：topic_key 与中文名都命中，只出该主题", async () => {
    const byKey = await text("parent_library_topics", { topic: "lunyu" });
    expect(byKey).toContain("- 论语（lunyu）：珊珊 7/10 · 闻闻 5/10");
    expect(byKey).not.toContain("场景英语");
    const byName = await text("parent_library_topics", { topic: "论语" });
    expect(byName).toBe(byKey);
    const missing = await text("parent_library_topics", { topic: "不存在的主题" });
    expect(missing).toContain("未找到主题");
  });

  it("④ child 过滤：只出该孩子的数字；不存在的孩子报错并列出候选", async () => {
    const out = await text("parent_library_topics", { child: "珊珊" });
    expect(out).toContain("珊珊 7/10");
    expect(out).not.toContain("闻闻 5/10");
    const bad = await text("parent_library_topics", { child: "不存在的孩子" });
    expect(bad).toContain("名下没有叫「不存在的孩子」的孩子");
    expect(bad).toContain("珊珊、闻闻");
  });

  it("⑤ coursesTool：带 child 按孩子口径（✅已完成）；不带 child 是名下合计（旧行为）", async () => {
    const perChild = await text("parent_library_courses", { topic: "lunyu", child: "珊珊" });
    expect(perChild).toContain("- 论语课01｜✅已完成｜最近 2026-09-24");
    const agg = await text("parent_library_courses", { topic: "lunyu" });
    expect(agg).toContain("✅2/2"); // 两孩子该课都 ✅ → 合计 2/2（口径已在描述注明）
  });
});
