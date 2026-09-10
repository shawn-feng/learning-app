## [ISSUE-053] 定时任务·课程时间段：当天设置当天触发，过一天就丢失需重设
- **类型**：Bug（配置持久化/同步被浅合并覆盖，classTimes 字段丢失）
- **状态**：✅ 已修复（config-sync 深合并；详见本条目底部「修复落地」）
- **现象**：家长在「设置 → 定时任务 → ⏰ 课程时间段（上课/下课提醒）」里给孩子配好上课/下课时间，设置当天提醒正常触发（孩子端顶部横幅+铃声/语音）；但**第二天课程时间段就没了**，重新打开设置页字段为空，必须再设一次。
- **已定位的链路与根因（读代码确认）**：
  - 课程时间段存 `classTimes: ClassTime[]`（`{start,end,label?}`）于 `scheduler-config.json`（按 parent 存，`parents/<id>/scheduler-config.json`），见 `electron/lib/scheduler.ts:47-63` 模型 + `:202-286` `getChildSchedulerConfig`/`setChildSchedulerConfig`。
  - **触发逻辑不是元凶**：cron 每分钟 `getChildSchedulerConfig(child.childId)` **实时重读文件**（`electron/lib/scheduler.ts:460`），`classTimes` 只要还在文件里就每天触发（`class-reminder` lastKey 含日期、跨天自动失效只是防重，不丢配置）。所以"过一天没了"=配置从文件被清掉，不是触发逻辑退化。
  - **本地保存均保留 classTimes**：
    - `src/components/SchedulerSettings.tsx:102` `save(childId)` 发整份 `cfg`（含 classTimes）→ `scheduler:config:set` → `setChildSchedulerConfig`（落盘+pushConfig）。
    - `src/components/SchedulerTasksPanel.tsx:109-129` `pushEffectiveConfig`（定时任务页 mount 时跑）`merged = {...base, recording, todo, autoNewSession}`，`base` 来自 `schedulerConfigGet`（含 classTimes）故 `...base` 保留 classTimes（**注释 line 85「保留 classTimes/archiveLimit」即指此处**：说明旧版 `pushEffectiveConfig` 曾掉过 classTimes）。
  - **最强嫌疑 = SPLIT 配置同步的浅合并覆盖**（`electron/lib/config-sync.ts`）：
    - `syncOnce`（:126-150）每 2 分钟 + 登录时 force 拉全量，对每个 config key 调 `mergeJsonFile`（:106-117）。
    - `mergeJsonFile` 是**顶层 `{...local, ...incoming}` 浅合并**：对 `scheduler-config.json`，`merged.children = incoming.children`（整体替换为服务端快照）。
    - **若服务端 `scheduler_config` 快照的 `children[childId]` 不含 `classTimes`**（被新 `scheduler:task:*` 模型的有效配置写回时遗漏、或某次 push 只带 recording/todo/autoNewSession 未带 classTimes），则下次 2 分钟轮询/登录拉取会把本地已存的 `classTimes` 整体覆盖空 → 第二天消失。
    - 服务端有效配置本就不含 classTimes（`server/src/db/task-runs.ts:6` 明文「客户端据此合并 classTimes/archiveLimit 推回」），而服务端 `/config` 真源快照若由有效配置派生则会缺 classTimes → 回拉即清本地。
- **排查/确认步骤**：
  1. 复现后立刻看 `data/parents/<id>/scheduler-config.json` 的 `children[childId].classTimes` 是否空 —— 空即坐实「被写空」。
  2. 看 `data/cache/config-revision.json` 与控制台 `[config-sync]` 日志，确认 `scheduler_config` 最近一次 merge 前后 children 是否丢了 classTimes。
  3. 比对登录时 `syncOnce(true)` 拉到的服务端 `scheduler_config.children[childId]` 是否含 classTimes。
  4. 确认当前部署客户端构建的 `pushEffectiveConfig` 是否仍是「`...base` 保留 classTimes」版（旧版会直接丢）。
- **修改入口**：
  - **主修（深合并 children，避免回拉覆盖丢字段）**：`electron/lib/config-sync.ts:106` `mergeJsonFile` 对 `scheduler_config` 改为**按 childId 深合并**——`merged.children[childId] = {...local.children[childId], ...incoming.children[childId]}`（字段级合并，服务端缺 classTimes 也保留本地），其余 key 维持现浅合并。
  - **加固（服务端真源补齐）**：`server/src/routes/scheduler.ts` 的有效配置下发 / `/config/set` 存 `scheduler_config` 时，把 `classTimes`/`archiveLimit` 这类"非任务驱动"字段从旧快照原样保留（或把 classTimes 也纳入任务模型由服务端真源持有），杜绝服务端快照缺字段。
  - **回退保护**：`SchedulerSettings`/`SchedulerTasksPanel` 保存前若发现 `classTimes` 将被丢弃应告警，而非静默清空。
- **优先级**：高（课程时间段配置无法跨天保留，家长每天重设；与 ISSUE-019 课程提醒、ISSUE-038 定时任务新模型、SPLIT M8-C 配置同步强耦合）。
- **记录时间**：2026-09-06
- **✅ 修复落地（2026-09-06）**：
  - **根因确证**：服务端 `/config/set` 是**哑存储**（routes/config.ts:92-98 原样存客户端 push 的 value_json，绝不派生/改写 scheduler_config）；worker 也仅**读** legacy scheduler_config 做提醒（worker/scheduler.ts resolveChildConfig `...base` 已含 classTimes）。故服务端侧**无需改动**——真凶在客户端 config-sync 拉取合并：`mergeJsonFile` 旧逻辑对 scheduler_config 顶层浅合并 `{...local,...incoming}` → `children` 整段被服务端快照替换 → 服务端某 child 缺 classTimes（或显式 `[]`）时回拉即清本地。
  - **改动（单文件 `electron/lib/config-sync.ts`）**：
    1. `mergeJsonFile` 增加 `key` 参数；对 `scheduler_config` 改**按 childId 深合并**（`mergeChildConfigs`）：顶层 `{...local,...incoming}` 保留 parent/backup/eventPoll；children 先铺本地全量（服务端缺的本地 child 不丢）、再逐 child 字段级覆盖。
    2. **classTimes 空/缺防丢**：incoming 该 child `classTimes` 缺键或空数组而本地非空 → 保留本地（服务端快照视为过期，防真实数据模式 `classTimes:[]` 覆盖本地已配课程表）；其余字段（recording/todo/autoNewSession/archiveLimit/classAlertMode）一律以服务端为准。
  - **验证**：tsc 0 业务错；electron-vite build 过；merge 算法 15 场景全 PASS（缺键保留/空`[]`保留/服务端非空正常覆盖/本地空用服务端/服务端少 child 不丢/双方空保持空/任务字段正常覆盖）。
  - **未提交、未部署**（并行会话 ISSUE-049/050 有未提交改动，提交时分开）。
