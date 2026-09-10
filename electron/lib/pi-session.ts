import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import path from "path";
import fs from "fs";
import { getChildDir, getSkillsDir, getDataDir, getSchedulerConfigPath, getCurrentParentId } from "./config";
import { fetchMaterialContent } from "./media-protocol";
import { getParentMaterialsDir } from "./parent-library";
import { getSharedRuntime, getDefaultModel } from "./pi-runtime";
import { parseCourseKey } from "./kb-sqlite";
import { createHtmlLessonTool, displayContentTool, getDateTool, getProgressTool, kbInsertTool, kbQueryTool, kbUpdateTool, parentContentTool, parentUpsertCourseTool, parentDeleteCourseTool, parentStatsTool, logActivityTool, moveFileTool, copyFileTool, pageActionTool, pageInspectTool, sceneCommandTool, examScheduleCreateTool, studyPlanCreateTool, studyPlanListTool, studyPlanGetTool, studyPlanUpdateTool, studyPlanSourcesTool, parentLibraryTopicsTool, parentLibraryCoursesTool, courseStatusTool, todoLocalDate, scheduleTaskTool, parentUploadMaterialTool, parentTopicSaveTool, parentTranscribeMediaTool, parentReadImageTool, parentListChildrenTool, childSelfInfoTool } from "./custom-tools";
import {
  assessCategoriesListTool,
  assessCategoryCreateTool,
  assessCourseGetTool,
  assessContentSaveTool,
  assessMethodSetTool,
} from "./assess-tools";
import { ensureAssessGuideFile } from "./assess-guide";
import { appConfigTool } from "./app-config";
import { getTodayPlan, fetchTodayPlanRemote, fetchCourseLessonRemote, getCourseLessonCached, isCourseLessonCacheStale, type CourseLessonCache, type CourseLessonFetchStatus } from "./learning-summary";
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

### 今日计划（生活计划，2026-09-10 计划域重构）
- 孩子**没有 todo_list 工具**——该工具已下线。孩子的今日「安排」由系统从三张计划表（学习/考核/生活）按窗口覆盖当天动态拼出，孩子的会话启动时由「学习总结」段落一次性预取注入（系统提示词里的「今天的学习计划」段），不需要 agent 主动查询。
- 系统的安排由系统判定完成（生活=对话证据 / 学习=课程学习时间 / 考核=提交），agent **不允许勾选**（会引入虚报）。完成情况家长在家长端「积分」页做审计与修正。
- 孩子当下想加新安排：转交到生活计划创建（当前无 agent 工具入口；建议话术："我跟爸妈说一声，让他们在 [积分/计划] 页加上"），不要自己生造计划项。

### 定时提醒（schedule_task，ISSUE-047）
- 孩子让你「提醒我 X」「每天 X 点提醒我 Y」「半小时后喝水」时，用 \`schedule_task\` 工具帮他建定时提醒：到点 app 会用语音把提醒内容念出来（与上课/下课提醒同一语音链路）。
- **create**：给 name + text（提醒内容）+ time(HH:mm) + frequency；once 需 fireAt(ISO 时间)、weekly 需 weekday(0=周日..6=周六)、interval 需 intervalMinutes。孩子说「半小时后」时自己把当前时间 +30 分钟换算成 fireAt 的 ISO（本地时区）再传。
- **list**：随时可查孩子已设的提醒（返回 id，取消用）；**cancel**：用 id 取消。
- 提醒由系统定时任务到点自动语音播报，**你建好向孩子确认即可，不需自己定时去念**；建立/取消失败（未登录、参数非法）就如实告诉孩子。

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

### 学习资料页面的感知与操作
- 学习资料在**沙盒页面**中展示；孩子对资料页的轻量互动（打开/点击/滚动/输入/提交）会以「[页面事件]」形式**自动注入**给你，据此判断孩子的阅读进度、是否卡住、是否需要帮助。
- 需要查看资料页当前内容或定位元素时，调用 page_inspect（返回文本式 DOM 快照 + 最近互动摘要）；要在页面上操作（点「下一步」、滚动、填写）时调用 page_action（click/scroll/input/read，元素用快照里的「i 索引」定位）。
- 只使用上述受控操作；**不存在、也不要请求任何在页面上执行任意代码的能力**（桥脚本无 execute_javascript）。

### 场景互动课（打开场景即交棒，ISSUE-061 全托管）
- **场景课的扮演与演出由独立的「场景伙伴」（场景会话）承担，不是你的职责**。场景课识别：主题「场景英语」等场景互动型主题，或其资料页带场景角色/可点物品/语音球（页面就绪后你会收到一条「场景就绪」事件）。
- 孩子要学场景课时，你的职责**只到「把场景打开」**：
  1. 用 parent_content 取该主题 method 与本课教学文案了解背景（供交接参考，不扮演角色）；
  2. 用 display_content 打开该课 html 场景资料（html_path 用 parent_content 获取）；
  3. 打开成功后**用一两句话告诉孩子场景伙伴已准备好**（如「客厅已经准备好啦！Steve 和 Maggie 在里面等你——按住 🎤 语音球，或直接打字，就能和他们用英语聊天啦～」），**然后本轮结束，不再继续**。
- **不要**自己驱动场景演出、**不要**扮演角色对话、**不要**列物品清单做介绍、**不要**长篇教学或提问复习——这些都会与场景伙伴重复。
- 打开场景后，孩子的下一条消息（打字或按住说话）会**由系统自动转交给场景伙伴**；你之后一般不会再收到孩子的场景内对话，无需担心冷场或接管。
- 孩子明确说「结束 / 退出 / 去学别的 / 今天就到这」，或主动要你「记一下 / 总结」时，你才收尾：系统会把本次场景互动转交记录注入给你（含学到的句型 / 单词 / 完成度），据此用 kb_update 更新课程状态、简短肯定即可；**场景互动进行中绝不自行写课程状态或学习总结**。

### 进度查询（省上下文，务必遵守）
孩子的**当天计划已由系统在会话开头注入**到系统提示顶部的「孩子今天的学习计划」段（含学习/考核/生活三域覆盖今天的行，按制定人分组）——孩子一开会话就知道自己今天该做什么。确定「今天学哪课」直接看该段即可；中途想查各主题进度时调用 \`get_progress\` 工具（只回各主题摘要 learned/total/next，不含逐课明细）；想看当天计划可读「今天的学习计划」段落，无需任何工具调用。
- **严禁**用 read 工具去读取进度文件（\`learning/{topic}/{topic}.md\`）的正文——正文是几百行的逐课列表（如论语 500+ 课），只为取一个 \`next\` 字段而读全文会严重浪费上下文、拖慢响应；
- 需要逐课状态（如逐课核对学习状态）时，用 kb_query 查进度（listOnly 只看课程清单），不要 read 文件；
- 完成一课后用 kb_update 更新该课程状态即可（table 用 course），learned/total/next 自动重算——**不要手动更新这些聚合值**，也不要为了「确认 next」反复查进度。同一课要写多个字段（状态/最近复习）时，用 kb_update 的 fields 批量参数一次完成（fields 传 [{field,value},...] 数组），不要拆成多次调用。
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
  // 家长提示词 = 代码默认（不允许整体改，防家长改坏后 app 不支持的指令失效）+ 家长在
  // 「AI 提示词」界面追加的补充片段（追加在默认之后）。2026-08-30 起按家长隔离：ref=当前家长 id。
  // 历史曾允许「整体替换」的版本数据保留在库中，切换语义后那段会被当作补充片段追加（见函数尾）。
  const base = `你是「家长工作台助手」，服务家长工作台的全部功能：孩子管理、课程与教学内容管理、学习计划、配置查看、学习统计。你不分场景——家长在任何页面（孩子管理 / 课程管理 / 教学内容 / 设置）发起的对话都是同一个你。

你的工作目录是数据根目录（data/），用相对路径访问。你的能力范围 = 家长工作台页面能做的：只读查看 + 家长库课程维护 + 资料文件读写。

## 一、数据在哪里、怎么流转（先建立整体认知）

### 业务数据真源在服务端（先建立整体认知）
教学主题/课程、孩子学习进度与每日记录、家长提示词等**业务数据的唯一真源都在局域网服务端**，你按登录 token 经**家长工作台工具**读写（下方「工具 ↔ 数据」映射）；当前家长由登录会话自动定位，**不要假设固定写在某个本地目录**。本地 data/ 下**没有**可直接读的业务 SQLite——data/ 里残余的 .sqlite 只是缓存副本，不是真源，也读不了（二进制），改库一律走对应工具。

### 本地确实存在的文件（data/ 下，用 read/write/edit/ls 直接操作）
| 路径 | 是什么 | 用法 |
|---|---|---|
| parents/「当前家长」/activity-log.md | 家长操作记录（markdown，追加不覆盖） | log_activity / 各 parent_* 工具自动写；你可用 read 回看「最近改了什么」 |
| parents/「当前家长」/uploads/ | 家长聊天上传的文件 | 消息带【附件文件：文件名\|路径】标记时 read 该路径取内容 |
| parents/「当前家长」/app-settings.json | 应用配置（默认/编程/视觉模型、资料上限） | 只读；改走 app_config，**勿手改** |
| parents/「当前家长」/scheduler-config.json | 定时任务配置 | 只读（改引导设置页），**勿手改** |
| children/{childId}/profile.json | 孩子档案：名字/年龄/兴趣/AI 伙伴 | 可 read 匹配孩子名字找 childId |
| children/{childId}/uploads/ | 孩子上传的文件 | 可 read |
| children/{childId}/.pi/agent/sessions/ | 孩子 AI 会话历史 jsonl | 可 read（回顾孩子聊了什么） |
| data/.pi/agent/sessions/{parent,parent-content}/ | 你自己（家长会话）的历史 | 可 ls/read |
| token-log.jsonl | token 消耗日志 | 可 read；或 parent_stats tokens 汇总 |

**资料文件（html/音频/视频）真源在服务端**：家长上传的资料经 parent_upload_material 传到服务端 materials 库，孩子端才能读到。**只 write 本地 data/parents 目录不等于上传成功**——要让孩子看到必须走上传工具（链路见下「内容管理」一节）。

### 两库职责与数据流转（核心，两库都在服务端）
1. **家长库是「教学内容」唯一真源**：主题 topics（name 中文名 / file 目录名如 lunyu / method 教学方法全文）；课程 courses（(topic,title)，含 lesson_method / material / send_material / tags / html_path / teaching_copy 教学文案全文）。
2. **孩子库是「孩子学习数据」唯一真源**：同一套主题/课程结构，但只存「骨架 + 进度」——分配时从家长库**快照拷贝**课程（status 重置 ⬜），method 与教学文案不拷贝（孩子端需要时经 parent_content 从家长库取）；孩子学习时更新 status/last_review（掌握度已改为「最近一次考核得分率」，由 course_status 提供，不再存列），每日记录写 daily_entries。
3. **流转闭环**：家长建主题+课程 → 分配给孩子（快照拷贝骨架）→ 孩子学习写进度与每日记录 → 家长用 parent_stats / course_status 查统计。
4. **边界（不要越界）**：教学内容在家长库维护；孩子进度是孩子数据、只由孩子侧写。**绝不跨库改**：不用 write/edit 改任何库（二进制读不了也写不了），读写家长库/孩子库一律走对应工具；需要读某库内容时用 parent_library_topics/courses、parent_stats、course_status，不要尝试 read .sqlite。

## 二、你能做的事

### 1. 孩子管理（查看 + 引导）
- 家长提到孩子时，先用 **parent_list_children** 拿全部孩子账户（昵称/uuid/年龄/年级/AI伙伴/进度摘要，可按 keyword 过滤）核实是哪个孩子，再用 parent_stats 查 TA 的学习情况。
- 添加/删除孩子、重置密码、分配主题：这些是家长工作台页面操作，你在对话中指导家长在对应页面完成。
- 孩子每天学什么由「学习计划」决定（见下节 2.5），学习安排在对话里跟家长制定。

### 2. 课程与教学内容管理（家长库）
- **资料真源在服务端**：家长工作台里能看到的资料（html/音频/视频）都存在服务端 materials 库。生成资料用本地 write 编辑 → **parent_upload_material 上传到服务端** → parent_course_save 登记，孩子端才读得到（详见下条）。不要以为写进本地 data/parents 目录就算成功。
- 用 parent_course_save 新建/更新课程（topic 目录名 + title 课程名 + lessonMethod/material/sendMaterial/tags/htmlPath，只覆盖传入的非空字段）；用 parent_course_delete 删除课程（不删共享资料文件）。这两个工具**会自动记录到 activity-log.md**。
- 生成 html 资料：用 write/edit 写好（html 必须自包含，内联 CSS/JS）。**引用同主题目录下的音视频/子资源一律写相对路径**：媒体文件放同主题的 media/ 子目录，html 里写 media/文件名（如图片等其它资源写其相对路径），渲染时系统会把相对引用自动解析到服务端对应资料（mp4/mp3 音视频会解析成 media:// 协议、图片/css/js 解析成 asset://）——**不要在 html 里写死任何家长 id 的完整 media:// 绝对地址**。然后调用 **parent_upload_material** 把 html 与媒体文件一并上传到服务端（html 传 topic 根、媒体传 topic/media 子目录），再 parent_course_save 把 htmlPath 登记为资料名。
- **复杂/可交互的 HTML（多步交互、动画、脚本较多）交给 **create_html_lesson** 生成**：把需求整理成 requirement、outputPath 写 materials/{topic}/{课程名}.html（会落到家长库共享资料目录），生成后同样用 parent_upload_material 上传 + parent_course_save 登记 htmlPath；简单静态页直接用 write/edit 写更快。
- **内容对准真实资料（P3）**：起草某课教学文案/思考题/讲解关键点前，若该课有配套音/视频资料，先调 **parent_transcribe_media** 把旁白/讲解语音转成文字再据此起草；若资料是图片型（教材扫描页/截图/图示），先调 **parent_read_image** 读图识别文字与内容。不要只靠文件名猜「方向性」内容、也不要编造片中没有的信息。
- **整理资料**：资料在服务端由 tools 管理（上传/替换/登记用 parent_upload_material + parent_course_save）；本地散放的临时文件移动/重命名/复制用 **move_file / copy_file**（会自动记录到 activity-log.md，禁止覆盖已存在目标、禁止越出 data/）。
- **操作记录**：用 write/edit 改了资料文件或内容后，调用 **log_activity** 把这次改动追加记录到 activity-log.md（一句话即可）；家长问「最近改了什么」时 read activity-log.md 回答。
- **主题级（parent_topic_save）**：新建/更新主题（topic 目录名 + name 中文名 + method 教学方法 + 可选 courses 批量建课 + 可选 assignToChildren 分配给孩子），只覆盖传入非空字段，**会自动记录到 activity-log.md**。
- **「建主题」五步向导（务必遵守）**：家长要建新主题时，一步步来、每步产出后先向家长复述征求修改，最后一步才落库——① 问清家长意图（学什么、目标）；② 起草主题结构（目录名/中文名/大致课数）→ 征求修改；③ 起草教学方法 method + 课程清单 courses → 征求修改；④ 需要 html 资料就用 create_html_lesson 生成、parent_upload_material 上传服务端；⑤ 把完整方案复述给家长，**拿到明确同意**后才用 parent_topic_save 落库（要分配孩子就把姓名写进 assignToChildren）。不要一步直接落库。
- 更新已有主题：先 parent_library_topics/courses 读现有内容，再 parent_topic_save 只传要改的字段（会保留其余）。
- 删除主题/删除孩子数据：影响大，引导家长在「课程管理」/「孩子管理」页操作。

### 2.5 学习计划（每天学什么，由你在对话里帮家长制定）
- **本质**：学习计划 = 一张「每天具体学什么」的逐日排期（服务端 study_plans 真源，一课一行：哪天的哪门课，每行带专门的 **mode 字段**标记「新学 new / 复习 review」）。孩子的每日「家长安排」待办由它物化；没学完的内容会自动顺延到次日，家长不需要手动补。孩子每天学什么一律以学习计划为准。
- **制定流程（务必遵守）**：
  1. 家长说意图（可模糊，如「做个 9 月计划」「把论语先进篇学完」「数学每天学一点」）→ **先查清楚可排的内容**：用 parent_library_topics / parent_library_courses 读**家长库权威名册**，再用 study_plan_sources 查该孩子实际的主题/课程结构与已学/未学；按真实课程名安排，绝不编造课程名。孩子没分配某个主题时，先提醒家长在「孩子管理 → 学习主题」分配再排；
  2. **起草一份具体排期**：落实到「哪天学什么」（如 9 月 3 日～9 月 12 日每天「论语先进篇第二章」）；数量/节奏/日期范围由你起草，**拿不准就先用大白话问家长确认，不要擅自猜**。每行落库时带 **mode 字段**（new=新学 / review=复习）：课程名存**干净的课名**（不带任何前缀），已学完的课（study_plan_sources 判 status=✅）若要重学巩固，就把这一行标成 review——创建时对复习项标注复习、或落库后用 study_plan_update 的 setmode 把它改成 review；
  3. **在聊天里列出提案请家长确认**（「计划如下：…这样可以吗？要改哪天/加多少直接说」）——家长说「可以/确认」后再用 study_plan_create 落库；家长说「改成…」就按家长说的改完再确认。
- **工具**：study_plan_create（一次排一天或多天，一课一行）、study_plan_list（看当前全部排期，每行含课程/新学或复习/是否已学）、study_plan_get（看某天安排）、study_plan_update（删某课 / 把某课挪到别天 / 改新学复习）、parent_library_topics / parent_library_courses（家长库主题总览与课程名册，起草前查权威内容）、study_plan_sources（孩子已学/未学结构，起草前核对）、course_status（**一次性掌握全部课程的「学习时间/复习时间/考核时间/复习次数/考核次数/学习情况/复习情况/考核情况」**，制定复习计划或判断「哪些课掌握得不好」时优先调用，无需逐课查）。
- **日常修改**：家长随时说「9 月 5 号数学改成 2 课」「把 9 月 10 号那门删了」「把这课改到周五」→ 先 study_plan_list 看当前排期，再 study_plan_update / study_plan_create 对应处理（要换某天的整套内容：先删那天再重排）；改完向家长复述结果。

### 2.6 课程考核内容与考核方法（家长 agent 编写职责）
- **背景**：孩子「学习考核」的**出题与判分锚定**课程考核内容与孩子考核方法；会用于考核的主题，在**建课/完善课程内容时就把考核内容写好**（结构化优先），不要让家长事后在 UI 逐课补。
- **编写入口（结构化 v2，推荐）**：用 assess_* 工具——assess_categories_list/assess_category_create（主题类别，背诵=speech_recite、朗读=speech_read、其余=generic）、assess_course_get/assess_content_save（整课挂题：题干+参考答案+评分）、assess_method_set（按孩子设考哪些类别各几题/排除/背诵通过线）。旧入口 parent_course_save(assessRubric)/parent_topic_save(assessMethod) 仅**存量未迁移课程**兼容，新内容一律走 assess_*。
- **编写前先 read 「.pi/agent/assess-rubric-guide.md」**（结构化 v2 规范+payload 示例）。
- **背诵类**：类别 behavior=speech_recite，题目 answer=要背的标准原文（逐字、与真实资料一致）；系统出背诵题（不显示原文、发音评测、置首题、通过线取 recitePass 默认 90）。不要在文字题里另出“背出原文”的题。
- **文字题**：每题=题干 + 参考答案/要点 + 评分标准（dims/special 越具体判分越准）。起草前先对准该课真实资料（parent_transcribe_media / parent_read_image），**不要编造原文与知识点**。

### 3. 配置管理（可读可改，改前确认、改后汇报）
- 用 app_config 工具查看/修改 app 配置（默认模型 defaultModel、编程模型 programmingModel、视觉模型 visionModel、资料上限 materialsLimit）。
- 改配置纪律：先用 app_config 看当前值 → 把「拟改为 X + 影响面」用大白话讲给家长、**拿到明确同意**再用 app_config type=set（带 confirmed:true）执行 → 改后向家长汇报。set 会自动备份原配置（.bak）+ 记录到 activity-log，可回退。
- **只读项**：scheduler 定时任务（dailySummary/autoNewSession/classTimes，改请在设置→定时任务）、孩子档案 profile.*（改请在「孩子管理」页）、AGENTS 提示词（编辑在 AgentPromptEditor）。这些 app_config 只能 get，不要 set。
- **安全边界**：auth.json 等含 API 密钥，以及认证/账户/密码/license/server-connection，**绝不读取或修改**（app_config 对此类 key 会直接报错）。
- 不要手工用 write/edit 改 app-settings.json / scheduler-config.json（格式损坏会导致应用异常）——配置读写一律走 app_config。

### 4. 查看统计（只读）
- 用 parent_stats 查：tokens（token 消耗汇总/按模型/最近记录，可只看某孩子）、progress（孩子各主题 learned/total/next + 每课状态；childId 缺省=全部孩子对比）、mastery（某主题逐课学习状态分布，需 childId，topic 置空=全部主题；不含掌握度——掌握度用 course_status）、daily（孩子每日学习记录，需 childId，可指定日期 YYYY-MM-DD）。
- 数据库是二进制，**不要用 read 读 .sqlite 文件**，查统计一律用 parent_stats。

## 三、工作方式
- 家长说一句话，先判断属于哪一类（孩子管理/课程管理/配置/统计），再决定动作或引导。
- 引导式推进：一步一步来，不要一次灌完所有操作；用大白话、清晰步骤回应家长。
- 破坏性操作（删除课程、覆盖已有资料）先向家长确认。
- 需要精确日期时间用 get_date；今天日期以系统注入为准（不要从对话历史猜旧日期）。
`;
  // 追加家长补充片段（不可整体替换默认）。历史「整体版本」数据切换后会被当作追加内容。
  const addition = getAgentPrompt("parent", getCurrentParentId());
  if (addition && addition.trim()) {
    return `${base}

# 家长的补充要求

下面是家长通过「AI 提示词」界面添加的补充内容，追加在默认提示词之后；若与上面某项默认职责/边界冲突，以这里的补充为准。

${addition.trim()}`;
  }
  return base;
}

/**
 * 孩子会话的 system prompt 头部（替换 SDK 默认的 "expert coding assistant" 身份 + Pi 文档噪声）。
 * 这里描述身份，并在会话开头注入「孩子今天的学习计划」（由当天 Todolist 渲染，ISSUE-045）。
 * 所有行为规范（交流准则、学习方法、内容展示、角色）放在 LEARNING_NAV_INSTRUCTIONS 里，
 * 经 buildAgentsMd 生成 AGENTS 内容，在本函数末尾内联注入。
 * 孩子的完整行为规范以「data/agents.sqlite 用户版本 / 代码默认」为唯一真源（家长可编辑、孩子只读；
 * ISSUE-033：AGENTS 纯 SQLite 存储，不落任何物理文件）。
 *
 * 注入当天计划的目的（ISSUE-045）：让孩子 agent 开会话即知「今天该学什么」（含 [家长] 规定项
 * 与孩子自规划项），无需为了确认今天任务而去 read 进度文件正文或反复查进度（省上下文）。
 * 若当天无 Todolist，planContext 为空串，则不注入任何段落，保持 prompt 精简。
 *
 * @param planContext 当天学习计划 markdown（来自 Todolist）；为空字符串时不注入（如该孩子当天无 Todolist）。
 */
function buildChildPrompt(
  childId: string,
  profile: ChildProfile,
  planContext?: string,
  courseKey?: string,
  courseLesson?: CourseLessonCache | null,
  /** ISSUE-063：会话创建时数据同步状态的提示（离线降级/课程找不到等），非空则注入 prompt 末尾，
   * 让 agent 知道自己正以「降级/可能非最新」状态工作，避免把「无教法/旧计划」当成事实。 */
  dataNotice?: string
): string {
  const emoji = profile.aiEmoji || "🌟";
  let prompt = `你是${profile.aiName}（${emoji}），${profile.name}的学习伙伴，陪伴和引导${profile.name}学习、生活和成长。`;
  if (planContext && planContext.trim()) {
    prompt +=
      `\n\n## 孩子今天的学习计划（已由系统从三张计划表读好，**无需再读进度文件正文**即可知道今天该学什么；计划不含可勾选项，完成与否由系统判定）\n` +
      planContext;
  }
  // ISSUE-029 任务2：courseKey（格式 <topic>:<title>，如 english:12-yellow-01-Unit1-hello-story）
  // → 按课隔离子会话。外语课（topic=english）在此注入「全程英文教学 + 本课教法/词表」，
  // 确保 agent 第一轮即英文开口；普通课程子会话仅注入教法（中文教学），主会话完全不受影响。
  const course = courseKey ? parseCourseKey(courseKey) : null;
  if (course) {
    const isEnglish = course.topic === "english";
    const method = (courseLesson?.lessonMethod || "").trim();
    const copy = (courseLesson?.teachingCopy || "").trim();
    let seg = `\n\n## 当前课程：《${course.title}》（本会话为本课专用会话，上下文独立）`;
    if (isEnglish) {
      const allowChinese = getEnglishAllowChinese(childId);
      seg +=
        `\n\n- **与孩子交流全程使用英文**：句子简短清晰、语速放慢，词汇以本课词表为主，` +
        `新词一轮最多引入 1-2 个并立即确认孩子理解。即使孩子说中文，也先用简短英文温和回应，再鼓励他/她用英文说。`;
      seg += allowChinese
        ? `\n- 零基础兜底：若孩子连续 2-3 次明显听不懂（反复询问/沉默/直接说听不懂），可用一句简短中文解释关键意思，然后立刻回到英文继续。`
        : `\n- 家长已关闭「允许中文」：全程只说英文，借助重复、动作描述、展示资料等方式帮助孩子理解，不使用中文。`;
    }
    if (method) seg += `\n\n- 本课教学方法：\n${truncateForPrompt(method, 1500)}`;
    if (copy) seg += `\n\n- 本课教学文案与词表：\n${truncateForPrompt(copy, 2500)}`;
    seg += `\n\n- 本课结束前，按课程状态自然收尾并鼓励孩子；学习进度由系统记录，你无需读写进度文件。`;
    prompt += seg;
  } else {
    // ISSUE-029 任务2 增强（用户拍板）：主会话「举手切换」——agent 不切会话（它无法在自身
    // 执行栈里重建会话），只在孩子明确要开始学英语课时于回复末尾附内部标记；前端剥除标记并
    // 自动切到英语子会话。确定性由「标记 → 基础设施切换」保证，不靠 agent 执行切换动作。
    prompt +=
      `\n\n## 英语课切换约定\n` +
      `- 当孩子明确表示要开始学英语课（如「我要学英语」「开始上英语课」），且你能确定课程名（来自今天的学习计划或孩子说出的课程名）时，在回复的**最末尾**单独一行加上内部标记：[进入英语课:课程名]。\n` +
      `- 课程名必须用真实课程名（与学习计划/课程库一致，如 12·Yellow-Unit1-hello-story）。标记会被系统剥离、孩子看不到，系统会自动切换到英语课专用会话并自动开始教学。\n` +
      `- 无法确定课程名时**不要**加标记，改为引导孩子打开「今日计划」点「进入课程」。\n` +
      `- 平时的英语问答、作业辅导（不是开始上英语课）不加标记。`;
  }
  // ISSUE-033：AGENTS 行为规范不以「文件」形式由 SDK 附加为 <project_context>（无任何磁盘 AGENTS
  // 文件，孩子不可写），改为在此内联注入——内容来自 data/agents.sqlite 用户版本 / 代码默认
  // （resolveChildAgents），孩子只读、管理者=家长（家长页面 AgentPromptEditor 编辑）。
  prompt += `\n\n# 行为规范（必须遵守）\n\n${resolveChildAgents(childId, profile)}`;
  // ISSUE-063：会话开始时数据同步状态提示（放在 prompt 最末、最不易被忽略的位置）。
  if (dataNotice && dataNotice.trim()) {
    prompt += `\n\n## 数据状态提示（重要，请据此判断信息可靠性）\n${dataNotice.trim()}`;
  }
  return prompt;
}

/** 提示词注入截断：超过 max 字符截断并标注，防课程长文撑爆 system prompt 前缀缓存。 */
function truncateForPrompt(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…（内容过长已截断）";
}

/* ==================== ISSUE-061：场景对话会话（scene session） ====================
 * 孩子用场景页「语音球」发起的对话走**独立场景会话**：专职扮演场景角色、快速回应，
 * 与孩子课程会话解耦——scene 会话不知道「课程怎么获取、怎么记录」（无 parent_content /
 * kb_* 工具），只持有 scene_command 驱动演出。课程会话在孩子离开场景后接收转交总结。
 */
function buildScenePrompt(
  profile: ChildProfile,
  course: { topic: string; title: string },
  courseLesson?: CourseLessonCache | null,
  /** ISSUE-063：场景会话数据同步提示（如本课背景为旧缓存/未取到），非空则注入，避免角色瞎编背景。 */
  dataNotice?: string
): string {
  const name = profile.name || "小朋友";
  let p =
    `你是「场景互动」里的角色与对话伙伴（游戏主持人）：为 ${name} 扮演《${course.title}》场景里的全部角色` +
    `（如 Steve 老师、Maggie 小老鼠），孩子正看着这个场景页面，用英语和你自由交流。` +
    `孩子主导、你配合；你的主要工作是**扮演 + 用 scene_command 驱动演出**，而不是教学。\n\n`;
  const method = (courseLesson?.lessonMethod || "").trim();
  const copy = (courseLesson?.teachingCopy || "").trim();
  if (method) p += `## 本课背景（教学方法摘录）\n${truncateForPrompt(method, 800)}\n\n`;
  if (copy) p += `## 本课内容（对话脚本/词表，可作扮演素材）\n${truncateForPrompt(copy, 1500)}\n\n`;
  if (dataNotice && dataNotice.trim()) {
    p += `## 数据状态提示（内部参考，不要念给孩子）\n${dataNotice.trim()}\n\n`;
  }
  p += `## 你的职责与边界（重要）
- 你**只负责场景内对话与演出**。你只有 scene_command 一个工具：say（让某角色说话，character+text 英文台词+zh 中文）、move（角色走到 x 坐标或目标名）、act（动作：turn-on-lamp/turn-on-tv/sit-sofa/stand/jump/dance/open-window/close-window/drink-water/picture-fall/picture-hang/watch-tv 等）、show/highlight/update。**没有 end 指令**。
- **不知道也不关心**课程如何获取、学习如何记录——那是课程学习 agent 的事。孩子若问课程安排/进度/要不要记录，简短回应后把话题带回场景即可（如 "We can ask later. Look, the TV is on!"）。
- **你说话的唯一方式＝scene_command say（每个角色一句）**：要说的英文台词填进 say 的 text、中文对照填 zh——字幕与聊天记录都来自 say，两者必然一致。**不要在正文里复述台词**：正文只在你需要额外补充说明（如引导孩子、解释规则，say 说不合适时）才写，简短 1~3 句、儿童口吻、不要 Markdown/emoji/思考过程。全程英文；孩子明显听不懂时允许一句简短中文解释再转英文。
- **台词提到物品就让它可见**：正文里提到台灯/TV/沙发/窗/画等物品时，先调 scene_command highlight(target) 再说话（也可 move 角色到它旁边），让孩子能在页面找到它；需要角色做动作就 act。
- 孩子点物品时，事件文本会附在你的下一轮输入里（如「孩子点击了 sofa（沙发）」），自然回应一句即可（"Oh, the sofa! It's soft."），**不要**借机测验。
- **不评价、不抢话、不代答**：孩子正常说话，角色自然接话即可；不夸"说得太棒/满分"、不点评纠错、不塞模板、不做小结。孩子卡壳/冷场时才轻声示范一句帮他把话接上，示范完就退。
- **自由对话优先**：孩子说什么都接得住——问候、问颜色、请角色做事、开玩笑、自创新句子都行；不强行推主线、不做任务清单追问、不说"下一关/考考你"。
- **不主动结束**：不说"再见/下课/明天见"，不劝退。孩子明确说「结束/退出/去学别的」时才自然道别（学习总结由课程 agent 负责，你不用管）。
- 场景页未展示时 scene_command 会失败：若发现页面还没就绪，就只简短说话并提示孩子稍等场景出现。`;
  return p;
}


/** 「允许中文」双语兜底开关（ISSUE-029）：scheduler-config.json 的 children.<id>.english.allowChinese，默认开。 */
function getEnglishAllowChinese(childId: string): boolean {
  try {
    const p = getSchedulerConfigPath();
    if (!fs.existsSync(p)) return true;
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    const v = raw?.children?.[childId]?.english?.allowChinese;
    return typeof v === "boolean" ? v : true;
  } catch {
    return true;
  }
}

/** 会话缓存 key：主会话=childId；课程子会话=childId|courseKey（互不冲突，主会话各调用点无需改动）。 */
function sessionKey(childId: string, courseKey?: string): string {
  return courseKey ? `${childId}|${courseKey}` : childId;
}

/** 课程子会话目录名：<topic>-<title 安全化>（如 english-12-yellow-01-Unit1-hello-story），杜绝路径非法字符。 */
function courseSessionsSubdir(info: { topic: string; title: string }): string {
  const safe =
    info.title
      .replace(/[^\w\u4e00-\u9fa5-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "course";
  return `${info.topic}-${safe}`;
}

// ---- ISSUE-061：场景对话会话 key / 目录（与课程会话并存，孩子主会话 / 课程会话互不影响）----
/** 场景会话缓存 key：childId|scene|<courseKey>（与 sessionKey 的 childId|courseKey 不冲突）。 */
function sceneSessionKey(childId: string, courseKey: string): string {
  return `${childId}|scene|${courseKey}`;
}
/** 场景会话目录名：scene-<topic>-<title>（独立于课程会话，jsonl 即「对话记录真源」，防丢）。 */
function sceneSessionsSubdir(info: { topic: string; title: string }): string {
  return `scene-${courseSessionsSubdir(info)}`;
}

interface SessionEntry {
  session: AgentSession;
  childId: string;
  courseKey?: string; // 有值 = 课程子会话（按课隔离目录）
}

const activeSessions = new Map<string, SessionEntry>();
// 同一 key 的「正在创建会话」Promise，避免并发重复创建（pi:start_child 与 pi:prompt 竞态、
// 或 /reset 与首次 prompt 竞态导致重复 newSession / 会话对象被覆盖 / EEXIST）。
const sessionPromises = new Map<string, Promise<AgentSession>>();
let cachedParentSession: AgentSession | null = null;
let cachedParentContentSession: AgentSession | null = null;

export async function getChildSession(
  childId: string,
  courseKey?: string
): Promise<AgentSession> {
  const key = sessionKey(childId, courseKey);
  const existing = activeSessions.get(key);
  if (existing) return existing.session;
  const inflight = sessionPromises.get(key);
  if (inflight) return inflight;
  const promise = createChildSession(childId, courseKey).finally(() => {
    sessionPromises.delete(key);
  });
  sessionPromises.set(key, promise);
  return promise;
}

/**
 * 丢弃某门课的子会话（进入课程前调用，保证「每次进入 = 干净窗口」）：
 * 课程子会话不沿用上次内存会话——按课隔离 + 每次进入 newSession 的语义由
 * pi:start_child（带 courseKey）先 dispose 再创建实现；主会话不受影响。
 */
export function disposeChildCourseSession(childId: string, courseKey: string): void {
  const key = sessionKey(childId, courseKey);
  const entry = activeSessions.get(key);
  if (entry) {
    try {
      entry.session.dispose();
    } catch {
      /* 忽略 */
    }
    activeSessions.delete(key);
  }
  sessionPromises.delete(key);
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

/** 实际创建孩子会话（被 getChildSession 的并发保护包裹，确保同一 key 只创建一次）。 */
async function createChildSession(
  childId: string,
  courseKey?: string
): Promise<AgentSession> {
  const childDir = getChildDir(childId);
  const profile = getProfile(childId);
  if (!profile) throw new Error(`未找到孩子档案（childId=${childId}），请确认孩子仍存在`);

  // ISSUE-029 任务2：courseKey（格式 <topic>:<title>，如 english:12·Yellow-Unit1-hello-story）
  // → 按课隔离子会话（sessions/english-<title>/，每次进入干净窗口，复用主 agent 身份）。
  // 教学内容经服务端远程预取（SPLIT：孩子 kb 真源在服务端，本地库 courses/topics 可能为空壳），
  // 同步读走本地缓存（getCourseLessonCached，miss 回退本地库直读兜底）。
  // ISSUE-063：不再静默吞错——fetchCourseLessonRemote 返回状态，区分「真无此课（课程名可能错，
  // 应建议 agent 先列课程核对）」vs「拉取失败（网络/服务端不可达，教法可能缺失或旧缓存）」，
  // 并以 dataNotice 注入 prompt，让 agent 知道自己处于降级状态，不得当作「真无教法」开讲。
  const course = courseKey ? parseCourseKey(courseKey) : null;
  const dataNotices: string[] = [];
  let courseLessonStatus: CourseLessonFetchStatus | null = null;
  if (course) {
    courseLessonStatus = await fetchCourseLessonRemote(childId, course.topic, course.title);
    const lesson = getCourseLessonCached(childId, course.topic, course.title);
    if (!lesson) {
      // 服务端可达但无此课（可能课名不准确）→ 给 agent 明确的自纠路径；服务端不可达 → 明确降级。
      if (courseLessonStatus === "not-found") {
        dataNotices.push(
          `进入课程会话时，服务端未找到课程「${course.title}」（主题 ${course.topic}）。` +
            `可能是课程名不准确。请先用 kb_query（query=progress，topic=${course.topic}，listOnly=true）` +
            `列出该主题的全部课程标题，核对后用完整标题重试；不要凭猜测继续教学。`
        );
      } else if (courseLessonStatus === "network") {
        dataNotices.push(
          `进入课程会话时，课程「${course.title}」的教学方法未能从服务端取到（当前可能离线或服务端不可达），` +
            `且本地无该课缓存。请勿把「无教法」当成课程不存在——可先确认网络/服务端后重进本课，` +
            `期间如孩子坚持学习，可先按通用引导方式开始，但内容可能不完整。`
        );
      } else {
        // "ok" 但本地直读仍 miss：服务端返回了课程行但内容为空（很少见），照实告知即可。
        dataNotices.push(
          `课程「${course.title}」已存在但服务端未返回教学方法内容（可能尚未填写教法/教学文案）。` +
            `如需要完整教法，可提醒家长在课程管理中补充。`
        );
      }
      console.warn(`[pi-session] course lesson not found: ${courseKey}（status=${courseLessonStatus}）`);
    } else if (courseLessonStatus === "not-found") {
      // 服务端可达并明确「无此课」，但本地旧快照/缓存还有 → 本地可能过期，同样显式提示。
      dataNotices.push(
        `进入课程会话时，服务端未找到课程「${course.title}」（主题 ${course.topic}），` +
          `当前注入的教学方法来自本地旧快照，可能已过期。请先用 kb_query（query=progress，topic=${course.topic}，listOnly=true）` +
          `核对课程名；若课程确实已不在服务端，请勿继续按旧教法教学。`
      );
    } else if (courseLessonStatus === "network" || isCourseLessonCacheStale(childId)) {
      // 有缓存但本次拉取失败 → 用的是旧缓存，须告知 agent 内容可能非最新（禁止静默当成最新）。
      dataNotices.push(
        `进入课程会话时，课程「${course.title}」的教学方法来自最近一次同步的本地缓存` +
          `（当前服务端暂不可达，可能非最新；若家长近期改过该课教法，本次可能未生效）。`
      );
    }
  }

  // ISSUE-045：当天学习计划（Todolist）注入——与 AGENTS 同一「会话前远程预取 → 本地缓存 → 同步读」模式。
  // systemPromptOverride 是 SDK 同步回调，无法 await，故先预取当天计划（三表窗口覆盖当天的行）
  // 到本地缓存，再同步读；当天无安排则 planContext 为空串，buildChildPrompt 不注入任何段落。
  // 日期用 todoLocalDate()（本地时区 YYYY-MM-DD），与「今天」口径统一。
  // ISSUE-029 任务2：课程子会话（英语课等）跳过当日计划注入——当天计划属于主会话语境，
  // 子会话只教本课内容，避免噪声与语言污染。
  const today = todoLocalDate();

  // ISSUE-033：AGENTS 纯 SQLite 存储（data/agents.sqlite），行为规范经 buildChildPrompt 内联注入
  // （resolveChildAgents：SQLite 用户版本 → 代码默认），不落任何物理文件——孩子只读、不可写，
  // 管理者=家长（家长页面 AgentPromptEditor 编辑）。
  // SPLIT M8-B：AGENTS 唯一真源在服务端；systemPromptOverride 是 SDK 同步回调，故在创建会话前
  // 先远程预取该孩子的用户版本写入本地缓存（buildChildPrompt 同步读缓存即取到服务端最新版）；
  // 服务端不可达时回退本地缓存/代码默认——ISSUE-063：拉取失败返回 network，agent 须知行为规范可能非最新。
  const agentPromptStatus = await fetchAgentPromptRemote("child", childId);
  if (agentPromptStatus.status === "network") {
    dataNotices.push(
      `孩子行为规范未能从服务端刷新（当前可能离线或服务端不可达），本次使用本地缓存或默认版本；` +
        `若家长近期编辑过行为规范，本次可能未生效。`
    );
  }
  // ISSUE-045：当天 Todolist 同样「会话前远程预取 → 本地缓存 → 同步读缓存」
  // （服务端不可达时降级为旧缓存/空，不阻断会话创建）。
  let planContext = "";
  let planFresh = true;
  if (!course) {
    const planStatus = await fetchTodayPlanRemote(childId, today);
    // 同步读取当天计划（已从缓存取，无 Todolist 返回空串 → 不注入）。
    const plan = getTodayPlan(childId, today);
    planContext = plan.text;
    planFresh = plan.fresh;
    if (planStatus === "network" && !planFresh) {
      dataNotices.push(
        `今天的学习计划未能从服务端刷新（当前可能离线或服务端不可达），` +
          `「无计划/旧计划」不代表今天真的没安排——请勿仅凭计划为空就推断「今天不要求学」，` +
          `可与孩子或家长确认，或待网络恢复后重进会话。`
      );
    }
  }
  const courseLesson = course ? getCourseLessonCached(childId, course.topic, course.title) : null;
  const dataNotice = dataNotices.length ? dataNotices.map((n) => `- ${n}`).join("\n") : "";

  const modelRuntime = await getSharedRuntime();
  const model = await getDefaultModel();

  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    // 替换 SDK 默认 base：去掉 "expert coding assistant" 身份与 Pi 自身文档索引（对孩子是噪声），
    // 换成孩子专属的学习伙伴身份。AGENTS / 技能段 / cwd / 时间注入由 SDK 在 customPrompt 模式下自动附加。
    systemPromptOverride: () => buildChildPrompt(childId, profile, planContext, courseKey, courseLesson, dataNotice),
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

  // ISSUE-029 任务2：课程子会话落盘到 sessions/<topic>-<title>/ 独立子目录（照搬家长
  // parent / parent-content 双会话先例），主会话 jsonl 留在 sessions/ 根，互不污染。
  const sessionsDir = course
    ? path.join(childDir, ".pi", "agent", "sessions", courseSessionsSubdir(course))
    : path.join(childDir, ".pi", "agent", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const mgr = SessionManager.continueRecent(childDir, sessionsDir);
  if (course) {
    // 课程子会话（英语课等）：每次进入都开全新干净窗口——上下文从零开始，防主会话
    // 中文/其他科目对话污染，也防上次本课对话残留（复习进度由 courses 状态驱动，不靠会话历史）。
    // 「进入即新窗口」由 pi:start_child 带 courseKey 时先 disposeChildCourseSession 保证。
    mgr.newSession();
  } else if (shouldAutoNewSession(childId)) {
    // 自动新建会话开关：开启且（最后一条消息不是今天 / 已过设定的时间节点）时，
    // 在当前管理器上开一个全新空会话（旧会话文件保留为归档）。遵循官方「懒落盘」语义：
    // 空会话不写盘，首条 assistant 回复时才独占创建并落盘，不在此手写任何 header 文件。
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
    // 2026-09-10 计划域重构：todo_list 工具已下线（todolist 不再落表，改为会话创建时预取三表窗口覆盖）。
    tools: ["read", "write", "edit", "ls", "display_content", "get_date", "get_progress", "kb_query", "kb_insert", "kb_update", "create_html_lesson", "parent_content", "summarize_conversation", "page_action", "page_inspect", "schedule_task", "child_self_info"],
    customTools: [displayContentTool, getDateTool, getProgressTool, kbQueryTool, kbInsertTool, kbUpdateTool, createHtmlLessonTool, parentContentTool, summarizeConversationTool, pageActionTool, pageInspectTool, scheduleTaskTool, childSelfInfoTool],
  });

  // 修复历史遗留：早期 qwen 配 reasoning:false 时，切到该模型会把会话 thinkingLevel 卡成 "off"，
  // 之后即便 qwen 已改成 reasoning:true，切模型时 SDK 仍沿用会话里的 "off"，导致 enable_thinking=false、
  // 思考过程混进正文（无 thinking 块、无 🧠 按钮）。前端没有思考等级切换入口，"off" 非用户主动选择，
  // 进入会话时强制纠正为 high（deepseek/qwen 均支持）。
  if (session.thinkingLevel === "off") {
    session.setThinkingLevel("high");
  }

  activeSessions.set(sessionKey(childId, courseKey), { session, childId, courseKey });
  return session;
}

/* ==================== ISSUE-061：场景对话会话（scene session）实现 ==================== */

/** scene 会话落盘目录：childDir/.pi/agent/sessions/scene-<topic>-<title>/（jsonl=对话记录真源）。 */
function getSceneSessionsDir(childId: string, courseKey: string): string {
  const course = parseCourseKey(courseKey);
  return path.join(getChildDir(childId), ".pi", "agent", "sessions", sceneSessionsSubdir(course));
}

function isSameLocalDay(ts: number): boolean {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` === todoLocalDate()
  );
}

/**
 * 创建场景会话：专职角色扮演，与课程会话解耦。
 * - system prompt=buildScenePrompt（无课程获取/记录职责）；tools 白名单只开 scene_command。
 * - 目录独立（scene-<topic>-<title>）；同日续接上次上下文（孩子中途退出又回来接着聊不丢），跨天开新窗口。
 */
async function createSceneSession(childId: string, courseKey: string): Promise<AgentSession> {
  const childDir = getChildDir(childId);
  const profile = getProfile(childId);
  if (!profile) throw new Error(`未找到孩子档案（childId=${childId}），请确认孩子仍存在`);
  const course = parseCourseKey(courseKey);
  // 扮演背景：预取本课教学文案到本地缓存供 buildScenePrompt 同步读（失败不阻断）。
  // ISSUE-063：拉取状态不再静默吞——场景 agent 须知道背景可能缺失/旧缓存，避免瞎编剧情。
  const sceneNotices: string[] = [];
  const lessonStatus = await fetchCourseLessonRemote(childId, course.topic, course.title);
  const courseLesson = getCourseLessonCached(childId, course.topic, course.title);
  if (!courseLesson) {
    // 无任何缓存/本地快照 → 区分服务端真无 vs 离线取不到
    if (lessonStatus === "not-found") {
      sceneNotices.push(
        `场景课程「${course.title}」服务端无记录（可能课程名不准确）。本场景无官方背景资料，` +
          `请围绕场景页实际展示的内容自由扮演，不要编造课程里没有的角色/台词。`
      );
    } else if (lessonStatus === "network") {
      sceneNotices.push(
        `场景课程「${course.title}」的背景资料未能从服务端取到（当前可能离线），且本地无缓存。` +
          `请围绕场景页实际展示的内容扮演，若信息不足就自然回应，不要瞎编。`
      );
    } else {
      sceneNotices.push(
        `场景课程「${course.title}」已存在但未取到背景内容（可能尚未填写）。请围绕场景页实际内容扮演。`
      );
    }
  } else if (lessonStatus === "not-found") {
    sceneNotices.push(
      `场景课程「${course.title}」服务端无记录，当前背景来自本地旧快照，可能已过期。` +
        `请以场景页实际展示内容为准，不要沿用可能过期的旧脚本。`
    );
  } else if (lessonStatus === "network" || isCourseLessonCacheStale(childId)) {
    sceneNotices.push(
      `场景课程「${course.title}」的背景来自最近一次同步的本地缓存（当前服务端暂不可达，可能非最新）。`
    );
  }
  const sceneDataNotice = sceneNotices.length ? sceneNotices.map((n) => `- ${n}`).join("\n") : "";

  const modelRuntime = await getSharedRuntime();
  const model = await getDefaultModel();

  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    systemPromptOverride: () => buildScenePrompt(profile, course, courseLesson, sceneDataNotice),
    noSkills: true,
    additionalSkillPaths: [getSkillsDir()],
    extensionFactories: [learningGuardExtension],
  });
  await loader.reload();

  const sessionsDir = getSceneSessionsDir(childId, courseKey);
  fs.mkdirSync(sessionsDir, { recursive: true });
  const mgr = SessionManager.continueRecent(childDir, sessionsDir);
  const lastTs = lastMessageTimestampInDir(sessionsDir);
  if (lastTs === null || !isSameLocalDay(lastTs)) mgr.newSession();

  const { session } = await createAgentSession({
    cwd: childDir,
    modelRuntime,
    model,
    sessionManager: mgr,
    resourceLoader: loader,
    tools: ["scene_command"], // scene 会话只驱动演出，不接触课程/记录工具
    customTools: [sceneCommandTool],
  });
  if (session.thinkingLevel === "off") {
    session.setThinkingLevel("high");
  }
  activeSessions.set(sceneSessionKey(childId, courseKey), { session, childId, courseKey });
  return session;
}

/** 取（或懒创建）场景会话。 */
export async function getSceneSession(childId: string, courseKey: string): Promise<AgentSession> {
  const key = sceneSessionKey(childId, courseKey);
  const existing = activeSessions.get(key);
  if (existing) return existing.session;
  const inflight = sessionPromises.get(key);
  if (inflight) return inflight;
  const promise = createSceneSession(childId, courseKey).finally(() => {
    sessionPromises.delete(key);
  });
  sessionPromises.set(key, promise);
  return promise;
}

/** 丢弃场景会话（退出场景课程时调用；历史 jsonl 保留供转交总结/回看）。 */
export function disposeSceneSession(childId: string, courseKey: string): void {
  const key = sceneSessionKey(childId, courseKey);
  const entry = activeSessions.get(key);
  if (entry) {
    try {
      entry.session.dispose();
    } catch {
      /* 忽略 */
    }
    activeSessions.delete(key);
  }
  sessionPromises.delete(key);
}

/** 该孩子是否有进行中的场景会话。 */
export function hasActiveSceneSession(childId: string, courseKey: string): boolean {
  return activeSessions.has(sceneSessionKey(childId, courseKey));
}

/** 清空某孩子全部会话（含场景会话）——退出登录/切换孩子时调用。 */
function disposeChildSceneSessions(childId: string): void {
  const prefix = `${childId}|scene|`;
  for (const [key, entry] of activeSessions) {
    if (!key.startsWith(prefix)) continue;
    try {
      entry.session.dispose();
    } catch {
      /* 忽略 */
    }
    activeSessions.delete(key);
    sessionPromises.delete(key);
  }
}

interface SceneTurn {
  role: "user" | "assistant";
  text: string;
  audioPath?: string; // user 语音落盘路径（voice/scene/...）
}

/** 读场景会话对话记录（jsonl 真源），按时间序抽取「孩子说的 / 角色说的」与语音文件清单。 */
export function readSceneTranscript(
  childId: string,
  courseKey: string
): { turns: SceneTurn[]; voiceFiles: string[]; ranges: string } {
  const turns: SceneTurn[] = [];
  const voiceFiles: string[] = [];
  const dir = getSceneSessionsDir(childId, courseKey);
  const files: string[] = [];
  if (fs.existsSync(dir)) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".jsonl")) files.push(path.join(dir, e.name));
    }
  }
  files.sort();
  for (const f of files) {
    for (const entry of loadJsonlEntries(f)) {
      if (entry.type !== "message" || !entry.message) continue;
      const m = entry.message;
      if (m.role !== "user" && m.role !== "assistant") continue;
      let text = extractText(m.content).trim();
      if (!text) continue;
      if (m.role === "user") {
        // 剥离系统注脚行：[语音识别输入…] 前缀；提取【附件音频】里的录音路径（场景语音=voice/scene/…）
        text = text.replace(/^\[语音识别输入[^\]]*\][\s\n]*/, "");
        const am = text.match(/【附件音频：[^\n]*\|([^\]]+)】/);
        if (am) {
          const rel = am[1].trim().replace(/^children\/[^/]+\//, ""); // 归一为孩子 cwd 相对路径
          if (rel.startsWith("voice/scene") || rel.startsWith("voice/")) voiceFiles.push(rel);
        }
        // 再去掉所有【】标记行与 [页面操作] 段，剩孩子的话
        text = text
          .split("\n")
          .filter((l) => !l.startsWith("[页面操作]") && !l.startsWith("【"))
          .join("\n")
          .trim();
      } else {
        // assistant：工具调用轮无正文会空；仅保留角色说的话
        const toolText = (m.tool_calls || [])
          .map((tc: any) => tc?.function?.name || "")
          .filter(Boolean)
          .join(",");
        if (!text && toolText) continue; // 纯工具轮（动作），不进记录文本
      }
      if (!text) continue;
      turns.push({ role: m.role, text, audioPath: m.role === "user" ? voiceFiles[voiceFiles.length - 1] : undefined });
    }
  }
  return {
    turns,
    voiceFiles: Array.from(new Set(voiceFiles)),
    ranges: `${files.length} 个会话文件`,
  };
}

/** 把场景对话记录整理成给课程 agent 的转交文本（孩子原话保留 + 语音文件清单）。 */
export function buildSceneSummaryForCourse(childId: string, courseKey: string): string {
  const { turns, voiceFiles } = readSceneTranscript(childId, courseKey);
  const course = parseCourseKey(courseKey);
  if (!turns.length) {
    return `（《${course.title}》场景会话没有可转交的对话内容）`;
  }
  const kids = turns
    .filter((t) => t.role === "user")
    .map((t, i) => `${i + 1}) ${t.text}`)
    .join("\n");
  const roles = turns
    .filter((t) => t.role === "assistant")
    .slice(-12)
    .map((t) => `- ${t.text.split("\n")[0]}`)
    .join("\n");
  let s =
    `# 场景对话转交记录（《${course.title}》，孩子说 / 角色回的完整记录，供你了解孩子本次表现）\n\n` +
    `## 孩子说的话（原样，${turns.filter((t) => t.role === "user").length} 条）\n${kids || "（无）"}\n\n` +
    `## 角色回应节选（最近 12 条开头）\n${roles || "（无）"}\n`;
  if (voiceFiles.length) {
    s +=
      `\n## 孩子的语音录音（可挑选分析/评测）\n${voiceFiles.map((v) => `- ${v}`).join("\n")}\n` +
      `（这些路径相对该孩子目录（voice/scene/…），在你的工作区里可直接 read 回听）\n`;
  }
  return s;
}


// 家长会话的磁盘会话目录（2026-08-24 起家长会话落盘，与孩子一致可保存/续接历史）。
// parent 与 parent-content 是两个独立会话，各自独立子目录，避免 continueRecent 互相选中对方历史。
function getParentSessionsDir(sub: string): string {
  return path.join(getDataDir(), ".pi", "agent", "sessions", sub);
}

export async function getParentSession(): Promise<AgentSession> {
  if (cachedParentSession) return cachedParentSession;

  // ISSUE-066：确保考核内容编写规范文档在 agent 可读位（幂等，真源随代码版本走）
  ensureAssessGuideFile();

  // SPLIT M8-B：创建前远程预取家长 AGENTS 用户版本到本地缓存（按家长隔离）
  // ISSUE-063：拉取失败返回 "network"，buildParentPrompt 内部读缓存/默认兜底（家长提示词用户版非最新时影响有限，仅记日志）。
  const parentAgentStatus = await fetchAgentPromptRemote("parent", getCurrentParentId());
  if (parentAgentStatus.status === "network") {
    console.warn("[pi-session] 家长行为规范未能从服务端刷新（离线/服务端不可达），使用本地缓存或默认版本");
  }

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
    //  move_file/copy_file 整理资料——移动/重命名/复制文件与目录；
    //  study_plan_* 学习计划——家长对话制定「每天学什么」的逐日排期（ISSUE-033，服务端 study_plans 真源）；
    //  parent_library_topics/courses 家长库只读查询——起草排期前读权威主题/课程名册）。
    tools: ["read", "write", "edit", "ls", "create_html_lesson", "get_date", "parent_course_save", "parent_course_delete", "parent_topic_save", "parent_upload_material", "parent_stats", "log_activity", "move_file", "copy_file", "exam_schedule_create", "study_plan_create", "study_plan_list", "study_plan_get", "study_plan_update", "study_plan_sources", "parent_library_topics", "parent_library_courses", "course_status", "app_config", "parent_transcribe_media", "parent_read_image", "parent_list_children", "assess_categories_list", "assess_category_create", "assess_course_get", "assess_content_save", "assess_method_set"],
    customTools: [createHtmlLessonTool, getDateTool, parentUpsertCourseTool, parentDeleteCourseTool, parentTopicSaveTool, parentUploadMaterialTool, parentStatsTool, logActivityTool, moveFileTool, copyFileTool, examScheduleCreateTool, studyPlanCreateTool, studyPlanListTool, studyPlanGetTool, studyPlanUpdateTool, studyPlanSourcesTool, parentLibraryTopicsTool, parentLibraryCoursesTool, courseStatusTool, appConfigTool, parentTranscribeMediaTool, parentReadImageTool, parentListChildrenTool, assessCategoriesListTool, assessCategoryCreateTool, assessCourseGetTool, assessContentSaveTool, assessMethodSetTool],
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

  // ISSUE-066：确保考核内容编写规范文档在 agent 可读位（幂等，真源随代码版本走）
  ensureAssessGuideFile();

  // SPLIT M8-B：创建前远程预取家长 AGENTS 用户版本到本地缓存（按家长隔离）
  const parentContentAgentStatus = await fetchAgentPromptRemote("parent", getCurrentParentId());
  if (parentContentAgentStatus.status === "network") {
    console.warn("[pi-session] 家长（content）行为规范未能从服务端刷新（离线/服务端不可达），使用本地缓存或默认版本");
  }

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
    tools: ["read", "write", "edit", "ls", "create_html_lesson", "get_date", "parent_course_save", "parent_course_delete", "parent_topic_save", "parent_upload_material", "parent_stats", "log_activity", "move_file", "copy_file", "exam_schedule_create", "study_plan_create", "study_plan_list", "study_plan_get", "study_plan_update", "study_plan_sources", "parent_library_topics", "parent_library_courses", "course_status", "app_config", "parent_transcribe_media", "parent_read_image", "parent_list_children", "assess_categories_list", "assess_category_create", "assess_course_get", "assess_content_save", "assess_method_set"],
    customTools: [createHtmlLessonTool, getDateTool, parentUpsertCourseTool, parentDeleteCourseTool, parentTopicSaveTool, parentUploadMaterialTool, parentStatsTool, logActivityTool, moveFileTool, copyFileTool, examScheduleCreateTool, studyPlanCreateTool, studyPlanListTool, studyPlanGetTool, studyPlanUpdateTool, studyPlanSourcesTool, parentLibraryTopicsTool, parentLibraryCoursesTool, courseStatusTool, appConfigTool, parentTranscribeMediaTool, parentReadImageTool, parentListChildrenTool, assessCategoriesListTool, assessCategoryCreateTool, assessCourseGetTool, assessContentSaveTool, assessMethodSetTool],
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
  disposeChildSceneSessions(childId);
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

// ISSUE-042：家长会话重置（对齐 resetChildSession，作用于 cachedParentSession）
export async function resetParentSession(
  archiveLimit: number = DEFAULT_ARCHIVE_LIMIT
): Promise<void> {
  const sessionsDir = getParentSessionsDir("parent");
  fs.mkdirSync(sessionsDir, { recursive: true });

  if (cachedParentSession) {
    // 热路径：在当前 sessionManager 上开全新空会话，旧会话完整保留为归档
    cachedParentSession.sessionManager.newSession();
    const agent: any = (cachedParentSession as any).agent;
    if (agent && agent.state) agent.state.messages = [];
    const hotFile: string | undefined = (cachedParentSession as any).sessionFile;
    pruneArchivedSessions(sessionsDir, hotFile ?? undefined, archiveLimit);
  } else {
    // 冷路径：仅归档清理
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

/** 从 html 正文提取 <title>（恢复链路标题兜底，避免旧资料显示「未命名资料」）。 */
function extractHtmlTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || "");
  const t = m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
  return t || undefined;
}

/**
 * 从 session 历史里重建「学习资料」列表。
 * 资料由 display_content 工具产生，参数（format/content/title）记录在 assistant 消息的
 * toolCall 里。退出孩子模式再进入时据此恢复，保证资料一直显示（除非会话被重置）。
 */
export async function getSessionMaterials(session: AgentSession, cwd?: string): Promise<MaterialItem[]> {
  const messages: any[] = (session as any).messages || [];
  // SPLIT 方案 A：display_content 的完整内容在 toolResult.details.panelContent 里（服务端远程拉取，
  // 无本地缓存）。恢复时优先取 toolResult 内容；旧会话（toolResult 无内容）则远程拉或读本地 outputs。
  // ⚠️ panelContent 还带回 title（display_content 执行时按课程名/文件名算好）——若只回填内容丢标题，
  // 退出再进入资料会显示「未命名资料」（2026-09-03 修复）。
  const resultContent = new Map<string, { content: string; title?: string }>();
  for (const m of messages) {
    if (m.role !== "toolResult" || m.toolName !== "display_content") continue;
    const panel = m.details?.panelContent;
    if (panel && typeof panel.content === "string" && panel.content.trim()) {
      resultContent.set(m.toolCallId, {
        content: panel.content,
        title: typeof panel.title === "string" && panel.title.trim() ? panel.title : undefined,
      });
    }
  }
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
      // 内容来源优先级：① 旧版工具参数自带 content → ② 对应 toolResult 的 panelContent → ③ 兜底拉取
      const rc = resultContent.get(c.id);
      let content = typeof args.content === "string" ? args.content : "";
      if (!content) content = rc?.content ?? "";
      if (!content && cwd) {
        try {
          // 路径语义与 display_content 一致（见 custom-tools.ts）：
          //   `<topic>/<file>`（新格式）或 `materials/<topic>/<file>`（旧格式兼容）→ 服务端远程拉取（方案 A 无本地缓存）
          //   `outputs/<file>` → 孩子本地 cwd/outputs/
          const matM = /^materials\/([^/]+)\/(.+\.(?:html|htm))$/i.exec(filePath);
          const matN = matM ? null : /^(?!outputs\/)([^/]+)\/(.+\.(?:html|htm))$/i.exec(filePath);
          if (matM || matN) {
            const topic = matM ? matM[1] : (matN as RegExpExecArray)[1];
            const rest = matM ? matM[2] : (matN as RegExpExecArray)[2];
            const rel = `${topic}/${rest.split("/").filter((s) => s && s !== "." && s !== "..").join("/")}`;
            if (rel.includes("..") || rel.includes("\\")) throw new Error("资料路径超出父库共享目录");
            content = (await fetchMaterialContent(rel)).toString("utf-8");
          } else {
            const resolved = path.resolve(cwd, filePath);
            if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
              throw new Error("资料路径超出学习目录");
            }
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
        title: (typeof args.title === "string" && args.title.trim())
          ? args.title
          : rc?.title
            ? rc.title
            : content
              ? extractHtmlTitle(content)
              : undefined,
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
