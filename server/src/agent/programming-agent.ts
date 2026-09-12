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
  defineTool,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createCorePaths, getWorkerRuntime, learningGuardExtension, resolveWithin } from "@pi/agent-core";
import { materialsRoot } from "../db/materials.js";
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

async function getProgrammingSession(deps: ProgrammingDeps, cwd: string, sessionKey: string): Promise<AgentSession> {
  const key = `${deps.parentId}:${sessionKey}`;
  const existing = sessions.get(key);
  if (existing) return existing;

  const settings = readParentSettings(deps.db, deps.dataDir, deps.parentId);
  const programmingKey =
    typeof settings.appSettings?.["programmingModel"] === "string"
      ? String(settings.appSettings["programmingModel"])
      : "";
  if (!programmingKey) {
    throw new Error("编程 agent 未配置模型：请到「设置 → 模型配置」选择「编程 agent 模型」后重试");
  }
  const runtime = await getWorkerRuntime(deps.dataDir, deps.parentId, settings.auth);
  const sep = programmingKey.indexOf("/");
  const provider = sep > 0 ? programmingKey.slice(0, sep) : programmingKey;
  const modelId = sep > 0 ? programmingKey.slice(sep + 1) : "";
  const model = provider && modelId ? runtime.getModel(provider, modelId) : undefined;
  if (!model) throw new Error(`编程 agent 模型不可用：${programmingKey}（请到设置页重新选择）`);

  const agentDir = path.join(cwd, ".pi", "agent");
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
   * 输出路径：`materials/<topic>/<file>.html` → 家长资料真源；
   * 其它（如 `outputs/x.html`）→ 该家长工作区。仅允许 .html/.htm。
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

/** 生成/修改一份 HTML 资料并落盘（含沙箱校验与落盘校验）。
 * @param workspaceRoot 非 materials 输出的落盘根（家长调用时=家长工作区；孩子调用时=孩子工作区）；
 *                      不传时默认家长工作区。
 */
export async function generateHtmlLesson(
  deps: ProgrammingDeps,
  input: GenerateHtmlLessonInput,
  workspaceRoot?: string
): Promise<GenerateHtmlLessonResult> {
  const paths = createCorePaths(deps.dataDir);
  const isMaterial = input.outputPath.startsWith("materials/");
  const base = isMaterial
    ? materialsRoot(deps.dataDir, deps.parentId)
    : workspaceRoot ?? paths.childWorkspaceDir(deps.parentId, "parent");
  const relInBase = isMaterial ? input.outputPath.slice("materials/".length) : input.outputPath;
  let resolved: string;
  try {
    resolved = resolveWithin(base, relInBase);
  } catch (err) {
    throw new Error(`输出路径超出允许范围：${input.outputPath}（${(err as Error).message}）`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== ".html" && ext !== ".htm") {
    throw new Error(`编程 agent 只产出 .html/.htm 文件（当前: ${input.outputPath}）`);
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const session = await getProgrammingSession(deps, base, input.sessionKey ?? input.outputPath);
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
  await session.prompt(prompt);
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
  return { path: resolved, relPath: isMaterial ? `materials/${relInBase}` : relInBase, title: input.title };
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
        "**path**：资料真源相对路径，如 `materials/lunyu/lesson-01.html`（必须以 .html/.htm 结尾）。\n" +
        "**注意**：编程 agent 未配置模型时会明确报错，需家长先到设置页选择「编程 agent 模型」。",
    parameters: Type.Object({
      title: Type.String({ description: "资料标题（如「论语学而篇 互动练习」）" }),
      requirement: Type.String({ description: "需求描述：内容、结构、交互要求（越具体越好）" }),
      path: isChild
        ? Type.Optional(Type.String({ description: "输出相对路径（缺省 outputs/<标题>.html）" }))
        : Type.String({ description: "输出路径（相对资料根，如 materials/<topic>/<文件>.html）" }),
    }),
    execute: async (_id: string, params: any) => {
      const title = String(params?.title ?? "").trim();
      const requirement = String(params?.requirement ?? "").trim();
      if (!title || !requirement) throw new Error("title 与 requirement 都必填");
      const safeName = title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 60);
      const outputPath = isChild
        ? String(params?.path ?? `outputs/${safeName}.html`)
        : String(params?.path ?? "").trim();
      if (!outputPath) throw new Error("path 必填（如 materials/<topic>/<文件>.html）");
      const r = await generateHtmlLesson(deps, { title, requirement, outputPath }, workspaceRoot);
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
