/**
 * 服务端孩子 agent 会话注册表（P1 核心）：
 * 把「一个孩子的交互会话」在服务端跑起来——持久落盘、工具装配、事件流式发布。
 *
 * 会话形态：packages/agent-core 的 createCoreSession（sessionsDir 落盘 = 持久会话），
 * 会话文件放 `<dataDir>/agent-sessions/<parentId>/<childId>/`（与客户端镜像目录分开，避免互相污染）。
 * 多端：同一 (parentId, childId) 在进程内复用同一个 session 实例，事件经 stream-hub 广播给全部订阅者。
 * 并发：同一会话同一时刻只允许一次 prompt（`busy`），否则两个设备的输入会交错进同一上下文。
 */
import type { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import {
  createCorePaths,
  createCoreSession,
  getWorkerRuntime,
  pickWorkerModel,
  type CoreSessionDeps,
  type CorePaths,
} from "@pi/agent-core";
import { createWorkerKbTools } from "../worker/kb-tools.js";
import { readParentSettings } from "../worker/scheduler.js";
import { getAgentPrompt } from "../db/agents.js";
import { openParentLib } from "../db/parent-lib.js";
import { createServerFsTools, SERVER_FS_TOOL_NAMES } from "./fs-tools.js";
import { createSummarizeConversationTool } from "./kb-summary-tool.js";
import { createTodayPlanTool, createParentContentTool } from "./plan-tools.js";
import { createDisplayContentTool, DISPLAY_TOOL_NAME } from "./display-tool.js";
import { PAGE_TOOL_NAMES, createPageTools } from "./page-tools.js";
import { createProgrammingTool } from "./programming-agent.js";
import { getCaps } from "./caps.js";
import { buildServerChildPrompt, buildServerScenePrompt } from "./prompt.js";
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
    "get_today_plan",
    "parent_content",
    "summarize_conversation",
    DISPLAY_TOOL_NAME,
    "create_html_lesson",
    ...(caps.materialPanel ? PAGE_TOOL_NAMES : []),
    "kb_query",
    "kb_insert",
    "kb_update",
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
  const displayTool = createDisplayContentTool({ dataDir: deps.dataDir, parentId, childId, streamKey: streamKeyOf(parentId, childId) });
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
          createTodayPlanTool({ dataDir: deps.dataDir, parentId, childId }),
          createParentContentTool({ dataDir: deps.dataDir, parentId, childId }),
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
      });

  const slot = sessionSlot(childId, kind);
  const handle = await createCoreSession({
    deps: CORE_SESSION_DEPS,
    runtime,
    model,
    cwd: workspace,
    agentDir: `${workspace}/.pi/${slot}`,
    systemPrompt,
    toolNames,
    customTools,
    sessionsDir: paths.agentSessionsDir(parentId, slot),
    // reset 后首次重建：newSession() 起一个干净会话（丢弃旧文件历史）
    shouldAutoNewSession: () => resetMarks.has(key),
    // 会话级红线（路径越界拦截 + 每轮注入日期）与客户端同一份实现
    extensionFactories: [guardExtension],
  });
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
 * 课程会话的上下文块：该课的教法/考核方法/资料路径（均取自家长库真源）。
 * 拿不到课程记录时不编造，显式说明——避免模型凭课程名猜教学内容。
 */
function courseContextBlock(deps: AgentSessionDeps, parentId: string, childId: string, courseTitle: string): string {
  try {
    const lib = openParentLib(deps.dataDir, parentId);
    try {
      const row = lib
        .prepare(
          `SELECT topic, lesson_method, teach_copy, assess_rubric, html_path, status, last_review
           FROM courses WHERE title = ? LIMIT 1`
        )
        .get(courseTitle) as
        | { topic?: string; lesson_method?: string; teach_copy?: string; assess_rubric?: string; html_path?: string; status?: string; last_review?: string }
        | undefined;
      if (!row) return `本课「${courseTitle}」在家长库中未找到（可能有名字差异），请先与家长确认课程名再开始。`;
      const lines = [
        `- 课程：${courseTitle}（主题 ${row.topic ?? "-"}）`,
        `- 状态：${row.status ?? "-"}｜最近学习：${row.last_review || "-"}`,
        row.html_path ? `- 已有资料：${row.html_path}（可用 display_content 展示）` : "",
        row.lesson_method ? `- 教法（怎么上）：${row.lesson_method}` : "",
        row.teach_copy ? `- 教学文案要点：${row.teach_copy.slice(0, 800)}` : "",
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
  const key = keyOf(parentId, childId, kind);
  const streamKey = streamKeyOf(parentId, childId);
  const evtPrefix = opts.pendingPageEvents ? `[页面事件] ${opts.pendingPageEvents}\n` : "";
  const prompt = `${evtPrefix}${text ?? ""}`.trim();
  if (!prompt) return { ok: false, error: "空消息" };

  entry.busy = true;
  agentStreamHub.publish(streamKey, "user_message", { text: prompt, pageEvents: opts.pendingPageEvents ?? "", session: kind });
  try {
    await entry.session.prompt(prompt);
    return { ok: true };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    agentStreamHub.publish(streamKey, "error", { message, session: kind });
    return { ok: false, error: message };
  } finally {
    entry.busy = false;
    agentStreamHub.publish(streamKey, "turn_end", { session: kind });
  }
}

/** 某孩子是否已在服务端建过会话（供测试与调试） */
export function hasSession(parentId: string, childId: string, kind: ChildSessionKind = "main"): boolean {
  return entries.has(keyOf(parentId, childId, kind));
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
