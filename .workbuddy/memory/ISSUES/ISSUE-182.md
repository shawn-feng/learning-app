# ISSUE-182：自定义定时任务 v2——按「分配的 agent」用默认上下文+全量工具执行；可分配家长；失败通知；指令模板

- **类型**：架构变更 / 需求（自定义任务 v2，推翻 ISSUE-116 v1 的收窄白名单执行模型）
- **优先级**：高（v1 数据面过窄，家长写的指令大部分做不了——任务"执行不正常"的根因）
- **记录时间**：2026-10-13
- **来源**：用户对 v1 讨论的四条拍板（原话见下）

## 用户拍板（2026-10-13）

> 1. 为了确保任务正常执行，自定义任务分配给哪个 agent，执行任务时就用该 agent 的默认上下文，包括所有能执行的工具。
> 2、3 按照你的建议做（失败通知 + 指令模板）。
> 4. 自定义任务要分配给特定孩子，分配的孩子都是独立的会话。另外，定时任务也要能分配给家长。

逐条翻译：
1. **执行上下文 = 分配的 agent 的默认上下文 + 其全部可执行工具**——废除 v1 的收窄白名单 ephemeral 会话（v1 只有 kb 三件+掌握四件+天气+提醒，连错题本都读不到，ISSUE-116 讨论）；
2. **失败通知**：连续失败主动推给家长（家长不该靠翻执行结果页才知道任务挂了）；
3. **指令模板**：创建界面预置模板，降低家长写指令的门槛；
4. **分配模型**：孩子（每个分配的孩子**独立会话**，保持 v1 现状）+ **新增家长**（整任务只跑一轮，家长 agent 上下文）。

## v1 现状（被本 issue 推翻的部分）

`server/src/worker/custom-tasks.ts`：命中→占位 last_fired_at→每孩子一个 `createWorkerEphemeralSession` 无头会话，系统提示是任务执行器专用文案，工具白名单 = `kb_query/kb_insert/kb_update`（孩子库仅 daily/课程/主题进度/标签四类，**mistake_book/考核/积分都读不到**）+ `mastery_*` 四件 + `weather` + `create_reminders`；看门狗 5 分钟；执行摘要（≤300 字符）写 task_runs。触发判定/占位幂等/in-flight 锁/每孩子独立会话——这四件 **v2 保留不动**。

## 方案

| # | 改动 | 位置 | 说明 |
|---|---|---|---|
| F1 (P0) | **执行会话改用分配 agent 的默认上下文 + 全量工具**：<br>· 分配**孩子**的任务 → 每孩子一轮，用**孩子 agent 基底提示词**（[域 A]~[域 I] 场景规范全套）+ `CHILD_AGENT_TOOL_NAMES` 全量（kb 工具/child_mistake_log/create_html_lesson/child_exam_plan_create/display_content/get_date…）；<br>· 分配**家长**的任务 → 整任务一轮，用**家长 agent 基底提示词** + 家长全量工具（场景技能 load_skill、parent 内容/计划/报表工具、parent_build_material…） | `custom-tasks.ts`（executeCustomTask 的会话创建段）+ `tasks.ts`（createWorkerEphemeralSession 泛化） | 会话仍 in-memory 临时会话，**不进孩子/家长对话 UI**（v1 边界保持）。家长工具带**场景守卫**（未 load_skill 拒绝执行）——家长基底本身会先 load_skill，无需特殊处理，但要在任务系统提示里保留"先 load_skill 再动手"的提醒 |
| F2 (P0) | **分配模型加「家长」**：`scheduler_task_assignments` 增加目标维度（parent / child）；定时任务页分配时可选「家长」或多个孩子；**家长任务整任务只跑一轮**（无 per-child 展开），执行上下文=家长 agent | `db`（幂等迁移）+ 定时任务页 UI + `runCustomTasksTick`（家长任务单轮分支） | 触发判定/占位逻辑任务级不变；家长任务与 ISSUE-166 手动触发的 date/childId 语义对齐（parent 任务无 childId） |
| F3 (P1) | **看门狗按时长类任务放宽**：家长任务可能含编程 agent 长工具（parent_build_material 中位 321s、最长 654s，ISSUE-146/147）——家长任务上限提到 **11 分钟**（对齐 ISSUE-146 口径）；孩子任务保持 5 分钟 | `custom-tasks.ts` EXEC_TIMEOUT_MS 分支化 | 超时仍 abort + task_runs=error 不重试 |
| F4 (P1) | **失败通知**：按任务累计 task_runs 连续 `error` 次数，**连续 ≥2 次 → 给家长推一条通知**（摘要=最近一次错误信息；通道复用家长端既有可见面——家长中心通知/报表区，实施时定具体通道；无现成通道则建一条家长侧提醒）。恢复 ok 后计数清零 | `task-runs.ts` / 新增小模块 | 家长任务与孩子任务都适用 |
| F5 (P1) | **创建界面指令模板**：预置 ③~4 个模板一键预填 instruction——「天气+穿衣提醒」（weather+create_reminders）、「学习情况分析」（mastery_*）、「错题复习提醒」（孩子任务：child_mistake_log list → create_reminders）、「空白自定义」 | 定时任务页创建 UI | 模板只是预填文本，家长可改；模板清单随场景工具扩充 |
| F6 (P2) | 全量工具下的边界写进任务系统提示（在 agent 基底之上追加一小段任务约定）：完成 outcomes 落文件/展示的语义（display_content 无在线页面时落 display_contents 表，孩子下次打开可见——**合理语义，写明**）；执行摘要仍取末轮文本 ≤300 字符；积分/完成态只读铁律不因任务态放松 | 任务系统提示拼接段 | 防止"任务态"被当成绕过铁律的口子 |

## 验收场景

1. 孩子任务「错题复习提醒」：无头会话用孩子基底+全量工具 → `child_mistake_log(list)` 读到 open 错题 → `create_reminders` 给该孩子建提醒 → 摘要写 task_runs；
2. 家长任务「每天整理上周考核」：整任务一轮、家长 agent 上下文（可 load_skill 用考核/报表场景工具）→ 产出报表/操作成功；
3. 同任务分配 2 个孩子 → 两个独立会话各跑一轮、互不可见（v1 行为保持）；
4. 连续失败 2 次 → 家长收到通知；恢复后不再推；
5. 家长任务跑 parent_build_material 类长工具 → 11 分钟内不被看门狗误杀；
6. 触发幂等/占位/补跑行为与 v1 一致（回归 ISSUE-116 既有测试）。

## 实施记录（2026-10-15，F1~F6 全落地，client 0.1.29 / server 0.5.33 未部署）

**用户边界强调（实施前拍板）**：只有 `type='custom'`（`runCustomTasksTick → executeCustomTask` 链）换 agent 默认上下文；recording/todo/autoNewSession/mistake_sorting/reminder 等确定流程任务**原样不动**。共享代码唯一触碰 = `createWorkerEphemeralSession` 加可选 `opts.cwd`（缺省=家长 kb 目录，既有调用零变化）。mastery_analysis 本质是 custom 任务，随 v2 走新路径（mastery_* 四件保留）。

### 落点清单

| 项 | 改动 |
|---|---|
| 装配真源（F1 防漂移关键） | `session-registry.ts` 抽导出 `buildChildAgentToolset(deps, pid, cid, {includePageTools})`（kb/fs/display/parent_content/三组 plan/报表/child_db/kb_lookup/get_date/summarize_conversation，page_* 按 flag），`ensureEntry` 改调用（行为不变）；`parent-registry.ts` 抽导出 `buildParentAgentToolset(deps, pid, {streamKey,getMessages})` → `{toolNames,customTools,skillState,workspace,scratch,agentDir}`（全量家长工具过 compactParentTools 场景守卫），`ensureEntry` 改调用 |
| 执行分支（F1/F6） | `executeCustomTask` 签名 `childId` → `target: {kind:"child",childId} \| {kind:"parent"}`。孩子分支：buildServerChildPrompt（agentRules=getAgentPrompt + dbTablesBlock=buildChildSelfBlock，与交互会话同参）+ CHILD_TASK_ADDENDUM；工具=孩子全量（includePageTools:false）+ 任务特供三件（weather/reminders/mastery，孩子正式会话没有）；白名单=两者并集；cwd=孩子工作区。家长分支：buildServerParentPrompt+PARENT_TASK_ADDENDUM+家长全量；cwd=scratch；**dynamic import session-registry/parent-registry**（它们静态引 worker/scheduler，而 scheduler 静态引本文件，静态 import 成环——与 tasks.ts resetSession 同法） |
| 数据模型（F2） | `db.ts` 幂等补列：`scheduler_task_assignments.target_type`、`task_runs.target_type`（NOT NULL DEFAULT 'child'）+ 新表 `scheduler_alerts`；家长分配行=(task_id, 家长id, 'parent')，主键不变；家长 run 的 child_id 列存**家长 id**（ctx.childId 才是 "parent" 哨兵）。过滤补齐：findTaskForRun / buildEffectiveChildConfig / listChildReminders / takeDueReminders 全加 `target_type='child'`；listTasksWithAssignments/listTaskRuns/recordTaskRun 透传 targetType |
| tick（F2） | `runCustomTasksTick`：分配查询带 target_type，家长行整任务一轮（in-flight key `${taskId}:parent`），孩子行照旧逐个；占位/幂等不动 |
| 看门狗（F3） | `execTimeoutMs(target)`：孩子 5min / 家长 11min（ISSUE-146 长工具口径）；超时仍 abort+error 不重试 |
| 失败通知（F4） | 新 `worker/task-alerts.ts`：`notifyCustomTaskFailure`（最近两条 task_runs 都 error 才推；同串去重=已有 alert 晚于最近一次非 error run；恢复 ok/skip 自然清零）+ `scheduler_alerts` 表滚动保留 50 条/家长 + SSE `agentStreamHub.publish("<pid>:parent","display_content",{source:"scheduler_alert"})`（复用 ISSUE-108 家长流桥）+ publish 可注入（测试桩）。挂点=executeCustomTask 的 recordTaskRun 之后（inject 路径也走）。新路由 GET /api/v1/scheduler/alerts。客户端：Dashboard SSE 分支→定时任务入口红点（仿报表模式），SchedulerTasksPanel 页顶提醒条+load 拉取 |
| 模板（F5） | 新 `worker/custom-task-templates.ts`：WEATHER_REMINDER_TEMPLATE（天气穿衣 07:30，weather_query→create_reminders once）+ MISTAKE_REVIEW_TEMPLATE（错题复习 19:00，child_mistake_log list→有错题才 create_reminders）；GET /task-templates 返回三张卡；POST /tasks 模板分支泛化——mastery 幂等特例保留，新 key=普通 custom 插入（覆盖值回退模板默认，不自动分配） |
| 客户端 | `preload.ts`/`ipc-handlers.ts`：schedulerTaskAssign 改 `(id, enabled, opts?: {childId?, target?:"parent"})`（破坏性签名，渲染层已同步）+ schedulerAlertsList + schedulerTaskUpdate 补 instruction 类型；web shim 同步。`SchedulerTasksPanel.tsx`：分配弹窗顶部「👨 家长（本人）」勾选（仅 custom）、任务卡家长 chip、执行表「执行对象」列（parent 显示家长）、失败提醒条；`Dashboard.tsx`：scheduler_alert 红点+进页清除 |

### 测试与验证

- 新增 `test/issue182-custom-tasks-v2.test.ts` 12 例：迁移（新旧库）、execTimeoutMs 分支、tick 家长单轮/家长+2孩子三轮/占位、家长 prompt 与 task_runs.target_type、失败通知（首错不推→二连推→同串不重推→恢复清零→新串再推）、effective-config 不吃家长行、targetType 透传与按孩子过滤、assign 路由（custom 可家长/recording 400/取消分配）、模板清单与 weather 模板创建覆盖、alerts 路由。
- `test/issue116-custom-tasks.test.ts` 两处调用改 target 签名（守语义不变）；`test/issue135-scheduler-task-template.test.ts` 模板清单断言更新（1→3 张卡）。
- 结果：改动面 7 文件 64/64 绿；全量套件 9 文件失败均为**环境性既有**（delivery/parent-library 需本地服务端 8788、kb-sqlite/learning-summary 需真实数据、open-voice 真网、issue144 scenesOfTool 断言滞后于 HEAD、web-shim 缺 181 的 auth 三方法）——与本次改动无关，零新增回归。
- `npx tsc --noEmit`：server 仅存量的 6 个基线错误（token-usage/models/topic-package）；客户端 electron-vite build ✓、server npm run build ✓（0.5.33）。

### 待办（部署后）

- server 0.5.33 部署 201 + 客户端 0.1.29 重打包后，按验收场景 1~6 实测（重点：错题复习提醒模板端到端、家长任务 load_skill 报表、连续失败通知红点）。

### 补记（2026-10-16，0.5.34 已部署 201）：自动化场景口径 v2 + 工具支持 target=parent

**实测反馈**：用户要家长 agent 建任务「每天早上7点，对当天学习计划里的课程创建考核计划（新学考全部知识点、复习考掌握不好的知识点）」→ agent 回复**创建不了**。

**根因**：v2 只换执行器、没同步**模型的认知口径**——`skills/parent/automation.ts` 正文仍写 v1 白名单「执行会话能做的：查天气、建提醒、读写 daily；**不能碰：积分、考核、学习计划**」，模型读完按"做不到"拒答。
关键机制：工具描述那处旧口径（parent-plans.ts 的「能力边界」段）经 compactParentTools **下沉剥掉后模型根本看不到**——**技能正文才是口径真源**（修哪里：只修技能也够，工具描述同步修避免误导后来人）。

**修复（server 0.5.35；首布误用 0.5.34 号——已被并行会话的 ISSUE-183 占用，改号重发）**：
1. automation 技能「能力白名单」整段重写为 v2「执行能力」：分配孩子=孩子 agent 全量工具（每孩子独立一轮）；分配家长（target="parent"）=家长 agent 全量工具（整任务一轮，按需 load_skill）；**考核/计划类自动化默认分配给家长**（家长建=必考计入完成率、孩子自建=加分项）；仍做不到的收敛为「加/扣积分、改完成态」（本无工具）+「指令必须自包含（执行时无人在线，不能写待确认问句）」+ 考核类指令依赖课程已挂知识点与题库题（没挂到点会失败且不重试）。triggers/示例补上考核场景原话。
2. `parent_scheduler_task_create` 加 `target?: "parent"`（与 childName **二选一**，两者并用/都不给/非法值均报错）；target=parent → 分配行 child_id=家长 id + target_type='parent'，直通 0.5.33 已部署的 F2 执行分支（家长 agent 上下文整任务一轮）。描述同步重写。

**测试**：issue182 +2 例（target=parent 落库断言 / 二选一与非法值校验不落行）；issue144-parent-skills automation 关键词断言 +5（`target="parent"`/全量工具/必考/加分项/二选一）；顺带修过期断言 issue144-parent-report-tools（mastery_report 自 ISSUE-135 P5 起为 progress+plan 多场景）。77+41 全绿。

**部署**：0.5.35（08:29）——version/health/journal/bundle md5 全过，转义感知标记校验（新口径 FOUND、旧「不能碰积分」MISSING）；**超集校验**：ISSUE-183 三标记 + ISSUE-182 F4 标记均 KEPT（构建自含并行会话已提交源码，无回退）。⚠️ 两条教训：①esbuild 把非 ASCII 转义为**大写** `\uXXXX`，中文 marker grep 必 0 命中（详见 DEPLOYMENT.md 0.5.35 段）；②**bump 前先看 git log 最新部署记录**，避免与并行会话撞版本号（本修复首布撞上 ISSUE-183 的 0.5.34）。

**遗留**：客户端 0.1.29 未打包（本修复纯服务端，不需要客户端重打包；用户可直接在 app 里重试建任务）。

### 补记 2（2026-10-16，0.5.36 已部署 201）：automation 口径定稿「只讲创建」

用户定稿：*「这个口径只要按照家长要求创建定时任务就行了，并不是执行定时任务。口径里写了太多关于如何执行定时任务的事情。应该只描述如何创建目前已经有的几种定时任务。」*

- 重写 automation 技能正文为**只讲创建**：新增「目前已有的几种任务」表（提醒类 / 天气与穿衣 / 错题复习 / 学习情况分析 / 考核计划类 / 其他——每行 = 指令要点 + 分配对象），保留参数速查、重复规则（REPEAT_RULES_BLOCK 同源）、复述确认与失败语义；**删除全部执行侧描述**（执行器工具面 / load_skill 机制 / 0.5.35 加的「执行能力」段——那类内容会被模型当成创建门槛而拒答）。
- 工具描述（parent_scheduler_task_create）同步去执行侧内容。
- 测试：issue144-parent-skills 关键词断言更新 + **反向守卫**（「全量工具 / 不能碰 / load_skill」不得回流技能正文）；77/77 绿。
- 部署 0.5.36：version/health/journal/转义感知标记（创建口径 FOUND、执行细节与旧口径 MISSING）/ISSUE-183 超集 KEPT 全过。
- **口径真源原则（两条修复的共同教训）**：模型看到的 parents skill 正文 = 家长 agent 的唯一口径真源（工具描述经 compactParentTools 下沉后不可见）；口径要写"创建/使用"侧的事，执行侧机制（工具面、守卫、看门狗）属于执行器实现，写进创建口径只会变成拒答理由。
