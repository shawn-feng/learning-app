/**
 * ISSUE-116（2026-09-19）：自定义定时任务——自然语言指令到点让 agent 无头执行。
 * ISSUE-182（2026-10-15）v2：执行上下文从「收窄白名单任务执行器」改为**分配 agent 的默认上下文 + 全量工具**。
 *
 * 调度：scheduler_tasks.type='custom' + instruction（自然语言）+ frequency/time（复用四种频率）。
 * - 触发判定（沿 last_fired_at 幂等语义）：daily/weekly=「今天(且周几)已过目标时刻且今天未跑过」；
 *   once=fire_at 到点且未 expired；interval=距上次触发 ≥ interval_minutes。**daily/weekly 不用 5 分钟桶**
 *   ——到点后任意 tick（含停机恢复）当日首次命中即补跑一次；执行失败不重试（last_fired_at 已推进，次日正常）。
 * - 执行（异步不阻塞 tick）：置 last_fired_at 占位 → 按分配目标跑独立无头 ephemeral 会话（in-memory，
 *   不进孩子/家长对话 UI）：
 *   · 分配**孩子** → 每孩子一轮：孩子 agent 基底提示词（buildServerChildPrompt，与交互会话同参）
 *     + 全量孩子工具（buildChildAgentToolset，page_* 不装配）+ 任务特供三件（weather/reminders/mastery）；
 *   · 分配**家长** → 整任务一轮：家长 agent 基底提示词（buildServerParentPrompt）+ 家长全量工具
 *     （buildParentAgentToolset，场景守卫随 compactParentTools 生效）。
 *   看门狗：孩子 5 分钟 / 家长 11 分钟（家长任务可能含 parent_build_material 类长工具，ISSUE-146 口径；
 *   超时 abort，task_runs=error）→ agent 末轮文本作为执行摘要写 task_runs（ok/skip/error）。
 *   连续失败 ≥2 次推家长提醒（task-alerts.ts）。
 * - 边界（issue 定稿）：owner 仅 parent；产物（提醒/展示/报表）可见、过程不进对话 UI；
 *   in-flight 内存锁防两个 tick 并发跑同一 (任务, 目标)。**仅 custom 类型走本文件**——recording 等
 *   确定流程任务仍走各自 WorkerTask 的专用提示词与白名单，不受 v2 影响。
 */
import { nowLocalIso, toLocalIso } from "../util/time.js";
import type { DatabaseSync } from "node:sqlite";
import { createCorePaths } from "@pi/agent-core";
import { readParentSettings } from "./scheduler.js";
import { createWorkerEphemeralSession, hhmm, type WorkerTaskCtx } from "./tasks.js";
import { formatLocalDate } from "./kb-tools.js";
import {
  CUSTOM_TASK_TOOL_NAMES,
  createRemindersTool,
  createWeatherTool,
  WEEKDAY_ZH,
} from "./custom-task-tools.js";
// ISSUE-182：孩子/家长 agent 的「默认上下文」装配真源在各自 registry（与交互会话共用同一份）。
// 注意 session-registry/parent-registry 静态引用 worker/scheduler（readParentSettings），而 scheduler
// 又引用本文件 → 静态 import 会成环，**执行时 dynamic import**（与 tasks.ts 的 resetSession 同法）。
import { getAgentPrompt } from "../db/agents.js";
import { buildServerChildPrompt } from "../agent/prompt.js";
import { buildChildSelfBlock } from "../agent/registry-prompt.js";
import { AgentStreamHub, agentStreamHub } from "../agent/stream-hub.js";
import { createMasteryTools, MASTERY_TOOL_NAMES } from "./mastery-tools.js";
import { recordTaskRun } from "../db/task-runs.js";
import { notifyCustomTaskFailure, type SchedulerAlertPublish } from "./task-alerts.js";

// 看门狗（F3）：孩子任务 5 分钟；家长任务 11 分钟（对齐 ISSUE-146 长工具口径）
const CHILD_EXEC_TIMEOUT_MS = 5 * 60_000;
const PARENT_EXEC_TIMEOUT_MS = 11 * 60_000;

/** 自定义任务暴露的工具名**并集**：SDK 的 tools 白名单对自定义工具同样生效，漏登记 = 工具静默不可见。 */
export function customTaskToolNames(): string[] {
  return Array.from(new Set([...CUSTOM_TASK_TOOL_NAMES, ...MASTERY_TOOL_NAMES]));
}

/** 执行目标（ISSUE-182 F2）：孩子（每孩子独立一轮）| 家长（整任务一轮，家长 agent 上下文）。 */
export type CustomTaskTarget = { kind: "child"; childId: string } | { kind: "parent" };

export function execTimeoutMs(target: CustomTaskTarget): number {
  return target.kind === "parent" ? PARENT_EXEC_TIMEOUT_MS : CHILD_EXEC_TIMEOUT_MS;
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
  const ts = toLocalIso(now);
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

/**
 * 任务附加段（F6）：拼在 agent 基底提示词**之后**——基底给「默认上下文」（身份/数据规则/铁律），
 * 本段给「任务态」约定：无头一次性执行、摘要口径、产物可见性、铁律不放松。
 */
const CHILD_TASK_ADDENDUM =
  `\n\n## 本次是「定时任务无头执行」（到点自动运行，不是和孩子对话）\n` +
  `- 现场没有人回答你的问题，用上面给出的工具尽力完成指令；做不到就如实汇报，不要编造。\n` +
  `- 结束后用一两句话汇报执行结果（会作为执行摘要记录，家长可见）。\n` +
  `- 产物照常可见：display_content 在孩子不在线时会落库，孩子下次打开就能看到，放心按指令产出；` +
  `create_reminders 创建的提醒到点推送到孩子设备语音播报。\n` +
  `- create_reminders 约定：同任务下次运行会自动替换上次未播报的提醒（replace 默认 true），按指令批量创建即可；` +
  `频率选型：「每天/工作日固定播」→ daily/weekly；「未来 N 天各播一次」→ 一次性创建 N 条 once（每条 fireAt=对应日期时刻）；` +
  `不要把未来多天建成 daily（会每天全部重复播）。\n` +
  `- 若指令是**学习情况分析/掌握度归纳**类：用 mastery_todo_list 看待归纳范围 → mastery_plan_context 取素材 → ` +
  `mastery_save_records 写知识点结果 → mastery_save_course_mastery 写课程掌握与教学建议；不要自己手写这些表的 SQL。\n` +
  `- 查询类工具失败时不要编造数据，如实汇报失败原因。**"任务态"不放松铁律**：积分/完成态等只读口径照旧，` +
  `数据读写一律走工具，不直接改库、不臆造查询结果。`;

const PARENT_TASK_ADDENDUM =
  `\n\n## 本次是「定时任务无头执行」（到点自动运行，不是与家长在线对话）\n` +
  `- 现场没有人回答你的问题，用上面给出的工具尽力完成指令；做不到就如实汇报，不要编造。\n` +
  `- 结束后用一两句话汇报执行结果（会作为执行摘要记录，家长可见）。\n` +
  `- 动手前先找准场景并 load_skill（场景守卫：先加载该场景，其工具才肯执行）；一件事跨场景就连着加载。\n` +
  `- 指令若要产出报表/汇总，用 parent_display_report 推到家长端「📊 报表」区（离线也能看回执）。`;

/** user turn：时间 + 执行对象 + 家长预设指令。 */
function buildTaskPrompt(
  instruction: string,
  target: CustomTaskTarget,
  childName: string | null,
  now: Date
): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const timeStr = `${p(now.getHours())}:${p(now.getMinutes())}`;
  const who =
    target.kind === "parent"
      ? "家长（由家长助手本人执行，无孩子上下文）"
      : `孩子：${childName ?? target.childId}`;
  return (
    `当前时间：${dateStr} ${timeStr}（${WEEKDAY_ZH[now.getDay()]}）。执行对象：${who}。\n\n` +
    `【任务指令（家长预设）】\n${instruction}\n\n请现在执行，完成后简要汇报结果。`
  );
}

function localTimeOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 默认发布器：走进程内 agentStreamHub（家长流）。测试经 inject.publish 注入桩或置 null。 */
const defaultAlertPublish: SchedulerAlertPublish = (key, type, data) => {
  agentStreamHub.publish(key, type, data);
};

/** 单次执行（一个任务 × 一个目标）：无头会话 + 看门狗，结果写 task_runs。
 *  inject.round 供测试注入（替代真实 LLM 会话；返回值即执行摘要）；
 *  inject.publish 供测试注入失败通知的发布器（缺省走 agentStreamHub）。 */
export async function executeCustomTask(
  deps: { dataDir: string; db: DatabaseSync },
  parentId: string,
  target: CustomTaskTarget,
  task: CustomTaskRow,
  now: Date,
  inject?: { round?: (prompt: string) => Promise<string>; publish?: SchedulerAlertPublish | null }
): Promise<void> {
  const startedAt = new Date();
  let status: "ok" | "skip" | "error" = "ok";
  let message = "";
  const childId = target.kind === "child" ? target.childId : "parent";
  const instruction = String(task.instruction ?? "").trim();
  if (!instruction) {
    status = "skip";
    message = "指令为空，跳过";
  }
  const childRowOf = (id: string) =>
    deps.db.prepare("SELECT name FROM children WHERE id = ?").get(id) as { name?: string } | undefined;
  if (status === "ok" && inject?.round) {
    // 测试路径：不走真实会话，直接把注入函数当执行轮
    try {
      const who = target.kind === "child" ? childRowOf(childId)?.name ?? childId : null;
      message = (await inject.round(buildTaskPrompt(instruction, target, who, now))).slice(0, 300) || "已执行（无汇报文本）";
    } catch (e) {
      status = "error";
      message = String((e as Error).message || e).slice(0, 300);
    }
  }
  if (status === "ok" && !inject?.round) {
    let session: { prompt(p: string): Promise<unknown>; abort?: () => Promise<unknown> | void; dispose(): void } | null = null;
    try {
      const settings = readParentSettings(deps.db, deps.dataDir, parentId);
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
      const timeoutMs = execTimeoutMs(target);
      let systemPrompt: string;
      let toolNames: string[];
      let customTools: any[];
      let cwd: string;
      if (target.kind === "child") {
        // 孩子任务：孩子 agent 默认上下文（基底提示词 + 全量工具，page_* 不装配）+ 任务特供三件
        const { buildChildAgentToolset } = await import("../agent/session-registry.js");
        const childRow = childRowOf(childId);
        const toolset = buildChildAgentToolset({ db: deps.db, dataDir: deps.dataDir }, parentId, childId, {
          includePageTools: false,
        });
        const taskTools = [
          createWeatherTool(deps.db, parentId),
          createRemindersTool(deps.db, parentId, childId, task.id),
          ...createMasteryTools({ dataDir: deps.dataDir, parentId, childId }),
        ];
        systemPrompt = buildServerChildPrompt({
          paths: createCorePaths(deps.dataDir),
          parentId,
          childId,
          childName: childRow?.name ?? childId,
          today: localDateOf(now),
          now: localTimeOf(now),
          agentRules: getAgentPrompt(deps.dataDir, "child", childId) ?? "",
          dbTablesBlock: buildChildSelfBlock(deps.dataDir, parentId, childId),
        }) + CHILD_TASK_ADDENDUM;
        // 白名单是「工具名并集」：SDK 的 tools 白名单对自定义工具同样生效，漏登记 = 工具静默不可见。
        toolNames = Array.from(new Set([...toolset.toolNames, ...customTaskToolNames()]));
        customTools = [...toolset.customTools, ...taskTools];
        cwd = toolset.workspace;
      } else {
        // 家长任务：家长 agent 默认上下文（整任务一轮；场景守卫随 compactParentTools 生效）
        const { buildParentAgentToolset, buildServerParentPrompt } = await import("../agent/parent-registry.js");
        const toolset = buildParentAgentToolset(
          { db: deps.db, dataDir: deps.dataDir, auth: settings.auth, appSettings: settings.appSettings },
          parentId,
          { streamKey: AgentStreamHub.key(parentId, "parent") }
        );
        systemPrompt =
          buildServerParentPrompt({
            parentId,
            workspace: toolset.workspace,
            today: localDateOf(now),
            customNote: getAgentPrompt(deps.dataDir, "parent", parentId) ?? "",
          }) + PARENT_TASK_ADDENDUM;
        toolNames = toolset.toolNames;
        customTools = toolset.customTools;
        cwd = toolset.scratch;
      }
      const sess = await createWorkerEphemeralSession(ctx, systemPrompt, toolNames, customTools, { cwd });
      session = sess;
      const who = target.kind === "child" ? childRowOf(childId)?.name ?? childId : null;
      const prompt = buildTaskPrompt(instruction, target, who, now);
      // 看门狗：整轮超时 → abort → error（不重试当天，last_fired_at 已占位）
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watchdog = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            void (session as { abort?: () => Promise<unknown> | void } | null)?.abort?.();
          } catch {
            /* 忽略 */
          }
          reject(new Error(`执行超过 ${timeoutMs / 60000} 分钟无完成，已中止`));
        }, timeoutMs);
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
      console.error(`[worker:custom] task=${task.id} target=${target.kind}:${childId} failed:`, message);
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
      // F2 约定：家长任务的 run child_id 列存家长 id（ctx.childId 才是 "parent" 哨兵）
      childId: target.kind === "child" ? target.childId : parentId,
      targetType: target.kind === "parent" ? "parent" : "child",
      taskId: task.id,
      taskName: task.name,
      taskType: "custom",
      date: formatLocalDate(now),
      point: task.time,
      status,
      message,
      startedAt: toLocalIso(startedAt),
      finishedAt: nowLocalIso(),
    });
  } catch (e) {
    console.error(`[worker:custom] record task_runs failed (${task.id} ${childId}):`, (e as Error).message);
  }
  // F4：连续失败 ≥2 次推家长提醒（ok/skip 恢复即清零；inject 路径也走，便于测试）
  try {
    const publish = inject && "publish" in inject ? inject.publish : defaultAlertPublish;
    notifyCustomTaskFailure(deps.db, publish, parentId, task, status, message);
  } catch (e) {
    console.error(`[worker:custom] notify failure alert failed (${task.id}):`, (e as Error).message);
  }
}

/** in-flight 锁：防重叠 tick 并发执行同一 (任务, 目标)。 */
const inflight = new Set<string>();

/** custom 任务 tick：找出到期任务 → 占位 → 异步按目标执行（不阻塞其它任务/孩子）。
 *  家长分配（ISSUE-182 F2）整任务只跑一轮（无 per-child 展开）；孩子分配照旧逐孩子。
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
          `SELECT child_id, target_type FROM scheduler_task_assignments a WHERE a.task_id = ? AND a.enabled = 1`
        )
        .all(t.id) as Array<{ child_id: string; target_type?: string }>;
      if (!assigns.length) continue;
      claimFire(deps.db, t, now);
      fired++;
      const exec = inject?.exec ?? executeCustomTask;
      const launch = (target: CustomTaskTarget, key: string) => {
        if (inflight.has(key)) return;
        inflight.add(key);
        // 异步执行不阻塞 tick（issue 定稿）；完成/失败都写 task_runs
        void exec(deps, p.id, target, t, new Date()).finally(() => inflight.delete(key));
      };
      for (const a of assigns) {
        if (a.target_type === "parent") continue; // 家长行在下面整任务跑一轮
        launch({ kind: "child", childId: a.child_id }, `${t.id}:${a.child_id}`);
      }
      if (assigns.some((a) => a.target_type === "parent")) {
        launch({ kind: "parent" }, `${t.id}:parent`);
      }
    }
  }
  return fired;
}
