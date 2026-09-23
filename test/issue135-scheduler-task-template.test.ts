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
});
