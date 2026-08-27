import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import path from "path";
import fs from "fs";
import { getChildDir, getSkillsDir, getDataDir, getSchedulerConfigPath } from "./config";
import { getParentMaterialsDir } from "./parent-library";
import { getSharedRuntime, getDefaultModel } from "./pi-runtime";
import { createHtmlLessonTool, displayContentTool, getDateTool, getProgressTool, kbInsertTool, kbQueryTool, kbUpdateTool, parentContentTool, parentUpsertCourseTool, parentDeleteCourseTool, parentStatsTool, logActivityTool, moveFileTool, copyFileTool } from "./custom-tools";
import { getLearningSummary, progressSummaryToMarkdown, fetchProgressRemote } from "./learning-summary";
import { getProfile, type ChildProfile } from "./child-auth";
import { getAgentPrompt, fetchAgentPromptRemote } from "./agent-prompts";
import {
  findLastConversationDate,
  formatLocalDate,
  summarizeConversationTool,
  summarizeDailyConversation,
} from "./daily-summary";
import { getChildSchedulerConfig, getParentSchedulerConfig } from "./scheduler";
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
学习总结、生活事件等记录由**系统定时任务**统一完成（按配置的时间点从孩子当天的对话中提取，写入 daily）。**当孩子/家长希望回顾或总结某天的学习内容、生活事件时，调用 \`summarize_conversation\` 工具**（按天汇总，date 可省略，自动选最近有会话的一天；该天无会话会返回跳过说明）。各主题 method.md 的「记录」段指引照常执行。
**孩子数据已全部存入 SQLite（kb.sqlite），数据读写一律用 kb_query / kb_insert / kb_update 结构化工具，禁止用 read/write/edit 碰数据文件**——daily/、life/、inquiries/、tasks/、tags/、learning 进度 的 markdown 只是历史归档，不要读写。**标签只能从标签定义表选**（先 kb_query 查词表与判断标准，不能自创），打在 daily 生活事件（content 里写 \`- 标签：\` 行，自动解析）与课程上。只有 materials/ / uploads/ 等内容文件才用 write/edit / read；主题教学方法与课程教学文案存家长库，一律用 parent_content 获取。

### 孩子上传的附件（uploads/）
- 孩子上传的图片会随消息直接发送给你（你可见），无需读取文件；
- 孩子上传的文本文件（txt/md）已保存在 \`uploads/\` 目录下，消息里有 \`【附件文件：文件名|路径】\` 标记（路径如 \`uploads/xxx.txt\`）。需要文件内容时用 read 工具读取标记里的路径再回应，不要凭空猜测内容；不必要时不读。

### 目录查看（ls）
- 用 \`ls\` 查看你自己工作目录（cwd）下的 \`outputs/\`、\`uploads/\`、\`materials/\` 里已有哪些文件，便于复用 / 展示 / 清理已生成的 html 或资料——它只列「文件名 + 是否文件夹」，不读内容，省上下文。
- 列目录受边界保护：只能列自己 cwd 范围内的目录，列 \`../\` 等越界路径会被系统拦截（保护共享数据区 data/shared/）。
- **数据库不用 \`ls\` 翻**：SQLite 数据文件（kb.sqlite）及 learning/、daily/、life/ 等归档目录一律用 kb_query 看清单，不要用 \`ls\` 去列这些数据目录——列名字本身无意义，知识 / 进度清单应走结构化工具。

### 内容展示
- 需要给孩子展示 **html 格式** 学习资料时：
  1. 若该 html 文件**还不存在**（或需要修改），先用 \`create_html_lesson\` 工具生成/更新（把标题、结构要求、内容要点、交互要求整理成 requirement 传给编程 agent），生成成功后再展示；
  2. 若 html 文件**已存在**，直接用 display_content 工具通过 \`path\` 引用展示。
- **outputPath 规则（便于集中管理与查询）**：孩子要求的**工具/游戏/一次性产物**（如番茄钟）→ \`outputs/{名称}.html\`，集中在 \`outputs/\` 便于统一查找与清理、独立于任何学习主题；**学习资料**（与主题 method/materials 配套的教学展示）→ \`materials/{topic}/{课程名}.html\`，落在父库共享目录（单一真源，多孩子共享同一份，不需要在孩子本地另存）。
- 用 create_html_lesson 生成文件、再由 display_content 引用文件，而不是把一长串 HTML 正文直接塞进 display_content 的 content 参数：独立 HTML 文件能让孩子端直接预览完整页面，也避免超长正文撑爆消息、干扰对话上下文。

### 进度查询（省上下文，务必遵守）
各主题的 **进度摘要（learned/total/next/updated）由系统从课程表自动计算**，已放在系统提示顶部的「孩子的学习进度概览」里，确定「下一课」或查询进度时：
- **直接用**系统提示里给出的 \`next\` 值，或调用 \`get_progress\` 工具（只回摘要，不含逐课明细）；
- **严禁**用 read 工具去读取进度文件（\`learning/{topic}/{topic}.md\`）的正文——正文是几百行的逐课列表（如论语 500+ 课），只为取一个 \`next\` 字段而读全文会严重浪费上下文、拖慢响应；
- 需要逐课状态（如逐课核对掌握度）时，用 kb_query 查进度（listOnly 只看课程清单），不要 read 文件；
- 完成一课后用 kb_update 更新该课程状态即可（table 用 course），learned/total/next 自动重算——**不要手动更新这些聚合值**，也不要为了「确认 next」反复查进度。
`;

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
`;
}

/**
 * 孩子会话实际收到的 AGENTS 内容（ISSUE-033：AGENTS 纯 SQLite 存储，不落任何物理文件）。
 * 优先级：SQLite 用户版本（data/agents.sqlite，整体替换权威）→ 代码默认 buildAgentsMd。
 * 孩子目录/家长目录均无 AGENTS 文件；行为规范经 buildChildPrompt 内联注入 system prompt，
 * 孩子只读（无文件可写）、管理者=家长（家长页面 AgentPromptEditor 编辑）。
 */
export function resolveChildAgents(childId: string, profile: ChildProfile): string {
  const userVersion = getAgentPrompt("child", childId);
  if (userVersion && userVersion.trim()) return userVersion;
  return buildAgentsMd(profile);
}

/**
 * 返回某 scope/ref 的「默认提示词」内容（ISSUE-033 编辑器初始填充用）：
 * - 孩子：按 profile 生成 buildAgentsMd（保证「在默认基础上修改」；AGENTS 纯 SQLite，无磁盘文件）；
 * - 家长：返回统一版 buildParentPrompt 的代码默认（2026-08-24 起不分场景）。
 * 注意：本函数在「无用户整体版本」时调用，因此不会出现与 SQLite 用户版本叠加的情况。
 */
export function getDefaultPrompt(scope: string, ref: string): string {
  if (scope === "child") {
    const profile = getProfile(ref);
    return profile ? buildAgentsMd(profile) : "";
  }
  if (scope === "parent") {
    // ISSUE-037 续：家长提示词已统一（不再分 main/content 场景），统一返回代码默认
    return buildParentPrompt();
  }
  return "";
}

/**
 * 家长工作台助手统一提示词（2026-08-24 起不再分场景：原「通用家长助手」与「教学内容生成」
 * 两个提示词合并为一份，getParentSession / getParentContentSession 共用）。
 * 覆盖家长工作台全部职责：孩子管理 / 课程与教学内容管理 / 配置查看 / 学习统计，
 * 并说明 app 数据结构与数据流转，让 agent 知道数据在哪、怎么流动、边界在哪。
 */
function buildParentPrompt(): string {
  // ISSUE-033：用户保存的家长提示词版本优先（整体替换代码默认）。
  // ref 兼容：历史「教学内容生成」用户版本（ref=content）在 main 无自定义时兜底生效，
  // 避免合并后用户已编辑过的内容被代码默认静默覆盖（编辑器统一为 main 后会自动展示该内容）。
  const userVersion = getAgentPrompt("parent", "main") || getAgentPrompt("parent", "content");
  if (userVersion && userVersion.trim()) return userVersion;
  return `你是「家长工作台助手」，服务家长工作台的全部功能：孩子管理、课程与教学内容管理、配置查看、学习统计。你不分场景——家长在任何页面（孩子管理 / 课程管理 / 教学内容 / 设置）发起的对话都是同一个你。

你的工作目录是数据根目录（data/），用相对路径访问。你的能力范围 = 家长工作台页面能做的：只读查看 + 家长库课程维护 + 资料文件读写。

## 一、数据在哪里、怎么流转（先建立整体认知）

### 数据目录
\`\`\`
data/
  parents/default/          # 家长库：教学内容的唯一真源
    parent.sqlite           #   topics(主题) + courses(课程) + meta（二进制，用 parent_stats 查，不要 read）
    materials/{topic}/      #   资料文件（html/md 直接放；音频/视频放 media/ 子目录）
    activity-log.md         #   家长操作记录：你对 app 的改动都记在这里（可 read 查看历史）
  children/{childId}/       # 每个孩子一个目录
    profile.json            #   孩子档案：名字/年龄/兴趣/AI 伙伴（文本，可 read）
    kb.sqlite               #   孩子学习数据真源：topics/courses(进度)/daily_entries(每日记录)/tags/meta（二进制，用 parent_stats 查）
    uploads/                #   孩子上传的文件
    .pi/agent/sessions/     #   孩子 AI 会话历史 jsonl
  agents.sqlite             #   AGENTS/提示词用户版本库（孩子+家长）
  app-settings.json         #   应用配置：默认模型/编程模型/资料上限
  scheduler-config.json     #   定时任务配置（每日学习记录总结/自动新会话等）
  token-log.jsonl           #   token 消耗日志（文本，可 read；或 parent_stats tokens 汇总）
\`\`\`

### 两库职责与数据流转（核心）
1. **家长库 parent.sqlite 是「教学内容」唯一真源**：主题表 topics（name 中文名 / file 目录名如 lunyu / method 教学方法全文 / rules_json 含 daily 每日目标、type 必学|选学）；课程表 courses（(topic,title) 复合主键，含 lesson_method / material / send_material / tags / html_path / teaching_copy 教学文案全文）。
2. **孩子库 kb.sqlite 是「孩子学习数据」唯一真源**：同一套主题/课程结构，但只存「骨架 + 进度」——分配时从家长库快照拷贝课程（status 重置 ⬜），method 与教学文案**不拷贝**（孩子端需要时经 parent_content 工具从家长库取）；孩子学习时更新 status/mastery/first_learned/last_review，每日学习记录写 daily_entries。
3. **流转闭环**：家长在家长库建主题+课程 → 分配给孩子（快照拷贝骨架）→ 孩子学习时写进度与每日记录 → 家长在家长工作台查统计（parent_stats 看进度/token/每日记录）。
4. **边界（不要越界）**：教学内容（方法/文案/资料）在家长库维护；孩子进度是孩子数据、只在孩子库维护。**绝不跨库改数据**：不用 write/edit 改任何 .sqlite 文件（二进制也读不了），改数据库一律走对应工具。

## 二、你能做的事

### 1. 孩子管理（查看 + 引导）
- 家长提到孩子时，先 read children/*/profile.json 匹配名字找到 childId，再用 parent_stats 查 TA 的学习情况。
- 添加/删除孩子、重置密码、分配主题、设置每日目标：这些是家长工作台页面操作，你在对话中指导家长在对应页面完成。

### 2. 课程与教学内容管理（家长库）
- 家长可能直接把文件放进 parents/default/materials/{topic}/（或 media/ 子目录）——先用 **ls** 列出目录看看里面有什么文件，再决定关联/处理，不要假设目录里有什么。
- 用 parent_course_save 新建/更新课程（topic 目录名 + title 课程名 + lessonMethod/material/sendMaterial/tags/htmlPath，只覆盖传入的非空字段）；用 parent_course_delete 删除课程（不删共享资料文件）。这两个工具**会自动记录到 activity-log.md**。
- 资料文件：用 write/edit 写到 parents/default/materials/{topic}/；音频/视频放 media/ 子目录，html 里用 media://local/parent/default/{topic}/media/文件名 引用；html 必须自包含（内联 CSS/JS）；写好后用 parent_course_save 把 htmlPath 登记为 materials/{topic}/文件名.html。
- **整理资料**：需要移动/重命名文件或目录（如把散放的 html 移进 materials/{topic}/、音频移进 media/、重命名）用 **move_file**；复制文件/目录用 **copy_file**。这两个工具会自动记录到 activity-log.md，且禁止覆盖已存在目标、禁止越出 data/。
- **操作记录**：用 write/edit 改了资料文件或内容后，调用 **log_activity** 把这次改动追加记录到 activity-log.md（一句话即可）；家长问「最近改了什么」时 read activity-log.md 回答。
- 主题的新建/教学方法编辑/分配/每日目标：页面操作，你引导家长在「课程管理」页完成，或按家长指示做你能做的部分。

### 3. 配置查看
- 读 app-settings.json / scheduler-config.json 了解当前配置（默认模型、定时任务等）；**修改请引导家长在设置页操作**，不要手工改配置 JSON（格式损坏会导致应用异常）。
- auth.json 含 API 密钥，**绝不读取或修改**。

### 4. 查看统计（只读）
- 用 parent_stats 查：tokens（token 消耗汇总/按模型/最近记录，可只看某孩子）、progress（孩子各主题 learned/total/next + 每课状态，必填 childId）、daily（孩子每日学习记录，必填 childId，可指定日期 YYYY-MM-DD）。
- 数据库是二进制，**不要用 read 读 .sqlite 文件**，查统计一律用 parent_stats。

## 三、工作方式
- 家长说一句话，先判断属于哪一类（孩子管理/课程管理/配置/统计），再决定动作或引导。
- 引导式推进：一步一步来，不要一次灌完所有操作；用大白话、清晰步骤回应家长。
- 破坏性操作（删除课程、覆盖已有资料）先向家长确认。
- 需要精确日期时间用 get_date；今天日期以系统注入为准（不要从对话历史猜旧日期）。
`;
}

/**
 * 孩子会话的 system prompt 头部（替换 SDK 默认的 "expert coding assistant" 身份 + Pi 文档噪声）。
 * 这里描述身份，并附带「孩子的学习进度概览」（由 learning-summary 从各进度文件 frontmatter
 * 解析而来，仅 frontmatter 级信息）。所有行为规范（交流准则、学习方法、内容展示、角色）放在
 * LEARNING_NAV_INSTRUCTIONS 里，经 buildAgentsMd 生成 AGENTS 内容，在本函数末尾内联注入。
 * 孩子的完整行为规范以「data/agents.sqlite 用户版本 / 代码默认」为唯一真源（家长可编辑、孩子只读；
 * ISSUE-033：AGENTS 纯 SQLite 存储，不落任何物理文件）。
 *
 * 注入进度概览的目的（ISSUE-006）：让 agent 开会话即知「下一课」是什么，无需为了确认 next
 * 而去 read 整个进度文件（论语等主题正文可达几百行，纯浪费上下文）。
 *
 * @param progressContext 进度概览 markdown；为空字符串时不注入（如该孩子暂无主题）。
 */
function buildChildPrompt(childId: string, profile: ChildProfile, progressContext?: string): string {
  const emoji = profile.aiEmoji || "🌟";
  let prompt = `你是${profile.aiName}（${emoji}），${profile.name}的学习伙伴，陪伴和引导${profile.name}学习、生活和成长。`;
  if (progressContext && progressContext.trim()) {
    prompt +=
      `\n\n## 孩子的学习进度概览（已在下方替你读好，**无需再读进度文件正文**即可知道下一步学什么）\n` +
      progressContext;
  }
  // ISSUE-033：AGENTS 行为规范不以「文件」形式由 SDK 附加为 <project_context>（无任何磁盘 AGENTS
  // 文件，孩子不可写），改为在此内联注入——内容来自 data/agents.sqlite 用户版本 / 代码默认
  // （resolveChildAgents），孩子只读、管理者=家长（家长页面 AgentPromptEditor 编辑）。
  prompt += `\n\n# 行为规范（必须遵守）\n\n${resolveChildAgents(childId, profile)}`;
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

/** 任意会话目录下所有会话文件中，最后一条消息的时间戳（ms）；没有消息则返回 null。 */
export function lastMessageTimestampInDir(sessionsDir: string): number | null {
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

/** 该孩子所有会话文件中，最后一条消息的时间戳（ms）；没有任何消息则返回 null。 */
export function getLastMessageTimestamp(childId: string): number | null {
  return lastMessageTimestampInDir(path.join(getChildDir(childId), ".pi", "agent", "sessions"));
}

/**
 * 是否应在「开会话」时强制新建一个空会话（只判断，不落盘）。开启开关后才可能返回 true，
 * 满足以下任一即新建：
 *   1) 最后一条消息不是今天（跨天 → app 启动/打开孩子模式时开新会话）；
 *   2) 今天内、且当前时间已过了设定的时间节点，且最后一条消息在该节点之前（每天固定时间节点开新会话）。
 * 没有任何历史消息时返回 false（continueRecent 本身即空会话，无需强制新建）。
 */
function shouldAutoNewSessionInDir(sessionsDir: string, cfg: AutoNewSessionConfig): boolean {
  if (!cfg.enabled) return false;
  const lastTs = lastMessageTimestampInDir(sessionsDir);
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

export function shouldAutoNewSession(
  childId: string,
  cfg: AutoNewSessionConfig = getAutoNewSessionConfig(childId)
): boolean {
  return shouldAutoNewSessionInDir(path.join(getChildDir(childId), ".pi", "agent", "sessions"), cfg);
}

/**
 * 家长会话「自动新建会话」策略（2026-08-24，与孩子一致）：
 * 读 scheduler-config.json 的 parent.autoNewSession，对家长的会话目录（parent / parent-content）做同款判定。
 */
export function shouldAutoNewSessionForParent(sessionsDir: string): boolean {
  try {
    const cfg = getParentSchedulerConfig().autoNewSession;
    return shouldAutoNewSessionInDir(sessionsDir, cfg);
  } catch (e) {
    console.error(`[pi-session] parent autoNewSession check failed:`, (e as Error).message);
    return false;
  }
}

// 会话前自动总结：配置 recording.onNewSession 时，对「今天之前最后有会话的一天」做按天汇总。
// fire-and-forget（不阻塞会话打开）；找不到会话日期或当天无对话时 summarizeDailyConversation 内部跳过。
function maybeSummarizeBeforeNewSession(childId: string): void {
  try {
    const cfg = getChildSchedulerConfig(childId);
    if (!cfg.recording.onNewSession) return;
    const childDir = getChildDir(childId);
    const date = findLastConversationDate(childDir, formatLocalDate(new Date()));
    if (date) {
      void summarizeDailyConversation(childDir, date).catch((e) =>
        console.error(`Pre-session summary failed for child ${childId}:`, e)
      );
    }
  } catch (e) {
    console.error(`Pre-session summary setup failed for child ${childId}:`, e);
  }
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

  // ISSUE-033：AGENTS 纯 SQLite 存储（data/agents.sqlite），行为规范经 buildChildPrompt 内联注入
  // （resolveChildAgents：SQLite 用户版本 → 代码默认），不落任何物理文件——孩子只读、不可写，
  // 管理者=家长（家长页面 AgentPromptEditor 编辑）。
  // SPLIT M8-B：AGENTS 唯一真源在服务端；systemPromptOverride 是 SDK 同步回调，故在创建会话前
  // 先远程预取该孩子的用户版本写入本地缓存（buildChildPrompt 同步读缓存即取到服务端最新版）；
  // 服务端不可达时回退本地缓存/代码默认。
  await fetchAgentPromptRemote("child", childId).catch(() => null);
  // SPLIT 收尾：学习进度概览同样「会话前远程预取 → 本地缓存 → getLearningSummary 同步读缓存」
  // （服务端不可达时降级为旧缓存/空，不阻断会话创建）。
  await fetchProgressRemote(childId).catch(() => null);

  const modelRuntime = await getSharedRuntime();
  const model = await getDefaultModel();

  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    // 替换 SDK 默认 base：去掉 "expert coding assistant" 身份与 Pi 自身文档索引（对孩子是噪声），
    // 换成孩子专属的学习伙伴身份。AGENTS / 技能段 / cwd / 时间注入由 SDK 在 customPrompt 模式下自动附加。
    systemPromptOverride: () => buildChildPrompt(childId, profile, progressContext),
    // shared/skills 已无教学技能（recording / study-tracker 均已移除，目录为空），
    // 该扫描路径仅作兜底，未来若再加技能无需改加载逻辑。
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
    // 配置了「每次新建会话前自动总结」时，先对之前的会话（今天之前最后有对话的一天）做按天汇总，
    // fire-and-forget：不阻塞会话打开，失败只记日志（汇总本身幂等，重复触发不重复写 daily）。
    maybeSummarizeBeforeNewSession(childId);
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
    // display_content / get_date / get_progress / kb_query / kb_insert / kb_update / create_html_lesson
    // / summarize_conversation 都是 customTools，故名字都要列在 tools 里，缺一不可
    // ——此前 get_progress 漏列导致 agent 根本拿不到该工具（ISSUE-006 配套修复）。
    // ls 是 SDK 内置工具（node_modules/@earendil-works/pi-coding-agent/dist/core/tools/ls.js），
    // 仅需列在 tools 白名单即启用、无需 customTools 条目——让孩子能列自己 cwd 下的目录
    // （outputs/ 已生成 html、uploads/ 上传资料、materials/ 学习资料）以复用/展示/清理；
    // 越界防护由 learning-guard 统一拦截（ISSUE-049）。
    tools: ["read", "write", "edit", "ls", "display_content", "get_date", "get_progress", "kb_query", "kb_insert", "kb_update", "create_html_lesson", "parent_content", "summarize_conversation"],
    customTools: [displayContentTool, getDateTool, getProgressTool, kbQueryTool, kbInsertTool, kbUpdateTool, createHtmlLessonTool, parentContentTool, summarizeConversationTool],
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

// 家长会话的磁盘会话目录（2026-08-24 起家长会话落盘，与孩子一致可保存/续接历史）。
// parent 与 parent-content 是两个独立会话，各自独立子目录，避免 continueRecent 互相选中对方历史。
function getParentSessionsDir(sub: string): string {
  return path.join(getDataDir(), ".pi", "agent", "sessions", sub);
}

export async function getParentSession(): Promise<AgentSession> {
  if (cachedParentSession) return cachedParentSession;

  // SPLIT M8-B：创建前远程预取家长 AGENTS 用户版本到本地缓存
  await fetchAgentPromptRemote("parent", "main").catch(() => null);
  await fetchAgentPromptRemote("parent", "content").catch(() => null);

  const dataDir = getDataDir();
  const modelRuntime = await getSharedRuntime();
  const model = await getDefaultModel();

  const loader = new DefaultResourceLoader({
    cwd: dataDir,
    // 必须显式传 agentDir：SDK 构造时对 agentDir 调 resolvePath，Windows 下传 undefined 会
    // 在 normalizeWindowsShellPath 里 undefined.startsWith 崩溃（与 ISSUE-020 编程 agent 同根因）。
    agentDir: path.join(dataDir, ".pi", "agent"),
    systemPromptOverride: () => buildParentPrompt(),
    // 家长模式同样不需要全局技能索引（~/.agents/skills 60 个无关技能），noSkills 关掉。
    noSkills: true,
    // 家长模式同样需要每轮时间注入（写进度文件 updated 日期、回答"今天几号"等），
    // 以及越界读写拦截。extension 必须挂 extensionFactories（createAgentSession 的 extensions 参数无效）。
    extensionFactories: [learningGuardExtension],
  });
  await loader.reload();

  // 2026-08-24：家长会话落盘（此前 SessionManager.inMemory 不保存历史）。
  // continueRecent 续接最近会话；autoNewSession 策略（跨天/定点）与孩子一致，开会话时裁决。
  const sessionsDir = getParentSessionsDir("parent");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const mgr = SessionManager.continueRecent(dataDir, sessionsDir);
  if (shouldAutoNewSessionForParent(sessionsDir)) {
    mgr.newSession();
  }

  const { session } = await createAgentSession({
    cwd: dataDir,
    modelRuntime,
    model,
    sessionManager: mgr,
    resourceLoader: loader,
    // ISSUE-037 续：家长提示词统一后，工具集也统一为家长工作台全量
    //（孩子管理=只读 profile + parent_stats 统计；课程管理=parent_course_*；配置=read 文本；
    //  ls 列目录——家长直接把文件放进 materials/ 目录后，agent 需要能查看目录里有什么；
    //  move_file/copy_file 整理资料——移动/重命名/复制文件与目录）。
    tools: ["read", "write", "edit", "ls", "get_date", "parent_course_save", "parent_course_delete", "parent_stats", "log_activity", "move_file", "copy_file"],
    customTools: [getDateTool, parentUpsertCourseTool, parentDeleteCourseTool, parentStatsTool, logActivityTool, moveFileTool, copyFileTool],
  });

  cachedParentSession = session;
  return session;
}

/**
 * 教学内容生成会话（ISSUE-026 原专用会话）：2026-08-24 起提示词与工具均与通用家长会话统一
 * （buildParentPrompt + 家长工作台全量工具），仅保留独立单例与 childId="parent-content"
 * （前端 TopicDetail / TopicEditor 的事件过滤仍按该 childId 区分）。
 */
export async function getParentContentSession(): Promise<AgentSession> {
  if (cachedParentContentSession) return cachedParentContentSession;

  // SPLIT M8-B：创建前远程预取家长 AGENTS 用户版本到本地缓存
  await fetchAgentPromptRemote("parent", "main").catch(() => null);
  await fetchAgentPromptRemote("parent", "content").catch(() => null);

  const dataDir = getDataDir();
  const modelRuntime = await getSharedRuntime();
  const model = await getDefaultModel();

  const loader = new DefaultResourceLoader({
    cwd: dataDir,
    agentDir: path.join(dataDir, ".pi", "agent"),
    systemPromptOverride: () => buildParentPrompt(),
    noSkills: true,
    extensionFactories: [learningGuardExtension],
  });
  await loader.reload();

  // 家长会话落盘 + autoNewSession 策略（同 getParentSession，独立 sessions 子目录）
  const sessionsDir = getParentSessionsDir("parent-content");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const mgr = SessionManager.continueRecent(dataDir, sessionsDir);
  if (shouldAutoNewSessionForParent(sessionsDir)) {
    mgr.newSession();
  }

  const { session } = await createAgentSession({
    cwd: dataDir,
    modelRuntime,
    model,
    sessionManager: mgr,
    resourceLoader: loader,
    tools: ["read", "write", "edit", "ls", "get_date", "parent_course_save", "parent_course_delete", "parent_stats", "log_activity", "move_file", "copy_file"],
    customTools: [getDateTool, parentUpsertCourseTool, parentDeleteCourseTool, parentStatsTool, logActivityTool, moveFileTool, copyFileTool],
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
      // ⚠️ 路径语义必须与 display_content 工具一致（见 custom-tools.ts）：
      //    materials/<topic>/<file> → 父库共享目录 data/parents/<pid>/materials/
      //    （2026-08-27 修复：此前一律用孩子 cwd 解析，父库资料路径必然读不到 →
      //     恢复出的条目 content 为空 → 退出孩子模式再进入时资料白屏）
      //    outputs/<file> → 孩子本地 cwd/outputs/
      let content = typeof args.content === "string" ? args.content : "";
      if (!content && cwd) {
        try {
          let resolved: string;
          const matM = /^materials\/([^/]+)\/(.+\.(?:html|htm))$/i.exec(filePath);
          if (matM) {
            const parentMatRoot = getParentMaterialsDir();
            resolved = path.join(parentMatRoot, matM[1], matM[2]);
            if (resolved !== parentMatRoot && !resolved.startsWith(parentMatRoot + path.sep)) {
              throw new Error("资料路径超出父库共享目录");
            }
          } else {
            resolved = path.resolve(cwd, filePath);
            if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
              throw new Error("资料路径超出学习目录");
            }
          }
          content = fs.readFileSync(resolved, "utf-8");
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
