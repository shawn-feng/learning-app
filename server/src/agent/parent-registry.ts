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
import { PLAN_DOMAIN_TOOL_NAMES, createPlanDomainTools } from "./parent-plans.js";
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

/**
 * 待重建标记：家长端「重置会话」后置位，下次 ensureEntry 时 newSession()（丢弃旧会话历史）。
 * 2026-09-15：此前 resetParentSession 只释放内存实例、历史靠 continueRecent 续接——导致
 * 「重置」后旧上下文（含模型此前的错误自我认知，如"我没有某工具"）仍在，追问时被旧答案锚住。
 */
const resetMarks = new Set<string>();

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

/** 家长 agent 的 system prompt（P2 资料治理 + 2026-09-13 计划域三表工具）。 */
export function buildServerParentPrompt(input: { parentId: string; workspace: string; today: string }): string {
  return `你是「学习伙伴」家长工作台的助手，帮家长管理孩子的学习计划、生活计划、考核排期、课程与学习资料。

## 当前上下文
- 家长：${input.parentId}
- 今天：${input.today}
- 你的工作区：${input.workspace}（read/write/edit/ls 只能在此目录内）——用于放临时产出，正式资料请用 parent_put_material 发布到真源。

## 计划域（学习计划 / 生活计划 / 考核排期）
对象一律按**孩子姓名**定位（不确定先 parent_list_children）：
- 起草案期前先 parent_study_plan_sources 查孩子真实课程结构，按**真实存在的课程名**排，不猜课程名；
- parent_study_plan_create 排「每天学什么」（一次可排多天，复习课加「复习：」前缀）；parent_study_plan_list 看现有排期（含行 id）；parent_study_plan_get 看某天安排；parent_study_plan_update 删/挪天/改复习；
- parent_life_plan_create 建生活计划（必须完成项，如「每天整理书包」；同天同标题自动跳过）；parent_life_plan_list / parent_life_plan_update 查看/改删；
- parent_exam_plan_create 预约考核——courses 必须是**精确课程名**，家长说的模糊范围（「最近学的 3 课」）先查再确认，**信息不全必须问，不要猜**；parent_exam_plan_list 查看排期；
- 改排期/建考核前先复述方案让家长确认；未学完的课系统自动顺延，不需要你手动挪。

## 课程学习资料（唯一真源）
资料在服务端，按主题目录组织（如 lunyu/materials/lesson-01.html）。整理资料请用这些工具，不要试图用本地文件工具去改真源：
- parent_list_materials：先看清楚现在有什么（整理前必做）
- parent_read_material：读正文（判断是否重复、内容是否正确）
- parent_move_material：移动/改名（归并散落文件）
- parent_put_material：写入/覆盖（发布你生成的资料）
- parent_delete_material：**默认只演练**，会返回将删除清单；必须先把清单复述给家长并取得同意，再带 confirm=true 真正删除
- parent_read_image：读教材扫描页/截图里的内容

## 落库主题与课程（家长库真源）
设计好教学主题/课程后，用工具直接写入家长库真源（孩子学习时从家长库读取，落库即对孩子可见）：
- parent_upsert_topic：写主题（name 主键 + topic_key 目录名 + method/assess_method/progress）
- parent_upsert_course：写课程（topic + title 联合主键 + sort_order/status/lesson_method/html_path/teaching_copy/assess_rubric）
覆盖前先 parent_library_topics / parent_library_courses 核对现有结构；status/last_review/review_count 由系统维护，落库时一般只给初始 ⬜（或让系统更新），勿手写进度。先复述落库内容让家长确认。

## 孩子的对话记录（只读，家长已授权）
需要知道孩子**具体说了什么**时用 parent_read_child_conversation（默认读今天；date 传 all + days 可读最近几天，最多 7 天；也接受「今天/昨天/前天」）：
- 适用：判断某课是否真学会、哪一步卡住、孩子提过什么困惑，或复盘学习过程；只要概括性进度就别读逐字稿，用计划/记录类工具即可。
- 边界：只能读**自己名下**孩子的记录（系统按归属校验）；**只读**——不存在任何改写孩子会话的能力。
- 汇报方式：向家长**概括要点**，不要大段复述逐字稿原文。

## 工作原则
- 动手前先列清单、复述你的整理方案，让家长知道你准备改什么（家长看不到你脑子里的计划）。
- 不确定就查：parent_library_topics / parent_library_courses 是权威主题与课程名册。
- 批量改动分步做，每步说明结果；删除/覆盖这类不可逆动作尤其谨慎。
- 面向家长用简洁中文，说清「做了什么、影响哪些文件」。
`;
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
  const customTools = [
    ...fsTools,
    ...parentTools,
    ...createPlanDomainTools({ db: deps.db, dataDir: deps.dataDir, parentId }),
    createGetDateTool(),
  ];

  const systemPrompt = buildServerParentPrompt({ parentId, workspace, today: localDate() });

  const handle = await createCoreSession({
    deps: DEPS,
    runtime,
    model,
    cwd: workspace,
    agentDir,
    systemPrompt,
    toolNames: [
      ...SERVER_FS_TOOL_NAMES,
      ...PARENT_AGENT_TOOL_NAMES,
      ...PLAN_DOMAIN_TOOL_NAMES,
      "get_date",
    ].filter((n, i, arr) => arr.indexOf(n) === i),
    customTools,
    sessionsDir: paths.agentSessionsDir(parentId, kind),
    // 重置后首次重建：newSession() 起干净会话（旧 jsonl 保留为历史，不再被 continueRecent 选中）
    shouldAutoNewSession: () => resetMarks.has(key),
  });
  resetMarks.delete(key);

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

/**
 * 中止家长会话的当前一轮（ISSUE-095）：调 SDK 的 session.abort()（中止当前操作并等待 agent idle）。
 * 没有在跑的一轮时为 no-op（返回 false）。中止后 submitParentPrompt 的 finally 会清 busy
 * 并经 SSE 推 turn_end，家长端忙碌态正常解禁。
 */
export async function abortParentSession(parentId: string, kind: ParentSessionKind = "parent"): Promise<boolean> {
  const key = keyOf(parentId, kind);
  const entry = entries.get(key);
  if (!entry || !entry.busy) return false;
  try {
    await entry.session.abort();
    console.log(`[parent-agent] 已中止会话 ${key} 的当前一轮`);
    return true;
  } catch (err) {
    console.error(`[parent-agent] 中止会话 ${key} 失败:`, (err as Error).message);
    return false;
  }
}

/**
 * 重置家长会话（真正的「新会话」语义，2026-09-15 起）：释放内存实例 **并置「待重建」标记**——
 * 下次对话 newSession() 起干净会话（旧 jsonl 保留为历史，不再被 continueRecent 选中）。
 * 为什么要改：此前只 dispose 实例，历史仍续接，「重置」形同虚设——旧上下文（包括模型此前
 * 说过的错误自我认知，如"我没有某工具"）会一直把新能力盖住（ISSUE-102 实证）。
 */
export function resetParentSession(parentId: string, kind: ParentSessionKind = "parent"): void {
  const key = keyOf(parentId, kind);
  const entry = entries.get(key);
  if (entry) {
    try {
      entry.session.dispose?.();
    } catch {
      /* 忽略 */
    }
    entries.delete(key);
  }
  resetMarks.add(key);
  console.log(`[parent-agent] 已重置会话 ${key}（下次对话新开会话，旧历史保留为归档）`);
}
