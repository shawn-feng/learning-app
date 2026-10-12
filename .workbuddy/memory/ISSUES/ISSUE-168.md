# ISSUE-168：服务端时间戳混杂 UTC/本地时区——排查收口统一为用户时区（speex 评测语音的 server 处理时间查到 UTC 即症状之一）

- **类型**：bug / 架构（时间戳口径统一；排查型 issue）
- **现象**：今天查询评测语音（speech 评测，用户原文「esp语音」）在 server 端的处理时间，拿到的是 **UTC**（比本地时间早 8 小时）。排查确认系统内部确实混杂两种时间口径。
- **排查结论（已核实代码）**：
  - **UTC 侧（写入即 UTC 的位置）**：`toISOString()` 全仓 **112 处**（exam/speech_assessments.created_at、files.created_at、exam_attempts、task-runs.ts:338/473、db.ts 建表 DEFAULT、log.ts 等）+ SQLite `datetime('now')` **5 处**（assess-content.ts 题库 created_at/updated_at 默认值与 touch、db-channel.ts:635 touchUpdatedAt——`datetime('now')` 本身就是 UTC）；**先例已踩坑**：ISSUE-143 验证脚本按本地日期 LIKE `files.created_at` 整批漏行（「考核明细/files 表 created_at 是 UTC」当时已注明）；家长报的「评测语音处理时间查到 UTC」即 speech_assessments/审计类 created_at 是 `toISOString()` 所致；
  - **本地时区侧（已经是本地口径）**：业务日期域（计划/结算/考核归属日）早已统一本地——`formatLocalDate`（kb-tools.ts:397，服务端时区）、`dayStart/dayEnd`（计划窗口）、`localDatetime`（db-channel 服务端生成列）；设置/调度 worker 均按本地日期运转。
  - **混杂的后果**：同一张表里 `YYYY-MM-DD` 归属列（本地）与 `created_at` ISO 时间戳（UTC）并存；跨天窗口（晚 8 点后=UTC 已是明天）按 created_at 日期筛选/展示错位 8 小时；日志与 DB 时间戳对不上；家长看到的「处理时间」多数展示场景直接读原始值。
- **改造方向（建议）**：
  ① **口径定案**：**展示与查询一律用户（服务端主机）时区**；存储有两种可选——A. 全部改存本地时间 ISO（无时区后缀，与现有 `YYYY-MM-DD` 列同口径，读侧零转换；**推荐**，单机部署/时区固定场景最简单）；B. 保持 UTC 存储+读侧统一转换（多时区未来更稳，但要动所有展示/筛选点）。推荐 A + 全局辅助函数（如 `nowLocalIso()` 收口）；
  ② **收口改写**：112 处 `toISOString()` 按表逐批替换（优先 speech_assessments/files/exam_attempts/task_runs/审计与日志——家长可见的「处理时间」）；5 处 `datetime('now')` 改 `datetime('now','localtime')`；`new Date(...)` 默认列（db.ts 建表 DEFAULT CURRENT_TIMESTAMP 的表盘点调整）；
  ③ **存量数据**：已写入的 UTC 行**不回写**（历史记录少 8 小时可接受）或提供一次性 `+8h` 迁移脚本（可选项，建议不迁——审计类时间戳改动风险大于收益）；新旧混存期间查询按「写入批次」区分不现实，接受偏差；
  ④ **防回归**：lint/测试护栏——新增 `no-toISOString-in-server` 风格检查（或统一 helper 后禁直呼），测试断言新写入行的 created_at 与 `formatLocalDate(new Date())` 同日。
- **回归**：评测/录音/审计时间在家长端显示为本地时区；按日期筛选（当日/范围）不再漏行；ISSUE-143 类验证脚本口径问题消失；计划/结算域（本就本地）零变化；201 部署后新写入行验证 +8h 正确。
- **优先级**：中（家长可见的时间错位 8 小时；改动面广但机械，需分批+护栏）
- **记录时间**：2026-09-27

## ✅ 已实施（2026-10-11，方案 A：全部改存本地 ISO）

**改动**：
- 新增 `server/src/util/time.ts`：`toLocalIso(d)` / `nowLocalIso()`——本地时区、无 Z 后缀、毫秒精度（形态对齐 toISOString），头注释写明边界与护栏指向；
- **118 处 toISOString 全量替换**（42 文件，node 脚本机械替换 + import 注入）：`new Date().toISOString()` → `nowLocalIso()`、其余 Date 实例 → `toLocalIso(expr)`；两处链式形态（kb-entries.ts 的 cutoff 计算）单独处理；排查确认 server/src 内**无必须 UTC 的外部协议场景**（TC3 签名在 benefit-auth/Python 侧；server 的 tokenhub.ts 只有 DB 写入与毫秒 TTL 比较）；
- **5 处 `datetime('now')` → `datetime('now','localtime')`**（assess-content.ts 题库建表默认×2 + touch×2、db-channel.ts touchUpdatedAt×1）；
- **护栏** `test/issue168-timezone.test.ts` 3 例：①源码扫描禁 `.toISOString()`（白名单仅 util/time.ts）②禁裸 `datetime('now')` ③toLocalIso/nowLocalIso 形态断言（本地日期/无 Z/毫秒）；
- 存量 UTC 行**不回写**（issue 定案），新旧混存期接受偏差；`new Date(本地ISO)` 解析按本地时区，与写入口径自洽。

**验证**：护栏 3/3 绿；server tsc 0 新错（token-usage/models 的 CategoryDayRow 4 错=并行会话 ISSUE-174 半成品、topic-package 1 错=既有）；server bundle 构建过；全量 vitest 925 过/20 失败——**stash 基线对照确认 4 类失败全部归属并行工作**：issue144-report/issue160/web-shim-coverage 基线即挂；open-voice（400 vs 502）= ISSUE-174 的 ASR tokenhub 兜底改变行为（AsrProviderId+tokenhub、ORDER 首位），非时间戳替换引起。

**待部署 201**：新写入行 created_at 应为本地时区（与旧 UTC 行对照 +8h）；按日筛选（当日/范围）不再漏行；家长端「处理时间」显示本地。
