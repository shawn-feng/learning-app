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
- **优先级**：待定（用户未标注，建议中：提升记录质量，但改动面较广需谨慎）。
- **记录时间**：2026-08-20

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
- **优先级**：待定（用户未标注，建议中：儿童 UX 关键，改动集中在单文件）。
- **记录时间**：2026-08-21
