import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 纯 node 环境没有 electron：打桩 app，使 config 走临时目录（同 parent-library.test）。
vi.mock("electron", () => ({ app: undefined }));

const mockTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parent-stats-"));
vi.mock("../electron/lib/config", () => ({
  getDataDir: () => mockTmpRoot,
  getChildrenDir: () => path.join(mockTmpRoot, "children"),
  getChildDir: (id: string) => path.join(mockTmpRoot, "children", id),
  getSharedDir: () => path.join(mockTmpRoot, "shared"),
  getSkillsDir: () => path.join(mockTmpRoot, "shared", "skills"),
}));

import { parentStatsTool, logActivityTool, moveFileTool, copyFileTool, displayContentTool } from "../electron/lib/custom-tools";
import { upsertParentTopic, allocateTopicToChild, getActivityLogPath, appendActivityLog } from "../electron/lib/parent-library";
import { insertCourse, insertDailyEntry, openKbDb } from "../electron/lib/kb-sqlite";
import { appendTokenLog } from "../electron/lib/token-stats";

const CHILD = "stats-child-001";

async function run(params: any): Promise<string> {
  const r = await parentStatsTool.execute("call-1", params, {} as any, undefined, { cwd: mockTmpRoot } as any);
  const text = r.content?.find((c: any) => c.type === "text")?.text || "";
  return text;
}

beforeEach(() => {
  fs.rmSync(mockTmpRoot, { recursive: true, force: true });
  fs.mkdirSync(mockTmpRoot, { recursive: true });
  fs.mkdirSync(path.join(mockTmpRoot, "children"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(mockTmpRoot, { recursive: true, force: true });
});

describe("parent_stats 只读统计工具（统一家长提示词配套）", () => {
  it("tokens：无日志时返回 0 汇总", async () => {
    const text = await run({ type: "tokens" });
    expect(text).toContain("token 消耗统计");
    expect(text).toContain("总 token：0");
  });

  it("tokens：有日志时按 childId 过滤汇总", async () => {
    fs.mkdirSync(path.join(mockTmpRoot, "children", CHILD), { recursive: true });
    appendTokenLog(
      {
        seq: 0,
        ts: new Date().toISOString(),
        channel: "child",
        childId: CHILD,
        model: "deepseek-v4-flash",
        ok: true,
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.001,
        totalTokens: 150,
        replyLength: 20,
      },
      CHILD
    );
    const text = await run({ type: "tokens", childId: CHILD });
    expect(text).toContain("总 token：150");
    expect(text).toContain("deepseek-v4-flash");
    // 不带 childId 的汇总（家长全局）不含孩子隔离日志
    const globalText = await run({ type: "tokens" });
    expect(globalText).toContain("总 token：0");
  });

  it("progress：无 kb.sqlite 返回提示，不抛错", async () => {
    const text = await run({ type: "progress", childId: CHILD });
    expect(text).toContain("暂无学习数据");
  });

  it("progress：有分配主题时输出进度 markdown（只读不改数据）", async () => {
    upsertParentTopic(
      "default",
      { name: "论语", topicKey: "lunyu", method: "# 方法" },
      [{ title: "论语学而篇第一章", lessonMethod: "朗读" }]
    );
    const childDir = path.join(mockTmpRoot, "children", CHILD);
    fs.mkdirSync(childDir, { recursive: true });
    // 先建孩子进度（已学 ✅），再分配快照——快照不覆盖孩子进度
    insertCourse(childDir, { topic: "lunyu", title: "论语学而篇第一章", status: "✅", mastery: "良好" });
    allocateTopicToChild("default", CHILD, "lunyu");

    const text = await run({ type: "progress", childId: CHILD });
    expect(text).toContain("学习进度");
    expect(text).toContain("论语");
    expect(text).toContain("✅");

    // 只读验证：查询后课程进度未被改动
    const db = openKbDb(childDir);
    try {
      const row = db.prepare("SELECT status, mastery FROM courses WHERE topic = 'lunyu'").get() as any;
      expect(row.status).toBe("✅");
      expect(row.mastery).toBe("良好");
    } finally {
      db.close();
    }
  });

  it("daily：有记录时输出每日学习记录；缺省日期不抛错", async () => {
    const childDir = path.join(mockTmpRoot, "children", CHILD);
    fs.mkdirSync(childDir, { recursive: true });
    insertDailyEntry(childDir, { date: "2026-08-24", block: "学习", title: "论语第一章", content: "- 标签：学习\n读完第一章" });
    insertDailyEntry(childDir, { date: "2026-08-24", block: "生活", title: "帮妈妈洗碗", content: "- 标签：劳动\n主动帮忙" });

    const text = await run({ type: "daily", childId: CHILD, date: "2026-08-24" });
    expect(text).toContain("每日学习记录");
    expect(text).toContain("论语第一章");
    expect(text).toContain("帮妈妈洗碗");
  });

  it("daily / progress 缺 childId 时报错（提示参数），不静默", async () => {
    await expect(run({ type: "progress" })).rejects.toThrow(/childId/);
    await expect(run({ type: "daily" })).rejects.toThrow(/childId/);
  });
});

describe("activity-log 家长操作记录（markdown）", () => {
  it("appendActivityLog 首次创建表头、之后追加，不覆盖历史", () => {
    const p = getActivityLogPath();
    expect(fs.existsSync(p)).toBe(false);
    appendActivityLog("default", "更新 论语学而篇第一章 的资料");
    appendActivityLog("default", "删除课程 三字经「第一课」");
    const content = fs.readFileSync(p, "utf-8");
    expect(content).toContain("# 家长操作记录"); // 表头
    expect(content).toContain("更新 论语学而篇第一章 的资料");
    expect(content).toContain("删除课程 三字经「第一课」");
    // 追加不覆盖：两次记录都在
    const lines = content.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(2);
  });

  it("logActivityTool 追加记录并返回确认", async () => {
    const r = await logActivityTool.execute("call-1", { entry: "写了新版资料 论语第一章.html" }, {} as any, undefined, { cwd: mockTmpRoot } as any);
    const text = r.content?.find((c: any) => c.type === "text")?.text || "";
    expect(text).toContain("activity-log.md");
    expect(fs.readFileSync(getActivityLogPath(), "utf-8")).toContain("写了新版资料 论语第一章.html");
  });

  it("logActivityTool 缺 entry 时报错", async () => {
    await expect(
      logActivityTool.execute("call-1", { entry: "" }, {} as any, undefined, { cwd: mockTmpRoot } as any)
    ).rejects.toThrow(/entry/);
  });
});

describe("move_file / copy_file 文件整理工具", () => {
  const ctx = { cwd: mockTmpRoot } as any;
  const matDir = path.join(mockTmpRoot, "parents", "default", "materials", "lunyu");

  beforeEach(() => {
    fs.mkdirSync(matDir, { recursive: true });
  });

  it("move_file 移动文件并自动记录 activity-log", async () => {
    const src = path.join(matDir, "旧名.html");
    fs.writeFileSync(src, "<html>x</html>", "utf-8");
    const r = await moveFileTool.execute("c1", { source: "parents/default/materials/lunyu/旧名.html", dest: "parents/default/materials/lunyu/新名.html" }, {} as any, undefined, ctx);
    expect(r.content?.[0]?.text).toContain("已移动");
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(path.join(matDir, "新名.html"))).toBe(true);
    expect(fs.readFileSync(getActivityLogPath(), "utf-8")).toContain("移动/重命名");
  });

  it("move_file 目标已存在时报错（不覆盖）", async () => {
    fs.writeFileSync(path.join(matDir, "a.html"), "a", "utf-8");
    fs.writeFileSync(path.join(matDir, "b.html"), "b", "utf-8");
    await expect(
      moveFileTool.execute("c2", { source: "parents/default/materials/lunyu/a.html", dest: "parents/default/materials/lunyu/b.html" }, {} as any, undefined, ctx)
    ).rejects.toThrow(/已存在/);
  });

  it("move_file / copy_file 拒绝越出 data/ 的路径", async () => {
    fs.writeFileSync(path.join(matDir, "a.html"), "a", "utf-8");
    await expect(
      moveFileTool.execute("c3", { source: "parents/default/materials/lunyu/a.html", dest: "../escape.html" }, {} as any, undefined, ctx)
    ).rejects.toThrow(/超出工作空间/);
    await expect(
      copyFileTool.execute("c4", { source: "../../etc/passwd", dest: "parents/default/materials/lunyu/x.html" }, {} as any, undefined, ctx)
    ).rejects.toThrow(/超出工作空间/);
  });

  it("copy_file 复制文件并自动记录 activity-log", async () => {
    fs.writeFileSync(path.join(matDir, "a.html"), "content-a", "utf-8");
    const r = await copyFileTool.execute("c5", { source: "parents/default/materials/lunyu/a.html", dest: "parents/default/materials/lunyu/copy.html" }, {} as any, undefined, ctx);
    expect(r.content?.[0]?.text).toContain("已复制");
    expect(fs.readFileSync(path.join(matDir, "copy.html"), "utf-8")).toBe("content-a");
    expect(fs.readFileSync(getActivityLogPath(), "utf-8")).toContain("复制");
  });

  it("move_file / copy_file 源不存在时报错", async () => {
    await expect(
      moveFileTool.execute("c6", { source: "parents/default/materials/lunyu/不存在.html", dest: "parents/default/materials/lunyu/x.html" }, {} as any, undefined, ctx)
    ).rejects.toThrow(/源文件不存在/);
    await expect(
      copyFileTool.execute("c7", { source: "parents/default/materials/lunyu/不存在.html", dest: "parents/default/materials/lunyu/x.html" }, {} as any, undefined, ctx)
    ).rejects.toThrow(/源文件不存在/);
  });
});

describe("display_content 路径解析（两层平铺 + 每课子目录/index.html）", () => {
  const ctx = { cwd: path.join(mockTmpRoot, "children", CHILD) } as any;

  beforeEach(() => {
    fs.mkdirSync(path.join(mockTmpRoot, "parents", "default", "materials", "qianziwen", "千字文-02-云腾致雨-鳞潜羽翔"), { recursive: true });
    fs.mkdirSync(path.join(mockTmpRoot, "parents", "default", "materials", "lunyu"), { recursive: true });
    fs.writeFileSync(path.join(mockTmpRoot, "parents", "default", "materials", "qianziwen", "千字文-02-云腾致雨-鳞潜羽翔", "index.html"), "<html>02段</html>", "utf-8");
    fs.writeFileSync(path.join(mockTmpRoot, "parents", "default", "materials", "lunyu", "论语学而篇第一章.html"), "<html>第一章</html>", "utf-8");
  });

  it("每课子目录/index.html 三层结构可正常展示（ISSUE-037 事故修复）", async () => {
    const r = await displayContentTool.execute("d1", { path: "materials/qianziwen/千字文-02-云腾致雨-鳞潜羽翔/index.html", title: "千字文第2段" }, {} as any, undefined, ctx);
    const panel = (r as any).details?.panelContent;
    expect(panel.content).toContain("02段");
    expect(panel.filePath).toBe("materials/qianziwen/千字文-02-云腾致雨-鳞潜羽翔/index.html");
  });

  it("两层平铺 materials/<topic>/<file>.html 仍正常（回归）", async () => {
    const r = await displayContentTool.execute("d2", { path: "materials/lunyu/论语学而篇第一章.html" }, {} as any, undefined, ctx);
    const panel = (r as any).details?.panelContent;
    expect(panel.content).toContain("第一章");
  });

  it("三层路径含 ../ 越界时拒绝（共享资料目录守卫）", async () => {
    await expect(
      displayContentTool.execute("d3", { path: "materials/qianziwen/../../parents/default/activity-log.html" }, {} as any, undefined, ctx)
    ).rejects.toThrow(/超出共享资料目录范围/);
  });

  it("文件不存在时报错（原事故报错信息）", async () => {
    await expect(
      displayContentTool.execute("d4", { path: "materials/qianziwen/千字文-99-不存在/index.html" }, {} as any, undefined, ctx)
    ).rejects.toThrow(/资料文件不存在/);
  });
});
