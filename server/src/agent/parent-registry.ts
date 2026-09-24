/**
 * 服务端家长 agent 会话注册表（P2）。
 *
 * 与孩子会话（session-registry.ts）的差异：
 * - 作用域是**家长**而非孩子（key = `<parentId>:parent` / `<parentId>:parent-content`）；
 * - 工具面向课程与资料治理（parent-tools.ts）；ISSUE-131 P2：根=workspaces/<pid>，运行区 scratch/；
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
} from "@earendil-works/pi-coding-agent";
// ISSUE-134：统一还原字符串化参数（内含 SDK defineTool）
import { defineTool } from "./tool-kit.js";
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
import { friendlyModelError, syncSessionModel } from "./model-sync.js";
import { PARENT_AGENT_TOOL_NAMES, createParentAgentTools } from "./parent-tools.js";
import { PLAN_DOMAIN_TOOL_NAMES, createPlanDomainTools } from "./parent-plans.js";
import { createParentReportTool } from "./parent-report-tool.js";
// ISSUE-144 P4：家长侧**场景专用只读工具**（D1 考核 / D5 掌握 / D3 错题 / F3 积分 / F2 兑换）
// ——通用通道（parent_db_read）退场的**前置**，台账 §3.2
import { PARENT_CHILD_REPORT_TOOL_NAMES, createParentChildReportTools } from "./parent-child-report-tools.js";
import { agentStreamHub } from "./stream-hub.js";
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
// ISSUE-144：场景技能（常驻层只留索引与铁律，正文按需 load_skill 加载）
import { buildSkillIndexBlock } from "./skills/parent/index.js";
import { IRON_RULES_BLOCK } from "./skills/parent/shared.js";
import { createLoadSkillTool, createParentSkillState, LOAD_SKILL_TOOL_NAME } from "./parent-skills.js";
// ISSUE-144：工具说明下沉（一句 + 指路 + Schema 只留结构 + 场景守卫）——只在注册点过一道
import { compactParentTools } from "./parent-tool-compact.js";

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

/**
 * 家长 agent 的 system prompt。
 *
 * 2026-09-25（ISSUE-144）**常驻层瘦身**：原来把 8 个业务域的做法全写在这里（约 4000 字符），
 * 现在只留——身份、当前上下文、**场景技能索引**、**铁律**、工作原则；
 * 各域的步骤与汇报口径搬进 `agent/skills/parent/*`，由模型按家长意图 `load_skill` 按需加载。
 * 这样常驻前缀稳定（利于前缀缓存），也避免"无关口径每轮都在"分散注意力。
 *
 * 2026-09-25（ISSUE-144 P6）**通用通道退场**：原来这里还有一段「通用数据查询（兜底通道）」
 * 与两库表/列/路径元数据块（`buildDataChannelBlocks`），教模型用 `parent_db_read` 自己拼口径。
 * 通用数据 API 已整组退场，那段连同元数据块一并删掉——**场景要什么，就由场景专用工具给什么**；
 * 缺工具时按工作原则如实说明并指路界面，不再有"自己查表"这条退路。
 */
export function buildServerParentPrompt(input: { parentId: string; workspace: string; today: string }): string {
  return `你是「学习伙伴」家长工作台的助手，帮家长管理孩子的学习计划、考核、课程与学习资料。

## 当前上下文
- 家长：${input.parentId}
- 今天：${input.today}
- 你的工作区：${input.workspace}（read/write/edit/ls 只能在此目录内）——用于放临时产出，正式资料请用 parent_put_material 发布到真源。

${buildSkillIndexBlock()}

## 铁律（做错会坏数据或越权，任何场景都不例外）
${IRON_RULES_BLOCK}

## 工作原则
- 动手前先列清单、复述你的方案，让家长知道你准备改什么（家长看不到你脑子里的计划）。
- 不确定就查：parent_library_topics / parent_library_courses 是权威主题与课程名册。
- 批量改动分步做，每步说明结果；删除/覆盖这类不可逆动作尤其谨慎。
- **手里没有对应工具时，如实说"这件事我现在做不到"并指路界面，不要绕道、不要臆造工具名、更不要假装做完了。**
- 面向家长用简洁中文，说清「做了什么、影响哪些文件」。
- 上面「场景技能」里写了各场景更细的做法与汇报口径：**先在索引里找准场景、load_skill 加载后再动手**；一件事跨两个场景时可以连着加载两份。
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

  // ISSUE-131 P2：家长 agent 根 = workspaces/<pid>（materials/uploads/scratch/孩子目录都在其内，
  // fs 工具/网盘同此边界）；会话运行区（cwd、.pi）独立到 scratch，不再落 parent/ 工作区。
  const workspace = paths.agentRoot(parentId);
  const scratch = paths.agentScratchDir(parentId);
  const agentDir = `${scratch}/.pi`;

  const fsTools = createServerFsTools(workspace);
  // ISSUE-144：会话级技能状态——`load_skill` 与场景守卫共用（同一会话内加载过的场景，其工具才肯执行）
  const skillState = createParentSkillState();
  const parentTools = createParentAgentTools({
    db: deps.db,
    dataDir: deps.dataDir,
    parentId,
    workspaceDir: workspace,
    agentDir,
    auth: settings.auth,
    appSettings: settings.appSettings,
    skillState,
  });
  // ISSUE-144（A 路线全量铺开）：工具**说明下沉**——description 压成"一句 + 指路"、参数 Schema 只留结构、
  // 并外包一层**场景守卫**（未加载所属场景 → 拒绝执行）。说明的正文在各场景技能里（`load_skill` 按需加载）。
  // 通用设施（load_skill / log_activity / fs 工具）不在下沉范围，原样保留。
  const customTools = compactParentTools(
    [
      ...fsTools,
      ...parentTools,
      ...createPlanDomainTools({ db: deps.db, dataDir: deps.dataDir, parentId, skillState }),
      // ISSUE-144 P4：孩子的数据洞察（考核逐题 / 掌握与薄弱 / 积分与兑换）——按姓名定位孩子、
      // 取数范围写死、只读；家长问「考得怎么样/哪里薄弱/这分怎么算的」时不再需要通用通道
      ...createParentChildReportTools({ db: deps.db, dataDir: deps.dataDir, parentId }),
      // ISSUE-108：家长报表（markdown → 家长端「报表」区），仅运营类家长助手（parent/parent-content）可推
      createParentReportTool({ db: deps.db, parentId, streamKey: key }),
      // ISSUE-144：场景技能按需加载（会话内幂等；家长覆盖层存 agents.sqlite，按本家长隔离）
      createLoadSkillTool({ dataDir: deps.dataDir, parentId, state: skillState }),
      createGetDateTool(),
    ],
    skillState
  );

  // ISSUE-144 P6：systemPrompt 不再注入两库表/列/路径元数据块（通用数据 API 已退场，
  // 那张"自己查表"的清单只会诱导模型绕过场景专用工具）。
  const systemPrompt = buildServerParentPrompt({
    parentId,
    workspace,
    today: localDate(),
  });

  const handle = await createCoreSession({
    deps: DEPS,
    runtime,
    model,
    cwd: scratch,
    agentDir,
    systemPrompt,
    toolNames: [
      ...SERVER_FS_TOOL_NAMES,
      ...PARENT_AGENT_TOOL_NAMES,
      ...PLAN_DOMAIN_TOOL_NAMES,
      // ISSUE-144 P4：场景专用只读报告工具（常驻在工具面；说明与口径走场景技能 + 场景守卫）
      ...PARENT_CHILD_REPORT_TOOL_NAMES,
      "get_date",
      "parent_display_report",
      LOAD_SKILL_TOOL_NAME,
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

// —— 挂死看门狗（ISSUE-146 P0 改造）：判据与工具执行状态分离 ——
// 原来「240s 无任何事件即判挂死」会把**长时工具**（编程 agent：中位 321s、最长 654s）误杀，
// 且报错文案错误地归因给模型。现在：有工具在跑 → 用 TOOL_EXEC_TIMEOUT_MS 硬上限 + 工具超时文案；
// 无工具在跑 → 才用 SESSION_IDLE_TIMEOUT_MS 判模型静默。活跃度与工具计数见 session-activity.ts。

function attachStream(entry: Entry, key: string): void {
  entry.session.subscribe((event: any) => {
    markActivity(key);
    switch (event?.type) {
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame?.type === "text_delta") agentStreamHub.publish(key, "text_delta", { delta: ame.delta });
        else if (ame?.type === "thinking_delta") agentStreamHub.publish(key, "thinking_delta", { delta: ame.delta });
        break;
      }
      case "tool_execution_start":
        // ISSUE-146 P0：工具执行期间会话静默是正常的 —— 计数让 watchdog 跳过误判
        beginToolExecution(key, event.toolName);
        agentStreamHub.publish(key, "tool_start", { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
        break;
      case "tool_execution_update":
        // ISSUE-146 P0-b：长工具经 execute 的 onUpdate 回报进度（每 15s「仍在生成…已 X 分钟」等），
        // 让家长不再对着空白气泡等 11 分钟。注意：**不**复用 text_delta/message_end，
        // 否则会污染客户端轮内文本缓冲（web/src/shim/core/sse.ts 的 turnTextBuffers）。
        agentStreamHub.publish(key, "tool_progress", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          progress: toolProgressText(event.partialResult),
        });
        break;
      case "tool_execution_end":
        endToolExecution(key, event.toolName);
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
  // ISSUE-126：设置里换了默认模型 → 对现有会话原地热切换（历史保留，不销毁重建）；
  // 切换失败（典型：新 provider 没配 key）→ 本轮不发送，把原因明确返回给前端。
  const synced = await syncSessionModel(deps, parentId, entry.session, "parent-agent");
  if (!synced.ok) return { ok: false, error: synced.error };
  const prompt = String(text ?? "").trim();
  if (!prompt) return { ok: false, error: "空消息" };
  const key = keyOf(parentId, kind);
  entry.busy = true;
  agentStreamHub.publish(key, "user_message", { text: prompt });
  // —— 挂死看门狗（2026-09-18）：模型 API 偶发连接挂起时 prompt 永不返回也不报错，
  // 会话 busy 永久占用、客户端无限转圈。任何事件都刷新活跃时间；超过 IDLE 无事件
  // 即视为挂死 → abort 当前一轮（finally 会恢复 busy）+ 经 error 事件告知前端。
  const activity = { fired: false };
  // 本轮基线：lastActivityAt 缺失时回退到本轮开始时间（ISSUE-146）
  const turnStartedAt = Date.now();
  markActivity(key, turnStartedAt);
  const watchdog = setInterval(() => {
    if (activity.fired) return;
    const last = lastActivityAt(key) ?? turnStartedAt;
    const silent = Date.now() - last;
    const tools = runningToolCount(key);
    if (tools > 0) {
      // ISSUE-146 P0：有工具在跑 —— 此时静默是**正常**的（长工具的 execute 内部 await 一个独立的
      // 嵌套会话，它的事件不进父会话，父层只有 tool_start 一个事件）。改用显著更宽的工具硬上限兜底，
      // 且文案如实归因到「工具」，不再像旧版那样误报成「模型服务无响应」。
      if (silent <= TOOL_EXEC_TIMEOUT_MS) return;
      activity.fired = true;
      clearInterval(watchdog);
      const names = runningToolNames(key).filter(Boolean).join("、") || "未知工具";
      console.error(
        `[parent-agent] 会话 ${key} 的工具 ${names} 超过 ${TOOL_EXEC_TIMEOUT_MS / 60000} 分钟无任何进度，判定卡死，中止本轮`
      );
      agentStreamHub.publish(key, "error", {
        message:
          `工具「${names}」执行超过 ${TOOL_EXEC_TIMEOUT_MS / 60000} 分钟仍未完成，已自动中止本轮。` +
          `该任务可能过于复杂，可拆成更小的需求后重试。`,
      });
      void entry.session.abort().catch(() => undefined);
      return;
    }
    // 无工具在跑 → 这才是原本要抓的「模型 API 偶发挂起」，判据与文案保持原样
    if (silent <= SESSION_IDLE_TIMEOUT_MS) return;
    activity.fired = true;
    clearInterval(watchdog);
    console.error(`[parent-agent] 会话 ${key} 超过 ${SESSION_IDLE_TIMEOUT_MS / 1000}s 无任何事件，判定挂死，中止本轮`);
    agentStreamHub.publish(key, "error", {
      message: `模型服务超过 ${SESSION_IDLE_TIMEOUT_MS / 1000} 秒无响应，已自动中止本轮。请重试；多次出现请检查模型服务。`,
    });
    void entry.session.abort().catch(() => undefined);
  }, 5000);
  // 异步执行整轮（提交即返回）：与孩子侧同因——长工具轮若被 POST 同步等待，会撞客户端超时
  // 把成功轮误报成「无法连接服务端」。结束/错误经 SSE（turn_end / error）推送。
  void (async () => {
    try {
      await entry.session.prompt(prompt);
    } catch (err) {
      if (!activity.fired) {
        const message = (err as Error)?.message ?? String(err);
        agentStreamHub.publish(key, "error", { message });
      }
    } finally {
      clearInterval(watchdog);
      entry.busy = false;
      // ISSUE-146 P0：一轮结束即清活跃/工具计数 —— 防异常路径（工具没 emit end）导致计数泄漏，
      // 那会让**下一轮**的看门狗永远跳过判定、真挂死反而再也没人抓。
      clearActivity(key);
      agentStreamHub.publish(key, "turn_end", {});
    }
  })();
  return { ok: true };
}

export function hasParentSession(parentId: string, kind: ParentSessionKind = "parent"): boolean {
  return entries.has(keyOf(parentId, kind));
}

/** 读取某家长会话的历史消息（原始 shape 供客户端映射；会话未建立时返回空数组）。 */
export function getParentSessionHistory(
  parentId: string,
  kind: ParentSessionKind
): Array<{ role: string; content: unknown[]; timestamp?: number | string }> {
  const entry = entries.get(keyOf(parentId, kind));
  if (!entry?.session?.messages) return [];
  return entry.session.messages.map((m: any) => ({
    role: String(m?.role ?? ""),
    content: m?.content ?? [],
    ...(m?.timestamp != null ? { timestamp: m.timestamp } : {}),
  }));
}

/**
 * 打开家长会话（ISSUE-107 冷路径）：ensureEntry（continueRecent 续接落盘会话）后返回现会话全部历史。
 * 口径与孩子端 openChildSession 不同：家长会话**不做跨天裁决**——key 不含日期、长期持续累积
 * （registry 刻意不按日期自动新建），家长退出重进返回的是现会话全部历史，上下文不丢。
 */
export async function openParentSession(
  deps: ParentSessionDeps,
  parentId: string,
  kind: ParentSessionKind
): Promise<ReturnType<typeof getParentSessionHistory>> {
  await ensureEntry(deps, parentId, kind);
  return getParentSessionHistory(parentId, kind);
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
  clearActivity(key); // ISSUE-146 P0：随之清掉活跃/工具计数，避免旧会话残留影响新会话的看门狗
  console.log(`[parent-agent] 已重置会话 ${key}（下次对话新开会话，旧历史保留为归档）`);
}
