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
