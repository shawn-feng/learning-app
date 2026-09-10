## [ISSUE-058] 201 生产环境：21:00 recording 任务在同一孩子会话里当天执行多次（珊珊 3 次 / 闻闻 2 次）
- **类型**：Bug（服务端无头 worker 调度去重非原子 / 并发重叠 → recording 多点触发）
- **现象**：201 生成环境上，配置 21:00 的 recording（每日对话总结写 daily）任务，在一个孩子维度当天被跑了多次。例：2026-09-06 珊珊执行 3 次、闻闻执行 2 次（次数随孩子不同，非全环境一致）。
- **调度去重机制（已读代码 `server/src/worker/scheduler.ts` + `db/sessions.ts`）**：
  - cron `*/2 * * * *` 每 2 分钟跑 `runWorkerTick`（scheduler.ts:71/256）。
  - 桶匹配：`pointInBucket`（:110）把配置点（如 21:00）映射到 5 分钟桶 [21:00,21:05)，覆盖本桶内所有 2 分钟 tick（21:00/21:02/21:04 共 3 跳）。
  - 去重：`alreadyRanToday`（:166）读 `worker_state.last_key`（children+task="recording"）的「当天已跑点集合」；跑完才在 `runTaskAtPoint`（:238-252）`setWorkerState` 把该 point 写进集合（跨天自动失效）。
  - `worker_state` 读写（`db/sessions.ts:282-302`）是**普通 `SELECT last_key` + `INSERT...ON CONFLICT DO UPDATE`**，**非事务原子 claim，无行锁**。
- **根因（按可能性排序，均为「去重游标检查→异步 LLM 跑批→才写去重」之间无锁」的变体）**：
  1. **【主因·同进程跨 tick 重叠】node-cron 不防同一回调重叠执行**：recording 实际是 `createWorkerEphemeralSession` + LLM 提取 + 写 daily（tasks.ts:199-225），对话多/慢的孩子一次要数十秒到 >2 分钟。21:00 那跳刚启动、还没写完 `worker_state` 时，21:02 / 21:04 的 tick 已触发，`alreadyRanToday` 仍读 false → **再次启动 recording**。重叠 tick 数 ≈ 一次 recording 耗时 / 2 分钟；珊珊更话唠→summary 更久→叠 3 跳，闻闻较短→叠 2 跳。**单进程即可解释 3 vs 2**。
  2. **【次因·多进程并发竞态】201 上若有 >1 个 learning-server 进程**（systemd 重启动留孤儿 / `node server.cjs` 手动多开 / PM2 cluster），各进程独立 `startWorkerScheduler` 共享同一 `server.sqlite`，但 `worker_state` 的 read→write 非原子（无 `BEGIN IMMEDIATE`/无 SELECT FOR UPDATE）→ 并发进程都读到「未跑」→ 各跑一次。N 进程最坏 N 次，且因错误重试（status==="error" 不写去重，下一跳再跑）会更多。
  3. **【待查·多任务行】** `buildEffectiveChildConfig`（task-runs.ts:206-209）把一个孩子分配的**所有 recording 任务行的 `time`  Collect 成 `times` 数组**，去重键是 `(childId,"recording",point)`，`point` 取各自 `time`。若某孩子被建了多条 recording 任务且 `time` 不同（如 21:00/21:01/21:02，UI 可重复添加且分配无去重），则同一桶内每个不同 point 各跑一次 → 珊珊 3 条/闻闻 2 条也会直接成立。需查 `scheduler_tasks` 实际行数。
  4. **【次要·客户端双跑】** 客户端本地 recording 已用 `!hasServerFeature("worker")` 守卫（electron/lib/scheduler.ts:466/602），201 服务端 `SERVER_FEATURES` 含 `worker`（version.ts:12，v0.3.3）→ 正常情况下客户端不跑。但**旧客户端 / feature 协商失败的客户端仍会本地跑 recording** → 叠加服务端，次数+1。属兜底排查项。
- **副作用**：多次执行时各自独立 `readServerDailyConversation` + 并发 `kb_insert`，因首跑尚未写 daily 故后续并发跑都判「无 existing」→ **同一天 daily 出现重复条目**（也可反向佐证本 issue）。
- **201 上确认步骤（取证据定主因）**：
  1. `ps aux | grep -E "server.cjs|learning-server" | grep -v grep` —— 看是否 >1 进程（验证假设 2）。
  2. `sqlite3 /opt/learning-server/data/server.sqlite "SELECT id,type,time,extra_json FROM scheduler_tasks WHERE parent_id='<pid>' AND type='recording';"` 及 `... assignments` —— 看珊珊/闻闻各被分了几条 recording、time 分别是什么（验证假设 3）。
  3. `sqlite3 ... "SELECT child_id,point,status,startedAt,finishedAt FROM task_runs WHERE date='2026-09-06' AND taskType='recording' ORDER BY child_id,startedAt;"` —— 直接数每人几次、各 point、耗时（若单进程且耗时>2min 即印证假设 1）。
  4. `sqlite3 ... "SELECT child_id,last_key FROM worker_state WHERE task='recording';"` —— 看去重集合是否真写了（若为空说明写入失效）。
- **修复入口 / 方向**：
  - **同进程锁（最小、必做）**：在 `runWorkerTick`（:263-276）启动 `runTaskAtPoint` 前，用进程内 `Set<string>`/`Map` 做 `childId|taskType|point` 的 in-flight 锁——`alreadyRanToday` 与「加锁」原子判定，跑完（含成功/失败/skip）再释放；彻底消除 node-cron 重叠。可与 `runWorkerCatchUp`（:287）共用同一把锁。
  - **多进程原子 claim（若确认多进程）**：把 `worker_state` 去重改为原子占有——新增 `worker_locks(child_id,task,point,date)` 唯一键，`runTaskAtPoint` 开头 `INSERT ... ON CONFLICT DO NOTHING`：插入成功=抢占执行，失败=跳过；或用 `BEGIN IMMEDIATE` 事务包住「查+写」。`setWorkerState` 现有 `last_key` 写法保留作可见游标。
  - **单实例保证**：201 部署确保只有 1 个 `node /opt/learning-server/server.cjs`（systemd `Type=simple` 单实例 + `Restart=on-failure`，勿手动多开；必要时加 PID/文件锁防双启）。
  - **recording 任务去重建模**：`buildEffectiveChildConfig` 对同类型任务按 `time` 去重（同 time 多条合并为一条），根绝假设 3 的「多行多 time 各跑一次」。
- **优先级**：高（每日总结重复写 daily、浪费 LLM token、且重复条目污染家长「每日记录」回看；201 生产可复现）
- **记录时间**：2026-09-06
