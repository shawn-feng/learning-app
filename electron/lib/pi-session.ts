import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import path from "path";
import fs from "fs";
import { getChildDir, getSkillsDir } from "./config";
import { getSharedRuntime } from "./pi-runtime";
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
  return `你是一个技能编辑助手，帮助家长创建和调整主题教学技能。

你的工作目录是共享技能目录。你可以使用 read/write/edit 工具创建和修改技能文件。

### 技能结构
每个技能是一个目录，包含 SKILL.md 文件和可选的教学资料：
\`\`\`
{skill-name}/
├── SKILL.md          # 必需：技能说明和教学流程
├── materials/        # 可选：教学资料
└── references/        # 可选：参考文档
\`\`\`

### SKILL.md 格式
\`\`\`markdown
---
name: skill-name
description: 技能描述，说明何时使用
---

# 技能标题

## 工作流程
1. 读取进度文件...
2. 教学引导...
3. 考核...
4. 输出学习总结...
\`\`\`

请根据家长的需求创建或修改技能文件。
`;
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

  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: childDir,
    modelRuntime,
    sessionManager: SessionManager.continueRecent(childDir),
    resourceLoader: loader,
    tools: ["read", "write", "edit", "display_content", "get_date"],
    customTools: [displayContentTool, getDateTool],
    extensions: [
      {
        name: "learning-guard",
        factory: learningGuardExtension,
      },
    ],
  });

  activeSessions.set(childId, { session, childId });
  return session;
}

export async function getParentSession(): Promise<AgentSession> {
  if (cachedParentSession) return cachedParentSession;

  const skillsDir = getSkillsDir();
  const modelRuntime = await getSharedRuntime();

  const loader = new DefaultResourceLoader({
    cwd: skillsDir,
    systemPromptOverride: () => buildParentPrompt(),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: skillsDir,
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    tools: ["read", "write", "edit"],
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
