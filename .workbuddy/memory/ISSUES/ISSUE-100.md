# ISSUE-100：agent 移到服务端后，每日新建会话（省 token）的机制丢失

## 现象 / 用户问题

旧方案（客户端 agent 时代）每天创建新会话以省 token，逻辑有两条：
1. **冷路径（开会话时）**：每次打开客户端，检测会话里最后一条消息的日期是否当天；不是当天就新建会话（丢弃旧上下文）。
2. **热路径（固定时刻）**：客户端存活状态下，到配置的 `autoNewSession.hour:minute` 自动新建空会话（清空活跃对话）。

用户问：agent 全量上移服务端后，新系统是否还有同样的机制？

**结论：没有了。上面的「每日新建会话省 token」机制在新架构下已断链，会话会跨天持续累积，token 不省。**

## 排查证据

### 1. 服务端会话按 childId 持久，不按天切分
- `server/src/agent/session-registry.ts`：会话 key = `${parentId}:${childId}:${kind}`（L76-78），落盘目录 `data/agent-sessions/<parentId>/<childId>-<slot>/`（L259、L6 注释）。**没有日期维度，一个会话文件跨天无限增长。**
- `ensureEntry`（L167）里 `createCoreSession({ shouldAutoNewSession: () => resetMarks.has(key) })`（L261）：这个回调**只判断“是否显式请求过 reset”（resetMarks）**，**完全不看日期**。也就是说服务端永远不会因“跨天”而自动开新会话。

### 2. 冷路径（开会话按日期判断）随客户端零 agent 被移除
- 原本的日期判断实现是客户端 `pi-session.ts` 的 `shouldAutoNewSession` / `getChildSession`（打开时检查“最后消息非今天/已过设定节点 → 开新会话”）。
- 该文件现已归档在 `tmp/pi-session-old.ts`（L294 `getChildSession`、L438 注释“并发保护包裹，确保同一 key 只创建一次”），**不在运行代码里**。
- 现存 `getChildSessionHistory`（`session-registry.ts:463`）只是读历史，**不含任何日期判断，也不会触发新建**。

### 3. 热路径（固定时刻自动新建）残留在客户端 scheduler，但默认关闭且仅“客户端存活那一刻”触发
- `electron/lib/scheduler.ts:552-571` 仍保留 `auto-new-session` 定时块：`cc.autoNewSession.enabled` 时，到 `hour:minute` 且当天未跑过 → `runSessionReset(child.childId)` → `resetChildSession` → `POST /agent/:childId/reset` → 服务端 `newSession`。
- 但：
  - **默认 `enabled: false`**（`scheduler.ts:110`、`scheduler.ts:128`，child/parent 配置都是 `{ enabled: false, hour: 21, minute: 0 }`）。
  - **触发条件苛刻**：cron 每分钟检查 `now.getHours()===hour && now.getMinutes()===minute`，**只有客户端那一分钟正好开着才会重置**；否则当天不触发（注释 `lastDay !== now.toDateString()` 防重复，但“没开=没跑”，不会补跑）。
  - 服务端本身没有对应定时器，全靠客户端在线。

### 4. 迁移注释自证
- `scheduler.ts:462`：“客户端已零 agent：会话由服务端持久管理，重置即通知服务端 newSession”。
- `scheduler.ts:37` 旧注释提到冷路径“由 pi-session 的 shouldAutoNewSession 在开会话时统一裁决”——而 pi-session 已归档，裁决点消失。

## 根因

每日新建会话的“日期裁决”逻辑原本挂在**客户端 session 生命周期**上（`pi-session.shouldAutoNewSession`）。agent 上移服务端时，服务端 `session-registry` 的 `shouldAutoNewSession` 被重新定义为“仅响应显式 reset 标记”，**没有把“跨天自动开新会话”这一职责迁移到服务端**。客户端残留的定时块又默认关闭、且仅“客户端在线那一分钟”触发，等于机制实质失效。

## 影响

- **省 token 的初衷落空**：服务端会话跨天累积，上下文越来越长，每次 prompt 的 input token 持续增长（这正是当初要做每日新建的原因）。
- 行为不一致：旧客户端时代开 app 必开新会话；现在开 app 继续昨天上下文；固定时刻重置又默认不开启。

## 修复方向（未改代码）

最干净的落点在**服务端**（会话的权威管理方）：

- **F1（推荐，恢复冷路径）**：触发点 = **进入账户 / 打开孩子对话视图的那一刻**（客户端加载会话时，对应服务端“取/初始化会话”的入口），**不是**发消息时。检查该会话最后一条消息的本地日期 != 今天 → 先 `resetSession(...)` 再返回空会话。等价于旧系统 `pi-session.createChildSession` 的冷路径（“开会话即按日期裁决”）。
  - **UX 决策（2026-09-14 用户裁定）**：**不能**放在 `submitChildPrompt`（发首条消息时）——否则用户先看到昨天的消息、一发消息会话突然清空，会误以为“会话丢了”。必须在进会话时就完成跨天检测与新建，用户一进来看到的就是当天空会话。
  - 实现落在服务端会话“打开/加载”入口（非 `submitChildPrompt`），客户端在拿到会话后直接渲染（已是空），无需额外处理。
- **F2（恢复热路径 + 配置生效）**：把 `autoNewSession` 的“到点重置”职责迁到服务端（worker 或 session-registry 内定时器，按本地时区在配置的 hour:minute `resetSession`），不再依赖客户端在线；并默认开启或至少让设置页的开关真正生效。
- **F3（可选，更彻底）**：会话按天分文件（落盘目录带日期），天然隔离上下文，review 页 `/sessions/:childId?date=` 也能直接对上；但改动面比 F1/F2 大，建议先 F1+F2。

> 注：F1 与现有 `resetMarks` 机制可共存——显式 reset（用户手动/家长操作）与跨天自动 reset 都走 `resetSession` 同一条路径。

## 实施计划（2026-09-14 规划，待确认后实施）

> 目标：恢复「每日新建会话省 token」机制。F1=进会话按日期裁决（冷路径），F2=固定时刻服务端重置（热路径）。两条独立、互补。

### F1 冷路径：进会话即按日期裁决（用户裁定的 UX：进会话就新建，绝不先显旧消息再清空）

**服务端 `server/src/agent/session-registry.ts`**
1. 新增 `lastMessageTimestampInDir(sessionsDir)`：复用旧 `tmp/pi-session-old.ts:354` 的逻辑——递归扫 `*.jsonl`，取所有 `entry.type==="message"` 且 `role∈{user,assistant}` 中最大的 `timestamp`（SDK 同款格式，可直接复用）。
2. 新增 `isLastMessageToday(sessionsDir)`：`lastTs===null → false`（无历史，无需重置）；否则 `new Date(lastTs).toDateString()===new Date().toDateString()`。
3. 新增 `openChildSession(deps, parentId, childId, kind)`：
   - `sessionsDir = paths.agentSessionsDir(parentId, sessionSlot(childId, kind))`
   - `key = keyOf(parentId, childId, kind)`
   - **若 `!isLastMessageToday(sessionsDir)` → `resetSession(parentId, childId, kind)`**（释放内存实例 + 置 `resetMarks`）
   - `await ensureEntry(...)`（因 `resetMarks` 命中 → `newSession()` 起干净会话；若未命中则 `continueRecent` 载入既有历史）
   - `return getChildSessionHistory(parentId, childId, kind)`
4. `shouldAutoNewSession` 闭包（L261）：**加一道保险**，改为 `() => resetMarks.has(key) || !isLastMessageToday(sessionsDir)`。这样即便客户端漏调 `/open`、只在发消息时触发 `ensureEntry`，也不会继续昨天的上下文。
5. 导出 `openChildSession`。

**路由 `server/src/routes/agent.ts`**
6. 新增 `POST /api/v1/agent/:childId/open`：鉴权 → 解析 `session`（main/scene/course:*）→ `const msgs = await openChildSession(...)` → 返回 `{ messages }`。

**客户端 `electron/lib/server-agent-client.ts`**
7. 新增 `openChildSession(childId, session?, token?)` → `POST /agent/:childId/open`。
8. 进会话加载处把原来的 `getChildHistory(...)`（初始历史拉取）替换为 `openChildSession(...)`。返回的历史已是「跨天重置后的空会话」或「当天既有会话」。**实现时需 grep `getChildHistory` 在 `src/`（React 进会话 hook）的调用点一并切换**；`getChildHistory` 保留给「回顾历史」类场景。

**行为验证**：次日进入对话 → 客户端调 `/open` → 服务端见最后消息非今天 → 重置 → 返回空历史 → 用户一进来就是当天空会话，无「先见旧消息再清空」的违和感。✅

### F2 热路径：固定时刻服务端重置（让既有的 `autoNewSession` 配置真生效）

**服务端 `server/src/worker/tasks.ts`**
1. 新增 `autoNewSessionTask: WorkerTask`：
   - `type: "autoNewSession"`
   - `catchUp: "latest"`（每天该点只触发一次）
   - `points(cfg)`：`cfg.autoNewSession?.enabled ? [\`${pad(hour)}:${pad(minute)}\`] : []`（默认 21:00，取 `db/task-runs.ts` 已算好的 effective 配置）
   - `run(ctx)`：`const { resetSession } = await import("../agent/session-registry.js"); resetSession(ctx.parentId, ctx.childId);`（**不传 kind → 重置该孩子全部会话** main/scene/course；释放内存 + 置 `resetMarks`，下次 `/open` 或首条消息即重建干净会话）
   - **为何 lazy import**：`session-registry` 已 import `worker/scheduler`（readParentSettings），`worker/scheduler` import `tasks`，若 `tasks` 静态 import `session-registry` 会形成 `tasks→session-registry→scheduler→tasks` 环；运行时 `import()` 规避静态环，且 `resetSession` 仅在 `run` 运行时被调用，安全。
2. `registerTask(autoNewSessionTask)`（模块加载即注册）。

**调度器 `server/src/worker/scheduler.ts`**：**无需改动**——`runWorkerTick` 已遍历 `listTasks()` + `points(cc)` + 5 分钟桶匹配 + `alreadyRanToday` 去重，F2 task 直接接入现有 2 分钟调度。

**配置开关**：`autoNewSession` 已存在于 effective 配置（`db/task-runs.ts:203`，默认 `enabled:false, hour:21, minute:0`），客户端开关已通过 `ipc-handlers.ts:710` 返回。**F2 只是让它“做了点什么”**，默认仍关闭（保持 opt-in 语义，不强行改默认）。

**F1 与 F2 的分工**：
- 开了 app 跨午夜、但还没到 21:00 → F1 在进会话时按日期重置（日期变了）。
- app 在 21:00 那刻没开 → F2 服务端照常到点重置；下次进会话 F1 见最后消息非今天（若又跨天）或已是被 F2 清过的当天空会话。
- 即便同一天，F2 也会在 21:00 强制开新会话（即旧「固定时间新建」语义）。两者互不冲突。

### F3（可选，暂缓）：按天分文件
`createCorePaths`/`agentSessionsDir` 目录加日期维度，review 页 `?date=` 直接对齐。F1+F2 已能省 token，F3 改动面大，**暂缓**。

### 改动文件清单
- `server/src/agent/session-registry.ts`：+`lastMessageTimestampInDir` / `isLastMessageToday` / `openChildSession`；`shouldAutoNewSession` 加日期保险。
- `server/src/routes/agent.ts`：+`POST /open`。
- `server/src/worker/tasks.ts`：+`autoNewSessionTask` + `registerTask`。
- `electron/lib/server-agent-client.ts`：+`openChildSession`；进会话初始加载切到 `/open`（含 `src/` 调用点）。
- （核实）`src/` React 进会话 hook 的 `getChildHistory` 调用点。

### 验证
1. 单测：`lastMessageTimestampInDir` 对已知 `.jsonl` 正确取最大时间戳；`isLastMessageToday` 跨天/当天/空目录三种情况。
2. F1 集成：当天发一条消息 → 模拟“次日”进会话 → `/open` 返回空；旧 `.jsonl` 文件仍在（磁盘历史可回顾）。
3. F2 集成：给测试孩子开 `autoNewSession` 设一个临近分钟 → 观察 worker 日志 `[worker] task=autoNewSession ... ok@HH:MM`；随后 `/open` 为干净会话。
4. **部署**：server 改动需重新构建并发布到 ubuntu(192.168.1.201:8788)+OSS 流水线；遵循“Windows 先验、ubuntu 后验”。

## 关联

- 客户端旧实现：`tmp/pi-session-old.ts`（日期裁决的“前世”）。
- 服务端会话：`server/src/agent/session-registry.ts`、`server/src/routes/agent.ts`。
- 客户端残留定时：`electron/lib/scheduler.ts:552-571`、`electron/lib/server-agent-client.ts:477 resetChildSession`。
- 会话回顾按天查询（已支持）：`server/src/db/sessions.ts`、`server/src/routes/sessions.ts`。

## 状态

✅ 已解决（2026-09-14 实施 F1 + F2）：

- **F1 冷路径（进会话跨天裁决）**：`session-registry.ts` 新增 `lastMessageTimestampInDir`（递归扫 .jsonl 取最后一条 user/assistant 消息时间戳，复用旧客户端 pi-session 逻辑）/`isLastMessageToday`（无历史视为"今天"=无需重置）/`openChildSession`（最后消息非今天 → 先 resetSession 再 ensureEntry，返回裁决后历史）；`ensureEntry` 的 `shouldAutoNewSession` 加日期保险（`resetMarks || !isLastMessageToday`，服务端重启后首条消息也不会续昨天上下文）；`routes/agent.ts` 新增 `POST /api/v1/agent/:childId/open`。
- **F2 热路径（固定时刻服务端重置）**：`worker/tasks.ts` 新增 `autoNewSessionTask`（points 取 effective 配置的 `autoNewSession`，默认 enabled:false/21:00 保持 opt-in；catchUp=latest；run 内 lazy import `resetSession` 规避 tasks→session-registry→scheduler→tasks 静态环，重置该孩子全部会话）。
- **客户端**：`server-agent-client.ts` 新增 `openChildSession`（POST /open → mapHistoryMessages）；`ipc-handlers.ts` 进会话两处加载（`pi:start_child` 主/课程会话、`scene:history` 场景会话）由 `getChildHistory` 切换为 `openChildSession`——用户一进来看到的就是当天会话；`getChildHistory`（/history）保留给回顾类只读场景。
- **验证**：server `tsc --noEmit` 通过、`npm run build`（esbuild bundle）通过；根 `electron-vite build` 通过；冒烟测试 8 项断言全过（今天/昨天/空目录/目录不存在 × 时间戳与布尔判定）。**待部署 ubuntu(201) 后生产验证**。
- F3（按天分文件）维持暂缓。

### 部署与生产验证（2026-09-14 晚）
- **补充修复**：`worker/scheduler.ts` 的 `schedulerTaskTypeFor` 增加 `autoNewSession → auto_new_session` 映射（任务表用下划线命名；不映射则 findTaskForRun 查不到、task_runs 挂不上任务）。
- **已部署 201**：server.cjs 0.4.1（paramiko 模板 `tmp/deploy/deploy_server_041.py`），备份 `.bak-*`；验证 version=0.4.1、`/open` 返回 401（路由生效）、health ok。
- **用户报障「18:30 没生效」排查结论**：① 18:30 时服务端还是旧构建（本日 18:40 才部署）；② **服务端 DB 里没有 18:30 的任务**——scheduler_tasks 仅 9/3 的「自动新建会话 21:30」（分配两孩）+ scheduler_config 仅 21:30/23:00 旧配置，当日无任何新建任务行 → 用户那次创建未成功落库（原因待用户确认 UI 是否报成功）。
- 端到端触发验证：临时把 21:30 任务改 time=18:54 → worker tick 18:50 桶命中即触发 → **journalctl 两个孩子 ok@18:54 + task_runs 两条记录（task_name 正确挂接）→ 已恢复 21:30**。F2 生产链路全通。
- 客户端 0.1.15 安装包已构建（`dist-release-021/学习伙伴 Setup 0.1.15.exe`，含历史消息时间戳修复，见下）。
- **⚠️ 已按用户指示回退（2026-09-14 20:20）**：用户明确「不要部署到 201」→ 用备份 `server.cjs.bak-20260914-1840` 恢复并重启，现 201 运行 **0.3.5**（features 仅 session_sync/worker/exam）。**重要发现：201 生产从未部署过 0.4.x agent 服务端化版本**——今天 18:40 部署 0.4.1 前，生产一直是 0.3.5，即 ISSUE-081~099 的全部服务端改动此前只在本地开发环境验证过，生产 agent 形态待用户后续统一决策。因此「今晚 21:30 任务会触发」的说法在 0.3.5 下不成立（0.3.5 无 autoNewSessionTask）。部署约定已记入 MEMORY.md：未经用户明确同意不得部署 201。

### 本地环境根因修正 + 多时间点修复（2026-09-14 20:45，最终定案）

- **用户澄清：18:30 未生效发生在本地 dev server**（server/data/server.sqlite），此前查 201 得出「任务未落库」的结论**作废**——本地库中任务 18:19:20 创建成功、分配正确（珊珊+闻闻）、parent_id 匹配。
- **真正根因**：`buildEffectiveChildConfig` 用 `tasksFor.find(type==='auto_new_session')` 只取**第一个**任务——珊珊名下 9/2 就有「自动新建会话 22:00」（time=21:00）任务，今天新建的 18:30 被**静默遮蔽**，eff 配置 hour=21 → 18:30 桶不匹配 → 不触发。recording 是 `times[]` 多时间点建模，autoNewSession 却是单时间点——设计缺陷。
- **修复**：① `EffectiveChildConfig.autoNewSession` 增加 `times?: string[]`（全部任务时间点，去重排序）；② `autoNewSessionTask.points()` 优先返回 times（兼容旧 hour/minute 单点）；③ `WorkerSchedulerChildConfig.autoNewSession` 增加 times 字段。
- **本地验证（20:41）**：重启 dev server → 启动补跑立即执行 `[worker] task=autoNewSession child=闻闻/珊珊 ok@18:30`；task_runs 两条落库且任务名正确挂接（类型映射修复生效）；worker_state 游标 {date:2026-09-14, points:["18:30"]} 正确。珊珊/闻闻会话已重置（resetMarks 已置，下次进会话即新会话）。
- **运维备注**：本地 dev server 现由助手会话的后台任务托管（task pctwmc），建议用户在自己终端重启接管（进程随助手会话结束而停止）；今晚 21:00（旧任务）与 18:30（新任务）明天起都会按各自时间点触发。
