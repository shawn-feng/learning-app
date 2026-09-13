/**
 * 服务端家长 agent 会话注册表（P2）。
 *
 * 与孩子会话（session-registry.ts）的差异：
 * - 作用域是**家长**而非孩子（key = `<parentId>:parent` / `<parentId>:parent-content`）；
 * - 工具面向课程与资料治理（parent-tools.ts），工作区在 `workspaces/<parentId>/parent/`；
 * - 会话同样持久落盘（`agent-sessions/<parentId>/parent/`），支持多端订阅同一会话。
 *
 * 说明：家长库（topics/courses）是家长维度的真源，模型凭据与孩子会话同源
 * （server 端 settings 的 auth 加密存储），因此复用了同一套 runtime 选取逻辑。
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
  type CorePaths,
  type CoreSessionDeps,
} from "@pi/agent-core";
import { readParentSettings } from "../worker/scheduler.js";
import { createServerFsTools, SERVER_FS_TOOL_NAMES } from "./fs-tools.js";
import { PARENT_AGENT_TOOL_NAMES, createParentAgentTools } from "./parent-tools.js";
import { agentStreamHub } from "./stream-hub.js";

const DEPS: CoreSessionDeps = {
  createAgentSession,
  ResourceLoader: DefaultResourceLoader,
  SessionManager: SessionManager as unknown as CoreSessionDeps["SessionManager"],
};

export type ParentSessionKind = "parent" | "parent-content";

export interface ParentSessionDeps {
  db: DatabaseSync;
  dataDir: string;
}

interface Entry {
  session: any;
  busy: boolean;
  paths: CorePaths;
}

const entries = new Map<string, Entry>();

function keyOf(parentId: string, kind: ParentSessionKind): string {
  return `${parentId}:${kind}`;
}

function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function createGetDateTool() {
  return defineTool({
    name: "get_date",
    label: "获取当前日期时间",
    description: "返回服务端当前日期与时间（YYYY-MM-DD HH:mm），用于「今天/本周」这类时间指代。",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [
        {
          type: "text" as const,
          text: (() => {
            const d = new Date();
            const p = (n: number) => String(n).padStart(2, "0");
            return `${localDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
          })(),
        },
      ],
      details: {},
    }),
  });
}

/** 家长 agent 的 system prompt（P2 版：资料治理为主，行为规范真源接入属 P2 后续/家长 AGENTS）。 */
export function buildServerParentPrompt(input: { parentId: string; workspace: string; today: string }): string {
  return `你是「学习伙伴」家长工作台的助手，帮家长管理孩子的课程与学习资料。

## 当前上下文
- 家长：${input.parentId}
- 今天：${input.today}
- 你的工作区：${input.workspace}（read/write/edit/ls 只能在此目录内）——用于放临时产出，正式资料请用 parent_put_material 发布到真源。

## 课程学习资料（唯一真源）
资料在服务端，按主题目录组织（如 lunyu/materials/lesson-01.html）。整理资料请用这些工具，不要试图用本地文件工具去改真源：
- parent_list_materials：先看清楚现在有什么（整理前必做）
- parent_read_material：读正文（判断是否重复、内容是否正确）
- parent_move_material：移动/改名（归并散落文件）
- parent_put_material：写入/覆盖（发布你生成的资料）
- parent_delete_material：**默认只演练**，会返回将删除清单；必须先把清单复述给家长并取得同意，再带 confirm=true 真正删除
- parent_read_image：读教材扫描页/截图里的内容

## 工作原则
- 动手前先列清单、复述你的整理方案，让家长知道你准备改什么（家长看不到你脑子里的计划）。
- 不确定就查：parent_library_topics / parent_library_courses 是权威主题与课程名册。
- 批量改动分步做，每步说明结果；删除/覆盖这类不可逆动作尤其谨慎。
- 面向家长用简洁中文，说清「做了什么、影响哪些文件」。`;
}

async function ensureEntry(
  deps: ParentSessionDeps,
  parentId: string,
  kind: ParentSessionKind
): Promise<Entry> {
  const key = keyOf(parentId, kind);
  const existing = entries.get(key);
  if (existing) return existing;

  const paths = createCorePaths(deps.dataDir);
  const settings = readParentSettings(deps.db, deps.dataDir, parentId);
  const runtime = await getWorkerRuntime(deps.dataDir, parentId, settings.auth);
  const model = pickWorkerModel(runtime, settings.appSettings);

  const workspace = paths.childWorkspaceDir(parentId, "parent");
  const agentDir = `${workspace}/.pi`;
  const fsTools = createServerFsTools(workspace);
  const parentTools = createParentAgentTools({
    db: deps.db,
    dataDir: deps.dataDir,
    parentId,
    workspaceDir: workspace,
    agentDir,
    auth: settings.auth,
    appSettings: settings.appSettings,
  });
  const customTools = [...fsTools, ...parentTools, createGetDateTool()];

  const systemPrompt = buildServerParentPrompt({ parentId, workspace, today: localDate() });

  const handle = await createCoreSession({
    deps: DEPS,
    runtime,
    model,
    cwd: workspace,
    agentDir,
    systemPrompt,
    toolNames: [...SERVER_FS_TOOL_NAMES, ...PARENT_AGENT_TOOL_NAMES.filter((n) => !SERVER_FS_TOOL_NAMES.includes(n)), "get_date"],
    customTools,
    sessionsDir: paths.agentSessionsDir(parentId, kind),
  });

  const entry: Entry = { session: handle.session, busy: false, paths };
  attachStream(entry, key);
  entries.set(key, entry);
  console.log(`[parent-agent] 已就绪会话 ${key}`);
  return entry;
}

function attachStream(entry: Entry, key: string): void {
  entry.session.subscribe((event: any) => {
    switch (event?.type) {
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame?.type === "text_delta") agentStreamHub.publish(key, "text_delta", { delta: ame.delta });
        else if (ame?.type === "thinking_delta") agentStreamHub.publish(key, "thinking_delta", { delta: ame.delta });
        break;
      }
      case "tool_execution_start":
        agentStreamHub.publish(key, "tool_start", { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
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
        if (event.message?.role === "assistant") agentStreamHub.publish(key, "message_end", { message: event.message });
        break;
      case "agent_end":
        agentStreamHub.publish(key, "agent_end", {});
        break;
      case "error":
        agentStreamHub.publish(key, "error", { message: String(event.error || event.message || "未知错误") });
        break;
      default:
        break;
    }
  });
}

export async function submitParentPrompt(
  deps: ParentSessionDeps,
  parentId: string,
  kind: ParentSessionKind,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const entry = await ensureEntry(deps, parentId, kind);
  if (entry.busy) return { ok: false, error: "busy：上一轮还在回答，请稍候" };
  const prompt = String(text ?? "").trim();
  if (!prompt) return { ok: false, error: "空消息" };
  const key = keyOf(parentId, kind);
  entry.busy = true;
  agentStreamHub.publish(key, "user_message", { text: prompt });
  // 异步执行整轮（提交即返回）：与孩子侧同因——长工具轮若被 POST 同步等待，会撞客户端超时
  // 把成功轮误报成「无法连接服务端」。结束/错误经 SSE（turn_end / error）推送。
  void (async () => {
    try {
      await entry.session.prompt(prompt);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      agentStreamHub.publish(key, "error", { message });
    } finally {
      entry.busy = false;
      agentStreamHub.publish(key, "turn_end", {});
    }
  })();
  return { ok: true };
}

export function hasParentSession(parentId: string, kind: ParentSessionKind = "parent"): boolean {
  return entries.has(keyOf(parentId, kind));
}

/** 重置家长会话：释放内存实例（下次对话按 continueRecent 续接；服务端家长会话暂不做「新会话」语义）。 */
export function resetParentSession(parentId: string, kind: ParentSessionKind = "parent"): void {
  const key = keyOf(parentId, kind);
  const entry = entries.get(key);
  if (!entry) return;
  try {
    entry.session.dispose?.();
  } catch {
    /* 忽略 */
  }
  entries.delete(key);
}
