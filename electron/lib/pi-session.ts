import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import path from "path";
import fs from "fs";
import { getChildDir, getSkillsDir, getDataDir, getSchedulerConfigPath } from "./config";
import { getSharedRuntime, getDefaultModel } from "./pi-runtime";
import { createHtmlLessonTool, displayContentTool, getDateTool, getProgressTool, kbInsertTool, kbQueryTool, kbUpdateTool, parentContentTool, parentUpsertCourseTool, parentDeleteCourseTool } from "./custom-tools";
import { getLearningSummary, progressSummaryToMarkdown } from "./learning-summary";
import { getProfile, type ChildProfile } from "./child-auth";
import learningGuardExtension from "../extensions/learning-guard";
import { disposeProgrammingSessions } from "./programming-agent";

const LEARNING_NAV_INSTRUCTIONS = `
## 交流准则
- 用孩子听得懂的话说话，简短、亲切，不堆术语，回答保持简洁，不输出长篇大论
- 不懂就承认，不瞎编；不确定的事，先查资料（用工具读文件）再回答
- 孩子来了先自然问候，不直接进入学习模式
- 孩子有进步、有思考时，明确说出来肯定
- 孩子有疑惑时，不直接给标准答案，先倾听、引导他自己想，有时候倾听和讨论比答案更重要
- 从生活话题自然引导应用已学知识，不强行说教
- 不评判孩子的选择——听、理解、必要时给建议

## 行为规范

### 学习
孩子要学习某个主题时：
1. 用 kb_query 查看主题清单与进度（SQLite，别读数据文件）
2. 用 parent_content 从**家长库**获取该主题的教学方法（type 用 "method"）——**这是本次引导的唯一权威依据**：教学步骤、展示时机、资料位置都按 method 严格执行；当 method 的具体规定与你的通用判断冲突时，**以 method 为准**。需要某课的教学文案或 html 资料路径时同样用 parent_content 获取（孩子库不存 method 与教学文案，不要尝试读文件或猜内容）

### 记录
学习总结、生活事件等记录由 recording 技能负责，按需调用（详见其 SKILL.md）。
**孩子数据已全部存入 SQLite（kb.sqlite），数据读写一律用 kb_query / kb_insert / kb_update 结构化工具，禁止用 read/write/edit 碰数据文件**——daily/、life/、inquiries/、tasks/、tags/、learning 进度 的 markdown 只是历史归档，不要读写。**标签只能从标签定义表选**（先 kb_query 查词表与判断标准，不能自创），打在 daily 生活事件（content 里写 \`- 标签：\` 行，自动解析）与课程上。只有 materials/ / uploads/ 等内容文件才用 write/edit / read；主题教学方法与课程教学文案存家长库，一律用 parent_content 获取。

### 孩子上传的附件（uploads/）
- 孩子上传的图片会随消息直接发送给你（你可见），无需读取文件；
- 孩子上传的文本文件（txt/md）已保存在 \`uploads/\` 目录下，消息里有 \`【附件文件：文件名|路径】\` 标记（路径如 \`uploads/xxx.txt\`）。需要文件内容时用 read 工具读取标记里的路径再回应，不要凭空猜测内容；不必要时不读。

### 内容展示
- 需要给孩子展示 **html 格式** 学习资料时：
  1. 若该 html 文件**还不存在**（或需要修改），先用 \`create_html_lesson\` 工具生成/更新（把标题、结构要求、内容要点、交互要求整理成 requirement 传给编程 agent，输出到 \`learning/{topic}/materials/{课程名}.html\`），生成成功后再展示；
  2. 若 html 文件**已存在**，直接用 display_content 工具通过 \`path\` 引用展示。
- **不要**自己手工拼一长串 HTML 正文塞进 display_content 的 content 参数——用 create_html_lesson 生成文件、display_content 引用文件。

### 进度查询（省上下文，务必遵守）
各主题的 **进度摘要（learned/total/next/updated）由系统从课程表自动计算**，已放在系统提示顶部的「孩子的学习进度概览」里，确定「下一课」或查询进度时：
- **直接用**系统提示里给出的 \`next\` 值，或调用 \`get_progress\` 工具（只回摘要，不含逐课明细）；
- **严禁**用 read 工具去读取进度文件（\`learning/{topic}/{topic}.md\`）的正文——正文是几百行的逐课列表（如论语 500+ 课），只为取一个 \`next\` 字段而读全文会严重浪费上下文、拖慢响应；
- 需要逐课状态（如 study-tracker 核对每课掌握度）时，用 kb_query 查进度（listOnly 只看课程清单），不要 read 文件；
- 完成一课后用 kb_update 更新该课程状态即可（table 用 course），learned/total/next 自动重算——**不要手动更新这些聚合值**，也不要为了「确认 next」反复查进度。
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
 * 教学内容生成专用提示词（ISSUE-026）：从通用家长助手中解耦，只聚焦「引导家长生成/完善一个学习主题的全部教学文件」，
 * 去掉「编辑教学技能」能力段（ISSUE-025 已移除技能 tab）。由 getParentContentSession 使用。
 */
function buildParentContentPrompt(): string {
  return `你是「教学内容生成助手」，专门帮家长为孩子的一个学习主题，生成或完善全部教学文件。你只做教学内容生成这一件事，不编辑教学技能。

你的工作目录是数据根目录（data/），用相对路径访问。当前要处理的孩子与主题由家长在对话中指定，或前端已附带「当前查看的文件」上下文。

## 目录结构（孩子维度）
\`\`\`
children/{childId}/learning/
  topics.md                  # 主题清单（frontmatter topics 数组）
  rules.md                   # 学习规则（每日目标量）
  {topic}/                   # 每个主题一个自包含目录
    {topic}.md               # 进度文件（frontmatter + 每课 ### 课程名 + 状态）
    method.md                #   教学方法
    materials/{课程名}.md     #   每课教学文案
    media/                   #   音视频（文件名与课程名逐字一致）
\`\`\`

## 引导家长生成教学内容的 6 步（可中断、可只做某一步）
1. 确认主题：key（英文目录名）、主题名、必学/选学、每日目标量。
2. 进度文件 {topic}.md：frontmatter（topic/learned/total/next/updated）+ 每课「### 课程名」+ 状态「⬜」。
3. method.md：教学步骤（分几步、每步考核方式、教学资料位置）。
4. 逐课文案 materials/{课程名}.md：原文/翻译/道理/典故等。三种方式：家长粘贴文本你来结构化、家长上传文件你来解析、你起草家长确认。
5. 登记：更新 topics.md 的 topics 数组 + rules.md 的 rules。
6. 音视频 + html：提示家长把 mp3/mp4 放进 media/（文件名与课程名逐字一致）。html 学习资料（给孩子看的展示版）由你灵活处理——无共性格式就手工拼 html 用 display_content 展示；每课有共同格式就写一个该主题专用脚本批量转 html（可参考 scripts/generate-lessons.mjs）。

## 文件结构约定
- 进度文件 frontmatter：topic、learned、total、next、updated。
- topics.md frontmatter：topics 数组，每项 {name, file, method, progress}，file 相对 learning/（如 lunyu/lunyu.md）。
- rules.md frontmatter：rules 对象，每项 {主题: {daily, type: 必学|选学}}。
- 课程名、materials 文件名、media 文件名三者逐字一致。

## 家长库课程工具（课程管理页，ISSUE-029）
- 家长库在 parents/default/（parent.sqlite 是教学内容真源；资料文件在 parents/default/materials/{topic}/，媒体在 media/ 子目录）。
- 课程管理页（前端「课程管理」）的对话使用本会话：家长会附带「当前主题/课程」上下文。
- 你可以用 parent_course_save（topic 目录名 + title 课程名 + lessonMethod/material/sendMaterial/tags/htmlPath）新建或更新课程；用 parent_course_delete 删除课程。
- 学习资料文件：用 write/edit 直接写到 parents/default/materials/{topic}/（如 parents/default/materials/lunyu/论语学而篇第一章.html）；音频/视频放 media/ 子目录，html 里用 media://local/parent/default/{topic}/media/文件名 引用；写好后用 parent_course_save 把 htmlPath 登记为 materials/{topic}/文件名.html。
- html 要自包含（内联 CSS/JS），音频用 media:// 协议，不依赖外网资源。

## 工作方式
- 家长说一句话，你先判断属于哪一步，引导式推进，不要一次灌完所有文件。
- 若前端附带了「当前查看的文件」上下文，请针对该文件给出生成/改写建议，并可主动用 write/edit 直接修改。
- 用大白话、清晰步骤回应家长，必要时先确认再动手改文件。
`;
}

/**
 * 孩子会话的 system prompt 头部（替换 SDK 默认的 "expert coding assistant" 身份 + Pi 文档噪声）。
 * 这里描述身份，并附带「孩子的学习进度概览」（由 learning-summary 从各进度文件 frontmatter
 * 解析而来，仅 frontmatter 级信息）。所有行为规范（交流准则、学习方法、内容展示、角色）放在
 * LEARNING_NAV_INSTRUCTIONS 里，经 buildAgentsMd 生成 AGENTS.md，由 SDK 自动附加为
 * <project_context>。孩子的完整行为规范以 AGENTS.md 为唯一真源（家长可在 custom 段编辑）。
 *
 * 注入进度概览的目的（ISSUE-006）：让 agent 开会话即知「下一课」是什么，无需为了确认 next
 * 而去 read 整个进度文件（论语等主题正文可达几百行，纯浪费上下文）。
 *
 * @param progressContext 进度概览 markdown；为空字符串时不注入（如该孩子暂无主题）。
 */
function buildChildPrompt(profile: ChildProfile, progressContext?: string): string {
  const emoji = profile.aiEmoji || "🌟";
  let prompt = `你是${profile.aiName}（${emoji}），${profile.name}的学习伙伴，陪伴和引导${profile.name}学习、生活和成长。`;
  if (progressContext && progressContext.trim()) {
    prompt +=
      `\n\n## 孩子的学习进度概览（已在下方替你读好，**无需再读进度文件正文**即可知道下一步学什么）\n` +
      progressContext;
  }
  return prompt;
}

interface SessionEntry {
  session: AgentSession;
  childId: string;
}

const activeSessions = new Map<string, SessionEntry>();
// 同一 childId 的「正在创建会话」Promise，避免并发重复创建（pi:start_child 与 pi:prompt 竞态、
// 或 /reset 与首次 prompt 竞态导致重复 newSession / 会话对象被覆盖 / EEXIST）。
const sessionPromises = new Map<string, Promise<AgentSession>>();
let cachedParentSession: AgentSession | null = null;
let cachedParentContentSession: AgentSession | null = null;

export async function getChildSession(
  childId: string
): Promise<AgentSession> {
  const existing = activeSessions.get(childId);
  if (existing) return existing.session;
  const inflight = sessionPromises.get(childId);
  if (inflight) return inflight;
  const promise = createChildSession(childId).finally(() => {
    sessionPromises.delete(childId);
  });
  sessionPromises.set(childId, promise);
  return promise;
}

// ---- 自动新建会话开关（autoNewSession）----
// 读取 scheduler-config.json 中该孩子的 autoNewSession 配置（与 scheduler.ts 同源，
// 在此直接读文件以避免与主进程 scheduler 模块形成循环依赖）。开关开启后，在「开会话」时
// 按「跨天」或「到了设定的时间节点」强制开一个全新空会话，旧会话文件保留为归档。
interface AutoNewSessionConfig {
  enabled: boolean;
  hour: number;
  minute: number;
}
const DEFAULT_AUTO_NEW_SESSION: AutoNewSessionConfig = { enabled: false, hour: 21, minute: 0 };

function getAutoNewSessionConfig(childId: string): AutoNewSessionConfig {
  try {
    const p = getSchedulerConfigPath();
    if (!fs.existsSync(p)) return { ...DEFAULT_AUTO_NEW_SESSION };
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const c = raw?.children?.[childId]?.autoNewSession;
    if (!c) return { ...DEFAULT_AUTO_NEW_SESSION };
    return {
      enabled: c.enabled === true,
      hour: typeof c.hour === "number" ? c.hour : DEFAULT_AUTO_NEW_SESSION.hour,
      minute: typeof c.minute === "number" ? c.minute : DEFAULT_AUTO_NEW_SESSION.minute,
    };
  } catch {
    return { ...DEFAULT_AUTO_NEW_SESSION };
  }
}

/** 该孩子所有会话文件中，最后一条消息的时间戳（ms）；没有任何消息则返回 null。 */
export function getLastMessageTimestamp(childId: string): number | null {
  const childDir = getChildDir(childId);
  const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
  if (!fs.existsSync(sessionsDir)) return null;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(sessionsDir);
  let maxTs: number | null = null;
  for (const f of files) {
    for (const entry of loadJsonlEntries(f)) {
      if (
        entry.type === "message" &&
        entry.message &&
        (entry.message.role === "user" || entry.message.role === "assistant")
      ) {
        const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        if (Number.isFinite(ts) && (maxTs === null || ts > maxTs)) maxTs = ts;
      }
    }
  }
  return maxTs;
}

/**
 * 是否应在「开会话」时强制新建一个空会话（只判断，不落盘）。开启开关后才可能返回 true，
 * 满足以下任一即新建：
 *   1) 最后一条消息不是今天（跨天 → app 启动/打开孩子模式时开新会话）；
 *   2) 今天内、且当前时间已过了设定的时间节点，且最后一条消息在该节点之前（每天固定时间节点开新会话）。
 * 没有任何历史消息时返回 false（continueRecent 本身即空会话，无需强制新建）。
 */
export function shouldAutoNewSession(
  childId: string,
  cfg: AutoNewSessionConfig = getAutoNewSessionConfig(childId)
): boolean {
  if (!cfg.enabled) return false;
  const lastTs = getLastMessageTimestamp(childId);
  if (lastTs === null) return false;
  const now = new Date();
  const today = now.toDateString();
  const lastDate = new Date(lastTs);
  // 行为1：最后一条消息不是今天 → 跨天，开新会话
  if (lastDate.toDateString() !== today) return true;
  // 行为2：今天内、已过设定的时间节点，且最后一条消息在该节点之前 → 开新会话
  const scheduled = new Date(now);
  scheduled.setHours(cfg.hour, cfg.minute, 0, 0);
  if (now.getTime() >= scheduled.getTime() && lastTs < scheduled.getTime()) return true;
  return false;
}

/** 实际创建孩子会话（被 getChildSession 的并发保护包裹，确保同一 childId 只创建一次）。 */
async function createChildSession(
  childId: string
): Promise<AgentSession> {
  const childDir = getChildDir(childId);
  const profile = getProfile(childId);
  if (!profile) throw new Error("Child profile not found");

  // 进度概览（仅 frontmatter 级）：注入系统提示，使 agent 开会话即知下一课，
  // 无需 read 整个进度文件（ISSUE-006）。无主题时 topics 为空，progressContext 为空串不注入。
  const progressContext = progressSummaryToMarkdown(getLearningSummary(childId));

  // 开会话前刷新 AGENTS.md，确保磁盘文件始终与源码 LEARNING_NAV 同步（保留家长在
  // custom 段的编辑）。这样无论源码怎么改、家长何时编辑，孩子会话拿到的行为规范都是最新、
  // 且唯一以 AGENTS.md 为真源，避免"改了源码但磁盘 AGENTS.md 陈旧、约束不生效"的问题。
  writeAgentsMd(childId, profile);

  const modelRuntime = await getSharedRuntime();
  const model = await getDefaultModel();

  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    // 替换 SDK 默认 base：去掉 "expert coding assistant" 身份与 Pi 自身文档索引（对孩子是噪声），
    // 换成孩子专属的学习伙伴身份。AGENTS.md / 技能段 / cwd / 时间注入由 SDK 在 customPrompt 模式下自动附加。
    systemPromptOverride: () => buildChildPrompt(profile, progressContext),
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

  const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
  const mgr = SessionManager.continueRecent(childDir, sessionsDir);
  // 自动新建会话开关：开启且（最后一条消息不是今天 / 已过设定的时间节点）时，
  // 在当前管理器上开一个全新空会话（旧会话文件保留为归档）。遵循官方「懒落盘」语义：
  // 空会话不写盘，首条 assistant 回复时才独占创建并落盘，不在此手写任何 header 文件。
  if (shouldAutoNewSession(childId)) {
    mgr.newSession();
  }
  const { session } = await createAgentSession({
    cwd: childDir,
    modelRuntime,
    model,
    sessionManager: mgr,
    resourceLoader: loader,
    // 注意：customTools 里的每个工具，其 name 必须同时出现在 tools 白名单中才会被
    // SDK 注册并激活（agent-session.js 的 isAllowedTool 会按白名单过滤 customTools）。
    // display_content / get_date / get_progress / kb_query / kb_insert / kb_update / create_html_lesson 都是 customTools，
    // 故名字都要列在 tools 里，缺一不可——此前 get_progress 漏列导致 agent 根本拿不到该工具（ISSUE-006 配套修复）。
    tools: ["read", "write", "edit", "display_content", "get_date", "get_progress", "kb_query", "kb_insert", "kb_update", "create_html_lesson", "parent_content"],
    customTools: [displayContentTool, getDateTool, getProgressTool, kbQueryTool, kbInsertTool, kbUpdateTool, createHtmlLessonTool, parentContentTool],
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

/**
 * 教学内容生成专用会话（ISSUE-026）：与通用家长助手解耦，使用 buildParentContentPrompt，
 * 只聚焦引导家长生成/完善学习主题的教学文件。同样复用 data/ 工作目录与 write/edit/get_date 工具。
 */
export async function getParentContentSession(): Promise<AgentSession> {
  if (cachedParentContentSession) return cachedParentContentSession;

  const dataDir = getDataDir();
  const modelRuntime = await getSharedRuntime();
  const model = await getDefaultModel();

  const loader = new DefaultResourceLoader({
    cwd: dataDir,
    systemPromptOverride: () => buildParentContentPrompt(),
    noSkills: true,
    extensionFactories: [learningGuardExtension],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: dataDir,
    modelRuntime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    tools: ["read", "write", "edit", "get_date", "parent_course_save", "parent_course_delete"],
    customTools: [getDateTool, parentUpsertCourseTool, parentDeleteCourseTool],
  });

  cachedParentContentSession = session;
  return session;
}

export async function disposeChildSession(childId: string): Promise<void> {
  const entry = activeSessions.get(childId);
  if (entry) {
    entry.session.dispose();
    activeSessions.delete(childId);
  }
}

/**
 * 重置孩子的「当前会话上下文」——把发给模型的上下文清空、从空白开始，
 * 但**不抹掉历史聊天记录**（旧会话文件完整保留，作为「归档」可随时在界面调阅）。
 *
 * 实现：使用 SDK 原生的 SessionManager.newSession() 在当前会话管理器上
 * 开启一个**全新的、空的 .jsonl 会话文件**；旧会话文件**原封不动留在磁盘上**成为归档。
 *   - newSession() 仅改变 sessionManager 指向的新文件与 leaf 指针（内存中 fileEntries 重置为 [header]），
 *     旧文件从不被删除、不被分叉——它就是一个独立的、可被 readChildSessionMessages 直接读取的历史文件。
 *   - resetLeaf()（分叉原语）不适用：它会在「同一文件」里开新根分支，旧对话作为兄弟分支残留，
 *     语义是「尝试多种可能性」而非「重置」，会让单个文件无限堆叠分支。newSession() 才是干净的「另开新会话」。
 *   - 同时清空内存 transcript（agent.state.messages），保证 getSessionHistory /
 *     getSessionMaterials 及 UI 立即为空。
 *
 * 两条路径：
 *   - 热路径（会话已在内存）：newSession() + 清空内存 transcript，立即生效；旧文件即归档。
 *   - 冷路径（应用未加载该会话，如定时任务触发时应用没开）：在 sessions 目录新建一个
 *     仅含 header 的空 .jsonl 会话文件，使下次 continueRecent 选中空白会话；旧文件保留为历史。
 *
 * 归档保留上限：每次重置后只保留最近 MAX_ARCHIVED_SESSIONS 个旧会话文件，更早的自动清理，
 * 避免 sessions 目录随重置次数无限膨胀（当前活跃会话文件永不被删）。
 *
 * 仅清「会话上下文 + 学习资料」，不清学习进度文件（daily/、learning/ 进度、profile 等）。
 */
/** 默认归档保留上限：每次会话重置后只保留最近 N 个旧会话文件，更早的清理，避免无限膨胀。值可由家长在设置里覆盖（见 scheduler config 的 archiveLimit）。 */
export const DEFAULT_ARCHIVE_LIMIT = 20;

export async function resetChildSession(
  childId: string,
  archiveLimit: number = DEFAULT_ARCHIVE_LIMIT
): Promise<void> {
  const childDir = getChildDir(childId);
  const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const entry = activeSessions.get(childId);
  if (entry) {
    // 热路径（按 SDK 官方流程）：在当前 sessionManager 上开一个全新的空会话（仅内存），
    // 旧会话文件完整保留为历史归档（不删除、不分叉）。
    // 不在此手写 header 文件：空会话没有可保存的信息，SDK 会在首条 assistant 回复时
    // 自动 openSync("wx") 独占创建并落盘（懒落盘）。这遵循官方语义，也彻底避免 EEXIST。
    // 边界：若 reset 后、发送任何消息前就重载/重进孩子模式，内存中的空会话未落盘，
    // continueRecent 会重新选中旧会话文件 → 旧消息重现（即此前 ISSUE-003 现象，已按用户决策接受）。
    entry.session.sessionManager.newSession();
    const agent: any = (entry.session as any).agent;
    if (agent && agent.state) agent.state.messages = [];
    const hotFile: string | undefined = entry.session.sessionFile;
    pruneArchivedSessions(sessionsDir, hotFile ?? undefined, archiveLimit);
  } else {
    // 冷路径（应用未加载该会话，如定时任务触发时应用没开）：
    // 按 SDK 官方流程，空会话不写盘——此处没有可持有的内存会话，故不创建/不写出任何 .jsonl。
    // 真正的"新会话"由下次 app 启动时 continueRecent 按官方语义创建
    // （目录无文件→建空会话；有文件→恢复最近会话）。定时重置的语义因此退化为：
    // 仅做归档清理，不再主动清空当前会话（用户已确认接受此边界）。
    pruneArchivedSessions(sessionsDir, undefined, archiveLimit);
  }
}

/**
 * 清理归档会话文件：保留 sessions 目录下最近 limit 个 .jsonl，更早的删除。
 * 当前活跃会话文件（activeFile）永不被删。limit<1 时不保留任何历史归档（仅当前会话）。
 */
export function pruneArchivedSessions(
  sessionsDir: string,
  activeFile?: string,
  limit: number = DEFAULT_ARCHIVE_LIMIT
): void {
  if (!fs.existsSync(sessionsDir)) return;
  const keep = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_ARCHIVE_LIMIT;
  const activeResolved = activeFile ? path.resolve(activeFile) : null;
  const files = fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(sessionsDir, f))
    .filter((f) => !(activeResolved && path.resolve(f) === activeResolved));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const f of files.slice(keep)) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 忽略单文件删除失败 */
    }
  }
}

/** 一行一 JSON 的 jsonl 会话文件 → 条目数组（容错跳过坏行）。 */
function loadJsonlEntries(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const entries: any[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* 跳过畸形行 */
    }
  }
  return entries;
}

/**
 * 直接读取某个历史会话 .jsonl 文件，重建其「活跃路径（root→leaf）」上的消息列表。
 * 不加载进 agent、不影响当前会话上下文——仅用于前端「显示历史会话」时按需调阅。
 * 复用了与 getSessionHistory 一致的文本提取规则（extractText）与角色映射。
 */
function readSessionMessagesFromFile(filePath: string): HistoryMessage[] {
  const entries = loadJsonlEntries(filePath);
  const nonHeader = entries.filter((e) => e.type !== "session");
  const byId = new Map<string, any>();
  for (const e of nonHeader) if (e.id) byId.set(e.id, e);
  // leaf = 没有任何其他条目以其为 parentId 的条目（线性会话即最后一条）
  const hasChild = new Set<string>();
  for (const e of nonHeader) if (e.parentId) hasChild.add(e.parentId);
  let leaf = nonHeader.find((e) => !hasChild.has(e.id));
  const pathChain: any[] = [];
  const guard = new Set<string>();
  let cur: any = leaf;
  while (cur && cur.id && !guard.has(cur.id)) {
    guard.add(cur.id);
    pathChain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  pathChain.reverse();

  const out: HistoryMessage[] = [];
  for (const e of pathChain) {
    if (e.type !== "message" || !e.message) continue;
    const role = e.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(e.message.content);
    if (text) {
      const ms = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
      out.push({
        role: role === "assistant" ? "ai" : "user",
        text,
        time: formatTime(Number.isFinite(ms) ? ms : undefined),
      });
    }
  }
  return out;
}

export interface SessionMeta {
  /** 文件名（前端据此请求具体消息；仅 basename，防目录穿越） */
  file: string;
  sessionId: string;
  /** 会话创建时间 ISO 字符串（取自 header.timestamp） */
  createdAt: string;
  /** 活跃路径上的消息条数 */
  messageCount: number;
}

/**
 * 列出某孩子的历史归档会话（排除当前活跃会话）。
 * 供前端「显示历史会话」下拉/列表使用。
 */
export async function listChildSessions(childId: string): Promise<SessionMeta[]> {
  const childDir = getChildDir(childId);
  const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
  if (!fs.existsSync(sessionsDir)) return [];
  const activeResolved = activeSessions.get(childId)?.session.sessionFile
    ? path.resolve(activeSessions.get(childId)!.session.sessionFile!)
    : null;
  const result: SessionMeta[] = [];
  for (const f of fs.readdirSync(sessionsDir)) {
    if (!f.endsWith(".jsonl")) continue;
    const full = path.join(sessionsDir, f);
    if (activeResolved && path.resolve(full) === activeResolved) continue;
    const entries = loadJsonlEntries(full);
    const header = entries.find((e) => e.type === "session");
    const msgs = readSessionMessagesFromFile(full);
    result.push({
      file: f,
      sessionId: header?.id ?? f,
      createdAt: header?.timestamp ?? "",
      messageCount: msgs.length,
    });
  }
  result.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return result;
}

/**
 * 直接读取指定历史会话文件（按文件名）的活跃路径消息，供前端显示。
 * file 仅取 basename，杜绝路径穿越。
 */
export async function readChildSessionMessages(
  childId: string,
  file: string
): Promise<HistoryMessage[]> {
  const childDir = getChildDir(childId);
  const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
  const full = path.join(sessionsDir, path.basename(file));
  if (!fs.existsSync(full)) return [];
  return readSessionMessagesFromFile(full);
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
  if (cachedParentContentSession) {
    cachedParentContentSession.dispose();
    cachedParentContentSession = null;
  }
  // ISSUE-020：编程 agent 会话随应用退出一并释放
  await disposeProgrammingSessions();
}

export function getActiveSession(childId: string): AgentSession | null {
  return activeSessions.get(childId)?.session ?? null;
}

export interface HistoryMessage {
  role: "user" | "ai";
  text: string;
  /** 消息时间戳（MM-DD HH:mm），用于前端气泡显示 */
  time?: string;
  /** AI 消息的思考过程（assistant content 里 type==="thinking" 块），恢复后与实时气泡一致可展开查看 */
  thinking?: string;
  /** AI 消息的工具调用记录（assistant content 里 type==="toolCall" 块 + 对应 toolResult 终态） */
  tools?: HistoryToolCall[];
}

/** 工具调用历史记录（与前端 ToolCallState 结构一致，退出重进恢复用） */
export interface HistoryToolCall {
  id: string;
  name: string;
  argsPreview?: string;
  status: "running" | "done" | "error";
  resultPreview?: string;
}

export interface MaterialItem {
  id: string;
  format: "html";
  content: string;
  title?: string;
  time: string;
  /** 资料文件路径（相对学习目录），用于去重 */
  filePath: string;
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
export function getSessionMaterials(session: AgentSession, cwd?: string): MaterialItem[] {
  const messages: any[] = (session as any).messages || [];
  const materials: MaterialItem[] = [];
  const seen = new Set<string>();
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
      const filePath = typeof args.path === "string" ? args.path : "";
      if (!filePath) continue;
      // 去重：同一份资料（同一 path）在历史里多次被展示时只保留首次，
      // 避免「每步都重发学习资料」导致面板堆积重复条目。
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      // 历史里可能只有 path（新版工具）或同时带 content（旧版）；
      // 若没有 content，则从文件重新读取，保证恢复出的资料可正常展示。
      let content = typeof args.content === "string" ? args.content : "";
      if (!content && cwd) {
        try {
          const resolved = path.resolve(cwd, filePath);
          if (resolved === cwd || resolved.startsWith(cwd + path.sep)) {
            content = fs.readFileSync(resolved, "utf-8");
          }
        } catch {
          content = "";
        }
      }
      materials.push({
        id: `mat-${materials.length}-${c.id || m.timestamp || Date.now()}`,
        format: "html",
        content,
        title: typeof args.title === "string" ? args.title : undefined,
        time: formatTime(m.timestamp),
        filePath,
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

/** 从 assistant content 里提取思考过程（type==="thinking" 块的 thinking 文本） */
function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c && c.type === "thinking" && typeof c.thinking === "string")
    .map((c: any) => c.thinking)
    .join("\n");
}

const TOOL_PREVIEW_LIMIT = 200;
const TOOL_RESULT_LIMIT = 300;

/**
 * 从 assistant content 里提取工具调用记录（type==="toolCall" 块），
 * 并用 toolResult 消息（按 toolCallId 匹配）填充终态 status 与结果预览。
 */
function extractToolCalls(
  content: unknown,
  toolResults: Map<string, { isError: boolean; text: string }>
): HistoryToolCall[] {
  if (!Array.isArray(content)) return [];
  const calls: HistoryToolCall[] = [];
  for (const c of content) {
    if (!c || c.type !== "toolCall" || !c.id) continue;
    let argsPreview = "";
    if (typeof c.arguments === "string") argsPreview = c.arguments;
    else if (c.arguments && typeof c.arguments === "object") argsPreview = JSON.stringify(c.arguments);
    if (argsPreview.length > TOOL_PREVIEW_LIMIT) argsPreview = argsPreview.slice(0, TOOL_PREVIEW_LIMIT) + "…";
    const res = toolResults.get(c.id);
    let resultPreview: string | undefined;
    if (res && res.text) {
      resultPreview = res.text.length > TOOL_RESULT_LIMIT ? res.text.slice(0, TOOL_RESULT_LIMIT) + "…" : res.text;
    }
    calls.push({
      id: c.id,
      name: typeof c.name === "string" ? c.name : "unknown",
      argsPreview: argsPreview || undefined,
      status: res ? (res.isError ? "error" : "done") : "running",
      resultPreview,
    });
  }
  return calls;
}

/**
 * Extract a renderable transcript from a session's message history.
 * 返回 user / assistant 消息的正文，以及 assistant 消息的思考过程与工具调用记录
 * （ISSUE-018：退出再进入时与实时气泡内联显示的效果一致，可展开查看）。
 */
export function getSessionHistory(session: AgentSession): HistoryMessage[] {
  const messages: any[] = (session as any).messages || [];
  const history: HistoryMessage[] = [];
  // toolResult 消息按 toolCallId 建索引，供 assistant 的工具调用匹配终态
  const toolResults = new Map<string, { isError: boolean; text: string }>();
  for (const m of messages) {
    if (m.role === "toolResult" && m.toolCallId) {
      toolResults.set(m.toolCallId, { isError: !!m.isError, text: extractText(m.content) });
    }
  }
  for (const m of messages) {
    if (m.role === "user") {
      const text = extractText(m.content);
      if (text) history.push({ role: "user", text, time: formatTime(m.timestamp) });
    } else if (m.role === "assistant") {
      const text = extractText(m.content);
      const thinking = extractThinking(m.content);
      const tools = extractToolCalls(m.content, toolResults);
      // 保留有正文 / 有思考 / 有工具调用的 assistant 消息
      // （纯 toolUse 中转消息若三者皆空则跳过，避免恢复出空气泡）
      if (text || thinking || tools.length > 0) {
        history.push({
          role: "ai",
          text,
          time: formatTime(m.timestamp),
          thinking: thinking || undefined,
          tools: tools.length ? tools : undefined,
        });
      }
    }
  }
  return history;
}
