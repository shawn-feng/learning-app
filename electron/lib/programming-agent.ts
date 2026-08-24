import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import path from "path";
import fs from "fs";
import { getChildDir } from "./config";
import { getParentMaterialsDir } from "./parent-library";
import { getSharedRuntime, getProgrammingModel } from "./pi-runtime";
import learningGuardExtension from "../extensions/learning-guard";

/**
 * 编程 agent（ISSUE-020）：专门负责把学习 agent 的需求描述转成儿童友好的自包含 HTML 学习资料。
 *
 * 设计要点：
 * - 独立会话：与学习 agent、家长助手完全隔离，不共享上下文；cwd = 孩子学习目录。
 * - 按 sessionKey 复用：同一份 HTML 的「生成 + 后续修改」在同一个编程会话里完成
 *   （工具参数 sessionKey 控制创建/复用），不重置——避免重复初始化，也避免上次任务污染本次上下文。
 * - 模型可配置：默认未配置 = 不可用，generateHtmlLesson 抛错并提示家长到设置页配置；
 *   只有家长在设置页选了「编程 agent 模型」后才能调用。
 * - 职责单一：只负责把 HTML 写到指定路径，不挂 kb_* / display_content，纯代码生成。
 */

const programmingSessions = new Map<string, AgentSession>();

function buildProgrammingPrompt(): string {
  return `你是「编程 agent」，专门负责把需求描述变成一份可直接给孩子用的 HTML 学习资料。
你的工作目录是某个孩子的学习目录（cwd）。

## 职责
- 只做 HTML 代码生成与修改，不做教学内容设计（内容设计由调用方学习 agent 负责）。
- 输出必须是一个**自包含**的 .html 文件：内联 CSS/JS，不依赖任何外部网络资源（本地图片/音频可用相对路径或 media:// 协议）。
- 面向儿童：大字号、高对比度、明亮的配色、点击卡片等交互，让低龄孩子也能独立操作。

## 工作方式
- 收到需求后，把 HTML 写到调用方指定的输出路径（相对 cwd）。具体落到什么路径由调用方（学习 agent）决定，你只负责写到这个路径，不关心学习资料等其它类型的归档位置。
- 修改已有文件时，先 read 原文件再 edit/write，保留已有内容结构，只改需要改的部分。
- 写完必须确认文件已落盘（write 成功返回即已落盘）。

## 职责边界
- 你只负责 HTML 代码生成与修改，不负责教学内容设计与传达：kb_* 工具与 display_content 工具由调用方学习 agent 使用，你不需要也无法调用它们；教学内容由学习 agent 提供，你只把它落成 HTML 文件。
- 你只写调用方指定的输出路径（可能是孩子本地的 \`outputs/\` 目录，或父库共享的 \`materials/\` 目录），不写到其它位置；不要去读或写其它孩子的数据，也不要调用 kb_*/display_content。
- 你只产出 HTML 文件，不在回复里写教学步骤或给孩子讲课——教学内容由学习 agent 负责传达。`;
}

/**
 * 获取（或创建）某个 sessionKey 对应的编程 agent 会话。
 * sessionKey 通常由调用方按输出路径派生（如 "lunyu-论语先进篇第十三章"），
 * 同一 key 复用同一会话，保证「生成 + 后续修改」上下文连续。
 */
export async function getProgrammingAgentSession(
  childId: string,
  sessionKey: string
): Promise<AgentSession> {
  const key = `${childId}:${sessionKey}`;
  const existing = programmingSessions.get(key);
  if (existing) return existing;

  const childDir = getChildDir(childId);
  const model = await getProgrammingModel();
  if (!model) {
    throw new Error(
      "编程 agent 未配置模型：请到「设置 → 模型配置」选择「编程 agent 模型」后重试"
    );
  }
  const modelRuntime = await getSharedRuntime();

  const loader = new DefaultResourceLoader({
    cwd: childDir,
    // 必须显式传 agentDir：SDK 构造时对 agentDir 调 resolvePath，Windows 下传 undefined 会
    // 在 normalizeWindowsShellPath 里 undefined.startsWith 崩溃（珊珊会话 create_html_lesson 实测报错）。
    // 与学习 agent 一致，隔离到该孩子的 .pi/agent。
    agentDir: path.join(childDir, ".pi", "agent"),
    systemPromptOverride: () => buildProgrammingPrompt(),
    // 编程 agent 同样不需要全局技能索引（~/.agents/skills 60 个无关技能），noSkills 关掉。
    noSkills: true,
    // 越界读写拦截 + 每轮日期注入（写 HTML 内容里的日期、文件名命名都可能用到）。
    // extension 必须挂 extensionFactories（createAgentSession 的 extensions 参数无效）。
    extensionFactories: [learningGuardExtension],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: childDir,
    modelRuntime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    // 编程 agent 只做代码生成：read/write/edit 足够，不挂 kb_*/display_content。
    tools: ["read", "write", "edit"],
    customTools: [],
  });

  programmingSessions.set(key, session);
  return session;
}

export interface GenerateHtmlLessonInput {
  childId: string;
  /** 课程标题（如「论语先进篇第十三章」），用于命名与文件头注释 */
  title: string;
  /** 需求描述：结构、内容、交互要求等（由学习 agent 从 method/材料整理） */
  requirement: string;
  /** 输出路径（相对格式：工具/游戏用 outputs/{名称}.html，学习资料用 materials/{topic}/{课程名}.html；函数内部锚定到正确根目录并以绝对路径写出） */
  outputPath: string;
  /** 会话键：同一份 HTML 的生成/修改复用同一会话；缺省按 outputPath 派生 */
  sessionKey?: string;
}

export interface GenerateHtmlLessonResult {
  /** 落盘后的文件绝对路径 */
  path: string;
  /** 相对学习目录的路径（供 display_content 使用） */
  relPath: string;
  title: string;
}

interface PhaseStats {
  /** 首 token 延迟（ms）：prompt 发起 → 第一个 thinking/text delta */
  firstTokenMs: number;
  /** 思考流式时长（ms）：首个 thinking_delta → 首个 text_delta（无思考则为 0） */
  thinkMs: number;
  /** 正文输出流式时长（ms）：首个 text_delta → 最后一次 agent_end（含期间工具执行，近似） */
  textMs: number;
  /** 工具调用次数 */
  toolCalls: number;
}

/**
 * 订阅会话流式事件，统计一次 prompt 的「思考 vs 输出」阶段耗时（近似拆分）：
 * 思考 = 首个 thinking_delta → 首个 text_delta；输出 = 首个 text_delta → 最后一次 agent_end。
 * 返回取数函数；prompt 结束后调用取统计并取消订阅。
 */
function collectPhaseStats(session: any, t0: number): () => PhaseStats {
  let thinkStart: number | null = null;
  let textStart: number | null = null;
  let textEnd: number | null = null;
  let toolCalls = 0;
  const unsub = session.subscribe((event: any) => {
    const now = Date.now();
    if (event.type === "message_update") {
      const t = event.assistantMessageEvent?.type;
      if (t === "thinking_delta") {
        if (thinkStart === null) thinkStart = now;
      } else if (t === "text_delta") {
        if (textStart === null) textStart = now;
      }
    } else if (event.type === "tool_execution_start") {
      toolCalls++;
    } else if (event.type === "agent_end" || event.type === "message_end") {
      textEnd = now;
    }
  });
  return () => {
    try {
      unsub();
    } catch {
      /* 忽略取消订阅失败 */
    }
    const first = thinkStart ?? textStart ?? 0;
    return {
      firstTokenMs: first ? first - t0 : 0,
      thinkMs: thinkStart && textStart ? textStart - thinkStart : 0,
      textMs: textStart && textEnd ? textEnd - textStart : 0,
      toolCalls,
    };
  };
}

/**
 * 让编程 agent 生成/修改一份 HTML 学习资料并落盘。
 * - 未配置编程模型 → 抛错（提示家长去设置页配置）。
 * - outputPath 必须位于孩子学习目录内（Path Guard）。
 * - 生成后校验文件确实落盘且非空，避免「AI 声称写完但没写」。
 */
export async function generateHtmlLesson(
  input: GenerateHtmlLessonInput
): Promise<GenerateHtmlLessonResult> {
  const { childId, title, requirement, outputPath, sessionKey } = input;
  const childDir = getChildDir(childId);

  // 锚定到正确根目录：工具/游戏（outputs/...）落在孩子学习目录；学习资料（materials/...）落在父库共享目录。
  // 之后以绝对路径交给编程 agent 写出——资料直接落盘到唯一真源，不需要镜像或软链接。
  const isMaterial = outputPath.startsWith("materials/");
  const base = isMaterial ? getParentMaterialsDir() : childDir;
  const relInBase = isMaterial ? outputPath.slice("materials/".length) : outputPath;
  const resolved = path.resolve(base, relInBase);
  const guardRoot = base;
  if (resolved !== guardRoot && !resolved.startsWith(guardRoot + path.sep)) {
    throw new Error(`输出路径超出允许范围: ${outputPath}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== ".html" && ext !== ".htm") {
    throw new Error(`编程 agent 只产出 .html/.htm 文件（当前: ${outputPath}）`);
  }

  // 环节计时：定位耗时（2026-08-24 用户反馈单次生成 ~4 分钟，需区分会话创建 / LLM 生成 / 落盘）
  const t0 = Date.now();

  const session = await getProgrammingAgentSession(childId, sessionKey ?? outputPath);
  const t1 = Date.now();

  // 预建目录（materials/{topic}/ 或 outputs/），避免 write 因目录不存在失败
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const existedBefore = fs.existsSync(resolved);
  const prompt = [
    existedBefore ? "修改已有文件：" : "生成新文件：",
    `标题：${title}`,
    `输出路径：${resolved}（绝对路径，务必写到这个绝对路径，不要写到其他位置）`,
    "",
    "需求：",
    requirement,
    "",
    existedBefore
      ? `原文件已存在（${resolved}），请先 read 原文件，在保留原有内容结构的基础上按需求修改，改完用 write 覆盖同一绝对路径。`
      : "文件还不存在，请用 write 创建；写完确认落盘成功。",
  ].join("\n");

  // 订阅流式事件，统计本次 prompt 的「思考 vs 输出」阶段耗时
  const stats = collectPhaseStats(session, Date.now());
  await session.prompt(prompt);
  const t2 = Date.now();
  const s = stats();
  console.log(
    `[programming-agent] LLM 阶段：首 token ${(s.firstTokenMs / 1000).toFixed(1)}s + 思考 ${(s.thinkMs / 1000).toFixed(1)}s + 正文输出 ${(s.textMs / 1000).toFixed(1)}s（工具调用 ${s.toolCalls} 次）`
  );

  // 校验落盘：文件必须存在且非空（阈值 100 字节，防空壳/半截写入）
  if (!fs.existsSync(resolved) || fs.statSync(resolved).size < 100) {
    throw new Error(`编程 agent 未能成功写入 ${outputPath}（文件不存在或为空），请重试`);
  }
  const t3 = Date.now();
  console.log(
    `[programming-agent] generateHtmlLesson 耗时 ${((t3 - t0) / 1000).toFixed(1)}s：` +
      `会话获取/创建 ${((t1 - t0) / 1000).toFixed(1)}s + LLM 生成 ${((t2 - t1) / 1000).toFixed(1)}s + 落盘校验 ${((t3 - t2) / 1000).toFixed(1)}s` +
      `（file=${outputPath} size=${fs.statSync(resolved).size}B）`
  );

  return {
    path: resolved,
    relPath: outputPath,
    title,
  };
}

/** 释放全部编程会话（应用退出时调用）。 */
export async function disposeProgrammingSessions(): Promise<void> {
  for (const [key, session] of programmingSessions) {
    try {
      session.dispose();
    } catch {
      /* 忽略单会话释放失败 */
    }
    programmingSessions.delete(key);
  }
}
