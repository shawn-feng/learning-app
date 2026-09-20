# ISSUE-116：定时任务新增「自定义任务」——自然语言指令到点让 agent 执行（✅ 已实施 2026-09-19；例：每天 6 点查天气 → 建 7 天天气播报提醒）

- **类型**：需求 / 设计（定时任务能力扩展；待拍板后实施）
- **需求描述**：定时任务里增加一种**自定义任务**：家长用**自然语言**描述要 agent 周期性完成的操作，到点由服务端无头执行。例：「每天早上 6 点查一下当天的天气，然后写入定时提醒任务，设置 7 天提醒」——即每天 6:00 agent 查天气，并创建未来 7 天每天 7:00 的天气语音提醒。
- **现状 / 已查证**：
  - **任务模型**：`scheduler_tasks`（主库 `db.ts:142-162`）——`type`（recording | auto_new_session | reminder）、`frequency`（once/daily/weekly/interval）+ time/weekday/interval_minutes/fire_at、`reminder_text`（仅 reminder 用）、owner（parent/child）、assignments 分配孩子。**加 type='custom' + `instruction` 列即可复用全部调度基建**。
  - **执行机制**：服务端无头 worker（`worker/scheduler.ts`，每 2 分钟 tick 跑 plan/stat/recording）；无头 agent 轮有成熟先例（ISSUE-028：summarize_conversation 异步整轮、提交即返回、挂死看门狗 `session-registry.ts:495-510`）。
  - **提醒链路**：agent 建 reminder 任务（ISSUE-047）→ 客户端每分钟轮询 `GET /scheduler/reminders` 到期提醒 → 本地语音播报（`electron/lib/scheduler.ts:493-513`，服务端就地去重幂等）——**自定义任务的产物（提醒）天然有播报出口**。
  - **能力缺口**：现有 agent 工具**没有天气/ web 查询**类工具——示例里的「查天气」跑不通，需配套一个查询工具。
- **方案（建议）**：
  ① **加类型**：`scheduler_tasks.type` 增 `'custom'` + 新列 `instruction TEXT`（自然语言指令）；owner 仅限 `parent`（孩子 agent 不给建 custom——执行权限大，防失控）；frequency/time 全复用；**执行幂等沿用 `last_fired_at` 现成机制**（当天跑过不重跑）。
  ② **执行主体（独立会话 slot）**：worker tick 到点 → 向该孩子的 agent 发**独立会话轮**（slot 如 `task:<taskId>`，**不污染 main/course 会话**，无历史累积）→ agent 拿着 instruction 执行（可调用工具）→ 结束把执行摘要写 `task_runs`（status ok/skip/error + message）——复用 ISSUE-028 无头整轮 + 看门狗范式，**异步执行不阻塞 tick**。
  ③ **工具面（首批配套）**：**新增天气查询工具**（服务端接天气 API，如和风/高摩免费档，key 走现有模型/服务配置通道）——否则需求示例无法成立；其余用孩子 agent 现有工具（创建提醒 ISSUE-047、写 daily_entries 等）。**建议 custom 会话用工具白名单子集**（天气 + reminder 创建 + daily 写 + 只读类），不含积分/考核/计划写等高危工具（待拍板）。
  ④ **示例流程走查**：任务（custom，daily 06:00，instruction=「查今天的天气，创建提醒任务：未来 7 天每天 07:00 播报当天天气」）→ 6:00 tick → 无头轮 → agent 调天气工具取今日天气 → 调 reminder 创建工具**一次性建 7 条** daily 07:00 提醒（text=各自日期的天气）→ task_runs=ok。指令模板里应引导「一次性建 N 条」而非「每天再建」（防提醒任务无限累积）；连续多天运行时 agent 会重复建——**需防重**：白名单 reminder 创建时带 source 标记（instruction 生成），或任务说明要求先查已有提醒（最简：提醒创建工具对「同 text+同 time」去重）。
  ⑤ **入口**：任务管理页（`SchedulerTasksPanel`）加「自定义任务」类型（名称+频率+时间+指令文本框+分配孩子）；家长 agent 工具扩展（对齐 ISSUE-047 孩子 reminder 工具范式，`parent_scheduler_task_create` 支持 type=custom+instruction）。
- **待拍板**：① custom 会话工具白名单范围（建议首批：天气+reminder 创建+daily 写+只读）；② 天气 API 选型与 key 管理；③ 执行超时上限（建议 3~5 分钟，看门狗先例）；④ 提醒防重策略（text+time 去重 vs source 标记）。
- **边界**：自定义任务执行的 agent 轮不进孩子/家长对话 UI（独立 slot，产物可见、过程不可见）；孩子端不建 custom 任务；执行失败写 task_runs=error 不重试当天（次日正常）；LLM 成本=每任务每次执行一轮（低频可接受）。
- **实施拆步**：P1 type+instruction+迁移 + worker 无头执行（独立 slot）+ task_runs 记录；P2 天气工具 + 提醒防重；P3 任务管理页 + 家长 agent 工具入口。
- **回归**：现有 recording/reminder/auto_new_session 任务零影响（type 枚举扩展）；提醒轮询/播报链路不变（产物仍是 reminder 任务）；孩子 agent 工具集不变（custom 白名单是独立会话的工具子集）；task_runs 查询页兼容新类型。
- **优先级**：中（自动化想象空间大、示例场景明确；依赖一个天气工具的最小新增）
- **记录时间**：2026-09-19

---

## ✅ 实施记录（2026-09-19）

- **P1 字段与调度**：
  - `scheduler_tasks` 加 `instruction TEXT`（db.ts：建表自带 + 老库幂等补列，沿 channel 先例）；type 增 `'custom'`（task-runs.ts 类型与面板类型列表同步）。
  - 新模块 `worker/custom-tasks.ts`：`runCustomTasksTick` 挂进 worker cron（每 2 分钟）+ 启动补跑。**触发判定沿 `last_fired_at` 幂等**：daily/weekly=「今天(且周几)已过目标时刻且今天未跑过」；once=fire_at 到点且未 expired（触发即置 expired）；interval=距上次 ≥ N 分钟。**daily/weekly 不走 5 分钟桶**——到点后任意 tick（含停机恢复）当日首次命中即跑一次；执行失败不重试当天（占位已推进，次日正常）。
  - **执行异步不阻塞 tick**（issue 定稿）：触发即占位（claimFire）→ 每个分配孩子一轮**独立无头 ephemeral 会话**（复用 `createWorkerEphemeralSession`，in-memory 不落盘、不进对话 UI）→ in-flight 内存锁防重叠 tick 并发 → **看门狗 5 分钟**超时 abort → agent 末轮文本作执行摘要写 `task_runs`（ok/skip/error）。
- **P2 工具面（新模块 `worker/custom-task-tools.ts`，白名单待拍板①落地）**：
  - 白名单 = `get_date/kb_query/kb_insert/kb_update`（复用 worker kb 工具）+ `weather_query` + `create_reminders`；不含积分/考核/计划写等高危能力。
  - **weather_query（待拍板②落地）**：默认 **Open-Meteo**（免费免 key：中文地理编码 + 7 天预报 + 降水概率，零配置可用）；默认城市走 settings `<parentId>:weather` JSON {location}（缺省「北京」）；查询失败如实返回不编造（后续可扩展和风等 provider）。
  - **create_reminders（待拍板④落地）**：批量建 reminder 任务（复用 ISSUE-047 `createReminderTask`，到点语音播报天然兼容）。防重 = **source 标记**（extra_json.source_task）+ 滚动替换（replace 默认 true：先停用本源未播报旧提醒，新批接管）+ (text+time+frequency) 精确去重。**频率选型引导**（实施中发现的关键语义）：「未来 N 天各播一次」必须建 N 条 **once**（各自 fireAt）——若建 daily 会每天全量重复播，系统提示与工具描述均已明示。
- **待拍板③落地**：执行超时上限 5 分钟。
- **P3 入口**：
  - 任务管理面板 `SchedulerTasksPanel`：类型加「🤖 自定义任务」（指令 textarea + 卡片指令摘要展示）；创建/启停/分配/删除全走既有接口（POST/PATCH /scheduler/tasks 收 `instruction`，custom 必带指令；owner 恒 parent）。
  - 家长 agent 工具 `parent_scheduler_task_create`（parent-plans.ts）：childName+name+instruction+time+frequency/weekday/intervalMinutes/fireAt，prompt 写明能力边界与「未来 N 天一次性批量创建」。
- **边界落实**：custom 会话产物（提醒）可见、过程不可见（无 SSE）；孩子不能建 custom（工具只在家长侧 + owner 校验）；task_runs 查询页天然兼容（新 type 行原样呈现）。
- **验证**：新增 `test/issue116-custom-tasks.test.ts` 13 用例（迁移×2、触发判定×5、提醒防重/播报兼容×3、执行链路×3：成功摘要/失败不抛错/触发占位+异步落库+未到点与未分配不触发），连同 ISSUE-112/115、exam、kb-domain-split、plan-scope、scheduler-task-state 共 **54 测试全过**；server tsc 零错误；`electron-vite build` 通过。
- **遗留（可选后续）**：天气 provider 扩展（和风/高德 + key 设置项）按需再加；面板可补 custom 任务的「立即执行一次」按钮。
