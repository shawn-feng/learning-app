import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

vi.mock("electron", () => ({ app: undefined }));

const mockTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parent-blocks-"));
vi.mock("../electron/lib/config", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../electron/lib/config")>();
  return {
    ...mod,
    getDataDir: () => mockTmpRoot,
    getLicensePath: () => path.join(mockTmpRoot, "license.json"),
    getChildrenDir: () => path.join(mockTmpRoot, "children"),
    getChildDir: (id: string) => path.join(mockTmpRoot, "children", id),
    getSharedDir: () => path.join(mockTmpRoot, "shared"),
    getSkillsDir: () => path.join(mockTmpRoot, "shared", "skills"),
    getParentConfigDir: () => path.join(mockTmpRoot, "parents", "_guest"),
    getAppSettingsPath: () => path.join(mockTmpRoot, "parents", "_guest", "app-settings.json"),
    getCurrentParentId: () => "",
  };
});

import { appConfigTool, APP_CONFIG_REGISTRY } from "../electron/lib/app-config";
import { parentTopicSaveTool, parentStatsTool } from "../electron/lib/custom-tools";
import { upsertParentTopic, allocateTopicToChild, getActivityLogPath } from "../electron/lib/parent-library";
import { getAppSettingsPath } from "../electron/lib/config";
import { writeTestLicense, registerTestChild } from "./helpers/server-token";
import { dbExec, dbQuery } from "../electron/lib/client-data";

let CHILD = "";

async function runStats(params: any): Promise<string> {
  const r = await parentStatsTool.execute("call-1", params, {} as any, undefined, { cwd: mockTmpRoot } as any);
  return r.content?.find((c: any) => c.type === "text")?.text || "";
}

async function runTopicSave(params: any): Promise<string> {
  const r = await parentTopicSaveTool.execute("call-1", params, {} as any, undefined, { cwd: mockTmpRoot } as any);
  return r.content?.find((c: any) => c.type === "text")?.text || "";
}

async function runAppConfig(params: any): Promise<string> {
  const r = await appConfigTool.execute("call-1", params, {} as any, undefined, { cwd: mockTmpRoot } as any);
  return r.content?.find((c: any) => c.type === "text")?.text || "";
}

/** 清理家长库主题 + 孩子主题（避免跨用例残留污染测试家长库） */
async function cleanupTopic(topicKey: string) {
  await dbExec("parent_lib.courses.delete", { topic: topicKey }).catch(() => {});
  await dbExec("kb.courses.delete", { child_id: CHILD, topic: topicKey }).catch(() => {});
}

beforeEach(async () => {
  fs.rmSync(mockTmpRoot, { recursive: true, force: true });
  fs.mkdirSync(mockTmpRoot, { recursive: true });
  fs.mkdirSync(path.join(mockTmpRoot, "children"), { recursive: true });
  writeTestLicense(mockTmpRoot, crypto.randomUUID());
  CHILD = crypto.randomUUID();
  await registerTestChild(mockTmpRoot, CHILD, "测试孩子");
});

afterAll(() => {
  fs.rmSync(mockTmpRoot, { recursive: true, force: true });
});

describe("块3：parent_stats mastery 逐课掌握度", () => {
  it("无主题时返回提示，不抛错", async () => {
    const text = await runStats({ type: "mastery", childId: CHILD });
    expect(text).toContain("暂无课程");
  });

  it("返回逐课掌握度分布（已掌握/学习中/未开始 + 掌握度字段）", async () => {
    await upsertParentTopic(
      "default",
      { name: "唐诗", topicKey: "tangshi", method: "# 方法" },
      [
        { title: "静夜思", lessonMethod: "朗读" },
        { title: "春晓", lessonMethod: "朗读" },
        { title: "登鹳雀楼", lessonMethod: "朗读" },
      ]
    );
    // 预置一门课为已学（status ✅ + mastery 熟练），一门为已开首次未掌握，一门未开始
    await dbExec("kb.courses.upsert", { child_id: CHILD, topic: "tangshi", title: "静夜思", sort_order: 0, status: "✅", mastery: "熟练", first_learned: "2026-09-01", last_review: "2026-09-02", review_count: 1, material: "", send_material: "", tags: "", lesson_method: "", html_path: "", teaching_copy: "" });
    await dbExec("kb.courses.upsert", { child_id: CHILD, topic: "tangshi", title: "春晓", sort_order: 1, status: "⬜", mastery: "", first_learned: "2026-09-03", last_review: "", review_count: 0, material: "", send_material: "", tags: "", lesson_method: "", html_path: "", teaching_copy: "" });
    await allocateTopicToChild("default", CHILD, "tangshi");
    // 分配会把春晓重置回未学；重新预置首学，制造「学习中」
    await dbExec("kb.courses.upsert", { child_id: CHILD, topic: "tangshi", title: "春晓", sort_order: 1, status: "⬜", mastery: "", first_learned: "2026-09-03", last_review: "", review_count: 0, material: "", send_material: "", tags: "", lesson_method: "", html_path: "", teaching_copy: "" });

    const text = await runStats({ type: "mastery", childId: CHILD, topic: "tangshi" });
    expect(text).toContain("逐课掌握度");
    expect(text).toContain("主题 tangshi");
    expect(text).toContain("已掌握 1 / 学习中 1 / 未开始 1");
    expect(text).toContain("静夜思");
    expect(text).toContain("已掌握");
    expect(text).toContain("掌握度 熟练");
    await cleanupTopic("tangshi");
  });
});

describe("块3：parent_stats progress 多孩子对比（childId 缺省）", () => {
  it("childId 缺省返回『全部孩子学习进度对比』", async () => {
    const text = await runStats({ type: "progress" });
    expect(text).toContain("全部孩子学习进度对比");
  });
});

describe("块2：parent_topic_save 主题级 + 分配", () => {
  it("新建主题（name+method+courses），家长库真源可查", async () => {
    const text = await runTopicSave({
      topic: "tangshi",
      name: "唐诗",
      method: "# 唐诗教学法\n1. 先读",
      courses: [{ title: "静夜思", lessonMethod: "朗读" }],
    });
    expect(text).toContain("已保存主题");
    const topics = await dbQuery<any[]>("parent_lib.topics.list", {});
    const t = topics.find((x) => x.topic_key === "tangshi");
    expect(t).toBeTruthy();
    expect(t.name).toBe("唐诗");
    expect(t.method).toContain("唐诗教学法");
    await cleanupTopic("tangshi");
  });

  it("带 assignToChildren 会分配给孩子（快照拷贝），活动日志留痕", async () => {
    await runTopicSave({ topic: "santi", name: "三体", method: "# 方法", courses: [{ title: "三体一", lessonMethod: "读" }] });
    const text = await runTopicSave({ topic: "santi", assignToChildren: "测试孩子" });
    expect(text).toContain("已分配给");
    const childCourses = await dbQuery<any[]>("kb.courses.list", { child_id: CHILD, topic: "santi" });
    expect(childCourses.some((c) => c.title === "三体一")).toBe(true);
    expect(fs.readFileSync(getActivityLogPath(), "utf-8")).toContain("parent_topic_save");
    await cleanupTopic("santi");
  });

  it("只更新 method 时保留 name / 课程（合并语义）", async () => {
    await runTopicSave({ topic: "tangshi", name: "唐诗", method: "# 旧方法", courses: [{ title: "静夜思" }] });
    const text = await runTopicSave({ topic: "tangshi", method: "# 新方法" });
    expect(text).toContain("已保存主题");
    const topics = await dbQuery<any[]>("parent_lib.topics.list", {});
    const t = topics.find((x) => x.topic_key === "tangshi");
    expect(t.name).toBe("唐诗");
    expect(t.method).toContain("新方法");
    await cleanupTopic("tangshi");
  });

  it("非法 topic 名直接报错", async () => {
    await expect(runTopicSave({ topic: "bad topic/../evil", name: "x", method: "m" })).rejects.toThrow(/字母\/数字\/_\/-/);
  });
});

describe("块1：app_config 配置工具", () => {
  beforeEach(() => {
    const guest = path.join(mockTmpRoot, "parents", "_guest");
    fs.mkdirSync(guest, { recursive: true });
    // 每个用例干净起：清掉 app-settings.json 与其 .bak，避免前一个用例的 set 状态泄漏
    for (const f of fs.readdirSync(guest)) {
      if (f.startsWith("app-settings")) fs.rmSync(path.join(guest, f), { force: true });
    }
  });

  it("get 未注册 key 返回可用清单", async () => {
    const text = await runAppConfig({ type: "get", key: "not.a.key" });
    expect(text).toContain("未知配置 key");
    expect(text).toContain("materialsLimit");
  });

  it("get materialsLimit 返回当前值（默认 20）", async () => {
    const text = await runAppConfig({ type: "get", key: "materialsLimit" });
    expect(text).toContain("当前值：20");
  });

  it("set 高影响项未 confirmed 时要求家长确认，不直接改", async () => {
    const text = await runAppConfig({ type: "set", key: "materialsLimit", value: 50 });
    expect(text).toContain("请把");
    expect(text).toContain("confirmed");
    // 值未变
    const after = await runAppConfig({ type: "get", key: "materialsLimit" });
    expect(after).toContain("当前值：20");
  });

  it("set 高影响项 confirmed:true 后真正生效 + .bak 备份 + activity-log", async () => {
    const appSettingsPath = getAppSettingsPath();
    fs.mkdirSync(path.dirname(appSettingsPath), { recursive: true });
    fs.writeFileSync(appSettingsPath, JSON.stringify({ materialsLimit: 20 }), "utf-8");
    const text = await runAppConfig({ type: "set", key: "materialsLimit", value: 55, confirmed: true });
    expect(text).toContain("已修改 materialsLimit");
    const after = await runAppConfig({ type: "get", key: "materialsLimit" });
    expect(after).toContain("当前值：55");
    // .bak 备份存在
    const baks = fs.readdirSync(path.dirname(appSettingsPath)).filter((f) => f.startsWith("app-settings.bak-"));
    expect(baks.length).toBe(1);
    // activity-log 留痕
    expect(fs.readFileSync(getActivityLogPath(), "utf-8")).toContain("app_config 修改 materialsLimit");
  });

  it("set 越界值（超 max）报错", async () => {
    await expect(runAppConfig({ type: "set", key: "materialsLimit", value: 999, confirmed: true })).rejects.toThrow(/不能大于/);
  });

  it("只读项（scheduler/profile/agents）不允许 set", async () => {
    await expect(runAppConfig({ type: "set", key: "scheduler.dailySummary", value: "x", confirmed: true })).rejects.toThrow(/只读/);
    await expect(runAppConfig({ type: "set", key: "profile.name", value: "x", scope: { childId: CHILD }, confirmed: true })).rejects.toThrow(/只读/);
  });

  it("永不触碰项（auth/license/token）直接报错，不处理", async () => {
    await expect(runAppConfig({ type: "get", key: "auth.apiKey" })).rejects.toThrow(/安全项/);
    await expect(runAppConfig({ type: "get", key: "license.path" })).rejects.toThrow(/安全项/);
    await expect(runAppConfig({ type: "set", key: "server-connection.url", value: "x", confirmed: true })).rejects.toThrow(/安全项/);
  });

  it("child 作用域读不到 childId 时 get 不抛错、返回提示", async () => {
    const text = await runAppConfig({ type: "get", key: "profile.name" });
    expect(text).toContain("profile.name");
  });
});

describe("注册表完整性（配置域 schema）", () => {
  it("app_config 注册表含配置域全部初始 key", () => {
    for (const k of ["materialsLimit", "defaultModel", "programmingModel", "visionModel", "scheduler.dailySummary", "scheduler.autoNewSession", "scheduler.classTimes", "profile.name", "profile.age", "profile.interests", "profile.ai", "agents.parent"]) {
      expect(APP_CONFIG_REGISTRY[k]).toBeTruthy();
    }
    // 认证/账户/密码类 key 不在注册表（永不触碰，仅靠 isForbiddenKey 拦截）
  });
});
