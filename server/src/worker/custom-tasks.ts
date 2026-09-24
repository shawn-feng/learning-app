/**
 * ISSUE-116（2026-09-19）：自定义定时任务——自然语言指令到点让 agent 无头执行。
 *
 * 调度：scheduler_tasks.type='custom' + instruction（自然语言）+ frequency/time（复用四种频率）。
 * - 触发判定（沿 last_fired_at 幂等语义）：daily/weekly=「今天(且周几)已过目标时刻且今天未跑过」；
 *   once=fire_at 到点且未 expired；interval=距上次触发 ≥ interval_minutes。**daily/weekly 不用 5 分钟桶**
 *   ——到点后任意 tick（含停机恢复）当日首次命中即补跑一次；执行失败不重试（last_fired_at 已推进，次日正常）。
 * - 执行（异步不阻塞 tick）：置 last_fired_at 占位 → 每个分配孩子一轮**独立无头 ephemeral 会话**
 *   （白名单工具，见 custom-task-tools.ts）→ 看门狗 5 分钟（超时 abort，task_runs=error）→
 *   agent 末轮文本作为执行摘要写 task_runs（ok/skip/error）。
 * - 边界（issue 定稿）：owner 仅 parent；产物（提醒）可见、过程不进孩子/家长对话 UI；
 *   in-flight 内存锁防两个 tick 并发跑同一 (任务, 孩子)。
 */
import type { DatabaseSync } from "node:sqlite";
import { readParentSettings } from "./scheduler.js";
import { createWorkerEphemeralSession, hhmm, type WorkerTaskCtx } from "./tasks.js";
import { createWorkerKbTools, formatLocalDate } from "./kb-tools.js";
import {
  CUSTOM_TASK_TOOL_NAMES,
  createRemindersTool,
  createWeatherTool,
  WEEKDAY_ZH,
} from "./custom-task-tools.js";
// ISSUE-135 P4：掌握闭环归纳工具（掌握分析类自定义任务用）。
// 注意：**不再 import 默认任务播种** —— 掌握分析任务改为家长显式添加（见 mastery-tools.ts 的 MASTERY_TASK_TEMPLATE）。
// ISSUE-144 P6：原先还挂 `createDataAgentTools`（parent_db_read/write/describe 三把通用数据通道工具）——
// 通用数据 API 已整组退场，**定时任务不再有"任意读写两库登记表"的通道**：任务能用的数据面就是
// kb_query / kb_insert / kb_update（孩子库受控子集，见 kb-tools.ts）+ mastery_*。以后哪类任务缺工具，
// 就为它补一把场景专用工具，而不是把通用通道请回来。
import { createMasteryTools, MASTERY_TOOL_NAMES } from "./mastery-tools.js";
import { recordTaskRun } from "../db/task-runs.js";

const EXEC_TIMEOUT_MS = 5 * 60_000; // 待拍板③：单次执行上限 5 分钟（看门狗）

/** 自定义任务暴露的工具名**并集**：SDK 的 tools 白名单对自定义工具同样生效，漏登记 = 工具静默不可见。 */
export function customTaskToolNames(): string[] {
  return Array.from(new Set([...CUSTOM_TASK_TOOL_NAMES, ...MASTERY_TOOL_NAMES]));
}

interface CustomTaskRow {
  id: string;
  parent_id: string;
  name: string;
  instruction: string | null;
  time: string;
  frequency: string;
  weekday: number | null;
  interval_minutes: number | null;
  fire_at: string | null;
  last_fired_at: string | null;
  expired: number;
}

function localDateOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 该 custom 任务在 now 是否应触发（last_fired_at 幂等：触发即占位，失败不重试）。 */
export function isCustomTaskDue(t: CustomTaskRow, now: Date): boolean {
  if (String(t.instruction ?? "").trim() === "") return false;
  const freq = t.frequency || "daily";
  const lastFired = t.last_fired_at ? new Date(t.last_fired_at) : null;
  if (freq === "once") {
    if (Number(t.expired ?? 0) === 1) return false;
    const fa = t.fire_at ? new Date(t.fire_at) : null;
    return fa != null && fa.getTime() <= now.getTime();
  }
  if (freq === "interval") {
    const iv = Number(t.interval_minutes ?? 0);
    if (!(iv > 0)) return false;
    return lastFired == null || now.getTime() - lastFired.getTime() >= iv * 60_000;
  }
  // daily / weekly：今天已过目标时刻且今天未跑过（停机恢复=当日补跑一次；失败不重试靠占位）
  if (lastFired && localDateOf(lastFired) === localDateOf(now)) return false;
  if (freq === "weekly") {
    if (t.weekday == null || Number(t.weekday) !== now.getDay()) return false;
  }
  return hhmm(now) >= String(t.time ?? "99:99");
}

/** 触发即占位：推进 last_fired_at（once 同时置 expired），防重叠 tick 双跑。 */
function claimFire(db: DatabaseSync, t: CustomTaskRow, now: Date): void {
  const ts = now.toISOString();
  if ((t.frequency || "daily") === "once") {
    db.prepare("UPDATE scheduler_tasks SET last_fired_at = ?, expired = 1, updated_at = ? WHERE id = ?").run(ts, ts, t.id);
  } else {
    db.prepare("UPDATE scheduler_tasks SET last_fired_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, t.id);
  }
}

function lastAssistantText(session: any): string {
  const msgs: Array<any> = session?.messages ?? [];
  let text = "";
  for (const m of msgs) {
    if (m?.role !== "assistant") continue;
    const content = Array.isArray(m.content) ? m.content : [];
    const joined = content
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");
    if (joined) text = joined;
  }
  return text;
}

const CUSTOM_TASK_SYSTEM_PROMPT =
  `你是定时任务执行器。家长预先写好任务指令，现在到点由你**无头自动执行**（没有任何人在线回答你的问题）。` +
  `用提供的工具尽力完成指令；结束后用一两句话汇报执行结果（会作为执行摘要记录，家长可见）。\n` +
  `约定：\n` +
  `- create_reminders 创建的提醒会按时刻推送到孩子设备语音播报；同任务下次运行会自动替换上次未播报的提醒（replace 默认 true），按指令批量创建即可。\n` +
  `- 频率选型：「每天/工作日固定播」→ daily/weekly；「未来 N 天各播一次」→ 一次性创建 N 条 once（每条 fireAt=对应日期时刻）；不要把未来多天建成 daily（会每天全部重复播）。\n` +
  `- 天气等查询工具失败时不要编造数据，如实汇报失败原因。\n` +
  `- 需要查/改数据时：本任务能用的数据面只有 kb_query / kb_insert / kb_update（该孩子的 daily 记录、课程表字段、主题进度、标签定义；范围受 kb-tools 白名单约束）。` +
  `要读别的数据（考核逐题、掌握档位、积分流水）本任务没有工具，如实说做不到，不要编造。\n` +
  `- 若指令是**学习情况分析/掌握度归纳**类：用 mastery_todo_list 看待归纳范围 → mastery_plan_context 取素材 → ` +
  `mastery_save_records 写知识点结果 → mastery_save_course_mastery 写课程掌握与教学建议；不要自己手写这些表的 SQL。`;

function buildCustomTaskPrompt(instruction: string, childName: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const timeStr = `${p(now.getHours())}:${p(now.getMinutes())}`;
  return (
    `当前时间：${dateStr} ${timeStr}（${WEEKDAY_ZH[now.getDay()]}）。执行对象孩子：${childName}。\n\n` +
    `【任务指令（家长预设）】\n${instruction}\n\n请现在执行，完成后简要汇报结果。`
  );
}

/** 单次执行（一个任务 × 一个孩子）：无头会话 + 看门狗，结果写 task_runs。
 *  inject.round 供测试注入（替代真实 LLM 会话；返回值即执行摘要）。 */
export async function executeCustomTask(
  deps: { dataDir: string; db: DatabaseSync },
  parentId: string,
  childId: string,
  task: CustomTaskRow,
  now: Date,
  inject?: { round?: (prompt: string) => Promise<string> }
): Promise<void> {
  const startedAt = new Date();
  let status: "ok" | "skip" | "error" = "ok";
  let message = "";
  const instruction = String(task.instruction ?? "").trim();
  if (!instruction) {
    status = "skip";
    message = "指令为空，跳过";
  }
  if (status === "ok" && inject?.round) {
    // 测试路径：不走真实会话，直接把注入函数当执行轮
    try {
      const childRow = deps.db.prepare("SELECT name FROM children WHERE id = ?").get(childId) as { name?: string } | undefined;
      message = (await inject.round(buildCustomTaskPrompt(instruction, childRow?.name ?? childId, now))).slice(0, 300) || "已执行（无汇报文本）";
    } catch (e) {
      status = "error";
      message = String((e as Error).message || e).slice(0, 300);
    }
  }
  if (status === "ok" && !inject?.round) {
    let session: { prompt(p: string): Promise<unknown>; abort?: () => Promise<unknown> | void; dispose(): void } | null = null;
    try {
      const settings = readParentSettings(deps.db, deps.dataDir, parentId);
      const childRow = deps.db.prepare("SELECT name FROM children WHERE id = ?").get(childId) as { name?: string } | undefined;
      const ctx: WorkerTaskCtx = {
        dataDir: deps.dataDir,
        mainDb: deps.db,
        parentId,
        childId,
        auth: settings.auth,
        appSettings: settings.appSettings,
        schedulerConfig: {},
        now,
        point: task.time,
      };
      const customTools = [
        ...createWorkerKbTools(ctx),
        ...createMasteryTools({ dataDir: deps.dataDir, parentId, childId }),
        createWeatherTool(deps.db, parentId),
        createRemindersTool(deps.db, parentId, childId, task.id),
      ];
      // 白名单是「工具名并集」：SDK 的 tools 白名单对自定义工具同样生效，漏登记 = 工具静默不可见。
      const toolNames = customTaskToolNames();
      const sess = await createWorkerEphemeralSession(ctx, CUSTOM_TASK_SYSTEM_PROMPT, toolNames, customTools);
      session = sess;
      const prompt = buildCustomTaskPrompt(instruction, childRow?.name ?? childId, now);
      // 看门狗：整轮超时 → abort → error（不重试当天，last_fired_at 已占位）
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watchdog = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            void (session as { abort?: () => Promise<unknown> | void } | null)?.abort?.();
          } catch {
            /* 忽略 */
          }
          reject(new Error(`执行超过 ${EXEC_TIMEOUT_MS / 60000} 分钟无完成，已中止`));
        }, EXEC_TIMEOUT_MS);
      });
      try {
        await Promise.race([sess.prompt(prompt), watchdog]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      message = lastAssistantText(sess).replace(/\s+/g, " ").trim().slice(0, 300) || "已执行（无汇报文本）";
    } catch (e) {
      status = "error";
      message = String((e as Error).message || e).slice(0, 300);
      console.error(`[worker:custom] task=${task.id} child=${childId} failed:`, message);
    } finally {
      try {
        session?.dispose();
      } catch {
        /* 忽略 */
      }
    }
  }
  try {
    recordTaskRun(deps.db, {
      parentId,
      childId,
      taskId: task.id,
      taskName: task.name,
      taskType: "custom",
      date: formatLocalDate(now),
      point: task.time,
      status,
      message,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[worker:custom] record task_runs failed (${task.id} ${childId}):`, (e as Error).message);
  }
}

/** in-flight 锁：防重叠 tick 并发执行同一 (任务, 孩子)。 */
const inflight = new Set<string>();

/** custom 任务 tick：找出到期任务 → 占位 → 异步逐孩子执行（不阻塞其它任务/孩子）。
 *  inject.exec 供测试注入（替换 executeCustomTask）。 */
export async function runCustomTasksTick(
  deps: { dataDir: string; db: DatabaseSync },
  now: Date = new Date(),
  inject?: { exec?: typeof executeCustomTask }
): Promise<number> {
  const parents = deps.db.prepare("SELECT id FROM parents").all() as Array<{ id: string }>;
  let fired = 0;
  for (const p of parents) {
    let tasks: CustomTaskRow[];
    try {
      tasks = deps.db
        .prepare(
          `SELECT * FROM scheduler_tasks WHERE parent_id = ? AND type = 'custom' AND enabled = 1 AND owner = 'parent'`
        )
        .all(p.id) as unknown as CustomTaskRow[];
    } catch (e) {
      console.error(`[worker:custom] list tasks parent=${p.id} failed:`, (e as Error).message);
      continue;
    }
    for (const t of tasks) {
      if (!isCustomTaskDue(t, now)) continue;
      const assigns = deps.db
        .prepare(
          `SELECT a.child_id FROM scheduler_task_assignments a WHERE a.task_id = ? AND a.enabled = 1`
        )
        .all(t.id) as Array<{ child_id: string }>;
      if (!assigns.length) continue;
      claimFire(deps.db, t, now);
      fired++;
      for (const a of assigns) {
        const key = `${t.id}:${a.child_id}`;
        if (inflight.has(key)) continue;
        inflight.add(key);
        const exec = inject?.exec ?? executeCustomTask;
        // 异步执行不阻塞 tick（issue 定稿）；完成/失败都写 task_runs
        void exec(deps, p.id, a.child_id, t, new Date()).finally(() => inflight.delete(key));
      }
    }
  }
  return fired;
}
