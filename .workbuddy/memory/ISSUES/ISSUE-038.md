## [ISSUE-038] 定时任务新模型：任务管理页（先创建任务 → 分配给孩子）+ 执行结果查询

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
- **后续修复（2026-09-02 排查，编号原为 029 与英语模块冲突改 038）**：worker 触发源改为直读 scheduler_tasks+分配（不再依赖客户端推送 scheduler_config 时机，见 worker/scheduler.ts collectChildConfigs/resolveChildConfig）；runTaskAtPoint 按 point 拆 todo_gen/todo_stat 任务匹配（task_runs 正确挂 task_id/名称）；新增 scripts/seed-parent-config.mts（开发机把本地 auth/app_settings 播种服务端）。现象：任务到点未执行且无记录，根因=客户端配置推送滞后 + 服务端无该家长 apiKey（No API key）。
- **优先级**：已完成（2026-09-02 实施 + 冒烟全过）
- **记录时间**：2026-09-02
