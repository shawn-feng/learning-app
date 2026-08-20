import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 纯 node 环境没有 electron；custom-tools → learning-summary → config 顶部 import electron app。
// 打桩成 undefined，与 learning-summary.test.ts 一致。
vi.mock("electron", () => ({ app: undefined }));

import { kbAppendTool, kbPatchTool, kbReadTool } from "../electron/lib/custom-tools";

const REAL_CHILD = path.resolve(__dirname, "../data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674");

/** 直接调用工具 execute（defineTool 返回 { execute }），ctx 只需 cwd。 */
async function runTool(tool: { execute: Function }, params: any, cwd: string) {
  return tool.execute("test-call", params, undefined, undefined, { cwd });
}

describe("kb_read（结构化读取）", () => {
  it("ref 简写定位 daily 生活区块，listOnly 返回标题清单", async () => {
    // 用真实主账号数据：2026-08-11 生活区块含「做番茄钟网页」
    const res = await runTool(kbReadTool, { ref: "daily/2026-08-11.md#生活", listOnly: true }, REAL_CHILD);
    const text = res.content[0].text as string;
    expect(text).toContain("做番茄钟网页");
    expect(text.split("\n").length).toBeLessThanOrEqual(5); // 只回标题清单，不含全文
  });

  it("block+item 定位单条生活事件", async () => {
    const res = await runTool(
      kbReadTool,
      { file: "daily/2026-08-11.md", block: "生活", item: "做番茄钟网页" },
      REAL_CHILD
    );
    const text = res.content[0].text as string;
    expect(text).toContain("番茄钟网页");
    expect(text).toContain("标签");
    // 只回该条目，不含「学习」区块
    expect(text).not.toContain("## 学习");
  });

  it("路径守卫：越界路径被拒", async () => {
    await expect(runTool(kbReadTool, { file: "../../../Windows/win.ini" }, REAL_CHILD)).rejects.toThrow(
      /超出学习目录范围/
    );
  });

  it("不存在的区块/条目报错并给出可选清单", async () => {
    await expect(runTool(kbReadTool, { file: "daily/2026-08-11.md", block: "不存在的区块" }, REAL_CHILD)).rejects.toThrow(
      /区块不存在/
    );
  });
});

describe("kb_patch / kb_append（临时目录写测试）", () => {
  let tmpDir: string;
  let dailyFile: string;
  let progressFile: string;

  beforeAll(() => {
    // 用系统临时目录隔离写测试（避免污染真实孩子数据；临时目录由系统回收）
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-tools-test-"));
    dailyFile = path.join(tmpDir, "daily", "2026-08-20.md");
    fs.mkdirSync(path.dirname(dailyFile), { recursive: true });
    fs.writeFileSync(
      dailyFile,
      "## 生活\n\n### 做番茄钟网页\n- 标签：#动手\n- 概要：原始概要\n\n## 任务\n\n### 做个番茄钟\n- 需求：一个番茄钟\n- 状态：pending\n",
      "utf-8"
    );
    // 进度文件（无 ## 区块，条目直接挂文件级——与真实 lunyu.md 一致）
    progressFile = path.join(tmpDir, "learning", "lunyu", "lunyu.md");
    fs.mkdirSync(path.dirname(progressFile), { recursive: true });
    fs.writeFileSync(
      progressFile,
      "---\nlearned: 282\ntotal: 514\nnext: \"论语先进篇第十七章\"\nupdated: 2026-08-19\n---\n\n### 论语先进篇第十六章\n状态:: ✅\n掌握度:: 良好\n复习次数:: 0\n最近复习:: 2026-08-13\n\n### 论语先进篇第十七章\n状态:: ⬜\n复习次数:: 0\n",
      "utf-8"
    );
  });

  it("kb_patch 定位更新 daily 条目字段，文件内容不进返回", async () => {
    const res = await runTool(
      kbPatchTool,
      { file: "daily/2026-08-20.md", block: "生活", item: "做番茄钟网页", field: "概要", value: "更新后的概要" },
      tmpDir
    );
    expect(res.content[0].text).toContain("概要=更新后的概要");
    // 返回里不应出现文件内容（只回确认信息）
    expect(res.content[0].text).not.toContain("原始概要");
    const text = fs.readFileSync(dailyFile, "utf-8");
    expect(text).toContain("- 概要：更新后的概要");
  });

  it("kb_patch 批量更新同条目多字段", async () => {
    await runTool(
      kbPatchTool,
      {
        file: "daily/2026-08-20.md",
        block: "任务",
        item: "做个番茄钟",
        fields: [
          { field: "状态", value: "done" },
          { field: "需求", value: "一个可爱的番茄钟" },
        ],
      },
      tmpDir
    );
    const text = fs.readFileSync(dailyFile, "utf-8");
    expect(text).toContain("- 状态：done");
    expect(text).toContain("- 需求：一个可爱的番茄钟");
  });

  it("kb_patch 非法字段名被拒绝（白名单校验）", async () => {
    await expect(
      runTool(kbPatchTool, { file: "daily/2026-08-20.md", block: "生活", item: "做番茄钟网页", field: "不存在的字段", value: "x" }, tmpDir)
    ).rejects.toThrow(/非法字段/);
  });

  it("kb_patch 内容文件（method.md）被拒绝", async () => {
    await expect(
      runTool(kbPatchTool, { file: "learning/lunyu/method.md", item: "x", field: "y", value: "z" }, tmpDir)
    ).rejects.toThrow(/内容文件/);
  });

  it("kb_append 向 daily 生活区块追加新条目", async () => {
    const res = await runTool(
      kbAppendTool,
      { file: "daily/2026-08-20.md", block: "生活", content: "### 新事件\n- 标签：#亲情\n- 概要：新事件概要" },
      tmpDir
    );
    expect(res.content[0].text).toContain("已追加");
    const text = fs.readFileSync(dailyFile, "utf-8");
    expect(text.indexOf("### 新事件")).toBeGreaterThan(text.indexOf("## 生活"));
    expect(text.indexOf("### 新事件")).toBeLessThan(text.indexOf("## 任务")); // 在生活区块内，任务之前
  });

  it("kb_append 不校验字段名：可直接追加 method 已输出的学习总结原文", async () => {
    // content = method 流程已输出给孩子的总结原文（含任意字段行），工具只追加不校验
    const res = await runTool(
      kbAppendTool,
      {
        file: "daily/2026-08-20.md",
        block: "生活",
        content: "### 总结原文事件\n- 标签：#亲情\n- 概要：任意字段原文",
      },
      tmpDir
    );
    expect(res.content[0].text).toContain("已追加");
    const text = fs.readFileSync(dailyFile, "utf-8");
    expect(text).toContain("### 总结原文事件");
    expect(text).toContain("- 概要：任意字段原文");
  });

  it("kb_append 文件存在但目标区块不存在时自动创建新区块（当天先写生活再写学习）", async () => {
    // dailyFile 现有 ## 生活 / ## 任务，无 ## 学习 → 追加学习区块应自动创建
    const res = await runTool(
      kbAppendTool,
      {
        file: "daily/2026-08-20.md",
        block: "学习",
        content: "### 论语先进篇第十八章\n- 考核：吟诵✓\n- 孩子表现：示例",
      },
      tmpDir
    );
    expect(res.content[0].text).toContain("已追加");
    const text = fs.readFileSync(dailyFile, "utf-8");
    expect(text).toContain("## 学习");
    expect(text).toContain("### 论语先进篇第十八章");
    // 原区块仍在
    expect(text).toContain("## 生活");
    expect(text).toContain("### 做番茄钟网页");
  });

  it("kb_append 非追加白名单文件（进度文件）被拒绝", async () => {
    await expect(
      runTool(kbAppendTool, { file: "learning/lunyu/lunyu.md", block: "x", content: "### y" }, tmpDir)
    ).rejects.toThrow(/不允许追加/);
  });

  // —— 2026-08-20 会话实测修复（用户反馈）——
  it("kb_patch 进度文件（无 ## 区块）可更新条目字段", async () => {
    const res = await runTool(
      kbPatchTool,
      {
        file: "learning/lunyu/lunyu.md",
        item: "论语先进篇第十七章",
        fields: [
          { field: "状态", value: "✅" },
          { field: "掌握度", value: "熟练" },
          { field: "首次学习", value: "2026-08-20" }, // 白名单已扩展
          { field: "最近复习", value: "2026-08-20" },
        ],
      },
      tmpDir
    );
    expect(res.content[0].text).toContain("状态=✅");
    const text = fs.readFileSync(progressFile, "utf-8");
    expect(text).toContain("状态:: ✅");
    expect(text).toContain("首次学习:: 2026-08-20");
    // 其它条目不受影响
    expect(text).toContain("### 论语先进篇第十六章");
    expect(text).toContain("掌握度:: 良好");
  });

  it("kb_patch 进度文件 frontmatter 更新（learned/next/updated）", async () => {
    await runTool(
      kbPatchTool,
      {
        file: "learning/lunyu/lunyu.md",
        item: "frontmatter",
        fields: [
          { field: "frontmatter:learned", value: "283" },
          { field: "frontmatter:next", value: "论语先进篇第十八章" },
          { field: "frontmatter:updated", value: "2026-08-20" },
        ],
      },
      tmpDir
    );
    const text = fs.readFileSync(progressFile, "utf-8");
    expect(text).toContain("learned: 283");
    expect(text).toContain("next: 论语先进篇第十八章"); // YAML 无引号字符串，合法且 learning-summary 可解析
    expect(text).toContain("updated: 2026-08-20");
  });

  it("kb_append 文件不存在时自动创建（daily 当日文件）", async () => {
    const res = await runTool(
      kbAppendTool,
      {
        file: "daily/2026-08-21.md",
        block: "学习",
        content: "### 论语先进篇第十八章\n- **课程名：** 论语先进篇第十八章\n- **掌握度：** 熟练\n- **孩子表现：** 测试条目",
      },
      tmpDir
    );
    expect(res.content[0].text).toContain("已创建");
    const text = fs.readFileSync(path.join(tmpDir, "daily", "2026-08-21.md"), "utf-8");
    expect(text).toContain("# 2026-08-21");
    expect(text).toContain("## 学习");
    expect(text).toContain("### 论语先进篇第十八章");
  });
});
