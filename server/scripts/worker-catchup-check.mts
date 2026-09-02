/**
 * 服务端 worker 补跑策略验证（方案B 阶段②补丁）：
 * - catchUp "latest"：recording 只补最近一个已过期点
 * - catchUp "all"：todo 按序补全部已过期点（gen + stat）
 * - 第二次调用不再重复（worker_state 去重）
 * 用法：npx tsx scripts/worker-catchup-check.mts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerTask } from "../src/worker/tasks.js";
import { runWorkerCatchUp } from "../src/worker/scheduler.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-catchup-"));
const hits: string[] = [];

// 假任务：不碰真实 handler，只记录触发的 point（registered 在 import 后）
registerTask({
  type: "test-catchup-latest",
  catchUp: "latest",
  points: () => ["00:00", "01:00"],
  run: async (ctx) => {
    hits.push(`latest:${ctx.point}`);
  },
});
registerTask({
  type: "test-catchup-all",
  catchUp: "all",
  points: () => ["00:00", "01:00"],
  run: async (ctx) => {
    hits.push(`all:${ctx.point}`);
  },
});

function fail(msg: string): never {
  console.error("✗ FAIL:", msg);
  process.exit(1);
}

// 造数据：家长 + 孩子 + scheduler_config（真实任务全关，只测假任务）
{
  const db = new DatabaseSync(path.join(dataDir, "server.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS parents (id TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL DEFAULT '{}', updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_state (child_id TEXT NOT NULL, task TEXT NOT NULL, last_run TEXT NOT NULL DEFAULT '', last_key TEXT NOT NULL DEFAULT '', PRIMARY KEY (child_id, task));
    CREATE TABLE IF NOT EXISTS scheduler_tasks (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, time TEXT NOT NULL, extra_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduler_task_assignments (task_id TEXT NOT NULL, child_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, PRIMARY KEY (task_id, child_id));
    CREATE TABLE IF NOT EXISTS task_runs (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, child_id TEXT NOT NULL, task_id TEXT, task_name TEXT NOT NULL DEFAULT '', task_type TEXT NOT NULL DEFAULT '', date TEXT NOT NULL, point TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ok', message TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, finished_at TEXT NOT NULL);`);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO parents (id, email, created_at, updated_at) VALUES (?,?,?,?)").run("p1", "a@b.c", now, now);
  db.prepare("INSERT INTO children (id, parent_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("c1", "p1", "娃", now, now);
  db.prepare("INSERT INTO settings (key, value_json, updated) VALUES (?,?,?)").run(
    "p1:scheduler_config",
    JSON.stringify({
      children: {
        c1: {
          recording: { enabled: false, times: ["21:00"] },
          todo: { enabled: false, genTime: "08:00", statTime: "21:00" },
        },
      },
    }),
    now
  );
  db.prepare("INSERT INTO settings (key, value_json, updated) VALUES (?,?,?)").run("p1:auth", "{}", now);
  db.close();
}

const deps = { dataDir, db: new DatabaseSync(path.join(dataDir, "server.sqlite")) };
try {
  await runWorkerCatchUp(deps); // 第一次：latest 补 01:00；all 补 00:00+01:00
  const expect1 = ["latest:01:00", "all:00:00", "all:01:00"];
  if (JSON.stringify(hits) !== JSON.stringify(expect1)) {
    fail(`第一次补跑 hits 不符\n  期望: ${JSON.stringify(expect1)}\n  实际: ${JSON.stringify(hits)}`);
  }
  console.log("第一次补跑 通过:", JSON.stringify(hits));

  hits.length = 0;
  await runWorkerCatchUp(deps); // 第二次：全部已跑，无动作
  if (hits.length !== 0) fail(`第二次补跑应无动作，实际: ${JSON.stringify(hits)}`);
  console.log("去重（第二次不重复） 通过");

  // recording/todo 关闭时 points 为空（防止误跑真实任务）
  const { listTasks } = await import("../src/worker/tasks.js");
  const realPoints = listTasks()
    .filter((t) => t.type === "recording" || t.type === "todo")
    .map((t) => t.points({ recording: { enabled: false, times: ["21:00"] }, todo: { enabled: false, genTime: "08:00", statTime: "21:00" } }));
  if (realPoints.some((p) => p.length > 0)) fail(`关闭时真实任务 points 应为空: ${JSON.stringify(realPoints)}`);
  console.log("真实任务关闭时 points 为空 通过");

  console.log("\n✅ 补跑逻辑全部通过");
} finally {
  deps.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
