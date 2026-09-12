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
import { createServerFsTools, SERVER_FS_TOOL_NAMES } from "./fs-tools.js";
import { createSummarizeConversationTool } from "./kb-summary-tool.js";
import { createDisplayContentTool, DISPLAY_TOOL_NAME } from "./display-tool.js";
import { PAGE_TOOL_NAMES, createPageTools } from "./page-tools.js";
import { getCaps } from "./caps.js";
import { buildServerChildPrompt } from "./prompt.js";
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

function keyOf(parentId: string, childId: string): string {
  return `${parentId}:${childId}`;
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
 * 按设备能力计算孩子会话的工具白名单（纯函数，便于测试与调试）。
 * 资料面板类工具（page_*）只在设备声明 `material-panel` 时注册——见 caps.ts 的说明。
 */
export function computeChildToolNames(caps: { materialPanel: boolean }): string[] {
  return [
    ...SERVER_FS_TOOL_NAMES,
    "get_date",
    "summarize_conversation",
    DISPLAY_TOOL_NAME,
    ...(caps.materialPanel ? PAGE_TOOL_NAMES : []),
    "kb_query",
    "kb_insert",
    "kb_update",
  ];
}

async function ensureEntry(deps: AgentSessionDeps, parentId: string, childId: string): Promise<Entry> {
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
  const displayTool = createDisplayContentTool({ dataDir: deps.dataDir, parentId, childId, streamKey: key });

  // 设备能力协商（P3）：资料面板类工具只在「对端确实有资料面板」时注册。
  // 若一律注册，模型会调用做不到的工具（如手机端无面板 / 无 Electron 面板），调用后只能报错，
  // 不如让它从工具表就知道这台设备做不到，从而改用对话引导。
  const caps = getCaps(key);
  const pageTools = caps.materialPanel
    ? createPageTools({ db: deps.db, dataDir: deps.dataDir, parentId, childId, streamKey: key })
    : null;

  const customTools = [
    ...kbTools,
    ...fsTools,
    displayTool,
    ...(pageTools ? [pageTools.pageActionTool, pageTools.pageInspectTool, pageTools.sceneCommandTool] : []),
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
  });

  const handle = await createCoreSession({
    deps: CORE_SESSION_DEPS,
    runtime,
    model,
    cwd: workspace,
    agentDir: `${workspace}/.pi`,
    systemPrompt,
    toolNames,
    customTools,
    sessionsDir: paths.agentSessionsDir(parentId, childId),
    // 会话级红线（路径越界拦截 + 每轮注入日期）与客户端同一份实现
    extensionFactories: [guardExtension],
  });

  const entry: Entry = { session: handle.session, busy: false, paths };
  attachStream(entry, key);
  entries.set(key, entry);
  console.log(
    `[agent] 已就绪会话 ${key}（持久：${paths.agentSessionsDir(parentId, childId)}；caps=${caps.raw || "none"}；工具 ${toolNames.length} 项；AGENTS ${agentRules ? "用户版" : "默认"}）`
  );
  return entry;
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
  opts: { pendingPageEvents?: string } = {}
): Promise<SubmitResult> {
  const entry = await ensureEntry(deps, parentId, childId);
  if (entry.busy) {
    return { ok: false, error: "busy：上一轮还在回答，请稍候" };
  }
  const key = keyOf(parentId, childId);
  const evtPrefix = opts.pendingPageEvents ? `[页面事件] ${opts.pendingPageEvents}\n` : "";
  const prompt = `${evtPrefix}${text ?? ""}`.trim();
  if (!prompt) return { ok: false, error: "空消息" };

  entry.busy = true;
  agentStreamHub.publish(key, "user_message", { text: prompt, pageEvents: opts.pendingPageEvents ?? "" });
  try {
    await entry.session.prompt(prompt);
    return { ok: true };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    agentStreamHub.publish(key, "error", { message });
    return { ok: false, error: message };
  } finally {
    entry.busy = false;
    agentStreamHub.publish(key, "turn_end", {});
  }
}

/** 某孩子是否已在服务端建过会话（供测试与调试） */
export function hasSession(parentId: string, childId: string): boolean {
  return entries.has(keyOf(parentId, childId));
}

/**
 * 释放某孩子的会话（caps 变化或测试清理用）。
 * 为什么要能释放：设备能力是**创建会话时**决定工具表的，手机端后连上报 material-panel 时，
 * 旧会话的工具表里没有 page_*，必须重建才能拿到——不重建会出现「同一会话有时能操作页面有时不能」。
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
  console.log(`[agent] 已释放会话 ${key}（下次对话按最新能力重建）`);
}

/** 释放会话（服务重启/测试清理用） */
export function disposeChildAgentSession(childId: string): void {
  for (const [key, entry] of entries) {
    if (key.endsWith(`:${childId}`)) {
      try {
        entry.session.dispose?.();
      } catch {
        /* 忽略 */
      }
      entries.delete(key);
    }
  }
}
