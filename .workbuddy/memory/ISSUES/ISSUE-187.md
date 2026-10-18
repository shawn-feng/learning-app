# [ISSUE-187] 孩子端「发消息永远等待模型返回，退出重进才看到消息」（Mac 客户端 0.1.30）

- **类型**：bug（Electron 薄客户端 SSE 死句柄永久占位，401 后不再重建）
- **优先级**：高（孩子端主链路不可用；家长端不受影响，故此前未被发现）
- **状态**：✅ 已修复（本地代码 + 回归；待打包客户端 0.1.31）
- **记录时间**：2026-10-17
- **标签**：`SSE` `server-agent-client` `ipc-handlers` `401` `session token` `Mac` `孩子agent`

---

## 一、现象（用户报告，2026-10-17）

> 珊珊的账号，在 Mac 上用客户端 app（最新 0.1.30）进入珊珊的会话界面，发消息后 agent 一直显示「等待模型回复」。退出后再进入，消息就显示出来了。家长 agent 没有问题。

补充特征（现场日志印证）：

1. 只有**孩子会话**坏；家长聊天同一台 Mac、同一账号完全正常；
2. 服务端**确实收到了消息并正常跑完**（会话落盘有完整回复），客户端就是收不到流式事件；
3. 「退出重进」= 走 `/agent/:childId/open` 拉历史 → 回复又出现了（所以用户以为「过一会儿才好」）；
4. 期间点「停止」按钮可正常中止服务端那一轮（`POST /abort` 200）。

## 二、现场取证（201 生产日志，只读）

家长 `86a84278…`、孩子（珊珊）`1f050a7f-df8a-45b0-925a-1ffe2aa35674`、Mac 客户端 `192.168.1.101`。

关键时间线（`/opt/learning-server/data/logs/server-log.jsonl`）：

| 时刻 | 事件 | 说明 |
|---|---|---|
| 10-10 12:39 | （JWT 签发）`iat=1791607141` | 会话 token **7 天 TTL**（`exp=1792211941`） |
| 10-17 **12:39** | **token 到期** | app 从 10-10 起一直开着，期间未重新登录 |
| 10-17 **13:07:21** | `GET /api/v1/agent/1f05…/stream?…&lastEventId=28787` → **401** | Mac 休眠/网络抖动后 SSE 自动重连，带的是**已过期 token** |
| 13:07 之后 | **全天再无任何 `/stream` 请求** | 关键：客户端没有再重连、也没有重建 |
| 17:27:22 | `GET /auth/parent-status` → 401 | 用户此时才发现掉登录 |
| 17:28:32 | `POST /auth/douyin` → 200 新 token | 重新登录成功 |
| 17:28:56 | `POST /agent/1f05…/open` → 200 | 进会话（历史正常回填） |
| 17:32:47 | `POST /agent/1f05…/prompt` → 200 | 服务端开始跑这一轮 |
| 17:33:23 / 17:33:27 | `POST /abort` ×2 | 用户等不到任何输出，点停止 |
| 17:33:38 | prompt → 200 | 再发一次 |
| 17:38:01 / 17:38:03 | abort ×2 | **等了 4 分 23 秒**，仍然一个字都没有 |
| 17:38:12 | `POST /auth/login` → 200 | 退出重登（换 token） |
| 17:38:33 | `POST /agent/1f05…/open` → 200 | **重进会话：之前几轮的回复都在**（正是用户描述的「退出再进就显示」） |
| 17:38:48 | prompt → 200 → 17:39:13 abort | 仍然收不到 → 再重进 |
| 17:44:23 | prompt → 200 → 17:44:50 重进 | 依旧如此 |

> 整个 10-17 只有**一条** `/stream` 请求（即 13:07 那条 401）。若流被正常重建，每次进会话/发消息都会看到新的 `GET /agent/…/stream`。

## 三、根因（两处叠加）

### 3.1 直接根因：401 后的「死句柄」在 Electron 主进程里永久占位

`electron/lib/server-agent-client.ts` 的 `openSse` 在 **401/403**（登录态失效）时把自身置为终态：

```ts
if (res.status === 401 || res.status === 403) {
  onError?.(`流连接失败（HTTP ${res.status}）：登录态可能已失效，请重新登录`);
  clearStall();
  closed = true;   // 此后永不再重连
  return;
}
```

但返回给上层的 `StreamHandle` **只暴露 `close()`，不暴露 `closed`**。而 `electron/lib/ipc-handlers.ts` 的
`ensureChildStream` / `ensureParentStream` 只判断「Map 里有没有这个 key」：

```ts
if (agentStreams.has(key)) return;   // 死句柄也命中 → 永不重建
```

于是 13:07 那次 401 之后：

- 该孩子的事件流在本进程内**永久静默**（既不再连、也不报错）；
- 用户 17:28 重新登录拿到新 token，`/open`、`/prompt`、`/abort` 全部正常（都是 HTTP，每次现取 token），
  唯独 SSE 不会重建 → **消息只进不出**；
- 服务端把这一轮正常跑完并落盘，客户端一条事件都收不到 → 工作气泡永远停在「等待模型返回…」；
- 退出重进走 `/open`（HTTP + 新 token）→ 历史里有回复 → 表现为「重进就显示出来了」。

**为什么家长 agent 正常**：家长流是 17:38:12 重新登录**之后**才建立的（`parent-agent/open` 17:38:12），
token 新鲜、连接没死；而孩子流是登录前就存在的死句柄。谁先遇到 401 谁就永久哑掉。

### 3.2 触发条件：7 天 TTL 的 session token 在长开 app 里过期

服务端 JWT `expiresIn = 7d`（`server/src/auth/jwt.ts`，由 `ttlDays` 传入），客户端只在**启动 / 登录 / 家长密码验证**
时换新 token。app 连续开着超过 7 天后：

- 所有 HTTP 请求开始 401（用户会看到掉登录）；
- **任何一次 SSE 重连**（休眠唤醒、网络切换、服务端重启）都会用过期 token 换 401 → 触发 3.1 的永久死句柄。

本案即 10-10 登录 → 10-17 12:39 到期 → 13:07 一次重连命中 401，之后 4 小时全部静默。

### 3.3 同源隐患（本轮一并修）

- 家长流的 key 恒为 `parent:parent`：**换账号登录**后 `ensureParentStream` 会复用上一个账号的活句柄 →
  新账号可能看到旧账号的事件（跨账号串流）；
- 登出也不关闭任何流（旧 token 的连接继续挂着）。

## 四、修复（客户端，主进程；服务端零改动）

1. `electron/lib/server-agent-client.ts`
   - `StreamHandle` 新增 `readonly closed: boolean`（终态判据，与 `web/src/shim/core/sse.ts` 既有语义对齐）；
   - `openSse` 返回值用 getter 暴露 `closed`；401/403 分支补一行 `console.log`（便于下次远程定位）。
2. `electron/lib/ipc-handlers.ts`
   - 新增 `dropClosedStream(key)`：**句柄已终态 → 先删再建**；`ensureChildStream` / `ensureParentStream` 均改为
     「有活句柄才复用」——重新登录后的首次进会话/发消息即重建（发消息前 `pi:prompt` 也会 ensure）。
   - 新增 `resetAgentStreams(reason)`：`auth:login` / `auth:register` / `auth:verify`（家长密码验证会换发 token）/
     `auth:douyin-login` / `auth:logout` 时关闭并清空全部流 → 换账号不串流、新 token 立即生效。
3. `package.json`：客户端版本 `0.1.30` → **`0.1.31`**（待打包 Mac/Windows 包）。

> 不动的部分：服务端 SSE 路由/hub/会话注册表、Web 端（本就有 `closed` 判据与 `disposeChild`）。

## 五、验证

- 新增回归 `test/issue187-sse-closed.test.ts`（4 例）：401 → `onError` 一次 + `closed=true`；403（家长流）同；
  正常连接 `closed=false`、`close()` 后 `true`；事件帧照常解析且 close 后不再重连。
- 既有 `test/server-agent-client.test.ts` 27 例不回归（合计 31/31 绿）。
- `npm run build`：**主进程/预加载构建通过**，产物 `out/main/index.js` 已含 `get closed()` 与
  「死句柄先删再建」逻辑（`grep` 核实）。⚠️ 本机渲染层构建在本轮环境里稳定报
  `[vite:esbuild-transpile] remove …esbuild-xxx: Access is denied`（esbuild 退出时删临时二进制被拒，
  与本次改动无关——本轮未动渲染层；换 TEMP 目录同样复现），打包 Mac 包请在 macOS 侧构建验证。
- `tsc --noEmit`（用 server 侧 TS 5.9，根目录 TS 7.0.2 本身缺 lib 无法跑）：无新增错误（既有类型债不变）。

## 六、发布/使用说明

- Mac 安装 **0.1.31** 后：token 过期 → 重新登录 → **首次进会话或发消息即自动重建事件流**，
  不再需要「退出重进」；若登录态失效当下正在会话页，会看到明确错误气泡「流连接失败（HTTP 401）…」。
- 已装 0.1.30 的现场应急：**完全退出 app（Cmd+Q）再启动**（重建主进程 = 清掉死句柄），
  或重登后进会话前重启一次 app。

## 七、遗留建议（未做，需拍板）

1. **会话 token 滑动续期**：`/auth/license` 已在校验 token，可顺带回签新 session token（客户端 checkAuth 采纳），
   彻底消除「长开 app 7 天后全端 401」；服务端 + 客户端小改，需部署 201。
2. **渲染层提示**：`ChatWindow` 里 `sseDown` 状态目前是死代码（从未被置 true），可接 `pi:sse_state`
   或 `pi:reply_error`，让断流/掉登录在聊天区可见（Web 已发 `pi:sse_state`，Electron 未发）。

## 八、为什么「断流 / 掉登录」的历次修复没兜住（用户追问的结论）

结论：**不是旧修复失效，而是它们各自只覆盖一条路径，本案落在这些路径的缝隙里**；并且**「401 终止后要能重建」这一格，Electron 从来没人实现过**（Web 后来补了）。

### 8.1 历次修复各自覆盖什么、边界在哪

| 旧 issue | 修的是什么 | 为什么盖不住本案 |
|---|---|---|
| **ISSUE-096**（2026-09-14）「SSE 只建一次、断线从不重连」 | `openSse` 改为自动重连 + `Last-Event-ID` 续传；**断线/服务端关闭**都能静默自愈 | 正文明确：「**仅 401/403（登录态失效，重连无意义）才回调 onError 终止**」。即 096 把 401 设计成**终点**，而不是"待续期后重连"；它只改了 `openSse`，**没改 `ensure*Stream` 的 `has()` 判据**（当时 Map 里缓存的一直是活句柄，问题没暴露） |
| **ISSUE-145**（2026-09-24）「SSE 静默停摆（永远等待模型返回）」 | 治的是**无字节、无异常、无 done** 的静默停摆：任何字节（含 `: ping`）刷新 `lastByteAt` + 45s 看门狗 `abort()` 走重连 | 本案是**显式 401**（有 HTTP 响应、有异常分支），不是静默停摆；而且 145 的重连用的是 `sessionToken()` 里那份**已过期**的 token → 重连一次就撞 401，正好落进 096 的"终止"分支。145 自己也写明「Electron 端 preload 未暴露 `pi:sse_state`，桌面客户端无横条，靠看门狗静默自愈」——**桌面端连失败都看不见** |
| **ISSUE-167 / ISSUE-179**（2026-09-28 / 2026-10-13）「断链自动恢复、不注销、阻断等待重连」 | 治的是**服务端不可达**：`serverFetch` 抛网络错 → 连接记账翻转 → `/health` 退避探活 → 恢复广播 → 撤阻断层 | 401 是**拿到了 HTTP 响应 = 服务端可达**（`server-client.ts` 里"任意响应都 `noteServerReachable()`"），所以连接状态始终是 healthy：**不阻断、不探活、不恢复**。179 的 F5 还明确写了「web 端刷新即注销的老坑（ISSUE-160）不在本 issue 范围」 |
| **ISSUE-160**（2026-09-27）「网页刷新即被踢回登录页」 | 治的是**授权/许可层**：删掉"本地 `expires_at` 过期即登出"的硬检查，改服务端权威 + 离线降级；`/auth/license` 401 才清凭证 | 管的是 **license 授权**，不是**服务端自己签的 session JWT**。本案是 `signSession(..., tokenTtlDays=7)` 的 **JWT 自身 7 天 TTL 到期**——160 既不续签 JWT，也不碰 SSE。现场用户在 17:27 撞到 `auth/parent-status` 401 才发现；重登换到新 JWT 后 HTTP 全部恢复，但 160 的语义（不因本地缓存过期就踢人）并不能让已经死掉的事件流复活 |
| **ISSUE-164 追加**（2026-10-08/09）「任务门禁 authCheck 过期保留凭证」 | 治的是**抖音任务未解锁**时不能清凭证 | 同为授权层，与 session JWT / SSE 无关 |

### 8.2 平台差异：Web 有 `closed` 判据，Electron 一直没有

- `web/src/shim/core/sse.ts` 的 `StreamHandle` 从**纯浏览器 Web 前端**那次提交（`2f7dac6`）起就带 `closed`，且 `ensureChildStream` 判 `existing && !existing.closed`，还有 `disposeChild()`；
- `electron/lib/server-agent-client.ts` 的 `StreamHandle` 在此之前**只有 `close()`**，`ipc-handlers` 的 `ensure*Stream` 只看 `agentStreams.has(key)`（`git log -S "readonly closed"` 在该文件为空）。
- ⇒ 于是「401 后重建」这一格：**Web 端早就兜住了，Mac/Windows 桌面端从来没兜住**。同一台机器上如果改用网页版，表现会不一样——这也是"为什么偏偏客户端上坏"的关键。

### 8.3 为什么偏偏在这台 Mac 上被踩中

三个条件同时成立才会触发（缺一不炸）：

1. **app 长开超过 7 天没重登**：现场 JWT 是 10-10 12:39 签的，10-17 12:39 到期。桌面 app 只要中途不重启/不重登，就会走到这一步（Web 端刷新页面就会重跑 `authCheck`，撞上的概率低得多）。
2. **过期后恰好发生一次 SSE 重连**：`.101` 这台 Mac 的网络每 30~60 分钟微抖一次（ISSUE-179 §排查结论实测：3 天 62 次探活，与 reboot 无关）——13:07 那次重连就是微抖触发的，带着过期 token → 401 → 死句柄。
3. **且没人把它救回来**：401 之后 `pi:reply_error` 只发给"当时在会话页"的渲染层（用户当时不在）；重新登录只换 HTTP token，`ensure*Stream` 仍命中死句柄 → 后续 4 小时 `/prompt` 全 200、客户端 0 事件。

### 8.4 给后续修复的教训（写进口径）

- **"重连策略"和"句柄生命周期"是两件事**：096/145 把"重连"做对了，但没有人负责"这条流已经死了之后，谁负责新建一条"。
- **401 不是网络故障**：所有基于"可达性"的恢复机制（167/179 的 health 探活）对它天然免疫，必须单独处理。
- **"重新登录"必须能让所有长连接重生**：登录/登出/换账号都应 `resetAgentStreams`（本次一并做了），否则"重登也没用，只能重启 app"。
- **平台实现要对齐**：同一份语义在 `web/src/shim/core/sse.ts` 与 `electron/lib/server-agent-client.ts` 双实现，**这次就是只补了一边**；后续这类改动要两边同 PR、同测试（本次回归用例已按契约写，可被两端复用）。
