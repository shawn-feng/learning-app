import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 纯 node 环境没有 electron；custom-tools → learning-summary → config 顶部 import electron app。
// 打桩成 undefined，与 learning-summary.test.ts 一致。
vi.mock("electron", () => ({ app: undefined }));

import { kbInsertTool, kbQueryTool, kbUpdateTool } from "../electron/lib/custom-tools";
import { openKbDb } from "../electron/lib/kb-sqlite";

const REAL_CHILD = path.resolve(__dirname, "../data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674");

/** 直接调用工具 execute（defineTool 返回 { execute }），ctx 只需 cwd。 */
async function runTool(tool: { execute: Function }, params: any, cwd: string) {
  return tool.execute("test-call", params, undefined, undefined, { cwd });
}

describe("kb_query（SQLite 结构化查询）", () => {
  it("query=daily：date+block 精确查询（真实主账号 2026-08-11 生活区块）", async () => {
    const res = await runTool(kbQueryTool, { query: "daily", date: "2026-08-11", block: "生活", listOnly: true }, REAL_CHILD);
    const text = res.content[0].text as string;
    expect(text).toContain("做番茄钟网页");
  });

  it("query=daily：month 聚合 + listOnly 只回标题", async () => {
    const res = await runTool(kbQueryTool, { query: "daily", month: "2026-08", block: "生活", listOnly: true }, REAL_CHILD);
    const text = res.content[0].text as string;
    expect(text.split("\n").length).toBeLessThanOrEqual(30); // 只回标题清单，不含全文
  });

  it("query=daily：block+title 定位单条", async () => {
    const res = await runTool(
      kbQueryTool,
      { query: "daily", date: "2026-08-11", block: "生活", title: "做番茄钟网页" },
      REAL_CHILD
    );
    const text = res.content[0].text as string;
    expect(text).toContain("番茄钟网页");
    expect(text).toContain("概要");
  });

  it("query=topics：返回主题清单与进度摘要", async () => {
    const res = await runTool(kbQueryTool, { query: "topics" }, REAL_CHILD);
    const text = res.content[0].text as string;
    expect(text).toContain("主题清单");
    expect(text).toContain("论语");
  });

  it("query=progress：topic + listOnly 返回课程清单", async () => {
    const res = await runTool(kbQueryTool, { query: "progress", topic: "lunyu", listOnly: true }, REAL_CHILD);
    const text = res.content[0].text as string;
    expect(text).toContain("lunyu");
    expect(text).toContain("论语学而篇第一章");
  });

  it("query=tags：tag 精确查询标签定义（词表 + 判断标准）", async () => {
    const res = await runTool(kbQueryTool, { query: "tags", tag: "亲情" }, REAL_CHILD);
    const text = res.content[0].text as string;
    expect(text).toContain("标签「亲情」定义");
    expect(text).toContain("亲情");
  });

  it("query=daily：tag 过滤查生活事件（真实库 08-11 动手标签）", async () => {
    const res = await runTool(kbQueryTool, { query: "daily", block: "生活", tag: "动手", listOnly: true }, REAL_CHILD);
    const text = res.content[0].text as string;
    expect(text).toContain("番茄钟");
  });

  it("query 非法值被拒", async () => {
    await expect(runTool(kbQueryTool, { query: "bad" }, REAL_CHILD)).rejects.toThrow(/支持 query/);
  });
});

describe("kb_insert / kb_update（临时目录写测试）", () => {
  let tmpDir: string;

  beforeAll(() => {
    // 用系统临时目录隔离写测试；先建库（kb_insert 依赖 kb.sqlite 存在）
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-tools-sqlite-test-"));
    const db = openKbDb(tmpDir);
    db.close();
  });

  it("kb_insert daily：写入新条目，内容不进返回", async () => {
    const res = await runTool(
      kbInsertTool,
      { table: "daily", date: "2026-08-20", block: "生活", content: "### 做番茄钟网页\n- 标签：#动手\n- 概要：原始概要" },
      tmpDir
    );
    expect(res.content[0].text).toContain("已写入 daily 2026-08-20");
    expect(res.content[0].text).not.toContain("原始概要"); // 内容不进上下文
    // 验证落库
    const q = await runTool(kbQueryTool, { query: "daily", date: "2026-08-20", block: "生活" }, tmpDir);
    expect(q.content[0].text).toContain("做番茄钟网页");
  });

  it("kb_insert daily：同主键重复插入返回不覆盖（append-only）", async () => {
    const res = await runTool(
      kbInsertTool,
      { table: "daily", date: "2026-08-20", block: "生活", content: "### 做番茄钟网页\n- 概要：应该不覆盖" },
      tmpDir
    );
    expect(res.content[0].text).toContain("已存在同名条目，未重复写入");
    const q = await runTool(kbQueryTool, { query: "daily", date: "2026-08-20", block: "生活", title: "做番茄钟网页" }, tmpDir);
    expect(q.content[0].text).toContain("原始概要"); // 仍是第一次的内容
    expect(q.content[0].text).not.toContain("应该不覆盖");
  });

  it("kb_insert daily：生活事件标签行自动解析 → kb_query daily tag 过滤可反查", async () => {
    const res = await runTool(
      kbInsertTool,
      { table: "daily", date: "2026-08-20", block: "生活", content: "### 2026-08-20 撒谎事件\n- 概要：说了谎\n- 标签：诚实" },
      tmpDir
    );
    expect(res.content[0].text).toContain("已写入 daily 2026-08-20");
    const q = await runTool(kbQueryTool, { query: "daily", block: "生活", tag: "诚实", listOnly: true }, tmpDir);
    expect(q.content[0].text).toContain("2026-08-20 撒谎事件");
  });

  it("kb_insert daily：entries 批量一次写入多条（同 date 多 block），返回新增/跳过计数", async () => {
    const res = await runTool(
      kbInsertTool,
      {
        table: "daily",
        date: "2026-08-21",
        entries: [
          { block: "学习", content: "### 论语先进篇第二十二章\n- 考核：吟诵✓\n- 孩子表现：主动背诵" },
          { block: "生活", content: "### 去公园玩\n- 标签：运动\n- 概要：在公园跑了三圈" },
          { block: "问答", content: "### 为什么天是蓝的\n- 孩子的疑问：天为什么是蓝的？\n- 结论：散射" },
        ],
      },
      tmpDir
    );
    expect(res.content[0].text).toContain("已批量写入 daily 2026-08-21");
    expect(res.content[0].text).toContain("新增 3 条");
    // 三条全部落库（跨区块）
    const q1 = await runTool(kbQueryTool, { query: "daily", date: "2026-08-21", block: "学习" }, tmpDir);
    expect(q1.content[0].text).toContain("论语先进篇第二十二章");
    const q2 = await runTool(kbQueryTool, { query: "daily", date: "2026-08-21", block: "生活" }, tmpDir);
    expect(q2.content[0].text).toContain("去公园玩");
    const q3 = await runTool(kbQueryTool, { query: "daily", date: "2026-08-21", block: "问答" }, tmpDir);
    expect(q3.content[0].text).toContain("为什么天是蓝的");
  });

  it("kb_insert daily：entries 批量重复条目自动跳过（append-only，不覆盖）", async () => {
    const res = await runTool(
      kbInsertTool,
      {
        table: "daily",
        date: "2026-08-21",
        entries: [
          { block: "学习", content: "### 论语先进篇第二十二章\n- 考核：吟诵✓\n- 孩子表现：主动背诵" }, // 已存在
          { block: "任务", content: "### 做个计分器\n- 需求：给练习打分的网页" }, // 新条目
        ],
      },
      tmpDir
    );
    expect(res.content[0].text).toContain("新增 1 条");
    expect(res.content[0].text).toContain("跳过重复/无效 1 条");
    // 已存在条目内容未被覆盖（还是第一次的 content）
    const q = await runTool(kbQueryTool, { query: "daily", date: "2026-08-21", block: "学习", title: "论语先进篇第二十二章" }, tmpDir);
    expect(q.content[0].text).toContain("主动背诵");
  });

  it("kb_insert daily：entries 批量缺 date 报错", async () => {
    await expect(
      runTool(kbInsertTool, { table: "daily", entries: [{ block: "生活", content: "### 事件\n- 概要：x" }] }, tmpDir)
    ).rejects.toThrow(/date \+ entries/);
  });

  it("kb_insert daily：entries 批量中无 ### 标题的条目计入跳过（不入库）", async () => {
    const res = await runTool(
      kbInsertTool,
      {
        table: "daily",
        date: "2026-08-21",
        entries: [
          { block: "学习", content: "没有标题行" },
          { block: "生活", content: "### 有效条目\n- 概要：ok" },
        ],
      },
      tmpDir
    );
    expect(res.content[0].text).toContain("新增 1 条");
    expect(res.content[0].text).toContain("跳过重复/无效 1 条");
  });

  it("kb_update daily：更新条目字段", async () => {
    await runTool(
      kbInsertTool,
      { table: "daily", date: "2026-08-20", block: "任务", content: "### 做个番茄钟\n- 需求：一个番茄钟\n- 状态：pending" },
      tmpDir
    );
    const res = await runTool(
      kbUpdateTool,
      { table: "daily", date: "2026-08-20", block: "任务", title: "做个番茄钟", field: "状态", value: "done" },
      tmpDir
    );
    expect(res.content[0].text).toContain("已更新 daily");
    const q = await runTool(kbQueryTool, { query: "daily", date: "2026-08-20", block: "任务", title: "做个番茄钟" }, tmpDir);
    expect(q.content[0].text).toContain("状态：done");
  });

  it("kb_update course：更新课程字段，learned/total 视图自动计算", async () => {
    // 先预置课程（courses 表，v3）
    const db = openKbDb(tmpDir);
    db.prepare("INSERT OR REPLACE INTO courses (topic, title, sort_order, status) VALUES (?, ?, ?, ?)").run("lunyu", "论语先进篇第十六章", 0, "✅");
    db.prepare("INSERT OR REPLACE INTO courses (topic, title, sort_order, status) VALUES (?, ?, ?, ?)").run("lunyu", "论语先进篇第十七章", 1, "⬜");
    db.close();

    // 更新课程字段
    const r1 = await runTool(
      kbUpdateTool,
      { table:"course", topic: "lunyu", item: "论语先进篇第十七章", field: "状态", value: "✅" },
      tmpDir
    );
    expect(r1.content[0].text).toContain("已更新 lunyu");
    // 复习次数 +1 自增
    await runTool(kbUpdateTool, { table:"course", topic: "lunyu", item: "论语先进篇第十七章", field: "复习次数", value: "+1" }, tmpDir);
    // 视图计算：两门课都 ✅ → 已学 2/2；不再手工维护 learned
    const q = await runTool(kbQueryTool, { query: "progress", topic: "lunyu" }, tmpDir);
    const text = q.content[0].text as string;
    expect(text).toContain("已学 2/2");
    expect(text).toContain("复习次数：1");
  });

  it("kb_update course：手动更新 learned/next 被拒绝（视图自动计算）", async () => {
    await expect(
      runTool(kbUpdateTool, { table:"course", topic: "lunyu", item: "论语先进篇第十六章", field: "learned", value: "999" }, tmpDir)
    ).rejects.toThrow(/learned\/next\/updated/);
  });

  it("kb_update 目标不存在报错", async () => {
    await expect(
      runTool(kbUpdateTool, { table: "daily", date: "2026-08-20", block: "生活", title: "不存在的事件", field: "概要", value: "x" }, tmpDir)
    ).rejects.toThrow(/不存在/);
  });

  it("kb_update 非法 table 被拒", async () => {
    await expect(runTool(kbUpdateTool, { table: "bad", field: "x", value: "y" }, tmpDir)).rejects.toThrow(/支持 table/);
  });

  it("kb_insert 非法 table 被拒", async () => {
    await expect(runTool(kbInsertTool, { table: "bad" }, tmpDir)).rejects.toThrow(/支持 table/);
  });
});
