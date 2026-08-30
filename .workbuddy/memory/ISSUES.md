# 待解决问题清单 (Open Issues)

> 本文件用于记录待解决/待实现的问题，不在此处修改项目或展开讨论。
>
> **2026-08-30 重置说明**：项目已切换至「客户端 + 服务端」拆分架构（SPLIT，见 `SPLIT-REQUIREMENTS.md` / `DESIGN-SPLIT.md`）。
> 原 ISSUE-001 ~ 052 均为旧架构（一体化 Electron「学习伙伴」应用）时期记录，已整体归档至
> `ISSUES-archive-2026-08-30.md`，不再在本文件保留。
> 本文件从空清单重新开始，只记录新架构下的问题。

## 新架构记录格式（模板）

- **类型**：bug / 需求 / 架构 / UI / 其他
- **描述**：
- **影响范围**：
- **排查/修改入口**：
- **优先级**：待定 / 高 / 中 / 低
- **记录时间**：YYYY-MM-DD

---

## [ISSUE-001] 家长界面孩子管理：孩子卡片上恢复学习进度展示

- **类型**：需求 / 功能回归（旧架构 ISSUE-019/027 曾实现家长页进度展示，SPLIT 拆分后未迁移）
- **描述**：家长界面「孩子管理」里，每个孩子卡片上要显示学习进度（如总进度 / 今日已学 / 最近学习），家长要能随时掌握孩子学习情况。当前卡片无任何进度信息。
- **现状 / 排查入口**：
  - 前端：`src/pages/Dashboard.tsx`（children 视图，`childList()` 拉列表渲染孩子卡片）——卡片无进度字段，`refresh()` 只取基础列表。
  - 服务端进度数据已存在、可复用：`server/src/routes/db.ts` 的 `kb.progress.list` / `parent_lib.progress.list`（topic_progress 视图：learned/total/next/updated），进度存服务端真源。
  - 建议：`server/src/routes/children.ts` 的 childList 聚合返回各孩子进度摘要（或新增独立接口），前端卡片渲染进度条 / 摘要；旧架构组件 `src/components/ProgressView.tsx` / `LearningDashboard.tsx` 可参考或复用。
- **优先级**：已完成（2026-08-30 实施：`children.ts` 聚合 topic_progress 返回 progress 摘要；`child-auth.ts` 透传；`Dashboard.tsx` 卡片加进度条 + 最近学习时间）
- **记录时间**：2026-08-30

## [ISSUE-002] 家长设置·定时任务：去掉「会话重置」，用「自动新建会话」即可

- **类型**：需求 / 功能移除
- **描述**：家长设置里的定时任务去掉「会话重置」（sessionReset），不再需要该功能——「自动新建会话」已覆盖其用途（跨天自动开新 + 每天定点开新），二者重叠，删除重置分支。
- **现状 / 排查入口**：
  - 前端：`src/components/SchedulerSettings.tsx:458-485`（session-reset 区块：开关 + 时/分）；:146 说明文字已注明「与每日会话重置功能重叠，二者择一即可」。
  - 配置模型：`SchedulerSettings.tsx:7` `sessionReset: { enabled, hour, minute }`，默认关闭（:38）。
  - 后端：会话重置执行逻辑（resetChildSession / runSessionReset / `pi:reset` IPC 链路）与「自动新建会话」共用调度框架，删 sessionReset 分支、保留新建会话分支。
- **优先级**：已完成（2026-08-30 实施：`SchedulerSettings.tsx` 删 UI 与配置字段；`scheduler.ts` 删 sessionReset 配置/分支/任务状态键；`pi:reset` 保留给聊天 /reset 与自动新建会话热路径）
- **记录时间**：2026-08-30

## [ISSUE-003] 家长设置·数据备份：改为服务端数据备份/恢复（zip 上传覆盖），去掉跨机进度查询

- **类型**：需求 / 架构调整
- **描述**：数据备份语义重定义：
  1. **去掉「跨机查进度」**（BackupSettings 现含该功能，旧 ISSUE-041 遗留，与 server 真源冲突）。
  2. **备份** = 把 server 端该家长的用户数据（课程 / 进度 / 生活记录等，**排除模型 API key 与登录凭证**）下载到 app 本地，打包为 zip。
  3. **恢复** = 上传这个 zip，server 用 zip 内数据**覆盖**其数据；**恢复前先对 server 当前数据做一次自动备份**（防误覆盖）。
- **现状 / 排查入口**：
  - 前端：`src/components/BackupSettings.tsx`（现为**本地** `data/` 全量 zip：一键备份 / 从备份恢复 / 定时备份 / 跨机查进度 :38）。
  - 服务端：`server/src/routes/*` 目前**无备份/恢复端点**（grep backup/restore 仅 agents.restore）——需新增：备份包生成接口、恢复上传覆盖接口、恢复前快照。
  - electron 侧备份 handler 需改为调 server 接口而非本地打包。
- **优先级**：已完成（2026-08-30 实施：`server/src/routes/backup.ts` 新增 GET /api/v1/backup（家长库+孩子 kb 打 zip）+ POST /backup/restore（multipart，恢复前自动快照 pre-restore）；`server-client.ts` 加 serverFetchBinary/serverUploadFile；`backup.ts` 改为服务端拉取/上传；`BackupSettings.tsx` 去掉跨机查进度）
- **记录时间**：2026-08-30

## [ISSUE-004] 孩子管理·分配学习主题：支持移除某孩子的某主题，有学习记录则保留记录

- **类型**：需求
- **描述**：分配主题弹窗里可以对某个孩子「移除」某个已分配主题；若该主题已有学习记录（topic_progress / 学习记录），**只解除孩子与该主题的关联（取消分配），学习记录保留在服务端不删除**；若将来重新分配，进度应能续上。
- **现状 / 排查入口**：
  - 前端：`src/components/ChildTopicsModal.tsx`（allocated map :47，分配时写每天学习量 :77/:212/:259）——目前**无移除 UI**。
  - 服务端：`server/src/routes/db.ts` 主题分配相关（topics 表 / 孩子库 topic_progress），**无 deallocate / 移除分配接口**（grep 未命中）——需新增：移除孩子库分配关系，保留 topic_progress 学习记录。
  - 注意边界：移除后孩子 agent 不再查询该主题；移除确认需二次确认（有学习记录时提示「记录保留」）。
- **优先级**：已完成（2026-08-30 实施：`db.ts` 新增 exec op `kb.topics.deallocate`（只删 topics 分配行、保留 courses/进度）；`parent-library.ts` 加 deallocateChildTopic；`ipc-handlers/preload` 加 parent:deallocate；`ChildTopicsModal.tsx` 已添加主题行加「移除」按钮（confirmDialog 提示记录保留））
- **记录时间**：2026-08-30

## [ISSUE-005] 家长模式：孩子卡片进度改为 icon 入口，点击进入详细进度看板（与孩子模式一致）

- **类型**：需求 / 交互调整（调整 ISSUE-001 的卡片直铺呈现方式）
- **描述**：
  1. 家长界面「孩子管理」里，**不再把孩子进度直接铺在卡片上**（当前 ISSUE-001 实现：进度条 + 进度摘要 + 最近学习时间），改为卡片上一个「学习进度」icon。
  2. 点击 icon 进入该孩子的**详细进度界面**，界面与孩子模式下的「学习进度看板」**完全一致**（主题总览 + 下钻），家长要能掌握孩子学习进度。
- **现状 / 排查入口**：
  - 家长模式：`src/pages/Dashboard.tsx` 孩子卡片（:206-233，ISSUE-001 渲染进度条/progressText/最近学习时间）——需改为 icon 按钮 + 点击后进入进度看板视图（弹窗或内嵌页）。
  - 可复用：`src/components/LearningDashboard.tsx`（孩子模式「学习进度看板」，`src/pages/Learn.tsx:30/:772` 挂载）——家长模式直接复用该组件（按 childId 传参即可）；如需孩子切换，可参考旧组件 `src/components/ProgressView.tsx` 的 props（childrenList/selectedChild/onSelectChild）。
  - ⚠️ `ProgressView.tsx` 当前**无人引用**（grep 全项目仅组件自身），是旧架构家长进度看板，可作参考或废弃。
  - 数据链路已通：`learning:summary` / `learning:topic` IPC（`electron/lib/ipc-handlers.ts:283/:294`）→ getLearningSummary / getTopicProgress，家长模式可复用。
- **优先级**：已完成（2026-08-30 实施：`Dashboard.tsx` 孩子卡片直铺进度改「📊 学习进度」icon（BarChart3）入口；点击弹窗复用孩子模式同一 `LearningDashboard` 组件（childId 传参）；侧栏列表同步去掉进度直铺；删除废弃 progressText 函数）
- **记录时间**：2026-08-30

## [ISSUE-006] 学习进度：孩子模式点主题后看不到详细课程学习情况；两模式界面/操作需完全一致

- **类型**：bug / 需求
- **描述**：
  1. **孩子模式**：学习进度看板里**点击一个主题后，无法查看该主题详细课程的学习情况**（每课状态 / 掌握度 / 当课总结）。
  2. **一致性要求**：家长模式和孩子模式的学习进度界面与操作功能必须**完全一样**（都支持「主题 → 每课 → 当课」三级下钻），家长模式落地见 ISSUE-005。
- **现状 / 排查入口**：
  - 前端组件**代码层面已具备下钻**：`src/components/LearningDashboard.tsx`——总览主题列表（openTopic :96）→ `learning:topic` IPC → 主题内每课列表（:167 起渲染 CourseItem[]）→ openCourse → `CourseDetail` 单课详情（CourseDetail.tsx 含状态/掌握度行）。**但用户实测点主题后看不到课程明细**，疑点在数据层：
    - `electron/lib/ipc-handlers.ts:294` `learning:topic` → `getTopicProgress(childId, topic)`：SPLIT 后进度真源在服务端，需确认该函数**是否真实返回每课 CourseItem 明细**（learned/status/mastery）；若 items 为空或抛错，主题页显示空态/报错，表现为「点主题没反应」。
    - `learning:courseSummary`（:305）→ getCourseDailySummary（关联 daily_entries block='学习'），确认当课总结数据是否存在。
  - 家长模式：暂无进度看板入口（见 ISSUE-005），落地后需与孩子模式**共用 LearningDashboard**（或同构组件）保证界面与操作一致。
- **优先级**：已完成（2026-08-30 实施：`learning-summary.ts` `getTopicProgress` 改为并行查 `kb.progress.list`（聚合行）+ `kb.courses.list`（按 topic 过滤，每课 CourseItem 明细）组装 `TopicDetail{...items}`；根因=原只返回视图行无 items，组件 `d.items.filter` 崩溃/空白。实测：english items=51、lunyu items=512（✅305/⬜207 与 progress 一致）、论语当课总结 2 条、三级下钻全通）
- **记录时间**：2026-08-30

## [ISSUE-007] 孩子详情页：点击孩子卡片进入详情页（标签页组织进度/主题/prompt 等），不再用弹窗

- **类型**：需求 / UI 重构（演进 ISSUE-005 的 icon+弹窗方案；ISSUE-005/006 已于 commit 912c4fe 实施）
- **描述**：
  1. 点击**孩子卡片本身**（而非仅 icon）进入该孩子的**详细页面**。
  2. 不再以弹窗形式展示：学习进度、分配学习主题（ChildTopicsModal）、编辑 AI 提示词（AgentPromptEditor）、重置密码（reset modal）等内容——全部改为详情页内的**标签页（tabs）**（如：学习进度 / 学习主题 / AI 提示词 / 账号密码）。
  3. 每个标签页内容**占满该区域**（整个 dashboard 内容区，而非弹窗），详情页提供返回（回孩子列表）。
- **现状 / 排查入口**：
  - `src/pages/Dashboard.tsx`：孩子卡片（:196-244）现为 5 个 icon 按钮（学习进度 BarChart3 / 重置密码 KeyRound / 学习主题 ListTree / 编辑 AI 提示词 Pencil / 删除 Trash2）；对应弹窗：
    - 学习进度 modal（:273-294，`progressChild`，内嵌 `LearningDashboard`）
    - `ChildTopicsModal`（:266-271，`topicsChild`）
    - 重置密码 modal（:296-314，`resetChildId`）
    - `AgentPromptEditor`（:316-320，`agentPrompt`）
  - 改造方向：卡片整体 onClick 进入详情页视图（新增 state / `view === "childDetail"`），详情页用 tabs 承载上述 4 块内容，各 tab **复用现有组件**（LearningDashboard / 主题分配逻辑 / AgentPromptEditor / 重置密码表单）；现有弹窗入口与 state（progressChild/topicsChild/agentPrompt/resetChildId）随之迁移到 tab 视图。
  - 关联：ISSUE-005（icon 入口 + 弹窗进度）为过渡方案，本 ISSUE 落地后卡片上的功能 icon 可简化或并入卡片点击。
- **优先级**：已完成（2026-08-30 实施：新建 `ChildDetailPage.tsx`（tabs：学习进度 LearningDashboard / 学习主题 / AI 提示词 / 账号密码(重置+删除)）；`ChildTopicsModal`/`AgentPromptEditor` 拆出 `ChildTopicsContent`/`AgentPromptContent` 平铺组件（弹窗容器保留复用）；`Dashboard.tsx` 卡片整体点击进详情页、删除原 4 个弹窗与 state（progressChild/topicsChild/agentPrompt/resetChildId）与 5 个 icon 按钮）
- **记录时间**：2026-08-30

## [ISSUE-008] 孩子界面：学习资料展示区可折叠；display_content 调用时自动展开并展示最新内容

- **类型**：需求 / UI
- **描述**：
  1. 孩子界面（Learn.tsx）中间的「学习资料」展示区域（MaterialsPanel，`view === "materials"`）**可以折叠**（收起后聊天区占据更多空间，展开恢复）。当前只有左侧导航栏 `learn-sidebar` 可折叠（`sidebarCollapsed`），资料区本身没有折叠能力。
  2. 当 AI 调用 **display_content** 要展示内容时，**自动展开**资料区并**展示最新内容**（即便当前处于折叠状态）。
- **现状 / 排查入口**：
  - `src/pages/Learn.tsx`：`learn-body` 内 MaterialsPanel 挂载（:763-769，仅 `view === "materials"` 时渲染）；左侧导航栏折叠参考（:622 `learn-sidebar collapsed`，state :112 `sidebarCollapsed`）；**display_content 自动打开最新资料的现有链路**（:202 注释 + :215 `data.toolName === "display_content"` → 自动打开最新一份，ISSUE-014 已实现）——折叠态自动展开可在此链路上叠加（收到 display_content 时若折叠则展开 + 定位最新资料）。
  - `src/components/MaterialsPanel.tsx`：列表 / 详情两态（详情 :184 起，列表 :232 起）；详情态已有「返回列表」（onBack），可参照加折叠按钮；`exec` 经 `useImperativeHandle` 暴露（:176），display_content 指令走 page:exec 链路。
- **优先级**：已完成（2026-08-30 实施：`MaterialsPanel` 加 `onCollapse` + 折叠按钮（详情/列表态均可用，PanelRightClose）；`Learn.tsx` 加 `materialsCollapsed` state，折叠显示窄条展开按钮；display_content 链路（materials 变化 effect）自动展开+选中最新）
- **记录时间**：2026-08-30

## [ISSUE-009] 聊天消息 markdown：字体放大一倍便于孩子阅读；行间不留空行、保持正常行距

- **类型**：UI / 需求
- **描述**：
  1. 聊天消息框里的 markdown **字体再放大一倍**（当前 `.markdown-body` font-size 15px → 约 30px），方便孩子阅读。
  2. **行与行之间不要有空行**：当前 `p` 的 `margin-bottom: 8px`（ul/ol 亦 8px）让段落之间留白、消息框被拉得很长——改为正常行间距（紧凑段落边距，行高保持可读）。
- **现状 / 排查入口**：
  - 渲染：`src/components/ChatWindow.tsx:651-660`（`bubble bubble-md` 内 ReactMarkdown + remarkGfm，仅 AI 消息）。
  - 样式：全局 `.markdown-body`（`src/styles.css:2399-2427`，font-size 15px / line-height 1.7 / p margin-bottom 8px / ul、ol margin-bottom 8px）。
  - ⚠️ **作用域注意**：`.markdown-body` 为全局共享（家长端聊天、资料面板 markdown 详情也用），需确认「放大字体」仅孩子聊天生效（如给孩子聊天专属 class 或在 ChatWindow 内联覆盖），还是家长端一并放大。
- **优先级**：已完成（2026-08-30 实施：ChatWindow AI 气泡加 `bubble-md-child`（仅孩子聊天 owner!=="parent"）；styles.css 覆盖：正文 30px（翻倍）、p/ul/ol margin 收窄（紧凑行距）、标题/代码块等比放大；家长端聊天与资料面板 .markdown-body 不受影响）
- **记录时间**：2026-08-30

## [ISSUE-010] 聊天消息输入框：语音输入（按住说话）按钮消失，需补回

- **类型**：bug / 功能回归
- **描述**：消息输入框里的「按住说话」语音输入按钮（Mic）不见了，需要补回来。
- **现状 / 排查入口**（已定位根因链）：
  - `src/components/ChatWindow.tsx:827-838`：Mic 按钮是**条件渲染** `voiceEnabled && (<button className="mic-button" …>…)`——`voiceEnabled` 为 false 时按钮完全不渲染。
  - `voiceEnabled` 来源：ChatWindow.tsx:169 初始 `false`，:279-280 启动后 `window.api.voiceConfigGet()` → `r.config.enabled` 赋值。
  - IPC：`voice:config:get`（`electron/lib/ipc-handlers.ts:1349`）→ `getMaskedConfig()` → `loadVoiceConfig()` 读 `getSharedDir()/voice-config.json`。
  - **根因候选**：`voice-config.ts:21` 默认 `enabled: false`——若 `voice-config.json` 不存在/丢失/被重置（SPLIT 迁移、清数据、换设备、路径变化），`loadVoiceConfig` catch 直接返回默认 false → 按钮消失；或用户在语音设置页（VoiceSettings.tsx:67 `enabled`）手动关闭；或 `voiceConfigSet` 曾写入 enabled:false。
  - 修复方向：① 排查/修复 `voice-config.json` 为何 enabled=false（文件丢失则恢复开启或默认开启）；② 或按用户期望让按钮**始终显示**（去掉 voiceEnabled 条件 / 无配置时点击引导去语音设置开启）。
- **优先级**：已完成（2026-08-30 实施：Mic 按钮**始终渲染**（去掉 voiceEnabled 条件，voice-config 丢失/未开启不再消失）；未开启时点击给引导提示「语音输入未开启：请家长在设置 → 语音输入 中开启」；root 根因=DEFAULT_CONFIG.enabled=false + 本机无 voice-config.json）
- **记录时间**：2026-08-30

## [ISSUE-011] 学习资料 html 里的语音（朗读按钮）音色与聊天语音不一致，需统一

- **类型**：bug / 需求
- **描述**：学习资料（MaterialsPanel 渲染的课程 html）里的「🔊 朗读」语音，音色与聊天消息框里的语音（TTS 朗读）不一样。需要统一为同一语音服务 / 同一音色。
- **根因（已定位）**：
  - **资料 html 用的是 Web Speech API**：课程 html 内嵌脚本（如 hanzigong `lesson-*/index.html` 的 `speak(btn, text)` 函数）调 `window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))`，并尝试挑选 Edge 在线神经语音（`cvInitVoices`：优先 `Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)` → Xiaoxiao/Yunxi Online → 本地 zh 兜底）。该机制**依赖 Chromium 暴露的语音列表，而 Electron（Chromium 内核）根本不提供这些在线神经语音**——详见 ISSUE-013 根因：`Xiaoxiao Online (Natural)` 是 **Edge 浏览器特供**的 TTS 云服务语音，Chromium 的 `getVoices()` 无此条目；Chromium 唯一在线语音是 Google network speech（需 Google API key，Electron 默认无）→ 在线分支全部落空 → fallback 系统本地 SAPI 语音（机械、难听）。⚠️ 与 iframe sandbox **无关**（speechSynthesis 不受 sandbox 限制，见 ISSUE-013）。
  - **聊天语音走主进程 edge-tts**：`window.api.voiceTts(text, {rate})`（preload.ts:242 → `voice:tts` IPC）→ `electron/lib/voice/tts.ts` 按 `tts-config.ts`（默认 provider "edge-tts"，音色由用户配置决定）合成播放，音质/音色稳定统一。
- **排查 / 修改入口**：
  - 资料 html 示例：`server/data/materials/<pid>/hanzigong/lesson-000-日月生辉/index.html:786` speak()、:745-785 cvInitVoices 语音选择；english/learn/*.html 同类。
  - 桥接方案（**推荐，课程 html 无需逐个改动**）：`src/lib/page-bridge.ts:336` `injectBridge` 注入的桥脚本里**接管/替换 `window.speechSynthesis`（speak/cancel/getVoices）**，把文本经 postMessage 上抛 → `MaterialsPanel`（或父页面）→ `window.api.voiceTts(text, {rate})` 走与聊天同一条主进程 edge-tts 链路 → 音色天然一致；需保留按钮 playing 高亮 / 停止等交互语义（可回传事件）。PageAction 已有下行通道（page-bridge.ts:58 click/scroll/input/read），可扩展或加独立上行事件。
  - 备选：改课程 html 生成模板脚本（hanzigong/english 生成器），把 speak() 改为调桥接口——需全量重生成 html，且存量文件不受影响，通用性差。
- **优先级**：已完成（2026-08-30 实施：BRIDGE_SCRIPT 注入 speechSynthesis shim——getVoices 返回模拟 Edge 在线语音（课程 cvInitVoices 选中 Xiaoxiao Online）、speak 上抛 kind=tts、cancel 上抛 tts-cancel、父级回执 page:tts:done 触发 utterance.onend 按钮复位；MaterialsPanel 处理 tts 事件走 window.api.voiceTts（edge-tts 与聊天同链路）、播完回执 iframe、cancel/卸载停止、不进页面操作记录；PageEventKind 扩展 tts/tts-cancel；page-bridge.test 新增 shim 行为测试）
- **记录时间**：2026-08-30

## [ISSUE-012] 分配学习主题列表与课程管理不一致：课程管理 9 个主题，分配主题时不足 9 个

- **类型**：bug
- **描述**：家长「课程管理」里有 9 个学习主题，但孩子管理「分配学习主题」时列表不足 9 个（数量/条目不一致）。
- **已排查（代码层面两处应一致）**：
  - 服务端真源：`server/data/parents/86a84278-*/parent.sqlite` `topics` 表实测 **9 行**（english / hanzigong / lunyu / qianziwen / reading / taodi / xiaojing / xiaozhuan / feizhougu）。
  - 课程管理：`src/components/CourseManager.tsx:39` `refreshTopics()` → `window.api.parentListTopics()`。
  - 分配主题：`src/components/ChildTopicsModal.tsx:45` `ChildTopicsContent`（孩子详情页「学习主题」tab 用，ChildDetailPage.tsx:112）`refresh()` 同样调 `window.api.parentListTopics()`（:66-67），渲染 `topics.map`（:174）**无过滤**（已分配仅标记「✓ 已添加」）。
  - IPC：`parent:listTopics`（`electron/lib/ipc-handlers.ts:316`）→ `listParentTopics()`（parent-library.ts:298）→ `dbQuery("parent_lib.topics.list")`；服务端 `parent_lib.topics.list`（`server/src/routes/db.ts:226`）全量 SELECT topics 表，**无过滤**；路由按 session 的 parentId（JWT）openParentLib。
- **待排查方向**：
  ① 请提供分配页实际显示的主题名列表/缺失项（对比缺哪几个，判断是数据还是渲染问题）；
  ② 家长登录 session 的 parentId 是否 86a84278…（不同家长账号查各自 parent_lib，库不同）；课程管理与分配主题是否同一登录态；
  ③ 客户端是否为最新构建（out/ 旧产物缓存）——建议先重启/重构建复测；
  ④ `dbQuery("parent_lib.topics.list")` 是否偶发失败：`listParentTopics` 对 topics 查询 `.catch(() => [])`——若服务端接口报错则分配页返回空/少（课程管理同样 catch，但可看主进程/渲染进程控制台是否有 dbQuery 报错）；
  ⑤ 前端字段映射：服务端返回 `topic_key`，`listParentTopics` 映射为 `topicKey`（parent-library.ts:330 附近）——若某行 topic_key 为空/异常，React `key={t.topicKey}` 可能告警但不丢行，仅作兜底检查。
- **优先级**：已完成（2026-08-30 核实：server parent_lib.topics.list 实测返回 9 行全量（english/feizhougu/hanzigong/lunyu/qianziwen/reading/taodi/xiaojing/xiaozhuan）；客户端 listParentTopics 无过滤（parent-library.ts:298-330 全量映射）、IPC parent:listTopics 透传、ChildTopicsContent topics.map 无过滤——当前代码与数据一致，原「不足 9 个」应为旧构建/迁移前数据，无需代码改动）
- **记录时间**：2026-08-30

## [ISSUE-013] 知识记录：Electron 里 speechSynthesis 为什么选不到 Edge 在线神经语音

- **类型**：其他（调查结论 / 知识记录，为 ISSUE-011 提供根因依据）
- **结论**：**不是沙盒 iframe 导致的**——`speechSynthesis` 不受 iframe sandbox 限制（sandbox="allow-scripts …" 即可用）。真正原因是 **Electron 用的是 Chromium 内核，根本不提供 Edge 浏览器特供的微软在线神经语音**。
- **Chromium 的 getVoices() 语音来源**（Electron 与 Chrome 相同）：
  1. **本地系统语音**（Windows SAPI5 安装的语音包，如 Microsoft Huihui Desktop / Kangkang Desktop，`localService=true`）；
  2. **Google 在线语音**（network speech，`localService=false`）——需要 Google API key 且能连 Google 服务；**Electron 默认不带 key、国内也不可达** → 在线语音列表实际为空。
- **Edge 的 "Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)" 是 Edge 浏览器专属**：由微软 Edge 的 TTS 云服务提供，语音名只出现在 Edge 的 `getVoices()` 里；Chromium/Electron 的 `getVoices()` 中**根本没有这个名字**。
- **后果**（hanzigong/english 课程 html 的 `cvInitVoices` 选择策略）：精确匹配 Xiaoxiao Online → Xiaoxiao/Yunxi Online → 任意 Online(Natural) → `localService === false`——**这些分支在 Electron 里全部落空**，最终 fallback 到本地 SAPI 语音（机械音；系统未装中文语音时更差）。
- **推论**：要让资料 html 语音与聊天一致，唯一可靠路径是绕开 speechSynthesis，改走主进程 edge-tts 链路（ISSUE-011 的桥接方案）。
- **记录时间**：2026-08-30

## [ISSUE-014] 孩子 agent 调用 page_inspect 多次失败，需定位失败档位

- **类型**：bug
- **描述**：孩子 agent 几次调用 `page_inspect`（查看学习资料页面 DOM 快照）均失败（返回「快照获取失败：xxx」/「页面无响应」等），需排查。
- **调用链（已梳理）**：
  - `electron/lib/custom-tools.ts:1019` `pageInspectTool.execute` → `executePageAction(childId, { action: "read", maxDepth, maxNodes })`（`page-bridge.ts:191`，**10s 超时兜底**「页面无响应（10 秒超时）」）→ `pageExecTransport`（`ipc-handlers.ts:48` 注入：`w.webContents.send("pi:page:exec", …)`）→ 渲染 `src/pages/Learn.tsx:343` `handlePageExec` → **childId 不匹配则静默 return**（:350）→ `materialsPanelRef.current.exec("read")`（面板未挂载则回执「当前没有打开的学习资料页面」）→ `MaterialsPanel.exec`（`MaterialsPanel.tsx:153-171`：iframe/桥未就绪 →「页面未就绪或已关闭」；postMessage 后 10s 无回执 →「页面无响应」）→ 回执 `pi:page:exec:result` → `resolvePageAction`（page-bridge.ts:211）。
- **失败档位（按可能性排序，需 agent 报错原文定位）**：
  1. **未展示资料/无 iframe**：MaterialsPanel 处于列表态（没选中资料）或当前 `view !== "materials"`（如进度看板页，面板卸载）→「页面未就绪或已关闭」/「当前没有打开的学习资料页面」——agent 在未先 `display_content` 时调 page_inspect 必然失败。
  2. **childId 不匹配**：agent 会话 childId（`childIdFromCwd(ctx.cwd)`）与学习界面当前孩子（`childIdRef.current`）不一致（多孩子切换 / 后台会话）→ 渲染层静默丢弃 → 主进程 **10s 超时**「页面无响应」。
  3. **iframe 桥未就绪**：资料刚打开、iframe 仍在加载/桥未握手（`readyRef` false）→「页面未就绪或已关闭」。
  4. **transport 未注入 / 主窗口 null**：`registerIpcHandlers` 未执行或 `getMainWindow()` 为 null → `pageExecTransport` 默认分支 `console.warn("[page-bridge] transport 未注入…")` 丢弃 → 超时。
  5. **iframe 内快照执行失败/超时**：页面 DOM 巨大（默认 maxNodes 500 / maxDepth 8 仍可能慢）或桥脚本异常 → postMessage 无回执 → 超时。
- **待用户提供**：agent 返回的报错**原文**（「快照获取失败：`<error>`」的 error 内容 / 是否显示超时），可直接定位到上述档位。
- **优先级**：已完成（2026-08-30 实测会话报错原文=`Cannot read properties of undefined (reading 'catch')`——是代码级异常非上述 5 档位：pageExecTransport 未注入/主窗口 null 时返回 undefined，executePageAction 直接 `.catch` 崩。已改 `Promise.resolve(pageExecTransport(...)).catch` 兜底；主窗口不存在时按 10s 超时「页面无响应」语义返回）
- **记录时间**：2026-08-30

## [ISSUE-015] 孩子页面操作不自动投递 agent，随下一轮消息附带发送

- **类型**：需求 / 行为调整
- **描述**：孩子在左侧学习资料页面上的操作（打开/点击/滚动/输入/提交）目前会**自动注入 agent 会话**，导致 agent 对每一个操作环节都要回复一次。改为：
  1. 操作事件**仅记录**（环形缓冲保留，供 `page_inspect` / 上下文读取）；
  2. **不自动发送给 agent**（去掉自动注入）；
  3. 在孩子的**下一轮消息**里，把这段时间的页面操作作为一段说明附带发送，并**注明「这部分是孩子在页面的操作」**；发送后清空。
- **现状 / 排查入口（已定位）**：
  - 事件上报：iframe 桥 → `src/pages/Learn.tsx:340` `handlePageEvent` → `window.api.pageEvent`（`pi:page:event` IPC）→ `queuePageEvent`（`electron/lib/page-bridge.ts:169`）：① 入环形缓冲（`bufferFor` 容量 50，供 `recentInteractions` / page_inspect 读，:223）；② **600ms 批处理后自动注入**（:183 `injectToSession`）。
  - **自动注入（根因）**：`injectToSession`（page-bridge.ts:135）：会话空闲 → `session.followUp(text)`（**立即投递** → agent 回复）；运行中 → `session.steer(text)`（排队注入）。注入文本前缀 `[页面事件]`（`buildInjectionText` :132）——这就是「agent 对每个操作环节都要回复」的来源。
  - 改造方向：
    ① `queuePageEvent` 停止自动注入（保留环形缓冲；600ms 批处理改为只累积 `pending` 待发送列表，或直接停用投递）；
    ② 按 childId 维护「待附带页面操作」列表（可直接复用缓冲：下一轮发送时取 `recentInteractions` 合并）；
    ③ 注入点：孩子发消息 `src/pages/Learn.tsx:433` `handleSend`（组装 `promptText` :528）——把 pending 页面操作以「[页面操作] 孩子在页面的操作：…」附加进消息，发送后清空；或主进程在孩子 user 消息进入会话时统一拼接（pi-session 消息入口）；
    ④ `page_inspect` / `page_action`（agent 主动查看/操作页面）能力保持不变。
- **优先级**：已完成（2026-08-30 实施：queuePageEvent 停用自动注入（删除 injectToSession/setSessionProvider 链路），事件只入环形缓冲（page_inspect 可读）+ 累积 pendingByChild；新增 takePendingPageEvents + IPC pi:page:pending + preload pageTakePending；Learn.tsx handleSend 取走并以「[页面操作] 这部分是孩子在页面上的操作：…」附到下一轮消息、发送后清空；page-bridge.test.ts 旧注入测试重写为新语义）
- **记录时间**：2026-08-30

## [ISSUE-016] 孩子界面：中间展示区折叠按钮仅学习资料页有，学习进度等页也需支持折叠

- **类型**：需求 / UI 一致性
- **描述**：孩子界面（Learn.tsx）中间展示区（learn-body）在**学习资料页**（`view === "materials"`）可以折叠（`materialsCollapsed`：收起资料区、聊天区占满剩余空间，左侧有折叠条/展开按钮）；但在**学习进度等其它展示页**（`view === "progress"` 渲染 `LearningDashboard`）中间区**没有折叠能力**，聊天区被固定宽度限制、无法占满。希望**所有展示页**（学习资料、学习进度等）都提供同样的折叠/展开按钮，让聊天区能占满。
- **现状 / 排查入口（已定位）**：
  - 折叠 state：`src/pages/Learn.tsx:114` `const [materialsCollapsed, setMaterialsCollapsed] = useState(false)`——命名绑定 materials，语义上应泛化为「中间展示区折叠」。
  - 折叠条（仅 materials）：`Learn.tsx:777-785` `material-collapsed-bar`（条件 `view === "materials" && materialsCollapsed`）；MaterialsPanel 内折叠按钮 `onCollapse` (:793) → `setMaterialsCollapsed(true)`。
  - 中间区分支：`Learn.tsx:775-798` `view === "materials" ? <MaterialsPanel …/> : <LearningDashboard …/>`——progress 分支直接渲染 `LearningDashboard`，无折叠包裹。
  - 聊天区宽度：`Learn.tsx:799-809`（折叠时 `flex:1` 占满），同样绑定 `view === "materials" && materialsCollapsed`。
- **改造方向**：
  ① 将「中间展示区折叠」抽象为不依赖 view 的能力（state 重命名如 `panelCollapsed`，或保留 `materialsCollapsed` 但扩展语义到所有 view）；
  ② 中间区统一包裹：无论 `MaterialsPanel` 还是 `LearningDashboard`，外层容器支持折叠 → 折叠时显示窄条展开按钮、聊天区 `flex:1` 占满；
  ③ 各展示页（如 `LearningDashboard`）需暴露 `onCollapse`（类似 MaterialsPanel 的 `onCollapse`）或在 Learn 层统一加折叠控制；
  ④ 注意 `LearningDashboard` 自身内部可能有独立布局/滚动，折叠其**外层容器**即可，无需改动其内部。
- **优先级**：待定（本会话仅记录，未实施）
- **记录时间**：2026-08-30
