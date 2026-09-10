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
