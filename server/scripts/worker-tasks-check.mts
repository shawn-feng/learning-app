/**
 * worker 任务注册探针（调试用，无断言）。
 * 说明：todo 已随计划域重构（2026-09-10）从 WorkerTask 迁出，由 worker/scheduler.ts 的
 * plan/stat 游标驱动（见 worker/plan-domain.ts），因此这里不再假设「第二个任务 = todo」。
 * 用法：npx tsx scripts/worker-tasks-check.mts
 */
import { listTasks } from "../src/worker/tasks.js";

const tasks = listTasks();
console.log("已注册任务:", tasks.map((t) => t.type).join(", ") || "（无）");
const cfg = { recording: { enabled: true, times: ["21:00", "22:30"] } };
const off = { recording: { enabled: false, times: ["21:00"] } };
for (const t of tasks) {
  console.log(`- ${t.type}: points(启用)=${JSON.stringify(t.points(cfg as any))}，points(关闭)=${JSON.stringify(t.points(off as any))}`);
}
if (!tasks.some((t) => t.type === "recording")) {
  console.error("✗ recording 任务未注册（应有）");
  process.exit(1);
}
console.log("✓ recording 任务注册正常（todo 由 plan-domain 游标驱动，不在本清单）");
