## [ISSUE-044] 客户端 + 服务端统一日志系统（便于远程排查）

- **类型**：可观测性 / 日志基础设施（客户端 + 服务端，ISSUE-043 现场取证暴露的系统性短板）
- **描述**：给 Electron 客户端和 learning-server 服务端都补一套**持久化、结构化、可远程取回**的日志，替代当前零散的 `console.*`（stdout，打包 app 不落盘、远程 Mac/Ubuntu 客户端拿不到）。ISSUE-043 取证时已实锤：客户端 `[session-sync]` 失败仅 `console.warn` 打到主进程 stdout，打包双击启动看不到、不写 .log（`electron/lib/sync-logger.ts:4` 注释也明写此痛点）；服务端 Fastify `logger:true` 只写 stdout，201 上无头 worker 跑在 systemd 下 stdout 未必可靠留存。目标是让"出问题时能快速定位是哪一端、哪个环节、哪个孩子/请求"。
- **现状（已查代码）**：
  - **客户端**：全程 `console.log/warn/error` 散落 `main.ts`/`ipc-handlers.ts`/`pi-session.ts`/`pi-runtime.ts`/`exam-engine.ts` 等；唯一结构化的文件落盘是 `electron/lib/sync-logger.ts`（`data/sync-log.jsonl`，JSONL append-only + 2000 行轮转 + 内存 statusMap + 前端面板，ISSUE-043 新增）——**这是可复用的范式，本 issue 应把它泛化为通用 app logger**。另 `token-stats.ts:233`、`parent-library.ts:123` 也有 appendFileSync 但各自为政。
  - **服务端**：`server/src/index.ts:23` `Fastify({logger:true})`（pino→stdout）；worker 内 `console.log/error` 散落 `worker/scheduler.ts`/`tasks.ts`/`study-plan-carry.ts`/`providers.ts`；`db/sessions.ts:86` appendFileSync 落会话镜像（业务数据，非日志）。**无文件 sink、无请求访问日志落盘、无错误日志文件、无 `app.log`**。
- **改造方向（两端对称，统一格式）**：
  1. **统一日志格式**：每行一条 JSONL，字段 `{ts(ISO), level(DEBUG|INFO|WARN|ERROR), scope(client|server), component(模块标签，如 session/ipc/llm/worker/sync/db/http), childId?, parentId?, reqId?, msg, err?(堆栈), durMs?}`。落地 `client-log.jsonl` / `server-log.jsonl`，append-only + 行数/体积双上限轮转（照搬 `sync-logger.ts` 的 `pruneLog`）。
  2. **客户端中央 logger**：新增 `electron/lib/app-logger.ts`（复用 sync-logger 的 append+prune+吞异常范式）；`console.*` 重定向到它（启动早期 monkey-patch `console.log/warn/error` → 写文件 + 仍回显 stdout）。捕获 `uncaughtException`/`unhandledRejection` 写 ERROR 级（防崩无声）。
  3. **客户端应记录（建议内容）**：
     - **生命周期**：启动、`dataDir`/`app.isPackaged`、加载的 `server-connection.json` url、`/api/v1/version` 特性探测结果（`session_sync`/`worker`/`exam` 是否含）、网络可达性。
     - **孩子会话**：`pi:prompt` 入参（text 长度、image/audio/file 数，**不记原文**）、vision 模型自动切换、prompt 耗时 `durMs`、LLM 成功/失败（`errMsg`）、工具调用（`display_content`/`kb_*`/parent_course_save 等，记工具名+耗时，不记内容体）、被动 compaction 触发。
     - **家长会话**：同上，`/reset` 命令、回看加载。
     - **会话同步**：已由 `sync-logger.ts` 覆盖（统一进同一 logger 即可，statusMap 面板保留）。
     - **上传/下载**：文件类型/大小、accept 拦截（ISSUE-036）、IPC 结果、server 返回状态。
     - **IPC**：每个 handler 入参摘要 + 耗时 + 失败；server 连接失败（errType 网络/http:status）。
  4. **服务端中央 logger**：pino 增加 file transport（`data/server-log.jsonl` 或 `SERVER_DATA_DIR/logs/`），保留 stdout；加 Fastify `onRequest/压测` hook 记访问日志（`method,path,status,durMs,reqId,parentId,ip`）；worker tick / task_runs 成功失败（已有 console 行）改走 logger（带 `childId`/`task.type`/`message`）；provider 注册失败、`sessions` sync 接收（`bytes/result`）、DB 查询错误、未捕获 500 写 ERROR 级（带栈）。
  5. **可远程取回（关键，呼应 ISSUE-043 痛点）**：
     - 客户端：复用 `sync-logger` 的 `readSyncLogFile` 范式，加 IPC `app:exportLog`（`dialog.showSaveDialog` 导出 `client-log.jsonl`）+ 设置页「诊断 → 导出日志」入口；**可选增强**：客户端日志随诊断上报一键上传到 201 家长库供管理员拉取（优先级低，先落地本地导出）。
     - 服务端：201 上 `tail -f data/server-log.jsonl` 即可；运维面板（或复用 `scheduler` settings）可看最近 ERROR。
  6. **隐私/体积**：**绝不记 prompt/消息正文、auth token、密钥**（现有 sync-logger 已不记内容，保持）；文本只记长度/摘要；轮转上限（如 5000 行 / 20MB）防膨胀；日志文件本身不入 git（`linux-016.zip` 等已列永不上库清单，沿用）。
- **优先级**：中（ISSUE-043 现场已靠手工 `server-connection.json`+`curl` 取证，但通用化后所有"某平台某孩子异常"都能自助定位，省去反复登机/上 Mac）。
- **记录时间**：2026-09-03
- **✅ 已实施（2026-09-06，v1 骨架 + 关键记录点；未提交/未部署）**：
  - **客户端 `electron/lib/app-logger.ts`（新增）**：统一 JSONL 落盘 `data/client-log.jsonl`，字段 `{ts,level,scope:"client",component,msg,...meta}`；`log/logInfo/logWarn/logError/getClientLog/readClientLogFile`；行数(5000)+体积(20MB)双上限轮转（复制 sync-logger 的 append+prune+吞异常范式）。`installConsoleRedirect()`（monkey-patch console.log/warn/error → 写文件+仍回显 stdout，捕获原始 error 供崩溃回显）；`installCrashHandlers(exitOnUncaught)`（uncaughtException 记 ERROR 后按 Node 默认退出；unhandledRejection 仅记 ERROR 不退出）。
  - **客户端接入**：`main.ts` 模块体最前 `installConsoleRedirect()+installCrashHandlers(true)`；`whenReady` 记「app ready」生命周期（cwd/packaged/dataDir/appVersion/platform/arch）；`before-quit` 记「app quitting」。原 71 处散落 console.* 经重定向自动捕获，无需逐处改。
  - **导出链路**：`ipc-handlers.ts` 新增 `app:exportLog`（dialog.showSaveDialog 导出 client-log.jsonl，照抄 sessions:exportLog 范式）+ `app:getLogTail`（读最近 N 条）；`preload.ts` 暴露 `appExportLog/appGetLogTail`；`GeneralSettings.tsx` 软件更新下方加「诊断 → 导出应用日志」区块（FileText 按钮 + 结果提示）。
  - **服务端 `server/src/log.ts`（新增）**：落盘 `SERVER_DATA_DIR/logs/server-log.jsonl`（未 init 兜底 cwd/data/logs），字段 `{ts,level,scope:"server",component,...}`；`initServerLog(dataDir)`、`log/logInfo/logWarn/logError/getServerLog`、`installServerConsoleRedirect()`（对称客户端，worker/routes 裸 console 统一落盘）。**不用 pino transport**（worker 线程在 esbuild 单文件+pkg 部署易断），直接 appendFileSync，与客户端对称。
  - **服务端接入**：`index.ts` loadConfig 后 `initServerLog(dataDir)+installServerConsoleRedirect()`；加 Fastify `onResponse` hook 记访问日志（method/path/status/durMs/reqId/ip）；boot 成功/DB 健康失败/监听失败均 logInfo/logError。
  - **验证**：客户端 tsc 0 业务错（仅 5 环境噪音）+ electron-vite build 全过（main/preload/renderer）；服务端 tsc 0 错 + esbuild build 过；冒烟 spawn dist/server.cjs → `server-log.jsonl` 实测含 worker 启动 / boot / GET health 200 / GET version 200 / GET 404 访问行。遗留：token-stats/parent-library 各自 appendFileSync 未并入；「诊断面板可视化查看日志」未做（仅导出+IPC tail，够用）。
