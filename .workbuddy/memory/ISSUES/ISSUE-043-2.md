## [ISSUE-043] 现场取证 + 同步机制澄清（2026-09-03 登 201 `192.168.1.201`）

### 同步机制（用户质疑点澄清）
- **回看读 DB（用户判断正确）**：`GET /api/v1/sessions/:childId?date=` → `querySessionMessages` → `session_messages` 表。
- **server 端 jsonl 是设计内必需，非冗余/非自产**：`POST /sessions/:childId/sync` 调 `appendAndIndexSession`（db/sessions.ts:55），对客户端上传的增量 `lines` 同时做 `fs.appendFileSync` 落盘 `data/sessions/<parentId>/<childId>/<file>.jsonl` + `INSERT OR REPLACE INTO session_messages` 索引。即 **jsonl 是源头、DB 是从 jsonl 派生的索引，双写同源**。所以"server 有 jsonl"与"回看读 DB"不矛盾、且必须并存。
- **为何 jsonl 不能省**：server 无头 worker 每日汇总 `readServerDailyConversation` 直接读 `data/sessions/` jsonl（注释明写"数据源换为服务端镜像"）。删 jsonl → 回看（DB）还在，但**汇总全废**。

### 201 现场事实（修正上轮两处误判）
- 映射：家长 `86a84278-...`(test@qq.com)；孩子 `1f050a7f-...`=**珊珊**；`09406c05-...`=闻闻（对照）。
- 珊珊 `data/sessions/<parent>/1f050a7f/` 下 **23 个 jsonl（共 3,058,651 字节）**，`session_messages` 表 **732 条**；服务端镜像非空（推翻"从未同步/为空"）。
- **误判修正①——同步时间≠文件名时间**：jsonl 文件名 `2026-08-30T23-39-59...` 是客户端创建 session 的时间戳（内容时间），非上传时间。`session_files.updated` 全部 = **2026-09-03T05:13:52~54Z（北京 13:13）** → 这 23 个历史文件是 **09-03 13:13 一次性批量补传**到 201 的，非 08-19~08-30 逐日自然同步。
- **强证是 sync 落盘（非手工导出）**：`session_files.synced_bytes` 与磁盘 jsonl 实际大小逐一吻合（最大文件 1170003=1170003）→ 确为 `appendAndIndexSession` 经 `fs.appendFileSync` 落盘；手工从 DB 导出不会写 `synced_bytes`。
- **误判修正②——"13:13 不是重传"是错的**：13:13 恰恰是**客户端补传的落盘时刻**（与 `server.sqlite-wal` 13:13:54 写入一致），内容仍只到 08-30，但这是 09-03 才传上来的。
- 汇总正常：珊珊 `recording` worker last_run=2026-09-02T13:00Z → 历史会话已被汇总（推翻"汇总跳过"）。
- **真实缺口**：server 上珊珊**完全没有 08-31 / 09-01 / 09-02 / 09-03 的会话**（jsonl 与 DB 均无）。结合"历史文件 09-03 才补传" → 珊珊 Mac 在 09-03 前基本未连 201 LAN。

### 架构性根因（比"客户端 bug"更准确）
- `session_sync` + `worker`（recording 汇总）**只部署在家庭局域网 201 的 learning-server**；公网 learning-cloud 不部署（见工作记忆 SPLIT 约定）。孩子 Mac 一旦不在 201 LAN 内（出门/连公网/睡醒才连），对话既不同步回看、也不被汇总。这是系统性前提缺失，ISSUE-043 本质是"回看依赖孩子设备能连 201 LAN"这一脆弱前提。
- 08-31~09-03 空白待上 Mac 验证两假设：A. 那几天没开 App/没对话（空白正常非故障）；B. Mac 走了公网 cloud（对话在别处未回流 201）。

### 待办（上珊珊 Mac 取证）
- `~/Library/Application Support/学习伙伴/app-data/children/1f050a7f-.../.pi/sync-state.json` 字节游标 + `agent/sessions/*.jsonl` 是否有 08-31~09-03 文件。
- 客户端日志搜 `[session-sync]`（网络/401/404/超时）；确认连接的服务端地址（201 vs cloud）与 `session_sync` feature 探测。
- 回看接口实测受阻：手搓 JWT 被拒（需服务端有效登录会话），但回看读 DB 已可间接证实历史有内容、近日期空白。

### Mac 本地取证进展（2026-09-03 14:48 用户现场确认）
- **用户已在珊珊 Mac 确认 08-31~09-02 本地有会话记录**（agent/sessions 下对应 jsonl）→ **排除假设 A（那几天没对话）**，锁定「本地有会话但未上云」，根因在客户端 sync 链路（server-connection 指向 cloud 或 sync 游标卡死）。
- **客户端日志不落盘（重要）**：package.json 无 electron-log/winston/pino，[session-sync] 失败仅 `console.warn` 打到主进程 stdout，打包 app 双击启动看不到、不写 .log。取证：①Mac 终端直接跑 `/Applications/学习伙伴.app/Contents/MacOS/学习伙伴` 看 stdout；②更推荐直接查 server-connection.json + curl /api/v1/version 看连的哪个 server 及 features 是否含 session_sync。
- **server 指向分水岭（config.ts）**：`getServerUrl()`→`getServerConnectionPath()`=`getDataDir()/server-connection.json`（`{url}`）；未配默认 `http://127.0.0.1:8788`。url=公网 cloud → sync 发往无 session_sync 的 cloud（根因坐实）；url=201 但那几天 Mac 不在 LAN → fetch 失败 warn；游标曾被误连 cloud 推进 → 永久静默跳过。
- **待用户跑的 Mac 命令**：查 `server-connection.json` 的 url；`curl -s <url>/api/v1/version` 看 features；`sync-state.json` 游标；`agent/sessions/*.jsonl -newermt 2026-08-30` 确认 08-31+ 在扫描目录。
- **临时修复（取证后）**：确为连 cloud 则把 server-connection.json 改 `http://192.168.1.201:8788` + 删该 child `sync-state.json` 清游标 + 重启 app → 本地增量重传 201。根因修复需 cloud 也部署 session_sync/worker，或客户端强制会话 sync 发往 201 家庭真源。

### 闭环结论（2026-09-03 14:55 自愈实锤）
- **数据已全量恢复（实锤）**：14:55 重查 201 `session_messages`（修正上轮 `ts>='2026-08-31'` 字符串比较 bug——`ts` 是整数毫秒，永远小于文本，`WHERE ts>='2026-08-31'` 全行 false 误显 0）。用正确毫秒边界后：珊珊 **08-31=248、09-01=25、09-02=68、09-03=12 条**，总 744 条。回看接口读此表 → 家长端看到 8-31~9-3 对话即此。
- **"什么也没做就恢复" = 客户端自动补传 backlog**：9-3 珊珊 Mac 升级到带 session-sync 的版本后，后台 sync 把本地 08-31~09-02（及 09-03）未 sync 的 session 增量首次推上 201（14:40 落盘 09-03 文件、余下批次随后补齐）。非手动修复，是"装上 sync 代码后第一次跑"的自愈行为。
- **架构根因最终定性（2026-09-03 16:01 用户更正后修正）**：**非数据丢失、非 LAN 不可达、非 cloud 误配**，而是**客户端版本滞后**。session-sync（方案B 上云）整条链路由 commit `de2ef67`（2026-08-31 23:24）引入，**仅 v0.1.8（2026-09-02）+ v0.1.9（2026-09-03）包含；v0.1.7（2026-08-31）及更早完全没有 `session-sync.ts`（已 git 核实 "NOT in v0.1.7"）**。珊珊 8-31~9-2 使用的 Mac 客户端仍是 ≤v0.1.7 → 读接口（进度/课程）正常（那些 API 早就有），但**本地会话永不会被上传**；家长端回看因此空白。9-3 客户端升级到 0.1.9 后 sync 首次运行，从游标 0 把全部历史（08-19~09-03）一次性补传（13:13 那批 08-19~08-30 + 14:40 那批 08-31~09-03）。数据从未丢失。
- **状态**：ISSUE-043 从"数据缺失 bug（高优）"降级为"客户端版本滞后导致的观察窗口空白，已随升级自愈"。数据完整，无需修复动作。
- **遗留设计限制（建议优化，非本次范围）**：①**客户端版本 vs 服务端特性发布的时间差**：server 先有 sessions 能力、旧客户端永远不推送 → 旧客户端孩子的对话在家长端长期不可见，直到客户端升级。建议：server 识别客户端版本、对过旧客户端弹"请更新"提示；或"会话同步"面板增加客户端版本/最后成功 sync 展示，让家长一眼看出"某孩子还没升级所以没回看"。②**已排除 "误连公网 cloud" 假设**（用户确认 server-connection.json 指向 `http://192.168.1.201:8788` 家庭真源）；**已排除 "LAN 不可达" 假设**（用户确认 8-31~9-2 珊珊能正常连 201 查进度/课程）。本次空白与网络无关。③sync 失败/游标异常静默问题已由本次"完整版"修复显式化（见下）。
- **对家长的解释口径**：珊珊不在家/没连家里服务器时，那几天对话回看会暂时空白，回家连上后自动补回——属正常，不是丢数据。

### 修复：同步失败显式化 + app 内可下载日志（2026-09-03 15:30 已实施）
- **目标**：把"静默吞掉"的同步失败变成「可感知、可手动重试、可导出日志」，直接解决遗留设计限制③（及部分①）。用户选"完整版"。
- **新增 `electron/lib/sync-logger.ts`**：落盘 `data/sync-log.jsonl`（append-only + 2000 行轮转），每行 `{ts,childId,trigger,serverUrl,ok,errType?,errMsg?,bytes?}`；并维护内存 `statusMap`（每孩子 `lastSyncAt/lastResult/consecutiveFails/lastError/connectedServer/pendingBytes/lastTrigger`）。导出 `markSyncAttempt/Success/Failure/Skip`、`getSyncStatus/getSyncLog/readSyncLogFile`。
- **改造 `electron/lib/session-sync.ts`**：`syncChildSessions` 加 `trigger` 参数（prompt/timer/quit/manual，对应 3 个旧调用点 + 新增手动）；成功/失败/无增量分别 `markSyncSuccess/markSyncFailure/markSyncSkip`；失败 `errType` 由 `ServerError.status` 区分网络(0)=`network` / http(>0)=`http:<status>` / 服务端 ok=false=`server`。原 `console.warn` 保留但不再是唯一出口。
- **新增 IPC（ipc-handlers.ts）**：`sessions:syncStatus`（状态快照）、`sessions:syncLog`（最近N条）、`sessions:forceSync`（立即同步所有孩子）、`sessions:exportLog`（`dialog.showSaveDialog` 导出日志到本机）。
- **preload.ts**：暴露 `sessionSyncStatus/sessionSyncLog/sessionForceSync/sessionExportLog`。
- **前端**：新增 `src/components/SessionSyncPanel.tsx`，`src/pages/Dashboard.tsx` 侧边栏加「📡 会话同步」入口（view="sync"）：每孩子状态卡（上次同步/成败/连续失败数/当前连的服务器/待同步字节）+「立即同步」按钮 +「导出同步日志」按钮 + 最近日志表，每 5s 自动刷新。
- **验证**：`electron-vite build` 通过（main/preload/renderer 均打包成功）；环境 tsc 的 global-type 告警与本改动无关。
- **范围说明**：本次为"客户端失败显式化 + 自助排查"层，未动架构根因（cloud 也部署 session_sync / 强制会话发往 201 真源）；该根因级修复留作后续。
- **用户确认（2026-09-03 15:58 / 16:01 两次更正）**：①珊珊 Mac 的 server-connection.json 指向 `http://192.168.1.201:8788`（家庭真源）→ 排除"误连公网 cloud"；②8-31~9-2 珊珊能正常连 201 查进度/课程 → 排除"LAN 不可达"。由此推翻"sync 强依赖 LAN 可达"的诊断。**真因 = 客户端版本滞后**：观察窗口内珊珊 Mac 跑 ≤v0.1.7（无 session-sync 代码），9-3 升 0.1.9 后首次 sync 补齐全部历史。详见「闭环结论」段。本次"同步失败显式化"改造仍价值在：让家长能看出"某孩子很久没成功 sync / 待同步字节堆积"，间接暴露"未升级旧客户端"。
