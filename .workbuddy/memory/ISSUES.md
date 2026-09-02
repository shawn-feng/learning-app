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
- **优先级**：已完成（2026-08-31 实施：折叠能力泛化为 `panelCollapsed`（不再绑定 view/materials）；任意展示页折叠后显示窄条展开按钮、聊天区 flex:1 占满；`LearningDashboard` 等非资料视图外层包 `panel-collapse-host` + 右上角悬浮折叠按钮（panel-collapse-fab），不侵入组件内部布局；display_content 自动展开逻辑同步改 `setPanelCollapsed(false)`）
- **记录时间**：2026-08-30

## [ISSUE-017] 孩子界面：学习资料点击/选中不认识的字词，显示读音+释义（不修改资料 html）

- **类型**：需求 / 功能（学习辅助）
- **描述**：孩子年龄小，学习资料（iframe 内的课程 html）里有不认识的字词。希望孩子**点击或选中**某个字词，就能**显示该字词的读音和意思**（拼音/释义），降低阅读门槛。要求：**不修改任何学习资料 html 文件本身**就能实现（资料 html 由课程生成器产出、存量多，不应逐个改）。
- **可行性（已查证，可行）**：资料 html 经 `injectBridge(html)` 注入 `BRIDGE_SCRIPT` 桥脚本（`src/lib/page-bridge.ts:388`、脚本体 :95）运行在 iframe 内，经 `window.parent.postMessage` 与父页面（`MaterialsPanel.tsx:104` send / :152 handler）双向通讯——ISSUE-011 的 speechSynthesis 接管正是同机制、已验证。**iframe 为 opaque origin（sandbox 不带 allow-same-origin，`MaterialsPanel.tsx:75`）→ 父页面不能直接读 iframe DOM，但桥脚本能读自己 DOM 并上抛**，故「捕获选中文本」在 iframe 内脚本做即可，不改资料 html。
- **现状 / 排查入口**：
  - 上行通道：`BRIDGE_SCRIPT` 的 `send(msg)`（`page-bridge.ts:101-105`）→ `window.parent.postMessage({type:"page:event", kind, detail}, "*")`；父 handler 在 `MaterialsPanel.tsx:152-209`（按 `data.type`/`kind` 分发，现有 `tts`/`tts-cancel`/`click`/`scroll` 等）。
  - 事件监听约定：全部捕获阶段、绝不 preventDefault/stopPropagation，不干扰课程脚本（`page-bridge.ts:204-205`）——新增 lookup 监听须遵守。
  - 读音复用：资料朗读已走 `speakMaterialText(text)` → `window.api.voiceTts`（edge-tts，与聊天同音色，ISSUE-011）——lookup 的「读音」可直接复用。
  - 释义数据源：**当前代码无中文字典**。需新增（见改造方向④）。
- **改造方向**：
  ① **捕获交互（桥脚本内）**：在 `BRIDGE_SCRIPT` 增加监听——孩子「选中文字后松开（mouseup + getSelection）」或「双击单字（dblclick）」→ 取选中/命中文本，避免与课程已有单击发音冲突（用选区/双击触发，不拦单击）。可附点击坐标 clientX/clientY 供浮层定位。
  ② **上抛父页面**：新增 `kind: "lookup"`（detail 含 text + 坐标），send 上行；`MaterialsPanel` handler 增加 `lookup` 分支（不进 `onPageEvent` 页面操作记录、不自动投 agent，遵循 ISSUE-015）。
  ③ **父页面浮层**：`MaterialsPanel` 上方覆盖一小卡片（拼音 + 释义 + 🔊 朗读按钮），按需定位到字词附近（用②的坐标）；点空白关闭。
  ④ **释义数据源**：起步用**本地内置汉字/词语字典（json，离线、隐私友好）**；进阶可选在线词典 API（需联网、国内可达性评估）；可在主进程/electron 侧或 server 侧内置字典，经 IPC/接口返回释义。建议先做本地字典（覆盖常用字 + 课程高频词）。
  ⑤ **分词/优先级**：选中文本优先整词查（词典精确匹配词条）；否则按单字拆分逐字展示（适合「点单字查字」场景）；也支持直接双击单字查该字。
- **优先级**：已完成 ✅（2026-08-31 实施）
- **实施记录（2026-08-31）**：
  - ① 桥脚本（`page-bridge.ts` BRIDGE_SCRIPT）：新增 `mouseup`（拖选）+ `dblclick`（双击选词）监听（捕获阶段、不 preventDefault），`getSelection` 取文本——过滤：无选中/纯英文数字/表单内（input/textarea/select）/超 8 字均不上抛；坐标随事件上抛（`detail.x/y`，相对 iframe 视口）；同文本近坐标 2s 节流防 mouseup+dblclick 双报。`PageEventKind` 加 `"lookup"`，`detail` 加 `x/y`。
  - ② 父页面（`MaterialsPanel.tsx`）：handler 加 `lookup` 分支——`lookupText()` 本地查词 → `WordLookupOverlay` 浮层（fixed 定位：iframe rect + clientX/Y，clamp 视口内）。**不进 `onPageEvent`**（遵循 ISSUE-015）。关闭：点浮层外空白（content-panel onClick）、Esc、iframe 内后续 click（非同交互序列 400ms 宽限）/scroll、资料刷新/卸载。⚠️ handler 闭包内 state 恒初值 → `lookupRef` + `showLookup` 同步（ISSUE-014 教训）。浮层条目：大字 + 拼音（多音空格分隔）+ 释义 + 🔊 朗读（复用 `speakMaterialText` → edge-tts）。
  - ③ 本地字典：`scripts/dict-build/`（chinese-xinhua word.json 16142 条 + pinyin-pro 多音补全）→ `src/lib/dict/chars.json`（14809 字，425 核心字儿童化释义覆盖）+ `words.json`（713 儿童高频词）；`overrides.mjs` 为儿童化覆盖表（**构建时合并，覆盖表拼音列含常用多音如「行 xíng háng」**）。构建：`node scripts/dict-build/build-chars.mjs`。
  - ④ 查询模块 `src/lib/dictionary.ts`：`lookupText()` 整词优先 → 贪心最长词拆分（首字分桶、词长降序、≤4 字）→ 逐字兜底；非中文跳过。数据经 `resolveJsonModule` 内联进渲染 bundle（+~0.7MB）。
  - ⑤ 测试：`test/dictionary.test.ts`（8 例）+ `test/page-bridge.test.ts` 新增 8 例 lookup 桥测试 → 42 例全绿；`tsc --noEmit` 无业务错误；`npm run build` 成功。桥体积 12.04KB（阈值 12→13KB）。
  - **遗留**：全量 vitest 16 文件失败系「无法连接服务端（127.0.0.1:8788，SPLIT 服务端未启动）」环境依赖，与本次改动无交集（page-bridge/dictionary 相关 42 例已独立验证全绿）。

## [ISSUE-018] 孩子界面：每学完一课压缩当前会话历史，节省 token

- **类型**：需求 / 性能（token 优化）
- **描述**：孩子每课学习都是新内容，与前面课程关系不大。希望**每学完一课后，把当前会话里前面课程的对话压缩/摘要掉**，只保留最近本课上下文与学习进度，从而节省 token（长课/多轮尤其明显）。
- **现状 / 排查入口（已查证）**：
  - **已有被动 compaction（非「每课」主动压）**：`electron/lib/user-init.ts:54` `buildChildSettings()` 返回 settings，`compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 10000 }`——SDK 在上下文接近模型上限（contextWindow - reserveTokens）时自动把旧消息摘要化、保留最近 10k token。**这是「满了才压」的被动机制，不是「每课结束主动压」，长课中途不省 token。**
  - **按天总结（非压缩当前会话）**：`electron/lib/daily-summary.ts` `summarizeDailyConversation`（按天把对话摘要写入 daily 文件）+ `summarizeConversationTool`（`summarize_conversation` 工具，供 agent 主动调）；`pi-session.ts:357` `maybeSummarizeBeforeNewSession` 在**开新会话前**对「今天之前最后有会话的一天」做按天汇总写入 daily（fire-and-forget）。这些是「持久化到 daily 供新会话首轮注入」，不压缩/缩减**当前会话**历史本身。
  - **自动 newSession 归档**：`pi-session.ts:425` `shouldAutoNewSession` 跨天/过时间节点时 `mgr.newSession()`（旧会话文件归档为历史、开空会话）——与「压缩当前会话」不同（归档=另开新会话，旧历史脱离当前上下文但不摘要替换；触发条件是时间而非「课」）。
  - **session API 面**：当前用到 `session.setThinkingLevel` / `dispose` / `sessionManager.newSession`（`pi-session.ts:455/568/615/429`），**未见手动 `compact()` 调用**；compaction 由 settings 被动驱动，疑似无公开手动触发接口（待确认）。
- **改造方向**：
  ① **确认 SDK 是否暴露手动 compact**：查 `node_modules/@earendil-works/pi-coding-agent` 的 AgentSession 类型/方法（如 `session.compact()`）；若有直接调用；若无，自实现如下②。
  ② **自实现「压缩当前会话」**：取当前会话 jsonl 历史 → 调 LLM 摘要（复用 `summarizeDailyConversation` 的摘要 prompt/逻辑）→ 将旧消息替换为一条/几条摘要消息，**保留最近本课对话 + 学习进度摘要**（progressContext 类），丢弃前面课程逐轮细节。与 SDK 自动 compaction 互补（主动压=提前省 token，被动压=满了兜底）。
  ③ **「一课完成」触发信号（关键，需确定）**：
     - 推荐：**display_content 切换到不同课程资料时**（`Learn.tsx` 的 display_content 链路 :202-215 materials 变化 effect）——孩子打开新课资料意味上一课告一段落，触发对上一课对话压缩；
     - 备选：新增 agent 工具 `compact_session`（让 agent 判断一课学完后自调）；或 UI（孩子/家长端）加「本课完成·压缩会话」按钮。
  ④ **防误压**：仅在「课程切换 / 明确一课完成」时触发，不每轮压；压缩前可顺带把本课要点写 daily（与现有 summarize 互补）。
  ⑤ **兼容性**：压缩后系统提示/AGENTS/进度概览仍由 SDK 首轮自动附加（`pi-session.ts:404` systemPromptOverride + progressContext），不受影响。
- **优先级**：⏸ 暂缓 / 暂不处理（用户 2026-08-31 标注：后续再讨论，本期不动）
- **记录时间**：2026-08-31

## [ISSUE-019] 家长端按孩子设置课程时间段，上课/下课在 app 顶部 1/3 区域提醒（铃声 + 语音播报）

- **类型**：需求 / 新功能（家长端配置 + 孩子端提醒）
- **描述**：在**家长界面为每个孩子单独设置课程时间段**（上课时间、下课时间，可多段/课表式）。到了上课/下课时间点，在孩子 app 界面**上方三分之一区域**弹出醒目提示（上课/下课），并**伴随铃声或语音播报**（如「上课时间到了，请开始学习」/「下课啦，休息一下」）。
- **现状 / 排查入口（已查证）**：
  - **按孩子配时间的现成骨架**：`electron/lib/scheduler.ts` 的 `DEFAULT_CHILD_CONFIG` 已有 `recording: { enabled, times[], onNewSession }`，配置经 `scheduler:config:get/set`（`preload.ts:200`）按 childId 存取，UI 在 `src/components/SchedulerSettings.tsx`（逐孩子卡片、时间用 `<input type="time">`、可增删多时间点）——**课程时间段配置 UI 与存储可完全照搬这套「按 childId + 多时间点」结构**，无需新造数据层。
  - **每分钟触发定时器已存在**：`scheduler.ts` 内已有 per-minute tick（`cc.recording.times.includes(nowMin)`，`scheduler.ts:345/442`），在 tick 里比对当前时间与各孩子配置即可触发——课程提醒可**复用同一计时循环**，新增 `classTimes` 比对 + 起止跳变检测（同一分钟只触发一次，用 lastFired 防重）。
  - **语音播报链路已通**：`electron/lib/ipc-handlers.ts:1425` `ipcMain.handle("voice:tts", … synthesize(text, opts))` 返回 mp3 base64（edge-tts 默认，经 `tts-config.ts` 可切 qwen/mimo）；渲染端 `MaterialsPanel.tsx:104 speakMaterialText` 已演示「调 `voiceTts` → `new Audio(mp3)` 播放」。故**语音播报直接复用 `voice:tts` 即可，与资料/聊天同音色**。
  - **铃声素材当前缺失**：全局搜 `mp3/wav/bell/ding` 无现成铃声资源；`media-protocol.ts`/`config.ts` 支持 mp3/wav 但无内置铃声文件。**需捆绑一个短促铃声 mp3/wav 到 app 资源目录**（如 `resources/bell.mp3`），提醒时播放。
  - **顶部提示现有机制偏弱**：仅有聊天区小条 `chat-notice`（`styles.css:2316` + `ChatWindow.tsx:805`，只在聊天顶部一小条）；需求是「**页面上面三分之一**」的全屏固定横幅——需新增 **app 级 overlay**（`position: fixed; top:0; height:33vh; z-index 高`），覆盖 Learn 各子视图，不依赖当前在哪一页。
- **改造方向**：
  ① **数据模型**：`scheduler.ts` `ChildSchedulerConfig` 增 `classTimes: { start: string; end: string; label?: string }[]`（每孩子多段）；`SchedulerSettings.tsx` 增「课程时间段」section（`<input type="time">` 起始/结束 + 增删，复用现有卡片/Plus/Trash2 模式）；存储走现有 `scheduler:config:set` 按 childId。
  ② **触发（复用计时）**：在现有 per-minute tick 中，对每个孩子遍历 `classTimes`，检测「当前分钟 ∈ [start, start) 跳变」=上课、「∈ [end, end) 跳变」=下课，用 `lastReminder` 标记防同分钟重触发；到点后 `webContents.send("class:reminder", { childId, type: "start"|"end", label })`（需在主进程持 webContents，沿用 recording 已有的定时任务执行上下文）。
  ③ **铃声 + 语音**：主进程/渲染端收到 `class:reminder` 后——a) 播放捆绑铃声 mp3（`<audio>` 或主进程读资源 buffer 播放）；b) **可选语音播报**：调 `voice:tts`（或渲染端 `voiceTts`）合成提示语并播放，音色与资料/聊天一致；两种可并存，也允许家长设置「仅铃声 / 仅语音 / 两者」。
  ④ **顶部 1/3 横幅（app 级 overlay）**：建议在 `Learn.tsx` 顶层（甚至 `App`/`Home` 层，确保任意子页可见）加一个固定定位的横幅组件，收到 `class:reminder` 时显示 33vh 高、醒目配色、上课/下课图标与文案，数秒后淡出或手动关闭；**注意多孩子场景**：横幅 childId 需与当前登录孩子匹配才显示（或家长端不显示、仅孩子端）。
  ⑤ **边界**：app 未打开/孩子未登录时不弹（静默）；跨天/配置变更后 tick 自动生效；铃声文件需随安装包分发（打包进 `extraResources`/asar 外）。
- **优先级**：已完成（2026-08-31 实施：`scheduler.ts` ChildSchedulerConfig 增 `classTimes[]`（start/end/label，可多段）+ `classAlertMode`（both/chime/voice）；`SchedulerSettings.tsx` 每孩子卡片加「课程时间段」section（起止 time + 课程名 + 增删 + 提醒方式 radio）；per-minute tick 检测起止跳变（`cs["class-reminder"].lastKey` 含日期防同日同点重触发）→ `webContents.send("class:reminder")` 广播（透传 mode）；`preload.ts` 加 `onClassReminder`；`Learn.tsx` 顶部 33vh 固定横幅（渐变+大图标，8s 自动消失/点击关闭，childId 匹配当前孩子才显示）+ 铃声（Web Audio 合成叮咚，零资源文件依赖）+ 语音播报（`voiceTts` edge-tts 与聊天同音色，按 mode 播报）；scheduler-task-state 测试更新 4 键。全量 288 例 0 失败、tsc 0 业务错误、build 通过）
- **⚠️ 查看入口（2026-08-31 用户实测「没看到」）**：区块在**家长端「设置 → 定时任务」→ 每个孩子卡片内**（⏰ 课程时间段，含空态提示「尚未设置课程时间段，点下方按钮添加」）。**主进程改动（scheduler.ts/preload.ts）必须完全退出 app 重启才生效**（dev 模式主进程不热更新）；渲染产物已确认包含新 UI 字符串。已补 archive-limit.test.ts 两例 classTimes 读写/兜底测试。
- **⚠️ 横幅交互调整（2026-08-31 用户要求）**：提醒横幅**不自动消失**——一直显示到孩子**点击**才关闭（删 8s 自动消失 effect）；横幅底部加「👆 点击关闭提示」闪烁文字（class-reminder-dismiss，blink 动画）。
- **⚠️ 二轮调整（2026-08-31 用户要求）**：① **铃声/语音也循环重复播报**——横幅常驻期间每 15s 重播一次直到点击关闭（`playReminderAlert` 统一首次+循环；`speakReminder` 加 `reminderSpeaking` 锁防上一轮未播完时重叠；interval effect cleanup 关闭即停）；② **孩子左侧边栏新增「今日课程」区块**（`SidebarClassSchedule` 独立组件：实时时钟 HH:mm:ss 每秒刷新只重渲染自身 + 当天课程时间段列表，经 `schedulerConfigGet` 取当前孩子 classTimes；折叠态显示 CalendarClock 图标按钮）。
- **记录时间**：2026-08-31

## [ISSUE-020] 孩子端左侧「切换展示页」浮层：鼠标移到选项框就消失、难选中

- **类型**：Bug / 交互（孩子端左侧边栏）
- **描述**：孩子界面左侧边栏的「切换展示页」（学习进度 / 学习资料等）弹出框，鼠标从触发按钮移向浮层选项时，浮层就消失，很难选中目标项；移动越慢越容易出现。
- **现状 / 根因（已查证代码）**：
  - 浮层是纯 hover 驱动：`.view-switcher`（`Learn.tsx:657-661`）挂 `onMouseEnter={() => setViewMenuOpen(true)}` / `onMouseLeave={() => setViewMenuOpen(false)}`，按钮**无 onClick 切换**，只有悬停才显示（`Learn.tsx:662-690`：`<button className="view-switcher-btn">` 仅 title，无 onClick；popover `viewMenuOpen && <div className="view-switcher-popover">` 为其 DOM 子元素）。
  - **致命间隙**：`styles.css:861-863` `.view-switcher-popover { position:absolute; left: calc(100% + 6px); top:0 }`——popover 左缘相对触发器右缘外移了 **6px**，二者之间存在一条**不属于任何元素**的空白缝隙。
  - 原生 `mouseleave`（React `onMouseLeave` 语义：移到子元素不触发，但离开元素边界到空白会触发）在鼠标穿过这 6px 空白时于 `.view-switcher` 上触发 → `setViewMenuOpen(false)` → popover 卸载 → 浮层消失。慢移时鼠标精确穿越缝隙，必然触发（"慢一点就消失"）；快移有时因轨迹略斜而侥幸不触发。
  - 注：popover 虽是 `.view-switcher` 的 DOM 子节点，但视觉偏移在容器外，且中间有 6px 真空气隙，故 hover 链断裂。
- **改造方向（按稳健性递进）**：
  ① **消除间隙（首选，低成本）**：popover 改 `left: 100%`（去掉 `+6px`），并用透明桥接伪元素覆盖缝隙——`.view-switcher-popover::before { content:""; position:absolute; left:-8px; top:0; width:8px; height:100% }`，使触发热区连续无断点。
  ② **关闭延时（兜底）**：`onMouseLeave` 不直接置 false，而设 ~150-200ms 定时器 `setTimeout(() => setViewMenuOpen(false), 180)`，期间 `onMouseEnter` 取消定时器；给孩子越过缝隙的容错时间（即使仍有小缝也不关）。
  ③ **点击切换（更适合低龄）**：给 `view-switcher-btn` 加 `onClick={() => setViewMenuOpen(v => !v)}` 变真下拉，hover 仅作辅助；选中项或点外部（`click-outside`）才关闭——不依赖 hover 几何，选中最可靠。
  ④ 组合 ①②③ 最稳；另确认 `PANEL_VIEWS` 顺序含「学习进度 / 学习资料」且 `setView(v.key)` 切换无误（现有 `:677-680` 已正确）。
- **优先级**：已完成（2026-08-31 实施：组合 ①②③——popover 改 `left:100%` + `::before` 透明桥接覆盖缝隙（8px 宽、上下各延展 6px）；`onMouseLeave` 改 ~180ms 延时关闭（`onMouseEnter` 取消定时器）；按钮加 `onClick` 切换真下拉 + 文档级 click-outside 关闭（viewSwitcherRef 判断）；卸载清理定时器）
- **记录时间**：2026-08-31

## [ISSUE-021] 孩子端学习资料列表：课名显示"未命名" + 重发资料不刷新/卡在别的课程

- **类型**：Bug / 数据展示 + 交互（孩子端左侧学习资料列表）
- **描述**：在 192.168.1.201（ubuntu）运行的孩子端 app、闻闻的会话里：① `display_content` 时左侧「学习资料」列表没有课程名，全是"未命名资料"；② 家长重新发送某课学习资料时，左侧不会自动显示最新重发的那份，仍停在别的课程的资料上。
- **现状 / 根因（已查证代码）**：
  - **列表 title 来源**：`MaterialsPanel.tsx:420` 渲染 `m.title || "未命名资料"`；`m.title` 来自 `display_content` 工具结果 `details.panelContent.title`（`custom-tools.ts:139`）。
  - **title 生成逻辑**：`custom-tools.ts:113/130` `titleBase = rest.replace(/\.[^.]+$/,"").split("/").pop()`（=资料文件名去扩展名），`title = params.title || titleBase`。即：仅当 agent 显式传 `title` 或文件名本身含可读课名时列表才显课名；否则是裸文件名，无意义/为空即"未命名资料"。
  - **课名未下传（核心 A）**：课程真实名称在 `courses.title`（`parent-library.ts:139` 等，`(topic,title)` 唯一），但 `display_content` 只接收 `path`（`<topic>/<file>.html`），**从不查 `courses` 取课名**下传给列表——系统知道课名却不传。若学习 agent 调 `display_content` 不带 `title`、且 html 文件名非课名（每课一子目录 / 按 id 命名），列表即全"未命名"。
  - **重发卡别的课程（核心 B）**：`Learn.tsx:226` 去重 `if (filePath && prev.some(m => m.filePath === filePath)) return prev`——同一课重发（path 相同）被整体丢弃，`materials` 引用不变 → `useEffect([materials])`（`:209`）不触发 → `setSelectedMaterialId(materials[materials.length-1].id)`（`:213`）不执行 → 选中项停在之前别的课程资料上；即便家长改了内容重发（同 path）旧内容也不更新。仅 path 不同（新课）才追加并自动选中——故"卡别的课程"正是**同 path 重发被去重**所致。
  - **⚠️ 环境差异（2026-08-31 用户补充）**：**该问题仅在 ubuntu（192.168.1.201）孩子端出现，Windows 本机 app 客户端不复现**。两条症状（"未命名" + 重发不跳最新）在 Windows 正常 → 强烈指向 **ubuntu 客户端跑的是滞后构建**：当前代码里 `titleBase` 文件名回退（`custom-tools.ts:130`）、`Learn.tsx:209` 自动选中 effect（ISSUE-014）、以及下文 ① 的 `courses.title` 下传修复若存在则 Windows 已含、ubuntu 未含。即：**根因大概率不是"代码永远错"，而是"ubuntu 构建没拿到这些已存在的修复"**。
  - **结论性排查顺序（必须先做）**：① 先核对 ubuntu 客户端版本/构建日期，确认是否含 `titleBase` 回退 + ISSUE-014 自动选中；② 若滞后 → **升级 ubuntu 客户端到当前构建并复测**，很可能直接消失，无需改代码；③ 若升级后仍在当前构建上复现 → 才是真代码 bug，按 ①② 改造方向修。
- **改造方向**：
  ① **课名下传**：`display_content` 解析 `path` → 按 `topic` + `html_path` 匹配查 `courses` 取 `courses.title` 作默认 `title`（agent 显式 `title` 仍优先）；或在 agent 系统提示/教学方法里要求展示课程必须带 `title=课名`。列表恒显课名。
  ② **重发刷新（关键约束）**：**禁止用"完全重复就不显示"的逻辑**。即使重发的内容与上一课 100% 相同（path 相同、内容 hash 也相同），左侧也必须自动把"最近一次 display_content 的那份"重新选中并显示在最前/最新位置，方便用户查看——即去掉 `Learn.tsx:226` 的"同 filePath 即 `return prev` 整体丢弃"，改为：命中同 path 时就地替换内容 + **无条件重新 `setSelectedMaterialId(该项)` 并滚动定位到该项**；新增资料照常追加末条并选中。去重只用于避免"同一轮消息内连续推送多份同 path 资料时堆积成 N 条"，不用于"跨轮重发时吞掉显示"。
  ③ **优先：升级 ubuntu 客户端核对（环境差异，最高优先级）**：Windows 不复现 → 先确认 192.168.1.201 ubuntu 客户端构建是否含 `titleBase` 回退 + ISSUE-014 自动选中 + ① 的 `courses.title` 下传；若滞后则**升级该 ubuntu 客户端并复测**，很可能症状直接消失、无需改代码。仅在升级后仍于当前构建复现，才推进 ① ② 代码修复。
  ④ **回归**：display_content 新教材自动弹开（ISSUE-014）、去重不堆积（`:224` 注释）、列表 title 渲染（`:420`）仍正确。
- **优先级**：已完成（2026-08-31 实施：① `custom-tools.ts` display_content 解析 `{topic}/{file}.html` 后按归一化 `html_path` 匹配查 courses 取 `title` 作默认（agent 显式 title 优先；先孩子库 `kb.courses.list` 再家长库 `parent_lib.courses.list`，匹配失败静默回退文件名）；② `Learn.tsx` handleToolEnd 去掉「同 filePath 即 return prev 丢弃」——同 path 重发改为**就地替换 content/title/time + 移到列表末尾（最新位置）+ 返回新数组引用触发自动选中**（满足「重发必须重新显示」约束，去重仅防同轮堆积）；③ `MaterialsPanel.tsx` HtmlFrame key 由 `html.length` 改为 `长度:内容hash`，同长度不同内容的重发也能重建 iframe 展示最新内容；④ ubuntu 环境差异核对结论：Windows 不复现→大概率滞后构建，需在 ubuntu 客户端升级到本构建后复测确认）
- **记录时间**：2026-08-31

## [ISSUE-022] 测试债务：9 个测试文件未随 SPLIT 迁移更新，全量 vitest 稳定失败 39 例

- **类型**：测试 / 架构迁移遗留
- **描述**：SPLIT 拆分后（2026-08-27 起），一批测试仍按旧架构（本地 kb.sqlite / 全局 scheduler 配置 / 本地 agent SQLite / 同步 async 化前）编写，导致全量 `vitest run`（需 127.0.0.1:8788 服务端运行）稳定失败 9 个文件 39 例（289 例中 250 过）。
- **失败清单与根因（2026-08-31 全量实测）**：
  1. `test/kb-tools.test.ts`（17 败）：kb_insert/kb_query/kb_update 走 `serverFetch` → 401「缺少 session token」（无登录 token）；需 `vi.mock server-client` 或预置 token。
  2. `test/kb-sqlite.test.ts`（6 败）：真实数据冒烟读本地 `data/children/1f050a7f/kb.sqlite`——SPLIT 后本地 kb 不再写，返回 0；应改读服务端 RPC 或删除该段。
  3. `test/auto-new-session.test.ts`（6 败）：scheduler-config 按家长分区后路径 `parents/_guest/scheduler-config.json` 父目录未建 → ENOENT；写配置前需 mkdir（getParentConfigDir 已自动建，测试直接写文件需补）。
  4. `test/sync.test.ts`（3 败）：`listChildren()` 未 await（async 化迁移遗漏）→ `children[0].childId` TypeError。
  5. `test/daily-summary.test.ts`（2 败）：buildProvidedContext 读本地 kb.sqlite（同 kb-sqlite 根因）。
  6. `test/scheduler-task-state.test.ts`（2 败）+ `test/event-poll-config.test.ts`（1 败）+ `test/archive-limit.test.ts`（1 败）：scheduler 配置 shape/家长分区路径迁移陈旧。
  7. `test/agents-sqlite.test.ts`（1 败）：saveAgentPrompt 已上云走 serverFetch 401（ISSUE-033 测试未 mock）。
- **入口**：各测试文件如上；统一思路=按 SPLIT 后真源（服务端 RPC / 家长分区配置路径）重写断言，需服务端 mock 或测试 token 的走 `vi.mock("server-client")`（参考 backup.test.ts 的 mock 模式）。
- **优先级**：低（均非业务回归，属技术债；修复前跑测试请先确认失败清单无新增项）
- **✅ 已修复（2026-08-31）**：9 个文件全部按 SPLIT 语义重写，全量 `vitest run` 31 文件 / 288 例 0 失败；两端 `tsc --noEmit` 0 错；`npm run build` 通过。修复明细：
  - `sync.test.ts`：三处 `childAuth.listChildren()` 补 `await`（async 化遗漏）。
  - `scheduler.ts saveSchedulerConfig`（真实缺陷）：写前 `fs.mkdirSync(path.dirname(p), {recursive:true})`——未登录 `_guest` 目录不建导致 ENOENT。
  - `pi-runtime.ts setProviderApiKey`（真实缺陷，同款）：写 `parents/_guest/auth.json` 前 mkdir（qwen-deepseek-models.test.ts 暴露）。
  - `custom-tools.ts kb_query progress`（真实缺陷）：服务端 `kb.courses.list` 返回 snake_case（`review_count` 等）未映射为 CourseItem camelCase → 复习次数/首次学习等字段丢失；补显式字段映射（learning-summary.ts 早已正确，仅 custom-tools 遗漏）。
  - `scheduler-task-state.test.ts`：断言改 3 键（session-reset 已删）。
  - `archive-limit.test.ts`：去掉废弃 `sessionReset` 字段/断言。
  - `auto-new-session.test.ts`：helper 写前 mkdir。
  - `daily-summary.test.ts`：`buildProvidedContext` 补 `await`；「种子库」用例改真实孩子（mock config + writeTestLicense + 服务端断言）。
  - `kb-tools.test.ts`：mock config + writeTestLicense；写测试每次 `crypto.randomUUID()` 注册全新测试 child（`registerTestChild`）隔离。
  - `kb-sqlite.test.ts`：「真实数据冒烟」改走服务端 dbQuery RPC。
  - `agents-sqlite.test.ts`：mock config + writeTestLicense + registerTestChild（随机 UUID）；saveAgentPrompt 补 await。
  - 注：`event-poll-config.test.ts` 无需改（scheduler.ts mkdir 修复覆盖）。
- **记录时间**：2026-08-31

## [ISSUE-023] 孩子聊天框字号设为可调节设置项，入口放孩子左侧边栏

- **类型**：Feature / 设置项（孩子端聊天字号调节）
- **描述**：把聊天框里的字体大小变成可调设置项，调节入口放在孩子界面的左侧边栏（与现有「朗读语速」并列），方便家长/孩子随时放大或缩小聊天文字。
- **现状 / 根因（已查证代码）**：
  - **孩子聊天字号当前硬编码**：`.bubble-md-child { font-size: 30px }`（`styles.css:2797`，ISSUE-009 将 15px 放大一倍为 30px）；其内 h1–h6 为绝对 px（h1 36 / h2 34 / h3 32 / h4–h6 30，`styles.css:2830-2835`），`pre` 代码块 22px（`:2838`）。所有值写死，家长端 `.markdown-body`（`:2401` 15px）不受影响——字号调节**仅孩子聊天的 `.bubble-md-child` 作用域**。
  - **边栏已有同类设置范式**：左侧边栏 `sidebar-rate` 区块（`Learn.tsx:713-739`）即「朗读语速」设置——展开态显示 `sidebar-section-label`+ `rate-grid` 按钮组、折叠态显示图标按钮（`Gauge`），状态 `rate` 为 `Learn.tsx:119` 的 `useState("+0%")`，经 `ChatWindow` 的 `rate` prop（`:836`）下传。字号设置**完全可套用同一骨架**（新增 `fontSize` state + 同类 UI 区块）。
  - **持久化先例**：`useChatPanel.ts`（`:7/12/19/34/42`）用 `localStorage` 按 `chat:${key}:collapsed/width` 持久化聊天面板状态，刷新后保留；而当前 `rate` 仅 `useState`、**未持久化**（刷新即回默认）。字号设置建议**复用 localStorage 范式按 childId 持久化**，避免每次进 app 重调。
- **改造方向**：
  ① **CSS 变量化**：给 `.bubble-md-child` 改 `font-size: var(--child-chat-font, 30px)`，并将 h1–h6/pre 改为相对单位（如 `1.2em`/`0.9em`）或同样引用变量派生，使一处字号即整体等比缩放；`Learn.tsx` 聊天容器设 `style={{ "--child-chat-font": fontSizePx }}`（经 `ChatWindow` 透传或外层包裹）。
  ② **边栏入口**：在 `sidebar-rate` 之后新增「聊天字号」区块（`Learn.tsx:739` 后），复用 `sidebar-section-label` + 控件：低龄友好建议**离散档位按钮**（小 22px / 中 30px(默认) / 大 38px / 特大 46px，沿用 `rate-grid` 样式），或 `<input type="range" min=16 max=48>` 滑块；折叠态给图标按钮（`Type`/`TextSize`）。
  ③ **状态与持久化**：`Learn.tsx` 加 `const [fontSize, setFontSize] = useState(...)`，`useEffect` 从 `localStorage.getItem(\`chat:${childId}:fontSize\`)` 初始化、变更时写回；默认 30px 与现状一致。
  ④ **作用域隔离**：仅对 `owner!=="parent"`（孩子聊天 `.bubble-md-child`）生效；家长端 `.markdown-body` 与资料面板不受影响（遵循 ISSUE-009 意图）。
  ⑤ **回归**：ISSUE-009 放大/紧凑行距、ISSUE-017 资料查词浮层、`.bubble-md-child` 渲染（ChatWindow）不受影响；字号滑块拖动实时生效、跨刷新保留。
- **优先级**：已完成（2026-08-31 实施：`.bubble-md-child` 改 `font-size: var(--child-chat-font, 30px)`，h1–h6/pre 改相对单位（1.2em/1.13em/1.07em/1em/0.73em）随基准等比缩放；`Learn.tsx` 边栏「朗读语速」后新增「聊天字号」区块（4 档按钮 22/30/38/46，折叠态 `Type` 图标，复用 rate-grid 样式）；`fontSize` state + localStorage 按 `chat:<childId>:fontSize` 持久化（默认 30px）；CSS 变量在 `.learn-chat` 容器下发，仅孩子聊天生效、家长端 `.markdown-body` 不受影响）
- **⚠️ 二轮修复（2026-08-31 用户实测）**：点击字号按钮气泡字体不变——根因=CSS 特异性：基础 `.message .bubble { font-size: 15px }`（0,0,2,0）压过 `.bubble-md-child`（0,0,1,0），正文一直 15px（ISSUE-009 时标题因同特异性后置规则生效、正文未放大，未被察觉）。修复=主规则提为 `.message .bubble.bubble-md-child { font-size: var(--child-chat-font,30px) }`（0,0,3,0）；标题/代码块同特异性后置已覆盖无需改。**教训：新增覆盖规则前先查基础规则特异性（.message .bubble / .markdown-body 等）**。
- **记录时间**：2026-08-31

## [ISSUE-024] 聊天框调宽手柄：当前是"点一下进入拖拽模式、再点一下退出"，应改成"按住拖拽、松手即停"

- **类型**：Bug / 交互（聊天面板拖拽手柄）
- **描述**：右侧聊天框左侧边缘有调宽手柄。当前行为是**点击一下就进入"拖拽模式"（之后移动鼠标即改变宽度），再点击一下才退出**；期望行为是**按住鼠标左键拖动才调宽、松开鼠标立即停止**（标准拖拽，松手即停）。
- **现状 / 根因（已查证代码）**：
  - **手柄绑定的拖拽逻辑**：`useChatPanel.ts` 的 `startDrag`（`src/hooks/useChatPanel.ts:49-70`）在 `onMouseDown` 时给 `window` 加 `mousemove`+`mouseup` 监听器，拖拽中 `setWidth` 实时改宽；`onUp` 负责移除监听器并还原 `cursor`/`userSelect`。**逻辑本身是"按住拖拽"模型**，不是 click-toggle——但有个致命缺陷：**`mouseup` 只监听在 `window` 上**。
  - **根因 = 拖到 iframe 上松手，`mouseup` 被 iframe 吞掉（经典"拖过 iframe"陷阱）**：孩子端 `Learn.tsx` 中间展示区是 `MaterialsPanel` 渲染的 **`<iframe srcDoc=...>`**（`MaterialsPanel.tsx:92/97`）——它是一个**独立 document**。手柄位于聊天面板左缘、紧邻中间区；用户往左拖（变宽）时鼠标移入中间区、若**在 iframe 上方松开**，`mouseup` 事件发生在 iframe 子文档里，**不会冒泡到父窗口 `window`** → 父窗口的 `onUp` 永不触发 → `mousemove` 监听器一直挂着 → 聊天框持续跟随鼠标移动，直到用户在父文档上再点一次（第二次 mousedown+mouseup 才让 `onUp` 跑）→ 表现为**"点一下进入拖拽、再点一下退出"**。
  - **为什么只在特定场景复现**：家长端 `Dashboard` 中间不是 iframe（`Dashboard.tsx:226` 同用手柄），松手在父文档上 `mouseup` 正常触发 → 表现为正常按住拖拽；**孩子端 `Learn` 中间是 iframe**，拖宽时极易在 iframe 上松手 → 必现"卡住/点二下"的 bug。这与用户"右侧聊天框宽度调整"的体感一致（孩子端右聊）。
  - **附带副作用**：`onUp` 不执行还会让 `document.body.style.cursor="col-resize"` / `userSelect="none"` 一直残留，光标与选中状态也被卡住。
- **改造方向**：
  ① **首选：Pointer Events + setPointerCapture**（最小且彻底）：手柄改用 `onPointerDown`/`onPointerMove`/`onPointerUp`，在 `onPointerDown` 调 `e.currentTarget.setPointerCapture(e.pointerId)`；之后 `pointermove`/`pointerup` 直接绑在**手柄元素自身**（捕获后即使指针移到 iframe 上方，事件也路由回手柄）。`onPointerUp` 里 `releasePointerCapture` + 移除监听 + 还原 cursor/userSelect。**彻底解决 iframe 吞事件**，无需改布局。
  ② **备选：拖拽时盖透明遮罩**：`onMouseDown` 时在 body 加 `position:fixed; inset:0; z-index` 的全屏透明层（盖在 iframe 之上），让 `mouseup` 落在父文档、再移除遮罩——可行但多一次 DOM 操作。
  ③ **备选：拖拽中禁 iframe 指针事件**：`onMouseDown` 给 body 加 class 使 `.materials-iframe { pointer-events:none }`，松手移除——同样让 mouse 穿透到父文档。
  ④ **保持现有持久化/范围**：`useChatPanel.ts` 是家长/孩子共用 hook（`Dashboard`/`Learn` 都走它），改造在 hook 内一次完成、两端同时修复；`width` 持久化（localStorage `chat:${key}:width`）与折叠逻辑不变。
  ⑤ **回归**：`chat.width` 拖拽实时生效 + 刷新保留（useChatPanel）、`chat.collapsed` 折叠（Learn.tsx:1003 / Dashboard）、ISSUE-023 字号变量、聊天区占满（ISSUE-008/016 的 `panelCollapsed` flex 逻辑）不受影响；重点测**孩子端往左拖到资料 iframe 上方松手**应能干净停住。
- **优先级**：已完成（2026-08-31 实施：方案① Pointer Events + setPointerCapture——`useChatPanel.ts` `startDrag` 参数改 `React.PointerEvent`，`onPointerDown` 时 `setPointerCapture(e.pointerId)`，`pointermove/pointerup/pointercancel` 绑到手柄元素自身（捕获后即使指针移入 iframe，事件仍路由回手柄，松手即停、彻底解决 iframe 吞 mouseup）；`releasePointerCapture` + 还原 cursor/userSelect；捕获失败 fallback window 级监听；`Learn.tsx`/`Dashboard.tsx` 手柄 `onMouseDown`→`onPointerDown`；`.chat-resize-handle` 加 `touch-action:none`（触屏可拖）。tsc 0 业务错误、build 通过）
- **记录时间**：2026-08-31

## [ISSUE-025] 孩子 Todolist：家长/孩子/agent 共建，定时生成+统计，边栏弹框查看，家长规定项不可改

- **类型**：Feature（孩子端 Todolist + 服务端自规划存储 + agent 工具 + 定时生成/统计）
- **描述**：给孩子建 Todolist。来源两类——① **家长规定**：来自孩子各学习主题的「学习规则」（家长在课程管理填写的 `rules_json.daily` 等）；② **孩子自规划**：孩子自己规划的事，存服务端。todolist 用 **markdown 表示**，agent 持有一个**读写该 markdown 的工具**，可创建/更新。每天设**生成时间点**与**统计时间点**，由孩子 agent 定时生成与更新完成度；孩子在对话中也可要求修改 todolist。**约束：家长规定的 todo 项不可被孩子或 agent 修改**（在 agent 提示词里约定）。孩子端左侧边栏加 Todolist 按钮，点开弹框显示「今天的 todolist」。**每天把 todolist 完成情况（完成数/总数、完成率、家长项 vs 自规划项拆分）记录下来，让孩子能看到自己「每天执行计划的能力」与一段时期的趋势。**
- **现状 / 已有可复用机制（已查证代码）**：
  - **边栏入口范式**：`Learn.tsx` 左侧 `sidebar-menu`（`:1031`）已有 Settings / 退出等按钮；`SidebarClassSchedule` 组件（`:183` 实时时钟 + 当天课程段）是「拉取配置/数据 → 渲染侧栏区块」的现成模板。Todolist 按钮 + 弹框可直接加在此处。
  - **家长学习规则数据**：各 topic 的 `rules_json`（`parent-library.ts:134/292-329`，含 `daily`/`type` 字段；`pi-session.ts:161` 文档说明 `rules_json` 含「daily 每日目标 / type 必学|选学」）。agent 可通过 `kb_query`（topic scope）取到这些规则——即「家长规定 todo」的自动来源。
  - **agent 工具范式**：`custom-tools.ts` 用 `defineTool({ name, description, parameters, execute })`（如 `display_content`/`kb_update`），工具名须同时进 `createAgentSession({ tools })` 白名单。新增 `todo_list` 工具（read 取当天 markdown / update 写 markdown）即可，对话内与定时任务都能调。
  - **定时触发范式**：`scheduler.ts` 每分钟 `cron` tick（`:395`），按 childId 配置 `cc` 触发——`recording.times[]`（`:411`）、`classTimes[]`（`:450`，起止跳变 + `lastKey` 防重）、`autoNewSession`。**定时 agent 任务**走 `daily-summary.ts` 的 `createEphemeralSession`（纯定时、无 AGENTS 上下文，见 memory：recording=纯定时任务）——todolist 的生成/统计可直接复用这套「到点 fire 一个 ephemeral agent 任务」的模式。
  - **服务端存储范式**：`server/src/routes/` 用 node:sqlite（`children.ts`/`db.ts` 等），孩子自规划内容应新增 `server/src/routes/todo.ts` + 表（如 `child_todos(child_id, date, items_json)`），符合 SPLIT「服务端为数据真源、多设备共享」约定（见 memory 服务端部署边界）。
- **改造方向**：
  ① **数据模型**：`SchedulerChildConfig`（`scheduler.ts:18-40`）增 `todo: { genTime: string; statTime: string }`（或 genTimes[]）。新增服务端 `todo.ts` 路由 + `child_todos` 表存「孩子自规划项」（按 child_id+date）。家长规定项来自 topic `rules_json`，不落孩子自规划表。
  ② **agent 工具 `todo_list`**（`custom-tools.ts`）：`read(date?)` 返回当天 markdown；`update(markdown, date?)` 写 `learning/todolist/{date}.md`（或 kb 条目，与现有 `kb.sqlite` 学习数据一致）。markdown 用 checkbox 语法 `- [ ] / - [x]` 表达完成度。
  ③ **定时生成/统计**（`scheduler.ts` tick + `daily-summary.ts` ephemeral）：到 `genTime` → fire ephemeral agent 任务，融合「topic rules（家长规定，标 [家长] 不可改）」+「服务端 child_todos 自规划项」+「过往未完成」生成当天 todolist markdown；到 `statTime` → fire 任务，agent 依据当天会话/进度判断各项完成度、把 `- [ ]` 改 `- [x]` 并写回（仅更新孩子自规划 + 完成标记，家长规定项正文不动），**同时把当天完成情况（完成数/总数、完成率、家长项与自规划项各自完成率）落库到 `child_todo_stats` 表（按 child_id+date 唯一），供历史与趋势查询**。
  ④ **孩子对话内修改**：`todo_list` 工具对**对话内**请求开放更新——但 agent 提示词约定：**家长规定项（源自 topic rules、带 [家长] 标记）只可划掉完成、不可删改内容**；孩子自规划项可增删改。
  ⑤ **边栏弹框**（`Learn.tsx`）：`sidebar-menu` 加 Todolist 按钮（图标 `ListTodo`），`useState(todoOpen)` + 弹框组件；打开时通过 IPC（→ 本地 `learning/todolist/{today}.md` 或服务端 `todo` 路由）拉取当天 markdown 并渲染（markdown 预览，参考 `.bubble-md-child`/`.markdown-body` 渲染）。
  ⑥ **提示词约定**（`pi-session.ts` `LEARNING_NAV_INSTRUCTIONS` / `buildChildPrompt`）：明确「todolist 中 [家长] 前缀项来自学习规则、不可删除或修改其文字，只能标记完成；其余项孩子可自行规划与调整」。
  ⑦ **回归**：ISSUE-019 横幅/铃声、边栏折叠（ISSUE-016）、字号（ISSUE-023）、iframe 拖拽（ISSUE-024）不受影响；定时任务与 recording/课程提醒互不干扰（各自 `lastKey`/防重）。
  ⑧ **每日完成记录 + 执行能力可视化**（`child_todo_stats` 表 + 边栏弹框新标签页）：
     - **落库**：在 ③ 的 statTime 任务里，除写回 markdown 外，另算「当天完成率 = 完成数/总数」「家长项规定完成率」「自规划项完成率」「连续达标天数」等，写入 `child_todo_stats(child_id, date, total, done, parent_done, self_done, rate, ...)`，每天一条（upsert）。
     - **孩子可见**：Todolist 弹框内加「📊 我的执行力」标签页（或顶部小卡片），展示——今日完成率 + 近 7/30 天完成率趋势（小柱状/折线，低龄友好可用 emoji 进度条）+ 连续达标天数 + 家长项 vs 自规划项对比。让孩子直观了解「自己每天执行计划的能力」与一段时期的进步。
     - **数据接口**：服务端 `todo.ts` 增 `GET /todo/stats?childId&range=7|30` 返回每日汇总数组；`Learn.tsx` 弹框经 IPC 拉取后渲染。统计只读不写，不影响 ②③④ 的写入链。
     - **注意**：完成率计算口径需在 agent 提示词或工具里统一约定（以 `- [x]` 判定完成），避免 markdown 与 stats 表不一致。
- **优先级**：已完成（2026-08-31 实施完毕，见下）
- **实施记录（2026-08-31）**：
  - **服务端**（`server/src/db/kb.ts` + `server/src/routes/db.ts`）：新增 `child_todos(date, items_md, updated)` 与 `child_todo_stats(date, total, done, parent_total, parent_done, self_total, self_done, rate, streak, updated)` 表（CREATE IF NOT EXISTS 自动迁移）；RPC handler `kb.todo.get` / `kb.todo.stats.list`（query）+ `kb.todo.put` / `kb.todo.stats.upsert`（exec），自动走 requireChildId + assertChildOwned。
  - **agent 工具**（`electron/lib/custom-tools.ts`）：`todoLocalDate`（本地日期，不用 toISOString）、`countTodoTasks`（确定性数 checkbox：total/done/parentTotal/parentDone/selfTotal/selfDone，`[家长]` 标记判定）、`todo_list` 工具（action=read/update，read 无数据返回「还没有 todolist」；update 需完整 markdown，返回计数汇总）。
  - **提示词约定**（`electron/lib/pi-session.ts` `LEARNING_NAV_INSTRUCTIONS` 新增「### 今日计划（Todolist，ISSUE-025）」）：`todo_list` 是唯一合法工具；`[家长]` 项绝不能删改文字、只能 `[ ]`→`[x]`；自规划项可增删；先 read 再 update、不得凭空重写。child session tools 白名单 + customTools 数组均加了 `todo_list`/`todoListTool`。
  - **定时任务**（`electron/lib/todo-scheduler.ts` 新建 + `electron/lib/scheduler.ts` 接入）：`runTodoGen`（家长项基线=孩子 kb topics.rules_json 的 daily/type → buildParentLines；+ 今天已有自规划项 + 昨日未完成项，ephemeral agent 融合写回）；`runTodoStat`（当天无 todolist 跳过；agent 依据当天会话+进度打勾写回 → 主进程 `saveTodoStats` 确定性解析落库，streak 逻辑：今天 ≥80% 且昨天达标 → +1，否则 1；不达标 → 0）；`scheduler.ts` 新增 `todo: { enabled, genTime, statTime }` 配置（默认关闭 08:00/21:00）、TaskState `todo.lastRun`（getChildState 自动补齐）、tick 分支 + `runCatchUp` 分支（两个时间点各自按本地日期+hhmm 去重）。
  - **家长端 UI**（`src/components/SchedulerSettings.tsx`）：每个孩子卡片新增「📋 今日计划（Todolist）」区块——开关 + 生成时间 + 统计时间（time input），旧配置无 todo 字段自动兜底默认值。
  - **孩子端 UI**（`src/components/TodoModal.tsx` 新建 + `src/pages/Learn.tsx`）：边栏 `sidebar-menu` 加「今日计划」按钮（ClipboardList 图标）；弹框两个标签页——「今日计划」只读渲染 checkbox 列表（[家长] 项橙色「家长安排」标签 + 完成划线 + 完成率/连续达标脚注）、「我的执行力」近 30 天柱状趋势 + 连续达标/历史最高/最近完成率卡片 + 家长项 vs 自规划项对比条。数据经新 IPC `todo:get` / `todo:stats:list`（`electron/lib/ipc-handlers.ts` + `preload.ts`）读服务端。
  - **验证**：`tsc --noEmit` 无新增错误（仅 5 条已知环境告警）；`npm run build` 通过；vitest 新增 `test/todo-scheduler.test.ts`（countTodoTasks 4 例）+ 更新 `test/scheduler-task-state.test.ts`（todo 键兼容，3 例）全部通过。
- **需求决策（2026-08-31 用户拍板，实施以此为准）**：
  1. **存储**：todolist markdown **全文存服务端** `child_todos` 表（child_id+date 唯一；含 items_md 与完成标记），本地仅展示缓存——符合 SPLIT「服务端数据真源、多设备共享」。
  2. **家长规定项范围**：该孩子**全部已分配主题**都生成——设了 daily 的生成「[家长] 主题名：今天学 X 课」；type=必学但未设 daily 的生成「[家长] 必学：主题名」；完全没设规则的主题不生成。数据源=**孩子 kb** `topics.rules_json`（分配主题时经 `parentSetChildTopicDaily` 写入，ChildTopicsModal；⚠️ 家长库 topics.rules_json 目前全空，勿从家长库取）。
  3. **定时配置**：家长在「设置→定时任务」按孩子配置 `todo: { enabled, genTime, statTime }`，**默认关闭**，默认值 08:00 生成 / 21:00 统计。
  4. **完成判定**：**仅 agent 自动**——统计点 agent 依据当天会话/学习记录判定打 `[x]`，弹框**只读展示、无手动勾选**；完成率口径以 `- [x]` 为准。
- **记录时间**：2026-08-31

## [ISSUE-026] 孩子左侧边栏常驻折叠，所有交互统一改为点击 icon 弹框（不再内联展开）

- **类型**：UX / 交互重构（仅孩子端 `Learn.tsx` 左侧边栏；家长端 `Dashboard` 边栏不在范围）
- **描述**：孩子端左侧边栏**始终保持折叠（图标栏）状态**，不再提供「展开成宽侧栏」的能力；点击任意功能 icon，**统一用弹框（modal/popup）承载该功能的完整交互**，而不是把整个侧栏内联撑开。即把当前「折叠→点 icon→整栏展开」的交互，收敛为「折叠图标栏→点 icon→弹框」——与现有 Todolist/AI 设置/修改密码按钮已用的弹框模式一致。
- **现状 / 根因（已查证代码 `src/pages/Learn.tsx`）**：
  - **折叠状态可切换**：`sidebarCollapsed` state（`:277`），`sidebar-toggle` 按钮（`:878-884`，`PanelLeftOpen`/`PanelLeftClose`）`onClick` 翻转；折叠时 `learn-sidebar` 加 `collapsed` 类（`:877`）。
  - **折叠态下，各功能 icon 点击 = 整栏内联展开**（这正是要改掉的）：
    - 模型（`:948-966`）：折叠态 `sidebar-icon-btn`（`Bot` 图标）`onClick={() => setSidebarCollapsed(false)}`（`:953`）→ 整栏展开后显示 `ModelSelector`。
    - 朗读语速（`:968-994`）：折叠态图标（`:973`）`setSidebarCollapsed(false)` → 展开显示 `rate-grid` 按钮组。
    - 聊天字号（`:996-1023`）：折叠态图标（`:1002`）`setSidebarCollapsed(false)` → 展开显示字号档位。
    - 今日课程（`:1025-1032`）：`SidebarClassSchedule` 收 `collapsed` + `onExpand={() => setSidebarCollapsed(false)}`（`:1030`），折叠态点图标→整栏展开看完整课表。
  - **切换展示页**用浮层 popover（`:899-946`，`view-switcher-popover`）——也是「内联展开」的一种，应一并改为弹框。
  - **已经是弹框的（目标范式，证明可行）**：`sidebar-menu`（`:1034-1065`）的「今日计划」(`setShowTodo(true)`)、「AI 伙伴设置」(`setShowAiSettings(true)`)、「修改密码」(`setShowChangePassword(true)`) 三个按钮——点 icon 直接开弹框，侧栏不展开。本项目已有成熟的弹框包裹（AI 设置 / 修改密码 / `TodoModal`），本次只需把前四类（模型/语速/字号/课程/展示页）也改成同范式。
  - **关键约束（勿踩）**：`ModelSelector` 必须**常驻挂载**（`:958` 注释：折叠时仅 CSS `display:none` 隐藏，避免卸载重挂导致重置回默认模型）。改弹框后，弹框里放 `ModelSelector` 时**仍需保持挂载**（如弹框常驻隐藏实例、或 ModelSelector 在 Learn 顶层常挂、弹框内只显示其容器），否则选中的模型会丢。
- **改造方向**：
  ① **常驻折叠**：`sidebarCollapsed` 默认置 `true`（`:277`），并**移除「展开」入口**——删 `sidebar-toggle` 的翻转折叠按钮（或其只保留「收起态」语义、不再展开）；`Learn` 全量去掉 `setSidebarCollapsed(false)` 的调用（`:953/973/1002/1030` 等）。侧栏成为固定图标栏。
  ② **功能 icon → 弹框**：为四类（模型 / 朗读语速 / 聊天字号 / 今日课程）各增一个弹框状态（如 `showModelModal` 等）+ 弹框组件（复用现有 Modal 包裹）：
     - 模型弹框内放 `ModelSelector`（**保持挂载**，见约束）；
     - 语速弹框内放 `rate-grid`（沿用现有档位按钮）；
     - 字号弹框内放 `FONT_OPTIONS` 档位（沿用 `handleFontSize`）；
     - 今日课程弹框内放完整 `SidebarClassSchedule`（去掉 `collapsed`/`onExpand` 的折叠分支，直接全量展示）；
     - 切换展示页 → 弹框版 `view-switcher`（去掉 popover 的 hover 缝隙逻辑，ISSUE-020 一并根治），点选项切换 `view`。
  ③ **图标栏只留 icon**：折叠态的 `sidebar-icon-btn`/`sidebar-btn` 全部改为「点击开对应弹框」，不再内联展开；`sidebar-profile` 折叠态仅显示头像（`:886-897` 现状已如此，保留）。
  ④ **样式收敛**：`styles.css` 巩固 `.learn-sidebar.collapsed` 固定宽度（如 56px），删/停用展开态的 inline 布局依赖；新增各弹框样式复用现有 modal class。
  ⑤ **回归**：ISSUE-025 的 TodoModal（`:1038` 已在 menu）、AI 设置 / 修改密码弹框不受影响；ISSUE-016 折叠、ISSUE-019 横幅、ISSUE-023 字号变量（弹框内字号调节仍生效）、ISSUE-024 拖拽、iframe 资料区均不受影响；重点测「点模型/语速/字号/课程/展示页 icon 均弹出对应框、且模型选择不丢」。
- **优先级**：已完成（2026-09-01 实施：`Learn.tsx` 边栏常驻折叠——删 `sidebarCollapsed` state 与 `sidebar-toggle` 展开按钮，`learn-sidebar` 恒 `collapsed`（64px 图标栏）；模型/朗读语速/聊天字号/今日课程/切换展示页 5 类交互全部改为 icon 按钮 + 弹框（新增 `showModel/showRate/showFont/showClass/showView` state，`sidebar-actions` 图标栏容器）；`SidebarClassSchedule` 去掉 collapsed/onExpand 改全量渲染；view-switcher popover 逻辑整体移除（viewMenuOpen/ref/timer/click-outside 全删，ISSUE-020 的缝隙问题不再存在）；**模型弹框常驻挂载**（overlay `display` 控制显隐，`ModelSelector` 不卸载，避免重挂拉模型切回默认）；弹框复用现有 modal/rate-grid/view-option 样式 + 新增 `.sidebar-actions`/`.view-options-modal`。tsc 0 业务错误、build 通过）
- **记录时间**：2026-08-31

## [ISSUE-027] 学习考核（全主观题语音作答 + 客户端出卷/判分 + 服务端存储 + v3 选课 LLM）——需求文档 `EXAM-REQUIREMENTS.md`，2026-09-01 实施完成
- **🎯 v2 演进（同日完成，EXAM-REQUIREMENTS §14 取代初版「按主题 assess_method 周期」）**：固定考核（每天/每周/每月/半年/年末多档并存，同日多档去重只考周期最长档）+ 自定义考核（家长对话 `exam_schedule_create` 生成排期，信息不全先确认）。核心 = `exam_schedules` 排期表（kind/scheduled_at/scope/status/attempt_id）；固定排期懒生成（60 天窗口）；选课算法 4 因子（复习到期/薄弱/久未考/新学）取前 N 门课、**每课完整出题**（去 8 题上限）；孩子端考核时间点列表（pending/started 可重试）替代选科目；家长端设置「学习考核」tab + 记录页排期查看/取消；`exam_attempts.schedule_id` 回填。验证：冒烟 18/18、每课完整出题 3 课 9 题、排期去重正确。
- **🎯 v3 演进（同日，EXAM-REQUIREMENTS §14.9 取代 v2 代码打分选课）**：**选课不用代码、给每个周期设置一个可编辑 prompt**（家长设置页「各周期选课规则」5 档 textarea + 恢复默认）。默认：每天/每周=周期内**所有**课程；每月=每主题**本月 50% + 本月前 25%**（数量=本月课数×25%）。**config 两段式**：`?schedule=X` → selectionPrompt（注入统计+候选清单）+ candidates（无 rubric）；`?schedule=X&courses=a,b` → 选中课程带 rubric + scoringPrompt。**周期归属标记（可靠性关键）**：服务端代码精确打标「★ 本周期/★ 本月/◐ 本月前」，LLM 按标记挑选不自己算日期（293 门长清单实测否则输出空）。候选口径含 status=✅ 已学无日期课（记「✅」归更早学习）。客户端 `selectCoursesForSchedule` 内存 session 选课（清理 LLM 复制的前缀 "[论语] "）+ 出卷改**逐课并发出题**（并发 3）。空窗口=空考核不自动放宽。验证：冒烟 20/20、真实 LLM 293 门候选→精确选窗口内 1 门→rubric 6078 字→逐课 3 题覆盖。
- **🎯 v3.1 演进（9-02，EXAM-REQUIREMENTS §14.10 取代五档固定频率）**：固定考核**只留 每天/每周**标签管理（每档：启用开关 + prompt + 时间；每周可设**周几几点** weekly{weekday,time}）；**去掉月度/半年/年度固定档**（自定义考核灵活安排）；**自定义考核可建多个**，每个有自己的 **scope.prompt + 日期时间点**（带 prompt 的自定义走选课两段式，freq="custom" 不打周期标记；第二段 courses 参数须在 scope 分支内优先——曾因 scope 先返回拿不到 rubric）。家长端入口从「设置」迁到家长中心左侧边栏「🎯 学习考核」（ExamAdminPanel）。验证：冒烟 24/24、daily/weekly 按配置生成、自定义两段式。

- **类型**：需求 / 新功能（已完整落地，本条目为后续查找的索引）
- **描述**：孩子按家长设置的周期参加「学习考核」：系统自动挑该周期内学/复习过的知识点出**全主观口述题**，孩子**语音作答**（每题一段、可重录/转写回显/文字兜底/记录用时），提交后**离线判分**，产出评估报告（整体掌握度 + 逐题反馈 + 每课加强计划）。需求细节见根目录 `EXAM-REQUIREMENTS.md`（设计稿 `assets/exam-template.html`）。
- **架构（关键约定，勿偏离）**：
  - **存储全在服务端**（内容 `assess_method`/`assess_rubric` + 记录 `exam_attempts` + 语音大文件走 files 通道落服务端磁盘）；**计算在客户端**（出卷+判分用本地 LLM 独立内存 session，符合本 app「AI 在客户端跑」现状——Electron 持有 LLM key 本地推理）。
  - **判分 prompt 由服务端下发**（`server/src/routes/exam.ts` 的 `SCORING_PROMPT`）= 判分口径单一真源，保证可比不漂移；判分 session 仅内存进行、**只把最终结果写 server DB**。
  - 考试视图 = HTML 模板（`src/lib/exam-template.ts` 的 `buildExamHtml`），宿主 `<iframe sandbox="allow-scripts allow-modals allow-forms" allow="microphone" srcDoc=...>` 渲染；锁定（禁导航/资料/AI 提示）由 `ExamView.tsx` 全屏覆盖保证；**严格一次性**（提交前不落盘，关闭即作废）。
- **数据模型**：
  - 家长库 `parent.sqlite` v4 迁移：`topics.assess_method`（每科目考核方法说明：周期/对象/题量）、`courses.assess_rubric`（每课考核要点）。
  - 孩子库 `kb.sqlite` v7 迁移：`courses.exam_mastery`（考核掌握度，与引导 mastery 双轨）。
  - 服务端 `exam_attempts` 表：`per_question` / `course_mastery` / `reinforce_plan` 为 JSON 列。
- **关键文件（后续查找入口）**：
  - 客户端对接+待考核：`electron/lib/exam.ts`（getExamConfig / uploadExamVoice / submitExamAttempt / listExamAttempts / getExamCourseRecords / getExamAudioDataUrl / **getExamPending** / **parsePeriodDays**）
  - 出卷/判分引擎：`electron/lib/exam-engine.ts`（`generateExamQuestions(topicConfig, childId)` / `scoreExamAttempt(scoringPrompt, answers, childId)`，SessionManager.inMemory + noContextFiles/noSkills）
  - IPC/preload：`electron/lib/ipc-handlers.ts`（`exam:config/pending/submit/attempts/courseRecords/audio/generate/score`）、`electron/preload.ts`（exam* 系列）
  - 服务端：`server/src/routes/exam.ts`（config 下发/attempts 提交/列表/course-records 每课聚合 + exam_mastery 回写）、`server/src/db.ts`（exam_attempts 建表）、`server/src/index.ts`（registerExamRoutes）
  - 孩子端：`src/components/ExamView.tsx`（pick→exam→scoring→report）、`src/lib/exam-template.ts`（buildExamHtml 应用内模板）、`src/pages/Learn.tsx`（考核按钮 + **待考核红角标**）
  - 家长端：`src/components/TopicDetail.tsx`（「考核要点」tab：方法说明 + 每课 rubric 编辑器）、`src/components/ExamRecords.tsx`（每课程考核记录表 + ▶ 听原音，挂 `ChildDetailPage.tsx` 的「🎯 考核记录」tab）
  - agent 工具：`electron/lib/custom-tools.ts` `parent_content` 支持 `type="assessRubric"` 取课程考核要点
  - 测试/冒烟：`test/exam.test.ts`（parsePeriodDays 5 例 + extractJson 3 例）、`server/scripts/verify-exam-smoke.mjs`（config 下发/提交/列表/每课聚合/403，**10/10 通过**）
- **验证**：主 tsc 0 业务错误（仅 5 条已知环境告警）、server tsc 0 错、vitest 33 文件/302 例全绿、electron-vite build 通过、服务端冒烟 10/10。
- **⚠️ 已知注意点**：
  - **判分必须带 rubric**：`ExamAnswerIn.rubric` 由 ExamView 从 `examTopic.courses` 按 course 匹配 `assessRubric` 传入，否则 LLM 看不到家长写的要点（2026-09-01 修复，勿再漏）。
  - 出卷/判分 session 目录按 childId 隔离（`getChildDir(childId||"default")`，2026-09-01 修复多孩子硬编码）。
  - 判分 prompt 涉及"按今天推算日期"必须注入具体日期（服务端 `buildScoringPrompt()` 替换 `{{TODAY}}`，2026-09-01 修复——否则 LLM 产出 2025-03-24 错误年份）。
  - 出卷已微调为**优先采用 rubric「考核内容」里的现成题目**（选择题去掉选项改口述，见 `exam-engine.ts` 出卷 prompt；配合 lunyu_exam 合并 md 导入的 rubric 使用）。
  - **createAgentSession 必须解构 `{ session }`**（exam-engine 曾直接当返回值用 → `dispose is not a function` 崩，2026-09-01 修复；daily-summary 同款写法）。
  - 服务端冒烟跑法（8899 + `SERVER_DATA_DIR` 指定临时数据目录 + run_in_background 起进程 + 每次清库重跑），详见 `2026-09-01.md` 日志。
  - 待考核提醒 = `exam:pending` IPC + Learn.tsx 考核按钮红角标（科目数），失败静默不打断学习。
- **2026-09-01 真实数据实测**（lunyu_exam 489 章）：`scripts/merge-lunyu-exam.mjs`（md+json 容错合并，461 章完整+28 降级）→ `scripts/import-lunyu-exam.mjs`（家长库 assess_rubric 489/489 + assess_method + 闻闻已学标记）→ 本机 8788 升级 v0.3.0（exam 路由+迁移）→ 出卷（LLM 按 rubric 出生活场景口述题）/判分（答对 4 分 vs 答错 0 分，评语带 rubric 锚定）/提交写库/course-records 聚合/exam_mastery='薄弱' 回写**全通**。
- **优先级**：已完成（2026-09-01 实施 + 全链路验证 + lunyu_exam 真实数据实测；设计文档 `EXAM-REQUIREMENTS.md` 与模板设计稿 `assets/exam-template.html` 于 2026-08-31 产出）
- **记录时间**：2026-09-01

## [ISSUE-028] 服务端增加 agent 功能：会话同步上云 + 无头 worker + 家长对话回顾（方案B）

- **类型**：架构 / 需求（2026-08-31 讨论定方向，2026-09-01 归档记录）
- **描述**：
  - 背景需求两个：① 定时任务需要 agent 自主运行，但客户端设备可能关机/休眠 → 漏跑（recording/todo 原在主进程 node-cron，runCatchUp 不回溯历史）；② 家长需要查看孩子与 agent 的完整对话过程（原会话 jsonl 只落客户端本地，家长端无通道）。
  - 结论：完整交互 agent **留在客户端**；只把三件搬上 learning-server（:8788）：**会话 jsonl 增量同步上云** + **服务端无头 worker**（ephemeral agent 跑 recording/todo 及未来自主任务）+ **家长完整逐字稿回顾**。已确认 pi-web（兄弟目录中间产物）为淘汰方案、不作为可复用资产；learning-server 原零 agent 代码。
- **现状 / 排查入口**：
  - 会话同步（阶段①）：
    - 客户端 `electron/lib/session-sync.ts`（新增）：游标 `data/children/<id>/.pi/sync-state.json`（files:[name]:{syncedBytes,lineCount}），Buffer 字节偏移切片增量，**服务端 ack 才推进游标**（离线/失败天然安全，无需持久队列）；触发 = 每轮对话后（`ipc-handlers.ts` pi:prompt 挂钩）+ 5min 定时 + before-quit flush。
    - 服务端 `server/src/routes/sessions.ts` + `server/src/db/sessions.ts`（新增）：`POST /api/v1/sessions/:childId/sync`（幂等 append，session_files 表存同步游标，session_messages 按 (child_id,file,line_index) INSERT OR REPLACE，**客户端权威**）；`GET /api/v1/sessions/:childId/dates`；`GET /api/v1/sessions/:childId?date=YYYY-MM-DD`（完整逐字稿，剔除 thinking，assistant 附工具调用）。表：`session_messages / session_files / worker_state`（`server/src/db.ts` schema v7）。
    - 家长端：`src/components/SessionReview.tsx`（新增，「💬 对话回顾」tab 挂 `ChildDetailPage.tsx`）+ IPC `sessions:reviewDates/reviewMessages`（`ipc-handlers.ts`）+ `electron/preload.ts`。
  - 无头 worker（阶段②/④）：
    - `server/src/worker/`（新增）：`providers.ts`（平移客户端 provider 配置）、`runtime.ts`（ModelRuntime.create 按家长临时 auth 文件注入，模型优先 app_settings.defaultModel，兜底 qwen-tokenplan/deepseek-v4-flash-0731）、`kb-tools.ts`（kb 三件套/todo_list/get_date 直调 `routes/db.ts` 导出的 queryHandlers/execHandlers，**不重复实现 SQL**）、`tasks.ts`（**WorkerTask 注册机制**：type/points(cfg)/catchUp/run；recording+todo 首批，未来「孩子不在场自主任务」registerTask 即可）、`scheduler.ts`（cron 每分钟 + worker_state 去重 + **启动补跑 runWorkerCatchUp**，catchUp: latest=recording 只补最近过期点 / all=todo 按序补 gen+stat）、`recording-prompt.ts`（与客户端同源副本）。
    - 数据源全服务端：当天对话读镜像 `data/sessions/`（`db/sessions.ts` readServerDailyConversation），kb 直读写服务端 DB，**不依赖客户端存活**。
  - apiKey 安全（任务5）：`server/src/crypto.ts`（新增，AES-256-GCM，密钥 SERVER_SECRET env 或首启生成 `dataDir/.secret`）；`routes/config.ts` settings 键 `auth` 加密落盘 + `GET /config` 解密回环（客户端 config-sync 会拉 auth 合并回本地，**不能过滤该键**——与计划偏差点）。
  - 双跑切换：`server/src/routes/version.ts`（0.2.0，`features: ["session_sync","worker"]`）；客户端 `electron/lib/server-features.ts`（新增，探测缓存）→ `electron/lib/scheduler.ts` 在 `hasServerFeature("worker")` 时跳过本地 recording/todo（含 runCatchUp），旧服务端无标志则保持本地调度不破坏现状。
  - 构建坑：`server/scripts/build.mjs` 增加 import_meta.url 垫片（esbuild CJS 打包 pi-coding-agent 后 `import_metaN.url` 为 undefined 启动即崩；构建后正则替换为 `require('url').pathToFileURL(__filename).href`，18 处）。另服务端 SDK 已固定精确版本 "0.84.1" 并适配严格类型（registry 重发布导致与客户端嵌套副本类型不同：reasoning 必填/samplingParams 移除/AgentToolResult.details 必填）。
- **关键文件清单（后续查找入口）**：
  - 客户端：`electron/lib/session-sync.ts`、`electron/lib/server-features.ts`、`src/components/SessionReview.tsx`（新增）；`ipc-handlers.ts`（sync 钩子 + sessions:review*）、`scheduler.ts`（worker 接管跳过）、`main.ts`（定时/探测启动）、`preload.ts`（sessionReview*）
  - 服务端：`server/src/routes/sessions.ts`、`server/src/db/sessions.ts`、`server/src/crypto.ts`、`server/src/worker/*`（providers/runtime/kb-tools/tasks/scheduler/recording-prompt）（新增）；`routes/db.ts`（导出 handlers）、`routes/config.ts`（auth 加密）、`routes/version.ts`（0.2.0+features）、`db.ts`（3 表）、`index.ts`（注册+启动 worker）、`scripts/build.mjs`（import_meta 垫片）
  - 验证脚本：`server/scripts/smoke-sessions.mjs`、`server/scripts/worker-catchup-check.mts`、`server/scripts/worker-tasks-check.mts`
- **验证**：server tsc 0 错；esbuild 单文件 15.7MB；冒烟全过（sync+幂等+回顾+加密回环+features）；补跑专项全过（latest/all/二次去重）；客户端 tsc 仅 5 条已知环境告警 + electron-vite build 通过；Linux pkg 产物 `server/dist/learning-server`（v0.2.0）打包成功。已提交 git `de2ef67`（28 文件 +4546 行）。
- **⚠️ 已知注意点 / 后续**：
  - **部署顺序**：先发客户端新版（含 server-features）再升服务端 0.2.0，否则老客户端本地 recording/todo 与服务端 worker 双跑（daily 重复/双倍 token）。
  - 真实 recording 冒烟需真实 apiKey（冒烟刻意未烧 token）。
  - 传输层仍 LAN HTTP 明文（完整保护需 HTTPS/RSA）；apiKey 目前仅静态加密。
  - 家长会话/父库未纳入同步；worker 只补「当天启动补跑」，服务端整日宕机错过时间点不回溯历史（影响极小）。
- **优先级**：已完成（2026-08-31 实施 + 全链路验证 + 提交 de2ef67；2026-09-01 归档记录）
- **记录时间**：2026-09-01

## [ISSUE-029] 英语学习模块（英语角）：专用英语 agent + 词汇感知/主题限定 + 每条语音发音评测 + 会话进 daily

- **类型**：需求 / 新功能（2026-08-31 讨论定需求，2026-09-01 起分阶段实施；本条目为模块总索引）
- **描述**：孩子学英语时切换到**专用英语 agent**（英文对话伙伴）：① 专用 system prompt——了解孩子已掌握词汇、沟通尽量用孩子懂的词、家长可设「当前主题/场景」限定对话范围防跑题；② 孩子用语音时**每条语音都做发音评测**、指出发音问题（前端评测卡 + agent 英文点评）；③ 英语会话内容**记录进 daily**、会话上云家长可回顾。
- **已确认分叉（用户 2026-08-31 拍板）**：
  1. 切换方式 = **显式入口**（孩子点「英语角」进入/退出，不做自动切换）
  2. 词汇基线 = **课程提取 + 家长补充**（从英语课程内容提取词表，家长可增减）
  3. 评测范围 = **自由对话全评**（英语角每条语音都评，ASR 文本回填 refText 自评分）
  4. 会话归属 = **上云可回顾**（session-sync 改递归，家长端可回顾英语对话）
- **需求/调研文档（后续查找入口）**：
  - 需求确认版：根目录 `ENGLISH-AGENT-REQUIREMENTS.md`（总体模型/会话形态/prompt 设计/词汇/评测/daily/上云/任务拆分/待定项）
  - 评测服务调研：`RESEARCH-pronunciation-assessment-2026-08-31.md`（腾讯智聆/阿里儿童/讯飞/Azure/开源对比）
- **✅ 已完成（2026-09-01 上午，任务 1：评测服务接入）**：
  - `electron/lib/assessment/`（仿 voice 模块）：`types.ts`（AssessmentResult 统一结构 score/accuracy/fluency/completeness/words[phones]）、`assessment-config.ts`（enabled/provider/providers，`shared/assessment-config.json`，打码/补丁复用 `voice-config.maskSecret`）、`providers/tencent-soe.ts`、`providers/aliyun-kid.ts`、`index.ts`（assessAudio 入口）
  - 智聆（**完整实现**）：`wss://soe.cloud.tencent.com/soe/api/<AppID>?参数&signature`；签名=除 signature 外参数**字典序**拼 `host/api/<appid>?k=v&...` 原文，SecretKey **HmacSha1→base64**；score_coeff=1.0（儿童最低苛刻度）/eval_mode=1（句子）/rec_mode=1/voice_format=1（wav）/16k_en；发送 wav 分片 1280B/40ms（1:1 实时率防报错）+ `{"type":"end"}` 结束帧；结果 `{code,result:"{...}",final:1}`（SuggestedScore/PronAccuracy/PronFluency/PronCompletion/Words[PhoneInfo]）
  - 阿里儿童 `en.word_kid.score`（**实验性，协议逆向还原**）：鉴权 `POST https://api.cloud.ssapi.cn:8080/auth/authorize`（request_sign=MD5("app_secret=&appid=&timestamp=&user_client_ip=&user_id=" 字典序拼接)）→ warrant_id → `wss://api.cloud.ssapi.cn` 发 connect（param.app{timestamp,applicationId,sig=MD5(appSecret+timestamp)}+param.sdk）/start（param.request{coreType,refText,rank}+param.audio{sampleRate:16000,channel:1,sampleBytes:2,audioType:"wav"}+param.app{userId}）/分片音频/`{"cmd":"stop"}`；返回 `{request_id,eof,params,refText,result{overall,details[{char,score,phone[{char,score,start,end}]}]}}`。⚠️ 技术方=声希科技，wss path 与包细节待真实密钥实测微调（aliyun-kid.ts 头部注释）
  - 链路：IPC `assessment:config:get/set` + `assessment:test`（录音评测固定 "hello"）、`electron/preload.ts`（assessmentConfigGet/Set/Test）、家长端「设置 → 发音评测」新 tab（`src/components/AssessmentSettings.tsx`，仿 VoiceSettings：启用开关 + 两服务卡片 + 字段 + 保存/默认/测试）
  - 测试：`test/assessment.test.ts` 9 例（配置打码/补丁跳过含 `*` 值/智聆签名自洽+字典序/双解析映射）；验证：tsc 0 业务错、vitest 全量 34 文件/311 例全绿、build 通过
- **⏳ 待办（任务 2-7，按 `ENGLISH-AGENT-REQUIREMENTS.md` §10 顺序）**：
  1. 英语会话骨架：`pi-session.ts` 新增 `getChildEnglishSession(childId)`（独立单例 + `sessions/english/` 独立子目录，照搬 parent-content 先例）+ `buildEnglishPrompt`（英文身份 + 词汇注入 + 主题限定）+ AGENTS 用户版按 `ref=<childId>-english` 存 agents.sqlite（家长可编辑）；工具精简（get_date/kb_query）
  2. 前端「英语角」入口（Learn.tsx 边栏）+ chat 路由切换（进入用英语 session、退出回主会话）+ IPC/preload 路由参数
  3. 英语角语音链路：录音 → ASR 与 `assessAudio` **并行**，ASR 文本回填 refText 自评分；评测卡 UI（总分+音素）+ 结果以 user 附注注入 agent 做英文点评
  4. 词表：课程词表提取 + 家长端编辑 UI + prompt 注入（第一版可先家长手填主题词表）
  5. `session-sync.ts` 扫描改**递归**（当前 `fs.readdirSync` 只扫根目录，英语会话子目录上云需改）
  6. daily 增强（可选）：RECORDING_PROMPT 加「英语口语练习」类别（当天评测均分/高频音素问题）
- **⚠️ 已知注意点**：
  - `readDailyConversation`（daily-summary.ts:47）**递归**扫 jsonl → 英语会话放 `sessions/english/` 子目录后**自动进 daily，零改动**；但 `session-sync.ts:63` 非递归 → 上云需改。
  - 英语 agent 不用 LEARNING_NAV_INSTRUCTIONS，`buildEnglishPrompt` 独立；主会话导航工具（display_content/page_action/todo_list）不挂英语会话。
  - 发音评测服务 key 在家长端配置（智聆 AppID/SecretId/SecretKey；阿里 AppKey/AppSecret）；阿里端**未实测**，首次需真实密钥验证。
- **优先级**：实施中（任务 1 已完成，任务 2-7 待实施；需求文档已闭环）
- **记录时间**：2026-09-01

## [ISSUE-030] 学习资料显示字号可调（孩子左侧边栏加「资料字号」按钮）

- **类型**：UX / 设置项（复用 ISSUE-023 聊天字号范式；仅孩子端 `Learn.tsx` + `MaterialsPanel.tsx` + `styles.css`）
- **描述**：在孩子的左侧边栏（图标栏）增加一个「资料字号」按钮，点击弹框提供字号档位（小/中/大/特大），用于调整**左侧展示的学习资料**的字体大小；按孩子持久化，跨刷新保留。与已实施的「聊天字号」(ISSUE-023) 并列，是同一范式在孩子端第二处字号入口。
- **现状 / 根因（已查证代码）**：
  - **现有字号设置只有聊天**：`Learn.tsx:28-35` `FONT_OPTIONS`/`DEFAULT_FONT_PX`、`:263` `showFont`、`:275` `fontSize`、`:278/:290` 按 `childId` 存 localStorage、`:896-902` 侧栏 `Type` 图标按钮、`:1160-1182` 弹框；经 CSS 变量 `--child-chat-font` 下传到 `.learn-chat`（`:1030`），仅作用于 `.bubble-md-child`。**学习资料目前无任何字号设置入口**。
  - **学习资料有三处字号表面，需分别处理**：
    1. **资料列表**（`MaterialsPanel.tsx:401-430` `.material-list`）：`.material-list-title` 16px(`styles.css:1052`)、`.material-list-count` 12px(`:1058`)、`.material-row-title` 16px(`:1105`)、`.material-row-time` 12px(`:1114`)——纯 CSS，改选择器即可。
    2. **markdown 资料正文**（`MaterialsPanel.tsx:387` `<div className="markdown-body">`）：全局 `.markdown-body` 字号——需作用域限定到资料容器（如 `.material-content .markdown-body`）再套 CSS 变量，避免影响家长端/聊天 markdown。
    3. **HTML 资料正文**（`MaterialsPanel.tsx:95` `<iframe srcDoc className="html-frame">`）：opaque origin，父页面 CSS **无法穿透**——必须经现有 `injectBridge`/`BRIDGE_SCRIPT` postMessage 通道（ISSUE-017 选词浮层同路）向 iframe 内注入 `font-size` 样式（与「不改资料 html」的约束一致）。
- **改造方向**：
  ① **侧栏加按钮**：紧邻聊天字号（`:903` 后）插入「资料字号」`sidebar-icon-btn`（如 `Type` 或 `TextSize` 图标）+ `showMatFont` state + 弹框（复制聊天字号弹框 `:1160`，复用 `FONT_OPTIONS`/`handleFontSize` 逻辑）。
  ② **状态 + 持久化**：新增 `matFontSize` state + 按 `childId` 存 localStorage（key 如 `chat:${childId}:matFontSize`，复用 `:278/:290` 模式），默认 16px（列表现状基准）。
  ③ **CSS 变量下传（列表 + markdown）**：在 `view==="materials"` 分支（`:995-1004`）给 `<MaterialsPanel>` 外层或组件内根节点设 `--material-font`；`.material-list-title/.material-row-title/.material-row-time/.material-list-count` 及资料 `.markdown-body`（作用域限定）改用 `var(--material-font, 16px)`。
  ④ **HTML 资料注入（iframe）**：经 bridge 把目标 font-size 下发给 iframe 内注入脚本（在 `BRIDGE_SCRIPT` 增 `kind:"fontSize"` 分支 + `MaterialsPanel` 收消息后 `postMessage` 下发）；脚本 `document.body.style.fontSize` 或注入 `<style>` 覆盖——复用 ISSUE-017 注入通道，资料 html 仍不改动。
  ⑤ **作用域隔离**：仅孩子端学习资料生效，家长端/聊天字号不受影响；低龄档位沿用 `FONT_OPTIONS`(22/30/38/46)。
- **⚠️ 回归**：ISSUE-023 聊天字号变量、ISSUE-026 边栏折叠/弹框、ISSUE-008/016 展示区折叠、iframe 选词(ISSUE-017)/拖拽(ISSUE-024)均不受影响；重点测「markdown 资料 + HTML 资料字号均随设置变化、刷新后保留、且不波及聊天字号」。
- **实施记录（2026-09-01）**：已落地，三处字号表面统一由 `--material-font` CSS 变量（Learn 层按 childId 存 localStorage `chat:${childId}:matFontSize`，默认 16px）驱动：
  ① 侧栏 `TextSelect` 图标按钮 + `showMatFont` 弹框（复用 `MAT_FONT_OPTIONS`/`rate-grid`，档位 16/22/30/38）；
  ② 列表（`.material-list-title/.material-list-count/.material-row-title/.material-row-time/.material-title`）改 `var(--material-font, <原px>)`；
  ③ 正文 markdown 作用域限定 `.content-panel .markdown-body, .content-panel .markdown-body *` 强制统一字号（不波及家长端/聊天 markdown）；
  ④ HTML 资料经 `page-bridge` 桥：初始字号由 `injectBridge(html, matFontPx)` 前置 `window.__PI_MAT_FONT` 注入、iframe 加载即套用；运行期变化由 MaterialsPanel 在 matFontSize 变更时 `postMessage({type:"page:mat-font",px})` 下发，桥脚本注入 `<style>`（`html,body,body * { font-size: Npx !important }`）——**不改资料 html 本体**；用 font-size（非 zoom）以免破坏查词浮层坐标。
- **优先级**：已实施（待回归验证）
- **记录时间**：2026-09-01

## [ISSUE-031] 查词浮层优化（拼音放大 + 多音字分行各有朗读 + 不显示意思）

- **类型**：UX / 交互优化（ISSUE-017 查词功能的增强；仅 `MaterialsPanel.tsx` + `styles.css`；字典 `dictionary.ts` 无需改）
- **描述**：优化孩子端学习资料「选中/双击中文 → 查词浮层」(ISSUE-017) 的展示：① **拼音字号放大**到与字同大（当前 14px、字 22px，太小看不清）；② **多音字的多个读音分行显示**，每个读音各有独立的 🔊 音频播放；③ **去掉释义**，浮层只显示读音（字 + 拼音）。
- **现状 / 根因（已查证代码）**：
  - 渲染在 `MaterialsPanel.tsx` `WordLookupOverlay`（`:111-159`）：每个 `LookupEntry` 渲染一个 `.word-lookup-item`（`:138-149`），内含 字(`.word-lookup-item-word`)、拼音(`.word-lookup-item-py`)、释义(`.word-lookup-item-meaning`)、一个朗读按钮（`onSpeak(en.text)`，`:142-149`）；`onSpeak` = `speakMaterialText`（`:408`）。
  - 字典 `LookupEntry.pinyin` = **空格分隔的多音**（dictionary.ts:19-20，如「行」→ "háng xíng"）；目前整串当一个 span 显示、只配一个朗读按钮（朗读的是 `en.text` 整字，TTS 会取默认音，无法区分多音）——不满足「每个读音各有朗读」。
  - 字号：`.word-lookup-item-word` 22px（styles.css:3178）、`.word-lookup-item-py` 14px（:3187）、`.word-lookup-item-meaning` 13px（:3193）——拼音显著小于字。
- **改造方向**：
  ① **拼音放大**：`.word-lookup-item-py` `font-size` 提至与字一致（22px，或直接 `var(--material-font, 22px)` 与 ISSUE-030 资料字号联动）；`.word-lookup-item-word` 维持 22px（或同变量）。
  ② **多音字分行 + 每音独立朗读**：渲染时把 `en.pinyin.split(/\s+/)` 拆成读音数组；每个读音单独一行（新样式如 `.word-lookup-reading`：拼音文本 + 独立 🔊 按钮）；按钮 `onSpeak` 传入**该读音的拼音串**（如 "háng"）以播对应音——⚠️ **音频源决策待确认**：TTS 直接读拼音字母串 vs 读该字在某词中的实际读音；建议先用拼音串 TTS，后续可加「载字的最小词」优化自然度；整字朗读按钮可保留也可去掉，以「每音一播」为准。
  ③ **去掉释义**：删除 `.word-lookup-item-meaning` 渲染（`MaterialsPanel.tsx:141`）及对应 CSS（styles.css:3193-3197）；浮层只留「字 + 分行拼音 + 每音朗读」。
  ④ **布局**：`.word-lookup-item` 改为「字在左/上，右侧或下方列出各读音行（每行拼音 + 🔊）」；保持 `align-items: baseline`、换行友好（`.word-lookup-item` 已是 flex + flex-wrap）。
- **⚠️ 回归**：ISSUE-017 的选中/双击捕获（page-bridge.ts:240-266）、lookup 上抛、click 关闭 grace（MaterialsPanel:263-277）、iframe 注入通道不受影响；仅浮层内部展示与朗读粒度变化；重点测「单音字正常、多音字分行各有 🔊、拼音清晰可读、无释义」。
- **优先级**：已实施（2026-09-01）
- **实施记录（2026-09-01）**：
  - `MaterialsPanel.tsx` `WordLookupOverlay`：删除 `.word-lookup-item-meaning` 渲染与释义；`en.pinyin.split(/\s+/).filter(Boolean)` 拆读音数组；每个读音一行（`.word-lookup-reading`：拼音 + 独立 🔊），`onSpeak(py)` 传该读音拼音串；无拼音时显示 `·` 占位；高度按条目/读音数动态估算避免溢出。
  - `styles.css`：`.word-lookup-item-word`/`.word-lookup-item-py` 字号改为 `var(--material-font, 22px)`（与 ISSUE-030 资料字号联动）；新增 `.word-lookup-readings`(纵向列)/`.word-lookup-reading`(拼音+按钮行)/`.word-lookup-py-none`；删除 `.word-lookup-item-meaning` 规则；朗读按钮改为 `flex:0 0 auto` 不再 `margin-left:auto`。
  - **音频源决策**：按 issue 建议先用「拼音串 TTS」（如 "háng"），后续可加「载字的最小词」优化自然度；整字朗读按钮已移除，以「每音一播」为准。
  - **二次优化（2026-09-01 22:5x）**：浮层头部新增「朗读选中文本」按钮（`word-lookup-play-all`，`onSpeak(state.text)`），播放**整段选中文本**（非单字/单音）；与每音朗读按钮区分（整段按钮在头部、逐音按钮在每行）。`MaterialsPanel.tsx` 头部加 `.word-lookup-head-actions`(flex 容器)+按钮；`styles.css` 加 `.word-lookup-head-actions`/`.word-lookup-play-all`。
  - **扩展到聊天框（2026-09-01 23:0x）**：把查词浮层抽成共享组件 `src/components/WordLookupOverlay.tsx`（导出 `LookupState` / `WordLookupOverlay`(forwardRef) / `useWordLookup` 选区捕获 hook）；`MaterialsPanel.tsx` 删本地副本改引用共享；`ChatWindow.tsx` 接入——`messagesRef` 容器内捕获中文选区 → `lookupText` → 浮层；新增 `speakText`(任意文本 edge-tts) 作 onSpeak；浮层渲染于 ChatWindow 根。灰盒：仅中文触发、点击外部/Esc 关闭、整段朗读可用。
  - 验证：`tsc --noEmit` 对 `MaterialsPanel.tsx`/`ChatWindow.tsx`/`WordLookupOverlay.tsx` 无业务错误（已过滤 @types/node26 环境告警）。
- **记录时间**：2026-09-01

## [ISSUE-032] 全链路加载态：登录 / 主页 / 内容未加载完都要显示「正在干什么」，加载完再显示页面

- **类型**：UX / 加载体验（防误判数据丢失；涉及 App.tsx / Home.tsx / Dashboard.tsx / ParentLogin.tsx + 新增统一 Loading 组件/样式）
- **描述**：在孩子端和家长端，凡是有异步加载的地方都必须有明确的「正在加载」提示，**且提示文案要说明正在干什么**（如「正在加载孩子列表…」「正在验证家长身份…」「正在进入学习…」），不得只显示笼统的「加载中…」。尤其「内容还没加载完时不能把页面当成已加载」——加载完成前要么整页显示加载门控、要么区块内显示占位，**绝不能**渲染空列表让用户误以为数据丢了。核心诉求：登录家长界面、打开主页、以及任何内容未加载完的环节，都要先给提示，加载完再显示真实页面。
- **现状 / 根因（已查证代码）**：
  - **① 主页孩子列表无 loading（最致命）**：`Home.tsx:33-34` `useEffect` 调 `childList().then(setChildren)`，但在 promise resolve 前 `children` 初始为 `[]`，页面**直接渲染空头像区**（`Home.tsx:98` `children.map` 不产出任何卡片）。**无 loading 状态、无占位提示**——当 `childList()` 走服务端网络较慢（云端/局域网波动）时，用户看到空主页，**以为孩子数据丢了**。更糟：`[]` 与「真·没有孩子」无法区分。
  - **② 家长中心孩子列表同样无 loading（用户明确点名）**：`Dashboard.tsx:36-38` `refresh()` 调 `childList()` 但**无 loading flag**，pending 期间 `children=[]` →「孩子列表（点击卡片进入详情）」区（`:163`）渲染为空 → 家长看到「孩子列表没有了」，以为数据丢失。这与用户原话完全对应。
  - **③ 登录→主页过渡断点**：`ParentLogin.tsx:53-68` 登录按钮已有 `loading`→「处理中…」，登录成功 `onLogin`→`App.tsx:44 setView("home")`→`Home` 挂载后又要等 `childList()`（见①）——**这中间主页渲染空列表**，是「登录家长界面时」体验断点真正所在。
  - **④ App 初始 authCheck 有提示但信息量低**：`App.tsx:22-32` `authCheck()` 异步期间 `view="loading"`→`加载中...`(`:37`)，**有**提示，但文案笼统、且只覆盖 authCheck，不覆盖后续 childList；故初始 OK、进入 home/dashboard 后的 childList 没被覆盖。
  - **⑤ 现有 loading 零散无统一机制**：`CourseDetail.tsx:109` / `LearningDashboard.tsx:179` 已有 `.placeholder`「⏳ 正在加载…」范式；`ChatWindow.tsx:653 historyLoading` 有「加载中…」；但 home/dashboard 的孩子列表**没复用**这套，且没有「整页门控」概念。spinner 样式 `.working-spinner`(styles.css:1953) 可复用。
- **改造方向**：
  ① **主页孩子列表门控（Home.tsx）**：新增 `childrenLoading` state，`useEffect` 置 `true`、`childList().then` 后 `false`。**pending 期间渲染占位「正在加载孩子列表…」（带 `.working-spinner`）而非空列表**；仅当 `!loading && list.length===0` 才显示「还没有添加孩子」（区分「未加载」与「真·空」）。
  ② **家长中心孩子列表门控（Dashboard.tsx）**：`refresh()` 加 `loading` flag，pending 期间「孩子列表」区显示「正在加载孩子列表…」占位，loaded 且空才显示「还没有添加孩子」——直接消除用户点名的「列表没了」误判。
  ③ **统一 Loading 组件（推荐，防重复造轮）**：新增轻量 `<LoadingBlock text="正在加载孩子列表…" />`（复用 `.working-spinner` + 文案，低龄友好），或区分两种语义：
     - **占位型**：列表/区块内联显示「正在加载…」留出骨架（用于 ①②）；
     - **整页门控型** `<PageLoading text="正在进入学习…" />`：loading 期间整页覆盖显示「正在干什么…」，加载完才渲染页面（对应「加载完了，再显示页面」）——可用于登录成功→home、或 childList 整页门控。
  ④ **文案要说明「正在干什么」**：所有提示文案具体化（「正在加载孩子列表…」「正在验证家长身份…」「正在进入学习…」），避免笼统「加载中」；与用户原话一致。
  ⑤ **登录过渡**：登录成功进入 home 后由 ① 的门控兜住（home 内部先加载完再显列表）；可选在 `App.tsx setView("home")` 前后加短暂「正在进入…」整页门控，但更干净的做法是 home 内部 gate。
  ⑥ **回归**：现有 `historyLoading`/`CourseDetail`/`LearningDashboard` 的 `.placeholder`/`ParentLogin`「处理中…」不破坏；spinner 复用 `.working-spinner`；`authCheck` 的「加载中…」可升级为更具体文案。
- **⚠️ 关键原则（用户强调）**：**「加载完再显示页面」**——任何异步数据未到位时，宁可整页门控或区块占位，也**不要**把空数组当成「无数据」渲染给用户，避免「孩子列表没了 / 数据丢了」的恐慌。
- **优先级**：已实施（2026-09-02）
- **实施记录（2026-09-02）**：
  - 新建 `src/components/Loading.tsx`：导出占位型 `LoadingBlock`（复用现有 `.working-spinner`）+ 整页门控型 `PageLoading`；`styles.css` 加 `.loading-block`/`.loading-text`/`.page-loading`/`.page-loading-text`/`.working-spinner-lg`/`.avatars-loading`（主页头像区加载占位，占满一行居中）。
  - `Home.tsx`：加 `childrenLoading` state，`useEffect` 置 `true`、`.finally` 置 `false`；pending 期间在头像区渲染 `LoadingBlock text="正在加载孩子列表…"` 占位，**绝不**渲染空头像区；仅 `!loading && empty` 才显示「还没有添加孩子，请联系家长添加」。
  - `Dashboard.tsx`：`refresh()` 加 `childrenLoading` flag（try/finally）；sidebar 孩子列表与 main `view==="children"` 区 pending 期间均显示「正在加载孩子列表…」占位，loaded 且空才显示原空提示——直接消除用户点名的「孩子列表没了」误判。
  - `App.tsx`：初始 `loading` 文案「加载中…」→「正在验证身份…」（更具体）。
  - 验证：`tsc --noEmit` 对 Home/Dashboard/App/Loading 无业务错误（已过滤 @types/node26 环境告警）。
- **记录时间**：2026-09-02

## [ISSUE-033] 灵活学习计划（家长对话制定 + 服务端监督执行 + 未完成叠加 + 上学/假期区分）

- **类型**：功能设计 / 新功能（替代现有「每主题每天学几课」死板模型；涉及服务端新增 study_plan 存储与执行 tick + 家长 agent 新工具 + 与 ISSUE-025 todolist / study-tracker 联动）
- **描述**：新增「学习计划」功能。场景：① **家长与孩子 agent 对话**完成计划制定（自然语言、足够灵活）；② 计划**存服务端**，由**服务端监督执行**；③ **未完成的计划项自动叠加（roll over）到下一周期/下一份计划**继续执行；④ **取代现有死板模型**——现有是「每个主题每天学几课」（`kb.topics.rules_json.daily` + `type`必学/选学，见 `parent-library.ts:541 setChildTopicDaily`、`ipc-handlers.ts:413`），太僵硬。新模型要支持：**单个课程安排学多少天**、**某一天可以学多个课程**、**无固定每日配额**；⑤ **区分「上学」与「假期」两套学习计划**（两套可切换/叠加）；⑥ 家长设置通过对话完成、由服务端执行。
- **现状 / 根因（已查证代码）**：
  - **现有计划模型 = 死板的「每主题每天 X 课」**：`setChildTopicDaily`(`parent-library.ts:541`) 把 `rules_json.daily`(如"3") / `type`(必学|选学) 写进孩子库 `kb.topics`；`todo-scheduler.ts:102-115` 据此把家长规定项渲染成「今天学 X 课」/「必学：XX」的 todo；`learning-summary.ts:155/262` 与 `study-tracker` 做每日达标评估。**它没有「课程级天粒度」「某天多课」「跨周期叠加」「上学/假期」任何概念**——正是用户嫌死板的根源。
  - **家长 agent 已有写入孩子 kb 的能力**：`custom-tools.ts` 的 `kb_query/kb_insert/kb_update`（带 `child_id` 参数，数据在 SPLIT 服务端 `kb.sqlite`）——家长 agent 可经对话改孩子知识库；**但缺少「学习计划」这一高层实体**，只有 topics.rules_json 这个粗糙载体。
  - **服务端无 study_plan 存储/执行**：`server/src/routes/*` 无 `study_plan` 相关表/路由（grep 命中仅 `parents.plan` 订阅档、exam `reinforcePlan` 复习计划，均非学习计划）；SPLIT 约定「服务端为数据真源、服务端监督」→ 学习计划必须新增服务端 `study_plans` 表 + 执行 tick。
  - **已有可复用执行链**：`todo-scheduler.ts`(ISSUE-025 实施的 genTime/statTime ephemeral agent) + `study-tracker`(每日达标评估) 已是把「家长规定」转成孩子每日 todo 并评估的机制——新学习计划应成为这份 todo 的**新数据源**，替换掉 `rules_json.daily` 的粗糙生成。
- **改造方向**：
  ① **数据模型（服务端新增 `study_plans` 表）**：字段建议 `id / child_id / mode('school'|'holiday') / period_start / period_end(或 open-ended) / items(JSON) / status / created_at / updated_at`；`items` 每项 = `{ topic, course?(单课或整主题), goal(如『学 N 天』/『某天学 A+B』), target_days?, done_days?, status('pending'|'done'|'rolled'), priority }`。支持「按课程排若干天」「某天多课」「无固定每日配额」三种粒度。
  ② **服务端监督执行 tick**：复用 `scheduler.ts` 每分钟 tick 骨架（同 `classTimes`/`recording.times`），新增 study-plan 检查：每日 genTime 把**未过期且未完成**的 plan items 展开成当天待办 → 喂给 `todo-scheduler` 生成孩子 todolist（**取代 `rules_json.daily` 生成逻辑**）；每日 statTime 由 agent 依据进度判定各 item 完成度、`done_days++`，**未达标项 status 保持 pending/置 rolled 进入下一周期**（叠加语义）。
  ③ **roll over（叠加）语义**：计划周期结束（period_end 或每日边界）时，仍 `pending` 的 item 不丢弃——自动 carry 到「下一周期计划」或延续执行（按 mode 选 school/holiday 当前生效那份）；在 todolist/进度里标注「📌 延续自上期」。
  ④ **家长对话制定工具**：新增家长 agent 工具 `study_plan_create/update`（或复用 kb 写入语义）把对话结果持久化到服务端 `study_plans`；家长说「论语先进篇学 5 天、假期每天加英语 2 课、周末不学数学」→ agent 解析成结构化 items 写入。提示词约定：家长规定项在 todolist 标 `[家长]` 不可改（同 ISSUE-025）。
  ⑤ **上学/假期切换**：家长可分别制定 school/holiday 两份；服务端按当前日期（是否在假期区间）自动选用生效那份（或叠加）；家长对话可指定「这是假期计划」。
  ⑥ **迁移/共存**：现有 `rules_json.daily` 可自动导入为首份默认 plan（或标记为 deprecated，新制定走 study_plans）；`todo-scheduler` 的 `rules.daily` 生成分支逐步由 study_plans 展开替代。
  ⑦ **回归**：ISSUE-025 todolist 渲染/统计、study-tracker 达标评估、topic rules 显示（`learning-summary.ts`）不破坏；服务端真源/多设备共享保持。
- **⚠️ 与 ISSUE-025 关系**：本 issue 的「学习计划」是 ISSUE-025「todolist」的**更灵活上游数据源**——todolist 由学习计划（替代 rules.daily）+ 孩子自规划 融合生成；两者共用服务端存储 + 每日 gen/stat tick。
- **优先级**：待定（本会话仅记录，未实施）
- **记录时间**：2026-09-02

## [ISSUE-029] 定时任务新模型：任务管理页（先创建任务 → 分配给孩子）+ 执行结果查询

- **类型**：需求 / 架构（2026-09-02 实施）
- **描述**：家长把定时任务从「设置」挪到家长中心左侧边栏独立页「⏰ 定时任务」，改为**先创建任务、再把任务分配给孩子**的两级模型，并用卡片展示；同时新增**定时任务执行结果查询**（每次执行 ok/skip/error + 信息）。目的：定时任务成为可复用模板（同一任务可分配给多个孩子），且家长能查看执行情况（服务端 worker 执行，设备关机/休眠不漏跑）。
- **现状 / 排查入口**：
  - 数据模型（server.sqlite，schema v8）：`scheduler_tasks`（任务定义：name/type/time/extra_json/enabled）、`scheduler_task_assignments`（task_id↔child_id，enabled）、`task_runs`（每次执行：status ok|skip|error + message + 起止时间）。`server/src/db/task-runs.ts`：recordTaskRun / findTaskForRun（按类型+时间点+孩子分配匹配任务）/ listTasksWithAssignments / buildEffectiveChildConfig / listTaskRuns。
  - 服务端路由 `server/src/routes/scheduler.ts`：GET|POST /scheduler/tasks、PATCH|DELETE /tasks/:id、POST /tasks/:id/assign、GET /scheduler/runs（childId/limit 过滤）、GET /scheduler/effective-config。`index.ts` 注册。
  - **执行链路不变**（关键设计）：任务+分配 → `effective-config`（每孩子 recording/todo/autoNewSession）→ 客户端合并 classTimes/archiveLimit 后仍走现有 `scheduler_config` 推送 → worker/客户端调度照旧。worker 每次执行（runTaskAtPoint）写 task_runs（`worker/scheduler.ts`），任务 run() 返回 {status:'ok'|'skip',message}（recording 无会话 skip、todo-stat 无 todolist skip）。
  - 前端：`src/components/SchedulerTasksPanel.tsx`（新增，家长中心 view="scheduler"：任务卡片 grid + 新建任务表单（类型/时间/名称/会话前总结）+ 分配孩子弹窗 + 执行结果表）；`src/pages/Dashboard.tsx` 边栏加「⏰ 定时任务」；`electron/lib/ipc-handlers.ts` + `electron/preload.ts` 加 scheduler:tasks:/task:/runs:/effective_config 系列 IPC。
  - 设置页收敛：`src/components/SchedulerSettings.tsx` 移除每孩子 recording/todo/autoNewSession 区块（保留 classTimes/archiveLimit/家长 autoNewSession/事件轮询），加「已移至定时任务」跳转提示。
- **验证**：server tsc 0 错；esbuild 单文件构建过；`scripts/smoke-sessions.mjs` 15 项全过（新增：创建→分配→effective-config→列表→结果查询→关停→删除）；worker 补跑回归过；客户端 tsc 仅 5 条已知环境告警 + electron-vite build 过。
- **⚠️ 已知注意点 / 后续**：
  - 任务类型目前 4 种：recording / todo_gen / todo_stat / auto_new_session（auto_new_session 为客户端行为，由 effective-config 驱动；worker 只执行 recording/todo）。
  - 老客户端（无任务模型）仍用旧 scheduler_config → 新服务端不强制迁移；新客户端打开定时任务页即自动把 effective-config 合入 scheduler_config（含未分配孩子自动关闭对应功能）。
  - 任务删除保留历史 task_runs（task_id 置空）。
- **优先级**：已完成（2026-09-02 实施 + 冒烟全过）
- **记录时间**：2026-09-02

## [ISSUE-034] 聊天气泡 markdown 渲染空行过多、消息被拉长（需紧凑化）

- **类型**：UI / CSS（聊天气泡内 agent 回复的 markdown 渲染后块级元素间距过大；涉及 `styles.css` 的 `.bubble-md` / `.bubble-md-child` / `.markdown-body` margin 规则）
- **描述**：消息框内 agent 回复的消息，在气泡里用 markdown 渲染后，**块级元素之间空行太多**（标题与列表之间、列表项之间、段落之间），导致整条消息被拉得很长。用户截图标注了多处红框空白区域（如「必学课」标题前、每个有序列表项之间、「复习课」标题前后等），要求**去掉这些多余空行，让消息更紧凑**。
- **现状 / 根因（已查证代码 + 截图对照）**：
  - **截图来源判断**：从字体大小看是**家长端聊天**（`.bubble-md`，基础字号 15px），非孩子端 30px 大字。孩子端 `.bubble-md-child` 在 ISSUE-009/023 已做过一轮「行距紧凑」但只改了 child 侧。
  - **家长端 `.bubble-md` 的 margin 值偏大**（`styles.css:1801-1837`）：
    - `h1-h6`: `margin: 14px 0 8px` —— **14px 上边距**，标题前有大段空白；
    - `ul, ol`: `margin: 4px 0 8px` —— 列表底部 8px；
    - `li`: `margin: 2px 0` —— 单项本身还行，但列表容器 margin 叠加后间距仍大。
  - **全局 `.markdown-body` 规则也叠加**（`styles.css:2548-2595`）：
    - `h1/h2`: `margin: 16px 0 8px` —— 比 `.bubble-md` 的 14px 还大（但 `.bubble-md` 选择器特异性更高应覆盖）；
    - `p`: `margin-bottom: 8px`；
    - `ul, ol`: `margin-bottom: 8px` + `padding-left: 24px`；
    - `blockquote`: `margin: 12px 0`；
    - `pre`: `margin: 12px 0` + `padding: 16px`。
  - **更关键的可能根因——空 `<p>` 标签**：LLM 输出的 markdown 常有连续空行（`\n\n\n` 或更多），经 markdown 渲染器转成**空的 `<p></p>` 或 `<p><br></p>`**，这些空标签虽无文字内容但有 `margin-bottom: 8px`（来自 `.bubble-md p` 或 `.markdown-body p`），叠加后形成截图中红框标注的大段空白。**这是最可能的「罪魁祸首」**——截图里红框位置往往正好在两个可见元素中间、且空白高度明显超过正常单倍 margin。
  - **已有「紧凑」先例但未覆盖家长端**：ISSUE-009/023 对 `.bubble-md-child`（孩子聊天）做了紧凑化（`p margin 0 0 4px`、`ul/ol margin 2px 0 4px`、`li margin 0`、`h1-h6 margin 10px 0 4px`），但 `.bubble-md`（家长聊天）**完全没做同样处理**，仍用原始宽松值。
- **改造方向**：
  1. **消除空标签空白（最优先，预计解决 80% 问题）**：给 `.bubble-md p:empty, .bubble-md p:has(> br:only-child)` 加 `margin: 0; padding: 0; height: 0; display: none;` —— 空段落不占任何空间。同时 `.markdown-body` 全局也加同样的空标签规则（防漏）。
  2. **收窄 `.bubble-md` 块级 margin（家长端对齐孩子端的紧凑值）**：
     - `h1-h6`: `14px 0 8px` → `8px 0 4px`（对标 `.bubble-md-child` 的 `10px 0 4px`）；
     - `ul, ol`: `4px 0 8px` → `2px 0 4px`；
     - `p`: `0 0 4px`（同 child）；
     - `li > ul, li > ol`: `2px 0` → `0`。
  3. **全局 `.markdown-body` 同步收窄**（影响资料面板等非聊天区域）：`h1/h2 margin-top` 从 16px 降到 10px、`p/ul/ol margin-bottom` 从 8px 降到 4px；或限定只在 `.bubble` 内生效避免波及资料面板。
  4. **⚠️ 不破坏孩子端 `.bubble-md-child` 已有的紧凑规则**（特异性更高不受影响）；资料面板 `.content-panel .markdown-body` 可保持原样（阅读场景适当宽松合理）。
- **优先级**：已实施（2026-09-02）
- **实施记录（2026-09-02）**：
  - **关键事实更正**：查证 `ChatWindow.tsx:728` 气泡容器为 `bubble bubble-md`（孩子端追加 `bubble-md-child`），**不带 `markdown-body` 类**，故全局 `.markdown-body` 规则根本不作用于气泡——原 issue「markdown-body 叠加」判断基于旧代码已不成立。因此只改 `.bubble-md` 即可，资料面板完全不受影响（契合「限定在 .bubble 内、不波及资料面板」）。
  - **（初版误判，非主因）空标签消除**：`.bubble-md p:empty, .bubble-md p:has(> br:only-child)` → `display:none`。这条对「连续空行产生空 `<p>`」有效，但**不是本次"大量空格"的主因**——闻闻最新两条消息实测用的是**单空行段落分隔（`\n\n`）**，根本不产生空 `<p>`，故该选择器对其完全无效；只起兜底作用。
  - **收窄 `.bubble-md` 块级 margin**（对齐孩子端紧凑值）：`h1-h6` `14px 0 8px`→`8px 0 4px`；`p` `0 0 8px`→`0 0 4px`；`ul,ol` `4px 0 8px`→`2px 0 4px`（padding 不变）；`li>ul,li>ol` `2px 0`→`0`。
  - 未动 `.markdown-body` / `.content-panel .markdown-body` / `.bubble-md-child`：资料面板阅读场景、孩子端既有紧凑规则均保留。
  - **⚠️ 二次修复（2026-09-02，真正根因）**：用 react-markdown 实测闻闻最新两条消息，确认 DOM 由 `<p>/<ol>/<hr>` 正常组成、无空 `<p>`——但渲染层 `.bubble-md` 的 `white-space: normal` 被 `.message .bubble` 的 `white-space: pre-wrap` **按特异性压死**（两者同为 0,2,0，但 `.message .bubble` 在前）。结果 markdown 文本里**每个 `\n` 都被当真实换行**，单空行 `\n\n` 直接变成一整行空白，叠加数次即"大量空格"。修法：把 `.bubble-md` 的 `normal` 改为 `.bubble.bubble-md`（0,2,0，靠后出现胜出）真正压过 `pre-wrap`；同时把 `.bubble-md hr` 的 `margin` 收紧到 `8px 0`（原 UA 默认 0.5em，孩子端 30px 大字下撑出 ~30px 空白）。用户气泡（仅 `bubble` 类）保留 `pre-wrap`，不受影响。
  - 验证：纯 CSS 改动，无 TS 影响；建议 dev 硬刷后回归（闻闻会话空行消失、消息明显变短）。
- **记录时间**：2026-09-02
