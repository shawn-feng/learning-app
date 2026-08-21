import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import path from "path";
import fs from "fs";
import { getChildDir } from "./config";
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
- 收到需求后，把 HTML 写到调用方指定的输出路径（相对 cwd），不要写到别处。
- 修改已有文件时，先 read 原文件再 edit/write，保留已有内容结构，只改需要改的部分。
- 写完必须确认文件已落盘（write 成功返回即已落盘）。

## 禁止
- 不要使用 kb_* 工具、display_content 工具——它们不属于你。
- 不要写 cwd 之外的文件。
- 不要输出教学步骤、不要给孩子讲课——你只产出 HTML 文件。`;
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
  /** 输出路径（相对孩子学习目录），如 learning/lunyu/materials/论语先进篇第十三章.html */
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

  // 路径守卫：只允许写学习目录内文件
  const resolved = path.resolve(childDir, outputPath);
  if (resolved !== childDir && !resolved.startsWith(childDir + path.sep)) {
    throw new Error(`输出路径超出学习目录范围: ${outputPath}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== ".html" && ext !== ".htm") {
    throw new Error(`编程 agent 只产出 .html/.htm 文件（当前: ${outputPath}）`);
  }

  const session = await getProgrammingAgentSession(childId, sessionKey ?? outputPath);

  // 预建目录（如 learning/{topic}/materials/），避免 write 因目录不存在失败
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const existedBefore = fs.existsSync(resolved);
  const prompt = [
    existedBefore ? "修改已有文件：" : "生成新文件：",
    `标题：${title}`,
    `输出路径：${outputPath}（相对 cwd，务必写到这个路径，不要写到其他位置）`,
    "",
    "需求：",
    requirement,
    "",
    existedBefore
      ? `原文件已存在（${outputPath}），请先 read 原文件，在保留原有内容结构的基础上按需求修改，改完用 write 覆盖同一路径。`
      : "文件还不存在，请用 write 创建；写完确认落盘成功。",
  ].join("\n");

  await session.prompt(prompt);

  // 校验落盘：文件必须存在且非空（阈值 100 字节，防空壳/半截写入）
  if (!fs.existsSync(resolved) || fs.statSync(resolved).size < 100) {
    throw new Error(`编程 agent 未能成功写入 ${outputPath}（文件不存在或为空），请重试`);
  }

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
