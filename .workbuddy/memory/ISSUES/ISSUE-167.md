# ISSUE-167：201 Mac/Ubuntu 客户端使用中「突然连不上 server」——回主页显示的是**本地开发环境的孩子**（离线降级静默吞掉环境切换），须退出家长重登才恢复 201

- **类型**：bug / 架构（多环境连接与离线降级的交互缺陷；Mac + Ubuntu 客户端均复现）
- **现象**：链接 201（http://192.168.1.201:8788）的客户端使用中突然连不上 server；退出到主页后，孩子列表显示的是**本地开发环境的孩子**（本机 8788 的）；只有**退出家长账户再登录**才重新连回 201 生产。
- **根因链（已核实代码，三个设计叠加成坑）**：
  1. **离线降级静默回退本地扫描**：`listChildren()`（child-auth.ts:216-222）在「serverFetch 失败（网络/超时）」时 `catch { }` **直接回退 `readLocalProfiles()`**——扫描本机 `children/<id>/profile.json`。而客户端本机 data 目录里**残留着开发期创建的孩子**（本地开发环境用同一台机器时留下），于是「连不上 201」被静默表现为「显示本地孩子」，**没有任何环境切换/断连提示**；
  2. **server-connection.json 指向不变但无人校验**：服务端地址持久化在 `<本机data>/server-connection.json`（config.ts:138-163），失联时它仍指向 201——但 `getServerUrl()` 只在**读配置文件**，不存在「失联后自动改指本地」的逻辑；真正让主页显示本地孩子的不是 URL 被改，而是 ① 的回退分支；
  3. **token/licence 缓存与会话状态在家长会话里**：重进时 `listChildren` 需要 `currentSessionToken()`+serverFetch 成功才走服务端分支；「退出家长再登录」之所以能恢复，是登录动作**重新校验了连接并刷新了 licence 缓存**（auth-manager cacheLicense）——即恢复路径存在，但只绑在「重新登录」这个重动作上，日常使用中失联无法自愈/无提示重试。
  - 附带风险：201 上的客户端本机 data 里若有**本地开发环境的孩子与 201 同名**，家长可能把录音/进度写到本地库（分裂），且 child-auth 的「本地有→自动上传 PATCH」分支（:172-186）可能在恢复连接后把本地脏数据上云（passwordHash 有双保险，其余字段没有）。
- **修复方向（建议组合）**：
  1. **环境可见性（核心）**：失联降级**不许静默**——`listChildren` 回退本地扫描时返回值带 `source: 'local-fallback'`（或 IPC 层带 `degraded: true`），主页顶部挂**常驻横幅**：「⚠ 已断开与生产服务端（201）的连接，当前显示本机数据（仅离线可用）」，并提供「重试连接」按钮；
  2. **自动重连**：断连后周期性探活（如 30s 一次 `GET /health`，指数退避），恢复后自动重拉孩子列表并撤横幅——把「退出重登」这个手工恢复动作自动化；
  3. **本地开发数据隔离**：生产安装包的 data 目录**不应残留本地开发孩子**——建议 data 目录按环境隔离（如 `ELEARN_ENV`/安装模式分目录）或提供「本机数据清理」；至少在 fallback 横幅里明确列出「本机孩子」与「服务器孩子」的数量差异，避免家长误入本地孩子的会话写脏数据；
  4. **上传防线**（补漏）：「本地有→自动上传 PATCH」分支在 fallback 场景（刚才连不上）禁止执行——降级模式下只读，恢复连接后经用户确认再同步。
- **回归**：真离线场景（断网）仍可用本地孩子（降级设计保留，只是可见化）；恢复连接后列表自动刷新且不重复上传 profile；passwordHash 双保险（2026-08-31 事故防线）不回退；Mac/Ubuntu 双端行为一致。
- **优先级**：高（生产环境失联静默降级 + 可能写脏数据，家长感知是「孩子全变了」；且 Mac/Ubuntu 双端均复现）
- **记录时间**：2026-09-27

## ✅ 实施记录（2026-09-28，客户端-only，服务端零改动）

**① 降级可见化（核心）**：新增 `electron/lib/connection-state.ts` 连接状态记账——`server-client.ts` 五个 fetch 函数（serverFetch/serverFetchBinary/uploadFileToServer/serverUploadFile/serverUploadWithFields）统一挂钩：**拿到任意 HTTP 响应（含 4xx/5xx）=可达**、fetch 抛错（网络不可达/超时）=断连；断连→恢复翻转时通知监听者。`listChildren` 的静默回退行为保留（真离线仍可用本地孩子），但状态不再不可见。主页（`src/pages/Dashboard.tsx` `dashboard-main` 顶部）挂**常驻横幅**：「⚠ 已断开与服务端（url）的连接，当前显示的是本机数据（仅离线可用）」+「服务器上次同步 N 个孩子，本机当前 M 个——请勿在本地孩子里产生新记录」+**重试连接**按钮。N 来自 `noteServerChildren`（listChildren 服务端分支成功时记账 `lastServerChildCount`）。

**② 自动重连**：新增 `electron/lib/connection-monitor.ts`——断连状态下指数退避探活 `GET /health`（30s→1m→2m→5m 封顶；**连接健康时不轮询**，无常驻流量）。恢复链路双通道：Electron 由 `onConnectionChange` 监听经 `server:connection-changed` 推送渲染层；web 无主进程推送，由 Dashboard 降级期间 30s 轮询 `serverConnectionState`（shim 在断连态时顺手探活 /health 自愈）。**恢复后自动重拉孩子列表并撤横幅**——「退出家长重登」这个手工恢复动作自动化。IPC 三通道：`server:connectionState` / `server:retryConnection` / `onServerConnectionChanged`（preload + web shim misc 域同签名）。

**③ 降级只读（上传防线）**：「本地有→自动上传 PATCH」分支（child-auth listChildren）新增第三道闸 `recentlyDegraded(10 * 60_000)`——**10 分钟内发生过断连/恢复不自动上云**（降级期间本机残留的开发孩子/脏详情不随恢复后的第一次列表刷新同步上去；等下一轮常规刷新或家长显式保存再同步）。passwordHash 双保险（2026-08-31 事故防线）原样保留。

**实现要点/踩坑**：`getServerUrl()` **永不返回空**（未配置时默认本机 8788，config.ts:151-163），所以「未配置=纯本地模式」的状态不存在——记账无条件记录，默认本机服务端没起也如实报断连；横幅条件只看 `connected === false`。Dashboard 的推送监听走 `registerListener` 通道，可能被任意组件的 `piRemoveListeners()` 误清——轮询兜底保证横幅自愈。

**未做（待拍板）**：修复方向 #3 的结构性方案——生产安装包 data 目录按环境隔离（ELEARN_ENV/安装模式分目录）或「本机数据清理」入口。现由横幅的数量差异提示兜底（家长能看出「服务器 3 个 vs 本机 5 个」的异常）。

**验证**：`test/issue167-connection.test.ts` 4 例全绿（可达/断连翻转与监听者通知、recentlyDegraded 窗口 fake-timers 推进、服务端不可达回退本地扫描、刚恢复不自动上云/窗口外恢复同步/lastServerChildCount 记账——mock server-client + 真 connection-state/child-auth，复用 app.test.ts 的 electron mock 范式）；app.test.ts 同跑 8/8 不互扰；electron-vite/web 双端构建过；web typecheck 6 条与基线持平（我的文件零报错，Dashboard 152 行隐式 any 为基线 107 行平移）。
