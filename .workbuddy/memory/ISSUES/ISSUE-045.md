## [ISSUE-045] 孩子 agent 会话注入：去掉「学习进度概览」，改为注入当天学习计划（无 todolist 则不注入）

- **类型**：需求 / 提示词调整（孩子 agent system prompt 注入内容变更）
- **描述**：
  1. **移除**每次孩子会话（开 Session）时注入到 system prompt 的「孩子的学习进度概览」段落（现由 `getLearningSummary` 生成，附在 `buildChildPrompt` 末尾）。
  2. **改为注入当天的学习计划**：内容来源 = 该孩子**当天的 Todolist**（今日计划 markdown）。即开会话即把今天要做的事（含 `[家长]` 规定项 + 孩子自规划项）放进提示词，让孩子 agent 一开始就清楚「今天该学什么」。
  3. **当天无 Todolist 则不注入**：查 `kb.todo.get`（today）若无内容（返回空/「今天还没有 todolist」），**不注入任何进度/计划段落**，保持 prompt 精简。
- **影响范围**：孩子 agent 开会话时的 system prompt（前缀缓存公共前缀）注入内容；影响孩子 agent「开局即知下一步/今天任务」的方式。家长模式不受影响。
- **现状 / 排查入口**：
  - **移除点①（计算）**：`electron/lib/pi-session.ts:413` `const progressContext = progressSummaryToMarkdown(getLearningSummary(childId));` —— 进度概览在此生成，需替换为当天计划获取。
  - **移除点②（注入段落）**：`electron/lib/pi-session.ts:239` `buildChildPrompt(childId, profile, progressContext?)` 及其 `:242-245` 注入的 `## 孩子的学习进度概览（已在下方替你读好，无需再读进度文件正文即可知道下一步学什么）` 整段 —— 改为注入当天计划（或按 `progressContext` 同款「空串则不注入」约定处理）。
  - **说明同步（必改，否则与注入内容矛盾）**：`electron/lib/pi-session.ts:74-79` `LEARNING_NAV_INSTRUCTIONS` 里「各主题的进度摘要……已放在系统提示顶部的『孩子的学习进度概览』里」相关文字，需改写为指向「当天的学习计划（Todolist）」，并删除/改写「直接用系统提示里给出的 next 值」等依赖进度概览的表述（agent 找下一课改为走 `todo_list` / `get_progress` 工具）。
  - **当天计划数据源**：`electron/lib/custom-tools.ts:1266-1274` `todo_list` 工具的 `read` 分支 → `dbQuery("kb.todo.get", { child_id, date })` 返回 `itemsMd`（非空即 todolist 文本，空则返回 `今天还没有 todolist。`）。日期用 `todoLocalDate()`（`:1197`，本地时区 YYYY-MM-DD，与 `todo_list` 工具保持一致）。session 构建处应以"今天"查 `kb.todo.get`：**有 `itemsMd` 则注入，无则不注入**。
  - **存储位置**：todolist 存服务端 `child_todos` 表（多设备共享，`custom-tools.ts:1246`）。注意 `getLearningSummary` 当前是同步读本地缓存（`pi-session.ts:422` 注释「会话前远程预取→本地缓存→同步读」），新计划读取需同样处理同步/缓存，避免开会话阻塞或读到昨天的旧计划（跨天边界要用同一"今天"）。
  - **前置能力已具备**：孩子 agent 工具列表已含 `todo_list`（`pi-session.ts:476`），agent 会话中仍可随时 `todo_list` read 当日计划；本 issue 是把"开局即知"从进度概览改为计划概览，并去掉冗余的进度注入。
- **优先级**：中（已实施）
- **记录时间**：2026-09-03

## 修复（2026-09-03，客户端 0.1.10+）
- **改动**：孩子 agent 开会话的 system prompt 注入，由「学习进度概览」改为「当天学习计划（Todolist）」；当天无 Todolist 则不注入任何段落。
- **新增（electron/lib/learning-summary.ts）**：`fetchTodayPlanRemote(childId, date)`（会话前远程预取当天 Todolist 到本地缓存 `cache/today-plan-<childId>.json`，与 todo_list read 同口径：itemsMd 空即空串）+ `getTodayPlan(childId)`（同步读缓存，含空串降级）。套用进度概览既有的「会话前预取→本地缓存→同步读」模式（systemPromptOverride 是同步链、不能 await）。
- **改动（electron/lib/pi-session.ts）**：
  - `createChildSession` 内：移除 `progressSummaryToMarkdown(getLearningSummary(...))` 与 `fetchProgressRemote(childId)` 预取；改为先 `const today = todoLocalDate()`，再 `await fetchTodayPlanRemote(childId, today)`，再 `const planContext = getTodayPlan(childId)`（同步）。
  - `buildChildPrompt(childId, profile, planContext?)`：段落标题由「孩子的学习进度概览」改为「孩子今天的学习计划」，注入 `planContext`；空串则不注入（保持精简）。
  - `LEARNING_NAV_INSTRUCTIONS`「进度查询」段：由「进度摘要已放在系统提示顶部『孩子的学习进度概览』、直接用 next 值」改写为「当天学习计划已注入系统提示顶部『孩子今天的学习计划』，确定今天学哪课直接看该段」，找下一课改为走 `todo_list` read / `get_progress` 工具。
  - import 调整：移除 `getLearningSummary/progressSummaryToMarkdown/fetchProgressRemote`，新增 `getTodayPlan/fetchTodayPlanRemote`（from learning-summary）与 `todoLocalDate`（from custom-tools）。
- **保留**：`get_progress` 工具与 `getLearningSummary/fetchProgressRemote`（ipc-handlers 面板刷新、custom-tools 的 get_progress 工具仍用，未删）；孩子仍可随时 `todo_list` read 当日计划。
- **验证**：esbuild 打包 pi-session.ts（含 learning-summary）通过，无语法/导入错（仅 kb-sqlite.ts 既有 duplicate-key 告警，无关）。
- **⚠️ 二次 bug（2026-09-03 晚，`npm run dev` 报 `ReferenceError: 家长 is not defined`）**：本改动重写「进度查询」段时，行 75 的 `[家长]` 误写**未转义反引号**（同文件行内代码应为 `\`` 转义），使 `LEARNING_NAV_INSTRUCTIONS` 模板提前闭合、模块求值崩。已修（`[家长]` 前后改 `\``）。教训：模板字符串内行内代码反引号一律转义；`node --check`/esbuild 查不出此类运行时断链（见 MEMORY.md）。
- **风险/注意**：跨天边界——预取与同步读用同一 `todoLocalDate()`「今天」，且预取在创建会话前 await 完成，不会读到昨天的旧计划；缓存降级为空串时不注入。
