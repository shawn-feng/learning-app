/**
 * 编程 agent（服务端形态，P3）：把孩子/家长 agent 的需求描述变成一份儿童友好的自包含 HTML 资料。
 *
 * 迁移自 `electron/lib/programming-agent.ts`，语义保持一致：
 * - 独立会话（与学习/家长 agent 隔离，不共享上下文）；按 sessionKey 复用，使「生成 + 后续修改」上下文连续；
 * - 只做代码生成（tools 仅 read/write/edit），不挂 kb_* / display_content；
 * - 模型来自家长设置的「编程 agent 模型」；**未配置即不可用**（明确报错提示去设置页），不静默回退到默认模型
 *   ——编程质量差异大，静默回退会让家长以为「配置没生效」；
 * - 输出路径经沙箱校验：`materials/...` → 家长资料真源；其它 → 该家长工作区；只允许 .html/.htm；
 * - 写完校验文件非空（阈值 100B），防「模型声称写完但没落盘」。
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
// ISSUE-134：统一还原字符串化参数（内含 SDK defineTool）
import { defineTool } from "./tool-kit.js";
import { createCorePaths, getWorkerRuntime, learningGuardExtension, resolveWithin } from "@pi/agent-core";
import { legacyMaterialsRoot,
  materialsRoot } from "../db/materials.js";
import { readParentSettings } from "../worker/scheduler.js";

export interface ProgrammingDeps {
  dataDir: string;
  db: import("node:sqlite").DatabaseSync;
  parentId: string;
}

const sessions = new Map<string, AgentSession>();

export function buildProgrammingPrompt(): string {
  return `你是「编程 agent」，专门负责把需求描述变成一份可直接给孩子用的 HTML 学习资料。

## 职责
- 只做 HTML 代码生成与修改，不做教学内容设计（内容设计由调用方学习 agent 负责）。
- 输出必须是一个**自包含**的 .html 文件：内联 CSS/JS，不依赖任何外部网络资源（本地图片/音频可用相对路径或 media:// 协议）。
- 面向儿童：大字号、高对比度、明亮的配色、点击卡片等交互，让低龄孩子也能独立操作。

## 工作方式
- 收到需求后，把 HTML 写到调用方指定的输出路径（绝对路径）。具体落到什么路径由调用方决定，你只负责写到这个路径。
- 修改已有文件时，先 read 原文件再 edit/write，保留已有内容结构，只改需要改的部分。
- 写完必须确认文件已落盘（write 成功返回即已落盘）。

## 职责边界
- 你只负责 HTML 代码生成与修改，不负责教学内容设计与传达；kb_* 与 display_content 由调用方 agent 使用，你不需要也无法调用。
- 只写调用方指定的输出路径，不写到其它位置；不要读或写其它孩子的数据。

## 交互通讯协议（需要与宿主/AI 通讯的资料必须遵循；勿发明私有 postMessage 通道）
凡资料要"上报孩子操作 / 调用朗读等宿主能力 / 接收 AI 下行命令"，统一使用宿主已注入的 window.PiBridge：
- 上报事件：PiBridge.emit(action, payload)（如测验提交后 emit('submit-answer', {questionId, answer, correct})）；
- 调用宿主能力：await PiBridge.request(action, payload)（如朗读：await PiBridge.request('tts.speak', {text: 'Hello'}); 返回 {ok}）。已实现能力：tts.speak（{text}）、lookup（{text}）。⚠️ tts.speak 的 {ok} 只表示"已受理"——宿主按队列顺序朗读多句，页面不要自行排队、不要等待播完、更不要自建语音合成；
- 接收宿主/agent 下行命令：PiBridge.on(action, function(payload){...})；handler 可返回 {data} 或 Promise 作为回执；PiBridge.off(action, handler) 注销；
- 交互密集或语义型页面在 <head> 声明 <meta name="pi-bridge" content="capture=manual">，让"只有 emit 的操作"才被上报；
- action 用小写连字符命名（submit-answer、scene.say、scene.act、scene.ready 等）；自定义 action 的 payload 里带 semantic 字段自解释；
- 场景互动类页面：角色/物品由页面绘制；下行用 PiBridge.on 注册 scene.say{character,text,zh} / scene.move{character,x,duration} / scene.act{character,act} / scene.show|hide{character} / scene.highlight{target} / scene.update{task,progress,total} / scene.busy{busy} / scene.mic.status{status}；上行 emit('scene.ready', manifest) 报属性清单、emit('scene.item-click', {target,word,zh}) 报点物品、emit('scene.mic.press' | 'scene.mic.release') 触发宿主录音。
完整协议规范见仓库根 MATERIAL-BRIDGE-PROTOCOL.md（正文约定以上述为准）。`;
}

/**
 * 嵌套编程会话的事件 → 一行**给人看的**进度文案（ISSUE-146 P0-b）。
 *
 * 为什么要翻译：嵌套会话的事件不能直接转发（会污染父层轮内文本缓冲），但长工具跑 4~11 分钟
 * 期间家长只能看到「正在使用工具…」一动不动。这里把它压成一句可读文案，经 SDK 的 `onUpdate`
 * 变成 `tool_execution_update` → 父会话 publish `tool_progress` → 客户端气泡显示。
 */
function describeProgrammingEvent(event: any): string | undefined {
  const type = event?.type;
  if (type === "tool_execution_start") {
    const name = String(event?.toolName ?? "");
    if (name === "read") return "正在查看现有文件…";
    if (name === "write") return "正在写入资料文件…";
    if (name === "edit") return "正在修改资料文件…";
    return name ? `正在执行 ${name}…` : undefined;
  }
  if (type === "message_update") {
    const ame = event?.assistantMessageEvent;
    if (ame?.type === "thinking_delta") return "正在设计页面结构…";
    if (ame?.type === "text_delta") return "正在编写页面代码…";
  }
  return undefined;
}

/**
 * 进度节流器：子会话事件很密（每个 token 一个 delta），SSE 不能照单全收。
 * 保证**最小间隔** MIN_INTERVAL_MS，且相同文案不重复发（心跳文案含分钟数，会自然变化）。
 */
function createProgressReporter(onProgress?: (text: string) => void) {
  const MIN_INTERVAL_MS = 3000;
  let lastSentAt = 0;
  let lastText = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!lastText || !onProgress) return;
    lastSentAt = Date.now();
    onProgress(lastText);
  };
  return {
    report(text: string): void {
      if (!onProgress) return;
      const t = String(text ?? "").trim();
      if (!t || t === lastText) return;
      lastText = t;
      const wait = MIN_INTERVAL_MS - (Date.now() - lastSentAt);
      if (wait <= 0) flush();
      else if (!timer) timer = setTimeout(flush, wait);
    },
    stop(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

async function getProgrammingSession(
  deps: ProgrammingDeps,
  cwd: string,
  sessionKey: string,
  agentDir: string
): Promise<AgentSession> {
  const key = `${deps.parentId}:${sessionKey}`;
  const existing = sessions.get(key);
  if (existing) return existing;

  const settings = readParentSettings(deps.db, deps.dataDir, deps.parentId);
  const programmingKey =
    typeof settings.appSettings?.["programmingModel"] === "string"
      ? String(settings.appSettings["programmingModel"])
      : "";
  if (!programmingKey) {
    // 带 parentId 便于诊断「设置页显示已配置但 agent 报未配置」类问题（ISSUE-097）：
    // 立刻能看出 agent 读的是哪个家长的服务端 app_settings，是否与设置页登录账号一致。
    throw new Error(
      `编程 agent 未配置模型（家长 ${deps.parentId} 的服务端 app_settings 无 programmingModel）：` +
        `请到「设置 → 模型配置」选择「编程 agent 模型」并保存后重试`
    );
  }
  const runtime = await getWorkerRuntime(deps.dataDir, deps.parentId, settings.auth);
  const sep = programmingKey.indexOf("/");
  const provider = sep > 0 ? programmingKey.slice(0, sep) : programmingKey;
  const modelId = sep > 0 ? programmingKey.slice(sep + 1) : "";
  const model = provider && modelId ? runtime.getModel(provider, modelId) : undefined;
  if (!model) throw new Error(`编程 agent 模型不可用：${programmingKey}（请到设置页重新选择）`);

  fs.mkdirSync(agentDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPromptOverride: () => buildProgrammingPrompt(),
    noSkills: true,
    extensionFactories: [learningGuardExtension],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    tools: ["read", "write", "edit"],
    customTools: [],
  });
  sessions.set(key, session);
  return session;
}

export interface GenerateHtmlLessonInput {
  /** 课程/资料标题（用于文件头与命名） */
  title: string;
  /** 需求描述：结构、内容、交互要求等 */
  requirement: string;
  /**
   * 输出路径：家长侧 = **资料根相对路径** `<topic>/<file>.html`（恒落资料真源，兼容旧 `materials/` 前缀）；
   * 孩子侧 = 相对孩子工作区（如 `outputs/x.html`）。仅允许 .html/.htm。
   */
  outputPath: string;
  sessionKey?: string;
}

export interface GenerateHtmlLessonResult {
  /** 落盘后的绝对路径 */
  path: string;
  /** 相对路径（materials 相对资料根；否则相对工作区），供 display_content 使用 */
  relPath: string;
  title: string;
}

/**
 * 输出路径路由（纯函数，便于测试）。
 * - **家长侧（workspaceRoot 未传，parent_build_material）**：恒落资料真源 `<dataDir>/materials/<parentId>/`，
 *   path 为**资料根相对路径** `<topic>/<文件>.html`（与 parent_put_material/list/read 同一语法）；
 *   兼容旧的 `materials/` 虚拟前缀写法（剥掉，ISSUE-118：此前非 materials 前缀会静默落到
 *   家长工作区——不可穿管、无管理入口，已废除）。topic 段（第一级目录）与 /materials/upload 同规则
 *   （`^[a-zA-Z0-9_-]+$`），中文标题需先落一个合法 topic 目录。
 * - **孩子侧（workspaceRoot 已传，create_html_lesson）**：`materials/` 前缀 → 资料真源（保留既有行为）；
 *   其它（如 `outputs/x.html`）→ 该孩子工作区。仅允许 .html/.htm。
 */
export function resolveLessonOutputPath(
  deps: ProgrammingDeps,
  outputPath: string,
  workspaceRoot?: string
): { base: string; resolved: string; relPath: string } {
  const paths = createCorePaths(deps.dataDir);
  const raw = String(outputPath ?? "").trim();
  if (!/\.html?$/i.test(raw)) {
    throw new Error(`编程 agent 只产出 .html/.htm 文件（当前: ${raw}）`);
  }
  const parentScope = workspaceRoot === undefined;
  const isMaterial = raw.startsWith("materials/");
  if (parentScope) {
    const relInBase = raw.replace(/^materials\//, "");
    const topic = relInBase.split("/")[0] ?? "";
    if (!/^[a-zA-Z0-9_-]+$/.test(topic)) {
      throw new Error(
        `path 须为资料根相对路径 <topic>/<文件>.html，topic（第一级目录）仅允许字母/数字/_/-，收到：${raw}` +
          `（示例：materials/lunyu/lesson-01.html 或 lunyu/lesson-01.html → topic=lunyu）`
      );
    }
    const base = materialsRoot(deps.dataDir, deps.parentId);
    const resolved = resolveWithin(base, relInBase);
    return { base, resolved, relPath: `materials/${relInBase}` };
  }
  const base = isMaterial ? materialsRoot(deps.dataDir, deps.parentId) : workspaceRoot;
  const relInBase = isMaterial ? raw.slice("materials/".length) : raw;
  let resolved: string;
  try {
    resolved = resolveWithin(base!, relInBase);
  } catch (err) {
    throw new Error(`输出路径超出允许范围：${raw}（${(err as Error).message}）`);
  }
  return { base: base!, resolved, relPath: isMaterial ? `materials/${relInBase}` : relInBase };
}

export interface GenerateHtmlLessonHooks {
  /** 进度回报（已节流，一行可读文案）→ SDK onUpdate → 父会话 SSE `tool_progress`（ISSUE-146 P0-b） */
  onProgress?: (text: string) => void;
  /** 父层中止信号：透传到嵌套编程会话（否则 11 分钟的生成无法被父层「停止」打断，ISSUE-146 P0-c） */
  signal?: AbortSignal;
}

/** 生成/修改一份 HTML 资料并落盘（含沙箱校验与落盘校验）。
 * @param workspaceRoot 非 materials 输出的落盘根（孩子调用时=孩子工作区）；不传时=家长侧，恒落资料真源。
 * @param hooks 进度回报与中止传播（ISSUE-146 P0；不传＝行为同旧版）
 */
export async function generateHtmlLesson(
  deps: ProgrammingDeps,
  input: GenerateHtmlLessonInput,
  workspaceRoot?: string,
  hooks?: GenerateHtmlLessonHooks
): Promise<GenerateHtmlLessonResult> {
  const paths = createCorePaths(deps.dataDir);
  const { base, resolved, relPath } = resolveLessonOutputPath(deps, input.outputPath, workspaceRoot);

  // ISSUE-131 P2：编程 agent 的 .pi 运行区进 scratch（家长=workspaces/<pid>/scratch，孩子=<cid>/scratch），
  // 不再长进资产区/工作区；输出 base 不变，sessionKey 机制不变（生成+改上下文连续）。
  const agentDir = path.join(workspaceRoot ? path.join(workspaceRoot, "scratch") : paths.agentScratchDir(deps.parentId), ".pi", "agent");

  // 迁移即用：目标只存在于旧 materials 根（存量不迁移策略）时，先复制到新根再按「修改已有」走，
  // 单源写入点恒为新根，避免新旧双份漂移。
  if (!fs.existsSync(resolved) && base === materialsRoot(deps.dataDir, deps.parentId)) {
    const legacyAbs = path.join(legacyMaterialsRoot(deps.dataDir, deps.parentId), relPath.replace(/^materials\//, ""));
    if (fs.existsSync(legacyAbs)) {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.copyFileSync(legacyAbs, resolved);
    }
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const session = await getProgrammingSession(deps, base, input.sessionKey ?? input.outputPath, agentDir);
  const existedBefore = fs.existsSync(resolved);
  const prompt = [
    existedBefore ? "修改已有文件：" : "生成新文件：",
    `标题：${input.title}`,
    `输出路径：${resolved}（绝对路径，务必写到这个绝对路径，不要写到其他位置）`,
    "",
    "需求：",
    input.requirement,
    "",
    existedBefore
      ? `原文件已存在（${resolved}），请先 read 原文件，在保留原有内容结构的基础上按需求修改，改完用 write 覆盖同一绝对路径。`
      : "文件还不存在，请用 write 创建；写完确认落盘成功。",
  ].join("\n");

  const t0 = Date.now();
  // ISSUE-146 P0：① 子会话事件 → 节流后的可读进度；② 15s 心跳，保证「黑洞期」也有进度可看；
  // ③ signal → session.abort()，让父层的「停止」按钮能真的打断这场生成（旧版做不到）。
  const reporter = createProgressReporter(hooks?.onProgress);
  const unsubscribe = hooks?.onProgress
    ? session.subscribe((event: any) => {
        const label = describeProgrammingEvent(event);
        if (label) reporter.report(label);
      })
    : undefined;
  const heartbeat = hooks?.onProgress
    ? setInterval(() => reporter.report(`生成中…（已 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟）`), 15000)
    : null;
  const onAbort = () => {
    void session.abort().catch(() => undefined);
  };
  if (hooks?.signal) {
    if (hooks.signal.aborted) onAbort();
    else hooks.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    await session.prompt(prompt);
  } finally {
    // ⚠️ 必须退订：编程会话按 sessionKey **复用**，不退订会让订阅者随每次生成累积
    hooks?.signal?.removeEventListener("abort", onAbort);
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    reporter.stop();
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!fs.existsSync(resolved) || fs.statSync(resolved).size < 100) {
    throw new Error(
      `编程 agent 未能成功写入 ${input.outputPath}（文件不存在或为空）。常见原因与处理：` +
        `① 未按要求的绝对路径落盘——可换更明确的需求重试（强调「把完整 HTML 写到 ${resolved}」）；` +
        `② 生成中途出错/内容被截断——可重试；若反复失败，检查「编程 agent 模型」是否可用或换模型再试`
    );
  }
  console.log(
    `[programming-agent] 生成完成 ${input.outputPath}（${fs.statSync(resolved).size}B，耗时 ${elapsed}s）`
  );
  return { path: resolved, relPath, title: input.title };
}

/** 释放全部编程会话（重启/测试清理）。 */
export function disposeProgrammingSessions(): void {
  for (const [key, s] of sessions) {
    try {
      s.dispose();
    } catch {
      /* 忽略 */
    }
    sessions.delete(key);
  }
}

/**
 * 生成「编程 agent 调用工具」：家长侧叫 parent_build_material（产出学习资料到真源），
 * 孩子侧叫 create_html_lesson（产出游戏/工具页到孩子工作区）。
 * 两者共用同一编程 agent 与协议 prompt，只是输出根与命名不同——分开命名是为了让模型一眼看懂
 * 「这份产出归谁、放哪里」。
 */
export function createProgrammingTool(
  deps: ProgrammingDeps,
  opts: { scope: "parent" | "child"; childId?: string }
) {
  const isChild = opts.scope === "child";
  const workspaceRoot = isChild
    ? createCorePaths(deps.dataDir).childWorkspaceDir(deps.parentId, opts.childId ?? "")
    : undefined;
  return defineTool({
    name: isChild ? "create_html_lesson" : "parent_build_material",
    label: isChild ? "制作 HTML 学习页/小工具" : "用编程 agent 制作学习资料",
    description: isChild
      ? "让编程 agent 制作一份 HTML 页面（小游戏/互动练习/小工具），产出会放到你的工作区。\n\n" +
        "**何时调用**：孩子想要一个可以点着玩的小页面、或需要交互式练习页时。\n" +
        "**注意**：只产出 HTML 文件，具体落盘位置由系统决定；产出后可用 display_content 展示给孩子。"
      : "让编程 agent 按需求制作/修改一份 HTML 学习资料，并写入课程资料真源。\n\n" +
        "**何时调用**：需要给某课生成互动练习页、绘本页、小游戏时（家长描述好需求与交互）。\n" +
        "**path**：资料真源相对路径 `<topic>/<文件>.html`，如 `lunyu/lesson-01.html`（与 parent_put_material 同语法；兼容旧 `materials/` 前缀写法）。必须以 .html/.htm 结尾。\n" +
        "**注意**：编程 agent 未配置模型时会明确报错，需家长先到设置页选择「编程 agent 模型」。",
    parameters: Type.Object({
      title: Type.String({ description: "资料标题（如「论语学而篇 互动练习」）" }),
      requirement: Type.String({ description: "需求描述：内容、结构、交互要求（越具体越好）" }),
      path: isChild
        ? Type.Optional(Type.String({ description: "输出相对路径（缺省 outputs/<标题>.html）" }))
        : Type.String({ description: "资料真源相对路径 <topic>/<文件>.html（如 lunyu/lesson-01.html，与 parent_put_material 同语法）" }),
    }),
    execute: async (_id: string, params: any, signal?: AbortSignal, onUpdate?: (partial: any) => void) => {
      const title = String(params?.title ?? "").trim();
      const requirement = String(params?.requirement ?? "").trim();
      if (!title || !requirement) throw new Error("title 与 requirement 都必填");
      const safeName = title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 60);
      const outputPath = isChild
        ? String(params?.path ?? `outputs/${safeName}.html`)
        : String(params?.path ?? "").trim();
      if (!outputPath) throw new Error("path 必填（如 materials/<topic>/<文件>.html）");
      const r = await generateHtmlLesson(deps, { title, requirement, outputPath }, workspaceRoot, {
        // ISSUE-146 P0：进度经 SDK 转成 tool_execution_update（父会话 publish `tool_progress`）；
        // 中止信号透传，让父层 abort 能打断嵌套的编程会话。两者都是**可选**形参，
        // 直调（脚本/测试）时不传即保持旧行为。
        onProgress: onUpdate
          ? (text: string) => onUpdate({ content: [{ type: "text" as const, text }], details: { progress: text } })
          : undefined,
        signal,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `已生成「${r.title}」→ ${r.relPath}（${fs.statSync(r.path).size} 字节）。`,
          },
        ],
        details: { path: r.relPath, absPath: r.path },
      };
    },
  });
}
