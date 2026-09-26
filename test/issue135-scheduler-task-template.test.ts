/**
 * ISSUE-135 P4 修订回归（2026-09-23 用户要求）：**掌握分析任务不再自动创建**。
 *
 * 背景：此前 `GET /api/v1/scheduler/tasks` 与 worker 的 custom tick 都会 `ensureDefaultMasteryTask()` 幂等播种，
 * 结果家长「并没有设置过定时任务」却在列表里看到一条每天 21:30 触发、会花 LLM 调用的任务。现改为：
 * - 任何读写接口都不会自动创建它（本文件 ①⑥ 锁住）；
 * - 只有家长显式添加才创建：`POST /api/v1/scheduler/tasks { template: "mastery_analysis" }`（固定 id，幂等，重复点不多建）；
 * - 模板本身可经 `GET /api/v1/scheduler/task-templates` 查询（UI 一键填表用，只读、不建行）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openDb } from "../server/src/db";
import { registerSchedulerRoutes } from "../server/src/routes/scheduler";
import { signSession } from "../server/src/auth/jwt";
import type { ServerConfig } from "../server/src/config";
import type { FastifyInstance } from "fastify";

const requireFromServer = createRequire(path.resolve("server/src/index.ts"));
const Fastify = requireFromServer("fastify") as (opts?: Record<string, unknown>) => FastifyInstance;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue135-sched-"));
const SECRET = "test-secret-135s";
const parentId = "parent-135s";
const childId = "child-135s";

const mainDb = openDb(dataDir);
const config: ServerConfig = { port: 8788, upstreamBase: "", jwtSecret: SECRET, tokenTtlDays: 7, dataDir };

let app: FastifyInstance;
let token = "";
const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

const listTasks = async (): Promise<Array<Record<string, unknown>>> => {
  const res = await app.inject({ method: "GET", url: "/api/v1/scheduler/tasks", headers: auth() });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { tasks: Array<Record<string, unknown>> }).tasks;
};
const customCount = async (): Promise<number> => (await listTasks()).filter((t) => t.type === "custom").length;

beforeAll(async () => {
  const now = new Date().toISOString();
  mainDb
    .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
    .run(parentId, "s135@test", now, now);
  mainDb
    .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(childId, parentId, "珊珊", now, now);
  token = signSession({ parent_id: parentId, email: "s135@test", plan: "basic" }, SECRET, 7);
  app = Fastify();
  registerSchedulerRoutes(app, { config, db: mainDb });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  mainDb.close();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟释放，忽略 */
  }
});

describe("ISSUE-135 P4 修订：掌握分析任务不再自动播种", () => {
  it("① GET /scheduler/tasks —— 打开列表**不会**自动创建任务", async () => {
    const tasks = await listTasks();
    expect(tasks.filter((t) => t.type === "custom")).toHaveLength(0);
    // 再打开一次也不该有（幂等播种已移除）
    expect(await customCount()).toBe(0);
  });

  it("② GET /scheduler/task-templates —— 返回掌握分析模板（只读，不建行）", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/scheduler/task-templates", headers: auth() });
    expect(res.statusCode, res.body).toBe(200);
    const list = (res.json() as { templates: Array<Record<string, unknown>> }).templates;
    expect(list).toHaveLength(1);
    expect(list[0]!.key).toBe("mastery_analysis");
    expect(list[0]!.name).toBe("学习情况分析");
    expect(list[0]!.time).toBe("21:30");
    expect(String(list[0]!.instruction)).toContain("mastery_todo_list");
    // 读模板不该建出任务
    expect(await customCount()).toBe(0);
  });

  it("③ POST /scheduler/tasks { template } —— 家长显式添加才创建，含分配孩子", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/scheduler/tasks",
      headers: auth(),
      payload: { template: "mastery_analysis" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { ok: boolean; created: boolean; task: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
    expect(body.task.type).toBe("custom");
    expect(body.task.time).toBe("21:30");
    expect(body.task.enabled).toBe(true);
    expect(await customCount()).toBe(1);
    // 分配行
    const a = mainDb
      .prepare("SELECT child_id, enabled FROM scheduler_task_assignments WHERE task_id = ?")
      .all(`task_mastery_${parentId}`) as Array<Record<string, unknown>>;
    expect(a.map((x) => x.child_id)).toEqual([childId]);
    expect(Number(a[0]!.enabled)).toBe(1);
  });

  it("④ 重复添加 —— created=false，不新建第二行", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/scheduler/tasks",
      headers: auth(),
      payload: { template: "mastery_analysis" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { created: boolean }).created).toBe(false);
    expect(await customCount()).toBe(1);
  });

  it("⑤ 未知模板 → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/scheduler/tasks",
      headers: auth(),
      payload: { template: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(await customCount()).toBe(1);
  });

  it("⑥ 缺 token → 401（模板与列表都不放行）", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/scheduler/tasks" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/scheduler/task-templates" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/scheduler/tasks", payload: { template: "mastery_analysis" } })).statusCode).toBe(401);
  });

  // —— 2026-09-26：UI 模板对话框支持家长改名称/时刻/提示词后保存（POST {template, ...overrides}）——
  it("⑦ 模板创建带覆盖（家长改过提示词/时刻）→ 落库为改过的值；非法 time / 空指令 → 400", async () => {
    // 先删掉 ③④ 建的那条，验证「带覆盖的创建」这条路径
    mainDb.prepare("DELETE FROM scheduler_tasks WHERE id = ?").run(`task_mastery_${parentId}`);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/scheduler/tasks",
      headers: auth(),
      payload: { template: "mastery_analysis", name: "学习情况分析（每日）", time: "20:00", instruction: "汇总本周学习与考核结果并更新课程掌握。" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { created: boolean; task: Record<string, unknown> };
    expect(body.created).toBe(true);
    expect(body.task.name).toBe("学习情况分析（每日）");
    expect(body.task.time).toBe("20:00");
    expect(String(body.task.instruction)).toContain("汇总本周学习与考核结果");
    expect(await customCount()).toBe(1);

    // 非法 time → 400；空 instruction → 400（都不建行）
    const badTime = await app.inject({
      method: "POST", url: "/api/v1/scheduler/tasks", headers: auth(),
      payload: { template: "mastery_analysis", time: "晚上八点" },
    });
    expect(badTime.statusCode).toBe(400);
    const badInstr = await app.inject({
      method: "POST", url: "/api/v1/scheduler/tasks", headers: auth(),
      payload: { template: "mastery_analysis", instruction: "   " },
    });
    expect(badInstr.statusCode).toBe(400);
    expect(await customCount()).toBe(1);
  });

  it("⑧ 任务已存在时带覆盖保存 → 不新建行，家长确认过的设置生效", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/scheduler/tasks",
      headers: auth(),
      payload: { template: "mastery_analysis", name: "学习情况分析", time: "22:00", instruction: "改后的提示词。" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { created: boolean; task: Record<string, unknown> };
    expect(body.created).toBe(false); // 固定 id：不新建
    expect(body.task.time).toBe("22:00");
    expect(String(body.task.instruction)).toBe("改后的提示词。");
    expect(await customCount()).toBe(1);
  });
});
