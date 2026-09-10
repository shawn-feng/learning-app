## [ISSUE-047] 孩子端：让 agent 直接制定「定时任务」（到点语音提醒 + 频率设置）

- **类型**：需求 / 功能扩展（扩展 ISSUE-038 定时任务新模型，能力开放到孩子 agent + 新增语音提醒/频率）
- **描述**：
  1. **孩子端可让 agent 创建定时任务**：孩子对话中说"半小时后提醒我喝水""每天晚上 9 点提醒我读英语""每周六上午提醒我练字"等，孩子 agent 应能**直接创建一条定时任务**（无需家长经设置页操作），到点执行。
  2. **到点语音提醒**：这类任务到点时，用**语音**对孩子播报提醒内容（"该喝水啦""该读英语啦"），即提醒以语音形式呈现（类似 ISSUE-019 的「上课/下课」语音播报，但由孩子/agent 自定义内容）。
  3. **可设置频率**：任务支持频率配置——单次（once）、每天（daily）、每周某天（weekly）、每隔 N（interval）等；不只是当前"每天固定时间点跑一次"的单一模式。
- **影响范围**：①孩子 agent 工具集（需新增"创建/查询/取消定时任务"工具）；②服务端定时任务模型（`server/src/routes/scheduler.ts` 任务结构 + `server/src/worker/scheduler.ts` 执行调度）需支持「孩子自建任务」归属与「频率」字段；③客户端提醒播报链路（复用/扩展 `class:reminder` 语音事件）。
- **现状 / 排查入口**：
  - **现有定时任务模型（家长侧，ISSUE-038）**：
    - 服务端：`server/src/routes/scheduler.ts` —— `POST /api/v1/scheduler/tasks`（创建，先建）、`GET`（列表含分配+最近执行结果）、`PATCH/DELETE /:id`、`POST /:id/assign`（分配给孩子、enabled=false 取消分配）。任务结构含 `name/type/time/extra`；执行由 `server/src/worker/scheduler.ts` 的 `runTaskAtPoint`（按 `task.type` + `point(time)` 每天跑一次，**无频率概念**）。
    - 客户端 IPC：`electron/lib/ipc-handlers.ts:658-` `scheduler:tasks:list` / `scheduler:task:create` / `:update` / `:delete` / `:assign` → 调服务端。家长在「任务管理页」创建再分配给孩子。
  - **现有语音提醒链路（家长侧，ISSUE-019）**：`electron/lib/scheduler.ts:396` `w.webContents.send("class:reminder", { childId, type, label, mode })` → 渲染侧（preload.ts:38 `class:reminder` 监听）语音播报上课/下课。`mode` 已含提醒模式概念，可复用为"自定义语音提醒"载体。
  - **孩子 agent 工具（无建任务能力）**：`electron/lib/pi-session.ts:476` 孩子 agent 工具列表（read/write/edit/ls/display_content/get_date/get_progress/kb_query/kb_insert/kb_update/create_html_lesson/parent_content/summarize_conversation/page_action/page_inspect/todo_list）——**没有"创建定时任务"工具**，agent 无法在对话里落一条定时任务，本 issue 需新增（如 `schedule_task`，支持 create/list/cancel + frequency + reminderText）。
- **改造方向（建议）**：
  1. **新增孩子 agent 工具 `schedule_task`**（或扩展）：参数含 `action(create/list/cancel)`、`text`(提醒内容)、`time`(HH:MM 或 ISO)、`frequency`(once/daily/weekly/interval)、`intervalMinutes?`、`weekday?`、`voice`(默认 true 语音)。落库到该孩子的任务（owner=child，区别于家长 owner=parent），并复用 `scheduler:task:create` 链路（需服务端允许 child 归属任务，或在 `extra` 标 `owner:"child"`）。
  2. **服务端任务模型扩展**：`routes/scheduler.ts` 任务结构加 `frequency`/`voice`/`owner` 字段；`worker/scheduler.ts` 执行调度按 `frequency` 判定是否到点（daily/weekly/interval/once），到点且 `voice` 的任务通过"提醒事件"下发（沿用 `class:reminder` 事件或新增 `child:reminder`），由客户端语音播报 `text`。
  3. **客户端播报**：扩展 `class:reminder` 事件（或新增监听）支持自定义 `text` 语音播报（现 `class:reminder` 的 label 已是文本，主要把"上课/下课"替换为任务 `text` 即可语音读出）；需保证 app 在前台/通知中心能播（参考 ISSUE-019 的铃声+语音播报）。
  4. **边界**：孩子自建任务**是否需家长审核/可见**？建议家长端「任务管理页」也能看到孩子自建任务（只读或可调），避免孩子被 agent 误建一堆任务；取消/修改走 `schedule_task` 工具或家长页。
- **优先级**：✅ 已完成（2026-09-06，代码核实落地）：`electron/lib/custom-tools.ts:1339` 新增 `scheduleTaskTool`（name=`schedule_task`，action=create/list/cancel，frequency 支持 once/daily/weekly/interval，voice 默认 true，payload `owner:"child"` → POST `/scheduler/reminders`）；`electron/lib/pi-session.ts:55-56` LEARNING_NAV_INSTRUCTIONS 加「定时提醒（schedule_task，ISSUE-047）」段，`:612-613` 孩子 agent 双数组（tools 白名单 + customTools）均已注册 `schedule_task`/scheduleTaskTool；到点播报复用 ISSUE-019 的 `class:reminder` 语音链路（自定义 text）。三处设计疑点（归属/家长可见/频率模型）已按 issue 述默认落定（child 归属、家长端任务页可看、频率模型齐全）。未提交、未部署（与 049/050/052/053/055 同在工作树，提交时分开）。
- **记录时间**：2026-09-04
- **✅ 已实现（2026-09-04，v1）**：
  - **设计定案**：家长只读可见（孩子说建即生效，家长任务管理页可见/可关闭删除，不经审核）；全频率 once/daily/weekly/interval；孩子「我的提醒」独立弹框（不放今日计划）。
  - **服务端**：`db.ts` scheduler_tasks 扩列（owner/frequency/reminder_text/weekday/interval_minutes/voice/fire_at/last_fired_at/expired，含旧库 ALTER 迁移）；`task-runs.ts` type 加 `reminder` + `createReminderTask/listChildReminders/listFamilyReminders/takeDueReminders`（到期判定按频率：daily/weekly 按本地日期去重、interval 从创建时刻起算 `last_fired_at`、once 触发即置 expired）；`routes/scheduler.ts` 加 `POST/GET /reminders` + `GET /reminders/list`，通用 POST 拒 `type=reminder`，`TaskWithAssignments` 下发 owner。
  - **Electron 客户端**：`ipc-handlers.ts` 加 `scheduler:reminder:create/list/due`；`scheduler.ts` 每分钟 tick 调 `/reminders` 拉到期项 → `broadcastCustomReminder(type="custom")` 复用 class:reminder；`preload.ts`/`Learn.tsx` type 加 `"custom"` 播报文案与横幅。
  - **孩子 agent**：`custom-tools.ts` 加 `scheduleTaskTool`（create/list/cancel，owner=child）；`pi-session.ts` 注册 + tools 白名单 + 行为规范加「定时提醒」段。
  - **家长面板**：`SchedulerTasksPanel.tsx` 类型加 `reminder`+`owner`，TYPE_META 加「孩子自建提醒」卡片；新建下拉过滤 reminder（家长建提醒走对话/专用口）。
  - **孩子端 UI（方案A，跟进追加 10:0x）**：新增 `src/components/MyRemindersModal.tsx`（🔔「我的提醒」弹框，独立于今日计划——提醒≠"要做的事"，不放 Todolist）；侧栏加 Bell 图标入口（Learn.tsx）；preload 加 `reminderList`/`reminderCancel`（复用 scheduler:reminder:list / task:delete）。列该孩子 reminder 类任务，按 once 优先/时间排序、已过期/已停用分组置灰，可逐条取消。electron-vite build 过。
  - **验证**：server tsc 0 错、esbuild 构建过、electron-vite build 过；冒烟测试 `scripts/smoke-reminder.ts` 14/14（daily 当日去重、weekly 仅当天、interval 首隔后触发且间隔内不重复、once 触发即 expired、voice=false、disabled 不触发）。⚠️ 测试曾误报 interval 立即触发，实为跨 case 共享 DB 串扰，非实现缺陷。
  - **部署注意**：server.cjs 需重新构建后同步到 201（`node scripts/build.mjs`）；本改动不影响 `learning-cloud`。
  - **边界/后续**：家长通过对话建提醒（owner=parent）尚未做独立工具，可用 `schedule_task`(child) 或待续；提醒横幅沿用 ISSUE-019「点击关闭」不自动消失。
- **备注**：ISSUE-019 提醒循环 15s 重复、本提醒也复用该横幅，属既有产品形态。
