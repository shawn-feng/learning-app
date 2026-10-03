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
// KB P1（2026-09-27）：孩子侧唯一的知识库检索入口 kb_lookup（家长库只读，门控在 SQL 里）
import { CHILD_KB_TOOL_NAMES, createChildKbTools } from "./child-kb-tools.js";
import { CHILD_REPORT_TOOL_NAMES, createChildReportTools } from "./child-report-tools.js";
import { readParentSettings } from "../worker/scheduler.js";
import { getAgentPrompt } from "../db/agents.js";
import { clearDisplayLog } from "../db/displays.js";
// KB P2 的推送（listEntryBriefsForCourse / buildCourseKbLines）已按用户决定取消（2026-09-25）：
// 一节课的准备材料由 parent_content（type 缺省=lesson）在工具层一次读出，见下方说明。
import { createKbWithdrawNoticeExtension } from "./kb-withdraw-notice.js";
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
import { buildServerChildPrompt } from "./prompt.js";
import { friendlyModelError, syncSessionModel } from "./model-sync.js";
import { agentStreamHub, AgentStreamHub } from "./stream-hub.js";
// ISSUE-146 P0：会话活跃度登记（挂死看门狗判据；长工具执行期间不算静默）
import {
  SESSION_IDLE_TIMEOUT_MS,
  TOOL_EXEC_TIMEOUT_MS,
  beginToolExecution,
  clearActivity,
  endToolExecution,
  lastActivityAt,
  markActivity,
  runningToolCount,
  runningToolNames,
  toolProgressText,
} from "./session-activity.js";
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

/**
 * 会话键：一个孩子**只有一条**会话（2026-09-25 会话收敛）。
 *
 * 原来有 main / scene / `course:<课名>` 三种形态，各自独立上下文与落盘目录。已删除 course 与 scene：
 * 前端不再主动切会话，孩子的一切对话都落在这一条上；只有 `/reset`（或跨天）才会开新的会话文件。
 * 键里保留 childId 段是为了与父/孩子两套注册表的关键字形状一致，也让日志一眼能看出是谁的会话。
 */
function keyOf(parentId: string, childId: string): string {
  return `${parentId}:${childId}:main`;
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

/**
 * 会话槽名（会话目录 / agentDir 用）。
 *
 * ⚠️ 2026-09-25 会话收敛：只剩一条会话，但槽名**仍带 `-main` 后缀**——磁盘上已有的孩子历史
 * （`<childId>-main/`）就是这个目录，改名等于把所有既有会话变成孤儿。`-scene` / `-course-*`
 * 目录留在磁盘上作为历史，不再读写；Token 统计的扫描器仍按目录名归类，所以旧数据在面板里照常可见。
 */
export function sessionSlot(childId: string): string {
  return `${childId}-main`;
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
 * 按设备能力计算工具白名单（纯函数，便于测试与调试）。
 * 资料面板类工具（page_*）只在设备声明 `material-panel` 时注册——见 caps.ts 的说明。
 */
export function computeChildToolNames(caps: { materialPanel: boolean }): string[] {
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
    // KB P1：知识库检索（家长库只读，门控在 SQL）
    ...CHILD_KB_TOOL_NAMES,
  ];
}

async function ensureEntry(
  deps: AgentSessionDeps,
  parentId: string,
  childId: string
): Promise<Entry> {
  const key = keyOf(parentId, childId);
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
  const displayTool = createDisplayContentTool({ dataDir: deps.dataDir, parentId, childId, streamKey: streamKeyOf(parentId, childId), sessionKey: "main" });
  const programmingTool = createProgrammingTool({ dataDir: deps.dataDir, db: deps.db, parentId }, { scope: "child", childId });

  // 设备能力协商（P3）：资料面板类工具只在「对端确实有资料面板」时注册。
  // 若一律注册，模型会调用做不到的工具（如手机端无面板 / 无 Electron 面板），调用后只能报错，
  // 不如让它从工具表就知道这台设备做不到，从而改用对话引导。
  const caps = getCaps(streamKeyOf(parentId, childId));
  const pageTools = caps.materialPanel
    ? createPageTools({ db: deps.db, dataDir: deps.dataDir, parentId, childId, streamKey: streamKeyOf(parentId, childId) })
    : null;

  const customTools = [
    ...kbTools,
    ...fsTools,
    displayTool,
    programmingTool,
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
    // KB P1：kb_lookup（检索家长库的已发布条目；只读、门控在 SQL）；
    // P3 起带 `db`，用于精确未命中时的向量兜底（读家长 settings 取 embedding 凭证）
    ...createChildKbTools({ dataDir: deps.dataDir, parentId, childId, db: deps.db }),
    ...(pageTools ? [pageTools.pageActionTool, pageTools.pageInspectTool] : []),
    createGetDateTool(),
    createSummarizeConversationTool({ db: deps.db, dataDir: deps.dataDir, parentId, childId }),
  ];

  const toolNames = computeChildToolNames(caps);

  // AGENTS 用户版本：服务端就是唯一真源（scope=child, ref=childId），直接读库注入，
  // 不再有旧架构「客户端先远程预取到本地缓存、同步回调再读缓存」的时序问题。
  const agentRules = getAgentPrompt(deps.dataDir, "child", childId) ?? "";

  const systemPrompt = buildServerChildPrompt({
    paths,
    parentId,
    childId,
    childName: childName(deps.db, childId),
    today: localDate(),
    now: localTime(),
    agentRules,
    dbTablesBlock: buildChildSelfBlock(deps.dataDir, parentId, childId),
  });

  const slot = sessionSlot(childId);
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
    // 会话级红线（路径越界拦截 + 每轮注入日期）与客户端同一份实现；
    // KB P2.1：再加一条每轮注入的「撤回复核纪律」——门控管得住"查得到查不到"，
    // 管不住"还记得不记得"（见 kb-withdraw-notice.ts 的实测缺陷说明）
    extensionFactories: [guardExtension, createKbWithdrawNoticeExtension({ dataDir: deps.dataDir, parentId })],
  });
  // ISSUE-113：新会话（/reset、跨天自动新建、或首次进入且旧会话非今天）→ 清该会话的展示登记，
  // 左侧资料列表随会话走（重进保留、重置清空）
  if (resetMarks.has(key) || !isLastMessageToday(sessionsDir)) {
    try {
      clearDisplayLog(deps.dataDir, parentId, childId, "main");
    } catch {
      /* 清理失败不影响会话建立 */
    }
  }
  resetMarks.delete(key);

  const entry: Entry = { session: handle.session, busy: false, paths };
  // ISSUE-146 P0：活跃度/工具计数按**会话** key 记，SSE 事件仍发到**孩子** streamKey
  attachStream(entry, key, streamKeyOf(parentId, childId));
  entries.set(key, entry);
  console.log(
    `[agent] 已就绪会话 ${key}（持久：${paths.agentSessionsDir(parentId, slot)}；caps=${caps.raw || "none"}；工具 ${toolNames.length} 项；AGENTS ${agentRules ? "用户版" : "默认"}）`
  );
  return entry;
}

// 「课程上下文块」与「按课推送知识条目」整条链路已删除（2026-09-25，用户拍板）：
//   ① `courseContextBlock`（教法/文案/考核要点/资料路径 + 本课知识条目 → system prompt 的「本次课程」段）
//      随课程会话下线删除——它唯一的调用点就是构造课程会话的 system prompt；
//   ② **推送本身按用户决定取消**：一节准备材料 = 教学方法 + 教学文案（+ 考核要点/资料路径），
//      「这节课怎么上、讲什么」本来就在文案与方法里，不需要再把挂课的知识条目预加载进上下文。
//      现在这节课的准备材料由 **`parent_content`（type 缺省=lesson）一次性读出**——工具层面的读取，
//      而不是会话建立时的注入；条目仍可按需 `kb_lookup` 拉取（命中/门控/高风险拒答全不变）。
//   ③ 随之删除：`buildCourseKbLines`（推送渲染规格）、`listEntryBriefsForCourse`（推送读取器）、
//      `prompt.ts` 的 `courseBlock` 注入位与「## 本次课程」段。
//   保留：`kb_entry_links`（条目↔课程绑定）本身——它在家长侧仍是一条可见的标注（见 db/kb-entries.ts）。

/**
 * 把 SDK 事件映射为流事件（与客户端 attachSessionEvents 的事件面保持一致）。
 *
 * ⚠️ 两个 key 必须分开（ISSUE-146 P0 修正）：
 * - `sessionKey`：**活跃度与工具计数**按会话记（会话收敛后一个孩子只有一条，但两者仍是不同的 key 语义）；
 * - `streamKey`（`${pid}:${cid}`）：SSE 事件的发布 key —— 客户端订阅一个孩子即可收到其全部事件。
 * 此前两者混用同一个参数（传的是 streamKey），导致 watchdog 读的 `sessionActivity.get(sessionKey)` 永远拿不到
 * attachStream 刷新的值 —— 判据退化成「从提交时刻起算的硬超时」，任何超过 240s 的**正常**轮都会被砍。
 */
function attachStream(entry: Entry, sessionKey: string, streamKey: string): void {
  entry.session.subscribe((event: any) => {
    markActivity(sessionKey);
    switch (event?.type) {
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame?.type === "text_delta") {
          agentStreamHub.publish(streamKey, "text_delta", { delta: ame.delta });
        } else if (ame?.type === "thinking_delta") {
          agentStreamHub.publish(streamKey, "thinking_delta", { delta: ame.delta });
        }
        break;
      }
      case "tool_execution_start":
        // ISSUE-146 P0：工具执行期间会话静默是正常的 —— 计数让 watchdog 跳过误判
        beginToolExecution(sessionKey, event.toolName);
        agentStreamHub.publish(streamKey, "tool_start", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      case "tool_execution_update":
        // ISSUE-146 P0-b：长工具（create_html_lesson 等）经 execute 的 onUpdate 回报进度。
        // **不**复用 text_delta/message_end，避免污染客户端轮内文本缓冲（turnTextBuffers）。
        agentStreamHub.publish(streamKey, "tool_progress", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          progress: toolProgressText(event.partialResult),
        });
        break;
      case "tool_execution_end":
        endToolExecution(sessionKey, event.toolName);
        agentStreamHub.publish(streamKey, "tool_end", {
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
            agentStreamHub.publish(streamKey, "error", { message: friendlyModelError(raw) });
            break;
          }
          agentStreamHub.publish(streamKey, "message_end", { message: event.message });
        }
        break;
      case "agent_end":
        agentStreamHub.publish(streamKey, "agent_end", {});
        break;
      case "error":
        agentStreamHub.publish(streamKey, "error", {
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
// —— 挂死看门狗（ISSUE-146 P0 改造）：判据与工具执行状态分离 ——
// 原来「240s 无任何事件即判挂死」会把**长时工具**（create_html_lesson：内部 await 独立编程会话，
// 实测中位 321s、最长 654s）误杀，且文案错误归因给模型。现在有工具在跑 → TOOL_EXEC_TIMEOUT_MS 硬上限；
// 无工具在跑 → 才用 SESSION_IDLE_TIMEOUT_MS 判模型静默。活跃度与工具计数见 session-activity.ts。

export async function submitChildPrompt(
  deps: AgentSessionDeps,
  parentId: string,
  childId: string,
  text: string,
  opts: { pendingPageEvents?: string } = {}
): Promise<SubmitResult> {
  const entry = await ensureEntry(deps, parentId, childId);
  if (entry.busy) {
    return { ok: false, error: "busy：上一轮还在回答，请稍候" };
  }
  // ISSUE-126：设置里换了默认模型 → 对现有会话原地热切换（历史保留，不销毁重建）；
  // 切换失败（典型：新 provider 没配 key）→ 本轮不发送，把原因明确返回给前端。
  const synced = await syncSessionModel(deps, parentId, entry.session, "agent");
  if (!synced.ok) return { ok: false, error: synced.error };
  const key = keyOf(parentId, childId);
  const streamKey = streamKeyOf(parentId, childId);
  const evtPrefix = opts.pendingPageEvents ? `[页面事件] ${opts.pendingPageEvents}\n` : "";
  const prompt = `${evtPrefix}${text ?? ""}`.trim();
  if (!prompt) return { ok: false, error: "空消息" };

  entry.busy = true;
  // 本轮基线：lastActivityAt 缺失时回退到本轮开始时间（ISSUE-146）
  const turnStartedAt = Date.now();
  markActivity(key, turnStartedAt);
  agentStreamHub.publish(streamKey, "user_message", { text: prompt, pageEvents: opts.pendingPageEvents ?? "" });
  // 挂死看门狗：模型 API 偶发挂起时 prompt 永不返回也不报错 → busy 永久占用。
  const watchdogActivity = { fired: false };
  const watchdog = setInterval(() => {
    if (watchdogActivity.fired) return;
    const last = lastActivityAt(key) ?? turnStartedAt;
    const silent = Date.now() - last;
    const tools = runningToolCount(key);
    if (tools > 0) {
      // ISSUE-146 P0：有工具在跑 —— 静默是正常的（长工具的 execute 内部 await 独立编程会话，
      // 它的事件不进本会话）。改用更宽的工具硬上限，且文案如实归因到「工具」。
      if (silent <= TOOL_EXEC_TIMEOUT_MS) return;
      watchdogActivity.fired = true;
      clearInterval(watchdog);
      const names = runningToolNames(key).filter(Boolean).join("、") || "未知工具";
      console.error(
        `[agent] 会话 ${key} 的工具 ${names} 超过 ${TOOL_EXEC_TIMEOUT_MS / 60000} 分钟无任何进度，判定卡死，中止本轮`
      );
      agentStreamHub.publish(streamKey, "error", {
        message:
          `工具「${names}」执行超过 ${TOOL_EXEC_TIMEOUT_MS / 60000} 分钟仍未完成，已自动中止本轮。` +
          `该任务可能过于复杂，可拆成更小的需求后重试。`,
      });
      void entry.session.abort().catch(() => undefined);
      return;
    }
    // 无工具在跑 → 这才是原本要抓的「模型 API 偶发挂起」，判据与文案保持原样
    if (silent <= SESSION_IDLE_TIMEOUT_MS) return;
    watchdogActivity.fired = true;
    clearInterval(watchdog);
    console.error(`[agent] 会话 ${key} 超过 ${SESSION_IDLE_TIMEOUT_MS / 1000}s 无任何事件，判定挂死，中止本轮`);
    agentStreamHub.publish(streamKey, "error", {
      message: `模型服务超过 ${SESSION_IDLE_TIMEOUT_MS / 1000} 秒无响应，已自动中止本轮。请重试；多次出现请检查模型服务。`,
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
        agentStreamHub.publish(streamKey, "error", { message });
      }
    } finally {
      clearInterval(watchdog);
      entry.busy = false;
      // ISSUE-146 P0：一轮结束即清活跃/工具计数 —— 防异常路径（工具没 emit end）导致计数泄漏，
      // 那会让**下一轮**的看门狗永远跳过判定、真挂死反而再也没人抓。
      clearActivity(key);
      agentStreamHub.publish(streamKey, "turn_end", {});
    }
  })();
  return { ok: true };
}

/** 某孩子是否已在服务端建过会话（供测试与调试） */
export function hasSession(parentId: string, childId: string): boolean {
  return entries.has(keyOf(parentId, childId));
}

/** 某孩子当前一轮是否在跑（开放 API /open/agent/status 用）：会话未建立 = 不忙。 */
export function isChildBusy(parentId: string, childId: string): boolean {
  return entries.get(keyOf(parentId, childId))?.busy === true;
}

/**
 * 中止该孩子会话当前的一轮（ISSUE-095）：调 SDK 的 session.abort()（中止当前操作并等待 agent idle）。
 * 会话收敛后一个孩子只有一条会话（2026-09-25），不再需要 kind 维度。
 * 中止后 submitChildPrompt 的 finally 会清 busy 并经 SSE 推 turn_end，客户端忙碌态正常解禁。
 * 返回实际发生中止的会话数（0 = 没有在跑的一轮）。
 */
export async function abortSession(parentId: string, childId: string): Promise<number> {
  const key = keyOf(parentId, childId);
  const entry = entries.get(key);
  if (!entry?.busy) return 0;
  try {
    await entry.session.abort();
    console.log(`[agent] 已中止会话 ${key} 的当前一轮`);
    return 1;
  } catch (err) {
    console.error(`[agent] 中止会话 ${key} 失败:`, (err as Error).message);
    return 0;
  }
}

/**
 * 重置某孩子的会话：释放内存实例并置「待重建」标记——下次对话 newSession() 起干净会话
 * （旧会话文件保留为历史，但不再被 continueRecent 选中）。
 *
 * 会话收敛后这是**唯一**会「立刻开一条新会话」的入口（另一条是跨天自动新建），
 * 对应孩子聊天框里的 `/reset` 命令。
 */
export function resetSession(parentId: string, childId: string): void {
  const key = keyOf(parentId, childId);
  disposeSession(parentId, childId);
  resetMarks.add(key);
}

/** 读取某孩子会话的历史消息（原始 shape 供客户端映射；会话未建立时返回空数组）。 */
export function getChildSessionHistory(parentId: string, childId: string): Array<{ role: string; content: unknown[]; timestamp?: number; toolCallId?: string; isError?: boolean }> {
  const entry = entries.get(keyOf(parentId, childId));
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
 *
 * 跨天自动新建是**保留**的行为（2026-09-25 会话收敛时用户明确保留）：前端不再主动切会话，
 * 但第二天进来仍是一条干净会话。
 */
export async function openChildSession(
  deps: AgentSessionDeps,
  parentId: string,
  childId: string
): Promise<ReturnType<typeof getChildSessionHistory>> {
  const paths = createCorePaths(deps.dataDir);
  const sessionsDir = paths.agentSessionsDir(parentId, sessionSlot(childId));
  const key = keyOf(parentId, childId);
  if (!resetMarks.has(key) && !isLastMessageToday(sessionsDir)) {
    console.log(`[agent] 会话 ${key} 最后一条消息非今天 → 每日自动新建会话（冷路径裁决）`);
    resetSession(parentId, childId);
  }
  await ensureEntry(deps, parentId, childId);
  return getChildSessionHistory(parentId, childId);
}

/**
 * 释放某孩子的会话（caps 变化或测试清理用）。
 * 为什么要能释放：设备能力是**创建会话时**决定工具表的，手机端后连上报 material-panel 时，
 * 旧会话的工具表里没有 page_*，必须重建才能拿到——不重建会出现「同一会话有时能操作页面有时不能」。
 * 释放 ≠ 新建：下次进会话同一天内是 continueRecent 续用同一文件。
 */
export function disposeSession(parentId: string, childId: string): void {
  const key = keyOf(parentId, childId);
  const entry = entries.get(key);
  if (!entry) return;
  try {
    entry.session.dispose?.();
  } catch {
    /* 忽略 */
  }
  entries.delete(key);
  clearActivity(key); // ISSUE-146 P0：活跃/工具计数随之清掉
  console.log(`[agent] 已释放会话 ${key}（下次对话按最新能力重建）`);
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
    clearActivity(key); // ISSUE-146 P0
  }
}
