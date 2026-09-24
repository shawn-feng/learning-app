/**
 * 服务端孩子 agent 会话注册表（P1 核心）：
 * 把「一个孩子的交互会话」在服务端跑起来——持久落盘、工具装配、事件流式发布。
 *
 * 会话形态：packages/agent-core 的 createCoreSession（sessionsDir 落盘 = 持久会话），
 * 会话文件放 `<dataDir>/agent-sessions/<parentId>/<childId>/`（与客户端镜像目录分开，避免互相污染）。
 * 多端：同一 (parentId, childId) 在进程内复用同一个 session 实例，事件经 stream-hub 广播给全部订阅者。
 * 并发：同一会话同一时刻只允许一次 prompt（`busy`），否则两个设备的输入会交错进同一上下文。
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
// ISSUE-134：统一还原字符串化参数（内含 SDK defineTool）
import { defineTool } from "./tool-kit.js";
import {
  createCorePaths,
  createCoreSession,
  getWorkerRuntime,
  pickWorkerModel,
  type CoreSessionDeps,
  type CorePaths,
} from "@pi/agent-core";
import { createWorkerKbTools } from "../worker/kb-tools.js";
import { CHILD_DB_TOOL_NAMES, createChildDbTools } from "./child-db-tools.js";
import { CHILD_REPORT_TOOL_NAMES, createChildReportTools } from "./child-report-tools.js";
import { readParentSettings } from "../worker/scheduler.js";
import { getAgentPrompt } from "../db/agents.js";
import { openKb } from "../db/kb.js";
import { clearDisplayLog } from "../db/displays.js";
import { openParentLib } from "../db/parent-lib.js";
import { buildChildSelfBlock } from "./registry-prompt.js";
import { createServerFsTools, SERVER_FS_TOOL_NAMES } from "./fs-tools.js";
import { createSummarizeConversationTool } from "./kb-summary-tool.js";
import {
  createParentContentTool,
  createChildStudyPlanCreateTool,
  createChildStudyPlanListTool,
  createChildStudyPlanUpdateTool,
  createChildExamPlanCreateTool,
  createChildExamPlanListTool,
  createChildExamPlanUpdateTool,
  createChildLifePlanCreateTool,
  createChildLifePlanListTool,
  createChildLifePlanUpdateTool,
} from "./plan-tools.js";
import { createDisplayContentTool, DISPLAY_TOOL_NAME } from "./display-tool.js";
import { PAGE_TOOL_NAMES, createPageTools } from "./page-tools.js";
import { createProgrammingTool } from "./programming-agent.js";
import { getCaps } from "./caps.js";
import { buildServerChildPrompt, buildServerScenePrompt } from "./prompt.js";
import { friendlyModelError, syncSessionModel } from "./model-sync.js";
import { agentStreamHub, AgentStreamHub } from "./stream-hub.js";
import { learningGuardExtension as guardExtension } from "@pi/agent-core";

const CORE_SESSION_DEPS: CoreSessionDeps = {
  createAgentSession,
  ResourceLoader: DefaultResourceLoader,
  SessionManager: SessionManager as unknown as CoreSessionDeps["SessionManager"],
};

export interface AgentSessionDeps {
  db: DatabaseSync;
  dataDir: string;
}

interface Entry {
  session: any;
  /** 正在处理一轮 prompt（并发守卫） */
  busy: boolean;
  paths: CorePaths;
}

const entries = new Map<string, Entry>();

/** 待重建标记：reset 后置位，下次 ensureEntry 时 newSession()（丢弃旧会话文件的历史）。 */
const resetMarks = new Set<string>();

/** 会话键：一个孩子可有主/场景/课程多条会话，各自独立上下文与落盘目录。 */
function keyOf(parentId: string, childId: string, kind: ChildSessionKind = "main"): string {
  return `${parentId}:${childId}:${kind}`;
}

/** 流（SSE）键：仍按孩子聚合——客户端订阅一个孩子的流即可收到其所有会话的事件（与客户端旧行为一致）。 */
function streamKeyOf(parentId: string, childId: string): string {
  return AgentStreamHub.key(parentId, childId);
}

function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localTime(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 极小 get_date 工具：模型需要「今天是几号」时不必靠猜（时间由服务端权威给出）。 */
function createGetDateTool() {
  return defineTool({
    name: "get_date",
    label: "获取当前日期时间",
    description: "返回服务端当前日期与时间（YYYY-MM-DD HH:mm）。用于判断'今天''现在'这类时间指代。",
    parameters: Type.Object({}),
    execute: async () => {
      const d = new Date();
      return {
        content: [{ type: "text" as const, text: `${localDate(d)} ${localTime(d)}` }],
        details: {},
      };
    },
  });
}

function childName(db: DatabaseSync, childId: string): string {
  try {
    const row = db.prepare("SELECT name FROM children WHERE id = ?").get(childId) as
      | { name?: string }
      | undefined;
    return row?.name?.trim() || "孩子";
  } catch {
    return "孩子";
  }
}

/** 懒创建/复用某孩子的持久会话。 */
/**
 * 会话类型（P3）：主会话 / 场景会话 / 课程会话。
 * 课程会话把该课的教法、考核方法、资料路径注入 prompt，让「这节课怎么上」有据可依；
 * 场景会话只驱动演出（工具表收窄）。三者各自持久落盘，互不污染上下文。
 */
export type ChildSessionKind = "main" | "scene" | `course:${string}`;

/** 会话槽名（用于会话目录/agentDir：把冒号等换成连字符，避免非法路径段）。 */
export function sessionSlot(childId: string, kind: ChildSessionKind): string {
  return `${childId}-${String(kind).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/**
 * 目录下（递归）所有 .jsonl 会话文件里最后一条 user/assistant 消息的时间戳（ms）；
 * 没有任何消息返回 null。条目格式与 SDK 落盘一致（type==="message"、timestamp 为 ISO 字符串），
 * 逻辑复用旧客户端 pi-session 的同名实现（ISSUE-100：每日新建会话的日期裁决真源在服务端）。
 */
export function lastMessageTimestampInDir(sessionsDir: string): number | null {
  if (!fs.existsSync(sessionsDir)) return null;
  const files: string[] = [];
  const walk = (dir: string) => {
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(sessionsDir);
  let maxTs: number | null = null;
  for (const f of files) {
    let lines: string[];
    try {
      lines = fs.readFileSync(f, "utf-8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        entry?.type === "message" &&
        entry.message &&
        (entry.message.role === "user" || entry.message.role === "assistant")
      ) {
        const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        if (Number.isFinite(ts) && (maxTs === null || ts > maxTs)) maxTs = ts;
      }
    }
  }
  return maxTs;
}

/**
 * 会话目录的最后一条消息是否落在今天（本地时区）。无任何历史消息返回 true（无需重置——
 * continueRecent 对空目录本身就是干净会话）。
 */
export function isLastMessageToday(sessionsDir: string): boolean {
  const ts = lastMessageTimestampInDir(sessionsDir);
  if (ts === null) return true;
  return new Date(ts).toDateString() === new Date().toDateString();
}

/**
 * 按设备能力 + 会话类型计算工具白名单（纯函数，便于测试与调试）。
 * 资料面板类工具（page_* / scene_command）只在设备声明 `material-panel` 时注册——见 caps.ts 的说明。
 */
export function computeChildToolNames(caps: { materialPanel: boolean }, kind: ChildSessionKind = "main"): string[] {
  if (kind === "scene") {
    return ["display_content", ...(caps.materialPanel ? ["scene_command"] : []), "get_date"];
  }
  return [
    ...SERVER_FS_TOOL_NAMES,
    "get_date",
    "parent_content",
    "summarize_conversation",
    DISPLAY_TOOL_NAME,
    "create_html_lesson",
    ...(caps.materialPanel ? PAGE_TOOL_NAMES : []),
    "kb_query",
    "kb_insert",
    "kb_update",
    "child_study_plan_create",
    "child_study_plan_list",
    "child_study_plan_update",
    "child_exam_plan_create",
    "child_exam_plan_list",
    "child_exam_plan_update",
    "child_life_plan_create",
    "child_life_plan_list",
    "child_life_plan_update",
    ...CHILD_REPORT_TOOL_NAMES,
    ...CHILD_DB_TOOL_NAMES,
  ];
}

async function ensureEntry(
  deps: AgentSessionDeps,
  parentId: string,
  childId: string,
  kind: ChildSessionKind = "main"
): Promise<Entry> {
  const key = keyOf(parentId, childId, kind);
  const existing = entries.get(key);
  if (existing) return existing;

  const paths = createCorePaths(deps.dataDir);
  const settings = readParentSettings(deps.db, deps.dataDir, parentId);
  const runtime = await getWorkerRuntime(deps.dataDir, parentId, settings.auth);
  const model = pickWorkerModel(runtime, settings.appSettings);

  const kbTools = createWorkerKbTools({
    dataDir: deps.dataDir,
    mainDb: deps.db,
    parentId,
    childId,
  } as any);
  const workspace = paths.childWorkspaceDir(parentId, childId);
  const fsTools = createServerFsTools(workspace);
  const displayTool = createDisplayContentTool({ dataDir: deps.dataDir, parentId, childId, streamKey: streamKeyOf(parentId, childId), sessionKey: kind });
  const programmingTool = createProgrammingTool({ dataDir: deps.dataDir, db: deps.db, parentId }, { scope: "child", childId });

  // 设备能力协商（P3）：资料面板类工具只在「对端确实有资料面板」时注册。
  // 若一律注册，模型会调用做不到的工具（如手机端无面板 / 无 Electron 面板），调用后只能报错，
  // 不如让它从工具表就知道这台设备做不到，从而改用对话引导。
  const caps = getCaps(streamKeyOf(parentId, childId));
  const pageTools = caps.materialPanel
    ? createPageTools({ db: deps.db, dataDir: deps.dataDir, parentId, childId, streamKey: streamKeyOf(parentId, childId) })
    : null;
  const isScene = kind === "scene";

  const customTools = [
    ...(isScene ? [] : kbTools),
    ...(isScene ? [] : fsTools),
    displayTool,
    ...(isScene ? [] : [programmingTool]),
    ...(isScene
      ? []
      : [
          createParentContentTool({ dataDir: deps.dataDir, parentId, childId }),
          createChildStudyPlanCreateTool({ dataDir: deps.dataDir, parentId, childId }),
          createChildStudyPlanListTool({ dataDir: deps.dataDir, parentId, childId }),
          createChildStudyPlanUpdateTool({ dataDir: deps.dataDir, parentId, childId }),
          createChildExamPlanCreateTool({ dataDir: deps.dataDir, parentId, childId }),
          createChildExamPlanListTool({ dataDir: deps.dataDir, parentId, childId }),
          createChildExamPlanUpdateTool({ dataDir: deps.dataDir, parentId, childId }),
          createChildLifePlanCreateTool({ dataDir: deps.dataDir, parentId, childId }),
          createChildLifePlanListTool({ dataDir: deps.dataDir, parentId, childId }),
          createChildLifePlanUpdateTool({ dataDir: deps.dataDir, parentId, childId }),
          ...createChildReportTools({ dataDir: deps.dataDir, parentId, childId }),
          ...createChildDbTools({ dataDir: deps.dataDir, parentId, childId }),
        ]),
    ...(pageTools
      ? isScene
        ? [pageTools.sceneCommandTool]
        : [pageTools.pageActionTool, pageTools.pageInspectTool, pageTools.sceneCommandTool]
      : []),
    createGetDateTool(),
    ...(isScene ? [] : [createSummarizeConversationTool({ db: deps.db, dataDir: deps.dataDir, parentId, childId })]),
  ];

  const toolNames = computeChildToolNames(caps, kind);

  // AGENTS 用户版本：服务端就是唯一真源（scope=child, ref=childId），直接读库注入，
  // 不再有旧架构「客户端先远程预取到本地缓存、同步回调再读缓存」的时序问题。
  const agentRules = getAgentPrompt(deps.dataDir, "child", childId) ?? "";

  const systemPrompt = isScene
    ? buildServerScenePrompt({ childName: childName(deps.db, childId), today: localDate(), agentRules })
    : buildServerChildPrompt({
        paths,
        parentId,
        childId,
        childName: childName(deps.db, childId),
        today: localDate(),
        now: localTime(),
        agentRules,
        courseBlock: kind.startsWith("course:") ? courseContextBlock(deps, parentId, childId, kind.slice("course:".length)) : "",
        dbTablesBlock: buildChildSelfBlock(deps.dataDir, parentId, childId),
      });

  const slot = sessionSlot(childId, kind);
  const sessionsDir = paths.agentSessionsDir(parentId, slot);
  const handle = await createCoreSession({
    deps: CORE_SESSION_DEPS,
    runtime,
    model,
    cwd: workspace,
    agentDir: `${workspace}/.pi/${slot}`,
    systemPrompt,
    toolNames,
    customTools,
    sessionsDir,
    // reset 后首次重建：newSession() 起一个干净会话（丢弃旧文件历史）。
    // 日期保险（ISSUE-100）：即便客户端漏调 /open、只在发消息时触发 ensureEntry
    // （如服务端重启后内存实例丢失），也不会继续昨天的上下文。
    shouldAutoNewSession: () => resetMarks.has(key) || !isLastMessageToday(sessionsDir),
    // 会话级红线（路径越界拦截 + 每轮注入日期）与客户端同一份实现
    extensionFactories: [guardExtension],
  });
  // ISSUE-113：新会话（/reset、跨天自动新建、或首次进入且旧会话非今天）→ 清该会话的展示登记，
  // 左侧资料列表随会话走（重进保留、重置清空）
  if (resetMarks.has(key) || !isLastMessageToday(sessionsDir)) {
    try {
      clearDisplayLog(deps.dataDir, parentId, childId, kind);
    } catch {
      /* 清理失败不影响会话建立 */
    }
  }
  resetMarks.delete(key);

  const entry: Entry = { session: handle.session, busy: false, paths };
  attachStream(entry, streamKeyOf(parentId, childId));
  entries.set(key, entry);
  console.log(
    `[agent] 已就绪会话 ${key}（持久：${paths.agentSessionsDir(parentId, slot)}；caps=${caps.raw || "none"}；工具 ${toolNames.length} 项；AGENTS ${agentRules ? "用户版" : "默认"}）`
  );
  return entry;
}

/**
 * 课程会话的上下文块：该课的教法/考核方法/资料路径取自家长库真源，
 * 学习状态（⬜/✅/最近学习）取自孩子库（2026-09-18 库域分工后两域分离）。
 * 拿不到课程记录时不编造，显式说明——避免模型凭课程名猜教学内容。
 */
function courseContextBlock(deps: AgentSessionDeps, parentId: string, childId: string, courseTitle: string): string {
  try {
    // 孩子库：该课的学习进度（行不存在 = 未分配该课）
    let statusLine = "";
    try {
      const kb = openKb(deps.dataDir, parentId, childId);
      try {
        const c = kb
          .prepare("SELECT topic, status, last_review FROM courses WHERE title = ? LIMIT 1")
          .get(courseTitle) as { topic?: string; status?: string; last_review?: string } | undefined;
        if (c) statusLine = `- 状态：${c.status ?? "-"}｜最近学习：${c.last_review || "-"}｜主题：${c.topic ?? "-"}`;
      } finally {
        kb.close();
      }
    } catch {
      /* 孩子库读不到不阻塞教学上下文 */
    }
    const lib = openParentLib(deps.dataDir, parentId);
    try {
      const row = lib
        .prepare(
          `SELECT topic, lesson_method, teaching_copy, assess_rubric, html_path
           FROM courses WHERE title = ? LIMIT 1`
        )
        .get(courseTitle) as
        | { topic?: string; lesson_method?: string; teaching_copy?: string; assess_rubric?: string; html_path?: string }
        | undefined;
      if (!row) return `本课「${courseTitle}」在家长库中未找到（可能有名字差异），请先与家长确认课程名再开始。`;
      const lines = [
        `- 课程：${courseTitle}（主题 ${row.topic ?? "-"}）`,
        statusLine,
        row.html_path ? `- 已有资料：${row.html_path}（可用 display_content 展示）` : "",
        row.lesson_method ? `- 教法（怎么上）：${row.lesson_method}` : "",
        row.teaching_copy ? `- 教学文案要点：${row.teaching_copy.slice(0, 800)}` : "",
        row.assess_rubric ? `- 考核要点：${row.assess_rubric.slice(0, 500)}` : "",
      ].filter(Boolean);
      return lines.join("\n");
    } finally {
      lib.close();
    }
  } catch (err) {
    return `（读取课程资料失败：${(err as Error).message}）`;
  }
}

/** 把 SDK 事件映射为流事件（与客户端 attachSessionEvents 的事件面保持一致）。 */
function attachStream(entry: Entry, key: string): void {
  entry.session.subscribe((event: any) => {
    markSessionActivity(key);
    switch (event?.type) {
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame?.type === "text_delta") {
          agentStreamHub.publish(key, "text_delta", { delta: ame.delta });
        } else if (ame?.type === "thinking_delta") {
          agentStreamHub.publish(key, "thinking_delta", { delta: ame.delta });
        }
        break;
      }
      case "tool_execution_start":
        agentStreamHub.publish(key, "tool_start", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      case "tool_execution_end":
        agentStreamHub.publish(key, "tool_end", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError === true,
          result: event.result,
        });
        break;
      case "message_end":
        if (event.message?.role === "assistant") {
          // ISSUE-126：模型 API 失败（429 额度/401 key/网络错误）时 SDK 不 emit error 事件，
          // 只记 stopReason:"error" + errorMessage 的空 assistant 消息。转成 error 事件告知前端，
          // 否则客户端只会收到 turn_end，工作气泡永远卡「等待模型返回」。
          if (event.message.stopReason === "error") {
            const raw = String(event.message.errorMessage || event.message.error || "模型调用失败");
            agentStreamHub.publish(key, "error", { message: friendlyModelError(raw) });
            break;
          }
          agentStreamHub.publish(key, "message_end", { message: event.message });
        }
        break;
      case "agent_end":
        agentStreamHub.publish(key, "agent_end", {});
        break;
      case "error":
        agentStreamHub.publish(key, "error", {
          message: String(event.error || event.message || "未知错误"),
        });
        break;
      default:
        break;
    }
  });
}

export interface SubmitResult {
  ok: boolean;
  error?: string;
}

/**
 * 提交一轮孩子输入并等待本轮结束（流式增量经 stream-hub 推送）。
 * - 页面事件（若有）按客户端既有语义附在本轮消息前（ISSUE-015）；
 * - 会话忙时直接返回 busy，由前端提示「上一轮还在回答」，不排队（避免上下文交错）。
 */
// —— 挂死看门狗（2026-09-18，与 parent-registry 同一套参数）：任何事件刷新活跃时间，
// 超过 IDLE 无事件判定挂死 → abort + error 事件告知前端。
const SESSION_IDLE_TIMEOUT_MS = 240_000;
const sessionActivity = new Map<string, number>();
function markSessionActivity(key: string): void {
  sessionActivity.set(key, Date.now());
}

export async function submitChildPrompt(
  deps: AgentSessionDeps,
  parentId: string,
  childId: string,
  text: string,
  opts: { pendingPageEvents?: string; kind?: ChildSessionKind } = {}
): Promise<SubmitResult> {
  const kind = opts.kind ?? "main";
  const entry = await ensureEntry(deps, parentId, childId, kind);
  if (entry.busy) {
    return { ok: false, error: "busy：上一轮还在回答，请稍候" };
  }
  // ISSUE-126：设置里换了默认模型 → 对现有会话原地热切换（历史保留，不销毁重建）；
  // 切换失败（典型：新 provider 没配 key）→ 本轮不发送，把原因明确返回给前端。
  const synced = await syncSessionModel(deps, parentId, entry.session, "agent");
  if (!synced.ok) return { ok: false, error: synced.error };
  const key = keyOf(parentId, childId, kind);
  const streamKey = streamKeyOf(parentId, childId);
  const evtPrefix = opts.pendingPageEvents ? `[页面事件] ${opts.pendingPageEvents}\n` : "";
  const prompt = `${evtPrefix}${text ?? ""}`.trim();
  if (!prompt) return { ok: false, error: "空消息" };

  entry.busy = true;
  markSessionActivity(key);
  agentStreamHub.publish(streamKey, "user_message", { text: prompt, pageEvents: opts.pendingPageEvents ?? "", session: kind });
  // 挂死看门狗：模型 API 偶发挂起时 prompt 永不返回也不报错 → busy 永久占用。
  // 超过 IDLE 无任何事件即 abort + error 事件告知前端。
  const watchdogActivity = { fired: false };
  const watchdog = setInterval(() => {
    if (watchdogActivity.fired) return;
    const last = sessionActivity.get(key) ?? Date.now();
    if (Date.now() - last <= SESSION_IDLE_TIMEOUT_MS) return;
    watchdogActivity.fired = true;
    clearInterval(watchdog);
    console.error(`[agent] 会话 ${key} 超过 ${SESSION_IDLE_TIMEOUT_MS / 1000}s 无任何事件，判定挂死，中止本轮`);
    agentStreamHub.publish(streamKey, "error", {
      message: `模型服务超过 ${SESSION_IDLE_TIMEOUT_MS / 1000} 秒无响应，已自动中止本轮。请重试；多次出现请检查模型服务。`,
      session: kind,
    });
    void entry.session.abort().catch(() => undefined);
  }, 5000);
  // 异步执行整轮（提交即返回）：一轮 agent 可能带长工具链（summarize_conversation 实测 3 分钟+），
  // 若 POST 同步等整轮结束，客户端 2 分钟超时会把**成功轮**误报成「无法连接服务端」。
  // 结束/错误统一经 SSE（turn_end / error）推送——渲染层的忙碌态本就由 pi:reply_end 驱动。
  void (async () => {
    try {
      await entry.session.prompt(prompt);
    } catch (err) {
      if (!watchdogActivity.fired) {
        const message = (err as Error)?.message ?? String(err);
        agentStreamHub.publish(streamKey, "error", { message, session: kind });
      }
    } finally {
      clearInterval(watchdog);
      entry.busy = false;
      agentStreamHub.publish(streamKey, "turn_end", { session: kind });
    }
  })();
  return { ok: true };
}

/** 某孩子是否已在服务端建过会话（供测试与调试） */
export function hasSession(parentId: string, childId: string, kind: ChildSessionKind = "main"): boolean {
  return entries.has(keyOf(parentId, childId, kind));
}

/**
 * 中止某孩子会话的当前一轮（ISSUE-095）：调 SDK 的 session.abort()（中止当前操作并等待 agent idle）。
 * kind 省略时中止该孩子**全部**会话中正在跑的一轮——前端「停止」按钮只知道 childId，
 * 不区分 main/scene/course，全量中止才不会漏（未在跑的会话为 no-op，跳过即可）。
 * 中止后 submitChildPrompt 的 finally 会清 busy 并经 SSE 推 turn_end，客户端忙碌态正常解禁。
 * 返回实际发生中止的会话数（0 = 没有在跑的一轮）。
 */
export async function abortSession(parentId: string, childId: string, kind?: ChildSessionKind): Promise<number> {
  const targets: Array<[string, Entry]> = [];
  if (kind) {
    const key = keyOf(parentId, childId, kind);
    const entry = entries.get(key);
    if (entry) targets.push([key, entry]);
  } else {
    const prefix = `${parentId}:${childId}:`;
    for (const [key, entry] of [...entries]) {
      if (key.startsWith(prefix)) targets.push([key, entry]);
    }
  }
  let aborted = 0;
  for (const [key, entry] of targets) {
    if (!entry.busy) continue;
    try {
      await entry.session.abort();
      aborted++;
      console.log(`[agent] 已中止会话 ${key} 的当前一轮`);
    } catch (err) {
      console.error(`[agent] 中止会话 ${key} 失败:`, (err as Error).message);
    }
  }
  return aborted;
}

/**
 * 重置某孩子的会话：释放内存实例并置「待重建」标记——下次对话 newSession() 起干净会话
 * （旧会话文件保留为历史，但不再被 continueRecent 选中）。不传 kind 时重置该孩子全部会话。
 */
export function resetSession(parentId: string, childId: string, kind?: ChildSessionKind): void {
  if (kind) {
    const key = keyOf(parentId, childId, kind);
    disposeSession(parentId, childId, kind);
    resetMarks.add(key);
    return;
  }
  const prefix = `${parentId}:${childId}:`;
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) {
      disposeSession(parentId, childId, key.slice(prefix.length) as ChildSessionKind);
      resetMarks.add(key);
    }
  }
}

/** 读取某孩子会话的历史消息（原始 shape 供客户端映射；会话未建立时返回空数组）。 */
export function getChildSessionHistory(parentId: string, childId: string, kind: ChildSessionKind = "main"): Array<{ role: string; content: unknown[]; timestamp?: number; toolCallId?: string; isError?: boolean }> {
  const entry = entries.get(keyOf(parentId, childId, kind));
  if (!entry?.session?.messages) return [];
  return entry.session.messages.map((m: any) => ({
    role: String(m?.role ?? ""),
    content: m?.content ?? [],
    ...(m?.timestamp != null ? { timestamp: m.timestamp } : {}),
    ...(m?.toolCallId != null ? { toolCallId: String(m.toolCallId) } : {}),
    ...(m?.isError != null ? { isError: !!m.isError } : {}),
  }));
}

/**
 * 打开孩子会话（ISSUE-100 F1 冷路径）：进会话那一刻做「跨天裁决」——
 * 落盘会话的最后一条消息不是今天 → 先 resetSession（释放内存实例 + 置 resetMarks），
 * 再 ensureEntry（resetMarks 命中 → newSession() 起干净会话；未命中 → continueRecent 载入当天既有历史），
 * 最后返回裁决后的历史消息。
 *
 * UX 裁定（2026-09-14 用户拍板）：重置必须在「进会话」时完成，**不能**放在 submitChildPrompt——
 * 否则用户先看到昨天的消息、一发消息会话突然清空，会被误认为「会话丢了」。
 * 客户端进会话加载历史即调本入口（/agent/:childId/open），拿到的一定是当天会话。
 */
export async function openChildSession(
  deps: AgentSessionDeps,
  parentId: string,
  childId: string,
  kind: ChildSessionKind = "main"
): Promise<ReturnType<typeof getChildSessionHistory>> {
  const paths = createCorePaths(deps.dataDir);
  const sessionsDir = paths.agentSessionsDir(parentId, sessionSlot(childId, kind));
  const key = keyOf(parentId, childId, kind);
  if (!resetMarks.has(key) && !isLastMessageToday(sessionsDir)) {
    console.log(`[agent] 会话 ${key} 最后一条消息非今天 → 每日自动新建会话（冷路径裁决）`);
    resetSession(parentId, childId, kind);
  }
  await ensureEntry(deps, parentId, childId, kind);
  return getChildSessionHistory(parentId, childId, kind);
}

/**
 * 释放某孩子的会话（caps 变化或测试清理用）。
 * 为什么要能释放：设备能力是**创建会话时**决定工具表的，手机端后连上报 material-panel 时，
 * 旧会话的工具表里没有 page_*，必须重建才能拿到——不重建会出现「同一会话有时能操作页面有时不能」。
 * 不传 kind 时释放该孩子的**全部会话**（caps 变化影响所有会话）。
 */
export function disposeSession(parentId: string, childId: string, kind?: ChildSessionKind): void {
  if (kind) {
    const key = keyOf(parentId, childId, kind);
    const entry = entries.get(key);
    if (!entry) return;
    try {
      entry.session.dispose?.();
    } catch {
      /* 忽略 */
    }
    entries.delete(key);
    console.log(`[agent] 已释放会话 ${key}（下次对话按最新能力重建）`);
    return;
  }
  for (const [key, entry] of [...entries]) {
    if (!key.startsWith(`${parentId}:${childId}:`)) continue;
    try {
      entry.session.dispose?.();
    } catch {
      /* 忽略 */
    }
    entries.delete(key);
  }
  console.log(`[agent] 已释放 ${parentId}:${childId} 的全部会话（下次对话按最新能力重建）`);
}

/** 释放某孩子的全部会话（服务重启/测试清理用）。 */
export function disposeChildAgentSession(childId: string): void {
  for (const [key, entry] of [...entries]) {
    if (!key.includes(`:${childId}:`)) continue;
    try {
      entry.session.dispose?.();
    } catch {
      /* 忽略 */
    }
    entries.delete(key);
  }
}
