import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import path from "path";
import fs from "fs";
import { getChildDir, getSkillsDir, getDataDir } from "./config";
import { getSharedRuntime, getDefaultModel } from "./pi-runtime";
import { displayContentTool, getDateTool } from "./custom-tools";
import { getProfile, type ChildProfile } from "./child-auth";
import learningGuardExtension from "../extensions/learning-guard";

const LEARNING_NAV_INSTRUCTIONS = `
## 行为规范

### 学习
孩子要学习某个主题时：
1. 先读 \`learning/topics.md\`（主题知识列表），找到对应主题及其方法文件
2. 读该主题的 \`method.md\`，按其中描述的教学方法引导孩子学习
（教学步骤、考核方式、教学资料位置都在 method.md 里）

### 记录
学习总结、生活事件等记录由 recording 技能负责，按需调用（详见其 SKILL.md）。

### 内容展示
用 display_content 工具向孩子展示内容，支持 markdown 和 html。

## 你的角色

你是孩子的良师益友，日常交流围绕三个角色：

### 良师 - 学习
- 有进步、有思考时，明确说出来肯定
- 孩子有疑惑时，不直接给标准答案，先倾听、引导他自己想

### 益友 - 生活
- 孩子来了先自然问候，不直接进入学习模式
- 认真听、配合聊，不敷衍不忽视
- 从生活话题自然引导应用已学知识，不强行说教
- 不评判孩子的选择——听、理解、必要时给建议

### 智囊 - 答疑
- 不懂就承认，不瞎编。查了再回答
- 用孩子能理解的方式解释，不炫术语
- 有时候倾听和讨论比答案更重要
`;

const CUSTOM_START = "<!-- custom:start -->";
const CUSTOM_END = "<!-- custom:end -->";

function extractCustomSection(content: string): string {
  const match = content.match(
    /<!--\s*custom:start\s*-->([\s\S]*?)<!--\s*custom:end\s*-->/
  );
  return match ? match[1] : "";
}

export function buildAgentsMd(profile: ChildProfile): string {
  return `你是${profile.aiName}，${profile.name}的学习伙伴。

## 你的身份
- 名字：${profile.aiName}
- 图标：${profile.aiEmoji || "🤖"}
- 性格：${profile.aiPersonality}

## 你的学生
- 名字：${profile.name}
- 年龄：${profile.age}岁
- 年级：${profile.grade}
- 兴趣爱好：${profile.interests}

${LEARNING_NAV_INSTRUCTIONS}

${CUSTOM_START}
${CUSTOM_END}
`;
}

export function writeAgentsMd(childId: string, profile: ChildProfile): void {
  const childDir = getChildDir(childId);
  const filePath = path.join(childDir, "AGENTS.md");

  // 保留家长在 custom 段内手动编辑的内容
  let customContent = "";
  if (fs.existsSync(filePath)) {
    customContent = extractCustomSection(fs.readFileSync(filePath, "utf-8"));
  }

  const full = buildAgentsMd(profile).replace(
    /<!--\s*custom:start\s*-->[\s\S]*?<!--\s*custom:end\s*-->/,
    `${CUSTOM_START}\n${customContent}${CUSTOM_END}`
  );

  fs.writeFileSync(filePath, full, "utf-8");
}

function buildParentPrompt(): string {
  return `你是家长工作台助手，帮助家长管理孩子的学习内容和教学技能。

你的工作目录是数据根目录（data/），用相对路径访问以下内容：

## 目录结构
\`\`\`
shared/skills/                 # 教学技能
  {skill}/SKILL.md             #   技能说明和教学流程（必需）
  {skill}/materials/           #   教学资料（可选）
  {skill}/references/          #   参考文档（可选）
children/{childId}/            # 每个孩子一个目录
  profile.json                 #   孩子的名字/年龄/兴趣等
  learning/                    #   孩子的学习主题
    topics.md                  #   主题清单
    rules.md                   #   学习规则（每日目标量）
    {topic}/                   #   每个主题一个自包含目录
      {topic}.md               #   进度文件（frontmatter + 每课 ### 课程名 + 状态）
      method.md                #   教学方法
      materials/{课程名}.md     #   每课教学文案
      media/                   #   音视频（家长放文件，文件名与课程名逐字一致）
\`\`\`

家长提到孩子名字时，先读 children/ 下各目录的 profile.json 找到对应 childId。

## 能力一：编辑教学技能
技能结构：SKILL.md（必需）+ materials/（可选）+ references/（可选）。
SKILL.md 格式：frontmatter（name/description）+ 工作流程。
根据家长需求创建或修改技能文件（在 shared/skills/ 下）。

## 能力二：引导生成教学内容（学习主题）
帮家长完成一个学习主题所需的全部文件，分 6 步引导，可中断、可只做某一步：

1. 确认主题：key（英文目录名）、主题名、必学/选学、每日目标量。
2. 进度文件 {topic}.md：frontmatter（topic/learned/total/next/updated）+ 每课「### 课程名」+ 状态「⬜」。
3. method.md：教学步骤（分几步、每步考核方式、教学资料位置）。
4. 逐课文案 materials/{课程名}.md：原文/翻译/道理/典故等。三种方式：家长粘贴文本你来结构化、家长上传文件你来解析、你起草家长确认。
5. 登记：更新 topics.md 的 topics 数组 + rules.md 的 rules。
6. 音视频 + html：提示家长把 mp3/mp4 放进 media/（文件名与课程名逐字一致）。html 学习资料（给孩子看的展示版）由你灵活处理——无共性格式就手工拼 html 用 display_content 展示；每课有共同格式（如论语每章「原文吟诵/白话翻译/道理应用」）就写一个该主题专用脚本批量转 html（可参考 scripts/generate-lessons.mjs）。

## 文件结构约定
- 进度文件 frontmatter：topic、learned（已学数）、total（总数）、next（下一课）、updated（日期）。
- topics.md frontmatter：topics 数组，每项 {name, file, method, progress}，其中 file 相对 learning/ 目录（如 lunyu/lunyu.md）。
- rules.md frontmatter：rules 对象，每项 {主题: {daily, type: 必学|选学}}。
- 课程名、materials 文件名、media 文件名三者逐字一致。

请根据家长的需求，创建或修改技能文件、引导生成教学内容。
`;
}

/**
 * 孩子会话的 system prompt 头部（替换 SDK 默认的 "expert coding assistant" 身份 + Pi 文档噪声）。
 * 注意：SDK 在 customPrompt 模式下仍会自动附加 <project_context>（AGENTS.md）、
 * <available_skills> 技能段、Current working directory 与学习守护扩展的时间注入，
 * 所以这里只负责「身份 + 通用准则」，孩子的详细行为规范由 AGENTS.md 提供（家长可在 custom 段编辑）。
 */
function buildChildPrompt(profile: ChildProfile): string {
  const emoji = profile.aiEmoji || "🌟";
  return `你是${profile.aiName}（${emoji}），${profile.name}的学习伙伴，不是编程助手。你在孩子的学习空间里工作，通过读写孩子的学习记录、用 display_content 展示学习内容来陪伴和引导${profile.name}学习。

## 交流准则
- 用${profile.age}岁孩子听得懂的话说话，简短、亲切，不堆术语
- 回答保持简洁，不输出长篇大论
- 不懂就承认，不瞎编；需要查资料时用工具读文件
- 展示学习内容（markdown / HTML 卡片）一律用 display_content 工具
- 你的身份、性格与完整行为规范以 AGENTS.md 为准`;
}

interface SessionEntry {
  session: AgentSession;
  childId: string;
}

const activeSessions = new Map<string, SessionEntry>();
let cachedParentSession: AgentSession | null = null;

export async function getChildSession(
  childId: string
): Promise<AgentSession> {
  const existing = activeSessions.get(childId);
  if (existing) return existing.session;

  const childDir = getChildDir(childId);
  const profile = getProfile(childId);
  if (!profile) throw new Error("Child profile not found");

  const modelRuntime = await getSharedRuntime();
  const model = await getDefaultModel();

  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    // 替换 SDK 默认 base：去掉 "expert coding assistant" 身份与 Pi 自身文档索引（对孩子是噪声），
    // 换成孩子专属的学习伙伴身份。AGENTS.md / 技能段 / cwd / 时间注入由 SDK 在 customPrompt 模式下自动附加。
    systemPromptOverride: () => buildChildPrompt(profile),
    // 教学技能在 shared/skills（recording / study-tracker），孩子默认扫描路径不含它，
    // 此前 <available_skills> 段为空，AGENTS.md 里写的 recording 技能孩子根本发现不了。
    // 注意：noSkills 必须为 true —— SDK 的 packageManager 会自动发现并启用 ~/.agents/skills
    // 下全部全局技能（agent-browser / bilibili-cli / code-reviewer 等 60 个），
    // 不关掉的话这些无关技能会全量进孩子 <available_skills> 索引，纯噪声还占 token。
    noSkills: true,
    additionalSkillPaths: [getSkillsDir()],
    // 注意：SDK 的 createAgentSession 从不读取 options.extensions（该参数被静默忽略），
    // 扩展必须挂在 DefaultResourceLoader 的 extensionFactories 上才会被加载。
    // 此前 learning-guard（before_agent_start 时间注入 + 越界读写拦截）一直没生效，
    // 导致 AI 拿不到当前日期时间（8/14~8/17 多次猜错日期/沿用旧日期）。
    extensionFactories: [learningGuardExtension],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: childDir,
    modelRuntime,
    model,
    sessionManager: SessionManager.continueRecent(childDir, path.join(childDir, ".pi", "agent", "sessions")),
    resourceLoader: loader,
    tools: ["read", "write", "edit", "display_content", "get_date"],
    customTools: [displayContentTool, getDateTool],
  });

  // 修复历史遗留：早期 qwen 配 reasoning:false 时，切到该模型会把会话 thinkingLevel 卡成 "off"，
  // 之后即便 qwen 已改成 reasoning:true，切模型时 SDK 仍沿用会话里的 "off"，导致 enable_thinking=false、
  // 思考过程混进正文（无 thinking 块、无 🧠 按钮）。前端没有思考等级切换入口，"off" 非用户主动选择，
  // 进入会话时强制纠正为 high（deepseek/qwen 均支持）。
  if (session.thinkingLevel === "off") {
    session.setThinkingLevel("high");
  }

  activeSessions.set(childId, { session, childId });
  return session;
}

export async function getParentSession(): Promise<AgentSession> {
  if (cachedParentSession) return cachedParentSession;

  const dataDir = getDataDir();
  const modelRuntime = await getSharedRuntime();
  const model = await getDefaultModel();

  const loader = new DefaultResourceLoader({
    cwd: dataDir,
    systemPromptOverride: () => buildParentPrompt(),
    // 家长模式同样不需要全局技能索引（~/.agents/skills 60 个无关技能），noSkills 关掉。
    noSkills: true,
    // 家长模式同样需要每轮时间注入（写进度文件 updated 日期、回答"今天几号"等），
    // 以及越界读写拦截。extension 必须挂 extensionFactories（createAgentSession 的 extensions 参数无效）。
    extensionFactories: [learningGuardExtension],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: dataDir,
    modelRuntime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    tools: ["read", "write", "edit", "get_date"],
    customTools: [getDateTool],
  });

  cachedParentSession = session;
  return session;
}

export async function disposeChildSession(childId: string): Promise<void> {
  const entry = activeSessions.get(childId);
  if (entry) {
    entry.session.dispose();
    activeSessions.delete(childId);
  }
}

export async function disposeAllSessions(): Promise<void> {
  for (const [childId, entry] of activeSessions) {
    entry.session.dispose();
    activeSessions.delete(childId);
  }
  if (cachedParentSession) {
    cachedParentSession.dispose();
    cachedParentSession = null;
  }
}

export function getActiveSession(childId: string): AgentSession | null {
  return activeSessions.get(childId)?.session ?? null;
}

export interface HistoryMessage {
  role: "user" | "ai";
  text: string;
}

export interface MaterialItem {
  id: string;
  format: "markdown" | "html";
  content: string;
  title?: string;
  time: string;
}

function formatTime(ts: number | undefined): string {
  const d = ts ? new Date(ts) : new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 从 session 历史里重建「学习资料」列表。
 * 资料由 display_content 工具产生，参数（format/content/title）记录在 assistant 消息的
 * toolCall 里。退出孩子模式再进入时据此恢复，保证资料一直显示（除非会话被重置）。
 */
export function getSessionMaterials(session: AgentSession): MaterialItem[] {
  const messages: any[] = (session as any).messages || [];
  const materials: MaterialItem[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const c of m.content || []) {
      if (!c || c.type !== "toolCall" || c.name !== "display_content") continue;
      let args = c.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          continue;
        }
      }
      if (!args || typeof args !== "object") continue;
      const content = typeof args.content === "string" ? args.content : "";
      if (!content) continue;
      materials.push({
        id: `mat-${materials.length}-${c.id || m.timestamp || Date.now()}`,
        format: args.format === "html" ? "html" : "markdown",
        content,
        title: typeof args.title === "string" ? args.title : undefined,
        time: formatTime(m.timestamp),
      });
    }
  }
  return materials;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c: any) => c && c.type === "text" && typeof c.text === "string"
      )
      .map((c: any) => c.text)
      .join("");
  }
  return "";
}

/**
 * Extract a renderable transcript from a session's message history.
 * Only user / assistant text is returned (tool calls, thinking, etc. are skipped).
 */
export function getSessionHistory(session: AgentSession): HistoryMessage[] {
  const messages: any[] = (session as any).messages || [];
  const history: HistoryMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = extractText(m.content);
      if (text) history.push({ role: "user", text });
    } else if (m.role === "assistant") {
      const text = extractText(m.content);
      if (text) history.push({ role: "ai", text });
    }
  }
  return history;
}
