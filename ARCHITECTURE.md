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

- 资料 iframe 分两类加载：
  - **html（共享/服务端资料）**：优先 **真实 URL 顶层文档** `asset://local/parent/{parentId}/{topic}/{rest}?doc=1&font=N&v={epoch}`——主进程 `electron/lib/material-doc.ts` 在协议层 `拉原始 → rewriteMaterialHtmlForRender → injectBridge`（PiBridge SDK + manual 采集 + 字号）返回 text/html，页面正文脚本随真实导航执行（2026-09-08 根治 srcDoc/dataURL 在 Electron 沙箱 iframe 中正文脚本不执行的问题）；渲染层 `MaterialsPanel/HtmlFrame` 对可解析 filePath 的共享 html 走此 docUrl，内容指纹/epoch 变化强重建 iframe，加载期有进度 overlay。无 filePath 的旧 html 回退 dataURL 内嵌。
  - **音视频/图片等非 html 资源**：自定义协议 `asset://` / `media://` 远程代理到 `/api/v1/materials/content/{id}`（id = base64url 的、相对 materials 根的 posix 路径；需 `topic/media/` 结构）。
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

## 6. 学习考核（EXAM，ISSUE-027 → 065/066/067）

> **架构与流程真源：`EXAM-ARCHITECTURE.md`**（2026-09-10 收口；端到端流程/数据模型/两层考核方法/判分规则/实现红线都在那里，本节只留要点）。

- 存储全在服务端（家长库）；**考核内容已结构化 v2**（ISSUE-067）：题库 `question_bank`（题干/answer/评分/题级行为/选择题 options/note/知识点概要）+ 主题类别 `topic_categories` + 课类题关系 `course_category_questions`（一课多类、一类多题=例题池）。
- **考核方法两层**：主题级 `topics.method_spec`（按孩子 require/exclude/recitePass）+ **排期级覆盖** `scope.methodSpec`（自定义考核"本次只考背诵"等，优先级最高）。
- 取题：结构化课服务端**直出题（0 LLM）**——按方法抽题、speech 题置首（refText=answer）、选择题带 options；无关系行的课回退旧路径（LLM 逐课出题，注入 assess_method+rubric，背诵题由系统注入防跨章错题）。
- 判分：逐题并发≤3；**选择题规则判分不进 LLM**；背诵题发音评测（recitePass 通过线、失败软失败）；掌握度客户端聚合；复习计划已移除（家长 agent 按需给）。
- 排期：固定档 daily/weekly=plan 周期内必学课全考（不走 AI）；自定义须家长 agent 解析**精确 courses**（+可选本次方法）；月/半年/年档已下线。孩子端考核页分"今天可参加/历史（补考+查看成绩）"。
- 家长 agent 工具：`assess_categories_list/category_create/course_get/content_save/method_set` + `exam_schedule_create`（详见 EXAM-ARCHITECTURE §6）；写作规范 `electron/lib/assess-guide.ts`（v2 结构化优先）。
- 审计：`data/exam-audit/{childId}/{日期}.jsonl`（select/generate/score 事件；结构化场次无 generate=直出生效）。

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
- 发音评测（口语/背诵题判分）：**客户端主进程本地评测（不走我们的云服务端）**，设置页可配置并切换默认 provider，当前支持两家并存：
  - **腾讯云智聆 SOE**：中文题型 `cn_*` 用引擎 `16k_zh`（长文本自动降级段落模式 eval_mode=2 规避 4104），其余 `16k_en`；凭证 AppID/SecretId/SecretKey（见 `tencent-aksk.txt`）。
  - **阿里云 SSECP（声希）HTTP POST API**：客户端直连声希，`cn.pred.score`（中文背诵/段落）/ `en.sent.score`（英文），声希直连 authorize 拿 `warrant_id`（**无需阿里云 AccessKey**，也不依赖卡死的 `CreateAccessWarrant.requestSign`）；凭证 appKey/appSecret（见 `ssapi.txt`）。provider=`aliyun-ssecp`。
  - 映射统一见 `electron/lib/exam.ts` 的 `toSpeechAssessment`；题型自动选引擎/corType。注意：早期服务端的 `server/src/assessment/*`、`routes/assessment.ts`、`providers/aliyun-kid.ts` 已删除，现阿里方案完全在客户端（`providers/aliyun-ssecp.ts`）。
  - **文本长度限制（2026-09-09 实测）**：
    - **腾讯智聆**：句子模式 `eval_mode=1` 中文 **≤30 字** / 英文 **≤60 词**；段落模式 `eval_mode=2` 中文 **≤120 字** / 英文 **≤300 词**。超段落上限仍报 `4104`，需按句拆分合并（代码已按长度自动选 eval_mode 规避 30 字 4104，但 >120 字硬上限未做拆分）。
    - **阿里声希 `cn.pred.score`**：**无字符数硬上限**——实测 800 / 2000 / 4000 字均返回正常结果，**从不报"文本过长 / refText exceeds"类错误**；唯一失败模式为 `"error":"core is timeout"`（服务端内核处理超时），由**录音与参考文本对齐不足 / 语音质量差**触发，与字数无关（结果非单调：4000 字过、1500 字反超时属噪声）。音频时长 ≤180s 已验证通过，更长受测试机上行带宽限制未证出硬天花板。
    - **实现影响**：阿里分支**不需要**腾讯式 30/120 字 eval_mode 降级或超长按句拆分（`aliyun-ssecp.ts` 当前无长度拆分逻辑即正确）；唯一注意点——录音时长须与文本大致匹配（别用 3s 短录音对 1000 字背诵），否则可能 `core is timeout`。腾讯的 >120 字拆分限制**只适用于腾讯**，对阿里不适用。
- 语音输入依赖 `ffmpeg-static`（跨平台打包时须按架构 rebuild，见 PACKAGING.md）。

## 11. 场景角色扮演（ISSUE-061）

- **形态**：学习资料 = 场景 HTML（`<meta name="pi-scenario">` 标记），只负责演出；ASR/TTS/agent 会话都在 app 壳。**独立 scene agent**：会话 key=`孩子|scene|<课程key>`（无课程会话时由资料 filePath 派生 `topic:title`），独立历史 jsonl、工具白名单只有 `scene_command`（课程/主会话已无此工具——职责物理隔离）。
- **通讯**：走 PiBridge 统一标准（见 §12 与 `MATERIAL-BRIDGE-PROTOCOL.md`）。下行：`scene_command` custom tool（say/move/act/show/hide/highlight/update，**无 end**）→ 宿主 `MaterialsPanel.scene()` 白名单校验 → `appCmd('scene.'+command)`（requestId/就绪 gate/回执底座）→ 页面 `PiBridge.on('scene.*')` 执行并回执；HTML 动作表实现须与行为规范/工具描述一致。
- **上行**：页面 `PiBridge.emit('scene.ready', manifest)`（场景属性清单，经格式化注入 agent）与 `scene.item-click{target,word,zh}`（转点击事件注入）；语音球 `scene.mic.press/release` 触发宿主录音与 ASR。清单/事件格式与作者约定见 `MATERIAL-BRIDGE-PROTOCOL.md` §5（scene.* 命名空间）。
- **场景会话接入（2026-09-08）**：课程 agent `display_content` 打开场景页时，主进程在返回中带 `isScene`（HTML 标记 / `SCENE_TOPIC_KEYS` 名单）→ Learn `activateSceneFromTool` 立即激活场景模式并派生场景 key（不等 iframe `scene.ready`——app 内沙箱 iframe 事件可能缺失）；回复收尾后宿主自动 `launchSceneIntro` 让场景伙伴开场。聊天记录与 HTML 字幕**同文同源**：主进程 `scene:prompt` 结束只回发本轮 `scene_command say` 的真实台词（无 say 才回 assistant 正文兜底）；重进场景时 `scene:history` 按同一规则回填聊天框。
- **agent 行为（孩子主导）**：不评价不引导、卡住才提醒、不主动结束/主动记录（课程状态推迟到孩子明确结束本课）；规则在 `LEARNING_NAV_INSTRUCTIONS` 场景段 + 各主题 method（教学法真源在家长库，改了即时生效）。
- 样例：`scenario-demo/lesson01-hello/index.html`（真源同步 `server/data/materials/<家长id>/changjingyingyu/lesson-01-livingroom-hello/index.html`）；主题数据「场景英语」在家长库 topics.changjingyingyu。

## 12. 资料页 ↔ 宿主统一通讯标准（PiBridge，2026-09-08）

- **定位**：唯一标准。任何"需要与宿主/agent 通讯"的资料网页（场景互动、家长端随堂测验、绘本等）一律用它，不再按页面种类维护私有通道（历史 `scene:*` 直发消息已废弃）。**规范真源：`MATERIAL-BRIDGE-PROTOCOL.md`**（本节省略细节，只登记架构落点）。
- **作者 API（唯一入口）**：`window.PiBridge.emit(action,payload)` 上行事件 / `request(action,payload)` 调宿主能力（Promise 回执）/ `on(action,handler)`、`off` 接收宿主→页面命令。页面声明 `<meta name="pi-bridge" content="capture=manual">` 后桥不再自动采集 click/scroll 等（只报显式 emit）；未声明者行为不变（向后兼容）。
- **信封**：`page:app`（事件上行）、`page:req`（能力请求上行）、`page:app-cmd` + `page:app-cmd:result`（命令下行 + 回执）、`page:app-res`（能力回执）；可靠性复用宿主 `page:exec` 底座（就绪 gate、requestId 配对、超时、iframe 重建自动 reject）。
- **动作目录**：通用命名空间（`submit-answer`/`complete-section`/`request-help`…；能力 `tts.speak`/`lookup`/`goto-course`/`get-progress`）+ 场景命名空间 `scene.*`（say/move/act/show/hide/highlight/update/busy/mic.status/mic.result；上行 ready/item-click/mic.press/release）。
- **实现落点**：
  - SDK 与桥注入：`src/lib/page-bridge.ts`（`PIBRIDGE_SCRIPT` / `injectBridge` / manual 识别 / `PageEventKind` 含 `app`）；
  - 宿主：`src/components/MaterialsPanel.tsx`（`page:app`→上抛；`page:req`→能力表；`page:app-cmd:result`→pending；`appCmd`；`scene()` 委托 `appCmd('scene.'+cmd)`；`speakMaterialText` 队列/打断双模式）；
  - 协议层注入：`electron/lib/material-doc.ts`（asset `?doc=1` 文档加载时 rewrite+injectBridge，使页面正文脚本与 SDK 一起随真实导航执行）；
  - agent 侧转译：`electron/lib/page-bridge.ts` `formatPageEvent`（`kind:"app"` → 自然语言事件注入）；
  - 制作侧：`electron/lib/programming-agent.ts` `buildProgrammingPrompt` 内嵌协议约定——编程 agent 产出的网页默认合规（家长端/孩子端一致，无需各维护一套）。
- **迁移状态**：场景英语已切单轨（页面零私有 `scene:*` 消息）；`MaterialsPanel` 保留旧 `scene:*` 上行兼容分支供未迁移页面兜底；家长端资料同样经 asset doc 通道加载即自动获得桥注入。

---

> **更新纪律**：新增/修改功能时，更新对应章节；已废弃的实现直接删掉，不保留历史包袱（历史见 ISSUES.md 与每日日志）。
