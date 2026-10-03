# ISSUE-166：定时任务手动触发——可选日期执行 + 日期已有执行记录时提示「是否覆盖之前的执行结果」

- **类型**：需求 / 设计（定时任务管理增强；对齐 ISSUE-116 custom 任务与 task_runs 记录体系）
- **需求描述（用户）**：定时任务里增加**手动触发**：触发时可**设定日期**；执行前**检测该日期的执行记录**——如果该日期已有执行记录，**提醒是否覆盖之前的执行结果**，确认后才执行（覆盖）。
- **现状（已核实代码）**：
  - **触发全靠 worker tick**：任务到点由服务端 2 分钟 tick 驱动（worker/scheduler.ts，custom 任务沿 `last_fired_at` 幂等占位语义，custom-tasks.ts:5-8——触发即推进、失败不重试）；**没有任何手动触发入口**（SchedulerTasksPanel 无此操作，routes/scheduler.ts 只有 CRUD）；
  - **执行记录**：`task_runs` 表（id/parent_id/child_id/task_id/task_name/task_type/**date**/point/status/message/started_at/finished_at），`recordTaskRun` 写入、`listTaskRuns` 查询（db/task-runs.ts:59/253）——**按 (task, date) 查已有记录现成**；task_runs **无唯一约束**（重复执行=多行并存），「覆盖」需要定义语义（建议：覆盖=重跑并把该 (task_id, child_id, date, task) 的旧行**标记 superseded 或删除**，而非物理覆盖单行）；
  - **各任务类型的执行语义不同**：custom（无头 agent 轮，写 task_runs）/recording（日汇总，写 daily_entries——**重复执行要幂等**，ISSUE-099/025 有去重先例）/reminder（纯客户端轮询播报，无服务端执行体）——手动触发对不同类型的含义与副作用不一样，方案里必须分别定义。
- **方案（建议）**：
  ① **手动触发 API**：`POST /api/v1/scheduler/tasks/:id/trigger`，body：`{ childId?, date }`（date 缺省=今天；childId 缺省=该任务所有分配孩子，明确传则单孩子）；鉴权 assertChildOwned；**仅支持 custom / recording 两类**（reminder 是客户端播报语义，无服务端执行体，不支持——UI 置灰并说明）；
  ② **触发前检测 + 覆盖确认**（两段式，前端编排）：先 `GET /api/v1/scheduler/tasks/:id/runs?date=`（现有 listTaskRuns 过滤）——有记录则前端弹确认框：「该日期已有执行记录（N 条，状态/时间…），是否覆盖？覆盖将重跑并使旧记录失效」；确认后带 `overwrite: true` 再调 trigger；
  ③ **覆盖语义**：重跑前把该 (task_id, *, date) 旧 task_runs 行 status 置 `superseded`（新状态枚举 ok/skip/error/**superseded**，查询页灰显/可筛）；**业务副作用需按类型回滚或幂等**：custom 的 daily_entries 类产物靠既有去重（同 date+block+title 冲突报错 → 提示先清理或用覆盖标记跳过）；recording 重跑依赖 summarize 幂等（ISSUE-025 同日去重已具备）；**积分/结算（stat 类）不进手动触发**（日终结算一次性语义，ISSUE-112 先例——覆盖会破坏流水幂等）；
  ④ **custom 的 last_fired_at 联动**：手动触发指定 date=过去某天时，不推进 last_fired_at 的「今天已跑」占位（否则次日自动触发被跳过）；date=今天才推进占位——手动触发与自动调度的幂等状态要分开记账（建议 task_runs 加 `triggered_by('auto'|'manual')` 列，一列两用）；
  ⑤ **UI**：SchedulerTasksPanel 每行加「手动触发」按钮 → 弹框（日期选择器 + 分配孩子勾选 + 该日期已有记录的列表预览 + 覆盖确认勾选）→ 执行后刷新 task_runs 列表；家长 agent 对称加工具（可选，二期）。
- **回归**：自动调度行为零变化（last_fired_at 占位语义只在手动+今天日期时推进）；task_runs 历史查询兼容新状态 superseded；recording/custom 重跑幂等验证（同日两次不产生双份 daily_entries/播报）；无覆盖确认时不产生副作用。
- **优先级**：中（运维补录/重跑的真实需求——设备停机漏跑、汇总失败的补救动作；改动集中在 trigger API + 前端弹框）
- **记录时间**：2026-09-27
