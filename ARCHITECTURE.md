# 学习伙伴（learning-app）功能架构与实现文档

> **本文定位**：app 技术架构 + 功能清单 + 实现细节的唯一真源文档。
> **维护规则**：每次功能调整 / 架构变更后必须同步更新本文，确保后续会话能据此准确了解项目现状、不被旧信息误导。
> 相关文档：问题清单见 `.workbuddy/memory/ISSUES.md`；打包部署见 `PACKAGING.md`；需求/设计见 `SPLIT-REQUIREMENTS.md` / `DESIGN-SPLIT.md` / `EXAM-REQUIREMENTS.md` 等。

---

## 1. 总体形态（SPLIT 拆分架构）

| 部分 | 技术 | 位置 | 说明 |
|---|---|---|---|
| **客户端**（学习伙伴） | Electron + React + TypeScript，内嵌 Pi agent 运行时 | 仓库根（`src/` 渲染层、`electron/` 主进程） | 孩子/家长双模式桌面应用；包名 `learning-app`，当前客户端版本 0.1.13 |
| **服务端**（learning-server） | Node + node:sqlite，Fastify 风格 REST `/api/v1/*` | `server/` | 部署家庭局域网 **201 (192.168.1.201):8788**；所有业务数据真源；服务端版本 0.3.x（真源 `server/src/routes/version.ts` 的 `SERVER_VERSION`） |
| **公网源**（learning-cloud） | FastAPI + nginx | ECS 47.96.154.226 | 仅做下载分发 + 版本登记，与业务无关（见 PACKAGING.md） |

- 客户端所有业务数据以 **服务端为真源**，经 REST + JWT session 访问；客户端本地 `data/` 下的 `materials/`、`children/*/kb.sqlite` 等均为旧架构残留，**不是真源**。
- 鉴权：JWT session（HS256，payload `{parent_id,email,plan}`），secret 在 `server/data/server-config.json` 的 `jwtSecret`。注意 `parents` 表的 `cloud_token` **不是** session token，当 Bearer 用会 401。

## 2. 数据真源与存储

### 2.1 服务端数据布局（`SERVER_DATA_DIR`，默认 cwd/data；201 上为 `/opt/learning-server/data`）

- **孩子 kb**：`SERVER_DATA_DIR/kb/<parentId>/<childId>.sqlite`。读写走 `POST /api/v1/db/query|exec`（op 如 `kb.topics.list/upsert`、`kb.courses.list/insert/updateFields`，args 带 `child_id`）。直接改 sqlite 须避开 server 运行时，**优先走 API**。
- **学习资料**：`SERVER_DATA_DIR/materials/<parentId>/<topic>/...`；`materialsRoot(dataDir,parentId)=dataDir/materials/parentId`。`courses.html_path` 存相对路径。索引在 `server.sqlite.materials` 表（`/materials/content/:id` **只查索引表不扫磁盘**，见 PACKAGING.md 运维坑）。
- **agents**：`data/agents.sqlite`（AGENTS 提示词纯 SQLite，ISSUE-033；编辑入口 = 家长端 `AgentPromptEditor` 组件）。
- **学习计划**：服务端 `study_plan_items`（见 §5）；游标/去重状态在 `worker_state`。

### 2.2 双库区分（家长库 vs 孩子 kb）⚠️

- **家长端课程管理面板读家长库 `parent_lib`**（`parent_lib.topics/courses.*`，比孩子 kb 多 `assess_method` / `assess_rubric` 字段）。
- 孩子 kb 只是分配后孩子侧的学习副本。
- 给家长面板加主题/课程必须写 `parent_lib.topics.upsert` + `parent_lib.courses.upsert`（无需 child_id），必要时同步 kb。

### 2.3 学习资料渲染链路（客户端）

- 渲染：`srcDoc` + 自定义协议 `asset://` / `media://` 远程代理到 `/api/v1/materials/content/{id}`（id = base64url 的、相对 materials 根的 posix 路径；需 `topic/media/` 结构）。
- 已知坑：① `asset://` 中 `local` 是 host；② meta-refresh 占位页需 `followHtmlRedirect` 先跟随；③ `registerSchemesAsPrivileged` 只能调用一次；④ `resolveMediaTarget` 需要 `topic/media/` 目录结构。
- **视频必须 H.264，禁 HEVC/H.265**（Linux Chromium 无 H.265 解码，ISSUE-056）。

## 3. Agent 会话体系（Pi SDK）

### 3.1 prompt 构成

- **孩子 prompt** = 身份（`buildChildPrompt`/systemPromptOverride）+ 行为规范（AGENTS）。行为规范在 `LEARNING_NAV_INSTRUCTIONS`（`electron/lib/pi-session.ts`）经 `buildAgentsMd` 生成。
- **家长提示词统一不分场景**：`buildParentPrompt` 单版本；工具含课程资料类、学习计划、todo、家长库读，以及 `parent_upload_material`（上传资料到服务端真源，ISSUE-055，custom-tools.ts + parent-library.ts，注册到 pi-session.ts 双家长会话）。
- **recording = 纯定时任务（ISSUE-024）**：prompt 真源 `electron/lib/recording-prompt.ts`（server 侧有一份同源拷贝，两份必须同步）；`createEphemeralSession` 用 `DefaultResourceLoader({noContextFiles:true,noSkills:true})`，工具只挂 kb 三件。客户端仅当服务端不报 `worker` feature 时启用本地调度（向后兼容）。

### 3.2 Pi SDK 关键坑（实现红线）

- customTools 的 name **必须同时进 `createAgentSession({tools})` 白名单**；ls/read/write/edit 为 SDK 内置。
- Windows `DefaultResourceLoader` 必须显式传 `agentDir`（孩子 = `childDir/.pi/agent`，家长 = `dataDir/.pi/agent`），否则崩。
- system prompt 是前缀缓存公共前缀：时间只到「日期」不到「秒」。
- 会话 append-only：重置用 `newSession()`（归档），勿用 `resetLeaf()`。
- `createAgentSession` 返回值必须解构 `{ session }`，否则 dispose 崩。
- Pi SDK jsonl 提取只取 role∈{user,assistant} 且 type=text。
- 主进程 WebSocket 勿用 `ws` 包 → 用内置全局 WebSocket。
- **prompt 模板字符串内禁字面反引号**：`RECORDING_PROMPT`、`LEARNING_NAV_INSTRUCTIONS` 内不得出现未转义反引号（行内代码用 `\``，代码围栏用 `~~~`）。esbuild/electron-vite 打包与 `node --check` 都查不出，仅运行时崩（两端打包均复现过）。

## 4. 服务端 worker 调度（方案 B，当前真源）

- **cron = 每 5 分钟**（`*/5`）。`server/src/worker/scheduler.ts`：`runPlanTick → runStatTick → runWorkerTick(recording)`。
- **runPlanTick**：先 carry（游标 = 昨天，纯 SQL 顺延未完成排期行），再 gen = 以最新 `study_plan_items` 当日排期物化今日 parent todo_items（家长中途改计划 ≤5min 反映；孩子自规划项绝不动）。
- **runStatTick**：事件驱动、当天可多次（勿回退「一天一次」）——今天有 todo_items 且 daily 有记录才跑；去重 = `worker_state` `todo_stat`.last_key=`{date,count}`，**daily 条数新增 → 下次 tick 重跑**。stat 纯代码按 courses `first_learned/last_review==今天` → ① 回写 study_plan_items done ② 按 plan_id 勾今日 parent todo ③ 汇总 child_kb `child_todo_stats`。
  - ⚠️ 勾 todo 判定勿用 `r.status`（load 的陈旧内存值 → todo 永不勾），须用 `doneOfPlan`（2026-09-04 实证）。
- **游标**：gen 无；stat = `todo_stat`.last_key；carry = `study_plan_carry`=昨天。

## 5. 学习计划 / todolist（ISSUE-033 多列表，不兼容旧版）

- **主库 `study_plan_items`（一课一行）**：字段 `parent_id/child_id/date/topic_key/course_name/mode('new'|'review')/origin('conversation'|'carry')/status('pending'|'done'|'carried')/done_at/active`；**完成态由 stat 回写**。旧表启动就地转换（`migrateStudyPlanV2`，meta `study_plan_v2_migrated` 幂等）；全量脚本 `server/scripts/migrate-study-plan-v2.mts <dataDir>`。
- **孩子 kb `todo_items`（一事一行）**：`child_id/todo_date/title/source('parent'|'child')/plan_id/status/done_at/note/sort`；`child_todo_stats` 由它汇总。
- **kb.todo ops**：list / add(仅 child) / addParent(source=parent,plan_id) / set / remove(仅 child) / removeByPlan(仅 parent)。⚠️ 写操作放 execHandlers、读操作放 queryHandlers，放错 registry 运行时报错。
- 服务端 `/study-plans` 与 `/today` 下发每行 `done`（家长面板以服务端为准，客户端不现算）。
- 工具契约：`todo_list` = read/add/check/uncheck/remove 结构化；`study_plan_update` 行级 act=delete/reschedule/setmode。家长排课「复习：」前缀在 agent-tool 入口归一为 mode=review。plan-text.ts 已删除。
- 验证脚本：`server/scripts/verify-study-plan-v2.mts`（10/10 通过）。

## 6. 学习考核（EXAM，ISSUE-027）

- 存储全在服务端；出卷 + 判分在客户端内存 session；判分 prompt 由服务端下发。
- v3 固定考核只留 每天/每周（`weekly{weekday,time}`）；config 两段式（`?schedule=` 选课无 rubric；`&courses=` 带 rubric + scoring）。
- 家长端管理面板：`src/components/ExamAdminPanel.tsx`；答题端 `ExamView.tsx`；出题已改异步流式（首门课就绪即开考，其余后台增量加入，ISSUE-050）。

## 7. 定时任务（scheduler，客户端侧）

- 配置/面板：`src/components/SchedulerSettings.tsx` / `SchedulerTasksPanel.tsx`；执行框架在 `electron/lib/scheduler.ts`。
- 已去掉「会话重置」分支，保留「自动新建会话」（跨天自动开新 + 每天定点开新）。
- ISSUE-053 起 scheduler_config 深合并保 classTimes；ISSUE-059 课程时间表按「模板 + 星期」分配（上学日/周末）。

## 8. 前端页面 / 组件地图

- **页面**（`src/pages/`）：`ChildSelect` / `Home` / `Learn`（孩子学习主界面）/ `Dashboard`（家长主页）/ `ParentLogin` / `Settings` / `SkillEditor`。
- **关键组件**（`src/components/`）：`ChatWindow`（聊天，markdown 紧凑渲染）、`LearningDashboard`（学习进度看板，家长/孩子复用）、`StudyPlanPanel`、`TodoModal`、`CourseManager` / `TopicEditor` / `CourseDetail`、`MaterialsPanel` / `MaterialManagerModal`、`ExamView` / `ExamAdminPanel` / `ExamRecords`、`SchedulerSettings` / `SchedulerTasksPanel` / `MyRemindersModal`、`AgentPromptEditor`（AGENTS 编辑）、`BackupSettings`（服务端备份/恢复 zip）、`SessionReview` / `SessionSyncPanel`、`TokenStatsPanel`、`WordLookupOverlay`（查词浮层）、`VoiceSettings` / `AssessmentSettings` / `VisionSettings`。
- **主进程关键模块**（`electron/lib/`）：`pi-session.ts` / `pi-runtime.ts`（agent 会话）、`scheduler.ts`、`server-client.ts`（REST 客户端）、`custom-tools.ts`（agent 工具）、`kb-sqlite.ts` / `kb-schema.ts`、`media-protocol.ts`（asset/media 协议）、`exam-engine.ts` / `exam.ts`、`session-sync.ts` / `sync-manager.ts`（会话上云）、`updater.ts`（electron-updater）、`voice/` 与 `assessment/`（语音/评测）。

## 9. React / 产品约束（实现红线）

- 绝不依赖 `setState(updater)` 闭包同步读外部状态；派生行为一律 `useEffect`（ISSUE-014）。
- **学习资料重发必须重显（ISSUE-021）**：即便内容 100% 相同，也要重新选中并显示最新一份。
- 全链路加载态：登录 / 主页 / 内容未加载完都要显示「正在干什么」（ISSUE-032）。
- ISSUE-018（每课压缩会话）暂缓。

## 10. 语音 / 评测相关

- 本地语音 ASR：默认千问 token-plan，响应为多层时需 pickText 多路径兜底（ISSUE-052）。
- 发音评测对接阿里 ssecp，调研/设计见 `RESEARCH-aliyun-ssecp-child-assessment-2026-09-07.md`、`DESIGN-ssecp-speech-assessment-2026-09-07.md`。
- 语音输入依赖 `ffmpeg-static`（跨平台打包时须按架构 rebuild，见 PACKAGING.md）。

## 11. 场景角色扮演（ISSUE-061）

- **形态**：学习资料 = 场景 HTML（`<meta name="pi-scenario">` 标记），只负责演出；ASR/TTS/agent 会话都在 app 壳。多角色 = 一个「游戏主持人」会话逐轮扮演全部 NPC，不拆多会话。
- **下行**：`scene_command` custom tool（say/move/act/show/highlight/update，**无 end**——页面永不收场，完成由对话提示）→ 复用 page_action 下行链（action="scene"）→ `MaterialsPanel.scene()` 白名单转发 → 场景页 `scene:*` 监听执行。HTML 动作表实现须与行为规范/工具描述一致。
- **上行**：场景页就绪上抛 `scene:ready{manifest}`（物品/角色/属性清单）→ MaterialsPanel 拼中文摘要以 kind=`scene-ready` 注入 agent（随孩子下一条消息）；孩子点物品上抛 `scene:child-click{target,word,zh}` → 转 click 事件注入。清单/事件格式与作者约定见 `SCENARIO-HTML-SPEC.md`。
- **agent 行为（孩子主导）**：不评价不引导、卡住才提醒、不主动结束/主动记录（课程状态推迟到孩子明确结束本课）；规则在 `LEARNING_NAV_INSTRUCTIONS` 场景段 + 各主题 method（教学法真源在家长库，改了即时生效）。
- 样例：`scenario-demo/lesson12-livingroom.html`；主题数据「场景英语」在家长库 topics.changjingyingyu。

---

> **更新纪律**：新增/修改功能时，更新对应章节；已废弃的实现直接删掉，不保留历史包袱（历史见 ISSUES.md 与每日日志）。
