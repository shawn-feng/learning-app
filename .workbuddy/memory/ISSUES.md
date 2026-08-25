# 待解决问题清单 (Open Issues)

> 本文件用于记录待解决/待实现的问题，不在此处修改项目或展开讨论。

## [ISSUE-001] 语音朗读默认速度 0.7 → 1.0

- **类型**：功能调整 / TTS 体验
- **描述**：当前语音朗读（浏览器 Web Speech API，`SpeechSynthesisUtterance`）的默认语速为 `0.7`，需改为 `1.0`（正常语速）。
- **影响范围**（按设计记忆，待在实现时复核具体文件）：
  - IPA 音标学习页（以 `longman_cache.jsonl` 为音标源，phoneme 音频来自 emma 目录）
  - `grammar.html` 语法学习页
  - 练习页 `practice.html`（紫色主题，积极词汇按音节数分组）
- **实现要点**：
  - 找到设置 `utter.rate = 0.7`（或默认 rate）的位置，改为 `1.0`。
  - 注意 TTS 策略：优先 `en-GB` 英音，无英音降级美音；改的是默认语速，不影响音种选择逻辑。
  - 若页面多处复用同一朗读函数，确保统一改到默认常量，避免遗漏。
- **当前状态 / 备注**：
  - **已修复（2026-08-18）**。实际定位到本工作区（「学习伙伴」Electron 项目）内真正承载默认朗读语速的代码，均为 Edge TTS（非浏览器 Web Speech API），默认 `-30%` 即 0.7 倍速：
    - `electron/lib/voice/tts.ts` 第 13 行 `DEFAULT_RATE`（后端合成默认语速）。
    - `src/pages/Learn.tsx` 第 17 行 `RATE_OPTIONS` 的「标准」档位 `-30%`(0.7x)，以及第 61 行 `useState("-30%")` 默认初始语速；第 414 行折叠态 title 兜底文案 `"0.7x"`。
    - `src/components/ChatWindow.tsx` 第 91 行 `rate` 默认参数 `"-30%"`（朗读兜底）。
  - 修改方式：将上述默认统一改为正常的 `1.0` 倍速——`tts.ts` 的 `DEFAULT_RATE` 改为 `"0%"`（Edge TTS 归一化为 `+0%`，即 1.0x），前端默认 `rate` 改为已存在的「正常」档位值 `"+0%"`（保证 `RATE_OPTIONS` 高亮联动正确），兜底文案改为 `"1.0x"`。音种（中文晓晓 / 英文英音）与降级逻辑未动。
  - 约定的 wowenglish IPA / `grammar.html` / `practice.html` 浏览器页面在本工作区**仍未找到**（未落地或位于仓库外），其 `SpeechSynthesisUtterance` 路径若后续补回，需同样把默认 `rate` 从 `0.7` 改为 `1.0`。
  - 生效方式：`electron/lib/voice/tts.ts` 与 `src/**` 为源码，`out/` 为编译产物，需重新构建（如 `npm run build` / `electron-vite build`）后运行才会生效。
- **优先级**：已完成
- **记录时间**：2026-08-18

## [ISSUE-003] 增加会话重置功能（定时任务 + 聊天 /reset 命令），并支持 `/` 触发命令

- **类型**：新功能
- **需求**：
  1. 增加「会话重置」能力（清空孩子当前会话上下文 / 学习资料面板等，让其重新开始）。
  2. 触发方式一：**定时任务**执行（如家长设定每天某时刻自动重置）。
  3. 触发方式二：聊天输入框里输入 `/reset` 执行。
  4. 聊天需新增「以 `/` 开头即触发命令」的能力（为后续更多命令预留）。
- **现状 / 实现入口（2026-08-18 已修复）**：
  - **聊天命令解析**：在 `src/pages/Learn.tsx` 的 `handleSend` 入口拦截以 `/` 开头的输入，识别命令分支（不发送给 AI）。已实现命令注册表 `COMMANDS`（`Learn.tsx` 内），支持 `/reset` 与 `/help`，为后续更多命令预留；`ChatWindow.tsx` 输入框占位提示已加上「以 / 开头可触发命令，如 /help」。
  - **会话管理新增 reset（语义：重置上下文、归档保留历史）**：`electron/lib/pi-session.ts` 的 `resetChildSession(childId)` 调 SDK 原生的 `SessionManager.newSession()` 在当前会话管理器上**开启一个全新的、空的 `.jsonl` 会话文件**，旧会话文件**原封不动留在磁盘上成为归档**；并清空内存 transcript（`agent.state.messages = []`），使下一次对话从空白上下文开始。
    - **为什么用 newSession 而非 resetLeaf（2026-08-18 更正）**：`resetLeaf()` 是「分叉 / 尝试多种可能性」原语——它会在**同一个文件**里从根节点开一条新分支，旧对话作为兄弟分支残留（append-only，不可删），语义是「探索分支」而非「重置」，会让单文件无限堆叠分支。用户明确要求「重置当前上下文、保留历史」，且**保留历史用「归档保留」**——每次重置生成一个独立历史会话文件、旧文件作为归档存着，而非分叉。故改用 `newSession()` 才是干净的「另开新会话」。
    - 热路径（会话已在内存）：直接 `newSession()` + 清内存 transcript，并**立即把新会话 header 写盘**（见下方「已知 bug」）——否则 `continueRecent` 重载会选回旧文件；旧文件即归档。
    - 冷路径（应用未加载该会话，如定时任务触发时应用没开）：在 sessions 目录新建一个仅含 header 的空 `.jsonl` 文件（手写合法 header，因 SDK 的 `newSession()` 不会立即写盘），使下次 `continueRecent` 选中空白会话；旧文件保留为历史。
    - ⚠️ **已知 bug 修复（2026-08-18 15:40）**：原热路径只调 `newSession()`（仅内存重置 + 指向新文件，**不写盘**），导致 (1) 磁盘无新 jsonl；(2) 用户退出再进入时 `SessionManager.continueRecent` 按 mtime 选中旧的「今天被修改过的大文件」，聊天框重现旧消息。修复：热路径在 `newSession()` 后取 `sessionManager.getHeader()` 并 `fs.writeFileSync(sessionFile, header)` 立即落盘，使重置持久化。新增 test/session-reset-durable.test.ts 用真实 SDK 复刻热路径并断言 `continueRecent` 选中新空文件。
    - **归档保留上限（家长可配置）**：`pruneArchivedSessions(sessionsDir, activeFile, limit)` 每次重置后只保留最近 `limit` 个旧会话文件，更早的自动清理，避免 sessions 目录随重置次数无限膨胀；当前活跃会话文件永不被删；`limit<1` 时不保留任何历史归档（仅当前会话）。默认值 `DEFAULT_ARCHIVE_LIMIT = 20`，由 `resetChildSession(childId, archiveLimit?)` 透传；`archiveLimit` 存于 per-child scheduler 配置（`SchedulerChildConfig.archiveLimit`），家长在「定时任务」设置页（src/components/SchedulerSettings.tsx 新增的数字输入，min 0 / max 200）配置，经 `scheduler:config:get/set` 读写，`pi:reset` 与定时 `runSessionReset` 都读取该值传入——无需新增 IPC。
    - **不清学习进度文件（daily/、learning 进度、profile）**。
    - ⚠️ 演变：早期曾错误地用「删 sessions 目录」(抹历史)；后误用 `resetLeaf()`(分叉而非重置)；最终按用户纠正定为 `newSession()` 归档保留（2026-08-18）。
  - **历史会话「归档保留 + 前端可选显示」**：旧会话文件不直接进 agent 上下文，仅用户需要时按需调阅。
    - 后端 `electron/lib/pi-session.ts` 新增 `listChildSessions(childId)`（列出归档会话元数据：文件名 / sessionId / 创建时间 / 消息条数，**排除当前活跃会话**）与 `readChildSessionMessages(childId, file)`（**直接读取指定 `.jsonl` 文件**，重建其活跃路径 root→leaf 消息列表，不加载进 agent、不影响当前上下文）；配套 jsonl 解析器 `loadJsonlEntries` / `readSessionMessagesFromFile`（复用与 `getSessionHistory` 一致的 `extractText` 文本提取与角色映射；`file` 仅取 basename 防目录穿越）。
    - IPC：`electron/lib/ipc-handlers.ts` 新增 `pi:listSessions`、`pi:getSessionMessages`；`electron/preload.ts` 新增桥接 `piListSessions`、`piGetSessionMessages`。
    - 前端：`src/components/ChatWindow.tsx` 顶部新增「📜 历史会话」开关按钮与历史浏览面板（左侧归档列表 + 右侧只读消息视图），`childId` 由 `src/pages/Learn.tsx` 传入；`src/styles.css` 补 `.history-panel` 等样式。默认折叠不显示，用户点开才列历史、任选一条查看（只读、与当前活跃会话完全隔离）。
    - **不清学习进度文件（daily/、learning 进度、profile）**。
    - ⚠️ 演变：早期曾错误地用「删 sessions 目录」(抹历史)；后误用 `resetLeaf()`(分叉而非重置)；最终按用户纠正定为 `newSession()` 归档保留（2026-08-18）。
    - 后端 `electron/lib/pi-session.ts` 新增 `listChildSessions(childId)`（列出归档会话元数据：文件名 / sessionId / 创建时间 / 消息条数，**排除当前活跃会话**）与 `readChildSessionMessages(childId, file)`（**直接读取指定 `.jsonl` 文件**，重建其活跃路径 root→leaf 消息列表，不加载进 agent、不影响当前上下文）；配套 jsonl 解析器 `loadJsonlEntries` / `readSessionMessagesFromFile`（复用与 `getSessionHistory` 一致的 `extractText` 文本提取与角色映射；`file` 仅取 basename 防目录穿越）。
    - IPC：`electron/lib/ipc-handlers.ts` 新增 `pi:listSessions`、`pi:getSessionMessages`；`electron/preload.ts` 新增桥接 `piListSessions`、`piGetSessionMessages`。
    - 前端：`src/components/ChatWindow.tsx` 顶部新增「📜 历史会话」开关按钮与历史浏览面板（左侧归档列表 + 右侧只读消息视图），`childId` 由 `src/pages/Learn.tsx` 传入；`src/styles.css` 补 `.history-panel` 等样式。默认折叠不显示，用户点开才列历史、任选一条查看（只读、与当前活跃会话完全隔离）。
  - **IPC 通道**：`electron/lib/ipc-handlers.ts` 新增 `pi:reset`（按 childId）：调用 `resetChildSession` 后重建干净会话并 `attachSessionEvents`，返回空 `history`/`materials`；`electron/preload.ts` 新增 `piReset` 与 `onPiSessionReset` 监听（主进程广播 `pi:session_reset` 事件）。
  - **定时任务**：复用既有 `scheduler.ts` 的 per-child 配置框架，新增 `sessionReset: { enabled, hour, minute }`（默认关闭，默认 22:00）。`runSessionReset(childId)` 调用 `resetChildSession` 并广播事件；已接入 `startScheduler` 的 cron（每日 hour:minute 执行，按天去重）与 `runCatchUp` 启动补跑；家长端 `src/components/SchedulerSettings.tsx` 新增开关 UI。
- **实现要点 / 取舍（已落地）**：
  - **命令解析位置**：放在发送入口 `Learn.handleSend`（父级 onSend 之前），而非 ChatWindow，因 reset 需要 childId 与 IPC。
  - **重置语义（最终定稿）**：重置的是「当前会话上下文」（`newSession()` 开新空文件、旧文件归档，模型看不到旧消息、从空白开始），**历史聊天记录不抹掉**（旧 `.jsonl` 作为归档保留、可在前端「历史会话」里按需只读调阅）；前端 `materials` 列表 + `selectedMaterialId` 清空；不清除学习进度（符合「只清会话上下文，不清进度」）。
  - **权限/安全（已知取舍，未强制家长校验）**：当前 `/reset` 对孩子与家长均可用（孩子也可触发清空）。`handleSend` 命令分支未做家长密码校验。若需「仅家长可重置、防孩子误清」，后续可在命令分支增加家长身份校验——已作为待定项记录，未阻塞本次实现。
  - **定时任务范围**：作用于单个孩子（per-child 配置），默认时间可配置（时/分），重置后通过 `pi:session_reset` 事件通知前端（若 Learn 页正打开该孩子则同步清空）。
- **优先级**：已完成（2026-08-18）
- **记录时间**：2026-08-18

## [ISSUE-002] 孩子模式 AI 自编学习资料（走 display_content 的 content 参数），而非展示预生成课程 HTML

- **类型**：行为 bug / 已修复
- **真实现象**：引导孩子学习某课时，AI **没有按 method.md 展示预生成课程 HTML**，而是用 `display_content` 的 `content` 参数**自己现场编写学习内容**展示给孩子。即「AI 自己生成学习资料」，不是「重复发同一份 html」（此前误读）。
- **设计规则（method.md）**：孩子只看预生成的 `materials/{课程名}.html`，AI 不应自编资料发给孩子（例 `lunyu/method.md` 第 17/124 行）。
- **根因（已确认）**：`display_content` 工具把「直接传 content（现场拼内容）」列为用法 #1 且 `content` 参数一直开放，诱导 AI 走自编路线；系统提示只说「展示用 display_content」没说「禁止自编、必须用 path」，method 的「不自己编」靠运行时读文件、未可靠注入。
- **真正修复（2026-08-18 实施）**：
  1. **工具接口 path-only + 仅 html（根治）**：`electron/lib/custom-tools.ts` 的 `display_content` 移除 `content` / `format` 参数，`path` 改为必填，仅接受 `.html/.htm`；工具描述重写为「只展示 html 资料、仅需要时调用、以 method 为准」。结构上杜绝 content 自编。
  2. **约束 1（条件性展示）**：`buildChildPrompt` / `LEARNING_NAV` 明确「display_content 仅用于 html 资料展示，仅当需要展示时调用（引导学习展示预生成 html、或孩子主动要求）；聊天/答疑/思考不调用」。去掉原「一律用」绝对化表述与冗余的「不要展示 markdown」。
  3. **约束 2（严格遵守 method）**：`buildChildPrompt` / `LEARNING_NAV` 明确「引导某主题学习必须先读并严格执行该主题 method.md，method 优先级高于通用判断」。
  4. **前端/历史恢复同步**：`MaterialItem` / `Material` 改 `format:"html"`、加 `filePath`；`getSessionMaterials(session, cwd?)` 按 `filePath` 去重，新版历史只存 path 时从文件重读 content（保证恢复不空白）；`Learn.tsx` 按 `filePath` 去重；`ipc-handlers` 调用处传入 `getChildDir(childId)`。markdown 展示走聊天消息气泡（前端已支持 markdown 解析），不走 display_content。
  5. **清理误修**：此前按「重复发同一份」误加的 `dedupKey` / `materialDedupKey` / `hashString` 及前端 `key` 全部移除（custom-tools / pi-session / Learn / MaterialsPanel），改用按 `filePath` 去重。
- **验证**：`tsc --noEmit` 改动文件 0 错误（仅 5 条环境相关全局类型告警，非本次引入）；`dedupKey` 残留引用 grep 确认无（仅 React 的 `e.key`/`v.key`）。`out/` 为编译产物，需重新构建才生效。
- **优先级**：已完成（2026-08-18）
- **记录时间**：2026-08-18

## [ISSUE-004] 聊天消息气泡需要显示时间

- **类型**：UI 增强
- **需求**：每条聊天消息气泡上应显示该消息的发送时间（用户可见的时间戳）。
- **现状（已修复，2026-08-18）**：
  - `ChatMessage` 接口**没有时间字段**：`src/components/ChatWindow.tsx:14-24`（`id / role / text / audio / thinking / tools / working`，无 `time`）。
  - 气泡渲染处（`ChatWindow.tsx:283-321`）只渲染 `m.text` 与朗读/思考按钮，**未渲染任何时间**。ai 气泡用 `bubble bubble-md`（第 285 行），user 气泡用 `bubble`（第 321 行）。
  - 消息在多处构造、均未带时间字段：
    - `src/pages/Learn.tsx`：用户与 working 消息 `userMsg` / `workingMsg`（第 313-323 行）、ai 回复（196、218、250 行）、系统提示（226-227、275-276 行「会话已重置」）。
    - `src/pages/SkillEditor.tsx:26,49`、`src/components/TopicEditor.tsx:42,84`。
  - 已有可用时间格式函数：`Learn.tsx:34` 注释「学习资料到达时间标签（MM-DD HH:mm）」、`nowLabel()`（第 158 行 `time: nowLabel()` 用于 materials）——可直接复用作消息时间戳。
- **实现要点 / 待确认**：
  - 给 `ChatMessage` 加 `time?: string` 字段（`ChatWindow.tsx:14`）。
  - 在各构造点填充时间（建议用统一的 `nowLabel()` / `nowTime()` 工具函数，避免散落）；注意 working（流式）消息在创建时就要带上时间，后续 patch 不应覆盖。
  - 若 Learn 模式会从 session 历史（`getSessionHistory` → `HistoryMessage[]`）重建消息，需把历史自带的时间戳映射到 `time` 字段（与 materials 重建一致）。
  - 渲染：在 `ChatWindow.tsx` 的气泡 JSX 内显示 `m.time`（ai 与 user 都显示），可与朗读/思考按钮同排或置于气泡下方；格式建议与 materials 统一（HH:mm 或 MM-DD HH:mm），需确认。
  - 样式：建议小号、弱色（如 `#999`），不喧宾夺主。
- **修复记录（2026-08-18 实施）**：
  1. **数据模型**：`ChatMessage`（`src/components/ChatWindow.tsx`）新增可选 `time?: string`；`HistoryMessage`（`electron/lib/pi-session.ts`）同步新增 `time?: string`。
  2. **构造点填时间（统一 `nowTime()` 工具，HH:mm）**：`src/pages/Learn.tsx`（用户 / working / ai 回复 / 错误 / 重置 / 命令反馈 / 历史重建）、`src/pages/SkillEditor.tsx` 与 `src/components/TopicEditor.tsx`（家长端流式 ai 首条 + 用户消息）均在创建时带上 `time`；working（流式）消息创建即带时间，后续 patch 不覆盖。
  3. **历史重建映射时间**：`getSessionHistory` 用消息自带 `m.timestamp`（epoch ms）格式化；`readSessionMessagesFromFile`（历史会话调阅）用条目级 `e.timestamp`（ISO）格式化；两者均走既有 `formatTime` → `MM-DD HH:mm`。Learn 重新进入时 `r.history` 的 `time` 直接回填气泡（缺失则回退 `nowLabel()`）。
  4. **渲染**：`ChatWindow.tsx` 在 ai（working / 正式）、user、以及历史浏览气泡内均渲染 `m.time`（`<div className="msg-time">`）。
  5. **样式**：`src/styles.css` 新增 `.msg-time`（小号 11px、右对齐；ai 气泡灰 `#999`，user 气泡半透明白），不喧宾夺主。
  - **格式取舍**：实时消息用 `HH:mm`（聊天惯例，最干净）；历史 / 归档消息因可能跨天用 `MM-DD HH:mm`，便于回溯。
  - **验证**：`tsc --noEmit` 改动文件 0 错误（仅 5 条环境相关全局类型告警，非本次引入）；`npm run build` 通过（renderer CSS 含 `.msg-time`）。`out/` 为编译产物，需重新构建才生效。
- **优先级**：已完成（2026-08-18）
- **记录时间**：2026-08-18

## [ISSUE-005] 孩子模式侧边栏模型显示未跟随「默认模型」设置（仍显示 deepseek flash）

- **类型**：bug / UI 同步
- **现象**：在设置里把默认模型改为「通义千问 Flash（qwen-flash）」，但进入孩子模式后，左侧边栏的模型选择器仍显示 deepseek flash。
- **根因（已确认，未改动）**：
  1. **主进程默认模型是硬编码、不读设置**：`electron/lib/pi-runtime.ts:113-118` —— `getDefaultModel()` 永远返回 `runtime.getModel("deepseek","deepseek-v4-flash")`，写死 `DEFAULT_PROVIDER/DEFAULT_MODEL`，**完全不读取用户在 Settings 里设置的默认模型**。Settings 把默认模型写进了渲染进程 `localStorage["defaultModel"]`（`src/pages/Settings.tsx:25,29-30`），而 main 进程读不到 `localStorage`，且 `getDefaultModel()` 也没去读 electron store / auth 里的默认项。
  2. **侧边栏 ModelSelector 永远选列表第一个**：`src/components/ModelSelector.tsx:27-29` —— `piGetModels()` 返回后直接 `setSelected(result[0])` 并 `trySwitchModel(第一个)`，**不根据用户设置的默认模型预选**。由于 `getAvailableModels()` 列表顺序把 deepseek 排在最前（provider 顺序 deepseek 在前），所以固定显示 deepseek flash。
- **影响链路**：
  - 实际会话用的模型：`pi-session.ts:194,244` 调 `getDefaultModel()` → 拿到硬编码 deepseek-v4-flash；孩子模式入口 `ModelSelector` 又切到列表第一个（deepseek）。
  - 显示与设置脱钩：Settings 的默认模型只存在 `localStorage`，两处（渲染 Settings / 主进程 runtime / 侧边栏选择器）没有统一来源。
- **排查/修复入口**：
  - 默认模型来源：`src/pages/Settings.tsx:25`（写 `localStorage["defaultModel"]`）、`electron/lib/pi-runtime.ts:113-118`（`getDefaultModel` 硬编码）。
  - 侧边栏选择器：`src/components/ModelSelector.tsx:19-37`（初始化选第一个）、`handleChange`/`trySwitchModel`（第 39-71 行，仅手动切换有效）。
  - 模型列表接口：`window.api.piGetModels()`（→ `getAvailableModels`，`pi-runtime.ts:107-110`）。
  - 会话建链：`electron/lib/pi-session.ts:194,244`（`getDefaultModel()` 调用处）。
- **候选修复方向（待定）**：
  1. **统一默认模型来源**：让 `getDefaultModel()`（主进程）读取用户设置（渲染 `localStorage` 需经 IPC 传给主进程，或改存 electron store / settings）。Settings 写入与 runtime 读取要落到同一存储。
  2. **ModelSelector 预选默认**：`ModelSelector` 初始化时先查「用户默认模型」，若存在则预选该项而非 `result[0]`；并在默认模型变化时刷新选择。
  3. 注意 `getDefaultModel()` 被 `scheduler.ts:123` 也调用（定时任务场景），修默认来源时一并覆盖，避免定时任务也用错模型。
- **已修复（2026-08-18）**：统一「默认模型」唯一种源为 `data/app-settings.json`（主进程可读），彻底解决脱钩。
  - `electron/lib/app-settings.ts`：新增 `defaultModel` 字段 + `getDefaultModelKey()` / `setDefaultModelKey(key)`。
  - `electron/lib/pi-runtime.ts` `getDefaultModel()`：优先读 `getDefaultModelKey()`，解析 `provider/modelId` 后用 `runtime.getModel`；解析不到（如 provider 未注册）回退硬编码 `deepseek/deepseek-v4-flash`。覆盖 `pi-session.ts`（孩子/家长会话建链）与 `scheduler.ts`（定时任务）调用方。
  - `electron/lib/ipc-handlers.ts`：新增 `pi:get_default_model`（返回 key）与 `pi:set_default_model`（写入并广播 `pi:default_model_changed`）；`electron/preload.ts` 新增桥接 `piGetDefaultModel` / `piSetDefaultModel` / `onPiDefaultModelChanged`（可退订）。
  - `src/components/ModelSelector.tsx`：初始化时并行取 `piGetModels()` 与 `piGetDefaultModel()`，默认 key 命中可用列表则预选并切换、否则回退列表第一项；监听 `onPiDefaultModelChanged` 在设置页改默认时自动切换。切换去重用 `appliedKey` ref、过期重试丢弃用 `desiredKey` ref（取代原 `switched` 一次性守卫）。
  - `src/pages/Settings.tsx`：设默认时经 `piSetDefaultModel(key)` 写入主进程（成为唯一种源），保留 `localStorage` 镜像；初始值从主进程读取，若主进程无记录但有旧 `localStorage` 值则迁移过去。
  - 验证：`tsc --noEmit` 改动文件 0 新增错误（仅 5 条已知环境相关全局类型告警）；`npm run build` 通过（main/preload/renderer 均含新逻辑）。`out/` 为编译产物，需重新构建生效。
- **优先级**：已完成（2026-08-18）
- **记录时间**：2026-08-18

## [ISSUE-006] 进度文件头部已标注「下一课」，agent 却读取完整文件

- **类型**：上下文效率 / 设计质疑（待排查）
- **现象 / 疑问**：孩子进度文件 `learning/{topic}/{topic}.md` 的 **frontmatter 头部** 已经写了 `next`（下一课）、`learned/total/updated`。但引导孩子学习时，agent 似乎仍会读取**整个进度文件**（含正文里逐课 `### 课程名` + 状态的长列表，如论语可达 514 课），仅为了确定「下一课」——这一步本可只取头部 `next` 字段，无需把几百行正文塞进上下文。
- **进度文件结构（已定位）**：
  - 位置：`data/children/<childId>/learning/{topic}/{topic}.md`。
  - frontmatter（`electron/lib/pi-session.ts:105,122,129` 与 `learning-summary.ts:10,88-89`）：`topic / learned / total / next / updated`——**`next` 即下一课，明文在头部**。
  - 正文：每个课程一条 `### 课程名` + 状态 `⬜`/`✅`（长列表，仅写更新 / 评估时才需要）。
- **两条读取路径（已定位，待确认 agent 实际走哪条）**：
  1. **高效路径已存在但没喂给 agent**：`electron/lib/learning-summary.ts` 的 `parseProgress()` **只解析 frontmatter**（learned/total/next/updated），经 `getLearningSummary(childId)` 产出紧凑摘要，并通过 IPC `learning:summary`（`ipc-handlers.ts:126`、`preload.ts:100`）暴露——但这是**给渲染层 UI 用的**，目前**没有注入 agent 的 LLM 上下文**，agent 自身享受不到这份「只看头部」的红利。
  2. **agent 走「读整份文件」**：应用层 `custom-tools.ts` 只注册了 `display_content` 与 `get_date` 两个工具，**没有通用的 `read_file` 工具**；agent 读进度文件靠 Pi SDK 默认的文件访问能力，或靠技能文案指示去「读取进度文件」（如 `data/shared/skills/study-tracker/SKILL.md:26`「读取每个主题的进度」，评估场景确实需要全文）。日常教学流只需 `next`，却也跟着读了全文。
- **根因假设（待验证，非结论）**：
  - 会话构建时（`buildChildPrompt` / `LEARNING_NAV` / AGENTS.md）**没有把 frontmatter 摘要（next 课）注入系统上下文**，agent 不知道下一课是什么，只能自己去读文件；而 SDK 默认文件读取是「整文件」语义，于是把几百行正文也拉进来了。
  - 教学流与评估流混用了同一份「读进度文件」动作，未区分「只需 next」与「需要全文评估」。
- **排查 / 修复方向（待定）**：
  1. **复用 `learning-summary.ts` 的 frontmatter 解析**，在开孩子会话时把「各主题 → next 课」紧凑摘要注入系统提示 / project_context，使 agent 无需读文件即可知下一课（最大收益，直接消灭冗余读取）。
  2. 若仍要 agent 主动取，提供轻量工具（如 `get_progress` 只回 frontmatter 的 `next/learned/total`），避免读正文。
  3. 区分读取意图：日常教学流只取 `next`；`study-tracker` 评估流才读全文（其本就需要逐课状态）。
  4. 确认 Pi SDK 是否默认带文件读写权限、能否在 child 会话里收窄，以防无意全文注入。
- **备注**：正文（逐课列表）对 token 成本敏感，论语等大主题尤其明显；即便功能正确，也应把「只看头部」做成默认行为。
- **修复记录（2026-08-19 实施，根因已确认即 ISSUE 原假设）**：
  1. **根因确认**：`learning-summary.ts` 的 `parseProgress()` 早已只解析 frontmatter，并经 IPC `learning:summary` 暴露——但那是**给渲染层 LearningDashboard 用的**，从未注入 agent 的 LLM 上下文；agent 又没有「只读 frontmatter」的工具，只能靠 SDK 的 `read` 工具整文件读取（method.md 写「读 frontmatter next 字段」，agent 实际 read 了全文）。故论语 514 课正文被整篇塞进上下文只为取一个 `next`。
  2. **注入进度概览到系统提示（最大收益，方向 #1）**：开孩子会话时（`electron/lib/pi-session.ts` 的 `createChildSession`）先 `getLearningSummary(childId)` 拿到 frontmatter 级摘要，经新增的 `progressSummaryToMarkdown(summary)`（`learning-summary.ts`）渲染成紧凑文本，传入 `buildChildPrompt(profile, progressContext)` 追加为系统提示的「## 孩子的学习进度概览」段。agent 开会话即知各主题 next 课，**无需 read 进度文件**。
  3. **新增轻量工具 get_progress（方向 #2）**：`electron/lib/custom-tools.ts` 新增 `get_progress` 工具（customTools 注册到孩子会话），只回 frontmatter 摘要（learned/total/next/updated），agent 会话中途刷新进度时免去读正文；childId 由 `ctx.cwd` 推导、无需前端传参。
  4. **约束 agent 读取意图（方向 #3）**：`LEARNING_NAV_INSTRUCTIONS` 新增「进度查询（省上下文，务必遵守）」段——明确「直接用系统提示里的 next 或 get_progress，严禁用 read 读进度文件正文；只有 study-tracker 明确需要逐课状态时才读全文」；同步在 `data/shared/skills/study-tracker/SKILL.md` 第二步加效率提示，评估流优先 get_progress。
  5. **验证**：`tsc --noEmit` 改动文件 0 错误（仅 5 条已知环境相关全局类型告警，非本次引入）；`npm run build` 通过（main/preload/renderer 均含新逻辑；需先 `rm -rf out` 规避 electron-vite 清空 out 的 EPERM）。`out/` 为编译产物，需重新构建生效。session 单测（jest）本机未装测试 harness + 需 Electron 运行时，未在本机跑；既有失败用例 app.test.ts / sync.test.ts 与本次改动无关。
- **优先级**：已完成（2026-08-19）
- **记录时间**：2026-08-18

## [ISSUE-007] 核查千问/DashScope 还能提供哪些模型（含官网可见的 DeepSeek 系列），并决定是否登记进应用

- **类型**：调研 + 实施 / 模型可用性（已完成）
- **背景 / 现象**：用户在千问（通义）官网看到，其平台除了 qwen-max/plus/flash，**还提供 DeepSeek 等第三方模型**。应用当前只把 qwen 官方模型挂到 `qwen` provider 下，未登记这些「同端点可调用」的其它模型。
- **现状（已定位）**：
  - 千问 provider 接入的是 DashScope OpenAI 兼容端点：`baseUrl = https://dashscope.aliyuncs.com/compatible-mode/v1`（`electron/lib/pi-runtime.ts:13,85`）。
  - 已登记模型仅 3 个：`QWEN_MODELS`（`pi-runtime.ts:40-81`）——`qwen-max` / `qwen-plus` / `qwen-flash`；经 `QWEN_PROVIDER`（83-88）→ `registerQwenProvider`（`runtime.registerProvider("qwen", ...)`，90-96）注册。
  - **代码注释已确认存在「同端点多模型」事实**：`pi-runtime.ts:14-15` 明确写道「SDK 内置的 `qwen-token-plan*` 是阿里云百炼 token-plan 套餐（模型为 MiniMax/DeepSeek/GLM 等），与这里接入的通义千问官方模型不是一回事」。即 DashScope/百炼经同一端点可提供 DeepSeek/GLM/MiniMax，但应用目前**没有把这些 model 登记为可用项**。
  - 模型列表出口：`getAvailableModels()`（`pi-runtime.ts:112`）→ IPC `pi:get_models`（`ipc-handlers.ts:451`）→ 前端 `ModelSelector`（`src/components/ModelSelector.tsx`）、设置页 `Settings.tsx`。
- **需排查 / 决策点（待确认）**：
  1. **调研可用模型清单**：核实 DashScope/百炼经该端点实际可调用、且该用户额度覆盖的模型 ID——尤其官网可见的 **DeepSeek 系列**（如 `deepseek-v3`、`deepseek-r1`、`deepseek-v3.1` 等），以及 GLM、MiniMax 等。需以官方「模型列表 / 百炼模型广场」为准（注意稳定别名与具体版本号差异）。
  2. **登记方式（设计取舍）**：
     - 方案 A：在现有 `qwen` provider 下追加 `deepseek-*` 等 model（共享 DashScope baseUrl）——用户持一个千问 Key 即可切到 DeepSeek。
     - 方案 B：注册独立 provider（如 `bailian`/`dashscope`）指向同一 baseUrl，专门列 DeepSeek/GLM 等非千问模型，与 `qwen` 官方模型在 UI 上分开。
  3. **推理/thinking 参数差异**：DeepSeek 用自身的 thinking 格式（与 qwen 的 `compat.thinkingFormat:"qwen"` 不同），登记时需配正确的 `reasoning` / `compat`（参考 deepseek provider 现有配置，避免思考混进正文），且 `maxTokens`/`contextWindow` 取该模型安全值。
  4. **默认模型联动**：若 DeepSeek-via-DashScope 性价比优于当前默认，是否影响 `getDefaultModel()`（`pi-runtime.ts:113-137`）与 `app-settings` 的默认选择（ISSUE-005 已统一为 `data/app-settings.json`）。
- **排查入口（可直接执行）**：
  - 模型注册：`electron/lib/pi-runtime.ts:40-96`（QWEN_MODELS / QWEN_PROVIDER / registerQwenProvider）。
  - 列表出口与前端：`electron/lib/pi-runtime.ts:112` `getAvailableModels`；`electron/lib/ipc-handlers.ts:451`；`src/components/ModelSelector.tsx`；`src/pages/Settings.tsx`。
  - 参考既有 deepseek provider 配置（reasoning / compat / thinkingFormat），确认跨 provider 复用或独立定义。
- **补充（2026-08-19）**：用户直觉里「官网可见 DeepSeek 系列」指 `deepseek-v3 / r1 / v3.1`——但**官方文档（2026-08-10）这些已不存在**，当前百炼/DashScope 同端点实际提供的是 **DeepSeek V4 系列**（`deepseek-v4-pro`、`deepseek-v4-flash-0731`），与用户印象里的版本号不同，调研时以官方为准。

## 调研结论与决策（2026-08-19 调研完成）

### 1. 经 DashScope/百炼 OpenAI 兼容端点（`compatible-mode/v1`）实际可调用的模型
来源：阿里云百炼 Model Studio 官方模型列表（更新 2026-08-10）。

| 类别 | 精确模型 ID（API 调用用） | 备注 |
|---|---|---|
| 通义官方（应用已登记稳定别名） | `qwen-max` / `qwen-plus` / `qwen-flash` | 别名自动路由最新版：`qwen3.8-max` / `qwen3.7-plus` / `qwen3.7-flash`（见 `pi-runtime.ts:16-17`），应用已挂 `qwen` provider |
| 第三方·DeepSeek | `deepseek-v4-pro`、`deepseek-v4-flash-0731` | 经百炼同端点（非直连），v3/R1 系列已下架 |
| 第三方·GLM（智谱） | `glm-5.2`（多区域）、`ZHIPU/GLM-5.2`（仅华北2北京） | |
| 第三方·MiniMax | `MiniMax/MiniMax-M3`（仅华北2北京） | 三方直供，区域受限 |
| 第三方·Kimi | `kimi/kimi-k3`（仅华北2北京） | 文本+图理解均北京 |
| 第三方·小米 | `xiaomi/mimo-v2.5-pro`（仅华北2北京） | |

> 注：多数非千问第三方模型**仅华北2北京可用**（区域限制），且 `kimi/kimi-k3`、`MiniMax/MiniMax-M3`、`xiaomi/mimo-v2.5-pro`、`ZHIPU/GLM-5.2` 等带 provider 前缀的 ID 在通用客户端需正确传 `model` 全名。

### 2. 决策（2026-08-19 已实施·方案 A）
**用户最终决定登记**：理由——经千问（百炼）调用的 DeepSeek **费用低于直连 DeepSeek 官方**，用户希望用同一个千问 Key 即可切到更便宜的 DeepSeek。故推翻原「不登记」调研建议，改为 **方案 A：在现有 `qwen` provider 下追加 DeepSeek 模型**（共享 DashScope `baseUrl`）。

**落地（2026-08-19 实施）**——`electron/lib/pi-runtime.ts`：
- 新增 `QWEN_DEEPSEEK_MODELS`（`pi-runtime.ts` 在 QWEN_MODELS 之后），在 `QWEN_PROVIDER.models` 里 `[...QWEN_MODELS, ...QWEN_DEEPSEEK_MODELS]` 合并。登记 4 项：
  - `deepseek-v4-flash`（别名，自动路由最新版）
  - `deepseek-v4-flash-0731`（定点快照）
  - `deepseek-v4-pro`（别名）
  - `deepseek-v4-pro-0813`（定点快照）
  - 模型 ID/可用性来源：千问平台官方模型清单 `platform.qianwenai.com/docs/.../text-generation-models`（上述 ID 与文档「推荐模型 / 第三方模型」表一一对应）。
- **关键兼容性（避免思考混进正文）**：DeepSeek 思考格式与 qwen 不同，必须 `compat.thinkingFormat:"deepseek"` + `requiresReasoningContentOnAssistantMessages:true`（**不能复用 qwen 的 `"qwen"`**）；`reasoning:true`、`supportsDeveloperRole:false`。参数取自 SDK 内置 `deepseek` provider 的 `deepseek.json`：`maxTokens:384000`（思考+输出共享，区别于 qwen 的 16k/32k/65k）、`contextWindow:1000000`、`thinkingLevelMap:{minimal:null,low:null,medium:null,high:"high",max:"max"}`（与 SDK 对齐，配合 `pi-session.ts` 对 `off` 的强制纠正为 `high`）。
- 注释已写明：这些项的 `maxTokens` 取 384000（与 qwen 不同）；以及为何用 `deepseek` 格式而非 `qwen`。

**默认模型联动（保持现状）**：
- `getDefaultModel()` 兜底默认仍是 SDK 直连的 `deepseek/deepseek-v4-flash`（`pi-runtime.ts:119-120`），未改；用户可在设置里把默认切到 `qwen/deepseek-v4-flash`（百炼版）以享低价——两 key（`deepseek/...` 与 `qwen/...`）在 UI/配置里是不同选项，不互相覆盖。
- ISSUE-005 统一的 `data/app-settings.json` 默认模型来源逻辑无需改；新项自动出现在 `getAvailableModels()` → IPC `pi:get_models` → 前端 `ModelSelector`/`Settings`，无需改前端。

**验证（2026-08-19）**：
- `tsc --noEmit`：仅 5 条已知环境相关全局类型告警（4×TS2318 + 1×TS2552），**无指向 pi-runtime.ts 的新增错误**。
- `npm run build`：通过（main/preload/renderer 均成功）。`out/` 编译产物需重构建生效。

### 3. 未做项（保留调研结论，暂不登记）
- **方案 B（独立 provider）未采用**：用户选了方案 A（同 `qwen` provider 挂载），故未注册 `bailian`/`dashscope` 独立 provider。如后续要 UI 上与 qwen 官方分离，再按方案 B 推进。
- **GLM / MiniMax / Kimi / Mimo 等其它第三方模型未登记**：多数仅华北2北京区域受限，且用户未要求；保留在调研清单里备查。

### 4. 顺带核对
- 应用默认 `deepseek/deepseek-v4-flash` 已是最新 v4 flash，无需补 v3 系（v3 在官方已下架）。
- `compat.thinkingFormat` 取值已含 `"deepseek"`（SDK `model-config.d.ts:46`），本次登记百炼版 DeepSeek 已直接用此值，无需改 SDK。

- **备注**：本 issue 是「先调研可用模型、再决定是否/如何登记」的待办；调研已完成，**用户决定按方案 A 在 `qwen` provider 下登记 DeepSeek V4 系列**（同一 DashScope Key 即可用更便宜的 DeepSeek），已于 2026-08-19 实施。原「不登记」仅为调研建议，已被用户推翻。其它第三方模型（GLM/MiniMax/Kimi/Mimo）仍保留在调研清单、未登记。
- **优先级**：已完成（2026-08-19）
- **记录时间**：2026-08-18（末次更新 2026-08-19）

## [ISSUE-008] 增加文件上传功能，按文件格式做对应处理（图片→识图模型等）

- **类型**：新功能（待实现）
- **需求**：聊天框支持**上传文件**；上传后根据**文件格式**自动做对应处理。例：图片 → 调**识图/视觉模型**识别内容再回答；其余格式（pdf/doc/音频等）也应有对应处理逻辑。
- **现状 / 关键约束（已定位）**：
  1. **应用仍没有视觉/多模态模型**：ISSUE-007 已登记 DashScope 的 DeepSeek V4 系列（`deepseek-v4-flash` 等，均为 `input:["text"]`），但**视觉模型（如 `qwen-vl` / `qwen2.5-vl` 系列）仍未登记**。全 `electron` 中唯一带 `image` 的命中是 `voice/tts.ts` 里处理 markdown 图片链接（与识图无关）。即「图片调识图模型」**必须先登记一个视觉模型**——仍可在 ISSUE-007 已打通的 `qwen` provider（DashScope 同端点）下追加 `qwen-vl-*`，复用同一 `baseUrl` 与 `registerProvider` 机制。
  2. **聊天无上传 UI**：输入框仅文本——`src/components/ChatWindow.tsx:514`（`onChange={setInput}`），发送经 `Learn.tsx` 的 `handleSend`（ISSUE-003 已定位 `/` 命令在此拦截）。`ChatMessage` 现有字段为 `id/role/text/audio/thinking/tools/working/time`，**没有附件/图片字段**。
  3. **已有可复用的「选文件」范式**：`electron/lib/ipc-handlers.ts:295` 用 `dialog.showOpenDialog` 让用户选文件（现有 skill/learning 读取通道复用）；可由新增 IPC（如 `file:pick` / `file:upload`）复用此模式把文件读入主进程。
  4. **会话工具集**：`electron/lib/pi-session.ts:333` 会话 `tools: ["read","write","edit","display_content","get_date"]`——上传文件如需让 agent 访问，需决定是「前端直接把图片块塞进消息」还是「落盘后交给 agent 的 read 工具」。
  5. **音频识别管线已存在**：`electron/lib/voice/`（顶层 `transcribeAudio` + aliyun/tencent/qwen 三 Provider）可直接复用于「上传音频→转写文本→进会话」。
- **实现要点 / 待确认（待定）**：
  1. **UI**：在 `ChatWindow.tsx` 输入框旁加「📎 上传」按钮 → 调主进程选文件 IPC → 拿到文件后按 MIME 路由，并在气泡渲染附件缩略（图片预览 / 文件名）。需给 `ChatMessage` 加 `images?` / `attachments?` 字段（`ChatWindow.tsx` 数据模型 + 气泡 JSX）。
  2. **格式路由（按扩展名/MIME）**：
     - `image/*` → 走**视觉模型**：把图片作为多模态内容块发给会话（需视觉模型登记，见约束 1）；若当前选中模型不支持视觉，需自动切到视觉模型或提示。
     - `audio/*` → 复用 `voice/transcribeAudio` 转写后作为文本消息进会话。
     - `application/pdf`、`doc(x)`、`txt/md` → 抽取文本（pdf/doc 需引入解析库，如 pdf-parse/mammoth）再进上下文；大文件需截断或摘要。
     - 其它（zip 等）→ 暂不支持或提示。
  3. **视觉模型登记**：在 `pi-runtime.ts` 的 `qwen` provider（或新增 vision 段）加视觉模型（如 `qwen-vl` 系列，`input:["text","image"]`，配正确 `reasoning`/`compat`——注意 qwen-vl 的 thinking 格式与 qwen 文本模型是否一致需核对），并决定：图片消息是否要求会话临时切到视觉模型、还是消息层带「vision」标记由 SDK 选模型。
  4. **落盘与隔离**：上传文件按 `childId` 隔离存放（参考 `data/children/<childId>/` 约定），避免跨孩子泄漏；临时文件需清理策略。
  5. **child 模式权限**：孩子是否也能上传、上传内容是否受限（同 ISSUE-003 未强制家长校验的取舍）。
- **排查 / 实现入口（可直接执行）**：
  - 聊天输入/发送：`src/components/ChatWindow.tsx:514`（输入）、`Learn.tsx` 的 `handleSend`；数据模型 `ChatWindow.tsx` 的 `ChatMessage`（14-24 行附近）。
  - 选文件 IPC 范式：`electron/lib/ipc-handlers.ts:295`（`dialog.showOpenDialog`）；新增 `file:*` IPC + `preload.ts` 桥接。
  - 会话与工具：`electron/lib/pi-session.ts:333`（tools 列表）、`getChildSession`。
  - 视觉模型登记：`electron/lib/pi-runtime.ts`（ISSUE-007 已在此登记 DeepSeek V4，同位置追加 `qwen-vl-*`）。
  - 音频复用：`electron/lib/voice/index.ts` `transcribeAudio`。
- **关联**：依赖视觉模型登记（ISSUE-007 已打通 `qwen` provider 同端点机制，可顺势加 `qwen-vl`）；音频转写可复用既有 `voice/` 管线。
- **已修复（2026-08-19 实施）**：
  1. **视觉模型登记（前置）**：`electron/lib/pi-runtime.ts` 新增 `QWEN_VL_MODELS`（挂 `qwen` provider，DashScope 同端点）：`qwen3-vl-flash` / `qwen3-vl-plus`，`input:["text","image"]`、`reasoning:true`、`compat.thinkingFormat:"qwen"` + `supportsDeveloperRole:false`、`maxTokens:8192`（保守值，VL 输出上限低于纯文本 qwen）、`contextWindow:256000`。并导出 `DEFAULT_VISION_MODEL = { provider:"qwen", modelId:"qwen3-vl-flash" }`（图片上传时自动切换目标，便宜优先）。旧 `qwen-vl-max/plus` 已被官方列入「旧版不再推荐」（2026-07-15 文档），故挂 Qwen3-VL 系。
  2. **前端上传 UI**：`src/components/ChatWindow.tsx` 输入框旁加「📎 上传」按钮 + 隐藏 `<input type="file" multiple accept="image/*,audio/*,text/plain,.txt,.md">`（不新增选文件 IPC，比 dialog.showOpenDialog 更轻、避免大文件过 IPC 往返）。`ChatMessage` 新增 `attachments?: ImageAttachment[]`（`{dataUrl,mime,name}`）；导出 `ImageAttachment` / `TextFileAttachment` / `SendOptions`。格式路由：`image/*`→`FileReader` 转 dataURL 进待发预览；`audio/*`→复用 `voiceTranscribe` 转写文本自动填入输入框；`txt/md`→`readAsText` 进待发列表；其余类型提示「暂不支持」。气泡渲染图片缩略（`.bubble-attachments` / `.bubble-image`），输入区上方渲染待发预览条（`.attachment-preview` / `.attachment-thumb` / `.attachment-file` / `.attachment-remove`），`Learn.tsx` 透传 `notice`（视觉切换提示）。
  3. **发送链路**：`Learn.tsx` `handleSend(text, opts?: SendOptions)` 拼装 prompt 正文（语音注明识别误差来源 / 图片注明「孩子上传了 N 张图片，请识别并回应」/ 文本文件附全文），dataURL 剥离前缀转 SDK `ImageContent[]`（`{type:"image",mimeType,data}`），经 `window.api.piPrompt(childId, promptText, sdkImages?)` 送主进程。
  4. **主进程自动切视觉模型**：`electron/lib/ipc-handlers.ts` `pi:prompt` 增加 `images` 参数；有图片且当前 `session.model.input` 不含 `"image"` 时，`runtime.getModel(DEFAULT_VISION_MODEL...)` + `session.setModel(vl)` 自动切换（会话级持久，qwen3-vl 也能正常聊文字），并通过新事件 `pi:vision_model_switched` 广播；`session.prompt(text, { images })` 内联发送。`electron/preload.ts` `piPrompt` 增加 images 参数 + 新增 `onPiVisionModelSwitched` 监听。
  5. **前端提示**：`Learn.tsx` 监听 `pi:vision_model_switched` → `ChatWindow` 输入区上方显示「🖼️ 已自动切换到视觉模型来识别图片」（6 秒自动消失，`.chat-notice` 样式）。
  6. **落盘持久化（2026-08-19 改，用户要求）**：上传文件落盘到 `data/children/<childId>/uploads/`（childId 隔离）：
     - 新增 IPC `file:save_upload`（`electron/lib/ipc-handlers.ts`）：接收 `{childId,name,mime,data(ArrayBuffer)}`，安全文件名（`path.basename` 防穿越 + 剔除危险字符 + `时间戳-原名` 防重名 + resolve 后必须在 uploads 目录内双保险）写入；返回相对路径 `children/<childId>/uploads/<file>`。
     - `electron/lib/config.ts` 新增 `getUploadsDir(childId)`、`UPLOAD_EXT_WHITELIST`、`DEFAULT_UPLOAD_LIMIT(200)`、`pruneUploads()`（每次保存后按 mtime 只留最近 200 个，防无限膨胀）；`electron/preload.ts` 新增 `saveUpload` 桥接。
     - 前端 `ChatWindow.tsx`：`ImageAttachment`/`TextFileAttachment` 加 `path?` 字段；图片/文本读取后经 `persistUpload` 落盘（失败降级不阻断，仍可用 dataURL 预览/发送）；音频转写时顺带落盘原始录音。
     - 发送仍走 dataURL 内联 base64（qwen3-vl 经 OpenAI 兼容端点必须 base64/URL，本地路径不可用）；落盘用于持久化保存与家长可检索。
  7. **验证**：`tsc --noEmit` 仅 5 条已知环境相关全局类型告警（TS7/@types/node26 不兼容），无本次新增错误；`npm run build` 通过（main/preload/renderer 均成功）。覆盖模型登记的 `test/qwen-deepseek-models.test.ts`（6 项）全部通过；其余 12 个失败用例均为既有环境问题（safe-delete 拦截测试清理 rmSync 导致 auto-new-session 6 项 / archive-limit 级联 1 项、learning-summary 真实数据漂移 2 项、functional 的 `app.isPackaged` 在 vitest 未定义 1 项、app.test.ts 云端 ECONNREFUSED 1 项、sync.test.ts 并发超时 1 项），与本次改动无关。
- **优先级**：已完成（2026-08-19）
- **记录时间**：2026-08-18（末次更新 2026-08-19）

## [ISSUE-009] 论语 method「记录」段需补充与 recording skill 一致的详细度要求

- **类型**：内容/规范问题（待修改 method.md，不改代码）
- **需求**：论语学习的 `method.md` 里「记录」部分，需要像 `recording` skill 那样，**明确记录的详细程度**——尤其是要把**孩子的行为内容描述清楚**（孩子的原话、举的例子、提的问题、情绪反应、思考过程、纠正过程），当前指令太简单，agent 只写一句空泛的「孩子表现」，丢掉了基本信息，无法日后完整回顾。
- **规则出处（两处对比）**：
  - **待改的弱指令（真源）**：`data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674/learning/lunyu/method.md:100-106` 的「记录」段，其中**第 104 行**只写「逐字段详写……孩子表现（孩子表现写具体，不写空话）」——一句话带过，未界定「具体」到底要记什么、没说不限篇幅、没禁止空话概括。
  - **应看齐的强规范**：`data/shared/skills/recording/SKILL.md`
    - 「详细度要求（最高优先级）」`SKILL.md:12-20`：不限制篇幅、记录所有关键点（孩子原话/例子/问题/情绪/思考/纠正过程）、不写空话（禁"表现很好""理解到位""很积极"）、宁详勿略。
    - daily「学习」区块「孩子表现」字段说明 `SKILL.md:86`：必填且详写，记录孩子的原话、举的例子、提的问题、思考过程、情绪反应，不限篇幅，宁可多写几行，不要只写"理解到位"。
    - 注意项 `SKILL.md:155`：详细度是硬要求。
- **排查 / 修改入口（可直接执行）**：
  - 真源文件：`data/children/<childId>/learning/lunyu/method.md`（**注意**：`cloud-service/storage/...` 下另有 4 份同名文件是云端同步副本，非真源，改本地 data/children 这份即可）。
  - 对照模板：`data/shared/skills/recording/SKILL.md` 的「详细度要求」+ daily「学习」区块「孩子表现」字段说明（即上面的规范，可直接复制到 method.md）。
- **候选修改方向（待定）**：
  1. **内联补齐**：在 `method.md` 记录段第 2 步下补一段「详细度要求」，对齐 recording skill——不限制篇幅、记录所有关键点（孩子原话/例子/问题/情绪/思考/纠正过程）、禁止空话概括、宁详勿略；并明确「孩子表现」字段必填、详写、不限篇幅。
  2. **改引用**：因 method.md 第 100 行写明「不调用 recording 技能」（论语记录是内联执行、不委托 recording skill），故不能直接靠调用 skill 获得其详细度；若采用引用写法，需写明「按 recording skill 的详细度要求填写孩子表现」以避免两处维护不同步。
- **普遍性提示（建议一并评估）**：同样的弱指令（「孩子表现写具体，不写空话」）也出现在 `data/children/1f050a7f-.../learning/` 下的 **english / qianziwen / hanzigong / reading / taodi / xiaojing / xiaozhuan** 的 `method.md` 记录段。用户点名论语，但根因是统一的模板文案过简；是否只修论语、还是所有主题 method 统一补详细度要求，需确认。
- **待确认项**：① 只修论语还是全主题统一；② 内联补齐 vs 引用 recording skill 的取舍；③ 是否顺手把 recording skill 的「详细度要求」段落抽成共享片段，供各 method.md 引用。
- **已修复（2026-08-19，用户确认：全部主题统一修 + 内联补齐）**：
  1. **范围**：`data/children/1f050a7f-.../learning/` 下 8 个主题的 `method.md` 记录段第 2 步全部更新（lunyu / english / qianziwen / hanzigong / reading / taodi / xiaojing / xiaozhuan）。
  2. **写法**：内联补齐——第 2 步的「孩子表现写具体，不写空话」改为「**孩子表现必填且详写**，按下方「详细度要求」记录」；第 2 步后新增一段「**详细度要求（硬性规定）**」：不限篇幅 / 记所有关键点（原话、例子、问题、情绪、思考、纠正过程）/ 禁空话（表现很好、理解到位、很积极）/ 宁详勿略。各主题字段列表（考核、掌握度、难点、错题、生字等）保持各自原有结构，english 的 Yellow 课程额外记录项未动。
  3. **二次修订（2026-08-19，用户要求）**：(a) 标题去掉「与 recording 技能一致」字样（详细度要求已写全，无需再引 recording，避免依赖 skill 内容）；(b) 删除各文件记录段原有的「> 会话里若有生活事件、随口问答、任务等其他内容，才用 recording 技能兜底记录。」提示句——专注学习记录、不分散 agent 注意力。
  4. **未做**：③ 抽共享片段未做（用户选内联，自包含不依赖 skill 内容）；`cloud-service/storage/` 下同名同步副本未改（非真源，云端同步会自动覆盖）。
  5. **验证**：grep 确认 8 个文件均含「详细度要求」段、旧弱指令「孩子表现写具体，不写空话」与「recording 技能兜底记录」均无残留。
- **优先级**：已完成（2026-08-19）
- **记录时间**：2026-08-19

## [ISSUE-010] 增加 token 统计（每轮发送给 agent 的内容 / 已有消息 vs 新增消息 / agent 返回消息）

- **类型**：可观测性 / 新功能（待实现）
- **需求**：做 token 统计，目的是了解 token 消耗情况。具体要统计：
  1. **每次发送给 agent 的内容的 token**（即每一轮真正发给 LLM 的 input，含 system prompt + 全部历史消息 + 工具定义）；
  2. **每一轮的「已有消息」与「新增消息」分别多少 token**（看上下文增量有多大）；
  3. **agent 返回消息的 token**（output）。
- **利好（已确认，SDK 已内置真实用量）**：`@earendil-works/pi-coding-agent`（v0.84.1）**自带 token usage**，不需要全部本地估算：
  - 每条 assistant 消息带 `usage` 字段（`dist/core/agent-session.js:255` 取自 `result.usage`），`Usage` 类型来自 `@earendil-works/pi-ai`；
  - SDK 提供 `UsageTotals { input, output, cacheRead, cacheWrite, cost }`（`dist/core/usage-totals.d.ts`）与 `addUsageToTotals()` 累加；
  - 因此「发送给 agent 的 token」≈ 本轮 assistant 消息 `usage.input`（+`cacheRead`），「agent 返回 token」≈ `usage.output`，可直接取**真实值**，不必 char/4 估算。
- **排查 / 实现入口（可直接执行）**：
  - **发送入口**：`electron/lib/ipc-handlers.ts:383` `pi:prompt` → `session.prompt(text)`（388）；同文件 `pi:prompt_parent`（433）为家长端；`electron/lib/scheduler.ts:150` `createAgentSession` 为定时任务。三处都应覆盖。
  - **已有/新增消息 diff**：`session.messages`（`ipc-handlers.ts:391`）在 `prompt()` 前后各快照一次，做消息级增量比对。注意：**只有 assistant 消息自带 `usage`**，user / tool / system 消息不带 → 「已有 vs 新增」的 token 拆分对这类消息需本地分词估算（见下）。
  - **agent 返回消息**：`ipc-handlers.ts:408-416` 提取最后一条 assistant 的 text；其 `usage.output` 即返回 token（real）。
  - **SDK 累积用量**：`session` 已隐含 `UsageTotals`（经 `addUsageToTotals`），可直接读会话级累计 input/output/cacheRead/cacheWrite/cost。
- **实现要点 / 待确认（待定）**：
  1. **已有 vs 新增拆分怎么做**：SDK 只给 assistant 消息的 usage，无法直接从 SDK 拿到「历史 user/tool 消息」的 token。两条路——(A) 引入分词器（如 `gpt-tokenizer` / `tiktoken` wasm）对 `session.messages` 逐条估算，再按 prompt 前后的消息切片算增量；(B) 近似：用「本轮 `usage.input` − 上轮累计已用 input」推增量。建议 (A) 更准，且问卷里已有上下文截断（`user-init.ts:109-110` `reserveTokens/keepRecentTokens`），可顺带看到截断后实际发送量。
  2. **统计落点（展示/留存方式）**：现有 `[pi:prompt]` 风格 console.log（`ipc-handlers.ts:384`）可先打日志；但「了解消耗」更适合**持久化**，建议按 childId 写 token 日志（如 `data/children/<childId>/token-log.jsonl`，每行记 `{round, ts, model, input, output, cacheRead, cacheWrite, cost, existingTokens, newTokens}`），可跨重启累计；是否还要在家长端 UI 做展示面板待定。
  3. **成本(cost)**：`UsageTotals.cost` 已含按模型计费，若要做费用看板可直接用，但需确认 SDK 计费表是否覆盖已登记的 DeepSeek/Qwen 模型（ISSUE-007 新增的 `qwen/deepseek-v4-*` 是否在 SDK cost 表中）。
  4. **定时任务路径**：`scheduler.ts` 的 agent 调用同样要计入，否则总量偏低。
- **关联**：与上下文截断（`user-init.ts` reserveTokens/keepRecentTokens）、缓存命中（`electron/extensions/learning-guard.ts:25` cache 命中与否影响 input 计费）直接相关；统计后可反推截断/缓存策略是否省 token。
- **修复记录（2026-08-19 实施）**：
  1. **新增核心模块 `electron/lib/token-stats.ts`**：
     - **真实用量直接取 SDK usage**：每轮 prompt 后对「新增 assistant 消息」的 `m.usage` 累加（input/output/cacheRead/cacheWrite/cost.total/totalTokens + assistantCalls 调用次数；`stopReason==="error"` 不计入），不本地估算、不按字符猜（已确认 `AgentMessage` 的 `AssistantMessage` 必带 `usage`，agent-session.js 每条 assistant 挂 `result.usage`）。
     - **已有 vs 新增拆分用本地近似分词**（SDK 不给 user/tool 消息 token）：`estimateTokens()`——CJK（含全角标点）~1.5 字符/token、其它 ~4 字符/token；`computeRoundStats(session, beforeCount)` 在 prompt 前快照 `messages.length`，已有 = 前 beforeCount 条估算、新增 = 之后估算（**已确认 SDK 的 prompt() 内部构造用户消息、不会在调用前 push 进 messages**，故 beforeCount 快照时机准确：「已有」= 上轮上下文，「新增」= 本轮输入+工具往返+回复）。
     - **按 childId 隔离落盘**：`data/children/<childId>/token-log.jsonl`（家长无 childId 落 `data/token-log.jsonl`），append-only 每行一条 JSON（seq 递增 / ts / channel / sessionFile / model / ok / 真实用量 / existingTokens / newTokens / assistantCalls / replyLength）；`MAX_TOKEN_LOG_LINES=5000` 超限截断防膨胀。
     - `logRound({session, beforeCount, channel, childId, ok, replyLength})` 一站式：收集 + 落盘，内部 try/catch 静默降级（统计失败绝不影响主流程）。
  2. **三个发送入口全部接入**：
     - 孩子聊天 `pi:prompt`（`ipc-handlers.ts`）：prompt() 前取 beforeCount，正常轮 `ok:true`、`stopReason=error` 的失败轮 `ok:false` 都记账（失败轮 input 通常已实际发生）。
     - 家长聊天 `pi:prompt_parent`：`channel:"parent"`，无 childId 落全局日志。
     - 定时任务 `scheduler.ts` `runRecording` / `runTracker`：`channel:"scheduler"`，按 childId 隔离。
  3. **家长端展示面板（UI 已实现，2026-08-19 同日）**：IPC `token:summary`（累计 rounds/totalInput/totalOutput/totalCacheRead/totalCacheWrite/totalCost/totalTokens/lastTs + 按模型分组 byModel）与 `token:list`（最近 N 条），`preload.ts` 桥接 `getTokenSummary` / `getTokenList`。前端新增 `src/components/TokenStatsPanel.tsx`，作为 Dashboard 侧边栏「📈 Token 消耗」独立菜单项（与「学习进度」平级）：顶部 6 张汇总卡（总轮次/总输入/总输出/缓存命中/估算总费用/最近使用）、按孩子·渠道表（每孩子 + 家长会话）、按模型表、最近明细表（100 条内合并排序，可按下拉过滤孩子，⏰ 标注定时任务、✓/✗ 标注成败、已有/新增估算并列显示）。
  4. **取舍**：未引入 gpt-tokenizer/tiktoken 新依赖（打包体积 + 维护成本），「已有/新增」用近似估算并在字段名上与非估算的真实 usage 分开（existingTokens/newTokens 是 estimated，input/output 是 real）；若后续要精确到字节级，可再换分词器。
  5. **验证**：新增 `test/token-stats.test.ts` **16 用例全过**（estimateTokens 中英混合 / computeRoundStats 累加与切片 / error 不计入 / usage 缺失防御 / content 数组只计 text / childId 隔离 / seq 递增 / 家长全局路径 / getTokenSummary 累计与 byModel / logRound 一站式 / 异常静默降级）；`tsc --noEmit` 过滤 TS2318/TS2552 后 0 业务错误；`rm -rf out && electron-vite build` 通过（main/preload/renderer 均成功，renderer 含 TokenStatsPanel）。全量 vitest **81 用例 69 通过 / 12 失败**（+16 全过）；12 失败为既有环境问题（learning-summary 真实数据漂移 2 / functional `app.isPackaged` 1 / app.test 云端 ECONNREFUSED 1，以及沙箱受限下偶发的 sync 超时与 safe-delete 清理拦截），与本次改动无关。
- **优先级**：已完成（2026-08-19）
- **记录时间**：2026-08-19

## [ISSUE-011] npm run dev 启动卡死/强制退出：启动同步整篇读+哈希 1925 文件阻塞主进程事件循环

- **类型**：性能 / 稳定性 BUG（待修复）
- **现象**：`npm run dev` 启动后日志出现：
  ```
  [NODE-CRON][WARN] missed execution at ...13:32:00... Possible blocking IO or high CPU user at the same process used by node-cron.
  [ERROR] Network service crashed or was terminated, restarting service.
  Version check: current=0.1.0, latest=0.1.0
  Sync complete: {"1f050a7f-...":{"uploaded":1,"downloaded":0,"skipped":1924}}
  ```
  随后 App 无响应，必须强制退出。
- **根因（已确认）**：`electron/lib/sync-manager.ts` 的 `scanChildFiles`（21-48 行）在 `syncChild`（113 行）内被**同步**调用（121 行 `const localFiles = scanChildFiles(childId);`）。它递归遍历孩子目录，对每个文件 `fs.readFileSync` 整篇读入内存 + `crypto.createHash("sha256").update(content)` 全量哈希 + `fs.statSync`，**全部同步、无 `await`、不释放事件循环**。一个孩子的 1925 个文件（日志 skipped:1924 + uploaded:1）被整篇读+哈希 → 主进程事件循环被长时间阻塞，表现为：
  1. node-cron 的每分钟 tick 在 13:32:00 无法触发 → WARN「blocking IO」；
  2. 主进程卡死导致 Chromium **network service**（独立进程）失联 → 「Network service crashed」；
  3. 整个 App 无响应 → 只得强制退出。
- **附带问题**：`main.ts:105` 注释写「Sync: ... (non-blocking)」是**错的**——`syncAllChildren`（main.ts:106）虽用 `.then()` 包裹，但内部 `scanChildFiles` 同步重 IO 仍阻塞事件循环；同样问题的还有 `fullSnapshot`（216 行）、`pushChildChanges`（208 行）经 `syncChild` 复用的扫描。
- **排查 / 修复入口（可直接执行）**：
  - 阻塞点：`electron/lib/sync-manager.ts:21-48` `scanChildFiles`（同步 `readFileSync`/`statSync`/`createHash`）；调用方 `syncChild` 121 行、`syncAllChildren` 190-203 行（启动时 main.ts:106）。
  - 启动顺序：`electron/main.ts:103-113`（`startScheduler` → `runCatchUp` → `syncAllChildren` → `createWindow` → `checkForUpdates`）。
  - 典型触发条件：孩子数据目录文件多（本例 1925）时必现；文件少时阻塞短、可能不暴露。
- **候选修复方向（待定，优先不阻塞主进程）**：
  1. **扫描改为异步 + 让出事件循环**：`scanChildFiles` 用 `fs.promises.readdir/readFile`，并在每 N 个文件后 `await new Promise(r => setImmediate(r))` 让出；或改用**流式哈希**（`crypto.createHash` + `fs.createReadStream` 管道）避免整篇入内存。
  2. **移出主进程**：把扫描/哈希放到 Worker 线程或子进程（如 `worker_threads` / `child_process`），主进程事件循环完全不受阻。
  3. **推迟/降优先级**：启动同步延后到窗口显示后再做，或改为「先只列目录 + mtime/size 快速比对，疑似变更再哈希」，减少无谓全量读。
  4. **纠正注释**：`main.ts:105` 的「non-blocking」与实际不符，改实现或改注释。
  5. **顺带**：确认 `runCatchUp`（main.ts:104，启动补跑定时任务）在任务开启时同样会 `createAgentSession` 重活阻塞主进程，需一并评估是否 offload。
- **关联**：与 ISSUE-010（token 统计）无直接关系；但同为「重型同步操作阻塞主进程」这一类问题，修复范式（异步化 / 移出主进程）可复用。
- **修复记录（2026-08-19 实施）**：
  1. **扫描全异步 + 流式哈希 + 让出事件循环（根治）**：`electron/lib/sync-manager.ts` 重写——`scanDirectory(rootDir, excludeDirs?)` 全走 `fs.promises.readdir/stat`，每 `SCAN_YIELD_EVERY=20` 个文件 `await setImmediate()` 让出事件循环（node-cron tick / IPC / 窗口事件可插队）；哈希改用流式 `hashFile()`（`createHash` + `createReadStream` 管道，大文件不整篇入内存）；`scanChildFiles` 变异步（返回 `{path,size,mtimeMs}`，**不再预先读内容+哈希**）。
  2. **size 预过滤（降哈希次数）**：`syncChild` 只对「云端存在且 size 相同」的本地文件流式哈希比对（8 路 `mapLimit` 并发池）；size 不同直接判定为变更走 last-write-wins（size 不同 → hash 必不同，与原 `lf.hash !== cloud.hash` 语义等价）。哈希失败降级为 `""` 走 last-write-wins。
  3. **并行与异步补齐**：`syncAllChildren` 改 `Promise.all` 孩子间并行；云不可达 fallback 与 `fullSnapshot` 改 `uploadAllLocal`（8 路并发上传）；下载/写盘改 `fs.promises`。
  4. **配套测试**：`test/sync-scan.test.ts`（4 用例，全过）：相对路径/size/mtimeMs 正确、排除 `.pi` 且 `.` 开头文件不排除、不存在目录返回 `[]` 不抛错、流式哈希与同步 sha256 一致（512KB）、扫描期间 `setImmediate` 被调用（验证让出）。**踩坑**：测试里用 `setInterval` 计数会让 vitest threads worker 无法退出而静默崩溃（无输出直接 exit 1），改用 `vi.spyOn(global, "setImmediate")` + `finally mockRestore` 规避；`--pool=forks` 可绕过但不应全局改。
  5. **验证**：`tsc --noEmit` 过滤 TS2318/TS2552 后 0 业务错误；`rm -rf out && npm run build` 通过；全量 `vitest run` **65 用例 53 通过 / 12 失败**（基线 61/49/12，+4 用例全过，失败项零新增）。12 个失败全为既有环境/数据问题：learning-summary 数据漂移（280→282 已学、next 变化）、sync.test 本地模拟扫描真实大目录超时（其 `scanChildFiles` 为测试内嵌模拟函数，不 import sync-manager，与本次无关）、functional `app.isPackaged`、app.test 云端 ECONNREFUSED、auto-new-session/archive-limit safe-delete 拦截 rmSync。
  6. `main.ts` 无需改动：`withTimeout` 在事件循环可跑后真正生效（此前同步阻塞时 setTimeout 回调也无法触发，超时形同虚设——这是 ISSUE-011 与既有「串行化+超时」改动的关系点）。
- **优先级**：已完成（2026-08-19）
- **记录时间**：2026-08-19

## [ISSUE-012] 聊天输入框随内容自动增高（不用滚动即可看到全部输入内容）

- **类型**：UI 体验优化（待实现）
- **需求**：聊天输入框要**随输入内容的增加而自动增高**，让使用者不滚动就能看到整段要发送的内容；清空后高度回落。
- **现状（已定位）**：
  - JSX：`src/components/ChatWindow.tsx:664-676` 的 `<textarea rows={1} style={{ minHeight: 44 }} />`——固定单行起（最小 44px），内容超一行后**在框内滚动**，看不到完整输入。
  - CSS：`src/styles.css:1594-1603` `.chat-input textarea` 有 `resize: none; max-height: 120px`——即使 textarea 高度可调，也被 120px 硬顶，超出部分只能滚动。
- **实现要点 / 待确认（待定）**：
  1. **auto-resize 逻辑**：在 textarea 的 `onChange` 里先 `style.height="auto"` 再 `style.height = Math.min(scrollHeight, max) + "px"`（经典做法），或加 ref + `useEffect([input])` 统一调整；上限取现有 `max-height:120px` 还是放宽（如 160~200px）待定——上限之内「全部可见」，超过才滚动。
  2. **清空回落**：发送后 `setInput("")`（`ChatWindow.tsx:229`）时要重置高度到初始（44px），否则留高。
  3. **追加文本路径同样触发**：语音识别追加（263 行 `setInput(prev => ...)`）、上传文件回填（368 行）都要走同一增高逻辑。
  4. **容器对齐**：`.chat-input`（`styles.css:1585-1592`）是 `align-items: center`，textarea 变高后上传/语音/发送按钮建议改为 `flex-end` 对齐，避免按钮悬空居中。
  5. **Enter 发送 / Shift+Enter 换行**（667-672 行）行为不变；自动增高不影响换行。
- **排查 / 修改入口（可直接执行）**：`src/components/ChatWindow.tsx:664-676`（textarea JSX + onChange）、`src/styles.css:1594-1603`（`.chat-input textarea` 的 max-height/overflow）。
- **关联**：无（独立 UI 优化）。
- **已修复（2026-08-19 实施）**：
  1. `ChatWindow.tsx`：新增 `textareaRef`，用 `useEffect([input])` 统一调整——`el.style.height = "auto"` 后取 `Math.min(scrollHeight, 160)`。统一按 [input] 驱动，覆盖输入、语音追加（`setInput(prev => ...)`）、文件回填、发送清空（回落 44px）所有 setInput 路径。
  2. `styles.css`：`.chat-input` 的 `align-items: center` → `flex-end`（textarea 变高时上传/语音/发送按钮贴底对齐）；`.chat-input textarea` 的 `max-height: 120px` → `160px`（与 JS 上限一致）+ `overflow-y: auto` + `line-height: 1.5`（超过上限才滚动）。
  3. Enter 发送 / Shift+Enter 换行行为不变。
  4. 验证：`tsc --noEmit` 过滤 TS2318/2552 后 0 业务错误；`npm run build` 通过（renderer 含新 CSS/JS）。`out/` 需重新构建生效。
- **优先级**：已完成（2026-08-19）
- **记录时间**：2026-08-19

## [ISSUE-013] 梳理孩子 agent 知识库的「快速查询 / 快速写入」，查询与写入都要省 token

- **类型**：知识库结构 + 工具面专项优化（已梳理定稿 2026-08-20，待实施）
- **需求**：孩子 agent 的知识库（`data/children/<childId>/`）需要再做一轮梳理，目标：**快速查询**（agent 想找什么能低成本拿到）、**快速写入**（记录/更新省力），且**查询与写入都要省 token**。
- **基线（已存在，先对齐）**：
  - 结构已按 `LEARNING-DATA-REDESIGN.md`（P0–P6 方案，项目根，239 行）落地：`daily/` 单一真相源（4 区块：学习/生活/问答/任务）+ `learning/`（topics.md 索引 + rules.md + 各主题 `{topic}.md` 进度/method.md/materials/）+ `life/{月}.md` 月索引（指针）+ `tags/` 倒排索引（taxonomy.md + 各 tag）+ `inquiries/`、`tasks/`、`outputs/`。
  - **进度查询省 token 已解决（ISSUE-006，已完成）**：`learning-summary.ts` 只解析 frontmatter → `progressSummaryToMarkdown` 注入系统提示顶部概览（`pi-session.ts:288`）；`get_progress` 工具（`custom-tools.ts:105`）只回 frontmatter；AGENTS.md 明令「严禁 read 进度文件正文取 next」。
  - 当前实测数据点：`daily/` 已有 **101 个文件**（2026-04-22 起）；论语进度文件正文 514 课；`topics.md` 8 主题；AGENTS.md 约 2.5KB。
- **缺口清单（梳理所得，待确认）**：
  1. **daily 无「总索引」，跨天检索贵**：101 个 daily 文件持续增长，agent 想查「上周学了什么/某主题的历史」只能按文件名猜 + 全量 read 多个 daily 文件；`life/{月}.md` 只索引生活事件，学习/问答/任务没有跨天入口 → 建议补 `daily/index.md`（`YYYY-MM-DD → 各区块摘要/指针`，追加友好），查询时先读索引再定点读区块。
  2. **daily 写入是「读全文 + edit」**：recording 记新内容需先读当天 daily 全文再 edit 重写；daily 文件内 4 区块会持续膨胀（追加友好设计没有兑现）→ 建议写入侧改为「区块追加行」（edit 只追加到目标区块尾部）或按区块分文件，避免整文件往返。
  3. **topics.md 数据双份**：同一份 8 主题在 frontmatter `topics` 数组 + 正文 markdown 表格各写一遍；`getLearningSummary` 只读 frontmatter，正文表格纯冗余（agent 可能误 read 全文）→ 建议删正文表格或标注「正文仅供人类查看，agent 只读 frontmatter」。
  4. **旧结构遗留文件未清**：`study-topics.md`（frontmatter `topics: {}` + 空表格）、`study-rules.md`（空）、`life-events.md`（旧单文件）仍在孩子目录根，是 P5 迁移残留 → agent 可能误读浪费 token，建议清理或标 `deprecated` 排除。
  5. **inquiries/ tasks/ 月索引缺口**：recording skill 只写 daily + life 索引 + tags 倒排（`recording/SKILL.md`），没有维护 `inquiries/{月}.md`、`tasks/{月}.md` 索引；`inquiries/`、`tasks/` 目录目前是空的 → 「零散问答/任务」的跨天检索无入口。
  6. **查询工具面单一**：现在只有 `get_progress`（进度）+ `display_content`（展示）。「快速查询」建议补结构化小读工具（如 `kb_read {kind: daily|life|tags|learning, ref}` 只回目标区块/摘要，替代 read 整文件）；「快速写入」建议补 `kb_append {file, section, content}`（追加友好，替代 edit 读改写）。
  7. **AGENTS.md 每轮全量注入**：AGENTS.md 作为 `<project_context>` 每次开会话都注入（现 2.5KB，custom 段会长大）；「省 token」可考虑核心段常驻 + 扩展段按需（如把 method/资料清单移出 AGENTS.md 只留指针，redesign 已强调「只放去哪读的指引」，需复核是否仍干净）。
  8. **大 progress 正文的按需读取**：study-tracker 需核对逐课状态时仍要读全文（论语 514 课）→ 可考虑「分批读 / 只读目标课段落 / frontmatter + 尾段 next 区」的降本策略（与 ISSUE-006 配套，但 ISSUE-006 只解决了「取 next」）。
- **省 token 的通用原则（写入记录，供方案设计）**：查询 = 先索引/摘要后定点小读，绝不整文件 read；写入 = 追加优先、避免读改写；查询型数据（进度/索引）与内容型数据（daily 详情/资料）分离；工具面替代自由 read/write。
- **排查 / 修改入口（可直接执行）**：
  - 结构真源：`data/children/<childId>/`（daily/ learning/ life/ tags/ inquiries/ tasks/ outputs/ + 遗留文件）。
  - 注入/模板：`electron/lib/pi-session.ts`（AGENTS.md 模板 `buildAgentsMd` 16-91 行、进度概览注入 288 行）；`electron/lib/learning-summary.ts`（frontmatter 解析）。
  - 工具注册：`electron/lib/custom-tools.ts`（工具列表 42 行起、`get_progress` 105 行、`display_content` 13 行）。
  - 写入方：`data/shared/skills/recording/SKILL.md`（daily + life + tags 写入流程）。
  - 基线设计：`LEARNING-DATA-REDESIGN.md`（P0–P6 已实施项，本次在它之上做查询/写入效率层）。
- **关联**：ISSUE-006（进度查询省 token，已解决，本 issue 是它的推广/泛化）；ISSUE-010（token 统计——落地后可量化验证本优化效果：查询/写入前后 token 对比）；ISSUE-009（method 记录详细度——写入质量与写入成本需平衡）。
- **优先级**：待定（用户未标注，建议中优先级：不影响功能，但随 daily 增长会越来越贵）
- **记录时间**：2026-08-19

### 设计方案（2026-08-19 产出，待用户确认后实施）

**设计原则**：查询 = 先索引/摘要后定点小读，绝不整文件 read；写入 = 追加优先、避免读改写；查询型数据（进度/索引）与内容型数据（daily 详情/资料）分离；工具面替代自由 read/write。

**现状核对（2026-08-19 实测）**：daily/ 101 个文件；topics.md frontmatter + 正文表格双份冗余（8 主题各写两遍）；根目录遗留 `study-topics.md`（frontmatter topics:{} + 空表格）、`study-rules.md`（空）、`life-events.md`（旧单文件）；inquiries/ 与 tasks/ 目录为空、无月索引；life/ 仅 2026-08.md。

**方案分三层**：

1. **结构层（数据）**
   - **新增 `daily/index.md`（跨天总索引）**：追加友好，每行 `- YYYY-MM-DD 学习:{主题数/摘要} 生活:{事件数} 问答:{数} 任务:{数}`，agent 查「上周学了什么」先读 index 再定点读目标 daily。
   - **topics.md 去重**：删正文表格，frontmatter 为唯一真源（`getLearningSummary` 只读 frontmatter，正文表格纯冗余且诱导 agent 误 read 全文）；文件头注释「正文仅供人类查看，agent 只读 frontmatter」。
   - **清理遗留文件**：`study-topics.md` / `study-rules.md` / `life-events.md` 数据已迁至 daily/life/learning 结构（P5 迁移残留）→ 建议直接删除（保留会误导 agent 误读浪费 token；内容已迁移无丢失风险）。
   - **inquiries/ tasks/ 月索引**：recording skill 增加维护 `inquiries/{YYYY-MM}.md`、`tasks/{YYYY-MM}.md`（追加行，指针指向 daily 锚点），与 life/{月}.md 一致。
   - **daily 写入改「区块追加」**：recording skill 明确「读目标 daily 时只取区块位置，edit 仅追加到目标区块尾部」，避免整文件读改写（4 区块会持续膨胀，追加友好设计需兑现）。

2. **工具层（agent 面，custom-tools.ts 新增，替代自由 read/write）**
   - **`kb_read {kind: daily|life|tags|learning|inquiry|task, ref}`**：只回目标区块/摘要（如 daily+日期→该日「学习」区块；life+月→月索引行），childId 由 ctx.cwd 推导；绝不整文件返回。
   - **`kb_append {file, section, content}`**：追加友好——向指定文件的目标区块（## 标题）尾部追加内容，免「读全文 + edit 重写」；仅允许追加到白名单文件（daily/*、life/*、tags/*、inquiries/*、tasks/*、AGENTS.md 的 custom 段），路径守卫同 display_content。
   - 与 `get_progress`（进度查询）形成「结构化小工具族」，替代 agent 对知识库的自由 read/write。

3. **注入层（上下文）**
   - **AGENTS.md 瘦身**：核心段（身份/交流准则）常驻；长内容（method 清单、资料目录等）移出只留指针，`buildAgentsMd` 复核是否仍干净（redesign 强调「只放去哪读的指引」）。
   - **daily/index.md 注入权衡**：是否把「最近 N 天」指针注入系统提示（方便 agent 直接知道最近学了什么）——注入增加固定 token 成本（N 天×1 行），建议先不注入、靠 kb_read 按需取，落地后用 ISSUE-010 统计对比再定。

**实施顺序（防漂移，分 4 步）**：
- Phase 1 结构：清理遗留文件 + topics.md 去重 + 新建 daily/index.md（脚本回填 101 天历史索引）
- Phase 2 工具：`kb_read` / `kb_append` 实现 + customTools 注册 + 单测（路径守卫/区块追加/回读正确性）
- Phase 3 规范：recording skill 更新（区块追加 + inquiries/tasks 月索引）+ AGENTS.md 工具指引
- Phase 4 验证：build + 全量测试 + 用 ISSUE-010 token 统计对比「查询/写入前后 token」量化收益

**待确认项**：① 遗留 3 文件直接删除 vs 标 deprecated 排除（建议删除，数据已迁移）；② daily/index.md 全量回填 vs 今日起增量（建议脚本全量回填一次，成本低收益完整）；③ 工具命名/参数（kb_read/kb_append 可改）；④ 是否注入 daily/index 到系统提示（建议先不注入）。

### 已定稿方案（2026-08-20，与 LEARNING-DATA-SPEC.md 一致）

**数据结构定稿**（详见 `LEARNING-DATA-SPEC.md`，现为唯一权威）：
- **不建 `daily/index.md`**（推翻原建议）：daily 文件名即日期 = 时间线索引；跨天查询用 `kb_read` month 聚合**按需生成**（不持久化、不漂移）。
- daily 详式定稿（`### 标题`+字段，孩子表现/概要必填详写）；进度文件每课加 `tags::`（**创建知识点时**一次性选定，不归 recording）；`outputs/` 启用（产物统一归位）；topics.md frontmatter 唯一真源（删正文表格）；inquiries/tasks 月索引由 recording 补维护；旧结构残留（life-events/study-topics/study-rules）删除；tags 倒排失效链接修复。

**工具定稿**（5.3/5.4/5.5 节）：
- `kb_read {file, block?, item?, listOnly?}`（含 month 聚合）；`kb_patch {file, item?, field?, value, fields?}`（定位更新，内容不进上下文，frontmatter 用 `frontmatter:key`）；`kb_append {file, block, content}`（区块尾追加）。共用定位器 + `kb-parser.ts`（纯函数，支持 `- 键：值` 与 `键:: 值` 两种格式）。
- **schema 约束四层保障**：L1 数据文件写入走 kb 工具收口（数据/内容文件分流）；L2 字段白名单（`kb-schema.ts` 单一真源，kb 工具与 lint 共享）；L3 AGENTS.md + recording 行为约束；L4 **lint 定时校验**（确定性脚本 `scripts/kb-lint.mjs`，app 启动时 + 每 24h，只报告不修改，报告落 `data/children/{childId}/lint-report.md`）。
- 已知限制：SDK 内置 write/edit 无法按路径禁止（内容文件需要），L1 依赖 L3+L4 兜底。

**实施清单（Phase 0–4）**：
- **Phase 0 规范补充（先定死规则）**：①SPEC 3.6/3.7 补「索引条目标题与 daily `###` 标题**同名**」约束（指针精确定位的根基）；②SPEC 5.3 补 `kb_read` 的 `ref` 简写（`daily/2026-08-13.md#生活` → `{file, block}`）；③SPEC 5.5 lint 校验加第③条「同标题条目存在」（指针三级校验：文件存在→区块存在→同标题条目存在）；④确认进度文件**不加**指向 daily 的指针（B 方案：进度管进度、复习次数承载频次，反查走 daily 文件名+课程名字段）。
- **Phase 1 结构迁移**：①删遗留 3 文件（life-events/study-topics/study-rules）+ 空壳孩子 `daily-logs/`；②topics.md 删正文表格；③产物移入 `outputs/`（番茄钟.html/pomodoro.html/tomato-timer.html）；④修 tags 倒排失效链接（`learning/lunyu.md` → `learning/lunyu/lunyu.md`）；⑤统一 life/2026-08.md 旧散文为索引行格式。验证：ls + 抽查 + tsc。
- **Phase 2 工具实现**：①`electron/lib/kb-parser.ts`（纯函数：frontmatter/区块/条目/字段，两种字段格式 `- 键：值` 与 `键:: 值`）；②`kb-schema.ts`（字段白名单单一真源）；③`custom-tools.ts` 注册 `kb_read`（含 ref 简写/listOnly/month 聚合）/`kb_patch`（frontmatter:key/批量 fields）/`kb_append`；④`pi-session.ts:341` tools 白名单同步；⑤单测（定位/追加/回读/路径守卫/ref 解析/未知字段拒绝）。验证：vitest 新用例全过 + `tsc` 过滤后 0 业务错误 + `npm run build`。
- **Phase 3 规范更新**：①`recording/SKILL.md` 补 inquiries/tasks 月索引步骤 + 索引标题与 daily 同名 + 写入走 kb 工具；②`LEARNING_NAV_INSTRUCTIONS`（pi-session.ts）加「数据文件禁止裸 write/edit，一律走 kb 工具」；③跑 `scripts/regenerate-agents.mjs` 刷新。验证：regenerate 后 AGENTS.md 含新指令。
- **Phase 4 lint + 验证**：①`electron/lib/kb-lint.ts`（校验：目录结构/daily 文件名/字段白名单/格式一致性/取值约束/指针三级校验/frontmatter 可解析）；②`scripts/kb-lint.mjs`（CLI + 主进程调用）；③主进程接入（启动时 + 每 24h，报告落 `data/children/{childId}/lint-report.md`，只报告不修改）；④端到端：新会话用 kb 工具读写验证 + ISSUE-010 token 对比量化（可选）。验证：lint 对现有 108 个 daily 跑出基线报告 + 主进程启动日志。
- **验收总则**：`LEARNING-DATA-SPEC.md` 为唯一权威，冲突以 SPEC 为准；每 Phase 完成跑 `tsc`（过滤 TS2318/2552）+ build + 相关测试。

### 实施进度（2026-08-20 已完成 Phase 0–4）
- **Phase 0 ✅**：SPEC 补指针规范（3.6/3.7 同名约束、5.3 ref 简写、5.5 lint 三级校验、3.4 B 方案注明）；daily 示例更新为实际 `- **键：** 值` 加粗格式。
- **Phase 1 ✅**：删主账号 life-events/study-topics/study-rules 残留；topics.md 删正文表格；产物移入 outputs/（番茄钟/pomodoro/tomato-timer）；tags 倒排 20 个文件失效链接修复（learning/lunyu.md → learning/lunyu/lunyu.md）；daily/2026-08-11.md 生活区块与 life/2026-08.md 统一为规范格式（`### 做番茄钟网页` + 索引行，同名）。
- **Phase 2 ✅**：新建 `electron/lib/kb-parser.ts`（结构解析纯函数，支持 `- 键：值`/`键:: 值`/`**键：** 值` 加粗三种形态）+ `kb-schema.ts`（字段白名单，含 recording 主流字段扩展）；custom-tools.ts 注册 kb_read（ref 简写/listOnly/month 聚合）/kb_patch（frontmatter:key/批量 fields/白名单拒绝）/kb_append（区块尾追加/白名单拒绝）；pi-session.ts tools 白名单 + customTools 同步；单测 `test/kb-parser.test.ts`（19 用例）+ `test/kb-tools.test.ts`（11 用例）全过。
- **Phase 3 ✅**：recording/SKILL.md 补第 5/6 步（inquiries/tasks 索引）+ 同名约束 + 第 7 节 kb 工具写入指引；LEARNING_NAV_INSTRUCTIONS 加「数据文件禁止裸 write/edit」；regenerate-agents.mjs 刷新（1 孩子）。
- **Phase 4 ✅**：新建 `electron/lib/kb-lint.ts`（校验：目录/文件名/字段白名单/格式一致性/取值约束/指针三级/frontmatter）+ `scripts/kb-lint.mjs`（CLI，node --experimental-strip-types）+ main.ts 启动时 + 每 24h 定时接入；**实测主账号 error=0 / warning=1436（历史基线字段）**；lint 跳过无 profile.json 的测试残留目录（~150 个）；daily 未知 ## 区块（评估区块）不检查。
- **验证**：kb 相关 30 用例全过；tsc 过滤后 0 业务错误；npm run build 通过；全量 vitest 无新增失败（既有环境性失败不变）。
- **遗留待办**：① 历史 daily（4-6 月）warning 1436 条为基线不迁移（历史即事实）；② study-tracker 评估区块文案引用 `study-rules.md` 已删除，需改为 `learning/rules.md`（后续随 study-tracker 更新）；③ 测试残留目录（ans-*/cont-* 等 ~150 个）堆积问题独立处理。

## [ISSUE-014] 左侧学习资料应自动显示最新资料，不要停在列表等手动点开

- **需求**：左侧「学习资料」面板要**自动显示最新的那份资料**；不要停在列表视图、让用户再点开最新的。用户原话：「不要返回列表再点开最新的」。
- **现状（已定位）**：
  - 会话进行中：`display_content` 工具结束 → `Learn.tsx` 新资料入列后自动弹开——**此链路旧实现实际从未生效**（详见下方 2026-08-19 二次修复的根因说明，初次登记时误判为「已自动弹开」）。
  - **缺口在会话恢复/重进**：恢复材料列表只 `setMaterials(r.materials)`，没有设置 `selectedMaterialId` → 面板停在列表视图（`MaterialsPanel.tsx:66-92`），用户必须手动点开最新一份。
  - 列表顺序：主进程 `getSessionMaterials`（`pi-session.ts:637-684`）按 session 历史顺序 push，**最新一份在数组末尾** → 可直接 `materials[materials.length - 1]` 取最新。
- **实现要点（候选，待定）**：
  1. 恢复材料列表后自动选中最新：`setSelectedMaterialId(r.materials[r.materials.length - 1]?.id ?? null)`（注意 id 是主进程重建的 `mat-*`，恢复后与 `materials` 一一对应，可用）；
  2. 触发时机取舍：仅「恢复/初始」时自动打开，还是「每次切回 materials 视图」都自动跟随最新（后者可能与用户主动点「返回列表」看历史的意图冲突，需确认）；
  3. 空列表时保持列表态（占位文案）不变。
- **排查 / 修改入口（可直接执行）**：`src/pages/Learn.tsx:152-155`（恢复材料）、`src/pages/Learn.tsx:198-222`（会话中自动弹开参照）、`src/components/MaterialsPanel.tsx:43-94`（两态渲染）、主进程 `electron/lib/pi-session.ts:637-684`（材料重建顺序）。
- **待确认项**：① 自动打开时机（仅恢复 vs 始终跟随最新）；② 用户显式「返回列表」后，新资料到达是否仍自动弹开（现实现是会的——若用户认为「返回列表后不该被打断」则需加状态判定）。
- **关联**：ISSUE-002（重发资料去重——本 issue 的「自动弹开」依赖同一 `display_content` 去重机制，避免弹开重复条目）。
- **已修复·第一轮（2026-08-19 白天）**：恢复材料后自动选中最新（`pi:start_child` 回调里 `setSelectedMaterialId(materials[length-1].id)`），解决「重进停在列表」。但**用户实测发现会话中第二份资料仍未自动切换**。
- **已修复·第二轮（2026-08-19 晚间，根因修正）**：
  - **根因**：会话中自动弹开的旧实现 `Learn.tsx:222` 是「在 `setMaterials(updater)` 里给闭包变量 `targetId` 赋值，再同步 `if (targetId) setSelectedMaterialId(targetId)`」——React 18 中 **updater 异步执行（render 阶段才跑）**，同步检查时 `targetId` **恒为 null**，自动弹开从未生效。第一份资料能显示是恢复逻辑选中的；会话中第二份 `display_content` 到达时无任何切换 → 左侧停留在第一份。初次登记「这条没问题」系误判。
  - **修复**（`src/pages/Learn.tsx`）：删除失效的 `targetId` 闭包赋值与同步 set；`handleToolEnd` 的 updater 只负责去重/追加（去重返回原引用时 React bail-out、effect 不触发）；新增 `useEffect(() => { if (materials.length === 0) return; setSelectedMaterialId(materials[materials.length - 1].id); }, [materials])`——渲染后最新状态已就绪，统一处理「会话中新增」「恢复回填」两种路径的自动打开；用户返回列表（materials 未变）不被打断，新材料到达则自动切到最新（待确认项②按「会弹开」默认）。
  - 验证：`tsc --noEmit` 过滤后 0 业务错误；`npm run build` 通过。手测路径：进入珊珊会话 → 让 AI 连续展示两份资料 → 第二份到达时左侧应自动切换到第二份。
- **优先级**：已完成（2026-08-19）
- **记录时间**：2026-08-19

## [ISSUE-015] 语音转写失败（ffmpeg）：Invalid data found when processing input——MediaRecorder 半成品 webm 未拦截

- **类型**：bug / 已修复（2026-08-19）
- **现象**：语音识别报错 `音频转换失败（ffmpeg）：[in#0] Error opening input: Invalid data found when processing input ... stt-in-*.webm`。
- **根因（本机已复现确认）**：用 ffmpeg-static 实测——**0 字节输入**与「只有 EBML 容器头」的**半成品 webm** 报错与用户完全一致（Invalid data）；有效 webm（≥250ms opus）转换正常。即写入临时文件的录音数据是**空/半成品**（MediaRecorder 极短录音或麦克风无数据时，Chromium 输出仅含容器头、无音频帧的 webm）。前端 `blob.size < 200` 阈值太松（半成品可达数百字节），主进程无兜底。
- **修复**：
  1. `electron/lib/voice/audio.ts` `webmToWav16k`：输入 `< 2000` 字节直接快速失败（报「录音数据过短或为空（N 字节）」，不调 ffmpeg）；ffmpeg 失败时**保留原始 tmpIn 文件**（tmpdir 系统清理）并把输入字节数 + 保留路径带进错误消息便于复现排查（cleanup 不再删 tmpIn）。
  2. 前端阈值统一收紧：`src/components/ChatWindow.tsx` 与 `src/components/VoiceSettings.tsx` 的 `blob.size < 200` → `< 2000`（有效录音 ≥250ms opus 远超 2KB，不误伤）。
- **验证**：新增 `test/voice-audio.test.ts` 4 用例全过（0 字节快速失败 / <2000 字节快速失败且带字节数 / 有效 webm 转 16k WAV 且 RIFF+16000Hz+单声道正确 / ffmpeg 失败时错误含输入大小且原始文件确实保留）；`tsc --noEmit` 过滤 TS2318/2552 后 0 业务错误；`electron-vite build` 通过；全量 vitest 85 用例 73 过 / 12 失败（+4 全过，12 为既有环境问题）。`out/` 需重新构建生效。
- **优先级**：已完成（2026-08-19）
- **记录时间**：2026-08-19

## [ISSUE-016] 家长页删除孩子账号后返回主页，密码输入框无法选中（点击无光标），需最小化再点开才恢复

- **类型**：bug / 待排查（用户未标注）
- **现象**：家长中心（Dashboard）删除测试孩子账号后，点「← 返回主页」，主页点击孩子卡片出现密码输入框后，**点击输入框无光标、无法输入**；只有**最小化再点开 App** 才能选中输入框、出现输入光标。
- **代码锚点（已定位）**：
  - 删除流程：`src/pages/Dashboard.tsx:56-61` `handleDeleteChild` → **`confirm()`**（渲染进程同步原生模态对话框）→ `child:delete` IPC（`electron/preload.ts:103`）→ `refresh()`。
  - 返回主页：`src/App.tsx:66` `onEnterChildMode={() => setView("home")}`——App 是 `switch(view)` 条件渲染（`App.tsx:40-87`），view 变化 → **Home 全新卸载/挂载**，`autoFocus`（`Home.tsx:107`）会重新触发。
  - 密码输入框：`src/pages/Home.tsx:100-109`（`type="password"` + `autoFocus` + `outline:none`），条件 `selectedChild &&`（97 行）——回主页时 `selectedChild` 初始为 null，输入框此时未挂载，点孩子卡片后才挂载。
  - 孩子列表：`Home.tsx:24-26` `childList()` 仅挂载时加载一次（删除后回主页会拉到新列表）。
  - 主进程 `child:delete` 实现（`electron/lib/ipc-handlers.ts`）无任何焦点操作，可排除主进程主动夺焦。
- **根因假设（待验证，非结论）**：
  1. **`confirm()` 模态对话框焦点残留（最吻合）**：Electron 渲染进程的 `confirm()` 是原生模态对话框，Windows 上关闭后 BrowserWindow/webContents 的键盘焦点可能未正确归还 → 页面可见可点但焦点处于异常态（点击 input 不出现光标）；**最小化/还原强制系统重新聚焦窗口 → 恢复**，与该症状完全吻合。Electron 官方亦不推荐渲染进程 `confirm()`，建议用主进程 `dialog.showMessageBox`（`main.ts:33` 已有现成用法范式）。
  2. `autoFocus` 竞争：输入框在 confirm 关闭后的焦点异常窗口期挂载，`autoFocus` 失败，且点击无法抢回焦点。
  3. 与删除内容本身无关（重置密码、新增孩子等其它操作后回主页是否同样出现，可缩小范围验证）。
- **候选修复方向（待定）**：
  1. **替换 `confirm()`** 为 `dialog.showMessageBox`（主进程，`main.ts:33` 范式），从根上消除原生模态焦点残留——最治本；
  2. 或在 Home 输入框挂载后主动 `focus()`（useEffect + ref 兜底），或在 `setView("home")` 后主进程 `mainWindow.focus()` / `webContents.focus()`；
  3. 验证手段：复现后最小化/还原可恢复 → 确认窗口级焦点问题；修完跑 `npm run build` 后手测删除→回主页→点输入框。
- **排查 / 修改入口（可直接执行）**：`src/pages/Dashboard.tsx:57`（`confirm()` 调用点）；`src/pages/Home.tsx:97-109`（输入框与 autoFocus）；`src/App.tsx:66`（返回主页）；主进程 `electron/main.ts:33`（`dialog.showMessageBox` 复用范式）。
- **待确认项**：① 是否每次必现、是否仅删除后出现（其它操作对比）；② 点击输入框时窗口标题栏/其它控件是否可交互（判断是窗口级还是页面级焦点问题）；③ 用 `dialog.showMessageBox` 替换后是否消失。
- **关联**：无直接关联（独立的 UI 焦点问题）。
- **已修复（2026-08-19 实施）**：采用治本方案 #1——替换渲染进程 `confirm()`。
  1. `electron/lib/ipc-handlers.ts` 新增 `dialog:confirm` handler：用 `dialog.showMessageBox`（type:"warning"，按钮「取消|确认」，`defaultId:0`/`cancelId:0` 默认取消，`noLink:true`），返回 `{confirmed}`。
  2. `electron/preload.ts` 新增 `confirmDialog` 桥接。
  3. `src/pages/Dashboard.tsx` `handleDeleteChild` 改为先 `await window.api.confirmDialog({title:"删除孩子", message, detail:"此操作不可撤销…", confirmLabel:"删除", cancelLabel:"取消"})`，`confirmed` 才执行 `childDelete`。
  4. 从根上消除 Windows 原生模态 confirm() 的焦点残留（最小化/还原才恢复的症状即为窗口级焦点未归还）；删除确认默认指向「取消」，防误删。
  验证：`tsc --noEmit` 过滤后 0 业务错误；`npm run build` 通过（main/preload/renderer 均成功）。手测路径：家长中心删除孩子 → 返回主页 → 点孩子卡片 → 密码输入框应可直接聚焦输入（需构建后复测确认）。

## [ISSUE-019] 家长页孩子学习进度展示——方案设计（内容 / 形式 / 技术方案）

- **类型**：需求 / 方案设计（待拍板后实施）
- **目标**：家长页能**快速掌握孩子学习情况的关键点**，聚焦三件事：
  1. **进度是否匹配计划**——实际进度 vs 每日计划目标，超前还是落后；
  2. **学习中的错误和误解**——最近出现过哪些错误/误解、涉及哪些知识点；
  3. **学习中的亮点和进步**——值得表扬的亮点（好问题、好例子、进步、情绪正面反应）。
- **现状（已定位）**：
  - 展示层 `src/components/ProgressView.tsx`（Dashboard「学习进度」视图，`Dashboard.tsx:216`）：已有一级进度条（learned/total/percent/下一课/最近更新）+「今日评估」表（rules 的 daily 目标 vs `updated` 是否今天）+「最近日志」（dailyLogs 最近 3 个 `<details>` 折叠全文）。
  - 数据层 `electron/lib/learning-summary.ts` `getLearningSummary()`（110-184 行）经 `getProgress` IPC 供前端：只含 topics（name/file/learned/total/percent/next/updated/daily/type）+ totals。
  - **错误/误解、亮点/进步：现有数据层与展示层均无**——需从 `daily/` 记录提取（recording skill 已在 daily 记「孩子表现：原话/例子/提问/情绪/思考/纠正过程」，见 ISSUE-009）。
- **方案要点（候选，待拍板）**：
  - **① 进度 vs 计划**：
    - 数据：`learning-summary` 已有 daily 目标与 learned；**缺「按日期的 learned 历史快照」**——候选：a) 约定 recording 在 daily 文件里记当天各主题 learned（结构化字段），由主进程扫描 daily 汇总出「计划累计线 vs 实际累计线」；b) 简单版：只算偏差 = 实际 learned − (daily × 已过天数)，显示「超前/落后 N 课」。
    - 形式：每主题一个「计划 vs 实际」对比（折线/进度双条），落后标黄/红、超前标绿。
  - **② 错误和误解**：
    - 数据：daily 记录里的「纠正过程」段；需与 recording 约定**结构化标记**（如 `### 错误与纠正` 小节或 `- 误解：… / 纠正：…` 条目）以便脚本提取（依赖 ISSUE-009 把记录写细）。
    - 形式：最近 N 天「常见错误清单」卡片（知识点 + 孩子的原始说法 + 纠正结果），错误用暖色（橙/红）标注，可折叠看原文。
  - **③ 亮点和进步**：
    - 数据：daily 记录的「孩子表现」段正面内容（原话/例子/提问/思考过程）。
    - 形式：亮点时间线/卡片（如「8/19 提出了一个好问题：…」「自己举了例子：…」），绿色高亮，配 emoji。
  - **技术方案（主进程汇总 + 前端渲染）**：扩展 `learning-summary.ts`（或新增 `learning-insights.ts`）扫描 `daily/` 生成 `{ errors: [...], highlights: [...], planDiff: {...} }`，经新 IPC（如 `progress:insights`）下发；前端 `ProgressView` 增加三个区块（或独立 `LearningInsights` 组件）。提取逻辑放主进程，避免全文注入上下文（呼应 ISSUE-013）；daily 全文仍保留 `<details>` 折叠供家长下钻。
- **前置依赖**：**ISSUE-009**（method 记录详细度对齐 recording skill）必须先落地，daily 记录才包含可供提取的错误/亮点信息；否则②③无数据可挖。
- **待确认项**：① 三块的优先级/首版范围（是否先做①简单版，②③依赖 009）；② 错误/亮点的**结构化标记格式**由谁定（recording skill / method.md 内约定）；③ 是否按主题/时间维度聚合、是否要「近 7 天/本月」时间窗；④ 展示位置：并入现有「学习进度」视图 vs 家长中心新增独立视图。
- **排查 / 修改入口（可直接执行）**：展示 `src/components/ProgressView.tsx`（现有三块参照）；数据 `electron/lib/learning-summary.ts`（扩展点）+ 新 IPC（`electron/lib/ipc-handlers.ts` 的 `getProgress` 相邻注册）；数据源 `data/children/<childId>/daily/*.md`（recording 写入）；规范 `data/shared/skills/recording/SKILL.md`。
- **关联**：ISSUE-009（前置，记录详细度）、ISSUE-013（提取放主进程省 token）、ISSUE-006（进度数据复用 `learning-summary`）。
- **优先级**：待定（用户未标注，建议中高：家长侧核心价值，但依赖 009）
- **记录时间**：2026-08-19
- **优先级**：已完成（2026-08-19）
- **记录时间**：2026-08-19

## [ISSUE-020] 增加专门的「编程 agent」负责 HTML 制作，学习伙伴 agent 判断需要 html 时调用它，编程 agent 单独设置模型

- **类型**：需求 / 待实现（用户未标注）
- **需求**：新增一个**专门的编程 agent**，职责是制作给孩子看的 HTML 学习资料。当学习伙伴 agent（孩子会话）判断需要做 html 时，**调用这个编程 agent** 生成；编程 agent 要**单独设置模型**（与学习 agent 的默认模型不同，可选更强/更适配代码生成的模型）。
- **现状（已定位）**：
  - 现在 html 由**学习 agent 自己拼**：孩子 prompt（`pi-session.ts:139`）明确写「html 学习资料（给孩子看的展示版）由你灵活处理——手工拼 html 用 display_content 展示」；`display_content` 工具（`custom-tools.ts:13`）负责展示，内容来自 agent 现场生成或脚本预生成。
  - 孩子 agent 会话：`createAgentSession`（`pi-session.ts:332-343`），模型 `getDefaultModel()`（301 行），工具面 `read/write/edit/display_content/get_date/get_progress/kb_read/kb_patch/kb_append`。
  - **SDK 无内置子 agent 机制（已查证）**：`@earendil-works/pi-coding-agent` dist 中无 subagent/delegate/task tool——「agent 调 agent」不能靠 SDK 原生能力，必须**应用层编排**。
- **技术方案（候选，待拍板）**：
  - **编排链路**：学习 agent 新增 customTool（如 `create_html_lesson`，参数：标题/内容要求/输出相对路径）→ 主进程 handler 捕获 → 创建/复用**编程 agent 会话**（独立 model，如 qwen-max / deepseek-v4 中代码能力更强的项，与 `getDefaultModel()` 解耦）→ 编程 agent 依要求生成 HTML 落盘（`data/children/<childId>/learning/<topic>/materials/` 或与 display_content 的 path 约定一致）→ 返回 `{path, title}` → 学习 agent 再用 `display_content` 展示。
  - **编程 agent 会话**：独立 prompt（编程规范：儿童友好样式、可交互 JS 沙盒内自包含、文件落盘路径约束、无 method/知识库职责）；工具面收敛为 `read/write/edit/get_date`（不挂 display_content/kb_*）；会话文件按 childId 隔离存储（沿用现有 `data/children/<childId>/sessions/` 模式）。
  - **模型配置**：`pi-runtime.ts` 模型清单已支持多模型（ISSUE-007 已登记 DeepSeek V4 系列），新增「编程 agent 模型」配置项（默认值与家长可调，落 Settings 或 config.ts），`createAgentSession({ model })` 传不同模型即可（现有签名支持，`pi-session.ts:334-335` 参照）。
  - **触发判定**：学习 agent 何时调编程 agent 由 prompt 引导（如「需要给孩子展示 html 时调用 create_html_lesson」），或保持 display_content 兼容（编程 agent 产出后仍走 display_content 展示，前端 MaterialsPanel 无需改动）。
- **待确认项**：① 编程 agent 模型选哪个（qwen-max / deepseek-v4 系列 / 其它）；② 会话生命周期：每次生成新建一次性会话 vs 长期复用同一编程会话（影响 token 与历史累积）；③ 学习 agent 是「调工具」还是「发消息给编程 agent」语义（本方案按工具编排，更可控）；④ html 生成的输入来源（学习 agent 传需求摘要 vs 编程 agent 自行读进度/method）；⑤ 是否需要家长在 Settings 里配置编程 agent 模型。
- **排查 / 修改入口（可直接执行）**：`electron/lib/pi-session.ts:332-343`（学习会话 tools/customTools 扩展点）、`electron/lib/custom-tools.ts`（新增 `create_html_lesson` 工具定义）、`electron/lib/pi-runtime.ts`（模型清单/默认模型）、`electron/lib/ipc-handlers.ts`（工具 handler 编排处）、`pi-session.ts:362-383`（家长 agent 会话范式可参照建编程会话）。
- **关联**：ISSUE-007（模型登记——编程 agent 模型从现有清单选）、ISSUE-002/ISSUE-014（display_content 展示链路保持兼容）、ISSUE-013（编程 agent 读写知识库与否、token 开销需评估）。
- **已修复（2026-08-20 实施，决策点已拍板）**：
  1. **模型配置**：`app-settings.ts` 新增 `programmingModel` 配置项 + `getProgrammingModelKey`/`setProgrammingModelKey`（**默认空 = 未启用**）；`pi-runtime.ts` 新增 `getProgrammingModel()`（未配置/解析失败返回 null，不静默回退）。
  2. **编程会话**：新建 `electron/lib/programming-agent.ts`——`getProgrammingAgentSession(childId, sessionKey)` 按 sessionKey 复用同一会话（**不重置**，一份 HTML 的生成+修改上下文连续；缺省 key 按 outputPath 派生）；cwd=childDir、noSkills、tools 收敛为 `read/write/edit`（不挂 kb_*/display_content）、挂 learning-guard 扩展（越界拦截+日期注入）；`generateHtmlLesson` 做路径守卫（仅限学习目录内 .html/.htm）、预建目录、生成后校验落盘非空（<100 字节视为失败）。**未配置模型时抛错并提示家长到设置页配置**。
  3. **工具接入**：`custom-tools.ts` 新增 `createHtmlLessonTool`（参数 title/requirement/outputPath/sessionKey），学习 agent 经它调编程 agent；`pi-session.ts` 孩子会话 tools+customTools 加 `create_html_lesson`，`LEARNING_NAV_INSTRUCTIONS`「内容展示」段改为「html 不存在/需改 → 先 create_html_lesson 生成，再 display_content 展示；禁止手工拼长 HTML 塞 content」；`disposeAllSessions` 一并释放编程会话（顺带补上 026 家长 content 会话遗漏的释放）。
  4. **设置页**：`ipc-handlers.ts` 加 `pi:get_programming_model`/`pi:set_programming_model`，`preload.ts` 加桥接；`Settings.tsx` 模型配置页新增「编程 agent 模型」下拉（默认「未启用」，可选已配置的任意模型，可清空停用）。
  5. 验证：tsc 过滤环境告警后 0 业务错误；`test/programming-agent.test.ts` 4 用例全过（越界路径拒绝、非 html 扩展名拒绝、未配置模型报错提示、配置读写往返）；`npm run build` 通过；全量测试 141 通过 / 14 失败（两次全量失败集合不一致——kb-sqlite/auto-new-session 等单独跑均全过，为并行级联的环境性预存失败，与本次改动无关）。
- **优先级**：已完成（2026-08-20）
- **记录时间**：2026-08-20

## [ISSUE-022] 学习主题 method.md（用户自定义）里对 kb 工具调用的约定要写清，且需能「检测 + 自动修复」

- **需求**：method.md 是家长可自由编辑的内容文件，但其「记录」段会规定 agent 如何调用 kb 工具（主要是 `kb_append` 写 daily）。这类 kb 工具调用的**约定要标准化、可校验**，并且系统要能**检测 method.md 里的陈旧/错误 kb 工具引用**（工具名写错、参数形状不对、误用 write/edit 写数据文件），并提供**自动修复**把它们改写成规范写法。
- **现状（已定位）**：
  - kb 工具真源：`electron/lib/custom-tools.ts` 注册的 `kb_read`(158) / `kb_patch`(252) / `kb_append`(380)，外加 `display_content`(31) / `get_date`(74) / `get_progress`(110)；规范签名见 `LEARNING-DATA-SPEC.md:286-319`（kb_read/get/patch/append 四工具 + 参数）。
  - method.md 角色：`LEARNING-DATA-SPEC.md:338` 表确认 method.md 属「内容文件」，可用 write/edit，但**其内容规定 agent 对数据文件必须用 kb 工具**（对照：`AGENTS.md:33`「数据文件读写一律用 kb_read/kb_patch/kb_append，禁止 write/edit 裸写」）。
  - 现状写法：8 个主题的 method.md「记录」段均写「用 `kb_append`（`{file:"daily/…", block:"学习", content:"### …"}`）」——目前与规范一致，但靠人工对齐，无自动化保障。
- **缺口（根因）**：
  1. **method.md 完全不在校验范围**：`kb-lint.ts` 的 `lintChildDir`（246-271）只跑 `lintDaily` / `lintProgress` / `lintIndexes` / `lintTopicsRules`——**无任何 method.md 检查**，用户改坏 kb 工具引用也检不出来；
  2. `kb-lint` 设计哲学是「只报告不修改」（`main.ts:153` 注释 + `writeReport` 仅落报告），目前**不具备自动修复能力**；
  3. **自动修复先例已存在**：`scripts/update-method-recording.mjs` 正是「遍历各主题 method.md、把记录段从 write/edit 改成 kb 工具指引」的脚本——证明「扫描+改写 method.md」可行，可沉淀为常驻能力。
- **候选方案（检测 + 自动修复）**：
  - **约定标准化**：在 `LEARNING-DATA-SPEC.md` 新增一节「method.md 内 kb 工具引用规范」（允许工具名集合、参数形状、数据文件 vs 内容文件边界）；或在 `kb-schema.ts` 加 `METHOD_KB_TOOLS` 白名单供检测复用（避免「工具一套、lint 一套」漂移，呼应 `kb-schema.ts:4-5` 既有设计意图）。
  - **检测（扩展 kb-lint）**：新增 `lintMethodKbRefs(childDir)`，正则扫描每个 `learning/{topic}/method.md`：① 是否引用不存在的工具名（如 `kb_write`/`kb_update`/`write`/`edit` 出现在数据文件写场景）；② 参数形状是否偏离规范（如 `kb_append` 缺 `block`、`kb_patch` 缺 `value`）；③ 是否把数据文件（daily/、learning 进度、life/、inquiries/、tasks/、tags/）写成走 write/edit。
  - **修复（新增 `scripts/fix-method-kb.mjs` 或并入 `update-method-recording.mjs`，常驻化）**：把扫描出的错误引用重写为规范写法（复用该脚本既有替换逻辑），幂等、可重复跑；`kb-lint` 报告里给「可自动修复」标记。
  - **触发**：沿用 `main.ts` 现有 `lintOnce`（启动 + 每 24h），检测阶段顺带跑 method 检查；修复可手动跑或加 IPC/按钮触发。**先不默认自动改**（避免误改家长自定义内容），报告后由人确认。
- **待确认项**：① 自动修复默认开还是仅报告（家长自定义内容误改风险）；② method.md 的 kb 引用是否要标准化模板（减少自由度）；③ 是否把 method.md 检查并入 `scripts/kb-lint.mjs` CLI 一并输出。
- **排查 / 修改入口（可直接执行）**：`electron/lib/kb-lint.ts`（新增 `lintMethodKbRefs` + 在 `lintChildDir` 调用）、`electron/lib/kb-schema.ts`（加 `METHOD_KB_TOOLS` 白名单）、`electron/main.ts:153-173`（触发点）、`scripts/update-method-recording.mjs`（修复先例，复用替换逻辑）、`LEARNING-DATA-SPEC.md:286-342`（规范真源）、各 `learning/{topic}/method.md`（被检/被修对象）。
- **关联**：ISSUE-009（同走 method.md「记录」段，本次把它对 kb 工具的引用标准化+可校验，与「详细度」互补）；ISSUE-013（kb 查询/写入省 token——method.md 写错工具会导致 agent 跑偏、额外消耗）；ISSUE-018（method.md 本身用 write/edit 属内容文件，与数据文件 kb 工具边界）。
- **已修复（2026-08-20 实施）**：
  1. `electron/lib/kb-schema.ts` 新增 `KB_DATA_TOOLS`/`KB_AUX_TOOLS`/`METHOD_KB_TOOLS`/`KB_TOOL_REQUIRED` 白名单（kb 工具真源，来自 custom-tools.ts 实际注册：`kb_read`/`kb_patch`/`kb_append` + 辅助 `display_content`/`get_date`/`get_progress`，**无 kb_get**）。
  2. `electron/lib/kb-lint.ts` 新增 `lintMethodKbRefs`（导出）：三类检测——① 全文扫描 `kb_xxx` 工具名合法性（非白名单→warning）；② 代码语境（``` 代码块 + 行内反引号）内 kb 工具调用缺必需参数（kb_append 缺 block/content、kb_patch 缺 value/fields、kb_read 缺 file/ref）；③ 数据文件裸 `write(`/`edit(` 调用（应走 kb 工具）。**仅检测代码语境，不误伤「禁止 write/edit 裸写」教学文案**。在 `lintChildDir` 调用，结果自动进 `lint-report.md`。
  3. `scripts/fix-method-kb.mjs`：常驻化修复脚本，复用 `update-method-recording.mjs` 的已知句式替换（进度→kb_patch、daily→kb_append）+ 过时工具名映射（kb_get→kb_read、kb_update→kb_patch）；幂等、可重复跑；**默认不自动执行**（ISSUE-022 决策：避免误改家长自定义内容，需人确认后手动跑）。
  4. `test/kb-lint-method.test.ts`（7 用例）覆盖：规范 method.md 零 warning、kb_get 检测、kb_append/kb_patch 缺参检测、数据文件裸 write 检测、不误伤「禁止 write/edit」文案、真实 lunyu method.md 零误报。**修复中发现并修正一个真实 bug**：规则1 原 regex 写成 `\bk_...`（要求 k 后紧跟下划线），但真实工具名是 `kb_read`（k 后接 b），导致规则1 对所有 kb 工具名完全匹配不到——之前"零误报"是假象；改为 `\bkb_...` 后真正生效。
  5. 验证：tsc 过滤环境告警后 0 业务错误；全量真实孩子 method.md 扫描 0 误报（不污染 lint-report）；vitest kb-lint-method 7 用例全过；`npm run build` 通过；全量测试 122 通过 / 12 失败，12 失败均为预存环境/数据问题（app.test 云端 ECONNREFUSED、functional app.isPackaged、learning-summary 真实数据漂移、auto-new-session/archive-limit 的 safe-delete 拦截 rmSync、sync 扫描超时），与本次无关。
- **优先级**：已完成（2026-08-20）
- **记录时间**：2026-08-20

## [ISSUE-017] 退出家长账号按钮只应出现在家长页面，去掉主页左上角退出按钮

- **类型**：需求 / 待实现（用户未标注）
- **需求**：退出家长账号的按钮**只保留在家长页面（Dashboard）**里；**去掉主页（Home）左上角的退出按钮**。理由：孩子（在主页选择孩子身份进入）不能退出家长账号，主页出现退出按钮会让低龄用户误操作退出登录。
- **现状（已定位）**：
  - 主页退出按钮：`src/pages/Home.tsx:143-158`（`position:absolute; top:20; left:20` 的「← 退出登录」按钮，onClick → `handleLogout` → `window.api.authLogout()` + `onLogout()`）。Home 是孩子和家长共用入口页，孩子点选孩子卡片进入学习，此按钮对孩子可见 → 需移除。
  - 家长页退出按钮：`src/pages/Dashboard.tsx:76-77`（header 右侧「← 返回主页」+「退出登录」两个按钮）——保留退出按钮在此处即可满足「只出现在家长页面」。
  - 登出实现（保留不变）：`Home.tsx:57-60` `handleLogout`；`App.tsx:67-70` Dashboard 的 `onLogout`（`authLogout` + `setView("parent-login")`）。
- **实现要点**：
  1. 删除 `Home.tsx:143-158` 的退出按钮 JSX（含 `handleLogout` 若不再被其它地方使用则一并清理，或保留无妨）；
  2. `Home` 组件的 `onLogout` prop（`Home.tsx:7`）随之不再需要，可从 `App.tsx:51-60` 的 `<Home>` 调用处移除该 prop（清理可选，不影响功能）；
  3. 家长退出入口唯一保留：Dashboard 右上角「退出登录」（`Dashboard.tsx:77`）。
- **排查 / 修改入口（可直接执行）**：`src/pages/Home.tsx:143-158`（删除按钮）、`Home.tsx:57-60`（handleLogout，可清理）、`src/App.tsx:51-60`（Home 的 onLogout prop，可清理）、`src/pages/Dashboard.tsx:76-77`（保留的退出按钮）。
- **待确认项**：① 主页是否还需要任何「返回/退出到登录页」的途径（如仅家长能登出、孩子通过「退出学习」回主页，主页本身没有退出入口 → 家长要退出需先进家长中心）；② `handleLogout`/`onLogout` prop 是否顺手清理。
- **关联**：无（独立 UI 调整）。
- **已修复（2026-08-19 实施）**：
  1. `src/pages/Home.tsx`：删除左上角「← 退出登录」按钮 JSX（原 143-158 行）与 `handleLogout` 函数；`Props` 移除 `onLogout`。
  2. `src/App.tsx`：`<Home>` 调用处移除 `onLogout` prop。
  3. 家长退出唯一入口保留在 Dashboard 右上角「退出登录」（`Dashboard.tsx:77`）。待确认项①按默认推进：主页无退出入口，家长要退出先进「家长中心」再退；孩子从主页进入学习、经「退出」回主页，全程接触不到退出登录。
  验证：`tsc --noEmit` 过滤后 0 业务错误；`npm run build` 通过。`out/` 需重新构建生效。
- **优先级**：已完成（2026-08-19）
- **记录时间**：2026-08-19

## [ISSUE-018] 退出孩子账号再进入后，历史消息也要恢复「模型的思考」和「工具调用记录」

- **类型**：需求 / 待实现（用户未标注）
- **需求**：孩子学习过程中退出再进入，历史消息里**也要有该轮 AI 的思考过程（thinking）和工具调用记录（tools）**，与实时会话中气泡内联显示的效果一致；现在恢复后只剩最终文本回复。
- **现状（已定位）**：
  - **主进程丢弃**：`electron/lib/pi-session.ts:699-716` `getSessionHistory()` 注释明写「tool calls, thinking, etc. are skipped」——历史重建时**只提取 user/assistant 的 text**（`extractText`），思考和工具调用被显式丢弃。
  - **前端结构已就绪**：`ChatMessage` 接口（`src/components/ChatWindow.tsx:14-32`）**已有** `thinking?: string`（23 行）与 `tools?: ToolCallState[]`（24 行），气泡渲染侧（`ChatWindow.tsx:283-321`）已支持显示——缺的只是「恢复时填充」。
  - **前端恢复映射**：`src/pages/Learn.tsx:130-150` 把 `getSessionHistory` 返回的消息映射成 `ChatMessage`，只填 `text / attachments / textFiles / audioPath / time`，**没填 `thinking` / `tools`**。
- **关键依赖（待确认）**：SDK assistant 消息里**思考内容存于哪个字段**（如消息顶层 `reasoning`/`thinking` 字段、或 content 块内特殊类型），工具调用存于 content 块的 `type:"toolCall"`（`getSessionMaterials` 已按此遍历，`pi-session.ts:641-652` 可参照）；需先在 SDK 消息结构里确认 thinking 的实际字段名，才能从历史正确还原。
- **实现要点（候选，待定）**：
  1. 主进程 `getSessionHistory()` 扩展：assistant 消息额外输出 `thinking`（取思考字段原文）与 `tools`（从 content 的 toolCall 块提取 name/argsPreview/status，与 `getSessionMaterials` 的遍历方式一致）；`HistoryMessage` 类型同步加字段；
  2. 前端 `Learn.tsx:130-150` 恢复映射时透传 `thinking` / `tools`（tool 的 status 历史值取「done/error」终态，时间戳缺失可省略）；
  3. 注意与上下文截断策略的兼容：历史被截断后较早轮次的 thinking/tools 会缺失，属预期。
- **排查 / 修改入口（可直接执行）**：`electron/lib/pi-session.ts:699-716`（`getSessionHistory`，主改点）、`pi-session.ts:637-684`（`getSessionMaterials` 遍历 toolCall 的参照范式）、`src/pages/Learn.tsx:130-150`（恢复映射）、`src/components/ChatWindow.tsx:6-32`（`ToolCallState`/`ChatMessage` 类型）。
- **待确认项**：① SDK assistant 消息思考字段的确切名称与结构（先看 `node_modules/@earendil-works/pi-coding-agent` 的 assistant 消息样例）；② 历史里的工具调用是否需要完整参数/结果预览，还是仅名称+状态；③ 恢复的消息是否需要与实时气泡一致的「思考可展开/折叠」交互。
- **关联**：ISSUE-004（气泡时间——同走 `getSessionHistory` 恢复链路，可一并改）；ISSUE-013（知识库 token 效率——thinking 恢复会增加历史体量，需权衡是否全量恢复）。
- **已修复（2026-08-19 实施）**：
  1. **SDK 消息结构确认（待确认项①）**：真实 jsonl 实测——assistant 消息 `content` 数组含 `{type:"thinking", thinking:"…"}`（thinkingSignature:"reasoning_content"）、`{type:"text", text:"…"}`、`{type:"toolCall", id, name, arguments}`；工具结果在独立消息 `{role:"toolResult", toolCallId, toolName, content, isError}`。
  2. **主进程 `getSessionHistory` 扩展**（`electron/lib/pi-session.ts`）：先遍历一遍把 `role:"toolResult"` 按 `toolCallId` 建索引；assistant 消息输出 `thinking`（type==="thinking" 块 join）与 `tools`（type==="toolCall" 块 → `HistoryToolCall{id,name,argsPreview,status,resultPreview}`，argsPreview=JSON.stringify(arguments) 截 200 字符，status 由对应 toolResult 的 `isError` 判 done/error，无结果则 running，resultPreview 截 300 字符）；正文/思考/工具三者皆空的 assistant 消息跳过（避免恢复出空气泡）。`HistoryMessage` 新增 `thinking?`/`tools?`，新增 `HistoryToolCall` 接口（与前端 `ToolCallState` 结构一致）。
  3. **前端恢复映射**（`src/pages/Learn.tsx`）：恢复历史时透传 `thinking: m.thinking`、`tools: m.tools`（仅 ai 消息）。气泡侧无需改：`ChatMessage` 已有 `thinking/tools` 字段，`ChatWindow` 的 `hasTrace` 判断与 🧠 展开交互直接生效（与实时气泡一致，可展开/折叠，待确认项③默认满足）。
  4. 取舍（待确认项②）：参数/结果均带预览（截断），不存完整原文——恢复出的历史保持轻量；历史被上下文截断较早的轮次 thinking/tools 缺失属预期（与截断策略兼容）。
  验证：`tsc --noEmit` 过滤后 0 业务错误；`npm run build` 通过；全量 vitest 85 用例 72 过 / 13 失败，13 失败均为既有环境/数据问题（safe-delete 拦截 auto-new-session/archive-limit、learning-summary 真实数据漂移、functional app.isPackaged、app.test 云端 ECONNREFUSED、sync.test 扫描真实目录超时偶发）——单独重跑 auto-new-session+archive-limit 13 用例全过，证实与本次改动无关。`out/` 需重新构建生效。
- **优先级**：已完成（2026-08-19）
- **记录时间**：2026-08-19

## [ISSUE-021] 语音输入多次说话只保存最后一段录音——应把本次输入的所有语音段拼接成一个音频文件

- **类型**：bug / 待修复（用户未标注）
- **现象**：聊天输入框用语音输入时，一次输入中**多次按住说话**（每段识别后追加文本），最终**保存/发送的录音只包含最后一段**；需求是把这一次输入的所有语音段**拼接成一个语音文件**保存（消息气泡里一个可播放的完整音频）。
- **根因（已定位，前端覆盖式状态）**：
  - 识别链路：每次按住说话 → `handlePressEnd`（`src/components/ChatWindow.tsx:415-441`）→ `voice:transcribe`（`electron/lib/ipc-handlers.ts:712-721`，返回 `{text, audio}`，audio=本段录音 webm base64）→ 前端 **文本用 `setInput(prev => prev + r.text)` 追加**（430 行，正确），但 **`setPendingAudio(r.audio)` 是覆盖**（431 行，错误——只留最后一段）。
  - 发送时 `ChatWindow.tsx:240` `const audio = pendingAudio || undefined` → 消息只带最后一段音频进 `ChatMessage.audio`；`setPendingAudio("")`（247 行）清空。预览区（688-701 行）也只支持单段。
  - 主进程 `transcribeAudio`（`electron/lib/voice/index.ts:30`）只做转写（webm→wav→provider），临时文件用完即删（ISSUE-015 后仅失败时保留），**无正式录音落盘**——「保存录音」实际是前端 base64 状态，历史恢复靠 `audioPath`（`readUpload` 读落盘文件，`ChatWindow.tsx:390-397`）。
- **实现要点（候选，待定）**：
  1. **前端多段累积**：`pendingAudio`（单段 string）改为 `pendingAudios: string[]`，每次识别 `push(r.audio)`；预览播放逻辑适配多段（或合并后播放）；
  2. **拼接**：发送时把所有段（base64/ArrayBuffer）交给主进程新 IPC（如 `voice:merge`）→ 主进程复用既有 ffmpeg 管线（`electron/lib/voice/audio.ts` `webmToWav16k`）把各段**转 wav 后用 ffmpeg concat** 拼成单个音频 → 落盘为正式文件（如 `data/children/<childId>/uploads/voice-*.webm|wav`）→ 消息带 `audioPath`（历史可恢复）+ 可选 base64 预览；
  3. 拼接细节：webm/opus 各段同编码可直接 concat demuxer，但跨段时间戳/EBML 可能不连续，**先统一转 wav 再 concat 更稳**；输出格式选浏览器可播的 wav/webm/mp3（确认播放端）；
  4. 若只发一段：保持现有行为（可直接落盘单段，不强制 concat）。
- **待确认项**：① 合并时机：发送时一次性合并 vs 每次识别后立即合并（发送时合并更省，但预览只能按段播）；② 合并输出格式（wav/webm/mp3）；③ 合并失败时的降级（如落盘失败仍用 base64 发送最后一段 + 提示）；④ 是否同时保留每段独立录音。
- **排查 / 修改入口（可直接执行）**：`src/components/ChatWindow.tsx:240-247`（发送取 audio）、`ChatWindow.tsx:415-441`（`handlePressEnd` 覆盖点）、`ChatWindow.tsx:688-701`（预览区单段）、`electron/lib/ipc-handlers.ts:712-721`（voice:transcribe 参照，新增 voice:merge 相邻注册）、`electron/lib/voice/audio.ts`（ffmpeg 拼接）、`electron/lib/voice/index.ts:30`（transcribeAudio）。
- **关联**：ISSUE-015（ffmpeg 管线与临时文件策略，拼接复用同一管线）；ISSUE-008（文件上传——落盘目录/`readUpload` 读取可复用）。
- **已修复（2026-08-20 实施）**：
  1. **前端累积多段**：`src/components/ChatWindow.tsx` 的 `pendingAudio`（单段 string）改为 `pendingAudios: string[]`；`handlePressEnd` 每次识别后 `setPendingAudios(prev => [...prev, r.audio])` 累积（不再覆盖）；预览区显示「N 段」并支持顺序连播（多段逐段播放）+ 一键清空；`SendOptions` 新增 `audios?: string[]`。
  2. **发送时合并**：`Learn.tsx` `handleSend` 对 `audios`：单段沿用原 `saveUpload`（落 `语音录音.webm`），多段（≥2）调新增 IPC `voice:merge` 合并落盘（返回 `path` + 合并后 WAV 的 base64 `data`）；消息同时带 `audio`(base64) 与 `audioPath`(历史恢复播放)。prompt 附件标记改用音频文件名（webm/wav 自适应）。
  3. **主进程合并**：`electron/lib/voice/audio.ts` 新增 `extractWavPcm`（解析 WAV、抽 PCM、校验 16k/单声道/16bit，含 fmt 块容错）+ `concatWav`（44 字节标准头 + 拼接）+ `mergeWebmSegments`（逐段 `webmToWav16k` 转 WAV→抽 PCM→拼接，单段失败跳过不丢整体）；`electron/lib/ipc-handlers.ts` 新增 `voice:merge`（按 childId 隔离落盘到 uploads、双路径校验、`pruneUploads`）；`electron/preload.ts` 新增 `voiceMerge` 桥接。
  4. **播放兼容**：`playAudioBase64` 按 base64 前缀 `UklG`(RIFF) 嗅探 WAV 并设 `audio/wav` MIME，确保合并后的 WAV 能播放（原硬编码 webm）。
  5. **验证**：新增 `test/voice-merge.test.ts`（8 用例：extractWavPcm/concatWav 纯函数 + 端到端两段合并 + 空输入/坏段跳过）全过；`tsc` 过滤环境告警后 0 业务错误；`npm run build` 通过；全量 vitest 无新增回归（4 个失败均为预存的 learning-summary 数据漂移 / app.test 云端 ECONNREFUSED / functional app.isPackaged，与本次无关）。
- **优先级**：已完成（2026-08-20）
- **记录时间**：2026-08-20

---

## [ISSUE-023] 孩子学习/生活数据已完全结构化，是否改用 SQLite 存储，避免 AI 用 write/edit 破坏结构、提升查询与维护效率

- **背景 / 现象**：孩子数据（`daily/`、`life/`、`inquiries/`、`tasks/`、`tags/` + `learning/` 进度 frontmatter）已经是**完全结构化的 markdown**（frontmatter + 命名区块 + 条目，由 `kb-parser.ts` 解析、`kb-schema.ts` 的 `DAILY_BLOCKS`/`TAG_BLOCKS`/字段白名单约束）。既然结构已稳定，是否值得迁到 SQLite，规避文本文件被写坏、查询慢、维护难的痛点。
- **当前结构性风险（已定位）**：
  - `pi-session.ts:342` 的 `tools` 白名单**仍含 `read/write/edit`**（SDK 通用工具）→ `AGENTS.md:35` 只是「约定」数据文件禁止裸 write/edit，但 agent **技术上可绕过 kb 工具直接 write/edit**，一旦误调用就会破坏 markdown 结构（这正是本 issue 要根除的根因）。
  - 即便走 kb 工具，写入也是「读全文→解析→改字符串→整篇重写 markdown」，脆弱（并发/截断易坏）、且 **IO/token 双贵**（ISSUE-013 同主题）。
- **候选方案（SQLite）**：
  - 每孩子一个 `data/children/<childId>/kb.sqlite`（沿用「按 childId 隔离」硬约束，`kb-schema.ts` 的区块/字段映射成表：`daily_entries`/`life_events`/`inquiries`/`tasks`/`tags`/`topic_progress` 等）；或单库按 `child_id` 分区。
  - 新增 SQL 后端工具替换 `kb_read/kb_patch/kb_append`：`kb_query`（SELECT 条件）、`kb_insert`（INSERT 条目）、`kb_update`（UPDATE 字段）→ agent 永远不再碰原始文件，结构上不可能被破坏。
  - 工具白名单移除 `write/edit`（保留 `read` 用于只读非数据文件如 method.md/materials）。
  - 迁移：用现有 `kb-parser` 把所有存量 markdown 导入 SQLite（脚本一次性）。
- **得益**：① 结构上防破坏（root cause 根除）；② 查询快（索引、WHERE，省 token——呼应 ISSUE-013）；③ 维护简单（schema 约束即文档）。
- **代价 / 关键权衡（已拍板 2026-08-20 讨论）**：
  1. **可读性与 Obsidian 友好性丢失**：✅ **已拍板：放弃 Obsidian 直读**。SQLite 为唯一真源，不做双写、不做定时导出 markdown；家长/AI 检索全部走 SQL 查询或家长 UI（learning-summary/insights）；markdown 仅一次性迁移，之后不再维护。
  2. **家长可手写 method.md/materials**：✅ 已确认：这类**内容文件**仍需 write/edit，SQLite 只接管「数据文件」（daily/life/inquiries/tasks/tags/进度 frontmatter），范围以 SPEC 5.4 文件类型分流为准。
  3. **SQLite 并发**：Electron 主进程单点访问，串行化；渲染进程读走 IPC（现有 `learning:summary` 范式）。
  4. **依赖**：✅ **已拍板：接受 native 依赖**（better-sqlite3 或 Node 内置 node:sqlite），但**先进 POC 验证**（先验证 Electron 打包/rebuild 是否踩坑，再全量）。
  5. ✅ **已拍板：先在小范围试点**——首批只迁 `tags/` 倒排索引进 SQLite，用 ISSUE-010 token 统计量化收益后再决定全量。
- **执行路线（2026-08-20 讨论定稿，P1 已实施 2026-08-20）**：
  - ~~P0 最小修复：白名单移除 write/edit~~ → **已否决（2026-08-20）**：agent 还要写**非结构化内容**（method.md、materials/、临时产物等无模板文件），write/edit 必须留在白名单——这正是 SPEC 5.4 已知限制「无法在工具层按路径禁止 write/edit」的体现。**结论：write/edit 不撤，数据入库后它们物理上碰不到结构化数据**——这使 SQLite 成为「防 AI 破坏」的**唯一结构层手段**，也是相对白名单/路径约束的决定性优势。
  - **P1 tags 索引 POC（已实施 2026-08-20）**：
    - **依赖选型**：`node:sqlite`（Node 内置模块，Electron 43 / 内置 Node 24.18.1 **原生可用**，实测 CREATE/INSERT/SELECT 全通）——**零 native 依赖**，直接消除 better-sqlite3 的 Electron rebuild/打包坑；`@types/node@26` 自带类型。
    - **新增文件**：`electron/lib/kb-sqlite.ts`（openKbDb / parseTagFile / tagsDirMtime / syncTagsToSqlite / queryTagLinks / tagLinksToMarkdown）；`scripts/migrate-tags-sqlite.mjs`（CLI 迁移，`node --experimental-strip-types scripts/migrate-tags-sqlite.mjs`）；`scripts/token-compare-tags.mjs`（收益量化）。
    - **表结构**：每孩子 `data/children/<childId>/kb.sqlite`，`tag_links(tag, kind, title, pointer)` + `meta(tags_last_sync)`。**同步策略**：tags/*.md 仍由 recording（kb_append）写，kb_query 查询前按 tags 目录 mtime 增量重建索引（幂等，mtime 未变跳过）。
    - **工具面**：新增 `kb_query`（custom-tools.ts + pi-session.ts:385 tools 白名单 + customTools 双注册；kb-schema.ts `KB_AUX_TOOLS` 加 kb_query、`KB_TOOL_REQUIRED` 加 query 必需参；kb-lint.ts 规则 1 合法集扩展含 kb_query；AGENTS.md:35 模板补充「查询标签用 kb_query 优先于 read tags/*.md」，已 regenerate-agents 刷新 4 个孩子）。
    - **验证**：新增 `test/kb-sqlite.test.ts` 17 用例全过（含端到端：kb_append 写入 → kb_query 增量同步读到）；tsc 过滤环境告警后 0 业务错误；`npm run build` 过（node:sqlite 保持内置引用未被打包）；全量 vitest 无新增回归（既有失败用例与本次无关）。
    - **⚠️ 量化结论（重要，影响 P2 决策）**：当前 tags 数据量极小（主孩子 19 文件共 1518 字符），SQLite 查询 token 收益**不明显**（全量 1.1x / 单标签 1.2x）——**tags 倒排不是能体现 SQLite 价值的最佳试点**。SQLite 的真实价值在「结构防破坏 + 事务一致性 + 大文件/跨维度查询」，tags 索引太小测不出来。**P2 全量决策建议**：要么换试点（如 daily/ 月聚合或 tasks 状态查询），要么直接按「结构防破坏」为主要理由推进（放弃 token 收益量化作为门槛），待 ISSUE-010 在真实长会话里再对比。
  - **P2 决策点**：POC 通过后 → 全量迁移（kb_query/kb_insert/kb_update 替换 kb_read/kb_patch/kb_append；迁移脚本用 kb-parser 导入存量；learning-summary/recording 技能同步改；ISSUE-022 检测脚本同步）。
  - **注意**：P0 否决后，SQLite 是防破坏唯一结构层手段，P1 POC 优先级相应提升（不再是「可选优化」，而是必选验证）。
- **排查 / 修改入口（可直接执行）**：
  - 数据结构真源：`data/children/<childId>/{daily,life,inquiries,tasks,tags,learning}/`；解析/约束 `electron/lib/kb-parser.ts`、`kb-schema.ts`。
  - 工具注册：`electron/lib/custom-tools.ts:157-...(kbRead/kbPatch/kbAppend)`；白名单 `electron/lib/pi-session.ts:342`。
  - 约定文案：`electron/lib/pi-session.ts` 生成的 `AGENTS.md:35`。
  - 索引/导出：`electron/lib/learning-summary.ts`、`recording/SKILL.md`。
- **关联**：ISSUE-013（知识库查询/写入省 token，SQLite 是最优解之一）；ISSUE-009（method 记录详细度——数据落库后提取更廉价）；ISSUE-022（method.md 的 kb 工具引用约定——迁移后工具名会变，需同步更新检测脚本）；ISSUE-006（进度 frontmatter 查询——SQL 化后天然高效）。
- **优先级**：**已完成（2026-08-20 P2 全量迁移落地）**
- **P2 全量迁移（2026-08-20 已实施）**：
  - 表结构：`daily_entries(date,block,title,fields_json,raw)` + `topic_progress` + `topics` + `rules` + `tag_links` + `meta`；**life/inquiries/tasks 月索引不建表**（`WHERE block=? AND date LIKE ?` 直查 daily_entries 代替，查询替代手工索引）。
  - 迁移：`scripts/migrate-kb-sqlite.mjs`（全量幂等）；主孩子 daily 1382 条（**687 条历史完全重复条目被主键去重，内容一致无损**）/ 进度 8 / topics 8 / rules 7 / tags 25。
  - 工具面：删 markdown 版 kb_read/kb_patch/kb_append → `kb_query`（daily/topics/progress/tags）+ `kb_insert`（daily/tags）+ `kb_update`（daily/progress）；pi-session.ts / kb-schema / kb-lint（改 SQLite 校验）/ AGENTS.md / recording SKILL.md / 8 个 method.md 全部同步（scripts/fix-method-kb-sqlite.mjs、fix-tag-pointers.mjs、fix-archive-tag-pointers.mjs）。
  - **坑**：topics.name 中文 vs topic_progress.topic 目录名——用 `file.split("/")[0]` 关联；lint 调 queryDaily 需传 `{}`；tags 历史指针 learning/taodi.md 失效（SPEC P5 遗留，双修 SQLite+归档）。
  - 验证：tsc 0 业务错误；build 过；kb 相关 7 套件 83 用例全过；lint 全孩子 error 0。
- **v3 修订（2026-08-21，已实施）——按用户拍板：**
  - **daily_entries 删 `fields_json` 列**（raw 唯一内容源；字段是 method 灵活设定的，白名单限制灵活性——**字段白名单机制整体废弃**，kb-schema 删 DAILY_FIELDS/PROGRESS_FIELDS/INDEX_FIELDS/legalFieldsFor；kb-lint 删字段 warning → 全孩子 warning 归零）。`kb_query daily` 非 listOnly 直接回 raw 原文。
  - **进度明细化**：新增 `courses(topic,title,sort_order,status,mastery,first_learned,last_review,review_count,material,send_material,tags)` 表；旧 topic_progress 表删除，**learned/total/next/updated 改为视图实时计算**（`kb_update` 只更新单课状态/时间字段，传 learned/next/updated 会被拒绝；复习次数 `value:"+1"` 自增）。
  - **v2→v3 就地迁移**：`openKbDb` 的 `ensureV3` 自动执行（去 fields_json 列、items_json 展开 courses、删旧表建视图），不丢 SQLite 迁移后新增数据；`openKbDb` 加 `PRAGMA busy_timeout=3000`（vitest 多文件并行访问真实库会锁冲突）。
  - **⚠️ 重要操作约束**：`migrate-kb-sqlite.mjs` 是全量重灌（DELETE + 从 markdown 导入），**SQLite 真源后不能再对真源库跑它**（会覆盖丢失 SQLite 里迁移后新增的 daily/进度）——它只是「首次建库/灾难恢复」工具。
  - 验证：tsc 0 业务错误；build 过；相关 7 套件 89 用例全过；lint 全孩子 error 0 / warning 0（592 条字段 warning 消失）。
- **v4 修订（2026-08-21，已实施）——按用户拍板（标签体系改造 + rules 并入）：**
  - **`topics` 加 `rules_json` 列，删除独立 `rules` 表**（rules.md 的 key 是**中文名**如「论语」，直接匹配 topics.name；曾误用目录名匹配导致合并失败，补丁回填）。
  - **`tag_links` 倒排表 → `tags` 定义表**（tag + dimension + criteria 判断标准）：只存标签定义（家长维护，AI 打标签前查），不再存「每关联一行」的倒排；**`daily_entries` 加 `tags` 列**（针对生活区块事件打标签，kb_insert 从 content 的 `- 标签：` 行自动解析，field=标签 更新时同步）；**courses.tags 确认保留**（每课打标签）。反查用 `(','||tags||',') LIKE '%,标签,%'` 扫数据行（查询替代索引，消灭倒排一致性问题）。
  - 工具面：`kb_query tags` 查定义表、`kb_query daily/progress` 支持 tag 过滤、**`kb_insert` 移除 tags 分支**（打标签改走 daily content / progress tags；标签定义不开放给 AI 写，保持词表纪律）；kb-lint 删倒排指针校验 → 新增「daily.tags / courses.tags ⊂ tags 定义表」合规校验。
  - 迁移/补丁：ensureV4 就地迁移（topics+rules_json、daily+tags 回填、tag_links→tags）；`scripts/fix-v4-tags-rules.mjs`（rules 中文名回填 + # 前缀归一化）、`fix-v4-backfill-tags.mjs`（**历史用过但不在词表的 57 个标签补入定义表** dimension=历史，保持历史可检索且 lint 归零）。
  - ⚠️ **坑（已踩）**：① rules.md key 是中文名，与 topics.name 匹配而非目录名；② AGENTS.md 模板是反引号模板字符串，嵌入 `- 标签：` 等反引号需 `\`` 转义（TS1127）；③ 历史标签带 `#` 前缀（#动手），normalizeTags 需去前导 #。
  - 验证：tsc 0 业务错误；build 过；相关 7 套件 88 用例全过；lint 全孩子 error 0 / warning 0。
- **记录时间**：2026-08-20（讨论定稿：SQLite 为唯一真源；**否决 P0 白名单收口**，理由 = agent 还要写无模板内容文件；直接进入 P1 tags 索引 POC）；2026-08-21（v3 / v4 修订落地）

---

## [ISSUE-024] 将 recording 技能按「记录类型」拆分为独立子技能，让 AI 处理时更专注

- **背景 / 需求**：当前 `data/shared/skills/recording/SKILL.md`（217 行）把 **4 类记录**塞进一个技能——① 学习（§2-3）、② 生活（§4）、③ 问答（§5）、④ 任务（§6），外加共用的「详细度要求（最高优先级）」和「写入方式/kb 工具」段。一个巨型技能让 AI 在提取时注意力分散、易漏类。拆成 4 个独立技能（如 `recording-study`/`recording-life`/`recording-inquiry`/`recording-task`），每类只关心自己的区块与字段，更专注、更不易错。
- **4 类已对应**记忆里的「计划学习 / 生活事件 / 即兴问答 / AI 任务执行」四类日常场景；`study-tracker`（每日达标评估）已是独立姊妹技能，拆分有先例。
- **已定位的引用（拆分后必须同步改）**：
  - 技能加载：`pi-session.ts:309-315` `additionalSkillPaths:[getSkillsDir()]` 指向 `data/shared/skills/`，SDK 自动发现子目录 `SKILL.md`——**拆分零改加载逻辑**，只增子目录。
  - **定时任务硬引用**：`scheduler.ts:244` 写死 `/skill:recording\n\n以下是最近的学习会话内容，请从中提取学习总结并更新学习记录文件`——**一次性提取全部 4 类**；拆分后需改为按类型各调一次（或保留父技能 `recording` 做编排，子技能各管一类）。
  - AGENTS.md 文案：`pi-session.ts:34`「学习总结、生活事件等记录由 recording 技能负责，按需调用」→ 改为列出 4 个子技能。
  - 各主题 `method.md` 里「不调用 recording 技能」等措辞（如 lunyu method.md:100）→ 引用名需随之更新。
- **方案要点（候选）**：
  - 目录：`data/shared/skills/recording-{study,life,inquiry,task}/SKILL.md`；原 `recording/` 保留为「编排/索引」父技能（仅列 4 子技能 + 共用约定），或直接删除改由调度层分别调用。
  - **共用段提取**：「详细度要求」与「kb 工具写入方式（§7）」是 4 类共用的，应抽成 `_common.md` 各子技能引用，避免 4 份维护不同步（呼应 ISSUE-022 的「共享片段」思路）。
  - **关键约束**：daily 是单一真相源（`daily/{日期}.md` 含 学习/生活/问答/任务 4 区块），拆分是**按提取关注点**而非按文件——各子技能仍 `kb_append` 到自己那一块，互不影响。
  - 调用粒度：实时会话中 agent 按当前内容类型调对应子技能；定时总结由 `scheduler.ts:244` 改为逐类调用（或父技能内部串起 4 子技能）。
- **待确认**：① 父技能保留 vs 删；② 共用段内联还是引用 `_common.md`；③ 定时任务改「逐类调用」还是「父技能编排」；④ 子技能命名（study/life/inquiry/task 还是 learning/life/qa/task）。
- **排查 / 修改入口（可直接执行）**：`data/shared/skills/recording/SKILL.md`（真源）；`pi-session.ts:34,309-315`；`scheduler.ts:244,295-301,382-387`；各主题 `method.md` 的 recording 引用。
- **关联**：ISSUE-022（method.md / 共用约定片段化，同一「拆共享」主题）；ISSUE-009（记录详细度——共用段抽 `_common.md` 后，详细度要求一处维护）；ISSUE-013（拆分后每类调用更聚焦、上下文更省）。
- **已实施（2026-08-21，方案变更）**：用户拍板改为「recording 不作为技能，改为纯定时任务」——不再拆 4 子技能，而是：
  1. 删除 `data/shared/skills/recording/` 技能目录（不再进 `<available_skills>`）；
  2. 新建 `electron/lib/recording-prompt.ts`：`RECORDING_SYSTEM_PROMPT`（极简记录助手身份）+ `RECORDING_PROMPT`（从原 SKILL.md 提炼的流程与要求：详细度/四类提取/kb 写入方式/daily 格式/标签）；
  3. `scheduler.ts`：`createEphemeralSession` 加 `DefaultResourceLoader({ noContextFiles:true, noSkills:true, systemPromptOverride })` 保证不加载 AGENTS.md / 技能 / 其它 prompt；工具只挂 `kb_query/kb_insert/kb_update`（顺带修复：原 ephemeral session 只有 read/write/edit、kb 工具缺失，recording 写不进 SQLite）；`runRecording` 改用 `readTodayConversation`（遍历所有 jsonl、按本地当天过滤、只取 role=user/assistant 的 text part、排除 thinking/toolCall/toolResult；顺带修复：旧 extractText 按 `user_message/assistant_message` 判断，与真实 jsonl 结构 `type=message` 不符、提取为空）；当天无对话直接跳过；
  4. `pi-session.ts` AGENTS.md「记录」段改为「由系统定时任务统一完成」，并跑 `scripts/regenerate-agents.mjs` 重新生成 2 个孩子 AGENTS.md。
- **遗留待确认**：① 各主题 method.md「记录（学完直接执行）」段仍会让 agent 实时写 daily/更新进度（与定时任务双轨；kb_insert/kb_update 幂等、短期无害）——是否移除、改由定时任务全权负责，待用户拍板；② 历史脚本 `scripts/rename-progress-to-course.mjs`、`trim-skill-params.py` 仍引用旧技能路径（一次性脚本，再跑会报文件不存在，不影响功能）。
- **优先级**：已完成（2026-08-21）

## [ISSUE-025] 家长设置页去掉「技能管理」与「技能编辑器」两个 tab（暂不开放给家长）

- **需求**：家长界面移除「技能管理」和「技能编辑器」功能入口，暂不向家长开放（当前无使用场景）。
- **现状（已定位）**：这两项都在家长**设置页** `src/pages/Settings.tsx`：
  - tab 类型声明 `Settings.tsx:20` 含 `"skills" | "editor"`；
  - tab 按钮数组 `Settings.tsx:85-86` `["skills", "技能管理"]`、`["editor", "技能编辑器"]`；
  - 渲染分支 `Settings.tsx:212` `{tab === "skills" && <SkillImport />}`、`Settings.tsx:214` `{tab === "editor" && <SkillEditor />}`；
  - 顶部 import `Settings.tsx:2-3` `import SkillImport` / `import SkillEditor`。
  - 组件本体：`src/components/SkillImport.tsx`（技能管理/导入）、`src/pages/SkillEditor.tsx`（技能编辑器）。
- **实现要点（候选）**：
  1. 从 `Settings.tsx` tab 联合类型移除 `"skills" | "editor"`；
  2. 从 tab 数组（85-86）删两行；
  3. 删渲染分支（212、214）；
  4. 删没用到的 import（2-3），避免编译 unused 警告；
  5. `SkillImport.tsx` / `SkillEditor.tsx` 两个文件**保留还是删除**待定（建议先保留，后续若重新开放可快速恢复；且 `window.api.skillsList/skillRead/skillWrite/skillImportFolder` 等 IPC 仍可保留供内部/开发用）。
- **待确认**：① 组件文件保留 vs 删除；② 相关 IPC（`skillsList`/`skillRead`/`skillWrite`/`skillImportFolder`）是否一并保留；③ 是否只是隐藏入口、还是连同底层能力都收敛（底层能力收敛会影响 ISSUE-024 的拆分与 recording 技能维护操作入口）。
- **排查 / 修改入口（可直接执行）**：`src/pages/Settings.tsx:2-3,20,85-86,212,214`；`src/components/SkillImport.tsx`、`src/pages/SkillEditor.tsx`。
- **关联**：ISSUE-024（recording 技能拆分——若底层技能维护入口被收敛，其拆分后子技能的维护/调试通道也要另寻）；底层 IPC 与 `data/shared/skills/` 加载逻辑（`pi-session.ts:309-315`）无直接关系，移除 UI 不影响技能运行时加载。
- **已修复（2026-08-20 实施）**：
  1. `src/pages/Settings.tsx`：从 tab 联合类型移除 `"skills" | "editor"`；tab 按钮数组删除「技能管理」「技能编辑器」两项；删除 `{tab === "skills" && <SkillImport />}` 与 `{tab === "editor" && <SkillEditor />}` 渲染分支；删除不再使用的 `SkillImport`/`SkillEditor` import。`SkillImport.tsx`/`SkillEditor.tsx` 组件文件保留（仅供开发/内部使用，运行时技能加载不受影响）。
  2. 验证：`tsc --noEmit` 过滤 TS2318/2552 后 0 业务错误；`npm run build` 通过；`grep` 确认 `src` 内已无 `skills`/`editor` tab 与 `SkillImport`/`SkillEditor` 残留引用。
- **优先级**：已完成（2026-08-20）
- **记录时间**：2026-08-20

## [ISSUE-026] 家长「教学内容」页改为左右分栏（左=目录+文件预览，右=AI 沟通），且该页聊天用专门提示词引导家长制作教学内容

- **需求**：家长设置页的「教学内容」标签（`topics`）改为左右两栏布局——左栏显示**目录 + 预览文件**，右栏是与 AI 的沟通；并且这个界面发出的聊天要带**专门的提示词**，引导家长制作/生成教学内容。
- **现状（已定位）**：
  - 页面本体：`src/components/TopicEditor.tsx`（注意是 `components/` 不是 `pages/`，`Settings.tsx:216` 以 `{tab === "topics" && <TopicEditor />}` 挂载）。
  - **当前布局不是你要的左右分栏**：孩子选择器 + 左目录树（220px，`rootFiles`+`topics`/`subdirs`） + 中间文件 `textarea` 编辑区 + **底部整宽 `ChatWindow`**（`TopicEditor.tsx:115-186`）。即「目录/文件/聊天」三者竖排加中置编辑，与你设想的「左目录预览、右聊天」不同。
  - 聊天链路：前端 `handleSend`（79-91）→ `window.api.piPromptParent`（`preload.ts:62`）→ 主进程 `pi:prompt_parent`（`ipc-handlers.ts:394`）→ `getParentSession()`（`pi-session.ts:358`）。
  - 家长提示词：`buildParentPrompt()`（`pi-session.ts:101-148`）**已含**「能力二：引导生成教学内容（6 步）」——但它是一个**共享单提示词**，同时混合「能力一：编辑教学技能」，且 `getParentSession` 是**全局缓存单例**（`cachedParentSession`，383 行），所有家长交互（含技能编辑）共用同一会话与提示词。
- **关键缺口（待决策的要点）**：
  1. **布局**：把底部聊天改成右栏；目录树+文件查看合并到左栏。文件左栏是「预览」还是保留「可编辑」待定（当前是 textarea 可编辑，`handleSave` 写回 `learningWrite`）——若右栏 AI 已能生成/改写文件，「预览」可能更合适，编辑交给 AI。
  2. **专门提示词**：你要的「该页聊天用专门提示词引导制作教学内容」意味着需要**与通用家长助手解耦**的提示词——要么新建一个聚焦「教学内容生成」的 parent-content 会话/提示词（`buildParentContentPrompt()`），要么给 `piPromptParent` 传 context 标志切换。当前共享 prompt 还掺着技能编辑，不纯。
- **实现要点（候选）**：
  - `TopicEditor.tsx` 重构为 `display:flex` 左右两栏：左 `<div style={{width:…}}>` 目录+文件预览，右 `<div>` `ChatWindow`；去掉底部整宽聊天。
  - 主进程新增 `getParentContentSession()`（或扩展 `getParentSession` 接收 mode 参数），用专门的 `buildParentContentPrompt()`（只保留 6 步教学内容引导，去掉技能编辑能力段）。
  - 前端首条消息已自动注入选中孩子身份（`TopicEditor.tsx:81-83`），可保留；专门提示词负责「引导制作」的语气与流程。
- **待确认**：① 左栏文件是预览（只读）还是仍可在页内编辑；② 专门提示词是新建父-content 会话，还是复用当前会话仅换 prompt；③ 与「技能编辑」场景是否彻底分离（若分离，ISSUE-025 移除技能 tab 后，通用 parent 助手是否还需要技能编辑能力）；④ 右栏聊天是否要带「当前正在看的文件」上下文（让 AI 针对该文件生成/改写）。
- **排查 / 修改入口（可直接执行）**：`src/components/TopicEditor.tsx`（全文件，布局 93-188、聊天 79-91、文件 66-77）；`electron/lib/pi-session.ts:101-148`（buildParentPrompt）、`358-386`（getParentSession）；`electron/lib/ipc-handlers.ts:394`（pi:prompt_parent）；`electron/preload.ts:62`（piPromptParent）。
- **关联**：ISSUE-025（同页移除技能 tab 后，本页更纯粹聚焦教学内容，专门提示词可顺势去掉技能编辑段）；ISSUE-020（编程 agent 制作 html——本页 AI 引导生成教学内容时，可能触发调用编程 agent 生成 html 资料）。
- **已修复（2026-08-20 实施）**：
  1. **左右分栏布局**：`src/components/TopicEditor.tsx` 重构为 `flex` 左右两栏——左栏 = 孩子选择器 + 目录树 + **选中文件只读预览**（`pre`，去掉原 textarea 编辑与「保存」按钮）；右栏 = `ChatWindow`。去掉原底部整宽聊天。
  2. **专门提示词解耦**：`electron/lib/pi-session.ts` 新增 `buildParentContentPrompt()`（只保留「引导生成教学内容 6 步」、去掉「编辑教学技能」能力段，呼应 ISSUE-025 移除技能 tab）+ 独立会话 `getParentContentSession()`（`cachedParentContentSession`，与通用 `getParentSession` 分离）；`electron/lib/ipc-handlers.ts` 新增 `pi:start_parent_content` / `pi:prompt_parent_content`（流式标签 `parent-content`，沿用 `attachSessionEvents` 机制）；`electron/preload.ts` 新增 `piStartParentContent` / `piPromptParentContent` 桥接。
  3. **当前文件上下文**：前端 `handleSend` 在发送时若已选中文件，附带 `【当前正在查看的文件：xxx】\n<内容>` 上下文，让 AI 针对该文件生成/改写（不取代 AGENTS.md 的文件操作规则）。
  4. 决策说明（待确认项）：① 左栏改为**只读预览**（编辑交给右栏 AI，避免页内编辑/AI 双写冲突）；② 新建 **parent-content 独立会话**（非复用通用 parent 会话换 prompt）；③ 与技能编辑彻底分离（ISSUE-025 已移除技能 tab，通用 parent 助手技能编辑能力保留但不在此页暴露）；④ 右栏聊天**带当前文件上下文**。
  5. 验证：tsc 过滤环境告警后 0 业务错误；`npm run build` 通过；全量测试 122 通过 / 12 失败（均预存，与本次无关，见 ISSUE-022 验证记录）。
- **优先级**：已完成（2026-08-20）
- **记录时间**：2026-08-20

## [ISSUE-027] 家长页面和孩子页面都要展示学习进度

- **需求**：家长页面和孩子页面**都要**展示学习进度。
- **重要现状（已定位，两边其实已有组件，需先与用户对齐「缺什么」）**：
  - **家长侧已有**：家长中心 `Dashboard.tsx` 有「学习进度」入口（`Dashboard.tsx:107,113`）→ `view === "progress"` 时渲染 `ProgressView`（`Dashboard.tsx:225-226`）；`ProgressView.tsx` 展示各主题进度条 + 今日评估布尔表 + 最近日志折叠（数据源 `getProgress` IPC，`ProgressView.tsx:41`）。
  - **孩子侧已有**：孩子模式 `Learn.tsx` 左侧面板配置含「📊 学习进度看板」tab（`Learn.tsx:26`），`view === "progress"` 时渲染 `LearningDashboard`（`Learn.tsx:729`）；`LearningDashboard.tsx` 展示总体进度 + 各主题进度条（数据源 `learningSummary` IPC，`LearningDashboard.tsx:40`）。
  - **孩子侧的关键缺口**：`Learn.tsx:721` 默认渲染 `materials`（学习资料）面板，**进度看板要手动切 tab 才看得到**——若用户希望「进孩子模式就能看到进度」，需调默认面板或加常驻概览。
- **待确认（关键，需用户澄清）**：
  1. 用户诉求是「**已有但不够显眼/不是默认显示**」（孩子侧默认面板、家长侧二级入口），还是「**想要更丰富的进度内容**」（如 ISSUE-019 的 ②错误误解 ③亮点进步）？
  2. 孩子侧的展示**形式**是否要儿童友好化（大字体/图标/进度条动画），还是复用 `LearningDashboard` 即可？
  3. 家长侧是否在 Dashboard 首页（`view === "children"` 列表）就要看到每个孩子进度概览，而不是点进「学习进度」二级视图？
  4. 孩子侧是否也应在聊天主区常驻（如侧边栏顶部小进度卡）？
- **排查 / 修改入口（可直接执行）**：家长侧 `src/pages/Dashboard.tsx:19,107,113,225-226` + `src/components/ProgressView.tsx`；孩子侧 `src/pages/Learn.tsx:23-27,616-729` + `src/components/LearningDashboard.tsx`；数据源 `electron/lib/learning-summary.ts`（`getLearningSummary`）+ IPC（`learning:summary`、`learning:progress`）。
- **关联**：ISSUE-019（家长页进度展示方案设计——①②③ 目标，本 issue 是「家长+孩子双端都展示」的入口/形式诉求，可与 019 合并实施）；ISSUE-006（进度数据源 frontmatter 概览，两端共用）。
- **状态：已修复（2026-08-21）**。用户澄清后确定方案：
  - 孩子侧**不改成默认面板**，保留左侧「学习进度看板」tab 手动切换；家长侧**保持现有二级入口**（首页孩子列表不加进度概览）。
  - 核心交付 = **钻取式进度**（两端一致）：总览（总体进度 + 各主题进度条）→ 点主题 → 每课概要列表（状态✅/⬜、掌握度、标签、首次学习、复习次数）→ 点单课 → 当课汇总（状态/掌握度/首次/最近复习/复习次数/教学资料/标签全字段）。
  - 家长侧原 `ProgressView` 用的是**旧 markdown 路径 `progress:get`（读 study-topics.md 等，已与 SQLite 真源脱节）**，改为与家长侧统一走 SQLite：`learningSummary` + 新增 `learning:topic` IPC；今日评估表改由 summary 的 `updated/today`、`daily`、`type` 实时计算。旧 `progress:get` IPC 保留未删（无调用方）。
  - 改动文件：`electron/lib/learning-summary.ts`（新增 `getTopicProgress`）、`electron/lib/ipc-handlers.ts`（新增 `learning:topic` handler）、`electron/preload.ts`（新增 `learningTopic`）、`src/components/LearningDashboard.tsx`（钻取）、`src/components/ProgressView.tsx`（重构为 SQLite + 钻取）、`src/styles.css`（钻取样式）、`test/learning-summary.test.ts`（新增钻取单测，5/5 通过）。`tsc --noEmit` 无业务错误（仅环境噪声 TS2318/TS2552），`npm run build` 通过。

## [ISSUE-027 增强] 点进课程显示学习总结 + 课程列表搜索
- **需求（2026-08-21 追加）**：① 家长/孩子界面点进单课时要显示「课程学习的总结内容」；② 课程列表页面要有搜索功能。
- **实现（v1，已废弃）**：最初按「教学资料」理解，新增 `getCourseMaterial` 读 `learning/<topic>/materials/<课程名>.md`。
- **修正（2026-08-21 同日）**：用户明确指出「每一课程的学习总结在 daily 数据表里」「学习进度的展示都要从数据库里取数据，不是从文件里」。故**废弃文件读取**，改为从 SQLite `daily_entries`（block='学习'）取该课学习总结：
  - `kb-sqlite.ts` 新增 `queryCourseDailySummaries(childDir, topicName, courseTitle)` + 标题章节课时键 `chapterKey(title, topicName)`：先去主题中文名+`·`，优先取括号 `（…）` 内章节课时标识（`学而篇第三章`/`为政篇第五章`），再退化为归一化串；course 行与 daily 行按此键关联。已用真实 lunyu 数据验证（512 课中 238 课有 daily 总结；学而篇第一章→2 条含「重新系统学习」、为政篇第五章→正确命中）。
  - `learning-summary.ts` 删 `getCourseMaterial`，改 `getCourseDailySummary`（返回 `{date,title,raw,tags}[]` 升序）；`ipc-handlers.ts` 删 `learning:courseMaterial` 改 `learning:courseSummary`；`preload.ts` 改 `learningCourseSummary(childId, topicName, title)`；`CourseDetail.tsx` 渲染「📝 这一课的学习总结」卡片列表（react-markdown 渲染 raw），空态「暂未找到该课的学习总结记录」。进度字段卡（courses 表）保留。
  - `matchesCourseSearch` 搜索 helper 与两端🔍搜索框保留。
- **根因/坑**：courses 表与 daily_entries 无外键，关联靠标题；daily 标题带 `·` 与 `（…跟读练习）` 装饰，须去主题名+`·`、括号优先取章节课时键，否则会错位/漏匹配。
- 验证：`test/learning-summary.test.ts` 7/7 通过（含 `getCourseDailySummary` 真实数据：论语学而篇第一章→数组非空、含知识点、日期升序；未知课→[]）；`tsc --noEmit` 无业务错误；`npm run build` 通过。
- **优先级**：已解决。
- **记录时间**：2026-08-21

## [ISSUE-028] AI 返回消息过长时自动滚动停在结尾，孩子看不到开头——应把消息开头显示在一屏幕内

- **需求**：AI 返回的消息过长、一屏放不下时，当前自动滚动让消息**结尾**贴底，孩子要手动往上滚才能看到**开头**；希望进入一屏就能看到开头。
- **根因（已定位）**：`src/components/ChatWindow.tsx:220-224` 的 useEffect 在 `messages` 变化时**无条件**执行 `messagesRef.current.scrollTop = messagesRef.current.scrollHeight`（滚到底部）。当最后一条消息高度超过视口（`clientHeight`）时，「底部」落在该消息结尾之后，开头被顶出屏幕上方。
- **消息结构（已定位，可供锚点）**：滚动容器 `.chat-messages`（`ChatWindow.tsx:573`，`messagesRef`）；每条消息外层 `<div className="message ${m.role}">`（583）；AI 文本在 `.bubble.bubble-md`（600）。
- **候选修复（方向）**：滚动目标从「scrollHeight（底）」改为「最后一条消息的**顶部**」：取最后一条 `.message` 的 `offsetTop`（或整条消息高度），`target = min(scrollHeight - clientHeight, lastMsgTop)`——消息短时等价于滚到底（最后一条完整可见），消息超一屏时停在开头可见。流式 working 阶段（587）同样适用（逐步增长时锚定开头）。
  - 需注意：`.message` 是 flex 行（583 起含 emoji/气泡/按钮），取 `offsetTop` 前最好让布局稳定（如 `requestAnimationFrame` 后再算）。
  - 可选增强：用户主动向上滚动阅读历史时，新消息到达**不强行拉回**（需在滚动事件里记录「用户是否已上滚」）。
- **待确认**：① 流式增长期间是否也保持开头可见（还是仅最终态）；② 用户上滚阅读历史时新消息是否打断（增强项）；③ 是否要考虑「过长消息折叠/展开」作为补充（与锚点方案二选一或共存）。
- **排查 / 修改入口（可直接执行）**：`src/components/ChatWindow.tsx:220-224`（滚动 useEffect）、`573`（容器）、`583-600`（消息结构/锚点）。
- **关联**：ISSUE-004（气泡时间显示，同文件历史恢复链路）；ISSUE-018（thinking/tools 恢复——trace 展开会让消息更高，加剧此问题）。
- **已修复（2026-08-22 实施）**：`src/components/ChatWindow.tsx` 重写滚动逻辑——从「无条件滚到底」改为「滚到**最后一条消息顶部**」：`target = min(scrollHeight - clientHeight, lastMsgTop)`，消息能整条放进视口时仍滚到底（自然、整条可见），超一屏时把开头显示在一屏内。用 `getBoundingClientRect` 计算 `lastMsgTop`（不受定位祖先影响）；新增 `nearBottomRef` + scroll 监听，用户主动上滚阅读历史时（`distanceFromBottom > 80px`）不打断、不强行拉回，滚回底部附近才恢复自动滚动。流式 working 阶段同样锚定开头。验证：`tsc --noEmit` 仅余基线 `TS2318/TS2552` 全局类型错误（与本次无关）。⚠️ 渲染层改动需 `npm run build` 后手测：长 AI 回复开头可见、用户上滚读历史不被拉回、用户发新消息正常跟到底。
- **优先级**：已完成（2026-08-24 手测确认）
- **记录时间**：2026-08-21 / 2026-08-22 修复

## [ISSUE-029] 主题教学资料与 method 入 SQLite（家长中心库 + 主题分配/拷贝给孩子）；method 存全文而非文件链接；每课 method 与 html 地址入库；资料移出孩子目录、改由家长目录统一管理

- **需求（四点）**：
  1. 教学主题的教学资料也存入 SQLite；教学方法 `method` 也存入。
  2. `method` 存入 `topics` 表**新增的 `method` 字段**，**存整个文本**，而不是现在的文件链接。
  3. 每一课的教学方法存入 `courses` 表**新增字段**；还要新增一个字段**记录学习资料 html 的地址**。
  4. 教学资料不再放到孩子的目录下，改在**家长的目录里管理**：给家长建一个 SQLite 库，所有学习主题都在家长这里；家长可以**分配学习主题给孩子**，分配后该主题的数据**拷贝到孩子的数据库**里。
- **现状（已定位，ISSUE-023 已落地 per-child sqlite）**：
  - `electron/lib/kb-sqlite.ts`（schema v4）已是每孩子一个 `data/children/<childId>/kb.sqlite`，SQLite 为唯一真源；相关表 `daily_entries` / `courses` / `topics` / `tags` / `meta` + 视图 `topic_progress`。
  - **`topics` 表已有 `method` 列，但当前是文件链接**：`migrateAllToSqlite`（kb-sqlite.ts:456-465）从 `topics.md` frontmatter 的 `method: learning/lunyu/method.md` 取值（路径），不是全文。需改为读取 `method.md` 整篇写入。
  - **`courses` 表现有列**：`topic,title,sort_order,status,mastery,first_learned,last_review,review_count,material,send_material,tags`——**没有**「每课 method」列，也没有「html 地址」列。
  - **html 资料现状**：在 `data/children/<id>/learning/<topic>/materials/*.html`（lunyu 单主题就有 **512 个 html**），由 `method.md` 用 `display_content(path="learning/lunyu/materials/{课程名}.html")` 引用孩子相对路径；`english/method.md:14`、`hanzigong/method.md:11` 等同理。
  - **家长库现状**：**`data/` 下只有 `children/` 和 `shared/`，没有 `parents/` 目录，也没有任何 parent sqlite**。所有主题数据当前是每个孩子的 `learning/` 各存一份（重复）。
- **方案要点（候选）**：
  - **新增家长库** `data/parents/<parentId>/parent.sqlite`（沿用 childId 隔离范式；parent 概念在会话层已有 `getParentSession`/`getParentContentSession`，但无数据落盘）。表：`topics(method 全文, rules_json, …)`、`courses(topic,title,…,method,html_path)`、`materials(topic,course,html_path,html_content?)`、`meta`。
  - **`topics.method` 改全文**：迁移/写入时读 `learning/<topic>/method.md` 整篇存文本（替代文件链接）。
  - **`courses` 加列**：`lesson_method TEXT`（每课教学方法）、`html_path TEXT`（学习资料 html 地址，绝对或 parent 库相对路径）。
  - **资料上移**：html（及可选 md 文案）从孩子 `learning/<topic>/materials/` **移到家长库管理**（parent 库 `materials` 表或 parent 目录下 `materials/<topic>/`）；孩子库只存 `html_path` 指针，运行时按 path 读取展示。
  - **分配/拷贝**：家长在 UI 勾选主题分配给某孩子 → 触发「拷贝」：把该主题的 `topics`/`courses`/`materials` 从 parent 库写入孩子 `kb.sqlite`（含 html 落盘到孩子可访问路径，或孩子库保留 path 指向 parent 库共享目录）。需定义「分配后家长再改主题，孩子是否同步更新」策略（快照 vs 链接）。
- **关键决策点（待你拍板）**：
  1. parent 库 `materials` 是否把 html **内容也存进 sqlite**（BLOB/长文本），还是只存文件 + `html_path` 指针（parent 目录放真实文件）；
  2. 分配是「**快照拷贝**」（家长改了孩子不变）还是「**实时链接**」（指向 parent 库，家长改孩子即变）——决定孩子库要不要冗余存资料；
  3. 多孩子共享同一份主题时，html 文件放哪里避免重复（parent 共享目录 vs 每孩子一份）；
  4. 存量迁移：现有每个孩子的 html（lunyu 512 个等）如何一次性导入 parent 库并清理孩子目录；
  5. `display_content(path=…)` 路径语义要随之改（从孩子相对路径 → parent 库 path / 共享目录）。
- **排查 / 修改入口（可直接执行）**：
  - 现有 sqlite 层：`electron/lib/kb-sqlite.ts`（SCHEMA_TABLES 79-125、migrateAllToSqlite 400-513、queryTopicsMeta 683、insertCourse 826、COURSE_FIELD_MAP 777）。
  - 主题/method/资料引用：`data/children/<id>/learning/topics.md`、`*/method.md`（文件链接写法）、materials 目录。
  - 资料展示：`electron/lib/custom-tools.ts` 的 `display_content`（读 path 展示）；`src/components/MaterialsPanel.tsx` / `Learn.tsx`。
  - 家长层 UI：家长「教学内容」页（`src/components/TopicEditor.tsx`，ISSUE-026 已做左右分栏）、`Settings.tsx`、可能的「分配」入口需新增。
  - 会话提示：`pi-session.ts` 的 `buildChildPrompt`（method 注入方式）、`getParentContentSession`（家长制作教学内容）。
- **关联**：ISSUE-023（本 issue 是其泛化/升级——023 只解决 per-child 结构化数据入 sqlite；本 issue 引入 parent 库 + 主题分配 + 资料上移）；ISSUE-022（method 的 kb 约定——method 入库后引用写法要同步调整）；ISSUE-009（method 记录详细度——入库的是 method.md 全文，详细度规范仍生效）；ISSUE-026（家长教学内容页是「分配/管理主题」的天然入口）。
- **优先级**：待定（架构级，建议先出数据模型与分配策略再动手；影响面大：schema 变更 + 双库 + 迁移 + UI）。
- **记录时间**：2026-08-21

## [ISSUE-029 处理记录] 2026-08-21（已实施，用户拍板三项决策）
- **决策**：① 分配 = **快照拷贝**（家长改主题不影响已分配孩子，重新分配才生效）；② `topics.method` **全文入库**、html 用**文件指针**（父库共享目录，多孩子共享一份）；③ **现在一次性迁移**存量资料。
- **实施**：
  - 新增父库模块 `electron/lib/parent-library.ts`：`data/parents/<pid>/parent.sqlite`（topics.method 全文 + courses 含 lesson_method/html_path）+ `materials/<topic>/*.html` 共享目录；`listParentTopics`/`listParentTopicCourses`/`upsertParentTopic`/`allocateTopicToChild`（快照：存在则只补内容字段、进度保留）/`migrateChildrenToParent`（method 全文、html 上移、html_path 回填、courses 同步父库）。parentId 固定 `default`（单家长假设，已参数化）。
  - child `kb-sqlite.ts`：courses 加 `lesson_method`/`html_path` 列（schema v5 + `ensureV5`），`CourseItem`/`rowToCourse`/`insertCourse`/`COURSE_FIELD_MAP`（课时方法/每课教学方法/html地址/html_path/学习资料地址）同步；`migrateAllToSqlite` 的 topics.method 从文件链接改为读 method.md 全文。
  - `display_content`：html 解析父库共享目录优先（`learning/<topic>/materials/<file>` → `data/parents/default/materials/<topic>/<file>`）、孩子目录兜底；`create_html_lesson` 生成后镜像一份到父库。
  - IPC：`parent:listTopics`/`parent:listCourses`/`parent:allocate`/`parent:migrate`；preload 对应 4 个方法。
  - UI：`src/components/ParentTopicAllocator.tsx` 挂到「教学内容」页（主题库列表 + 选孩子分配 + 迁移按钮，迁移有 confirm）。
  - **迁移已执行**：512 html 全部上移父库（孩子目录 0 残留，materials 目录保留 .md 教学文稿），孩子 courses.html_path 回填 512、topics.method 8 主题改全文；父库 8 主题（中文名）+ 1300 课 + 512 html_path。迁移前已备份 `data-backup-20260821-issue029/`（220MB，含 learning + kb.sqlite）。
  - 测试：`test/parent-library.test.ts` 4 用例（method 全文/课程字段/快照分配不丢进度/迁移链路，config mock 临时目录）；learning-summary 7/7；tsc 0；build 过。
- **遗留/后续**：① `create_html_lesson` 仍先写孩子目录再镜像父库（未完全改走父库 cwd，生成 html 可能带旧 childId media 引用——旧格式 handler 兜底可用，但多孩子共享时建议统一新格式）；② 家长端「编辑主题/制作资料」仍走 TopicEditor 孩子文件视角，未完全切到父库读写；③ display_content 兜底逻辑依赖孩子目录，后续可删。迁移时曾遇 `database is locked`（openParentDb 的 DROP VIEW 写锁竞争）→ 已改「视图存在则跳过重建」+ busy_timeout 10s。
- **媒体上移（html 引用）**：用户指出「html 里引用的 media 也要放到位置，不然 html 用不了」——512 个 html 均引用 `media://local/{childId}/learning/lunyu/media/{课程名}.mp3`（audio，206MB）。已把媒体 `mv` 到父库 `data/parents/default/materials/lunyu/media/`（共享，孩子目录清空删除）；512 个 html 的引用全部重写为 **`media://local/parent/{pid}/{topic}/media/{文件}`**（与 childId 解耦）；`media-protocol.ts` 重构：抽出纯函数 `resolveMediaTarget(dataDir, pathname)` 支持新 parent 格式 + 旧 childId 格式兜底 + 防穿越（parentId 含 ../\ 拒绝、resolve 后必须仍在 base 内），ALLOWED_EXT 不变；新增 `test/media-protocol.test.ts` 6 用例（新/旧格式、百分号解码、穿越拒绝、parentId 含 ../\ 拒绝、空路径）。验证：512 引用 0 缺失、0 旧格式残留、17/17 测试过、tsc 0、build 过。
- **分配入口移到孩子管理页**：用户要求「给孩子分配学习主题应该在孩子管理页面」。实施：① 删除 `src/components/ParentTopicAllocator.tsx`（原挂在「教学内容」页），从 TopicEditor 移除引用；② 新增 `src/components/ChildTopicsModal.tsx`——孩子在 `Dashboard.tsx`「孩子管理」卡片点「学习主题」按钮弹出，列出家长库主题（已学/总数、html 数、method 状态），一键「+ 添加主题」（parentAllocate 快照拷贝），已添加显示「✓ 已添加」，含「迁移存量资料」按钮；③ 新增 `parent:listChildTopics` IPC + `parentListChildTopics` preload + `listChildAllocatedTopics(childId)`（parent-library.ts，读孩子 kb.sqlite topics，无库返回空）。测试 +1（listChildAllocatedTopics 空/分配后），18/18 过、tsc 0、build 过。
- **学习进度入口 + 课程管理页**：① 孩子管理卡片新增「学习进度」按钮（setView=progress + 预选该孩子，直达其进度看板）；② 家长中心侧栏新增「课程管理」视图（`src/components/CourseManager.tsx`）：主题选择 + 新建主题（`parent:upsertTopic`，空 method/courses）、课程列表 + 课程表单（标题/每课方法/教学资料/学习资料/标签/html地址 → `parent:upsertCourse` 保存、`parent:deleteCourse` 删除；upsert 用 **NULLIF-COALESCE 只覆盖非空字段**，避免自动关联 html 时误清其它字段）、上传资料（`parent:uploadMaterial` 主进程对话框 → `copyMaterialIntoParent` 落盘父库 materials/<topic>/，媒体自动进 media/ 子目录，html 与课程同名自动回填 html_path）、agent 聊天（复用 parent-content 会话，上下文注入主题/课程/资料目录，agent 可 write/edit 父库 materials 下文件）。测试 +3（upsert/delete、copy 落盘 html vs media、listMaterials）→ 21/21、tsc 0、build 过（注：build 曾因运行中的 electron 占住 out/ 报 EPERM，杀进程后通过）。
- **课程管理重构（卡片 + 三列详情）**：用户要求「课程管理用卡片展示每个学习主题，主题卡片里有教学方法/课程详情/基本信息三个按钮；点击进入详细页面（三列：左课程列表、中 AI 对话框、右选中课程的详细信息）」。实施：① `CourseManager.tsx` 重写为主题卡片网格（卡片=主题名/课程数/html 数/方法状态 + 三按钮），`TopicDetail.tsx` 新增三列详情页——左：课程列表（添加/删除/↑↓排序）；中：AI 对话（上下文注入主题/课程/资料目录）；右：标签切换「教学方法（method markdown 渲染 + 编辑保存，parent:upsertTopic）/ 课程详情（名称 + 教学文案 markdown + 发给学生的学习材料——html_path 文件或 html 片段用 sandbox iframe 渲染，否则 markdown；含上传资料自动关联）/ 基本信息（主题名/目录/课程数/html 数/方法长度/每日目标/类型）」。② 数据层：`moveParentCourse`（与相邻课程交换 sort_order，`parent:moveCourse` IPC）、`readParentMaterial`（按相对父库根读资料文件防穿越，`parent:readMaterial` IPC）。③ AI 建课工具：新增 `parent_course_save`/`parent_course_delete` 两个 custom tools 并注册到家长内容会话（tools 白名单同步，谨记 ISSUE-006 教训），提示词补充家长库建课段（去掉模板字符串内反引号，曾引发 TS1005）。测试 +2（move 排序边界、readMaterial 内容/穿越）→ 23/23、tsc 0、build 0。
- **教学文案入库（courses.teaching_copy）**：用户要求「course 里增加教学文案字段，把文件存储的教学文案也放到数据库里；现在只有 lunyu 提供了，就把 lunyu 的放进去」。实施：child + parent courses 均加 `teaching_copy` 列（child ensureV5 扩展；parent 新增 `ensureParentV2`——`CREATE TABLE IF NOT EXISTS` 不会改已存在旧表，必须显式 ALTER 加列）；`CourseItem`/`rowToCourse`/`rowToParentCourse`/`insertCourse`/`upsertParentCourse`（NULLIF-COALESCE）/`upsertParentTopic`/`allocateTopicToChild`/`migrateChildrenToParent`（同步 + 新增 3.5 步：materials/<课程名>.md → teaching_copy 回填父库+孩子库，幂等 guard `teaching_copy='' OR IS NULL`）/`COURSE_FIELD_MAP`（教学文案/teaching_copy）全链路；`parent_course_save` 工具加 teachingCopy 参数；TopicDetail 课程详情「教学文案」改用 DB teachingCopy（markdown 渲染）。**真实数据已回填：父库 + 孩子库 lunyu 均 512/512**（内容为 md 全文）。测试 +1（migrate md 回填父库+孩子库）→ 24/24、tsc 0、build 0。注意：迁移统计 teachingCopyBackfilled 在真实数据上显示 0 但实测两库均已填（计数疑点未深究，以直查库为准）；另有 497 个散落孩子目录的 html 重复文件在迁移中被按「父库已有→删除孩子侧」清理（父库共享副本完好）。
- **孩子库去重（method/teaching_copy 只存家长库，专用工具查询）**：用户问「孩子的数据库里能否不要有主题教学方法和教学文案，要查询时通过专用工具从家长的表里获取内容」——采纳并落地：① `allocateTopicToChild` 不再拷贝 topics.method 与 courses.teaching_copy（孩子库只留主题骨架/进度/lesson_method/html_path 指针）；② `migrateChildrenToParent` 的 method 写入与 teaching_copy 回填**只写父库**，不再写孩子库；③ 新增 `parent_content` 专用工具（custom-tools.ts）注册到**孩子会话**（tools 白名单 + customTools 同步，谨记 ISSUE-006），type=method|teachingCopy，后端 `getParentContentForChild(childId, topicDir, type, course?)`（parent-library.ts）——**先校验该孩子确实分配了该主题再读家长库**，未分配一律拒绝，防越权；④ 孩子行为规范（LEARNING_NAV）更新：学习流程改为 kb_query topics + parent_content 取方法/文案，删除「读 method.md」旧指引；⑤ 存量清理：真实孩子库 topics.method 8 行、courses.teaching_copy 1300 行已清空（家长库仍为唯一真源，内容可随时取回）。测试：allocate 断言孩子库 method/teachingCopy 为空 + 新增 getParentContentForChild（未分配拒绝/分配后可取/其它主题拒绝）+ migrate 断言只回填父库 → 25/25、tsc 0、build 0。
- **孩子提示词来源全面 DB 化排查**：用户要求「排查孩子的提示词来源，都调整为使用数据库数据的工具」。逐项排查孩子会话提示词链路并修正：① **LEARNING_NAV/AGENTS.md**（上轮已改，本轮确认并**刷新真实孩子磁盘 AGENTS.md**——磁盘旧文案仍指引读 method.md，writeAgentsMd 每次开会话才重写，app 关闭期间为陈旧状态，已用临时脚本重写为新文案且保留 custom 段）；② **教学技能** recording / study-tracker 的 SKILL.md：均已用 kb_query/kb_insert/kb_update（确认无需改）；③ **工具描述**（孩子可见即提示词）：`display_content` 的「以该主题 method.md 的规定为准」→「以 parent_content 取到的教学方法为准」；`kb_insert`/`kb_update` 描述里「method.md / materials/ 等内容文件」→「materials/ / uploads/」（method 已非孩子文件）；`kb_query` 描述「字段由 method 定义」→「由家长库 method 定义」；④ **learning-guard 扩展**：日期注入文案「更新进度文件的日期字段」→「更新课程时间字段（首次学习/最近复习）」（进度已 SQLite 化）；⑤ 确认 `learning-summary.ts`（getLearningSummary/getTopicProgress/getCourseDailySummary）全部 SQLite 读（queryTopicProgress/queryCourseDailySummaries），`get_progress`/`kb_query`/`parent_content` 均 DB 后端。新增 `test/agents-md.test.ts` **锁定不变量**（AGENTS.md 必须含 parent_content、不得含「读 method.md/先读 topics.md」、数据读写禁 read/write/edit、进度查询禁读文件正文）→ 28/28、tsc 0、build 0。
- **parent_content 增加 htmlPath 查询**：用户要求「parent_content 还要能查询课程学习资料的 html 文件路径」。实施：① `ParentContentType` 增加 `htmlPath`，`getParentContentForChild` 按课程查 html_path 并**校验文件真实存在**（避免返回失效指针），返回家长库相对路径 `materials/<topic>/<file>.html`；② `parent_content` 工具 description/参数/错误文案同步（type=method|teachingCopy|htmlPath，course 必填）；③ `display_content` 的 path 解析扩展为**同时接受家长库相对路径** `materials/<topic>/<file>.html` 与旧 `learning/<topic>/materials/<file>.html`（正则 `^(?:learning\/[^/]+\/)?materials\/...`），描述注明 htmlPath 返回格式可直接传入。测试 +2 断言（htmlPath 文件不存在 → not found；造文件后返回正确路径）→ 28/28、tsc 0、build 0。
- **提示词分层去重（method/AGENTS/技能）**：用户问「既然工具描述写清楚了，为什么 AGENTS 和 method 还重复写怎么使用」——定位为「怎么调（工具描述唯一真源）vs 何时用/红线（AGENTS）vs 教学协议（method）」三层混叠，且 method 已与 parent_content 设计**漂移**（仍写「先读 learning/lunyu/materials/{课程名}.md」）。按用户拍板清理：① **8 个主题 method**（家长库 topics.method，`scripts/fix-method-tool-refs.py` 可重复执行，先备份 parent.sqlite.bak-dedup）：删 kb_update/kb_insert 参数级 JSON 示例 → 语义描述；教学文案读取 → `parent_content teachingCopy`；display_content 路径 → 家长库相对路径 `materials/<topic>/<file>.html`（论语 2 处）；tags 文件 `tags/{tag}.md` → kb_query 按 tag 查；小篆/陶笛「读索引文件定位」→ kb_query 课程清单、考核「读 materials 对应课」→ parent_content；春风阅读「读 reading.md 顺序」→ 系统 next；汉字宫保留索引 md + 字卡 html 内容文件流程（仅清 kb JSON）。每主题精简 ~190-250 字符；② **AGENTS.md（LEARNING_NAV）**：学习/记录/进度查询段去掉 `{query:"topics"}`/`{table:"course"}` 等 JSON，只留策略红线；③ **recording 技能 SKILL.md**：同步去 JSON 示例，保留领域语义（复习次数 +1、标签行、写入顺序），「课程名一致」改指课程表；④ 刷新真实孩子磁盘 AGENTS.md（保留 custom 段）；⑤ 测试加固：agents-md.test.ts 新增断言 AGENTS 不含 `{table:"course"`/`{query:"topics"`/`{query:"tags"`/`{query:"progress"` → 28/28、tsc 0、build 0。
- **method/技能二次去参数（只描述「用什么工具做什么」）**：用户指出「method 里还是有工具的调用参数，应该只描述用工具获取什么东西」——上一轮保留的 `（type:"teachingCopy"，topic 传…、course 传…）`、`（table 用 course：topic 传…、field 传…、value 传…）` 等仍是调用参数。二次清理（并入 `scripts/fix-method-tool-refs.py` 的 pass2，对当前库幂等）：method 里 parent_content 只写「获取该课教学文案/该篇教学文案/html 资料路径」；kb_update 只写「更新该课进度：状态→✅、掌握度、首次学习、最近复习」；kb_insert 只写「写入当日「学习」记录（### 课程名 标题 + 原文）」；kb_query 只写「查相关生活事件」；论语 display 改「（html 资料路径可先用 parent_content 获取）」。保留的仅领域语义字段名（状态/掌握度/首次学习/最近复习/### 课程名）与规则（learned/total/next 视图自动计算、字段缺失追加）。recording 技能同步清 `table 用`/`query 用`/`field 传`/`value 传` 及 `kb_query {query:"tags"}` JSON。验证：method 8/8 零参数残留、recording 零残留、每主题再精简 ~110-300 字符（论语 -305）；28/28、tsc 0、build 0。新增 `scripts/verify-method-clean.py` 可复查。
- **优先级**：已完成（2026-08-24 用户确认告一段落；管理端深化列为后续项）。

## [ISSUE-031] 给孩子分配学习主题时没有「每天学习量」的设置入口——应在家长界面分配时设置

- **类型**：需求 / 新功能（待拍板后实施）
- **需求**：每个孩子在分配学习主题时，「每天的学习量」没有地方设置。应在**家长界面给孩子分配学习主题**时设置该孩子在该主题的**每天学习量**（如每天学 3 章论语 / 2 课汉字宫 / 1 个内容单元英语）。
- **现状（已全部定位）**：
  1. **每日学习量目前只在旧文件、手工维护、已与 SQLite 链路脱节**：`data/children/<id>/learning/rules.md` frontmatter（真源为珊珊的）`rules: 论语:{daily:3,...} 汉字宫:{daily:2} 千字文:{daily:1} 英语:{daily:1, unit:内容单元}`；文件头注释「每日学习目标量。调整时直接改本文件」——需**手改文件**，家长界面无任何入口。
  2. **SQLite 迁移时 daily 被丢弃**：`kb-sqlite.ts:512` `migrateAllToSqlite` 写 topics 表 `insert.run(..., "{}")`——`rules_json` **硬编码空对象**，rules.md 的 daily 量未迁入任何库；实测父库 `parent.sqlite` topics 表 8 行 `rules_json` 全为 `{}`。
  3. **父库/孩子库 topics 表都没有「每日学习量」字段**：父库 `PARENT_SCHEMA_TABLES:44-50`、孩子库 `kb-sqlite.ts:113-119` 均为 `name, file, method, progress, rules_json`。
  4. **分配链路无 daily 参数**：`allocateTopicToChild(parentId, childId, topicDir)`（`parent-library.ts:273-332`）只拷 `name/file/rules_json`（method 不拷，走 parent_content），签名里没有学习量；`parent:allocate` IPC 同名透传。
  5. **分配 UI 无输入框**：`src/components/ChildTopicsModal.tsx:64`「+ 添加主题」按钮直接 `window.api.parentAllocate(child.childId, topicDir)`，无任何每日学习量设置控件。
- **方案要点（候选）**：
  - **数据模型**：daily 量是「**孩子 × 主题**」维度（同一主题不同孩子可不同）→ 孩子库 `topics` 表加列（如 `daily_amount TEXT/INTEGER`，幂等 ALTER 参照 `ensureV5`/`ensureParentV2` 范式）；父库 topics 可加 `daily_amount` 默认值，分配时快照进孩子库（分配后家长改默认不影响已分配孩子——沿用 ISSUE-029「快照拷贝」语义），或分配时按孩子单独设置。
  - **UI**：`ChildTopicsModal.tsx` 分配时弹「每天学习量」输入（数字 + 可选量纲说明）；或分配后在该孩子主题行内可编辑。
  - **消费方**：学习流程/study-tracker 从哪读 daily（`kb_query topics` / 新字段）需同步；ISSUE-019「进度 vs 计划」对比直接依赖此量。
- **待确认项**：
  1. 学习量字段放孩子库 topics（每孩子独立）还是父库默认+分配快照（沿用 ISSUE-029 语义）？
  2. 量纲：整数课数（每天 N 课）？还是允许自由文本（英语的「内容单元」、论语的「章」）？是否沿用 rules.md 的 `daily` + `unit` 双字段写法？
  3. UI 形态：分配时弹框设置 vs 分配后列表行内编辑；是否要「全局默认 + 按孩子覆盖」？
  4. 存量数据：现有 rules.md 的 daily（论语3/汉字宫2/千字文1/英语1）是否一次性迁入新字段？rules.md 是否废弃（同 ISSUE-013 清理遗留文件的思路）？
  5. 与 rules_json 的关系：rules_json 目前全空、无消费方，是否并入新字段或删除该列？
- **排查 / 修改入口（可直接执行）**：
  - 分配逻辑：`electron/lib/parent-library.ts:273-332`（allocateTopicToChild）+ `parent:allocate` IPC（ipc-handlers.ts）+ preload `parentAllocate`。
  - 分配 UI：`src/components/ChildTopicsModal.tsx`（:64 添加按钮、主题列表渲染）。
  - 表结构：父库 `parent-library.ts:44-50`、孩子库 `kb-sqlite.ts:113-119` + 幂等迁移（`ensureParentV2` 115-120 / `ensureV5` 范式）。
  - 旧数据：`data/children/<id>/learning/rules.md`（daily 真源）、迁移 `kb-sqlite.ts:512`（rules_json 硬编码 `{}`）。
  - 消费方：`electron/lib/learning-summary.ts`（getLearningSummary 的 daily 字段）、study-tracker/学习提示词（kb_query topics）。
- **关联**：ISSUE-029（主题分配/快照语义——daily 量随分配一起拷贝）；ISSUE-019（家长页「进度 vs 计划」展示依赖此量做偏差计算）；ISSUE-013（kb 工具族查询）。
- **优先级**：已完成（2026-08-24 用户确认；构建后手测通过）。
- **记录时间**：2026-08-21 / 2026-08-22 实施

## [ISSUE-031 处理记录] 2026-08-22（已实施）
- **拍板**：学习量存孩子库 `topics.rules_json.daily/type`（随分配从父库快照带入，每孩子可独立改）；UI = 分配时弹框设置 + 分配后行内可编辑。
- **实施**：
  - `parent-library.ts`：`listChildAllocatedTopics` 现返回 `daily/type`（解析 rules_json）；新增 `setChildTopicDaily(childId, topicDir, daily, type)` 写回孩子库 rules_json（幂等、主题不存在忽略）。
  - IPC/preload：新增 `parent:setChildTopicDaily` + `parentSetChildTopicDaily`。
  - UI：`ChildTopicsModal.tsx` 重写——已添加主题行内显示「每天学习量」输入框 + 类型下拉（必学/选学/复习）+ 保存；未添加主题点「+ 添加主题」弹出设置面板（默认带父库 daily/type），确认后 `parentAllocate` 紧接着 `parentSetChildTopicDaily` 写入。
  - 迁移不丢量：孩子库 topics.rules_json 独立于父库迁移，存量 daily 不会丢；`migrateAllToSqlite` 父库 topics 写 `{}` 仅影响父库默认（分配时父库默认 daily 现由分配链拷贝，见 rules_json 已随行）。
- **说明**：`rules_json` 已承载 daily/type（灵活自由文本，支持「3」「1 内容单元」等量纲），无需新增列；消费方（ISSUE-019 计划对比）后续从 `kb_query topics` 读 rules_json.daily 即可。
- **验证**：`tsc --noEmit` 相关文件 0 错。`npm run build` 后需手测：分配弹框设量、分配后改量保存、父库默认值带入。

## [ISSUE-032] 创建孩子时的目录结构仍按「文件时代」初始化，需按 SQLite 化后的结构调整

- **类型**：结构重构（待拍板后实施）
- **需求**：创建孩子时（`initChildDirectory`）孩子目录下创建的文件夹结构要改——现在部分信息已改为数据库存储（kb.sqlite 唯一真源），init 仍创建大量已废弃/冗余的目录与模板文件。
- **现状（已全部定位）**：
  1. **`initChildDirectory`（`electron/lib/user-init.ts:115-192`）仍按文件时代初始化**：
     - 创建 7 个归档目录 `daily/ learning/ life/ inquiries/ tasks/ outputs/ tags/`（:129-139）；
     - 创建 `daily-logs/` 空壳目录（:126）——ISSUE-013 已判定删除，init 却仍创建；
     - 写已废弃模板文件 `study-topics.md`（:147-151）、`study-rules.md`（:153-157）、`life-events.md`（:159-163）——ISSUE-013 已判定废弃删除，init 仍写盘（**实测珊珊目录 8-20 仍残留这三个文件**，即清理后又由 init/其它路径重建）；
     - 写 `learning/topics.md`（:171-175）、`learning/rules.md`（:177-181）模板——主题清单与分配已走家长库/孩子库 `topics` 表（ISSUE-029），daily 量应入库（ISSUE-031）；
     - 写 `tags/taxonomy.md`（:165-169）——标签体系 v4 已改为「标签直接打在数据行」，tags 定义真源是 kb.sqlite `tags` 表（recording SKILL.md:55），taxonomy.md 已是归档。
  2. **SQLite 已是唯一真源**：recording SKILL.md:7「SQLite 知识库 kb.sqlite 唯一真源，daily/、life/、inquiries/、tasks/、tags/、learning 进度的 markdown 只是历史归档，**不要读写**；一律用 kb_query/kb_insert/kb_update」；`openKbDb`（`kb-sqlite.ts:155-167`）首次打开自动建表（SCHEMA_TABLES + ensureV3/V4/V5 + 视图），**不依赖 init 预建目录**。
  3. **仍必要**：`profile.json`（:141）、`.pi/agent/sessions` + `.pi/agent/settings.json`（:122-124、183-187）、`.pi/skills`（:125）、`AGENTS.md`（:189 writeAgentsMd）；`uploads/` 由上传 IPC 按需 `mkdirSync`（`ipc-handlers.ts:838/932`），init 无需建。
  4. **kb.sqlite 初始化时机**：init 目前**不创建** kb.sqlite（首次 openKbDb 才建）；新孩子建议 init 时显式初始化空库（openKbDb 建表即可，幂等）。
  5. **约束——kb-lint 依赖这些目录/文件，改动需同步**：`electron/lib/kb-lint.ts:44` `REQUIRED_DIRS = ["daily","learning","life","inquiries","tasks","tags","outputs"]`（结构校验，缺失报错）；`:87-94` 校验 `learning/topics.md`、`learning/rules.md` **存在**（frontmatter 缺失报「主题清单未配置」）——与 ISSUE-029/031 入库方向矛盾，删目录/文件前必须先改 lint（存在性校验改查 kb.sqlite `topics` 表）。
- **方案要点（候选）**：
  - **init 新结构**：只建 `childDir` + `.pi/`（agent/sessions、skills、settings.json）+ `profile.json` + `AGENTS.md` + 初始化空 `kb.sqlite`；**不再创建归档目录与废弃模板**（study-topics/study-rules/life-events/daily-logs/taxonomy）。
  - **归档目录按需创建**：老孩子迁移/lint 场景需要时再建；或 **kb-lint 去掉 REQUIRED_DIRS 结构检查**（改查 kb.sqlite），topics/rules 存在性校验改查库。
  - **清理存量残留**：已有孩子目录里的 `study-topics.md` / `study-rules.md` / `life-events.md` / `daily-logs/` 清理（数据已迁移，无丢失风险，同 ISSUE-013 思路）。
  - 老孩子的 `daily/*.md`（珊珊 102 个）等历史归档文件：只读归档，可保留不动或按需压缩（可选）。
- **待确认项**：
  1. 新孩子 init 是否初始化空 kb.sqlite（推荐）？
  2. 归档 7 目录新孩子是否**完全不建**？kb-lint 的 REQUIRED_DIRS / topics.md·rules.md 存在性校验是否改为查库？
  3. 是否保留一份「人类可读」的目录（如 learning/ 仅存 topics.md 占位供家长直接查看）？
  4. 存量孩子目录残留文件是否一并清理？
- **排查 / 修改入口（可直接执行）**：
  - init：`electron/lib/user-init.ts:115-192`（initChildDirectory）+ 模板常量（STUDY_TOPICS_TEMPLATE/STUDY_RULES_TEMPLATE/LEARNING_TOPICS_TEMPLATE/LEARNING_RULES_TEMPLATE/buildTaxonomyMd）。
  - lint 依赖：`electron/lib/kb-lint.ts:44`（REQUIRED_DIRS）、`:87-94`（topics/rules 存在性）。
  - 库初始化：`electron/lib/kb-sqlite.ts:155-167`（openKbDb，建表幂等，可直接在 init 调用）。
  - 实测残留：`data/children/1f050a7f-…/`（study-topics.md / study-rules.md / life-events.md / daily-logs/ 存在）。
- **关联**：ISSUE-013（kb-lint/目录规范同源，本 issue 是结构侧收敛）；ISSUE-029（主题/资料已上移父库）；ISSUE-031（rules.md 的 daily 量入库后，rules.md 更无存在必要）。
- **优先级**：已完成（2026-08-24 用户确认；构建后手测通过）。
- **记录时间**：2026-08-21 / 2026-08-22 实施

## [ISSUE-032 处理记录] 2026-08-22（已实施）
- **拍板**：新孩子只建最小集；SQLite 唯一真源；kb-lint 去掉目录结构硬性检查、topics/rules 改查库；标签词表从 taxonomy.md 改为初始化时写入孩子库 tags 表（默认 20 个）。
- **实施**：
  - `user-init.ts` `initChildDirectory` 改为只建 `childDir` + `.pi/agent/sessions` + `.pi/skills` + `profile.json` + `.pi/agent/settings.json` + `AGENTS.md`；**不再建** `daily/learning/life/inquiries/tasks/outputs/tags/` 与 `daily-logs/`、`study-topics.md`/`study-rules.md`/`life-events.md`/`tags/taxonomy.md`/`learning/topics.md`/`learning/rules.md`；删除对应模板常量与 `buildTaxonomyMd`。新增 `initChildKb(childDir)`：调 `openKbDb` 建表并写入默认 20 个标签词表（tags 表空时才写）。
  - `kb-lint.ts`：移除 `REQUIRED_DIRS` 结构检查（仅校验 kb.sqlite 存在）；`lintSqliteTopicsRules` 改查孩子库 `topics` 表（空则报「未配置任何主题」），不再检查 `learning/topics.md`/`rules.md` 文件。
  - 运行时安全：排查确认新孩子创建路径无任何代码写这些废弃目录（`progress:get` 用 `existsSync` 守卫，缺文件仅省略字段，不报错）。
  - 测试同步：`test/app.test.ts`、`test/functional.test.ts`、`test/sync.test.ts` 的文件存在性断言改为断言 `kb.sqlite` + `AGENTS.md`；`functional.test.ts`「文件模板」两个 `it` 改写为断言 kb.sqlite + tags 表 20 行；`sync.test.ts` 的 hash 变更测试改用 `profile.json`。
- **验证**：`tsc --noEmit` 相关文件 0 错。`npm run build` 后需手测：新增孩子目录干净、kb-lint 对新孩子无「缺失目录」报错、默认标签词表就绪。

## [ISSUE-032 二次确认] 2026-08-24
- **用户再次提出**：「新建孩子账户时不要创建旧的路径文件夹，目前数据结构都调整到 sqlite 里，只需要生成 sqlite 文件即可。」
- **核实结论**：与 ISSUE-032 需求完全一致，且该 issue 已于 2026-08-22 实施完成。当前 `electron/lib/user-init.ts:63-96` 的 `initChildDirectory` 已仅建最小集（`childDir` + `.pi/agent/sessions` + `.pi/skills` + `profile.json` + 空 `kb.sqlite`（`initChildKb`）+ `.pi/agent/settings.json` + `AGENTS.md`），**不再创建** `daily/learning/life/inquiries/tasks/outputs/tags` 等旧归档目录与 `study-topics.md`/`study-rules.md`/`life-events.md`/`tags/taxonomy.md`/`learning/topics.md`/`learning/rules.md` 等废弃模板。无需新增 issue，确认闭环。

## [ISSUE-033] AGENTS 改为「代码默认 + 用户版本」：用户可编辑（每孩子 + 家长各一份），带历史版本可回退

- **类型**：架构 / 新功能（待拍板后实施）
- **需求**（用户原话要点）：「AGENTS 不要（文件），编到代码里，可以有个默认值，但用户可以修改，修改后就是用户的版本，以后都用用户的版本构建 prompt。每个孩子的 AGENTS 以及父母的 AGENTS 都这样操作。目的是为了让用户能自己编辑，编辑坏了，可以回退版本。」
- **现状（已全部定位）**：
  1. **孩子侧**：默认内容已在代码（`LEARNING_NAV_INSTRUCTIONS` `pi-session.ts:17-54` + `buildAgentsMd(profile)` `:66-85` 拼身份段）；`getChildSession` 每次开会话前调 `writeAgentsMd`（`:87-103`）**写盘** `data/children/<id>/AGENTS.md`，SDK 的 DefaultResourceLoader 在 customPrompt 模式下**自动把 AGENTS.md 文件附加为 `<project_context>`**（`createAgentSession` 不读 extension 同理，loader 是唯一注入通道）。
  2. **用户编辑现状 = 只能改 custom 段**：`writeAgentsMd` 只保留 `<!-- custom:start/end -->` 之间的内容（`extractCustomSection` `:59-64`），其余部分每次开会话都用代码默认**覆盖重建**——家长在 AGENTS.md 里改 custom 段之外的任何内容都会**被冲掉**（设计上只允许改 custom 段）。
  3. **家长侧**：`buildParentPrompt()`（`:105-153`）与 `buildParentContentPrompt()`（`:159+`，ISSUE-026）是**纯代码字符串**，经 `systemPromptOverride`（`:421`/`:457`）直接注入——**没有落盘文件、没有 custom 段、没有用户编辑入口**。
  4. **版本管理完全没有**：AGENTS.md 覆盖写盘，无历史版本、无回退能力；家长提示词更是代码常量。
  5. **相关既有事实**：ISSUE-025 已从家长界面移除「技能管理/技能编辑器」tab——本需求是**新增 AGENTS 编辑入口**，与技能编辑器无关（只编辑提示词本身），不冲突但需确认入口位置。
- **方案要点（候选）**：
  - **默认值在代码（已有，保持）**：`LEARNING_NAV_INSTRUCTIONS` + `buildAgentsMd` / `buildParentPrompt` / `buildParentContentPrompt` 即「代码默认」；引入统一的 `resolveAgents(kind: child|parent, ...)`：**存在用户版本则用用户版本，否则用代码默认**构建 prompt（用户版本优先，永不写盘覆盖）。
  - **用户版本存储**（与库化方向一致，候选）：
    - 方案 A（推荐）：家长库/孩子库 `meta` 表存「用户版本」+ 新增 `agents_versions` 表存历史版本（content/ts/备注），容量上限（如最近 20 版）；
    - 方案 B：JSON 文件（`data/children/<id>/agents-user.json`、`data/parents/<pid>/agents-user.json`，`{current, history:[...]}`）。
  - **孩子 AGENTS 注入方式（待确认）**：仍走 AGENTS.md 文件（文件内容 = 用户版本，`writeAgentsMd` 改为「有用户版本就写用户版本、否则写代码默认」，**不再无条件覆盖**）；或改为 `systemPromptOverride` 内联（`buildChildPrompt` 里拼 AGENTS，彻底去掉文件依赖——即「AGENTS 不要（文件）」的字面实现）。
  - **版本回退**：UI 展示历史版本列表，回退 = 把某历史版写入用户版本（回退本身也记一版，可再回退）；提供「恢复默认」= 清空用户版本。
  - **UI 入口**：家长中心新增「AI 提示词 / AGENTS」设置（每孩子一份 + 家长全局一份），编辑器 + 历史版本列表 + 回退/恢复默认按钮。
- **待确认项**：
  1. 用户版本是**整体替换** AGENTS 文本，还是**在代码默认基础上只改特定段**（现 custom 段语义泛化）？——影响合并逻辑与「代码升级后用户版本是否跟进新默认」的取舍（整体替换=用户版本与代码默认完全解耦；分段=默认更新自动生效）。
  2. 存储走 SQLite（家长/孩子库 meta + versions 表）还是 JSON 文件？
  3. 孩子 AGENTS 注入：保留 AGENTS.md 文件（内容=用户版本）vs 完全内联 systemPromptOverride（去掉文件）？
  4. 历史版本上限（如 20）与「回退是否记版本」？
  5. 家长侧是**一份统一** AGENTS，还是 `buildParentPrompt`（通用助手）与 `buildParentContentPrompt`（教学内容助手）**各一份**用户版本？
  6. UI 入口位置（家长中心哪个视图）？
- **排查 / 修改入口（可直接执行）**：
  - 代码默认与注入：`electron/lib/pi-session.ts`——`LEARNING_NAV_INSTRUCTIONS`（:17-54）、`buildAgentsMd`（:66-85）、`writeAgentsMd`（:87-103，含 extractCustomSection :59-64）、`buildChildPrompt`、`buildParentPrompt`（:105-153）、`buildParentContentPrompt`（:159+）、`getChildSession`（:352 刷新调用）、`getParentSession`（:421）、`getParentContentSession`（:457）。
  - 存储：孩子库 `electron/lib/kb-sqlite.ts`（meta 表，SCHEMA_TABLES :127-130）、父库 `electron/lib/parent-library.ts`（meta 表 :71-74）。
  - UI：家长中心（Dashboard/Settings 相关视图，新增入口）。
- **关联**：ISSUE-026（家长内容会话提示词——家长侧用户版本覆盖对象之一）；ISSUE-025（技能编辑器已移除，AGENTS 编辑入口是独立新增）；ISSUE-032（若孩子 AGENTS 改为内联，`AGENTS.md` 文件去留与目录结构联动）。
- **优先级**：已实施（代码完成，待构建后手测；用户拍板「整体替换 + SQLite 存储 + 家长中心设置页；孩子/家长各一份 + 历史版本可回退」）。
- **记录时间**：2026-08-21 / 2026-08-22 实施

## [ISSUE-033 处理记录] 2026-08-22（已实施）
- **拍板**：整体替换（用户版本与代码默认完全解耦，编辑坏了可一键回退默认）；存储走新建 `data/agents.sqlite`（`prompts` 当前版 + `prompt_history` 历史版）；保留 AGENTS.md 文件（内容=用户版本）；家长中心新增「AI 提示词」设置入口（孩子 + 家长各一份，含历史回退）。
- **实施**：
  - 新增 `electron/lib/agent-prompts.ts`：`getAgentPrompt/saveAgentPrompt/resetAgentPrompt/listAgentPromptHistory/restoreAgentPromptVersion`，scope/ref 维度（child=<childId>；parent=main 通用助手 / content 教学内容助手）。保存时旧版推入历史；空内容=恢复默认（删当前版，留历史）。
  - `pi-session.ts`：`writeAgentsMd` 优先写用户版本（整体替换），无用户版本才回退到「代码默认 + 保留 custom 段」向后兼容；`buildParentPrompt`/`buildParentContentPrompt` 优先返回用户版本。
  - IPC/preload：新增 `agents:get/save/history/restore` 通用接口（child:getAgentsMd/child:saveAgentsMd 改为走 SQLite，并即时落盘 AGENTS.md 生效）。
  - UI：新增 `src/components/AgentPromptEditor.tsx`（通用编辑器：textarea + 保存/恢复默认/历史版本列表回退）；`Dashboard.tsx` 孩子卡片「编辑 AI 提示词」与家长中心头部「家长 AI 提示词」均用它（家长端带 main/content 切换）。
- **验证**：`tsc --noEmit` 相关文件 0 错。`npm run build` 后需手测：编辑孩子/家长提示词保存即生效、恢复默认回退代码提示、历史版本回退。

## [ISSUE-033 方向修订] 2026-08-24 —— 孩子目录里不要 AGENTS 文件，孩子不能改它
- **用户新增诉求（原话）**：「孩子的数据目录里不能有 AGENTS 文件，孩子不可以修改这个文件。」
- **澄清（同日后续）**：「文件要保留，但是不能保留在孩子的目录里，孩子的 agent 不能修改这个 AGENTS 文件。可以保留到家长的目录里。」
  → **最终方向确定**：AGENTS 文件**保留**，但**从孩子目录移到家长目录**存放；孩子 agent **只读**该文件（由 SDK loader 从家长目录读），**不可写**（孩子目录无此文件、无写权限路径）。
- **与已实施的 033 冲突点**：033 处理记录（2026-08-22）拍板「**保留孩子 AGENTS.md 文件**（内容=用户版本），`child:saveAgentsMd` 即时落盘 `data/children/<id>/AGENTS.md` 生效」。本修订要求：**文件改存家长目录 `data/parents/<pid>/agents/<childId>.md`（或类似路径），孩子目录彻底不出现 AGENTS 文件**；孩子端只读、家长端（AgentPromptEditor）可写。
- **现状（已定位，全部落盘点）**：
  - `writeAgentsMd`（`pi-session.ts:96-119`）：写 `data/children/<id>/AGENTS.md`（:98）→ **需改为写家长目录**。
  - `getChildSession`（:413）每次开会话前调 `writeAgentsMd` 刷新孩子目录文件 → **改为刷新家长目录文件 / 不再对孩子目录写**。
  - `getChildSession`（:418-436）用 `DefaultResourceLoader({cwd: childDir})` → SDK 自动从 cwd 读 `AGENTS.md` 注入 `<project_context>`；**要让它读家长目录文件，需把 cwd 指向家长目录，或用 `contextFiles`/`systemPromptOverride` 显式加载家长目录文件**。候选：cwd 仍为 childDir（保证工具 read/write 落在孩子目录），AGENTS 改由 `systemPromptOverride`（`buildChildPrompt`，:423）从家长目录文件/SQLite 读取后内联注入——**最干净**：孩子目录无文件、孩子不可写、规范来自家长侧。
  - `child-auth.ts:132` 改 profile 后 `writeAgentsMd` 刷新 → 同步改写家长目录。
  - `user-init.ts:93` 新建孩子时 `writeAgentsMd` → 同步改为写家长目录（或在家长目录预建空/默认 AGENTS）。
  - IPC `child:saveAgentsMd`（:154-163）、`child:getAgentsMd`（:143-152）、`agents:save`（:174-185，scope=child 分支 :178-180 落盘孩子目录）→ **改为读写家长目录文件 + `data/agents.sqlite`**，不再 `writeFileSync`/`readFileSync` 孩子目录。
  - 存量：`data/children/{珊珊,闻闻}/AGENTS.md` 需删除（规范转移到家长目录）。
- **修订方案要点（已澄清，可执行）**：
  1. **文件存家长目录**：新增 `data/parents/<pid>/agents/<childId>.md`（每孩子一份，内容=用户版本，无用户版本时由代码默认生成）。管理者=家长（AgentPromptEditor 走 `agents:save` 写此文件 + SQLite）。
  2. **孩子只读、不可写**：孩子会话注入 `buildChildPrompt` 改为从「家长目录 AGENTS 文件 或 `data/agents.sqlite` 用户版本」取内容，经 `systemPromptOverride` 内联；孩子目录无 AGENTS 文件、工具白名单不含对该路径的写、UI 无孩子侧编辑入口（现状已满足）。
  3. **回退 033「写孩子目录文件」逻辑**：`writeAgentsMd` 入参加 `targetDir` 或新增 `writeParentAgentsMd(parentId, childId, content)`；`getChildSession`/`child-auth.ts`/`user-init.ts` 调用处改指向家长目录。
  4. **向后兼容**：存量孩子目录 AGENTS.md 删除（规范由家长目录/SQLite 提供，无丢失风险）；`child:getAgentsMd`/`agents:get` scope=child 改为读家长目录文件优先、SQLite 兜底。
- **待确认（仅剩细节，方向已定）**：
  1. 家长目录 AGENTS 文件路径：`data/parents/<pid>/agents/<childId>.md` 还是并入现有 `agents.sqlite`（033 已建，文本存 SQLite 即可，文件可不落盘）？——**建议：SQLite 为权威（033 已有），家长目录可不再落盘文件，仅保留「文件可读」选项供高级用户**。需你拍板是否还要物理文件。→ **曾拍板保留物理文件（2026-08-24 首版实施）**：`data/parents/default/agents/<childId>.md` + SQLite 双写；**2026-08-24 二次拍板（终版）**：**AGENTS 全部放 SQLite（data/agents.sqlite），不落任何物理文件**，查看/编辑均在家长页面 AgentPromptEditor（见下方「终版修订实施记录」）。
  2. 多家长（pid 非 default）时孩子 AGENTS 归属哪个 pid？当前单家长 default，暂定 default。→ **已拍板**：`getChildAgentsPath(childId, parentId=DEFAULT_PARENT_ID)` 已参数化，当前单家长走 default，未来多家长无需改结构。
- **排查 / 修改入口**：
  - `electron/lib/pi-session.ts`：`writeAgentsMd`（:96-119，改写家长目录/去孩子落盘）、`getChildSession`（:413 删孩子目录写、:418-436 cwd 保留 childDir、:423 buildChildPrompt 内联家长侧规范）、`buildChildPrompt`（:259 起，拼家长目录 AGENTS 内容）、`getDefaultPrompt`（:128-135 孩子分支改查家长目录/SQLite）、`child-auth.ts:6,132` 调用。
  - `electron/lib/user-init.ts:6,93` 新建孩子调用。
  - IPC：`electron/lib/ipc-handlers.ts` `child:saveAgentsMd`/`child:getAgentsMd`（:143-163）、`agents:save`/`agents:get`（:166-185，scope=child 分支去孩子落盘）。
  - 清理：`data/children/{珊珊,闻闻}/AGENTS.md` 删除。
  - SQLite：`electron/lib/agent-prompts.ts`（`data/agents.sqlite` 复用，scope=child/ref=childId）。
- **关联**：ISSUE-032（孩子目录精简——去掉 AGENTS.md 与"只建最小集"一致）；ISSUE-038（提示词去重——内联后 AGENTS 与工具 description 重叠治理可一并做）；ISSUE-029（家长库为中心——AGENTS 归家长目录与之同源）。
- **优先级**：✅ 已实施（2026-08-24 修订完成，构建/测试通过；待手测）→ **2026-08-24 终版已实施**（AGENTS 纯 SQLite、删物理文件，见下方「终版修订实施记录」）
- **记录时间**：2026-08-24

### ISSUE-033 修订实施记录（2026-08-24）
- **改动文件**：
  - `electron/lib/parent-library.ts`：新增 `getParentAgentsDir(parentId)` + `getChildAgentsPath(childId, parentId=DEFAULT_PARENT_ID)`（→ `data/parents/<pid>/agents/<childId>.md`）。
  - `electron/lib/pi-session.ts`：`writeAgentsMd` 改写家长目录（含 mkdir，不再碰孩子目录）；新增 `resolveChildAgents(childId, profile)`（优先级：SQLite 用户版本 → 家长目录文件 → 代码默认+custom 段）；`buildChildPrompt(childId, profile, progressContext)` 改为从 resolveChildAgents 取内容**内联注入 system prompt**（孩子目录无 AGENTS.md，SDK 不再附加 `<project_context>`，语义等价）；`getDefaultPrompt` child 分支改读家长目录文件；createChildSession 传 childId 给 buildChildPrompt。
  - `electron/lib/ipc-handlers.ts`：`child:getAgentsMd` / `child:saveAgentsMd` / `agents:save`（scope=child）全部改读写家长目录文件（`getChildAgentsPath` + mkdir），不再 `writeFileSync`/`readFileSync` 孩子目录。
  - `test/app.test.ts`、`test/functional.test.ts`、`test/sync.test.ts`：断言从「孩子目录含 AGENTS.md」改为「孩子目录**不**含 + 家长目录 agents/<childId>.md 存在」；sync 的 ≥3 文件断言调为 ≥2。
  - 新增 `test/agents-parent-dir.test.ts`：锁定 3 不变量（writeAgentsMd 写家长目录不写孩子目录 / resolveChildAgents 无用户版本→代码默认 / 有用户版本→整体替换）。
- **存量迁移**：`data/children/{09406c05…闻闻,1f050a7f…珊珊}/AGENTS.md` 已删除；家长目录 `data/parents/default/agents/` 已生成两份 `<childId>.md`（闻闻=代码默认 2433 字符；珊珊=SQLite 用户版本 886 字符，与磁盘一致）。
- **验证**：`tsc --noEmit` 过滤 TS2318/TS2552 后 0 错；`npm run build` 通过；测试 agents-md(3)/agents-parent-dir(3)/parent-library/app「initializes child directory」/functional「孩子目录包含所有必要文件」/sync(8) 全过。剩余失败均为既有：app.test.ts 云端 ECONNREFUSED 8005、functional `app.isPackaged` 未定义 + shared/skills 残留 recording/study-tracker + ISSUE-032 过时断言（tags/taxonomy.md、daily 目录）。
- **手测清单**：① 家长中心「编辑 AI 提示词」孩子侧：保存即生效（写家长目录 + SQLite）、恢复默认、历史回退；② 孩子会话行为规范仍生效（内联注入后交流准则/学习规则照常）；③ 孩子目录无 AGENTS.md、家长目录 agents/ 有文件。

### ISSUE-033 终版修订实施记录（2026-08-24，二次修订：AGENTS 纯 SQLite，删物理文件）
- **用户诉求（原话）**：「把孩子的 AGENTS 文件放到数据库 sqlite 里。修改后的也存在数据库里。查看和编辑就在家长页面里。」
- **终版拍板**：**AGENTS 全部存 `data/agents.sqlite`（prompts 当前版 + prompt_history 历史版），不落任何物理文件**（孩子目录、家长目录均无 AGENTS 文件）；查看/编辑均在家长页面 AgentPromptEditor（`agents:get/save/history/restore` 走 SQLite）。孩子开会话时 `buildChildPrompt` 内联注入 `resolveChildAgents`（SQLite 用户版本 → 代码默认 buildAgentsMd），孩子只读、不可写（无文件可写）。
- **核心改动**：
  1. `pi-session.ts`：删除 `writeAgentsMd`/`extractCustomSection`/custom 段占位（AGENTS 不再落盘，custom 段载体已无）；`resolveChildAgents` 简化为「SQLite 用户版本 → 代码默认」；`getDefaultPrompt` child 分支纯 `buildAgentsMd(getProfile(ref))`（无文件读取，profile 缺失返回空串防崩）；`createChildSession` 删开会话前 `writeAgentsMd` 刷新调用；删 `getChildAgentsPath` import。
  2. `parent-library.ts`：删除 `getParentAgentsDir`/`getChildAgentsPath`（无引用）。
  3. `ipc-handlers.ts`：`child:getAgentsMd`（用户版本 → 代码默认）、`child:saveAgentsMd`、`agents:save` 全部纯 SQLite，删 `fs.mkdirSync`/`writeFileSync` 落盘与 `getChildAgentsPath` import。
  4. `child-auth.ts` / `user-init.ts`：删 `writeAgentsMd` 调用与 import（AGENTS 与 profile 解耦，无需刷新）。
  5. 存量迁移：`data/parents/default/agents/` 两个 `<childId>.md` 删除（SQLite 已有珊珊用户版本 886 字符、闻闻走代码默认，无数据丢失）；孩子目录无 AGENTS.md 残留；删除过时脚本 `scripts/regenerate-agents.mjs`（写孩子目录 AGENTS.md，与纯 SQLite 矛盾且无引用）。
  6. 测试：`agents-parent-dir.test.ts` → 重写为 `test/agents-sqlite.test.ts`（4 用例：无物理文件/无用户版本→代码默认/有用户版本→整体替换/getDefaultPrompt child 分支）；app.test.ts「initializes child directory」、functional.test.ts「孩子目录包含所有必要文件」断言改为「孩子目录无 AGENTS.md + 家长目录无 agents 目录」；sync.test.ts 不变（断言本就正确）。
- **验证**：tsc（滤 TS2318/TS2552）0 错；`npm run build` 通过；agents-sqlite(4)/agents-md(3)/app 初始化用例/functional 必要文件用例/sync(8) 全过；单独跑 programming-agent(4)/kb-sqlite(23)/parent-library(12) 全过。完整套件 19 个失败均为既有（云端 ECONNREFUSED 8005、shared/skills 残留 recording/study-tracker、ISSUE-032 过时断言、learning-summary 依赖真实 data、qwen 运行时模型未初始化、并发偶发），零新增回归。
- **手测清单**：① 家长页面「编辑 AI 提示词」（孩子侧 + 家长侧）：保存即生效、恢复默认、历史回退；② 孩子会话行为规范照常生效（内联注入）；③ 磁盘确认：孩子目录与家长目录均无 AGENTS 文件，`data/agents.sqlite` 的 prompts 表为唯一真源。

## [ISSUE-034] SQLite 模糊匹配能力 + 需要模糊检索的场景分析（目标：减少 listOnly 操作，省 token）
- **现状 / 问题**：
  - 当前 `kb_query` 只有**精确匹配**（daily 的 date/block/title 等值匹配、tag 用 `LIKE` 逗号包裹）与 `listOnly` 标题清单。**没有对内容（raw / lesson_method / teaching_copy / method）的关键词检索能力**。
  - 导致：AI 想找"上次聊到月球/恐龙/诚实是哪天"或"哪一课讲反义词"，只能 month+listOnly 拉全部标题、或依赖记忆手动扫——正是要减少的 listOnly 操作。
- **SQLite 模糊匹配能力核查（已实测 node:sqlite / v22 内置 SQLite）**：
  1. `LIKE '%x%'` —— **中文子串直接可用**（逐字符匹配，对 CJK 无分词问题），实测 `'今天孩子读了关于月球的绘本' LIKE '%月球%'` → 1 行。缺点：无索引、全表扫描；但单孩子 daily_entries/courses 量级（百~千行）全扫可忽略，瓶颈是 token 不是 DB 速度。
  2. `GLOB` —— 大小写敏感，对中文检索价值低。
  3. **FTS5 全文检索 —— 内置可用**（实测 `CREATE VIRTUAL TABLE ... USING fts5` 不报错）。但两个坑：
     - 默认 `unicode61` 分词器**不对中文分词**：一整串 CJK 被当成一个 token，`MATCH '孔子'` 返回 0（已实测）。
     - `trigram` 分词器支持任意语言子串，但**查询词必须 ≥ 3 个字符**（已实测 '孔子'/'月球'/'学而' 均 2 字 → 0 行）；短中文关键词（2 字词语）匹配不到。
  - 结论：**中文短关键词检索，LIKE 是最稳的基线**；FTS5 trigram 适合 ≥3 字长文本做相关性排序，但不能作为 2 字关键词的唯一机制。
- **哪些场景需要模糊检索（减少 listOnly）**：
  1. **daily 内容关键词反查**：按 `raw` 自由文本找某天/某 block 的某次对话/事件（如"上次聊恐龙"），跨日期跨 block。→ 现只能 listOnly 全量再扫。
  2. **课程关键词定位**：按 `courses.title/lesson_method/teaching_copy` 找"讲反义词的课/讲过去式的课"，跨主题跨课。→ 现只能 progress+listOnly 再扫全部课。
  3. **主题/资料跨库全文检索（家长库，ISSUE-029 后资料上移父库）**：家长找某主题 method 里某段、某资料 html/path。→ 现无检索入口。
  4. **跨 block 自由文本**：同一关键词可能出现在"生活"和"学习"两类记录，需跨 block 检索。
  5. **录音/询问/任务反查**（recording 的 inquiries/tasks）：按内容找某次问答/任务。
  （tags 是受控词表、先查定义再选，不需模糊，维持现状。）
- **方案要点（待定）**：
  - 给 `kb_query` 增加 `keyword`/`search` 参数（daily / progress / 家长库 topics 各加一份），底层 `raw/title/method/teaching_copy LIKE '%kw%'`（中文稳健），**可选**叠加 FTS5 trigram 做相关性排序与片段高亮。
  - 返回**标题 + 命中片段（snippet）**而非整段 raw，命中再多也 token 可控；限制返回行数（如 20）。
  - 关键词为空时行为与现在一致（仍走 listOnly/精确）。
  - 预编译参数化（防注入，沿用现有 `prepare(...).all(...args)`）。
  - 提示词：在 kb_query description 明确"模糊检索用 keyword，不要用 read 文件 / 不要 listOnly 全量"。
- **待确认项**：
  1. 是否只做 LIKE（简单稳健），还是引入 FTS5 trigram（需 ≥3 字、建虚拟表、迁移脚本）？建议先做 LIKE，trigram 作为长文本增强。
  2. 返回片段长度与行数上限？
  3. 是否对 `tags` 也放开自由模糊（放开受控词表）？
  4. 家长库（ISSUE-029）是否同步加 keyword 检索？
  5. 关键词命中后，AI 是否还要再发一次精确/全量查询拿完整字段？还是片段已够？
- **排查 / 修改入口（可直接执行）**：
  - 查询实现：`electron/lib/kb-sqlite.ts`——`queryDaily`（:584-617，conds 拼装处加 keyword 分支）、`queryTopicProgress`（:620-657）、`SCHEMA_TABLES`（:82-130，如需 FTS5 加虚拟表）、`openKbDb`。
  - 工具接口：`electron/lib/custom-tools.ts`——`kbQueryTool`（:169-250，parameters 加 keyword + description 更新 + 各 case 透传）。
  - 家长库：`electron/lib/parent-library.ts`（topics 表，ISSUE-029 后做）。
  - 提示词：`electron/lib/pi-session.ts` AGENTS 里"优先 kb_query 而非 read 文件"段（:53 附近）补一句"模糊检索用 keyword"。
- **关联**：ISSUE-013（kb 工具族省 token，本 issue 是检索能力补全）；ISSUE-023（SQLite 唯一真源）；ISSUE-029（资料上移父库后跨库全文检索需求）；ISSUE-019（家长页进度展示若要结合"内容反查"也受益）。
- **优先级**：待定（建议中：直接减少 AI listOnly 全量扫，省 token 收益明确；LIKE 方案改动小）。
- **记录时间**：2026-08-23

## [ISSUE-035] study-tracker 从技能改为纯代码定时任务（数据库取数判断，不调用 AI）

- **背景 / 需求**：与 ISSUE-024（recording）同思路——学习评估不需要 AI：删除 `data/shared/skills/study-tracker/SKILL.md` 技能，改为 scheduler 定时任务，**判断逻辑由代码直接从 kb.sqlite 取数**（不再经 AI / 不再 /skill:study-tracker）。
- **已实施（2026-08-23）**：
  1. 删除 `data/shared/skills/study-tracker/`（且再次删除被外部恢复的 `recording/`——skills 目录现为空，加载路径兜底无害）；
  2. 新建 `electron/lib/study-tracker.ts`：`runStudyTracker(childDir, today?)` 纯代码——`queryTopicsMeta`（topics.rules_json：daily 每日目标 / type 必学选学）+ `queryTopicProgress`（learned/total/next/updated + 每课 first_learned）；**今日新增 = first_learned == 今天且状态✅ 的课数**；必学主题按 `todayLearned >= daily` 判定达标；生成 markdown 评估报告写入 `learning/tracker-latest.md`（latest 快照）并返回结构化结果；导出 `formatLocalDate`（scheduler 复用，删除本地重复定义）；
  3. `scheduler.ts`：`runTracker` 改为同步调用 `runStudyTracker` + 广播 `pi:study_tracker` 事件（前端无监听无副作用）；不再建 AI session、不再 logRound；
  4. `pi-session.ts` L53 文案（「study-tracker 核对」→「每日达标评估核对」）与 L377 注释更新；regenerate-agents.mjs 重新生成 AGENTS.md。
- **数据匹配关键点（踩过的）**：topics.file 形如 `lunyu/lunyu.md`（带路径）↔ courses.topic 是纯目录名 `lunyu` → 用 `file.split("/")[0]`；rules_json 的 daily 是**字符串**（"3"）需 Number()；`courses.first_learned` 存 YYYY-MM-DD（空串/'-' 表示无）。
- **输出**：tracker-latest.md（学习评估快照）+ 广播事件；前端暂无展示 UI（后续可接）。
- **遗留待确认**：① 前端是否要展示评估结果（接 `pi:study_tracker` 事件或读 tracker-latest.md）；② `recording/` 技能目录 8/21 23:04 被恢复的根因（疑似经技能导入 IPC，ISSUE-025 已隐藏 UI 但 IPC/组件保留）——若不再需要，可考虑移除 skills 相关 IPC。
- **已废弃并整体回退（2026-08-23 晚）**：用户确认 **study-tracker 功能不再需要**——孩子的学习进度界面已能直接看到当天是否完成学习任务，单独做每日达标评估任务属于重复。已移除：`electron/lib/study-tracker.ts`、`test/study-tracker.test.ts`、scheduler 内 studyTracker 配置/调度/runCatchUp 段、`SchedulerSettings.tsx` 的「学习进度追踪」UI 段、已生成的 `tracker-latest.md` 快照；相关测试断言同步更新（app/functional/scheduler-task-state/archive-limit）。`formatLocalDate` 收回 scheduler 本地。commit `463117a`（ISSUE-035 实现）保留在历史中，后续提交为移除操作。
- **优先级**：已废弃（2026-08-23）

## [ISSUE-036] recording 改造为「每日学习记录总结」：多时间点触发 + 会话前自动总结 + AI 工具化

- **背景 / 需求**（用户 2026-08-23 拍板）：
  1. 定时任务改名「每日学习记录总结」；
  2. 触发方式从「时间间隔」改为「具体时间点，可多个」，设置页可配；
  3. 新增「每次新建会话前自动总结之前的会话」开关；
  4. 作为 AI 工具：用户（孩子/家长）希望做汇总时，agent 自动调用；
  5. 每次汇总按天进行：从 jsonl 读某天的会话内容；该天没有会话则跳过。
- **已实施（2026-08-23）**：
  1. 新建 `electron/lib/daily-summary.ts` 核心（三路共用）：`readDailyConversation(childDir, date)`（参数化按天过滤，排除 thinking/toolCall/toolResult）、`findLastConversationDate`（今天之前最后有会话的天）、`findLatestConversationDate`（最近有会话的天，AI 工具缺省用）、`createEphemeralSession(childDir)`（从 scheduler 挪入，noContextFiles/noSkills/kb 三件套）、`summarizeDailyConversation(childDir, date)`（无会话 → skipped 不消耗 token；有会话 → AI 按 RECORDING_PROMPT 提取写 daily）、`summarizeConversationTool`（defineTool，name=summarize_conversation，date 可选）；
  2. `scheduler.ts`：recording 配置改 `{ enabled, times: string[], onNewSession }`（默认 times:["21:00"]，兼容旧 intervalHours 配置自动补默认）；`startScheduler` 按 times 逐时间点触发（当天该点未跑过才跑，lastRun 日期+HH:mm 判断）；`runCatchUp` 补跑今天已过的最晚时间点；
  3. `pi-session.ts`：`shouldAutoNewSession` 命中 newSession 前，若 `recording.onNewSession` 开启则 fire-and-forget 调 `summarizeDailyConversation`（总结今天之前最后有会话的天，失败只记日志）；工具白名单/customTools 挂 `summarize_conversation`；AGENTS.md「记录」段补充工具说明；
  4. `SchedulerSettings.tsx`：改「每日学习记录总结」，启用后显示多时间点列表（time 输入 + 删除 + 添加，默认 21:00）+「每次新建会话前自动总结」开关；
  5. 测试：`test/daily-summary.test.ts`（按天过滤/最近会话日/无会话跳过共 6 用例）；archive-limit 配置结构同步。
- **关键点**：AI 工具与定时/会话前三路共用 `summarizeDailyConversation`，幂等（kb_insert 同主键不重复写）；`pi-session ↔ scheduler` 循环 import（getChildSchedulerConfig / resetChildSession 均在函数内使用，ESM 安全）；`pi-session.ts` 本次改动与 ISSUE-033（agent-prompts）同文件，未提交（等 033 批）。
- **优先级**：已完成（2026-08-24 commit 已提交）
- **补充（2026-08-23 晚，同天多次汇总去重）**：用户选择「每次都跑 + 增量去重」策略——`summarizeDailyConversation` 跑 AI 前先 `queryDaily` 查当天已有条目，经 `formatDailyExistingList` 拼成「已存在清单 + 不重复规则」进 prompt（① 清单中已存在条目禁止重复插入；② 新信息用 kb_update 更新已有条目；③ 只对清单外新条目 kb_insert）；`daily_entries` 主键 (date,block,title) 幂等兜底。三路触发（定时多时间点/会话前/AI 工具）统一走此去重。`formatDailyExistingList` 为纯函数（raw 截断 120 字符省 token），新增 2 单测（daily-summary 共 9 用例全过）。

## [ISSUE-037] 家长「课程管理」页里的 AI 对话没有任何反应（发送后无回复、无报错）

- **类型**：bug（用户未标注；症状=家长课程教学页右侧 AI 聊天发送后无任何 AI 回复，疑似静默失败）
- **现象**：家长进入某学习主题的「课程管理」详情页（`src/components/TopicDetail.tsx`，右栏是与 AI 的沟通），在聊天框输入并发送后，**AI 不回复、输入框一直转圈或无任何变化**，也无任何错误提示。孩子/通用家长助手的聊天正常。
- **代码锚点（已定位完整链路）**：
  - 前端聊天：`src/components/TopicDetail.tsx`
    - `useEffect([topicDir])`（59-63）挂载时调 `window.api.piStartParentContent()`——**fire-and-forget，无 await、无 .catch**，返回 Promise 被丢弃；
    - `useEffect([])`（65-82）注册 `onPiStreaming` / `onPiAgentEnd` 监听，`onPiStreaming` 内 `if (data.childId !== "parent-content") return;`（67 行）按 childId 过滤；
    - `handleSend`（177-192）：`setBusy(true)` 后 `try { await window.api.piPromptParentContent(...) } catch { setBusy(false) }`——**catch 块只 reset busy，完全吞掉错误、不给任何 UI 提示**；
    - `busy` 状态仅在 `onPiAgentEnd`（childId==="parent-content"）时 `setBusy(false)`。
  - 主进程 handler：`electron/lib/ipc-handlers.ts`
    - `pi:start_parent_content`（723-731）：`getParentContentSession()` → `attachSessionEvents(session, "parent-content", getMainWindow)`；catch 仅返回 `{success:false}`，前端未消费；
    - `pi:prompt_parent_content`（733-743）：`getParentContentSession()` → `session.prompt(text)` → `logRound`；catch 返回 `{success:false, error}`。
  - 会话构造：`electron/lib/pi-session.ts:512-539` `getParentContentSession()`：单例（`cachedParentContentSession`），`DefaultResourceLoader({ noSkills:true, extensionFactories:[learningGuardExtension], systemPromptOverride: buildParentContentPrompt })`，`createAgentSession({ model: getDefaultModel(), sessionManager: SessionManager.inMemory(), tools:["read","write","edit","get_date","parent_course_save","parent_course_delete"], customTools:[getDateTool, parentUpsertCourseTool, parentDeleteCourseTool] })`。
  - 事件绑定：`electron/lib/ipc-handlers.ts:1152-1214` `attachSessionEvents`：`session.subscribe` → `message_update` 的 `text_delta` 发 `pi:streaming`、其它 type 发 `tool_*`/`agent_end`/`message_end`/`error`；用 `subscribedSessions.has(session)` 去重。
  - 桥接：`electron/preload.ts:14-33`（`onPiStreaming`/`onPiAgentEnd` 等）、`piPromptParentContent`（64）。
  - 工具名校验：已确认 `parent_course_save`/`parent_course_delete` 同时出现在 `tools` 白名单（`pi-session.ts:533`）与 `customTools` 的 `defineTool({name})`（`custom-tools.ts:473/516`）——**排除 ISSUE-006 同类「customTools 未进白名单被过滤」坑**。
- **✅ 根因（2026-08-24 已定位，非假设）**：三处静默点叠加，与孩子会话（`pi:prompt` + Learn.tsx）的「完整错误范式」对照后确认：
  1. **【核心】SDK `session.prompt()` 出错时不抛异常**——错误（`stopReason="error"` + `errorMessage`）记在最后一条 assistant 消息里（ipc-handlers.ts:659-661 孩子路径注释明示）。`pi:prompt_parent_content` / `pi:prompt_parent` 两个 handler **prompt 后不做 `assistantError` 检查**、不提取最终回复、不发 `pi:reply`/`pi:reply_error`/`pi:reply_end` → 即使 LLM 调用失败（网络/key/额度/模型）也返回 `{success:true}`，或返回 `{success:false}` 时前端不检查。
  2. **前端只 try/catch「invoke 抛异常」、从不检查返回值 `r.success`**（TopicDetail / TopicEditor / SkillEditor 三个组件同款）——主进程把错误包在返回值里而非抛异常，因此**后端任何失败前端都不可见**；且 `setBusy(true)` 后无 `agent_end`/`reply_end` 时 busy 永不复位 → 「一直转圈」。
  3. **前端不监听 `pi:reply` / `pi:reply_error` / `pi:error`**——即使主进程发出错误事件也无人消费。对照：孩子路径 handler 有完整的 `assistantError` 检查 + 回发 `pi:reply`（替换式展示）+ `pi:reply_error`（⚠️ 气泡） + `pi:reply_end`（复位 busy），Learn.tsx 全部监听，故孩子聊天正常。
  4. 次要：`piStartParentContent`/`piStartParent` fire-and-forget，会话构造失败（首次）无任何提示。
- **🔧 已修复（2026-08-24）**：
  1. **主进程 `ipc-handlers.ts`**：`pi:prompt_parent_content` 与 `pi:prompt_parent` 对齐孩子 `pi:prompt` 范式——prompt 后 `findLastAssistant` + `assistantError` 检查，失败：`logRound(ok:false)` + 回发 `pi:reply_error`{childId} + `pi:reply_end`{childId} + 返回 `{success:false, error:friendly}`；成功：提取最后 assistant text 回发 `pi:reply`{childId,text} + `pi:reply_end` + `logRound(ok:true, replyLength)`；catch 统一回发 `pi:reply_error`。childId 分别用 `"parent"` / `"parent-content"`。
  2. **`TopicDetail.tsx`**：① `piStartParentContent` 改为 `.then/.catch` 检查 `success`，失败 `setMsg` 提示；② `useEffect([])` 增补 `onPiReply`（替换流式气泡为最终回复）/`onPiReplyEnd`/`onPiReplyError`（⚠️ 气泡）/`onPiError`（顶部 msg 条）监听，均按 childId=="parent-content" 过滤；③ `handleSend` 检查 `r?.success`，失败 `setBusy(false)` + `setMsg` 错误提示。
  3. **`TopicEditor.tsx`**：同款三处修复（无 msg 条，错误用 ⚠️ 消息气泡），childId=="parent-content"。
  4. **`SkillEditor.tsx`**：同款三处修复（通用家长会话，childId=="parent"）。
- **验证**：`tsc --noEmit`（过滤 TS2318/TS2552 后无业务错误）+ `rm -rf out && npm run build` 三环境通过 + 相关单测 41 用例全过（token-stats / parent-library / daily-summary / agents-sqlite）。修复后行为：LLM 失败 → ⚠️ 气泡 + busy 复位；会话构造失败 → 顶部错误提示 + busy 复位；正常 → streaming + 最终回复替换展示（即使 streaming 事件不来，reply 事件也兜底显示全文）。
- **遗留**：① 用户若仍复现「无反应」，需按 ISSUE-037 原验证手段查主进程控制台 `[pi:event] child=parent-content` 与 `pi:prompt_parent_content` 的 `console.error`（现在失败必打印）；② 家长路径与孩子路径的「提取回复文本」逻辑重复（ipc-handlers.ts 内），将来可抽公共函数。
- **补充（2026-08-24 晚，界面对齐孩子聊天）**：用户要求「课程管理」页家长对话与孩子聊天界面一致——① 气泡里展示思考过程 + 工具调用；② 聊天区独立滚动、整页不被拉长。已实施：
  1. **思考/工具展示**：TopicDetail / TopicEditor / SkillEditor 全部对齐 Learn.tsx 的 working 气泡范式——发送时创建 `workingMsg`（`working:true, thinking:"", tools:[]`）+ `workingIdRef` 追踪；新增 `onPiThinking`（追加 thinking delta）、`onPiToolStart`（push running 工具）、`onPiToolEnd`（更新状态 done/error + resultPreview）监听，经 `patchWorking` 更新同一气泡；`onPiReply` 替换 working 气泡为最终文本（`working:false`）、`onPiReplyError` 替换为 ⚠️。主进程 attachSessionEvents 本就对所有会话发 thinking/tool 事件（queueThinking 节流 120ms），前端只需补监听。
  2. **滚动修复**（根因：`.dashboard-main` 是 `overflow-y:auto` 的 block 容器，TopicDetail 用 `height: calc(100vh - 120px)` 估算高度，估算偏差 / 消息增多会把整页拉长）：`styles.css` `.dashboard-main` 加 `display:flex; flex-direction:column`（子视图可撑满）；`.chat-window` 补 `min-height:0`（flex item 默认 min-height:auto 会被内容撑高）；TopicDetail 外层改 `flex:1; min-height:0; overflow:hidden`；TopicEditor/SkillEditor 外层同样改（SkillEditor 已无引用，同步保持一致）；Settings 根 div 加 `flex column; flex:1; min-height:0`（让「教学内容」tab 撑满）。**教训：flex 滚动布局用 calc(100vh - xxx) 估算高度是脆弱写法，正确姿势是父容器 flex + 子容器 min-height:0 + overflow 归位。**
- **关联**：ISSUE-016（同属「失败须显式提示、禁止静默」的用户体验原则）；ISSUE-026（课程管理页左右分栏 + 专用提示词）；ISSUE-010（logRound 记账）；customTools 白名单坑（ISSUE-006，本次已排除）。
- **优先级**：已完成（2026-08-24）
- **记录时间**：2026-08-24

## [ISSUE-038] 评估：AGENTS / method / 工具描述 中存在大量重复内容，这些重复是否必要？

- **类型**：评估 / 重构建议（用户要求评估重复是否必要；非 bug）
- **现象**：孩子 AGENTS.md（系统提示）、各主题 method.md（运行时经 parent_content 拉取、ISSUE-029 还随主题拷贝进孩子库）、以及各工具的 `description`（随工具 schema 每次请求都带）三处，对**同一批通用规则**反复陈述，存在三重重复。
- **已定位的三重重复（按规则逐条对照，含 file:line）**：

  | # | 通用规则 | AGENTS.md | method.md | 工具 description |
  |---|---|---|---|---|
  | R1 | 用 get_progress / 顶部概览取 next，**严禁 read 进度文件** | `pi-session.ts:57-61`（进度查询） | `learning/lunyu/method.md:7`（「next 由系统自动计算…不要读文件」） | `custom-tools.ts:128-132`（getProgressTool：不要 read 进度文件…浪费上下文） |
  | R2 | 展示 html 用 display_content，**不要自己手工拼 HTML** | `pi-session.ts:50-54`（内容展示） | `learning/lunyu/method.md:17`（「用 display_content…只展示html资料，不需要再自己编」） | `custom-tools.ts:33-37`（displayContentTool：何时调用/以 method 为准） |
  | R3 | method 是孩子引导的**唯一权威**，从 parent_content 取，孩子库不存 method/文案 | `pi-session.ts:40`（学习） | （隐含：method 自身即权威） | `custom-tools.ts:548-555`（parentContentTool：孩子库不存…必须先调用） |
  | R4 | 数据全在 SQLite，**禁止 read/write/edit 碰数据文件**，一律用 kb 工具 | `pi-session.ts:44`（记录） | — | `custom-tools.ts:173,180`（kbQueryTool：优先于 read 数据文件…不要用 read 读它们） |
  | R5 | 标签只能从定义表选，先 kb_query 词表 | `pi-session.ts:44` | — | `custom-tools.ts:178`（kbQueryTool：打标签前先查此表） |

  此外 AGENTS.md 的「学习/记录/内容展示/进度查询」四节（38-61 行）本质是**对 5 个工具的逐条用法散文重述**，与工具 description 高度重叠。
- **评估结论（核心回答：这些重复是否必要？）**：
  1. **method.md 里的通用规则（R1/R2）基本不需要**——这是最该清的重复。method.md 的定位是「某主题的**专属教学方法**」（论语的三步吟诵/翻译/应用、考核方式、反馈），而 R1/R2 是**全局通用约定**，本就属于 AGENTS.md（系统提示，孩子会话始终在上下文里）。保留在 method.md 的代价：① 随主题**拷贝进每个孩子的库**（ISSUE-029），N 主题 × M 孩子被放大 N×M 倍；② 改一条通用规则要同步改每一个 method.md，极易漂移（正是 ISSUE-033 想解决的「改了源码但磁盘陈旧」同类风险）；③ method.md 每次教学交互都被拉进上下文，通用废话浪费 token（与 ISSUE-013/034 的省 token 目标冲突）。**结论：method.md 应只留主题专属方法，通用规则一律回 AGENTS.md 一处。**
  2. **AGENTS.md ↔ 工具 description 的重叠（R1–R5）部分必要、部分冗余**：工具 description **必须自包含**——模型在决定调哪个工具时只读 schema，看不到 AGENTS 散文，所以「这个工具干嘛用、啥时候用」写在 description 里是必要的（R2/R3/R4/R5 在 description 的版本应保留）。但 **AGENTS.md 里对这 5 个工具的逐条散文重述（38-61 行）大多冗余**：系统提示始终在上下文，模型既看 AGENTS 又看 description，重复写两遍只增 token。可把 AGENTS 的「学习/内容展示/进度查询」压成一句话指针（如「知识库查询用 kb_query，详见其工具说明」），细节交给 description。
  3. **唯一可保留的"故意重复"**：把 1–2 条**最关键约束**在 method.md 里再强调一次（就近、增强遵守），但应是精选的少数，而非整段通用规则照抄。
- **建议方案（待拍板后实施）**：
  1. **method.md 去通用化**：保留各主题专属的「教学流程/考核/反馈」，删除 R1/R2 这类全局约定（它们已在 AGENTS.md）；改 `regenerate-agents`/主题生成脚本与存量 method.md 同步清理。
  2. **AGENTS.md 瘦身**：把「学习/记录/内容展示/进度查询」四节压成"工具名 + 一句话用途 + 指向工具 description"的索引式写法，删逐条散文。
  3. **工具 description 作为「如何使用工具」唯一真源**，保持自包含、不依赖 AGENTS 也不依赖 method。
  4. 可选：把 R1–R5 抽成一份「全局约定」常量，AGENTS.md 与（必要的）method.md 都引用同一份，避免将来漂移。
- **风险 / 待确认项**：① 删 method.md 通用句后，是否确有 AGENTS.md 在上下文兜底（孩子会话 system 始终注入 AGENTS.md，确认无"method 覆盖 AGENTS"导致通用规则失效的场景，ISSUE-033 用户整体版本路径需一并核对）；② AGENTS.md 压成索引后，模型是否仍稳定选对工具（建议删后做少量手测）；③ 存量 8 个主题 method.md 要不要一次性清理（可脚本批量）；④ 通用约定抽取为共享常量是否过度设计。
- **关联**：ISSUE-029（method 随主题拷贝进孩子库 → 重复被 N×M 放大，去重收益最大）；ISSUE-033（AGENTS/家长提示词版本化——本 issue 去重后版本更干净）；ISSUE-013 / ISSUE-034（省 token 目标一致）；ISSUE-026（课程管理专用提示词，同属提示词治理）。
- **优先级**：待定（建议中：纯提示词治理、不改功能，但能明显省 token、降漂移；建议与 ISSUE-029/033 一并拍板）。
- **记录时间**：2026-08-24

## [ISSUE-039] 精简模型 provider：去掉国外 provider，保留千问 token-plan，新增 MiniMax

- **类型**：需求 / 配置（仅记录的模型/provider 清单治理）
- **需求**（拆分为 3 项）：
  1. **移除国外 provider**：从可选模型列表里去掉 `anthropic`、`google`（Gemini）、`openrouter`、`groq` 这四个国外 provider（用户明确要求，符合国内环境默认）。
  2. **保留千问 token-plan**：保留通义千问（含 SDK 内置的 `qwen-token-plan*` 百炼 token-plan 套餐——MiniMax/DeepSeek/GLM 等经百炼调用），这是国内服务，不删。
  3. **新增 MiniMax 国内 provider**：作为新的可选国内模型源。
- **现状 / 根因（已定位锚点）**：
  1. **前端 API key 配置清单**（`src/pages/Settings.tsx:7-15` 的 `PROVIDERS` 数组）硬编码了：`deepseek` / `qwen` / `anthropic` / `openai` / `google`(Gemini) / `openrouter` / `groq`。其中 `anthropic`、`google`、`openrouter`、`groq` 即用户要去掉的；`deepseek`、`openai` 用户未点名，**默认保留**（不擅自删 deepseek，因为它是默认兜底模型）。
  2. **可用模型列表来源**：`electron/lib/pi-runtime.ts:210` 的 `getAvailableModels()` 直接 `return runtime.getAvailable()`——这是 SDK `ModelRuntime` 已注册 provider 的并集。当前仅显式 `registerQwenProvider`（:188）；`deepseek` 是 SDK 内置。若 SDK 默认还内置 anthropic/openai/google/openrouter/groq，**仅改 Settings.tsx 的前端下拉还不够**，列表仍会从 `getAvailableModels()` 暴露出来 → 必须在主进程层做**白名单过滤**（见下）。
  3. 千问 token-plan：`pi-runtime.ts:14-15` 注释已说明 `qwen-token-plan*` 是百炼 token-plan 套餐，与 qwen 官方模型不是一回事，需确认这些模型在 `runtime.getAvailable()` 中如何归类（归于 qwen provider 还是独立 provider），避免误删。
- **修改入口 / 方案要点（可直接执行）**：
  - `src/pages/Settings.tsx:7-15`：从 `PROVIDERS` 删除 `anthropic`/`google`/`openrouter`/`groq` 四项；新增 `{ id: "minimax", name: "MiniMax", keyHint: "请填写 MiniMax API Key" }`。
  - `electron/lib/pi-runtime.ts`：新增 `MINIMAX_PROVIDER`（参考 `QWEN_PROVIDER` 写法，MiniMax 走 OpenAI 兼容端点 `https://api.minimax.chat/v1`，`api:"openai-completions"`），并在 `getSharedRuntime()` 里 `registerMinimaxProvider(g[cacheKey])`；同时在 `getAvailableModels()` 增加 provider 白名单（如 `['qwen','deepseek','minimax']`）过滤掉 SDK 默认暴露的国外 provider。
  - 默认模型兜底（:217-218）`DEFAULT_PROVIDER="deepseek"` 保持不变。
- **待确认项**：
  1. **MiniMax 接入细节**：官方端点/模型清单/鉴权方式（Bearer header vs query ApiKey）——需查官方文档确认，不要猜 unsupported 字段。
  2. **是否要在 `getAvailableModels()` 加白名单**：若 SDK 默认注册了 anthropic 等，必须加；若 SDK 仅注册 qwen/deepseek，则前端 `PROVIDERS` 改了即可（建议两处都收敛，避免未来 SDK 升级又暴露）。
  3. **deepseek / openai 是否保留**：用户只点名删 4 个国外 provider，未提 deepseek（且是默认兜底）与 openai，默认保留，需用户确认。
  4. **千问 token-plan 暴露哪些具体模型**给 UI（MiniMax/DeepSeek/GLM 等是否都要列）。
- **关联**：ISSUE-020（编程 agent 模型共用同一 provider 选取链路）、ISSUE-005（默认模型链路同源）；偏向"国内服务优先"的区域约定。
- **优先级**：已完成（2026-08-24 用户确认；auth.json 密钥手动处理项已交代）。
- **记录时间**：2026-08-24

---

### ISSUE-039 实施记录（2026-08-24）

- **状态**：✅ 已实施（代码改动 + 构建通过）。两处 待确认项按下方"采用决策"落地，待用户二次核验。
- **改动文件 / 要点（可直接对照）**：
  1. `src/pages/Settings.tsx`：`PROVIDERS` 数组移除 `anthropic`/`google`/`openrouter`/`groq` 四项，新增 `{ id:"minimax", name:"MiniMax", keyHint:"请填写 MiniMax API Key" }`；保留 `deepseek`/`qwen`/`openai`。
  2. `electron/lib/pi-runtime.ts`：
     - 新增 `MINIMAX_MODELS`（7 个模型：M3 / M2.7(+highspeed) / M2.5(+highspeed) / M2.1(+highspeed)，contextWindow M3=1M、其余 204800；`api:"openai-completions"`、`input:["text"]`、`reasoning` 不开启）。
     - 新增 `MINIMAX_PROVIDER`（`baseUrl:"https://api.minimaxi.com/v1"`，国内端点）+ `registerMinimaxProvider()`，并在 `getSharedRuntime()` 里 `registerMinimaxProvider(g[cacheKey])` 注册。
     - `getAvailableModels()` 增加白名单 `ALLOWED_MODEL_PROVIDERS = ["qwen","deepseek","openai","minimax"]`，过滤掉 SDK 内置的国外 provider（确认 `ModelRuntime.create()` 会 `builtinProviders()` 全部注册，故白名单为必须且是防未来 SDK 升级再暴露的防御层）。
- **采用决策（对应原 待确认项）**：
  1. **MiniMax 接入细节**：端点/鉴权/模型清单均按官方文档核实（OpenAI 兼容、Bearer 鉴权、国内 `api.minimaxi.com/v1`、模型 M3/M2.x）。**未猜测 thinkingFormat**——SDK `thinkingFormat` 枚举无 `"minimax"`，故 MiniMax 按普通 `openai-completions` 接入、`reasoning` 关闭；M3 的 thinking（adaptive）暂不启用，待 SDK 增加 minimax thinkingFormat 再开（超出本 issue）。
  2. **白名单**：已加（见上），两处（前端 PROVIDERS + 主进程 getAvailableModels 白名单）都已收敛。
  3. **deepseek / openai 保留**：按用户原话只点名删 4 个国外 provider，默认保留 `deepseek`（默认兜底）与 `openai`。**⚠️ openai 同为国外 provider，若用户也想一并去掉，从 `ALLOWED_MODEL_PROVIDERS` 移除 `"openai"` 并从 `PROVIDERS` 删 openai 项即可——待用户确认。**
  4. **千问 token-plan 暴露**：`qwen` 在白名单内，含经百炼调用的 `deepseek-v4-*` 等 token-plan 模型一并保留暴露（符合"保留千问 token-plan"需求）。
- **非破坏性说明**：若 `auth.json` 中此前存过 anthropic/groq 等国外 provider 的 key，本次**不删除**这些条目（避免破坏性操作），只是前端不再提供配置入口、且 `getAvailableModels` 白名单不再暴露其模型；它们不会被实际使用。
- **验证**：`tsc --noEmit` 仅余 5 条环境性 TS2318/TS2552 全局类型告警（与改动无关）；`npm run build`（electron-vite）通过（out/main + preload + renderer 均构建成功）。
- **关联**：ISSUE-020 / ISSUE-005（同模型选取链路）；区域约定"国内服务优先"。

### ISSUE-039 二次修订：token-plan / 按量付费 拆分（2026-08-24 下午）

- **状态**：✅ 已实施（代码改动 + 构建通过）。**更正 2026-08-24 上午一处错误表述**：原实施记录 / 对话中称"计费方式代码控制不了、只能看账单"，**错误**——token-plan 与按量付费是**两个不同 base URL**，打到哪个 URL 即决定走哪种计费，故代码必须按 URL 拆分。
  - 按量付费：`https://dashscope.aliyuncs.com/compatible-mode/v1`（聊天 LLM）/ `https://dashscope.aliyuncs.com/api/v1/...`（千问 ASR）
  - token-plan：`https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`（聊天 LLM）/ `https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/...`（千问 ASR）
- **方向 A 落地（聊天 LLM，`electron/lib/pi-runtime.ts`）**：
  1. `QWEN_PROVIDER` 现仅挂 qwen 官方三款（max/plus/flash）+ Qwen3-VL（走 dashscope 按量 URL）。
  2. 新增 `QWEN_TOKENPLAN_PROVIDER`（`baseUrl` = token-plan 兼容端点），仅挂 `QWEN_DEEPSEEK_MODELS`（deepseek-v4-flash / flash-0731 / pro / pro-0813）；`registerQwenTokenplanProvider()` 在 `getSharedRuntime()` 注册。
  3. 白名单 `ALLOWED_MODEL_PROVIDERS` 增 `"qwen-tokenplan"`。
  4. **默认兜底模型**从 `deepseek/deepseek-v4-flash` 改为 `qwen-tokenplan/deepseek-v4-flash`（DeepSeek 已不再归属 SDK 内置 `deepseek` provider，否则默认模型会落到按量/SDK 默认 URL，与套餐意图冲突）。
  5. `getSharedRuntime()` 在 `ModelRuntime.create()` 前，若 `auth.qwen.key` 存在而 `auth["qwen-tokenplan"]` 缺失，则同步一份（同值）——token-plan 与按量共用同一阿里百炼 API Key，用户只需在 Settings 填一次千问 key。
- **语音 (STT) 同样拆分（`electron/lib/voice/`）**：
  1. `providers/qwen.ts`：`transcribe()` 接受 `creds.endpoint`，缺省回退 dashscope 按量 ASR 端点；token-plan 端点常量 = `token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`。
  2. `voice-config.ts`：`VoiceProviderId` 增 `"qwen-tokenplan"`；`DEFAULT_CONFIG.providers["qwen-tokenplan"]` 预填 `{ apiKey:"", endpoint: <token-plan ASR 端点> }`；`isProviderConfigured` 的 qwen case 同时覆盖 `qwen-tokenplan`（回退 `auth.qwen.key`）。
  3. `voice/index.ts`：`PROVIDER_NAMES` 加「千问(token-plan)」；`dispatch` 的 `qwen`/`qwen-tokenplan` 共用 `qwenTranscribe`（endpoint 已在 creds）。
- **Settings 下拉（`src/pages/Settings.tsx`）**：`PROVIDERS` 删掉 `deepseek` 项（DeepSeek 已归入 `qwen-tokenplan`，鉴权复用 qwen key，无需独立 key 入口），现仅 `qwen`（含 token-plan 说明）/ `openai` / `minimax`。模型下拉里 `qwen-tokenplan/deepseek-*` 由白名单自动出现。
- **验证**：`tsc --noEmit` 过滤环境告警后无业务错误；`npm run build`（electron-vite）通过。
- **未做（用户指示"先不管 minimax"，且语音/聊天 token-plan 已覆盖）**：MiniMax 当前仍走 `api.minimaxi.com/v1` 直连（非阿里百炼 token-plan 通道）；若你的 MiniMax 是百炼 token-plan 套餐购买，需把 `MINIMAX_PROVIDER.baseUrl` 改为百炼 token-plan 端点（待你确认）。
- **关联**：ISSUE-020 / ISSUE-005（同模型选取链路）。

### ISSUE-039 三次修订：两个 provider 完全独立（含独立 API Key）（2026-08-24 下午晚）

- **状态**：✅ 已实施（代码改动 + 构建通过）。**更正二次修订第 5 点的错误**：上轮称"token-plan 与按量共用同一 API Key、自动同步一份"——**错误**。用户明确：按量付费与 token-plan 的 **API Key 也不相同**，应按**两个完全独立的 provider** 处理，各自用自己 `auth.json` 的 key 段、各自独立 base URL，绝不互相拷贝。
- **改动（撤销"同步 key"，改为独立）**：
  1. `pi-runtime.ts` 的 `getSharedRuntime()`：**删除**原先"把 `auth.qwen.key` 同步到 `auth["qwen-tokenplan"]`"的块。`qwen-tokenplan` provider 仅读 `auth["qwen-tokenplan"].key`，与 `qwen` 的 key 完全无关。
  2. `voice-config.ts` 的 `isProviderConfigured`：`qwen-tokenplan` case **不再回退 `auth.qwen.key`**，改为读自身 `auth["qwen-tokenplan"]` 段（必须自身有 key 才算配置可用）。
  3. `Settings.tsx` 的 `PROVIDERS`：**补回 `qwen-tokenplan` 独立 key 入口**（之前为"只填一次"误删），现四项：`qwen`（按量付费）/ `qwen-tokenplan`（token-plan 套餐，keyHint 标明"与按量不同的 key"）/ `openai` / `minimax`。两通道各自在 Settings 独立填写、分别写入 `auth.qwen` 与 `auth["qwen-tokenplan"]`。
- **⚠️ 需用户手动处理（个人密钥文件，AI 不擅自动）**：`data/shared/auth.json` 当前 `qwen-tokenplan.key` 是上轮错误同步的、与 `qwen.key` 相同的副本。请打开设置页「通义千问 (token-plan 套餐)」填入你**真正的 token-plan key** 覆盖它（保存即写入正确值）。AI 不改 auth.json 既有密钥值，避免误删真实 key。
- **验证**：`tsc --noEmit` 过滤环境告警后无业务错误；`npm run build`（electron-vite）通过。
- **关联**：ISSUE-020 / ISSUE-005。

### ISSUE-039 四次修订：DeepSeek 直连不要去掉（2026-08-24 14:16）

- **状态**：✅ 已实施 + 构建通过。用户纠正"provider 里不要去掉 deepseek"——此前仅在 `Settings.tsx` 的 `PROVIDERS` key 入口误删 `deepseek` 项，而 SDK 内置 `deepseek` provider 与白名单 `ALLOWED_MODEL_PROVIDERS` 里的 `"deepseek"` 始终保留。现 DeepSeek 两条通道并存互不冲突：① `qwen-tokenplan/deepseek-v4-*`（百炼 token-plan 套餐，token-plan key+URL）；② SDK 内置 `deepseek/*`（官方直连，独立 deepseek key）。
- **改动**：`Settings.tsx` `PROVIDERS` 补回 `{ id:"deepseek", name:"DeepSeek (官方直连)" }` 独立 key 入口（现五项：qwen 按量 / qwen-tokenplan 套餐 / deepseek 直连 / openai / minimax）；`pi-runtime.ts` 把 `getDefaultModel` 兜底注释从"回退到 SDK deepseek"改为明确指向 `qwen-tokenplan/deepseek-v4-flash`，消除误读。
- **验证**：tsc/build 通过。

### ISSUE-039 五次修订：两个千问 provider 都挂 DeepSeek + 按 provider 筛选（2026-08-24 14:22）

- **状态**：✅ 已实施 + 构建通过。用户两点要求：① 点击 provider 只显示该 provider 的模型；② 千问按量与套餐两个 provider 都显示 DeepSeek 全部模型。
- **决策（用户拍板）**：DeepSeek 在 `qwen`（按量）与 `qwen-tokenplan`（套餐）**两个 provider 各注册一份**（`QWEN_DEEPSEEK_MODELS` 同时并入两者 models），分别走各自 baseUrl；按 provider 筛选应用到 Settings 与 ModelSelector 两处。
- **改动**：
  1. `pi-runtime.ts`：`QWEN_PROVIDER.models` 由 `[...QWEN_MODELS, ...QWEN_VL_MODELS]` 改为 `[...QWEN_MODELS, ...QWEN_VL_MODELS, ...QWEN_DEEPSEEK_MODELS]`（按量端点也挂 DeepSeek）；`qwen-tokenplan` 本就含 DeepSeek，实现两通道都可见可选。
  2. `src/components/ModelSelector.tsx`：新增 `activeProvider` 状态 + provider chip 栏（provider>1 时显示）；点击 provider 仅渲染该 provider 模型并切到其首个模型；默认激活 provider = 默认模型所属 provider；引入 `useMemo` 分组/过滤。`onPiDefaultModelChanged` 同步切 activeProvider。
  3. `src/pages/Settings.tsx`：① `selectedProvider` 初值由 `"deepseek"` 改为 `"qwen"`；② 「当前可用模型」列表与「编程 agent 模型」下拉均按 `selectedProvider` 过滤（复用既有 chip 切换），标题显示当前 provider 名；无模型时给空态提示。
- **验证**：`tsc --noEmit` 过滤环境告警后无业务错误；`npm run build`（electron-vite，303 modules）通过。
- **关联**：ISSUE-020 / ISSUE-005。

### ISSUE-039 六次修订：语音配置同样按量/token-plan 拆两个 provider（2026-08-24 14:33）

- **状态**：✅ 已实施 + 构建通过。用户要求语音配置（VoiceSettings）也像聊天那样把按量与 token-plan 拆成两个独立 provider 可选。
- **后端此前已具备**（前几轮）：`voice/providers/qwen.ts` 支持 `creds.endpoint`（缺省回退按量 dashscope 域名）；`voice-config.ts` 类型含 `qwen-tokenplan`、DEFAULT_CONFIG 预填 token-plan ASR 端点（`token-plan.cn-beijing.maas.aliyuncs.com/api/v1/...`）、`isProviderConfigured` 独立读 `auth["qwen-tokenplan"]`；`voice/index.ts` dispatch 的 `qwen`/`qwen-tokenplan` 共用 `qwenTranscribe`。**本次补齐前端 UI 与 key 路由细节**。
- **改动**：
  1. `src/components/VoiceSettings.tsx`：`VOICE_PROVIDERS` 加 `qwen-tokenplan`（千问·token-plan 套餐）独立项，fields = apiKey（标注"套餐专用 Key，与按量不同"）+ endpoint（readonly 文本框，显示固定套餐 ASR 端点、不可改，避免保存时丢失）；`fields` 类型加 `readonly?` 标记，渲染时 readonly 用 disabled 灰底 input。原 `qwen` 项改名为「千问 (按量付费)」。
  2. `electron/lib/voice/voice-config.ts`：`VOICE_PROVIDER_ORDER` 加 `"qwen-tokenplan"`（使套餐通道可作默认/回退候选）。
  3. `electron/lib/voice/providers/qwen.ts`：`loadQwenKeyFromAuth(isTokenPlan)` 增加 token-plan 分支——endpoint 含 `token-plan` 时读 `auth["qwen-tokenplan"].key`，否则读 `auth.qwen.key`；错误提示也区分两通道。
- **关键防丢点**：token-plan 的 endpoint 由 UI readonly 字段随 fields 一起保存（经 `applyVoiceConfigPatch` 的 `{...DEFAULT_CONFIG.providers, ...parsed}` 合并），不会被 `{apiKey}` 覆盖丢端点。
- **验证**：`tsc --noEmit` 过滤环境告警后无业务错误；`npm run build`（electron-vite，303 modules）通过。
- **关联**：ISSUE-020 / ISSUE-005。

## [ISSUE-040] App 版本发布与升级机制（在哪里发布新版本 / 怎么升级）——方案讨论

- **类型**：需求 / 架构（发布链路 + 客户端升级机制）
- **需求**：明确「新版本发布到哪里、用户怎么升级」，形成可执行的发布 + 升级闭环。当前只有「版本检测提醒 + 打开下载页」雏形，无自动下载 / 安装。
- **现状（已核实代码锚点，2026-08-24）**：
  - 打包：`package.json` 已配 electron-builder（win nsis x64 / linux deb+AppImage / mac dmg），`npm run dist:win` 出 `dist/`；**无 `publish` 配置、无 electron-updater 依赖** → 打不出 `latest.yml`，无法自动更新。
  - 版本检测（已有雏形）：`electron/main.ts:17` `APP_VERSION = "0.1.0"`（**硬编码，与 package.json 双源，易漂移**）；`checkForUpdates()`（:26）在启动串行任务第 3 步（sync → catch-up → 版本检查，各 30s 超时）拉 `${getCloudApiBase()}/api/version`，版本不等则弹「前往下载 / 稍后提醒」→ `shell.openExternal(download_url)`（下载 URL 为空时按钮无效）。
  - 云端接口：`cloud-service/app/main.py:51` `GET /api/version` 返回 `version/release_date/release_notes/download_url(目前 None)/min_version`——**全部硬编码 0.1.0**，download_url 注释「生产环境填实际下载地址」。
  - 数据安全（已确认，2026-08-24 实测修正路径）：打包后 `getDataDir()` = `app.getPath("userData")/app-data` = **`%APPDATA%/learning-app/app-data`**（userData 目录名取 package.json 的 `name`=learning-app，**不是** productName「学习伙伴」），**在安装目录之外** → NSIS 覆盖安装 / 升级不丢孩子数据 / auth / kb，升级方案无需数据迁移。
  - Windows 无代码签名（`signAndEditExecutable: false`）→ 新装用户会遇到 SmartScreen 未知发布者拦截。
- **方案讨论 A：发布渠道（在哪里发布）**
  1. **阿里云 OSS（推荐，仓库根已有 `aliyun-aksk.txt` AK/SK）**：安装包 + `latest.yml` 传 OSS（可挂 CDN）；electron-builder `publish: { provider:"generic", url:"https://<bucket>.oss-cn-xxx.aliyuncs.com/learning-app/" }`（或 `provider:"s3"` + aliyun endpoint）。国内直连快、稳定，适合分发大文件。
  2. **自有云服务静态托管（推荐配套）**：现有 FastAPI 服务挂 StaticFiles 出 `/download/` 目录，`/api/version` 的 download_url 指它；与认证 / 同步同域名，不新增基础设施。
  3. **GitHub Releases**：electron-builder 原生支持（`publish: github`），但国内下载慢 / 不稳，只适合做海外镜像。
  4. 腾讯云 COS 等同 OSS 思路（可选）。
- **方案讨论 B：升级机制（怎么升级）**
  1. **现状保底**：检测 + 弹窗 + 打开下载页手动装（体验差、零改动）。
  2. **electron-updater 自动更新（推荐）**：加依赖 + `publish` 配置 → 打包产出 `latest.yml`（NSIS 支持 blockmap 差量下载，省流量）；主进程 `autoUpdater.checkForUpdates()`，下载进度走 IPC 到前端（家长设置页「检查更新」按钮 + 进度条 + 下载完提示重启安装）；可配 `autoDownload` 策略；失败自动降级为打开下载页。
  3. **版本策略**：`/api/version` 扩展 `force`（强制）/ `channel`（stable/beta）；`min_version` 字段已存在——低于 min 强制升级（弹窗不可跳过或禁用核心功能），用于破坏性变更 / 安全修复；常规版本「稍后提醒」并记忆忽略（存设置）。
  4. **检查时机**：启动期已有；建议增加「家长设置页手动检查 + 可配每日自动检查」。
- **待确认项（需用户拍板）**：
  ① 发布源选 OSS / 自有服务器 / 都要（OSS 放包、服务器出 latest.yml 与元数据）？
  ② 升级机制做到哪一档：A. 保持手动下载（最快落地）；B. electron-updater 自动下载+静默安装（推荐）；C. 再加强制升级策略？
  ③ 是否购买 Windows 代码签名证书（解决 SmartScreen；自签名只能内部自用）？
  ④ 版本号策略：是否引入 semver 正式规则（当前 0.1.0；main.ts 与 main.py 双硬编码需先统一为 `app.getVersion()`）。
- **采用决策（2026-08-24 用户拍板）**：① 发布源 = **阿里云 OSS**（generic provider，仓库根已有 AK/SK）；② 升级机制 = **B 档：electron-updater 自动更新**（差量下载 + 静默安装，失败降级下载页；强制升级档 C 暂不做，min_version 字段保留备用）；③ 代码签名 = **暂不签名先发布**（维持 `signAndEditExecutable:false`，接受 SmartScreen 手动放行；OV 证书列为后续项）；④ 版本号 = **统一 semver + `app.getVersion()`**（`APP_VERSION` 硬编码删除，云端 `/api/version` 改读配置/数据库）。
- **实施要点（拍板后执行）**：
  - `electron/main.ts` `APP_VERSION` 改 `app.getVersion()`（消除双源漂移）。
  - `cloud-service/app/main.py` `/api/version` 改读配置 / 数据库（或独立 `versions` 表），不再硬编码。
  - 加 `electron-updater` 依赖；`package.json` `build.publish` 配置（provider generic → OSS）；`npm run dist:win` 产出 `latest.yml` 并上传 OSS。
  - IPC：`app:checkUpdate`（手动触发）、`onUpdateProgress` / `onUpdateStatus`（下载进度 / 就绪事件）。
  - 升级数据安全已确认无虞（userData 在安装目录外），无需数据迁移。
- **实施结果（2026-08-24 已落地）**：
  - 版本号统一：`electron/main.ts` 删硬编码 `APP_VERSION`，全部走 `app.getVersion()`（package.json）。云端 `GET /api/version` 改读 `app_versions` 表（`database.py` 新表，startup 无记录时 seed 0.1.0）；新增 `POST /api/version` 登记接口（`X-Admin-Token` 头 + 环境变量 `ADMIN_TOKEN` 鉴权，未配置返回 503）。
  - 依赖：`electron-updater@6.8.9` 装入 dependencies（`npm install electron-updater --legacy-peer-deps`——项目 edge-tts 声明 peer typescript^5 与 TS7 冲突，需 legacy-peer-deps）。
  - 新模块 `electron/lib/updater.ts`：`initUpdater`（事件→IPC，仅打包后生效，dev 推 disabled）、`silentCheckForUpdates`（启动静默，dialog 立即更新/稍后提醒→下载→重启）、`checkForUpdatesManually`（设置页手动，自动下载）、失败降级拉 `/api/version` 的 download_url 打开下载页。运行时 `autoUpdater.setFeedURL({provider:"generic", url: getUpdateFeedUrl()})` 覆盖内嵌 app-update.yml。
  - `electron/lib/config.ts` 新增 `getUpdateFeedUrl()`（默认 `https://www.aixuexihao.top/download/`，env `UPDATE_FEED_URL` 可覆盖）。
  - IPC：`app:get_version / app:check_update / app:download_update / app:quit_and_install` + 事件 `app:update_status / app:update_progress`（preload 独立 listener，不被 piRemoveListeners 误清）。
  - 前端：`GeneralSettings.tsx` 新增「软件更新」区块（当前版本、检查更新、进度条+速度、重启并安装、错误/最新/开发模式提示）。
  - 发布脚本 `scripts/publish-update.py`：读 aliyun-aksk.txt 的 OSS AK/SK，上传 `latest.yml + *.exe + *.exe.blockmap`（`--dist` 指定产物目录），可选 `--register` 登记版本（需 --admin-token）。oss2 2.19 无 `bucket_exists`/`Permission`（用 `get_bucket_info`+NoSuchBucket、`BUCKET_ACL_PUBLIC_READ`）。
- **⚠️ 重大决策变更（2026-08-24，替代原拍板的 OSS 公共读）**：阿里云 2024 新规**禁止新建 bucket 的公共读**（ACL 与 Policy 均返回 `Put public bucket acl/policy is not allowed`，需控制台申请）。**升级包托管降级为自有服务器**：ECS Nginx 正则加 `|download` 反代 8000，FastAPI `app.mount("/download", StaticFiles(dir=DOWNLOAD_DIR))`，文件放 `/opt/learning-cloud/download/`（latest.yml + 安装包 + blockmap），公网 `https://www.aixuexihao.top/download/`。OSS 仅作本地→服务器的中转通道（私有桶 + 签名 URL + 云助手 curl）。**已发布 0.1.1 到生产**（`/download/latest.yml` 200、云端登记 0.1.1、download_url 指向 /download/ 安装包）。若日后要恢复 OSS 分发：控制台申请公共读后把 `getUpdateFeedUrl()` 与 `build.publish.url` 改回 OSS URL 即可。
- **遗留待办**：
  - **GUI 升级动作未实测**（沙箱无桌面会话，客户端起不来）：本机装 0.1.1 后点「设置→通用设置→检查更新」应显示「已是最新版本」；发 0.1.2 后再验「检测→下载→重启安装」全链路。
  - `dist/` 与 `dist2/` 的 `win-unpacked/resources/app.asar` 被 Windows Defender 锁定（EBUSY 无法删除），打包用新目录 `dist3`；锁释放后可清掉旧目录。
  - Windows 打包需 `NODE_OPTIONS=`（清掉 WorkBuddy shim）在沙箱外跑，否则 fs.rm 被 safe-delete 拦。
- **优先级**：已拍板（2026-08-24；已实施，遗留 GUI 实测）
- **记录时间**：2026-08-24

## [ISSUE-041] 用户使用数据备份（排除敏感数据：模型 API key、登录/权限数据）

- **类型**：需求 / 工具（本地备份与可选恢复；与云端同步 sync-manager 互补）
- **需求（用户原话）**：怎么备份数据，备份用户的数据，**不是**登录权限数据，而是**使用数据**（例如孩子的学习生活记录、家长的课程管理等等）。**不要备份敏感数据**，例如模型 apikey 等等。
- **已核实的数据清单（2026-08-25 实地核查 `data/` 全部落盘）**：

  ### ✅ 应备份（用户使用数据 / 内容）
  1. **孩子知识库（核心「学习生活记录」）**：`data/children/<id>/kb.sqlite`（daily 记录、主题进度、标签定义——ISSUE-023/013 后已是唯一真源）。
  2. **孩子主题教学资料与媒体**：`data/children/<id>/learning/`（method.md、课程文案、`<topic>/media/*.mp3` 等音频）；`data/children/<id>/life/`（生活记录，若有）。
  3. **孩子上传与产出**：`data/children/<id>/uploads/`、`data/children/<id>/outputs/`（html 游戏/练习等）。
  4. **孩子身份元数据**：`data/children/<id>/profile.json`（name/age/grade/interests/aiName 等）——**但需剔除 `passwordHash` 字段**（见排除项）。
  5. **家长课程管理（核心「课程管理」）**：`data/parents/<pid>/parent.sqlite`（topics/courses/teaching_copy/method 全文——ISSUE-029 后已是唯一真源）。
  6. **家长教学资料文件**：`data/parents/<pid>/materials/`（html 资料 + `media/` 音频视频）。
  7. **家长操作日志**：`data/parents/<pid>/activity-log.md`。
  8. **AI 提示词用户版本**：`data/agents.sqlite`（`prompts` 当前版 + `prompt_history` 历史版——ISSUE-033 产物，含孩子/家长 AGENTS 自定义）。
  9. **调度配置**：`data/scheduler-config.json`（各孩子 recording 开关/间隔等——ISSUE-035/036）。
  10. **token 使用统计**：`data/token-log.jsonl`（用量数据，不含 key；用户可观察消耗）。
  11. **用户自编教学技能**：`data/shared/skills/`（SKILL.md + materials/references——家长创作的教学流程内容）。
  12. **模型偏好（非 key）**：`data/app-settings.json`（`materialsLimit`/`defaultModel`/`programmingModel` 为 "provider/modelId" 字符串，不含明文 key）——可选纳入。

  ### 🚫 应排除（敏感 / 登录权限 / 内部状态）
  1. **模型 API key（最关键的敏感数据）**：`data/shared/auth.json`（`pi-runtime.ts:375-390` `setProviderApiKey` 写入，实测含 `deepseek`/`qwen`/`qwen-tokenplan` 的 `{type:"api_key",key:"..."}` 明文）。**绝对不能进备份**。
  2. **登录 / 订阅 / 云端 token（权限数据）**：`data/license.json`（`plan`/`max_children`/`token`/`cached_at`——auth-manager 缓存）、`data/.pi/`（license 缓存与云 token）。用户明确「不备份登录权限数据」。
  3. **孩子密码哈希**：`data/children/<id>/profile.json` 的 `passwordHash`（bcrypt，child-auth.ts:12/40）——即便 profile.json 整体备份，也应剥离此字段。
  4. **agent 会话 jsonl（内部状态，非使用记录）**：`data/children/<id>/.pi/agent/sessions/*.jsonl`、`data/.pi/`——这些是会话历史（可能含 prompts 但不含 key；体积大且非「学习生活记录」本身，kb.sqlite 已承载记录）。**默认排除**，如用户想要可加选项。
  5. **调度内部状态**：`data/task-state.json`（scheduler 运行时状态，非用户数据）。
  6. **临时/缓存备份**：`*.bak-*`、`*.bak-dedup`（如 `app-settings.json.bak-20260824`、`parent.sqlite.bak-dedup`）——备份时跳过。

- **与现有 sync-manager 的关系（已核实，2026-08-25）**：
  - `electron/lib/sync-manager.ts` 已有云同步（`scanDirectory` :41 遍历、`fullSnapshot` :316 全量上传、`syncAllChildren` :290 逐个孩子），但**只同步 `data/children/<id>/` 单个孩子目录、上传到云端**，且 `scanDirectory` 默认 `excludeDirs:[".pi"]`（已避开会话）。它**不是本地备份**：① 不含家长库 `parent.sqlite`/`materials`、不含 `agents.sqlite`、不含 `scheduler-config.json`；② 不区分敏感/非敏感（只是恰好 auth.json 不在孩子目录内、没被传）；③ 是「同步」不是「可携带的备份包」。
  - **建议**：备份功能**复用 `scanDirectory`/`hashFile`/`mapLimit`/`crypto`**（sync-manager.ts:41/89/100），但根目录改为 `data/` 全量 + **显式 denylist**（auth.json/license.json/.pi/task-state.json/profile.passwordHash/临时 baks），产出**本地 zip 到用户指定路径**，与云同步不冲突（云同步继续走孩子目录，备份走本地包）。

- **建议方案要点（候选，待拍板）**：
  1. 新增 `electron/lib/backup.ts`：
     - `BACKUP_DENYLIST`（相对路径/目录名）：`shared/auth.json`、`license.json`、`.pi/`、`task-state.json`、各 `profile.json` 的 `passwordHash` 字段、所有 `*.bak-*`/`*.bak-dedup`。
     - `createBackup(destPath)`：遍历 `data/`，按 denylist 过滤，复制或打 zip（`archiver` 或 Node `zlib`+流式），写入 `backup-<YYYYMMDD-HHmmss>.zip`；含 `manifest.json`（来源版本、时间、含文件清单、已排除项）。
     - `restoreBackup(zipPath, {keepAuth:true})`：解压回 `data/`，**默认不覆盖** `shared/auth.json`/`license.json`（保护本机 key 与订阅）——即「恢复使用数据、保留本机敏感配置」。
  2. 前端：家长设置页新增「数据备份 / 恢复」入口（选目标目录、一键备份、选 zip 恢复）。
  3. 可选：备份时一并剥离 profile.json 的 passwordHash（写备份包时 delete 该字段，源文件不动）。
- **方案拍板（2026-08-25 讨论结论，用户逐项确认）**：
  - **范围 = 三位一体**：在原有「本地备份 zip」定位上扩展为 **① 备份防损 + ② 换机全量迁移 + ③ 家长异地发课/查进度**，不再只是本地 zip。
  - **备份触发模型**：备份 = **时间点快照**，**客户端手动按钮 + 定时任务（scheduler）发起，非实时连续同步**；与「持续双向同步」明确区分（q-1 用户原话：备份在客户端有发起按钮和定时任务设置，不需要实时备份）。
  - **防损深度 = 云端版本历史**：云端每文件保留最近 N 版 + 定期不可变快照，损坏/误删可回滚到时间点，避免 last-write-wins 把本地坏版本反向污染云端真源（覆盖原单镜像方案）。
  - **异地模式 = 异步（现在可做）**：家长上传进孩子云空间 → 孩子下次同步自动拉到；查进度走新增**只读云接口**解析云端 kb.sqlite / learning 摘要，孩子电脑不开也能查。不做实时（实时需等 ARCHITECTURE-SPLIT 引擎服务端，不在本 issue）。
  - **技术路线 = 复用现有体系**：沿用 `sync-manager.ts` + Python 云端 `storage/{parent_id}/{child_id}/` 与 `sync_files_meta` 表，增量实现；**不等待** ARCHITECTURE-SPLIT 引擎服务端重写。
  - **最终拍板（2026-08-25 三拍，用户原话「本地用zip，jsonl不纳入备份，A B C都实施完」）**：① 本地备份形式 = **zip 文件**；② `data/children/<id>/.pi/agent/sessions/*.jsonl` 会话历史**不纳入**备份/同步（kb.sqlite 已承载记录）；③ **层 A（备份防损）+ 层 B（换机迁移）+ 层 C（家长异地事件信箱）全部实施**，顺序 A→B→C。
  - **异地场景细化（2026-08-25 用户二轮澄清，已并入层 C）**：
    - **云端 = 存储 + 事件信箱（inbox）**：家长库数据（`parent.sqlite` + `materials/` + `activity-log.md`）整体跨设备同步（**家长目录纳入层 B 全量清单**）；每个孩子云端空间 + 事件队列 `sync_events`（`assign_topic` / `send_materials` / `request_progress` / `push_data` 等）。
    - **流程（全异步·轮询·低频）**：① 课程资料：家长手动/定时上传家长库到云端 → 其他 app 拉取到本地家长目录 → 主题分配后孩子可读（复用 ISSUE-029 主题分配）；② 主题分配：家长分配主题 → 写 `assign_topic` 事件 → 孩子 app 定时轮询拉到 → 应用进 child `learning/`；③ 进度查询：家长请求 → 云端发 `request_progress` 事件 → 孩子轮询到 → 推送最新 kb.sqlite/learning 摘要到云端 → 家长读云端（孩子也可定时自动推送，家长直接读云端最新，请求事件仅用于即时刷新）。
    - **关键简化（用户拍板）**：① **同一孩子单终端学习** → 孩子数据无并发写，last-write-wins 安全，无需复杂冲突合并；② 备份/同步/查询/分发**均低频、非实时** → 全部定时或手动触发，云端**无需实时推送**（轮询即可，省掉 SSE/长连接）。

- **分层落地计划（建议顺序，每层可独立交付/回退）**：
  - **层 A — 备份防损（基础，风险最低）**：
    1. 客户端扩展 `scanDirectory` denylist 到 ISSUE-041 全清单（家长库 `parent.sqlite`/`materials/`/`activity-log.md`、`agents.sqlite`、`scheduler-config.json`、`app-settings.json`、各 `profile.json` 剥离 `passwordHash`；仍排除 `shared/auth.json`/`license.json`/`.pi`/`task-state.json`/`*.bak*`）。
    2. 本地加密 zip + `manifest.json`（沿用原 `createBackup`/`restoreBackup`，`keepAuth:true` 保护本机 key/订阅）；前端家长设置页「数据备份/恢复」入口 + 发起按钮。
    3. 定时任务接入现有 `scheduler` 框架（按钮 + cron 双触发）。
    4. 云端版本历史：`cloud-service/app/sync.py` 上传时保留 prev 版本（N 版）+ 不可变快照；新增 `/api/sync/restore/{child_id}` 回滚端点。
  - **层 B — 换机全量迁移**：
    1. 同步范围从「仅孩子目录」扩到全清单（复用 `sync-manager`，根目录改 `data/` 全量 + denylist，或新增独立全量同步任务）。
    2. 新机登录同账号 → 一键拉回全清单（download）；`profile.passwordHash` 不跨机同步，新机用本机/重置解锁。
  - **层 C — 家长异地（场景 3，2026-08-25 二轮细化）**：
    - **云端 = 存储 + 事件信箱**：家长库数据（`parent.sqlite` + `materials/` + `activity-log.md`）整体跨设备同步（家长目录纳入层 B 全量清单）；每孩子云端空间 + 事件队列 `sync_events`（`assign_topic`/`send_materials`/`request_progress`/`push_data`）。
    - **流程（全异步·轮询·低频）**：① 课程资料：家长手动/定时上传家长库到云端 → 其他 app 拉取到本地家长目录 → 主题分配后孩子可读；② 主题分配：家长分配 → 写 `assign_topic` 事件 → 孩子 app 定时轮询拉到 → 应用进 child `learning/`；③ 进度查询：家长请求 → 云端发 `request_progress` 事件 → 孩子轮询到 → 推送最新 kb.sqlite/learning 摘要到云端 → 家长读云端（孩子也可定时自动推送，家长直接读最新）。
    - **新落点**：`cloud-service/app/sync.py` 增事件表 + `POST/GET /api/sync/events/{child_id}`（+ack）；`electron/lib/sync-manager.ts` 增轮询事件循环（并入 `scheduler`）；家长端 UI 上传/分配/查询入口（复用 ISSUE-029 主题分配）。
  - **复用入口**：`electron/lib/sync-manager.ts`(`scanDirectory`/`hashFile`/`mapLimit`)、`electron/lib/backup.ts`(新增)、`cloud-service/app/sync.py`(版本历史+progress+restore)、`electron/lib/scheduler.ts`(备份定时)、家长 UI(`CourseManager`/`TopicDetail`/设置页 发课+查进度入口)。

- **✅ 已实施（2026-08-25，A/B/C 全部落地，本地已构建+单测验证）**：
  - **客户端**：
    1. `electron/lib/backup.ts`（新增）：零依赖 zip（手写 ZIP 格式 + Node zlib，UTF-8 文件名，兼容 7-Zip/Python zipfile）；`createBackup`（denylist 过滤 + profile 剥离 passwordHash + manifest.json + 流式写盘）、`restoreBackup`（keepAuth 默认保护本机 auth/license + 路径穿越防护）、`zipUnpack`/`zipPack` 导出。
    2. `electron/lib/scheduler.ts`：新增 `SchedulerBackupConfig`（enabled/hour/minute/destDir，设备级）+ 定时备份任务（每分钟 tick 判断 + runCatchUp 补跑）+ 孩子事件轮询（`event-poll` task-state，默认 30 分钟一次）。
    3. `electron/lib/sync-manager.ts`：新增 `scanParentSpaceFiles`/`syncParentLibrary`/`syncAllData`（云端孩子清单 ∪ 本地 → 逐孩子同步 + 家长空间）；孩子 profile.json **上传剥离 passwordHash、下载合并保留本机 hash**（`sanitizeUploadContent`/`mergeDownloadContent`）。
    4. `electron/lib/sync-events.ts`（新增）：`writeEvent`/`pollEvents`/`ackEvents`/`queryCloudProgress`/`handleChildEvents`（assign_topic|send_materials → 同步孩子+家长库；request_progress → 推送孩子数据；统一 ack）/`pushParentLibraryWithEvent`/`requestAndQueryProgress`。
    5. `electron/lib/ipc-handlers.ts`：`backup:create`/`backup:restore`/`backup:config:get|set`、`dialog:pick_dir`、`sync:event_send`、`sync:query_progress`；`sync:pull` 改走 `syncAllData`；**`parent:allocate` 分配后自动写 assign_topic 事件**。
    6. `electron/preload.ts`：`createBackup`/`restoreBackup`/`backupConfigGet|Set`/`pickDirectory`/`syncEventSend`/`syncQueryProgress`。
    7. `electron/main.ts`：启动同步 `syncAllChildren` → `syncAllData`。
    8. 前端：`src/components/BackupSettings.tsx`（新增，设置页「数据备份」tab）：一键备份/从备份恢复/定时备份配置 + 云端同步区（推送资料到云端、云端查进度表格+最近 daily）；`src/pages/Settings.tsx` 加 tab。
  - **云端（cloud-service，仅改代码，**部署到 ECS 需另行执行**）**：
    1. `app/database.py`：新增 `sync_events` 表 + 索引。
    2. `app/sync.py`：上传覆盖前快照旧版本（`.versions/<b64path>/<ts>.bin`，保留 5 份）+ `GET /versions/{child_id}` + `POST /restore/{child_id}`；家长空间（`storage/{parent_id}/_parent/`，meta 用 child_id="_parent"）`GET /parent/status` + `POST /parent/upload|download`；`GET /children`（云端孩子清单）；事件 `POST/GET /events/{child_id}` + `POST /events/{child_id}/ack`；`GET /progress/{child_id}`（sqlite3 读云端 kb.sqlite 返回主题完成数 + 最近 daily）；download/upload-batch 补 `_safe_storage_path` 穿越防护。
  - **单测（新增 13 用例全过）**：`test/backup.test.ts`（4：denylist/zip 往返+脱敏/keepAuth）、`test/sync-parent-space.test.ts`（3：去敏合并/家长空间清单）、`test/sync-events.test.ts`（3：事件写→轮询→处理触发同步+ack→进度查询，mock cloudFetch 端到端）；`test/scheduler-task-state.test.ts` 更新为四键结构（3 过）。tsc 过滤环境噪声 0 业务错误；`npm run build` 通过；zip 经 Python zipfile 交叉验证（中文路径 + CRC 全过）。
  - **待办/边界**：① 云端需部署后 `init_db` 建表生效（sync_events）；② 新机首次登录 → 启动 syncAllData 自动拉回孩子+家长库，孩子解锁需在家长端重置密码（passwordHash 不上云）；③ 事件轮询间隔默认 30 分钟（无 UI 配置，后续可加）；④ 备份 zip 未加密（denylist 已排除敏感数据，加密可选后续加）。
- **排查 / 修改入口（可直接执行）**：
  - 敏感数据落点：`electron/lib/pi-runtime.ts:375-390`（`setProviderApiKey`→`getAuthPath()`→`data/shared/auth.json`）；`electron/lib/config.ts:34` `getAuthPath`；`electron/lib/auth-manager.ts`（license 缓存）；`electron/lib/child-auth.ts:12,40` `passwordHash`。
  - 复用：`electron/lib/sync-manager.ts:41` `scanDirectory`、`:89` `hashFile`、`:100` `mapLimit`。
  - 数据真源：`electron/lib/kb-sqlite.ts`（孩子 kb）、`electron/lib/parent-library.ts`（家长 parent.sqlite）、`electron/lib/agent-prompts.ts`（`data/agents.sqlite`）。
  - 数据根：`electron/lib/config.ts` `getDataDir()`。
- **关联**：ISSUE-040（版本/升级——同一「数据安全与可携带」主题，备份增强升级鲁棒性）；ISSUE-029/033（备份包需覆盖家长库与 agents.sqlite）；ISSUE-023/013（kb.sqlite 是唯一记录真源，备份即备份它）。
- **优先级**：待定（建议中：用户数据可携带/防丢的刚需；改动独立、可复用 sync-manager 工具函数，风险低）。
- **记录时间**：2026-08-25

## [ISSUE-042] 课程级「每课方法」(lesson_method) 与主题级「教学方法」(topics.method) 的区别与是否冗余

- **类型**：设计澄清 / 潜在精简（需用户拍板是否去掉课程里的 lesson_method 字段）
- **用户原话**：在家长页面的每个主题的单个课程为什么还有每课方法？这个方法和主题的教学方法在使用上有什么区别吗？如果没有这个区别，是否应该去掉课程里的每课方法？
- **已核实的两字段现状（2026-08-25）**：

  | 维度 | 主题教学方法 `topics.method` | 每课方法 `courses.lesson_method` |
  |---|---|---|
  | 存储 | `topics` 表 `method` 列（`kb-sqlite.ts:116`；入库见 `:495-512`，从 `learning/<topic>/method.md` 读全文） | `courses` 表 `lesson_method` 列（`kb-sqlite.ts:106`；v4→v5 迁移加列 `:177`） |
  | 编辑入口 | TopicDetail「教学方法」tab（`TopicDetail.tsx:431-457`，`parentUpsertTopic` 写库 `:233`） | 课程详情「每课方法」框（`TopicDetail.tsx:470-472`，随 `parentUpsertCourse` 写库） |
  | 送达 AI | 经 `parent_content` 工具 / AGENTS 注入（家长制作教学内容时取主题 method）；孩子侧经 method.md 或 kb_query 取 | 经 `get_progress` 返回（`kb-sqlite.ts:672` `lessonMethod` 字段已映射到返回对象）给**孩子 agent 学这课时** |
  | 语义定位 | 整主题通用教学法（如论语「三步吟诵→翻译→应用」） | 该课专属引导（理论上覆盖/补充通用法） |

- **分析（是否功能不同）**：
  1. **设计意图上确实不同**：`topics.method` = 整门课的通用方法（对所有课生效）；`lesson_method` = 单课特例（某课特殊步骤/重点，优先级应高于通用法）。二者在代码里**都是真字段、都送达 AI**，且孩子 agent 取 lesson_method 的路径（get_progress）与取 topics.method 的路径（method.md/kb_query）是分开的——所以**机制上不冗余，是有意做的「通用 + 特例」两层**。
  2. **但用户观察到的问题真实存在**：method.md（通用法）里往往已经写了「每课都按 X 走」，而 lesson_method 默认空（`:471`（未填）），家长很少填——结果**绝大多数课 lesson_method 为空、实际只靠通用法**。即「两层」在实践里塌缩成「一层」，lesson_method 形同冗余字段。
  3. **与 ISSUE-038 呼应**：method.md 通用法 + lesson_method 特例法，本质是「同一套教学规则在两处表达」，与 AGENTS/工具描述三重重复同属「提示词/方法冗余」问题。
- **建议方案（候选，待拍板）**：
  - **方案 A（保留但明确分工）**：保留 lesson_method，但在 UI/提示词里明确「lesson_method 仅在某课与通用法不同时才填」，并把 get_progress 返回的 lesson_method 设计为「有则覆盖通用法、无则忽略」——消除歧义。改动小。
  - **方案 B（去掉 lesson_method）**：从 courses 表删 `lesson_method` 列 + 课程详情去掉该框 + get_progress 不再返回；所有课统一用 topics.method。若某课确有特例，由家长在 topics.method 里用「第 X 课例外：…」表述，或未来引入「课内步骤」结构化字段。**最省 token、最去重**，但失去「逐课独立方法」的表达力。
  - 倾向：先确认用户要不要「逐课独立方法」这个能力——不要就走 B（与 ISSUE-038 去重方向一致）。
- **待确认项**：① 是否保留逐课独立方法能力？② 若要保留，get_progress 返回 lesson_method 的「覆盖语义」是否要明确写进提示词？③ 去掉时 courses 表迁移（DROP COLUMN 或留空列废弃）怎么处理？
- **排查 / 修改入口**：`electron/lib/kb-sqlite.ts:106`（列定义）、`:177`（迁移加列）、`:672`（get_progress 返回）、`:843-846`（kb 字段映射 `课时方法/每课教学方法→lesson_method`）；`electron/lib/parent-library.ts:268-274,329-343,491-516`（parentUpsertCourse 写 lesson_method）；前端 `src/components/TopicDetail.tsx:19,202,470-472,276`（lesson_method 展示/编辑/上下文）。
- **关联**：ISSUE-038（提示词/方法去重——lesson_method 与 topics.method 是方法冗余的子集）；ISSUE-029（课程/方法已入库，删列成本低）。
- **优先级**：待定（建议中：纯设计澄清 + 潜在 schema 精简，不影响功能；与 ISSUE-038 一并拍板最省事）。
- **记录时间**：2026-08-25
- **✅ 用户拍板（2026-08-25）**：走**方案 B（去显示，不保留逐课独立方法）**——课程详情**不再展示「每课方法」**，教学方法统一以**主题级 `topics.method`** 为准（即「教学方法按照主题的方法进行」）。
  - **已实施（2026-08-25）**：`src/components/TopicDetail.tsx` 课程详情（`tab==="course"` 区，原 :470-472）删除「每课方法」`<Section>` 块；教学方法只通过主题「教学方法」tab（`topics.method`）呈现。
  - **范围说明（窄改动）**：本次仅去 UI 展示，**未**删 `courses.lesson_method` 数据库列、未改 `get_progress` 的 `lessonMethod` 返回（`kb-sqlite.ts:672` 仍映射）。理由：用户原话是「在课程详情里不要显示每课方法」，属展示层决定；DB 列保留以便后续若需彻底清 schema 再单独走迁移。孩子侧取教学法的语义维持「主题 method 为主」即可，lesson_method 字段虽仍返回但前端不再展示、家长不再填写。
  - **关联代码点（如需后续彻底去列）**：`kb-sqlite.ts:106`（列定义）、`:177`（v4→v5 迁移加列）、`:672`（get_progress 返回）、`:843-846`（kb 字段映射）；`parent-library.ts:268-274,329-343,491-516`（parentUpsertCourse 写 lesson_method）；`TopicDetail.tsx` 已无展示引用。

## [ISSUE-043] 课程详情页把「标签」放到最上面（每课的 tags 置顶展示）

- **类型**：UI 调整（家长课程管理，课程详情区布局重排）
- **用户原话**：把每一课的标签放到课程详情的最上面。
- **现状（已定位，2026-08-25）**：课程详情渲染在 `src/components/TopicDetail.tsx:460-498`，Section 顺序为：① 每课方法（:470-472）→ ② 教学文案（:473-481）→ ③ 教学资料说明（:482-488，仅 material 非空时）→ ④ 发给学生（:489-491）→ ⑤ 标签（:492-494）。**标签当前在最后**。
- **需求**：把「标签」Section 移到课程详情最顶部（即：① 标签 → ② 每课方法 → ③ 教学文案 → ④ 教学资料说明 → ⑤ 发给学生）。
- **修改入口（待实施）**：`src/components/TopicDetail.tsx:460-498` 的课程详情 `<div>` 内，将 `:492-494` 的「标签」`<Section>` 块整体移到 `selected.title` 标题下方（:467 之后、:470 每课方法之前）。注意「上传资料」按钮（:468）在标题行，不需动。
- **说明**：基本信息 tab（:504-514）的「学习方法/每日目标/主题类型」等不在此次范围，仅课程详情（course tab）的每课 tags 置顶。
- **优先级**：待定（建议低：纯展示顺序，改动 1 处、风险极低，可顺手做）。
- **记录时间**：2026-08-25
- **✅ 已实施（2026-08-25，与 ISSUE-042 同批）**：`src/components/TopicDetail.tsx` 课程详情区，将「标签」`<Section>`（原 :492-494）整体移至课程标题行（:467）之后、**「教学文案」之前**；同时因 ISSUE-042 删除了「每课方法」块，最终顺序为：① 标签 → ② 教学文案 → ③ 教学资料说明（material 非空时）→ ④ 发给学生的学习材料 → ⑤ 删除/上传按钮。底部原「标签」块已删除，无重复。

## [ISSUE-044] 课程资料「上传资料」 vs 聊天框「上传文件」：落点、用途、异同

- **类型**：澄清 / 行为说明（用户问"点了上传资料会放哪里、与聊天框上传有何异同"）
- **用户原话**：课程资料里的上传资料，点击了上传，会把资料放到哪里？和聊天框的上传资料有什么异同？
- **已核实的两个上传通道（2026-08-25）**：

  ### A. 课程资料上传（家长课程管理）
  - 触发：TopicDetail「📤 上传资料」按钮（:468 / :497）→ `uploadMaterials()`（:249-269）→ `window.api.parentUploadMaterial(topicDir)`。
  - 后端：`ipc-handlers.ts:336` `parent:uploadMaterial` → 弹系统文件选择框 → `copyMaterialIntoParent(undefined, topicDir, p)`（`parent-library.ts:602-611`）。
  - **落点**：`data/parents/<pid>/materials/<topicDir>/` —— 媒体文件（mp3/mp4/…）进 `materials/<topicDir>/media/`，其余（html/md/pdf/图片）直接进主题目录（`parent-library.ts:593-610`）。
  - 自动关联：上传的 html 若文件名 = 某课程标题，自动 `parentUpsertCourse` 把 `htmlPath` 写入该课（:259-265），即进 `courses.html_path` 列（父库 `parent.sqlite`，共享给所有被分配的孩子）。
  - 用途：**教学资料文件**（持久、按主题归到家长库、跨孩子共享）。

  ### B. 聊天框上传（孩子聊天）
  - 触发：ChatWindow「📎 上传」按钮（:792-795）→ 落盘 `data/children/<childId>/uploads/`（`ipc-handlers.ts:984-1010` `file:save_upload`，`getUploadsDir` 按 childId 隔离）。
  - 处理：图片→视觉模型识别、音频→转写、txt/md→读全文进上下文（ISSUE-008）；`pruneUploads` 上限 200 个裁剪。
  - 用途：**临时会话附件**（仅本次对话使用，不进课程库、不共享、按孩子隔离）。

  ### C. 家长聊天框上传（ISSUE-044 修正，2026-08-25 已实施）
  - 触发：家长页 ChatWindow（TopicDetail / TopicEditor 的 AI 对话）「📎 上传」按钮，现传 `owner="parent"`。
  - **修正前**：家长聊天框未传 `childId`，上传落点塌成 `data/children/undefined/uploads/`（错误且污染孩子目录）。
  - **修正后**：落盘 `data/parents/<pid>/uploads/`（`ipc-handlers.ts` 新增 `file:save_upload_parent` / `file:open_upload_parent` / `file:read_upload_parent`，走 `getParentUploadsDir`（`parent-library.ts` 新增）；preload 新增 `saveParentUpload` / `openParentUpload` / `readParentUpload`；`ChatWindow.tsx` 据 `owner==="parent"` 路由，默认 `pid="default"`）。
  - 处理：与孩子聊天框一致（图片识别 / 音频转写 / txt·md 读取进上下文）；同样受 `pruneUploads` 上限裁剪。
  - 用途：**家长临时会话附件**，归到家长库 uploads，与孩子目录隔离（呼应 ISSUE-029 家长库为唯一真源）。

  ### 异同小结
  | 维度 | 课程资料上传（A） | 聊天框上传（B） |
  |---|---|---|
  | 落盘位置 | `data/parents/<pid>/materials/<topicDir>/`（父库共享） | `data/children/<childId>/uploads/`（孩子隔离） |
  | 隔离维度 | 按主题 / 家长 | 按孩子 |
  | 用途 | 教学资料文件，持久、进课程库、跨孩子共享 | 临时会话附件，仅本对话、不入课程 |
  | 是否进课程库 | 是（html 自动关联 `courses.html_path`） | 否 |
  | 生命周期 | 持久（家长库） | 会话级（200 个裁剪） |
  | 媒体处理 | media/ 子目录供 html `media://` 引用 | 图片识别 / 音频转写 |
  | 共享范围 | 所有分配到该主题的孩子可见 | 仅该孩子本会话 |

- **结论（直接回答用户）**：课程资料上传**不放孩子目录、放家长库的 `materials/<主题>/`**，是教学资料库的一部分（与聊天框上传完全两套、不共享）。两者容易混淆是因为按钮文案都叫"上传"，但目的与落点完全不同。家长聊天框上传（ISSUE-044 修正后）归到 `data/parents/<pid>/uploads/`，不再误落孩子目录。
- **潜在优化（候选，非必须）**：① 课程上传按钮文案改为「上传教学资料」、聊天按钮保持「上传文件」，降低混淆（呼应 ISSUE-038 的去歧义）；② 课程上传是否也该有"按孩子隔离/临时"选项——当前设计是"家长资料共享给孩子"，符合 ISSUE-029 架构，无需改。
- **实施记录（2026-08-25）**：已修复家长聊天框上传落点。改动：① `electron/lib/parent-library.ts` 新增 `getParentUploadsDir(parentId="default")`；② `electron/lib/ipc-handlers.ts` 新增 `file:save_upload_parent` / `file:open_upload_parent` / `file:read_upload_parent`（镜像孩子三件套，落点切到家长 uploads，路径校验/裁剪一致）；③ `electron/preload.ts` 新增 `saveParentUpload` / `openParentUpload` / `readParentUpload`；④ `src/components/ChatWindow.tsx` `Props` 增 `owner?: "child"|"parent"` + `parentId?`，`persistUpload`/`openUploaded`/`toggleMessageAudio` 据 `owner` 路由；`childId` 改为可选；⑤ `TopicDetail.tsx` 与 `TopicEditor.tsx` 的 ChatWindow 加 `owner="parent"`。验证：`tsc --noEmit` 过滤 TS2318/TS2552 全局噪声后无业务错误。`window.api` 类型为 `any`，无需改 d.ts。注意：家长聊天"历史会话"列表/读取（piListSessions/piGetSessionMessages）仍按 `childId` 走 `getChildDir`，家长会话存于 `data/.pi/agent/sessions/` 不走该路径——属独立的家长会话历史问题，不在本 issue 范围，未动。
- **排查 / 修改入口**：`electron/lib/ipc-handlers.ts:336`（parent:uploadMaterial）、`:984`（file:save_upload）；`electron/lib/parent-library.ts:593-611`（copyMaterialIntoParent + MEDIA_EXTS）；`electron/lib/config.ts` `getParentMaterialsDir`(:38) / `getUploadsDir`；前端 `src/components/TopicDetail.tsx:249-269,468,497`、`src/components/ChatWindow.tsx:285-303,792-795`。
- **关联**：ISSUE-029（家长库资料共享、courses.html_path 真源）；ISSUE-008（聊天框上传的识别/转写路由）。
- **优先级**：已完成（ISSUE-044 修正：家长聊天框上传落点已改为家长库 uploads，2026-08-25 实施；剩余候选仅为文案去歧义，未做）。
- **记录时间**：2026-08-25

## [ISSUE-045] 课程详情页「标签」家长可编辑，且标签选项从数据库获取

- **类型**：功能缺口 / 待实施（前端可编辑 + 后端家长库缺标签定义表）
- **用户原话**：课程详情里的标签，家长可以编辑修改，标签选项从数据库里获取。
- **现状（已定位，2026-08-25）**：

  ### 1. 前端：课程详情标签当前只读、无编辑入口
  - `src/components/TopicDetail.tsx:492-494` 的「标签」`<Section>` 仅做展示：`{selected.tags || <span>（无）</span>}`，**没有输入框/选择器/保存按钮**。
  - 对比：同页「教学方法」tab 已有完整的「✏️ 编辑 / 取消 / 保存」内联编辑态（:435-456，`editingMethod`+`methodText`+`saveMethod`），但「每课方法」「标签」均只读——编辑态是缺的。
  - `selected.tags` 来自 `parentUpsertCourse` 查询返回（`parent-library.ts:226,718-724`），是 `courses.tags` 列的逗号分隔字符串。

  ### 2. 后端：家长库（parent.sqlite）没有标签定义表 → 「选项从数据库获取」当前不成立
  - 家长库 schema（`parent-library.ts:68-98` `PARENT_SCHEMA_TABLES`）只建 `topics` / `courses` / `meta` 三表；`courses.tags` 是**纯 TEXT 列**（:87），**没有 `tags` 定义表**。
  - IPC 层 grep `parent:getTags` / `parentTags` / `getSubjectTags`：**无匹配**——即家长端根本没有「拉取标签选项」的接口，前端无从获取可选项。
  - 对照**孩子库已具备完备的标签定义机制**（可作为父库参照）：
    - `kb-sqlite.ts:121` 有 `tags(tag TEXT PRIMARY KEY, dimension, criteria)` 定义表（与 `daily_entries.tags` / `courses.tags` 应用列分离，符合 ISSUE-013 设计）；
    - `kb-sqlite.ts:759` `queryTags(childDir, tag?)` 按维度/词序返回全部定义 → 即「从数据库获取标签选项」的现成实现；
    - `kb-sqlite.ts:928` `tagsToMarkdown` 把定义表渲染成 markdown 供 AI 打标签前查；
    - 孩子 init 时 `initChildKb` 会播种默认标签词表（见 ISSUE-032 实施记录，默认 20 个）。
  - **结论**：「标签选项从数据库获取」在孩子侧已落地，家长侧**完全缺失**——这正是本 issue 要补的。家长是标签词表的拥有者（定义教学维度与标准），孩子只是应用方，所以从架构上标签定义本就该在家长库。

- **建议方案（候选，待拍板）**：
  - **后端**：在 `parent-library.ts` 的 `PARENT_SCHEMA_TABLES` 增加 `tags(tag TEXT PRIMARY KEY, dimension TEXT NOT NULL DEFAULT '', criteria TEXT NOT NULL DEFAULT '')` 表（结构照搬 kb-sqlite :121），并新增 `queryParentTags(parentId, tag?)`（照搬 `queryTags` :759）；首次建库时从一份默认词表播种（参照 initChildKb 的默认 20 标签，或单独一份家长默认词表）。加 IPC `parent:getTags` 返回选项。
  - **前端**：课程详情「标签」Section 改为可编辑——`selected.tags` 字符串 → 拆成 chip 列表 + 多选下拉（选项来自 `parent:getTags`）+ 自由新增（新增时写回 `tags` 定义表）；保存复用现有 `parentUpsertCourse`（已支持写 `tags` 列，`parent-library.ts:268-274,491-516`）或新增 `parent:courseSaveTags` IPC。建议把「标签」与「每课方法」都补齐内联编辑态，与「教学方法」tab 一致。
  - **可选**：标签定义（维度/判断标准）是否也要一套「家长维护 UI」——当前 kb-sqlite 的 tags 定义只能靠 init 播种或 AI 写，家长无法在界面维护维度/标准；若只做"选项下拉"可先不管定义维护，但中长期建议加（呼应 ISSUE-013 的"标签只能从定义表选"约束在家长侧也要可维护）。

- **待确认项**：
  1. 家长标签词表来源：复用孩子 init 播种的那 20 个默认标签？还是家长库单独一套默认词表？是否要支持家长在界面增删标签？
  2. 编辑保存走 `parent_course_save` AI 工具（现有：`TopicDetail.tsx:277` 已引导 AI 用此工具写 tags），还是新增显式 `parent:courseSaveTags` IPC 直接写库（更可靠、不依赖 AI 听话）？
  3. 是否要把「每课方法」(:470-472) 也一并补成可编辑（与标签编辑态同时做，统一 UX）？
  4. 标签定义表（dimension/criteria）是否本期就要家长可维护，还是仅先做"选项下拉 + 应用"？

- **排查 / 修改入口（可直接执行）**：
  - 前端只读点：`src/components/TopicDetail.tsx:492-494`（标签展示）、`:470-472`（每课方法展示，同样缺编辑态）；
  - 家长库 schema：`electron/lib/parent-library.ts:68-98`（缺 tags 定义表）、`openParentDb`（:122 可加 ensureParentV3 播种默认标签）；
  - 参照实现：`electron/lib/kb-sqlite.ts:121`（tags 定义表）、`:759` `queryTags`、`:928` `tagsToMarkdown`、initChildKb 默认标签播种；
  - 写库：家长 `parentUpsertCourse`（`parent-library.ts:268-274, 491-516`）已支持 tags 列；
  - IPC：需新增 `parent:getTags`（ipc-handlers.ts 仿 `parent:listTopics` / `parent:getCourses` 风格）；
  - 前端拉取：TopicDetail.tsx 需加 `useEffect` 在打开课程详情时 `window.api.parentGetTags()` 拉选项。

- **关联**：ISSUE-013（标签定义表 vs 应用列分离的设计——父库应照搬此模式）；ISSUE-043（标签置顶展示——与本条同处课程详情，建议一并做：先置顶 :043 + 再补可编辑本 issue）；ISSUE-029（家长库为唯一真源，标签定义放家长库符合架构）；ISSUE-038（标签字段与其他提示词重复治理是另一层，本条只管"编辑 + 选项来源"）。
- **优先级**：已实施（2026-08-25）。
- **✅ 已实施（2026-08-25）**：
  - **后端**：`parent-library.ts` ① `PARENT_SCHEMA_TABLES` 新增 `tags(tag, dimension, criteria)` 定义表；② `openParentDb` 调 `ensureParentTags` 在空表时播种 `PARENT_DEFAULT_TAGS`（20 个，四维，与 initChildKb 的 DEFAULT_TAGS 同源设计、父库独立维护一份）；③ 新增 `queryParentTags(parentId, tag?)`（照搬 kb-sqlite `queryTags`）与 `upsertParentTag(parentId, tag, dimension?, criteria?)`（INSERT OR REPLACE）。
  - **IPC + preload**：`ipc-handlers.ts` 新增 `parent:getTags`（返回 `queryParentTags(undefined)`）、`parent:upsertTag`（写回定义表）；`preload.ts` 暴露 `window.api.parentGetTags()` / `parentUpsertTag(tag, dimension?, criteria?)`（`window.api` 为 `any`，无需补类型声明）。
  - **前端**：`TopicDetail.tsx` 课程详情「标签」Section 改为可编辑——当前标签渲染为可移除 chip；下拉从 `parent:getTags` 选项（过滤已选中项、标注维度）添加；输入框「新增」先调 `parentUpsertTag` 写回定义表再应用到本课；保存复用既有 `parentUpsertCourse(topicDir, { title, tags })`（`COALESCE(NULLIF(...))` 语义，部分字段更新安全，不覆盖其它列）。打开主题时 `useEffect` 拉取选项。
  - **验证**：`tsc --noEmit` 四个改动文件（parent-library / ipc-handlers / preload / TopicDetail）无新增类型错误（已过滤环境级 TS2318/TS2552 噪声）。未跑 electron-vite 全量构建、未 git 提交。
  - **范围说明（窄改动）**：本期只做"选项下拉 + 应用 + 自由新增写回定义表"，**未**做"标签定义（dimension/criteria）的家长 UI 维护"——属原待确认项 4，后续可加（呼应 ISSUE-013）。标签应用列仍是 `courses.tags` 逗号分隔字符串，与定义表分离（符合 ISSUE-013「定义表 vs 应用列」模式）。
- **记录时间**：2026-08-25

## [ISSUE-046] 上下课提醒：家长设置每孩子每日学习时间点，到点页面弹铃铛动画 + 上课/下课铃声

- **类型**：新功能 / 待实施（定时提醒 + 前端动画 + 音频播放）
- **用户原话**：增加 issue，上下课提醒，类似于时间表，只是每节课学生么由孩子自己安排。家长设置每个孩子每天的学习时间点，到时间了，就在页面上进行提醒。例如出现铃铛的动画，并有下课或上课铃的声音。
- **需求拆解**：
  1. **家长配置**：在孩子维度设置「每日学习时间点」列表（如 `["09:00","10:30","14:00",...]`）。语义上有两种候选：① 每个时间点 = 一个「上课铃」提醒（孩子自由安排内容）；② 配置为「时间段」`[{start,end}]`，到点分别触发「上课铃 / 下课铃」。用户说"每节课由孩子自己安排"，故家长**只设时间、不设内容**——最简单是方案①（纯时间点 + 上课铃）；若想要"下课铃"则需方案②（成对 start/end）或额外区分类型字段 `type: "start"|"end"`。
  2. **到点触发**：主进程 cron 每分检测命中 → 向所有窗口广播该孩子的提醒事件（含 childId + 类型）。
  3. **前端表现**：页面出现铃铛动画（SVG/CSS 抖动 + 渐显覆盖层），并播放对应铃声（上课铃 / 下课铃）。
  4. **范围**：用户明确"在页面上进行提醒"= 应用内提醒（in-app overlay），非系统通知（Electron Notification 可选增强）。

- **现状（已定位，2026-08-25）——可高度复用现有调度/广播机制，无需另起炉灶**：

  ### 1. 配置落点（天然适配现有 per-child 调度配置）
  - `electron/lib/scheduler.ts:22-34` `SchedulerChildConfig` 接口 + `:51-56` `DEFAULT_CHILD_CONFIG` 已定义每孩子配置（recording/sessionReset/autoNewSession/archiveLimit），**新增 `classReminder: { enabled: boolean; times: string[] }`（方案①）或 `slots: { start: string; end: string }[]`（方案②）即可**。
  - 配置文件 `data/scheduler-config.json`（`getSchedulerConfigPath()` = `config.ts:91`）已是 per-child 结构（实测含 `cfg-kid-1`/`1f050a7f…` 等），存新字段零成本。
  - `getChildSchedulerConfig`（scheduler.ts:127-144）+ `setChildSchedulerConfig`（:146-169）的合并缺省逻辑需补新字段（仿 `recording` 处理：`enabled ?? false`、`times` 兜底）。

  ### 2. 触发机制（直接复用现有 cron 每分钟巡检）
  - `scheduler.ts:219-290` `startScheduler` 的 `cron.schedule("* * * * *", ...)` 每分遍历每个孩子、用 `hhmm(now)` 比对配置时间点——**与 `recording.times.includes(nowMin)` 判重逻辑（:231-247）几乎一模一样**，新增一段 `classReminder` 检测即可，每天每点只提醒一次靠 `task-state.json` 的 `lastRun` 防重（同 `recording` 的 `cs.recording.lastRun` 模式，state 结构 `scheduler.ts:10-19` + `getChildState` :93-109）。

  ### 3. 广播机制（已有现成样板，照搬即可）
  - `scheduler.ts:210-216` `broadcastSessionReset(childId)` 用 `w.webContents.send("pi:session_reset", { childId })` 向所有窗口广播——新增 `broadcastClassReminder(childId, type)` 发 `pi:class_reminder` 即可。
  - `electron/preload.ts:34-35` `onPiSessionReset` 注册 `pi:session_reset` 监听——新增 `onPiClassReminder` 注册 `pi:class_reminder`。
  - 前端已在 `src/pages/Learn.tsx:315` 通过 `window.api.onPiSessionReset(handleSessionReset)` 接收（回调 :290 清空状态）——新增全局监听组件即可（建议放 App 根或 Learn 页，保证任意子页面打开都能弹动画）。

  ### 4. 音频播放（已有播放通道，但**缺铃声资源**）
  - 前端已有 `new Audio(url).play()` 播放模式：`ChatWindow.tsx:388-396`（TTS 回放）、`:504-514`（语音消息）。**复用同一通道播 `url` 即可**。
  - **关键缺口**：全仓搜 `*.mp3/*.wav/*.ogg` 与 `*bell*` —— **没有任何铃声音频文件**（grep `bell/ding/class` 仅命中 `recording` 目录与无关词）。铃声需新增：① 打包资源（放 `public/` 或 `assets/`，如 `bell-start.mp3`/`bell-end.mp3`）；② 或用 Web Audio API 合成铃声（无外部文件）；③ 或 Edge TTS 生成（但"铃声"非语音，不如①②自然）。**需拍板音频来源**。
  - 播放需注意：用户可能在静音环境，建议动画 + 可选 OS 通知（Electron Notification）双保险。

  ### 5. 铃铛动画（全新，需新建组件）
  - 现有 UI 无铃铛/提醒动画组件；建议新建 `src/components/ClassReminderOverlay.tsx`（全屏半透明覆盖层 + 居中铃铛 SVG，`@keyframes` 抖动/缩放 + 渐显渐隐），监听 `pi:class_reminder` 显示 3~5 秒后自动消失，可点关闭。

- **建议方案（候选，待拍板）**：
  - **配置**：`scheduler.ts` 给 `SchedulerChildConfig` 加 `classReminder: { enabled, times: string[] }`；`SchedulerSettings.tsx` 每孩子卡片加「上课提醒」开关 + 多时间点输入（仿现有 `recording.times` 编辑 UI）；保存走现有 `scheduler:config:set`（ipc-handlers.ts:433）。
  - **触发+广播**：`scheduler.ts` 的 cron 循环新增 `classReminder` 段（仿 recording :231-247），命中 → `broadcastClassReminder(childId, "start")`；preload 加 `onPiClassReminder`。
  - **前端**：新建 `ClassReminderOverlay` 全局挂载，听 `pi:class_reminder` → 显示铃铛动画 + `new Audio("/bell-start.mp3").play()`。
  - **下课铃**：若采用方案②（时间段），到点再发 `"end"` 类型播 `bell-end.mp3`。

- **待确认项**：
  1. **时间点语义**：纯「上课铃」时间点（方案①，最简单）？还是「时间段」需上下课两种铃（方案②，需 start/end 配对）？—— 决定配置字段形状。
  2. **铃声音频来源**：打包 mp3 资源 / Web Audio 合成 / Edge TTS？当前全仓无铃声文件，需新建或合成。
  3. **是否叠加系统通知**：仅应用内动画，还是也发 Electron Notification（孩子切到别的窗口也能看到）？
  4. **提醒展示位置**：仅 Learn（孩子学习页）弹，还是全局覆盖层（任意页都能弹）？建议全局。
  5. **是否关联 ISSUE-031 的「每日学习量」**：提醒只是"时间点到了"，与"今天学几课"无强绑定（用户说内容孩子自己安排），但 UI 可在提醒里顺带显示"今日目标 X 课"增强引导——可选。

- **排查 / 修改入口（可直接执行）**：
  - 配置类型：`electron/lib/scheduler.ts:22-56`（`SchedulerChildConfig` + `DEFAULT_CHILD_CONFIG`）；
  - 配置读写合并：`scheduler.ts:127-169`（`getChildSchedulerConfig` / `setChildSchedulerConfig` 补新字段）；
  - 触发+广播：`scheduler.ts:219-290`（`startScheduler` cron 循环加段）、`:210-216`（`broadcastSessionReset` 仿写 `broadcastClassReminder`）；
  - 配置文件：`data/scheduler-config.json`（per-child，零成本扩字段）；
  - IPC：`electron/lib/ipc-handlers.ts:419-440`（`scheduler:config:get` / `:set` 已透传整个 config，新字段自动进出）；
  - preload：`electron/preload.ts:34-35`（仿 `onPiSessionReset` 加 `onPiClassReminder`）；
  - 前端监听样板：`src/pages/Learn.tsx:290-320`（仿 `onPiSessionReset` 模式）；
  - 前端播放样板：`src/components/ChatWindow.tsx:388-396,504-514`（`new Audio(url).play()`）；
  - 前端配置 UI：`src/components/SchedulerSettings.tsx:33-96`（每孩子卡片加提醒配置，仿 recording 编辑）；
  - 音频资源：需新建 `public/bell-start.mp3` + `public/bell-end.mp3`（或合成方案），并在 `package.json`/构建里确保打包。

- **关联**：ISSUE-031（每孩子每日「学习量」入库——本 issue 是「学习时间点」提醒，二者正交：量=学多少，点=何时学；UI 可协同展示）；ISSUE-041（备份——scheduler-config.json 含本提醒配置，应纳入备份范围，已排除敏感数据）；ISSUE-040（升级——配置向后兼容需注意）。
- **优先级**：待定（建议中：调度/广播机制可高度复用、风险低；唯一硬缺口是铃声资源 + 新建动画组件，工作量可控）。
- **记录时间**：2026-08-25

## [ISSUE-047] 大部分按钮改为 icon 表示、去掉文字描述，鼠标悬停 icon 时显示按钮名称

- **类型**：UI 重构 / 已实施（2026-08-25，跨多组件统一图标 + tooltip）
- **用户原话**：记录 issue 将大部分按钮用一个 icon 表示，把文字描述去掉，文字描述太占空间。鼠标移动上 icon 时显示按钮名称。
- **需求拆解**：
  1. 把界面上**大部分按钮**由「emoji + 中文文字」改成**纯 icon**（去掉文字标签）。
  2. 鼠标悬停 icon 时显示按钮名称（tooltip）。
  3. 目标：节省横向空间、界面更紧凑。

- **现状（已定位，2026-08-25）——有两个关键事实决定了方案：**

  ### 1. 项目**没有图标库**，当前是「emoji + 中文文字」混用
  - `package.json` 的 `icon` 字段为 `null`，`node_modules` 无 `lucide-react` / `react-icons` / `antd` / `heroicons` —— **无任何图标库**。
  - 现状图标是两类：① 内联 `<svg>`（仅 `TitleBar.tsx:109-133` 的窗口 最小化/最大化/关闭 三控）；② emoji 当 icon 用（`CourseManager.tsx:133-135` 的 `📖 教学方法` / `📚 课程详情` / `🗂 学习资料管理`、`TopicDetail.tsx:581` `📤 上传资料`、`AgentPromptEditor` 等）。
  - **没有统一的 `IconButton` 抽象组件** —— 只有 `CourseManager.tsx:146` 的 `CardBtn`（文字+emoji label）和 `TopicDetail.tsx:752` 的 `MiniBtn`（单字 label，↑↓删），都不是图标抽象。每个按钮各自写 `<button>文字</button>`，样式散落 CSS。

  ### 2. hover 显示名称的「tooltip 机制」其实**已经存在**且可复用
  - 大量按钮**已经**用了原生 `title="..."` 属性做 hover 提示，正是本 issue 要的"鼠标移到 icon 上显示名称"通道：
    - `ChatWindow.tsx:560`(显示/隐藏历史会话)、`:662`(收起/查看思考过程)、`:670`(朗读)、`:736`(播放语音)、`:758`(播放/停止录音)、`:765`(移除录音)、`:780/:797`(移除)、`:811`(上传文件说明)、`:824`(按住说话)；
    - `Learn.tsx:577`(收起/展开侧边栏)、`:602`(切换展示页)、`:640`(模型)、`:660`(朗读语速)、`:674`(语速选项)、`:687`(AI 伙伴设置)、`:698`(修改密码)、`:713`(退出)；
    - `TitleBar.tsx:108`(最小化)、`:116`(最大化/还原)、`:129`(关闭)；
    - `MaterialManagerModal.tsx:94`(折叠/展开)、`:101`(上传到 X/)、`:595`(移除) 等。
  - 即：把文字去掉、换成 icon 后，只要**保留/补上 `title` 属性**即满足"悬停显示名称"。原生 `title` 是最省事的方案；若想要更精致（延迟/样式化气泡），可新建 `<Tooltip>` 组件，但非必须。

  ### 3. 文字按钮分布广（待改造清单，按页面）
  - **Dashboard.tsx**：`← 返回主页`(:74)、`退出登录`(:75)、`新增孩子`(:155)、`进入`(:143)、`重置密码`(:204)、`管理主题`(:210)、`删除`(:228)、`进度`(:198) 等；
  - **Learn.tsx** 侧边栏：`切换展示页`(:602)、`模型`(:640)、`AI 伙伴设置`(:687)、`修改密码`(:698)、`退出`(:713)、`朗读语速`(:660) 等；
  - **ChatWindow.tsx** 工具栏：`显示/隐藏历史会话`(:560)、`查看思考过程`(:662)、`朗读`(:670)、`播放语音`(:736)、`播放/停止录音`(:758)、`移除录音`(:765)、`上传文件`(:811)、`按住说话`(:824)、`发送`(:843)；
  - **TopicDetail.tsx**：`✏️ 编辑/取消/保存`(:549-553)、`📤 上传资料`(:581/:676)、`移除标签`(:594)、`↑/↓/删 课程`(:528-530)、`删除课程`(:675)；
  - **Settings.tsx**：`保存 Key`(:183)、`刷新模型`(:201)、`设为默认`(:241)；
  - **其它**：`AgentPromptEditor`(保存/重置/历史/关闭)、`MaterialsPanel`(返回)、`SchedulerSettings`(保存/轮询)、`GeneralSettings`(保存/检查更新/下载/安装)、`VoiceSettings`(启用/切换/保存/测试)、`ChildTopicsModal`(迁移/添加/关闭)、`ProgressView`/`LearningDashboard`(返回/刷新/进入)。

- **建议方案（候选，待拍板）**：
  - **① 引入图标库（推荐 lucide-react）**：tree-shakeable、SVG 矢量、风格统一、量足（发送/上传/麦克风/播放/设置/编辑/删除/箭头等全有）。装 `npm i lucide-react`，新建共享组件 `<IconButton icon={Send} title="发送" onClick={...} />`（在 `src/components/`，统一 `.icon-btn` 样式：固定尺寸、hover 背景、focus 可见、`aria-label`=title 兼顾无障碍）。后续按钮统一走它，消除散落的 `<button>文字</button>`。
  - **② 文字→icon 映射**：逐页把文字按钮替换；保留 `title`（= 原文字）作 tooltip；emoji 按钮（📤📖 等）也改 lucide icon 更统一。
  - **③ tooltip 策略**：默认复用原生 `title`（零成本）；对高频/需精致处（如发送、录音）可选升级为自定义 `<Tooltip>` 气泡。
  - **④ 例外保留文字**：主操作/歧义按钮可保留文字或 icon+文字（如模态框「确认/取消」、表单「保存」），由"大部分"语义——非全部。建议保留文字的：破坏性确认（删除孩子/清空会话）、长尾低频操作。

- **待确认项**：
  1. **图标来源**：装 `lucide-react`（推荐）？还是继续用 emoji（零依赖但风格不一）？还是内联 SVG 组件（自维护）？—— 决定依赖与工作量。
  2. **是否"大部分"还是"全部"**：主 CTA（保存/确认/发送）是否也图标化，还是保留文字/图标+文字？需定边界，避免儿童界面（Learn/ChatWindow）看不懂纯图标。
  3. **儿童友好约束**：用户既定偏好「儿童友好视觉、大字体、高对比」（见长期记忆）——图标需**足够大、辨识度高、配色清晰**，不能为了省空间缩太小；Learn/ChatWindow 的图标尤其要孩子能懂（如朗读=喇叭、录音=麦克风、历史=时钟）。
  4. **tooltip 形式**：原生 `title` 够用，还是要做样式化气泡（带延迟/箭头）？
  5. **是否建统一 `<IconButton>` 组件**：强烈建议（消除重复、统一可访问性），但属于额外改动量，需拍板。

- **排查 / 修改入口（可直接执行）**：
  - 依赖：`package.json`（加 `lucide-react`）；`src/components/` 新建 `IconButton.tsx` + `src/styles.css` 加 `.icon-btn` 类；
  - 窗口控制样板（已有内联 svg）：`src/components/TitleBar.tsx:109-133`（可改为复用 IconButton）；
  - 现有 tooltip 通道（保留/补 title）：`ChatWindow.tsx:560/662/670/736/758/765/780/797/811/824`、`Learn.tsx:577/602/640/660/674/687/698/713`、`TitleBar.tsx:108/116/129`、`MaterialManagerModal.tsx:94/101/595`；
  - 改造起点（高频工具栏）：`ChatWindow.tsx:557-843`（发送/上传/录音/朗读/历史/思考）、`Learn.tsx:574-713`（侧边栏全套）；
  - emoji 按钮（改 lucide）：`CourseManager.tsx:133-135`、`TopicDetail.tsx:581/676`；
  - 文字按钮清单：`Dashboard.tsx`、`Settings.tsx`、`TopicDetail.tsx`、`AgentPromptEditor.tsx`、`SchedulerSettings.tsx`、`GeneralSettings.tsx`、`VoiceSettings.tsx`、`ChildTopicsModal.tsx`、`ProgressView.tsx`、`LearningDashboard.tsx`（见上"分布广"逐条）。

- **关联**：ISSUE-046（上下课提醒的铃铛动画——同为 UI 紧凑化/图标化方向，铃铛 icon 可复用 IconButton 体系）；长期记忆「儿童友好视觉（大字体、紫色主题、高对比）」——图标尺寸/对比度需遵守，不能因省空间牺牲可读性；ISSUE-038（提示词去重——独立，但同属"界面整洁"审美目标）。
- **优先级**：已落地（2026-08-25）。
- **实施记录（2026-08-25）**：
  - **依赖**：新增 `lucide-react`（SVG 矢量图标库，tree-shakeable）。安装时因项目既有 `edge-tts⊛typescript` peer 冲突，用 `npm i lucide-react --legacy-peer-deps` 绕过（冲突与本次无关）。
  - **统一组件**：新建 `src/components/IconButton.tsx`（`icon` + `title`(=tooltip+aria-label) + `active`(紫底高亮) + `danger`(红色 hover) + `label`(icon+文字) + `size`(默认20) + `...rest`）；`src/styles.css` 加 `.icon-btn` / `.icon-btn.window-ctrl`(窗口控制) / `.icon-btn.card-primary`(卡片主操作紫底) / `.chat-input .send-btn`(紫色圆形发送)。风格统一紫色主题、儿童友好（大图标、高对比、focus 可见）。
  - **Tooltip 策略**：复用原生 `title`（零成本、项目里大量按钮已有），未做样式化气泡。
  - **范围**：确认"大部分改纯 icon、保留关键文字"——破坏性/确认/表单保存（取消/确认/保存/关闭）保留文字或 `danger` 图标；tab 导航标签保留文字；带特殊形状/动画的按钮（mic/upload/speak/trace）只换 lucide 矢量图标、保留原 className。
  - **已改造文件**：ChatWindow（历史/朗读/录音/上传/发送/移除）、Learn（侧边栏收起/展示页/模型/语速/设置/密码/退出 + 窗口控制复用）、TitleBar（最小/最大/关闭内联 svg→IconButton）、Dashboard（返回/退出/家长AI提示词/孩子操作行/添加孩子 icon+文字）、CourseManager（CardBtn→图标+card-primary）、TopicDetail（返回/上传/编辑/删除课程/MiniBtn↑↓删/移除标签/添加标签）、Settings（刷新模型/设为默认）；家长页由子代理批量改：AgentPromptEditor/SchedulerSettings/GeneralSettings/VoiceSettings/BackupSettings/MaterialManagerModal/ChildTopicsModal/ProgressView/LearningDashboard/CourseDetail/MaterialsPanel（其余无纯文字操作按钮的文件未动）。
  - **验证**：`npm run build` 通过（renderer/main/preload 均编译，无 TS 报错）；vitest 跑（与改动无关既有失败见下）。
- **记录时间**：2026-08-25

## [ISSUE-048] 去掉孩子「课程添加」里的"存量迁移"功能（过渡功能，不应在 app 体现）

- **类型**：UI/功能清理（去除过渡态的"孩子资料迁移到家长库"入口；破坏性迁移逻辑是否保留为 dev 工具待拍板）
- **用户原话**：新增 issue，去掉孩子的课程添加里的存量迁移功能，这个是把孩子里的学习资料迁移到家长库，这只是个过渡功能，不需要再 app 里体现。
- **需求拆解**：删除 app 里"存量迁移"的用户入口（按钮 + 空状态引导文案），让"孩子资料 → 家长库"的迁移只在需要时通过 dev/CLI 手段进行，普通用户界面不再出现。
- **现状（已定位全链路）**：
  1. **UI 入口（前端）**：
     - `src/components/ChildTopicsModal.tsx:127-148` 的 `runMigrate()`——点「迁移存量资料」按钮后 `confirm` 警告 + 调 `window.api.parentMigrate()` + 显示迁移结果。
     - `ChildTopicsModal.tsx:158-166` 的 `<IconButton icon={RefreshCw} title="迁移存量资料到家长库" onClick={runMigrate} />`——孩子"学习主题"面板顶部的迁移按钮。
     - `ChildTopicsModal.tsx:183-184` 空状态提示：「家长库暂无主题。点击上方「迁移存量资料」把现有孩子的主题/资料导入家长库。」
     - `src/pages/CourseManager.tsx:113` 提示文案：「家长库暂无主题。可先新建主题，或在「孩子管理 → 学习主题」里迁移存量资料。」（引导用户去点迁移）。
  2. **preload 通道**：`electron/preload.ts:161` `parentMigrate: () => ipcRenderer.invoke("parent:migrate")`。
  3. **IPC handler**：`electron/lib/ipc-handlers.ts:338-345` `ipcMain.handle("parent:migrate", ...)` → 调 `migrateChildrenToParent()`。
  4. **后端迁移实现**：`electron/lib/parent-library.ts:762-863+` `migrateChildrenToParent(parentId)`（一次性存量迁移：method.md→父库 topics.method 全文、html→父库共享目录 materials/、孩子 courses 回填 html_path、删孩子侧空 materials 目录；破坏性，调用前需备份）。
  5. **历史背景**：这是 2026-08-21 ISSUE-029 落地的"现在一次性迁移"产物，当时用于把既有孩子目录里的 `learning/<topic>/{method.md,materials/*.html}` 上移到家长库（资料库上移 + method 全文入库）。迁移已完成、架构已切换为「资料在父库、孩子经 parent_content 取」，该按钮纯属过渡期便利入口，长期不应留在 app。
- **方案要点（候选）**：
  1. **必做（前台收敛）**：删 `ChildTopicsModal.tsx` 的迁移按钮（:158-166）与 `runMigrate` 函数（:127-148），并把两处空状态/引导文案（:184、CourseManager.tsx:113）改为「家长库暂无主题，请新建主题或从课程内容页制作」（去掉"迁移存量资料"引导）。
  2. **待拍板（后台去留）**：`migrateChildrenToParent` + IPC `parent:migrate` + preload `parentMigrate` 是否一并删除？
     - 方案 A（推荐，彻底清理）：连 IPC/preload/后端函数一并删，避免死代码与误触发破坏性迁移；若未来真要迁移，改为临时脚本/cli 一次性跑。
     - 方案 B（保留后台、只去 UI）：删 UI 入口即可，后端函数留作 dev 工具（风险：死代码 + 误用破坏性操作）。
  3. **类型清理**：`ChildTopicsModal.tsx` 里的 `MigrateResult` 类型引用（:134）一并移除（若走方案 A）。
- **待确认项**：
  1. 后台迁移逻辑直接删（方案 A）还是仅去 UI（方案 B）？
  2. 删除按钮后，空状态文案怎么写（是否提示"新建主题/制作教学内容"即可）？
  3. 是否确认存量迁移**早已跑过、所有孩子资料已在父库**（验证：`data/parents/default/materials/` 已有各主题目录、孩子目录 `learning/<topic>/materials/` 已清空）——若还有孩子未迁移，删按钮会堵死补救路径，需先确认无遗漏。
- **排查 / 修改入口（可直接执行）**：
  - 前端：`src/components/ChildTopicsModal.tsx`（删按钮 :158-166、删 `runMigrate` :127-148、改空状态文案 :184、去 `MigrateResult` 引用）、`src/pages/CourseManager.tsx:113`（改引导文案）。
  - preload：`electron/preload.ts:161`（删 `parentMigrate`）。
  - IPC：`electron/lib/ipc-handlers.ts:338-345`（删 `parent:migrate` handler）。
  - 后端：`electron/lib/parent-library.ts:762-863+`（`migrateChildrenToParent` 及 `MigrateStats` 接口，方案 A 才删）。
- **关联**：ISSUE-029（资料上移家长库 + method 全文入库——本 issue 是清理其过渡迁移入口）；ISSUE-041（备份——迁移破坏性，删入口前确保已备份更稳妥）；ISSUE-047（图标化——删按钮不影响，但 `RefreshCw` icon 若只这一个用途可一并清理）。
- **优先级**：待定（建议中：过渡功能清理，UI 改动极小、风险低；确认存量已迁移干净即可动）。
- **记录时间**：2026-08-25
