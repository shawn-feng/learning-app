## [ISSUE-043] 生产环境珊珊（Mac 客户端）会话未同步上云：家长回看空白 + 服务端每日汇总跳过

- **类型**：生产数据缺失 / 会话同步（session-sync，Mac 客户端特异性，自 0.1.8 起）
- **描述**：生产环境（201 局域网 learning-server）里，珊珊（Mac 客户端，自 0.1.8 即存在）的会话 jsonl 从未同步到 server 端。现象三连：① 201 server `data/sessions/<parentId>/<珊珊>` 为空（无珊珊会话数据）② 家长界面「会话回看」打开是空白 ③ 服务端每晚每日汇总（recording）任务跳过了珊珊。其它平台（Windows/Ubuntu）孩子正常回看+汇总。用户判定为 Mac 客户端特有 bug。
- **现状 / 根因（已查代码，锁定链路）**：
  - **客户端上传链路**：`electron/lib/session-sync.ts` `syncChildSessions(childId)` 读 `getChildDir(childId)/.pi/agent/sessions/*.jsonl` 增量（字节游标+行号幂等）→ `POST /api/v1/sessions/:childId/sync`（server/src/routes/sessions.ts:50）。三处触发：每轮孩子对话后（ipc-handlers.ts:1098 无条件 `void syncChildSessions(childId)`）、5min 定时 `startSessionSyncTimer`、退出前 `flushSessionSync`。失败被 try/catch 吞，仅 `console.warn('[session-sync] ... 同步失败')`，游标不前进。
  - **服务端镜像**：`server/src/db/sessions.ts:13` 落盘 `data/sessions/<parentId>/<childId>/*.jsonl`；201 已 advertise `session_sync` feature（version.ts:12）。
  - **家长回看**：`preload.ts:101` 注释「方案B 阶段①：家长对话回顾（读服务端同步上云的会话）」→ `GET /api/v1/sessions/:childId?date=`（sessions.ts:120）。server 镜像空 → 回看空白。
  - **服务端每日汇总**：`server/src/worker/tasks.ts:7` 数据源全在服务端镜像 `readServerDailyConversation`；`runWorkerTick(recording)`（worker/scheduler.ts）读不到会话 → 当日无会话跳过（对应「晚上汇总跳过」）。
  - **结论**：三症状同源 = 珊珊 Mac 客户端从未成功把会话 jsonl 推上 201 server。具体为何 Mac 失败待现场取证（见候选根因）。
- **候选根因（Mac 特异性，需取证）**：
  1. **网络/服务端指向**：201 是 LAN 服务器（192.168.1.201）。若珊珊 Mac 在 LAN 外（学校/蜂窝/其它 wifi）连的是公网 learning-cloud，而 cloud 端未部署 `session_sync`+`worker` → sync POST 失败被吞。需确认 Mac 客户端实际连的 server base URL 与 `hasServerFeature("session_sync")` 探测结果。
  2. **sync-state 游标卡死**：`getChildDir(childId)/.pi/sync-state.json` 若早期一次部分失败导致游标超前/错乱，后续 deltas 全被 `session-sync.ts:73 buf.length <= prev.syncedBytes` 跳过。平台无关但可能；需查珊珊 Mac 的 `sync-state.json` 与 sessions 实际字节大小。
  3. **parentId/childId 串号**：server 镜像按 parentId 分目录（db/sessions.ts:13）。若 Mac 端 parent 身份与 201 不一致（多设备/不同账号登录），镜像落在别的 parentId 下，回看按当前 parent 查为空。
  4. **ATS / 明文 HTTP（次可能）**：若 201 用 http 非 https，macOS App Transport Security 可能拦截 cleartext 请求。但 ATS 若全局拦截，登录/计划/考核也应失败——若仅会话缺失则排除全局 ATS。
- **诊断步骤（落地取证）**：
  - 珊珊 Mac：`~/Library/Application Support/学习伙伴/app-data/children/<childId>/.pi/` 下 `sync-state.json` + `agent/sessions/*.jsonl` 是否存在、字节大小。
  - 201 server：`data/sessions/` 下有无 `<parentId>/<珊珊childId>/` 目录及文件。
  - 珊珊 Mac 客户端日志搜 `[session-sync]` 看是否「同步失败」warn 及错误（网络/401/404/超时）。
  - 确认 Mac 客户端连接的服务端地址（201 vs cloud）与 `session_sync` feature 探测。
- **改造方向（按根因定）**：
  - 网络指向：客户端优先连 LAN 201（session_sync/worker 真源），或 cloud 端同样部署 session_sync+worker；回看/汇总统一真源。
  - 游标卡死：sync 增「游标校验」——文件 mtime/size 变化或 hash 不匹配则重置游标重传；提供「强制全量重传」入口（清 sync-state.json）。
  - parentId 串号：启动断言 parent 身份一致，sync 带 parentId 防串。
  - 通用加固：sync 失败在 UI/日志显式告警（当前静默），家长端可感知「某孩子会话未上云」；上传成功/失败上报 worker_state 便于运维排查。
- **优先级**：高（生产数据长期缺失，影响回看+汇总，自 0.1.8）
- **记录时间**：2026-09-03
