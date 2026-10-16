/**
 * ISSUE-182 回归（2026-10-15）：自定义定时任务 v2——按「分配的 agent」用默认上下文+全量工具执行；
 * 可分配家长；失败通知；指令模板。
 *
 * 守住：
 * ① target_type 迁移（新建库 + 老库幂等补列）+ scheduler_alerts 表；
 * ② runCustomTasksTick 目标分支：家长分配整任务一轮（无 per-child 展开）、孩子分配逐孩子、占位幂等；
 * ③ executeCustomTask 家长目标（注入）：prompt 执行对象=家长、task_runs.target_type='parent'；
 * ④ 失败通知（F4）：连续 error ≥2 推一条（同串去重）、恢复 ok 清零、新串再推；路由可读回；
 * ⑤ effective-config 不吃家长行；task_runs/assignments 的 targetType 透传；
 * ⑥ 路由：assign target=parent（仅 custom）、模板清单含新模板、普通模板创建/覆盖；
 * ⑦ 看门狗时长分支（孩子 5 分钟 / 家长 11 分钟）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../server/src/db";
import { execTimeoutMs, executeCustomTask, runCustomTasksTick, type CustomTaskRow, type CustomTaskTarget } from "../server/src/worker/custom-tasks";
import { buildEffectiveChildConfig, listTaskRuns, listTasksWithAssignments } from "../server/src/db/task-runs";
import { listSchedulerAlerts, recordSchedulerAlert, type SchedulerAlertPublish } from "../server/src/worker/task-alerts";
import { registerSchedulerRoutes } from "../server/src/routes/scheduler";
import { signSession } from "../server/src/auth/jwt";
import type { ServerConfig } from "../server/src/config";
import type { FastifyInstance } from "fastify";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue182-"));
const parentId = "parent-182";
const childA = "child-182a";
const childB = "child-182b";

const mainDb = openDb(dataDir);
const nowIso = () => new Date().toISOString();

beforeAll(() => {
  mainDb.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(parentId, "p182@test", nowIso(), nowIso());
  for (const [id, name] of [
    [childA, "珊珊"],
    [childB, "小明"],
  ] as const) {
    mainDb.prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, parentId, name, nowIso(), nowIso());
  }
});

afterAll(async () => {
  try {
    await app?.close();
  } catch {
    /* 忽略 */
  }
  try {
    mainDb.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL 句柄滞后，忽略 */
  }
});

let taskSeq = 0;
function seedCustomTask(overrides: Partial<CustomTaskRow> = {}): CustomTaskRow {
  taskSeq += 1;
  const base: CustomTaskRow = {
    id: `task_182_${taskSeq}`,
    parent_id: parentId,
    name: `测试任务${taskSeq}`,
    instruction: "整理上周考核并生成报表",
    time: "06:00",
    frequency: "daily",
    weekday: null,
    interval_minutes: null,
    fire_at: null,
    last_fired_at: null,
    expired: 0,
    ...overrides,
  };
  mainDb
    .prepare(
      `INSERT INTO scheduler_tasks (id, parent_id, name, type, time, enabled, owner, frequency, instruction, weekday, interval_minutes, fire_at, last_fired_at, expired, created_at, updated_at)
       VALUES (?, ?, ?, 'custom', ?, 1, 'parent', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(base.id, parentId, base.name, base.time, base.frequency, base.instruction, base.weekday, base.interval_minutes, base.fire_at, base.last_fired_at, base.expired, nowIso(), nowIso());
  return base;
}

function assignChild(taskId: string, childId: string): void {
  mainDb
    .prepare("INSERT INTO scheduler_task_assignments (task_id, child_id, enabled, created_at) VALUES (?, ?, 1, ?)")
    .run(taskId, childId, nowIso());
}
function assignParent(taskId: string): void {
  mainDb
    .prepare("INSERT INTO scheduler_task_assignments (task_id, child_id, target_type, enabled, created_at) VALUES (?, ?, 'parent', 1, ?)")
    .run(taskId, parentId, nowIso());
}

// ---------------------------------------------------------------- 迁移

describe("ISSUE-182 target_type 迁移", () => {
  it("新建库：assignments/task_runs 带 target_type，scheduler_alerts 表存在", () => {
    const aCols = (mainDb.prepare("PRAGMA table_info(scheduler_task_assignments)").all() as Array<{ name: string }>).map((c) => c.name);
    const rCols = (mainDb.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(aCols).toContain("target_type");
    expect(rCols).toContain("target_type");
    const hasAlerts = mainDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_alerts'").get();
    expect(hasAlerts).toBeTruthy();
  });

  it("老库：缺 target_type 列时 openDb 幂等补列", () => {
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue182-old-"));
    try {
      const raw = new DatabaseSync(path.join(oldDir, "server.sqlite"));
      raw.exec(`
        CREATE TABLE scheduler_task_assignments (
          task_id TEXT NOT NULL, child_id TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
          PRIMARY KEY (task_id, child_id)
        );
        CREATE TABLE task_runs (
          id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, child_id TEXT NOT NULL, task_id TEXT,
          task_name TEXT NOT NULL DEFAULT '', task_type TEXT NOT NULL DEFAULT '', date TEXT NOT NULL,
          point TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ok', message TEXT NOT NULL DEFAULT '',
          started_at TEXT NOT NULL, finished_at TEXT NOT NULL
        );
      `);
      raw.close();
      const db2 = openDb(oldDir);
      try {
        const aCols = (db2.prepare("PRAGMA table_info(scheduler_task_assignments)").all() as Array<{ name: string }>).map((c) => c.name);
        const rCols = (db2.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>).map((c) => c.name);
        expect(aCols).toContain("target_type");
        expect(rCols).toContain("target_type");
      } finally {
        db2.close();
      }
    } finally {
      try {
        fs.rmSync(oldDir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }
  });
});

// ---------------------------------------------------------------- 看门狗分支（F3）

describe("ISSUE-182 看门狗时长分支", () => {
  it("孩子任务 5 分钟，家长任务 11 分钟", () => {
    expect(execTimeoutMs({ kind: "child", childId: childA })).toBe(5 * 60_000);
    expect(execTimeoutMs({ kind: "parent" })).toBe(11 * 60_000);
  });
});

// ---------------------------------------------------------------- tick 目标分支（F2）

describe("ISSUE-182 runCustomTasksTick 目标分支", () => {
  it("仅家长分配 → 整任务一轮（无 per-child 展开），占位照旧", async () => {
    mainDb.prepare("UPDATE scheduler_tasks SET enabled = 0 WHERE parent_id = ? AND type = 'custom'").run(parentId);
    const t = seedCustomTask({ name: "家长周报", time: "07:00" });
    assignParent(t.id);
    const now = new Date(2026, 9, 15, 7, 10);
    const targets: CustomTaskTarget[] = [];
    const fired = await runCustomTasksTick({ dataDir, db: mainDb }, now, {
      exec: async (_deps, _pid, target) => {
        targets.push(target);
      },
    });
    expect(fired).toBe(1);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toEqual({ kind: "parent" });
    // 占位：同 tick / 同日再跑不重复
    const fired2 = await runCustomTasksTick({ dataDir, db: mainDb }, new Date(2026, 9, 15, 7, 20), { exec: async () => undefined });
    expect(fired2).toBe(0);
    const row = mainDb.prepare("SELECT last_fired_at FROM scheduler_tasks WHERE id = ?").get(t.id) as { last_fired_at: string };
    expect(row.last_fired_at).toBeTruthy();
  });

  it("家长 + 2 孩子 → 1 家长轮 + 2 孩子轮，互不吞并", async () => {
    const t = seedCustomTask({ name: "全家天气", time: "07:30" });
    assignChild(t.id, childA);
    assignChild(t.id, childB);
    assignParent(t.id);
    const now = new Date(2026, 9, 15, 7, 31);
    const targets: CustomTaskTarget[] = [];
    const fired = await runCustomTasksTick({ dataDir, db: mainDb }, now, {
      exec: async (...args) => {
        targets.push(args[2] as CustomTaskTarget);
      },
    });
    expect(fired).toBe(1);
    expect(targets).toHaveLength(3);
    expect(targets.filter((x) => x.kind === "parent")).toHaveLength(1);
    expect(targets.filter((x) => x.kind === "child").map((x) => (x as { childId: string }).childId).sort()).toEqual([childA, childB].sort());
  });
});

// ---------------------------------------------------------------- 家长目标执行（注入）

describe("ISSUE-182 executeCustomTask 家长目标", () => {
  it("prompt 执行对象=家长；task_runs 写 target_type='parent'", async () => {
    const t = seedCustomTask({ name: "家长任务", instruction: "汇总孩子本周学习情况" });
    const publishCalls: Array<{ key: string; type: string }> = [];
    const publish: SchedulerAlertPublish = (key, type) => {
      publishCalls.push({ key, type });
    };
    await executeCustomTask({ dataDir, db: mainDb }, parentId, { kind: "parent" }, t, new Date(2026, 9, 15, 8, 0), {
      round: async (prompt) => {
        expect(prompt).toContain("执行对象：家长");
        expect(prompt).toContain("汇总孩子本周学习情况");
        expect(prompt).not.toContain("珊珊");
        return "已生成本周学习汇总。";
      },
      publish,
    });
    const run = mainDb
      .prepare("SELECT status, message, target_type, child_id FROM task_runs WHERE task_id = ? ORDER BY finished_at DESC LIMIT 1")
      .get(t.id) as { status: string; message: string; target_type: string; child_id: string };
    expect(run.status).toBe("ok");
    expect(run.target_type).toBe("parent");
    expect(run.child_id).toBe(parentId);
    // 成功不推提醒
    expect(publishCalls).toHaveLength(0);
    expect(listSchedulerAlerts(mainDb, parentId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 失败通知（F4）

describe("ISSUE-182 失败通知", () => {
  it("连续 error ≥2 → 推一条；同串第 3 次不重推；恢复 ok 清零后新串再推", async () => {
    const t = seedCustomTask({ name: "会挂的任务" });
    let publishCount = 0;
    const publish: SchedulerAlertPublish = () => {
      publishCount += 1;
    };
    const failAt = async (d: Date) =>
      executeCustomTask({ dataDir, db: mainDb }, parentId, { kind: "child", childId: childA }, t, d, {
        round: async () => {
          throw new Error("模型额度不足");
        },
        publish,
      });

    await failAt(new Date(2026, 9, 15, 9, 0)); // 第 1 次 error： streak=1，不推
    expect(publishCount).toBe(0);
    expect(listSchedulerAlerts(mainDb, parentId)).toHaveLength(0);

    await failAt(new Date(2026, 9, 15, 9, 5)); // 第 2 次：连续 ≥2 → 推一条
    expect(publishCount).toBe(1);
    const alerts1 = listSchedulerAlerts(mainDb, parentId);
    expect(alerts1).toHaveLength(1);
    expect(alerts1[0]!.taskId).toBe(t.id);
    expect(alerts1[0]!.message).toContain("模型额度不足");

    await failAt(new Date(2026, 9, 15, 9, 10)); // 第 3 次：同一失败串 → 不重推
    expect(publishCount).toBe(1);
    expect(listSchedulerAlerts(mainDb, parentId)).toHaveLength(1);

    // 恢复 ok → 清零；之后单次 error 不推，再次连续 2 次 error → 新串再推
    await executeCustomTask({ dataDir, db: mainDb }, parentId, { kind: "child", childId: childA }, t, new Date(2026, 9, 15, 9, 15), {
      round: async () => "恢复正常",
      publish,
    });
    expect(publishCount).toBe(1);
    await failAt(new Date(2026, 9, 15, 9, 20));
    expect(publishCount).toBe(1);
    await failAt(new Date(2026, 9, 15, 9, 25));
    expect(publishCount).toBe(2);
    expect(listSchedulerAlerts(mainDb, parentId)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- 配置隔离与透传（F2）

describe("ISSUE-182 effective-config 与 targetType 透传", () => {
  it("家长分配行不进 per-child 有效配置", () => {
    const t = seedCustomTask({ name: "家长分析" });
    assignParent(t.id);
    const cfg = buildEffectiveChildConfig(mainDb, parentId);
    expect(Object.keys(cfg)).not.toContain(parentId);
    expect(Object.keys(cfg).sort()).toEqual([childA, childB].sort());
  });

  it("任务列表/执行结果带 targetType；孩子查询不被家长行污染", async () => {
    const t = seedCustomTask({ name: "透传检查" });
    assignChild(t.id, childA);
    assignParent(t.id);
    const task = listTasksWithAssignments(mainDb, parentId).find((x) => x.id === t.id)!;
    expect(task.assignments).toHaveLength(2);
    expect(task.assignments.filter((a) => a.targetType === "parent").map((a) => a.childId)).toEqual([parentId]);

    await executeCustomTask({ dataDir, db: mainDb }, parentId, { kind: "parent" }, t, new Date(2026, 9, 15, 10, 0), {
      round: async () => "家长侧完成",
      publish: null,
    });
    await executeCustomTask({ dataDir, db: mainDb }, parentId, { kind: "child", childId: childA }, t, new Date(2026, 9, 15, 10, 1), {
      round: async () => "孩子侧完成",
      publish: null,
    });
    const runs = listTaskRuns(mainDb, parentId, { limit: 10 }).filter((r) => r.taskId === t.id);
    expect(runs).toHaveLength(2);
    const parentRun = runs.find((r) => r.targetType === "parent")!;
    const childRun = runs.find((r) => r.targetType === "child")!;
    expect(parentRun.childId).toBe(parentId);
    expect(childRun.childId).toBe(childA);
    // 按孩子过滤：只回孩子的 run
    const onlyChild = listTaskRuns(mainDb, parentId, { childId: childA }).filter((r) => r.taskId === t.id);
    expect(onlyChild).toHaveLength(1);
    expect(onlyChild[0]!.targetType).toBe("child");
  });
});

// ---------------------------------------------------------------- 路由（F2/F4/F5）

const requireFromServer = createRequire(path.resolve("server/src/index.ts"));
const Fastify = requireFromServer("fastify") as (opts?: Record<string, unknown>) => FastifyInstance;

const SECRET = "test-secret-182";
const config: ServerConfig = { port: 8789, upstreamBase: "", jwtSecret: SECRET, tokenTtlDays: 7, dataDir };
let app: FastifyInstance;
let token = "";
const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  token = signSession({ parent_id: parentId, email: "p182@test", plan: "basic" }, SECRET, 7);
  app = Fastify();
  registerSchedulerRoutes(app, { config, db: mainDb });
  await app.ready();
}, 60_000);

describe("ISSUE-182 路由", () => {
  it("assign target=parent：custom 任务可分配家长；recording 任务 400；列表带 targetType", async () => {
    const custom = seedCustomTask({ name: "路由家长任务" });
    const okRes = await app.inject({
      method: "POST",
      url: `/api/v1/scheduler/tasks/${custom.id}/assign`,
      headers: auth(),
      payload: { target: "parent", enabled: true },
    });
    expect(okRes.statusCode, okRes.body).toBe(200);

    // recording 任务（非 custom）→ 400
    mainDb
      .prepare(
        "INSERT INTO scheduler_tasks (id, parent_id, name, type, time, enabled, owner, created_at, updated_at) VALUES (?, ?, ?, 'recording', '12:00', 1, 'parent', ?, ?)"
      )
      .run("task_rec_182", parentId, "录音任务", nowIso(), nowIso());
    const badRes = await app.inject({
      method: "POST",
      url: "/api/v1/scheduler/tasks/task_rec_182/assign",
      headers: auth(),
      payload: { target: "parent", enabled: true },
    });
    expect(badRes.statusCode).toBe(400);

    const tasks = listTasksWithAssignments(mainDb, parentId);
    const t = tasks.find((x) => x.id === custom.id)!;
    expect(t.assignments.some((a) => a.targetType === "parent" && a.childId === parentId && a.enabled)).toBe(true);
    // 取消分配
    const offRes = await app.inject({
      method: "POST",
      url: `/api/v1/scheduler/tasks/${custom.id}/assign`,
      headers: auth(),
      payload: { target: "parent", enabled: false },
    });
    expect(offRes.statusCode).toBe(200);
    const t2 = listTasksWithAssignments(mainDb, parentId).find((x) => x.id === custom.id)!;
    expect(t2.assignments.find((a) => a.targetType === "parent")?.enabled).toBe(false);
  });

  it("模板清单含普通模板；weather 模板创建 = 普通 custom 任务（可覆盖）", async () => {
    const tplRes = await app.inject({ method: "GET", url: "/api/v1/scheduler/task-templates", headers: auth() });
    expect(tplRes.statusCode).toBe(200);
    const keys = (tplRes.json() as { templates: Array<{ key: string }> }).templates.map((t) => t.key);
    expect(keys).toContain("weather_outfit_reminder");
    expect(keys).toContain("mistake_review_reminder");

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/scheduler/tasks",
      headers: auth(),
      payload: { template: "weather_outfit_reminder", time: "07:45", instruction: "自定义后的指令" },
    });
    expect(createRes.statusCode, createRes.body).toBe(200);
    const body = createRes.json() as { ok: boolean; task: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.task.type).toBe("custom");
    expect(body.task.name).toBe("天气与穿衣提醒"); // 名称未覆盖 → 模板默认
    expect(body.task.time).toBe("07:45"); // 时刻覆盖生效
    expect(String(body.task.instruction)).toBe("自定义后的指令");
    expect((body.task.assignments as Array<unknown>)).toHaveLength(0); // 普通模板不自动分配
  });

  it("alerts 路由：家长读回失败提醒", async () => {
    recordSchedulerAlert(mainDb, { parentId, taskId: "task_x", taskName: "路由提醒任务", message: "执行超过 5 分钟无完成" });
    const res = await app.inject({ method: "GET", url: "/api/v1/scheduler/alerts", headers: auth() });
    expect(res.statusCode, res.body).toBe(200);
    const alerts = (res.json() as { alerts: Array<{ taskName?: string; message?: string }> }).alerts;
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]!.taskName).toBe("路由提醒任务");
    expect(alerts[0]!.message).toContain("5 分钟");
    // 未登录 → 401
    const anon = await app.inject({ method: "GET", url: "/api/v1/scheduler/alerts" });
    expect(anon.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------- 家长 agent 建任务工具（target 分配）

describe("ISSUE-182 家长 agent 建任务工具（target 分配与 v2 口径）", () => {
  it("target=parent：落库任务 + 家长分配行（target_type=parent）；childName 路径照旧", async () => {
    const { createPlanDomainTools } = await import("../server/src/agent/parent-plans");
    const tool: any = createPlanDomainTools({ db: mainDb, dataDir, parentId }).find(
      (t: any) => t.name === "parent_scheduler_task_create"
    );
    // 本 issue 的用户场景：每天早上给当天学习计划的课程建考核计划 → 分配给家长（家长名义=必考）
    const r = await tool.execute("x", {
      target: "parent",
      name: "每日考核计划",
      instruction: "查看当天学习计划：对每门新学的课创建考核计划（考全部知识点）；复习的课只考掌握不好的知识点。",
      time: "07:00",
    });
    expect(((r as any).content as Array<{ text: string }>).map((c) => c.text).join("")).toContain("家长本人");
    const row = mainDb
      .prepare("SELECT id, frequency FROM scheduler_tasks WHERE parent_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1")
      .get(parentId, "每日考核计划") as { id: string; frequency: string };
    expect(row.frequency).toBe("daily");
    const assigns = mainDb
      .prepare("SELECT child_id, target_type, enabled FROM scheduler_task_assignments WHERE task_id = ?")
      .all(row.id) as Array<{ child_id: string; target_type: string; enabled: number }>;
    expect(assigns).toEqual([{ child_id: parentId, target_type: "parent", enabled: 1 }]);

    // 孩子路径照旧（childName → target_type='child'）
    await tool.execute("y", { childName: "珊珊", name: "孩子天气任务", instruction: "每天播报天气", time: "06:00" });
    const row2 = mainDb
      .prepare("SELECT id FROM scheduler_tasks WHERE parent_id = ? AND name = ?")
      .get(parentId, "孩子天气任务") as { id: string };
    const a2 = mainDb
      .prepare("SELECT child_id, target_type FROM scheduler_task_assignments WHERE task_id = ?")
      .all(row2.id) as Array<{ child_id: string; target_type: string }>;
    expect(a2).toEqual([{ child_id: childA, target_type: "child" }]);
  });

  it("校验：分配对象二选一必填、target 非法值 / 与 childName 并用被拒（都不落行）", async () => {
    const { createPlanDomainTools } = await import("../server/src/agent/parent-plans");
    const tool: any = createPlanDomainTools({ db: mainDb, dataDir, parentId }).find(
      (t: any) => t.name === "parent_scheduler_task_create"
    );
    await expect(tool.execute("x", { name: "n", instruction: "i", time: "07:00" })).rejects.toThrow(/childName|target/);
    await expect(
      tool.execute("x", { target: "child", childName: "珊珊", name: "n", instruction: "i", time: "07:00" })
    ).rejects.toThrow(/target/);
    await expect(
      tool.execute("x", { target: "parent", childName: "珊珊", name: "n", instruction: "i", time: "07:00" })
    ).rejects.toThrow(/二选一/);
    const cnt = mainDb.prepare("SELECT COUNT(*) AS c FROM scheduler_tasks WHERE parent_id = ? AND name = 'n'").get(parentId) as {
      c: number;
    };
    expect(cnt.c).toBe(0);
  });
});
