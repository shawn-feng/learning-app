# ISSUE-179：断连降级改为「阻断等待重连」——服务端已配置的客户端**永不显示本地孩子**（推翻 ISSUE-167 的离线兜底决策）

- **类型**：需求变更 / 客户端改造（用户 2026-10-13 拍板，含排查结论）
- **优先级**：高（生产客户端每天闪现开发期本地孩子，用户明确不可接受）
- **记录时间**：2026-10-13
- **关联**：ISSUE-167（其「真离线仍可用本地孩子」的降级保留决策被本 issue 推翻；可见化+自动重连+降级只读三件保留）
- **状态**：✅ **已实施（2026-10-13，F1~F6 全部落地；纯客户端，服务端零改动）**

## 用户需求原话（2026-10-13）

> 我现在的要求就是断链自动恢复，不要注销，不要显示老版本的本地孩子，不要有老版本的现象。断链了 app 就不能用，要等待重新链接。

逐条翻译成验收标准：
1. 断链自动恢复（ISSUE-167 已有，保留）；
2. 不需要注销重登（ISSUE-167 已自动化，保留）；
3. **永不显示本地孩子**（新——删掉服务端已配置时的 `readLocalProfiles` 兜底）；
4. 断链期间 app 不可用：显示「等待重新链接」阻断态，恢复后自动回到服务端孩子列表；
5. 老版本现象（静默降级、本地孩子闪现、需要注销）一个都不许再有。

## 排查结论（2026-10-13，本 issue 的触发背景；证据见 journalctl）

ISSUE-167 修复**机制上工作正常**（201 日志 3 天 87 次 `/health` 探活，每次断连都是 30s 内单次探活自愈，从无真宕机），但触发频率极高，降级兜底天天出场：

| 客户端 | 3 天探活 | 触发源 |
|---|---|---|
| 127.0.0.1（201 本机 Linux 客户端） | 10 次，**9 次与 `Started learning-server` 时刻对齐到秒级** | **服务端 3 天被部署重启 14 次**（10-10 一天 11 次），每次重启正在使用的客户端全断 |
| 192.168.1.101 | 62 次，全天每小时 1-4 次、与重启无关 | 该机器自身网络每 30-60 分钟微抖（Wi-Fi 省电/驱动/AP，需在那台机器查，应用侧无解） |

每次事件的形态：一条 fetch 失败 → `noteServerUnreachable` 翻转 → 用户此刻若在主页，`listChildren` 回退本地孩子 + 横幅 → 30s 探活恢复。**机制对、体验错**：开发残留的本地孩子出现在生产客户端本身就是事故感。

## 改动清单（纯客户端，client 0.1.23；服务端零改动）

| # | 改动 | 位置 | 说明 |
|---|---|---|---|
| F1 (P0) | **删除服务端模式下的本地孩子兜底**：serverFetch 失败不再 `readLocalProfiles()`，返回 `{ children: [], degraded: true }`（或类型化错误）；`server-connection.json` 存在（生产常态）时本地孩子列表**永不渲染** | `electron/lib/child-auth.ts` `listChildren`（原 ：216-222 的 catch 回退分支） | ISSUE-167 设计第 1 条「真离线仍可用本地孩子」就此作废；`children/<id>/profile.json` 只剩登录/归属断言用途 |
| F2 (P0) | **主页阻断态**：`degraded` 时 Dashboard 用全屏阻断层替代孩子列表——「与服务端断开连接，正在等待重新链接…（已等待 Ns）」+ spinner + 立即重试按钮；不渲染任何孩子入口 | `src/pages/Dashboard.tsx`（替换原降级横幅） | 依赖既有 `server:connectionState` / `retryConnection` / `onServerConnectionChanged` 三通道；阻断期间 **30s 轮询 `serverConnectionState` 自兜底**（防 `piRemoveListeners` 误清监听的老坑，ISSUE-167 实施记录已踩过） |
| F3 (P0) | **恢复自动解锁**：连接恢复（既有 monitor 探活成功→翻转广播）→ 自动重拉 `listChildren` → 阻断层退出，回到服务端孩子列表。全程无感知，不需要任何用户动作 | 既有 connection-monitor + Dashboard 恢复链路 | 建议把 `BASE_MS` 30s 收到 15s（阻断态下等待感更明显）；封顶 5m 不变 |
| F4 (P1) | **超时不再误判为断连**：`serverFetch` catch 里区分 `TimeoutError/AbortError`（服务端慢，≠不可达）与真网络错误（`fetch failed`/ECONNREFUSED/ECONNRESET）——**只有真网络错误才 `noteServerUnreachable()`**。`describeFetchError` 已有同款分类（:27），复用其判定 | `electron/lib/server-client.ts`（五个 fetch 函数的 catch，:71-74 等 5 处） | 防「长工具轮 >timeoutMs 被误判断连→全 app 阻断 30s」——阻断式 UX 下误判代价放大，此项从可选升为必做 |
| F5 (P1) | Web shim 对齐：web 端 children 域同样不回退本地孩子、返回 degraded；Dashboard 阻断层双端共用（组件本就在 src/，天然共享） | `web/src/shim/domains/`（children/misc 域） | web 端刷新即注销的老坑（ISSUE-160）不在本 issue 范围 |
| F6 (P2) | 防回归测试改造：原「服务端不可达回退本地扫描」用例反转为「不回退、degraded 标记」；新增「阻断态渲染 + 恢复自动解锁」用例；`recentlyDegraded` 三道闸保留（兜底虽删，闸门无害） | `test/issue167-connection.test.ts` | passwordHash 双保险（2026-08-31 事故防线）不回退 |

## 不做的事（明确出界）

- **本机数据清理入口 / data 目录按环境隔离**（ISSUE-167 遗留 #3）：F1 后本地孩子不再出场，清理的紧迫性消失，继续挂起。
- **.101 那台机器的网络治理**：机器侧问题（Wi-Fi 省电等），不在应用内；阻断式 UX 下它每小时阻断 30s 是**符合预期的表现**，若要根治去查机器。
- **部署重启频率**（3 天 14 次）：属开发流程问题；阻断式 UX 下每次重启 = 客户端阻断约 30s，用户已接受（「要等待重新链接」）。

## 验收场景

1. 正常使用中 `systemctl restart learning-server` → 客户端当前页面报错一次后，主页/回到主页显示阻断态（无任何本地孩子）→ 服务起来后 ≤15s 自动回到 201 孩子列表，全程无注销；
2. 拔网线/断 Wi-Fi → 阻断态；恢复网络 → 自动解锁；
3. 全程 journal 无「本地孩子被列出」的痕迹（`listChildren` degraded 分支）；
4. 长轮询超时（>15s 慢响应）不再触发阻断（F4）；
5. 老三样回归：静默降级（无横幅/无阻断）不允许出现；本地孩子列表不允许出现；注销重登不允许成为恢复手段。

## 实施记录（2026-10-13）

### 逐项落地

| # | 落地 | 关键文件 |
|---|---|---|
| F1 | `listChildren` 签名改 `Promise<ChildrenListResult>`（`{children, degraded}`）：服务端分支成功 → `{children, degraded:false}`；fetch 失败/**未登录无 token** → `{children:[], degraded:true}`。本地扫描 `readLocalProfiles` 只剩服务端详情缺失时的合并参考，**不再是列表来源**；文件末尾的 `return readLocalProfiles()` 兜底整体删除 | `electron/lib/child-auth.ts` |
| F2 | 新建 `ConnectionBlocking` 全屏阻断层（「与服务端断开连接 / 正在等待重新链接…（已等待 Ns）」+ spinner + 立即重试，双端共用）；新建 `useServerConnection` hook（挂载快照 + 变更推送 + 阻断期 30s 轮询自兜底 + 断连→恢复翻转回调）。Dashboard degraded 时整页阻断（dashboard-body 整体不渲染，孩子入口/侧栏/聊天全部消失）；Home 主页同样阻断（恢复自动重拉列表解锁）；ISSUE-167 降级横幅删除 | `src/components/ConnectionBlocking.tsx`（新）、`src/hooks/useServerConnection.ts`（新）、`src/pages/Dashboard.tsx`、`src/pages/Home.tsx` |
| F3 | 连接监视器探活基速 `BASE_MS` 30s→15s（指数退避 15s→30s→1m→2m→5m 封顶不变） | `electron/lib/connection-monitor.ts` |
| F4 | `server-client.ts` 抽出 `isTimeoutError()`（TimeoutError/AbortError/timeout/aborted），`describeFetchError` 复用；**五个 fetch 函数的 catch 只在非超时（真网络错误）时 `noteServerUnreachable()`**。web shim `request()` 同款对齐（AbortError 不记断连） | `electron/lib/server-client.ts`、`web/src/shim/core/server-fetch.ts` |
| F5 | web shim `childrenDomain.childList` 失败不抛错、返回 `{children:[], degraded:true}`（http 层已记账）；Dashboard/Home/阻断组件本就在 `src/`，web 天然共用 | `web/src/shim/domains/children.ts` |
| F6 | 原「服务端不可达回退本地扫描」用例反转为「degraded 空列表、本地孩子不出现」；新增「断连 degraded→恢复自动回到服务端孩子列表（本地残留不混入）」用例；新增 `issue179-connection-blocking.test.ts`（F4 超时≠断连 3 例 + 阻断层静态渲染断言「等待重新链接/立即重试/无孩子入口」+ web shim childList degraded 契约）。`recentlyDegraded` 三道闸与 passwordHash 双保险不动 | `test/issue167-connection.test.ts`、`test/issue179-connection-blocking.test.ts`（新） |

### 连带适配（childList 形状变更的波及面）

- **主进程内部**：`ipc-handlers.ts` `child:add`（上限计数 `children.children.length`）、`scheduler:config:get`（degraded 时空配置）；`scheduler.ts` `startScheduler` 每分钟循环改遍历 `children.children`（degraded 时本地孩子不参与任何定时逻辑）。
- **渲染层**：`OpenApiSettings`（原已防御式，零改）、`SchedulerSettings`、`FeishuBindPanel`（顺带修掉旧代码读 `r.success/r.data` 恒取不到、下拉恒空的存量 bug）。
- **web shim**：`childList` 返回形状（上述 F5）；`install.ts` 为 spread 装配零改。
- **测试**：`app.test.ts`（1 例）与 `functional.test.ts`（10 例）过去靠「未登录→本地扫描」兜底通过，按新契约改写：本地数据模型断言改扫 `children/*/profile.json`（新 `localProfiles()` helper），并顺带锁定「未登录 → degraded 空列表」契约；`sync.test.ts`（集成测试，服务端未跑时整组 skip）4 处解构改 `.children`。

### 验证

- `vitest` 定向：issue167（5）+ issue179（5）+ app（4）+ functional（16）全绿；
- `npm run build`（electron-vite：main/preload/renderer）与 `npm run web:build` 均通过；
- 全量 vitest：与 stash 基线逐文件对比，本次改动净修复（app/functional 10 例转绿），其余失败均为存量基线（kb-sqlite/learning-summary/parent-library/open-voice/web-shim-coverage/issue144/issue160，与本次无关——web-shim-coverage 缺 `authSetPassword/authParentStatus/authDouyinResetPassword` 系 ISSUE-174 前抖音登录进 Home 时未同步 shim 的存量缺口，另立记录）；
- 根 `tsc --noEmit` 在干净 HEAD 上即报 `TS2318 Cannot find global type`（存量环境问题，与本次无关，未处理）。

### 待生产验证（下个客户端包发布后）

- 验收场景 1~5 需在 201 生产客户端上按场景实测（restart 服务端 / 断网 / 长轮询）；
- 本次为纯客户端改动：**服务端 201 零部署**；客户端版本号随下个发布批次递增（当前 0.1.26 → 0.1.27）。
