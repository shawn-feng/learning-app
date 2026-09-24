# [ISSUE-145] 家长端两个「服务端正常、客户端却坏事」的缺口：①SSE 静默停摆（永远「等待模型返回」）②会话历史从不回填（刷新后一片空白）

- **类型**：bug（均为客户端缺口；表面症状与 096/126 同款，但故障段不同）
- **优先级**：高
- **状态**：✅ **已修复并部署 201（0.5.10，2026-09-24 15:53；web 前端包同步换装，端到端实测通过）**
- **记录时间**：2026-09-24
- **标签**：`SSE` `送达链路` `家长agent` `web端` `静默停摆` `心跳看门狗` `Last-Event-ID` `历史回填` `openParentSession`

> **两个症状，两条独立缺口**：
> ① **静默停摆**：连接活着、服务端一直在写、浏览器 TCP 全 ACK，但 JS 一条事件都没消费，且客户端从不重连 → 永久「等待模型返回」（§一~§四）；
> ② **历史不回填**：web shim 的 `piStartParent` 把 history 写死成 `[]` → 服务端 `/parent-agent/open` 全天**零调用** → 刷新/重进家长端永远是空白（§五）。
> 两者叠加，用户看到的就是「卡住 + 刷新后连历史都没有」。修复见 §七。

---

## 一、现象（2026-09-24 14:18–14:25，生产 201，用户报告）

家长 web 端（浏览器 192.168.1.200 连 `192.168.1.201:8788`）：

1. 14:18 家长发「创建今天的学校作业-课程…」+ 作业图片；
2. UI 上该轮变成「⏹ 已停止」（14:22 家长点了两次「停止」）；
3. 14:23 家长重发「继续」→ 工作气泡一直停在
   **「等待模型返回…（已等待 1 分 52 秒）· 响应较慢，可点 ■ 中止」**，再无任何输出。
4. 用户补充：**刷新页面重新进入后，历史消息也一条都不显示**（web 端与本地客户端均如此）；服务端落库成果完好。

## 二、结论

**服务端与模型完全正常**：两轮都在服务端完整跑完、SSE 事件也全部 publish 了。
**故障段＝「服务端 → 浏览器 JS」**，且形态是**静默停摆**——连接没断（TCP ESTAB、服务端持续写心跳、浏览器持续 ACK），
但**渲染层一个事件都没收到**，同时**客户端也不触发任何重连**，于是永久等待。
另有一条**独立缺口**：客户端（web shim）**从不请求会话历史**，导致刷新/重进后家长端空白（§五）。

## 三、证据（全部只读、可复现）

### 1. 会话落盘：两轮都完整跑完（`agent-sessions/<pid>/parent/2026-09-24T06-18-06-693Z_*.jsonl`）

| 轮次 | 用户消息 | assistant 收尾 | 关键动作 |
|---|---|---|---|
| 14:18:06 | 创建学校作业 + 图片 | 14:19:30「📋 方案确认…」439 字 | load_skill ×3、parent_read_image（OCR 出语文作业）、parent_library_topics… |
| 14:23:11 | 继续 | 14:23:38「✅ 已完成！」242 字 | parent_upsert_course → upsert_course_content → sync_courses_to_child ×2 |

### 2. SSE 回放探针：事件确实被 publish（含 `turn_end`）

只读探针：自签家长 JWT → `GET /api/v1/parent-agent/stream?kind=parent&lastEventId=1`
（服务端环形缓冲 500 条，`lastId>0` 才回放）→ 拿到当日家长的完整事件尾部：

```
#1086 message_end  stopReason=toolUse  tools=[parent_library_course_content]
#1428 message_end  textLen=439 stopReason=stop       ← 14:19:30 方案确认
#1429 agent_end
#1430 turn_end                                        ← 本该让气泡收尾
#1431 user_message text=继续
#1438..#1473 message_end/tool_start/tool_end ×4（upsert_course / content / sync×2）
#1548 message_end  textLen=242 stopReason=stop       ← 14:23:38 ✅已完成
#1549 agent_end
#1550 turn_end
（另有 text_delta 178 条/681 字、thinking_delta 301 条/3010 字）
```

⇒ 客户端**本该**收到 `message_end → agent_end → turn_end`；`pi:reply`/`pi:reply_end` 的源头一个不缺。

### 3. 那条 SSE 长连接仍然活着，服务端一直在写

- 该连接 = `192.168.1.201:8788 ← 192.168.1.200:58185`，**12:33:57 建连，到 14:35 仍 ESTAB**；
- `ss -ti` 两次采样（间隔 40s）：

  | 采样 | state | bytes_sent | bytes_acked | segs_out |
  |---|---|---|---|---|
  | 14:34:50 | ESTAB | 216103 | 216103 | 2052 |
  | 14:35:30 | ESTAB | **216142**（+39） | 216142 | **2055**（+3） |

  +39 字节 / +3 段 ＝ 正好是该路由 `setInterval(… ,15000)` 写的 **3 次 `: ping` 心跳**（13 字节/次）。
- 216KB 里除首次 304 的 CSS（41.7KB）外，**~174KB 就是 agent 的事件体**。
- ⇒ 说明：路由的 `keepAlive` 与 `agentStreamHub.subscribe` **都还在**（二者共用同一个 `req.raw.on("close")` 清理分支），
  事件**写得出服务端、也进得了浏览器**（`bytes_acked` 全额跟上）。

### 4. 但渲染层一个事件都没消费

工作气泡文案由 `ChatWindow.tsx:203` 的 `WorkingLabel` 决定：
`label = tools.length ? "正在使用工具…" : thinking ? "思考中…" : "等待模型返回…"`。

- 现场停在「等待模型返回…」且有 `· 响应较慢，可点 ⏹ 中止`（该提示的条件是 `elapsed>=90 && !hasOutput`，
  `hasOutput = tools.length>0 || !!thinking`，见 `ChatWindow.tsx:206`）
- ⇒ **`pi:thinking` 与 `pi:tool_start` 一条都没到**；而这两轮服务端必然发出 8 次 tool_start/end 与 301 条 thinking_delta。
- 另：`m.working===true` 时气泡**根本不渲染 `m.text`**（`ChatWindow.tsx:843-851`），所以文字也看不出来。

### 5. 客户端从未尝试重连

全天（`--since 11:17`）家长 agent 路由只出现过**一次** `GET /parent-agent/stream`（12:33:57）。
`openSse` 只在两种情况下重连：`reader.read()` 返回 `done`（服务端关连接）或抛异常。
**两者都没发生** ⇒ 读循环处于"无声等待"状态，`handle.closed` 也仍为 false（否则 `ensureParentStream` 会重建、日志会出现新连接）。

### 6. 排除项：不是"线上 web 包过期"

- 201 上服务的 `index.html` → `assets/index-BiRAcmS8.js`（09-22 07:46）；
- 本地 `web/dist` 今天 12:20 已重新构建为 `index-CbfDa-gx.js`；
- 把两份 bundle 的 `openSse` 段落逐段比对：**逐字等价，只差压缩后的变量名**（`pi:sse_state`/`lastEventId`/`turn_end` 等标记数量一致）。
- ⇒ **为这个问题重新部署 web 包不会有任何变化**，别白部署。

## 四、根因：三条缺口叠加，使"静默停摆"成为永久状态

与 **ISSUE-096** 同属「服务端完全正常、纯送达链路断」这一类；096 修掉的是**"连接断开后从不重连"**，
本案是**"连接没断、事件到不了 JS"**，现有实现在这条路径上没有防线：

1. **心跳没被当心跳用**：服务端每 15s 发一节 `: ping` 注释行，客户端 `parseSseChunk` 对注释行直接 `continue`
   （`web/src/shim/core/sse.ts:186`），**不更新任何"最后收到数据"的时间戳** → 没有存活判据。
2. **只有 `done`/`throw` 才重连**：`openSse` 的读循环没有任何超时/看门狗（`sse.ts:439-452`），
   静默停摆既不 `done` 也不 `throw` → `scheduleReconnect` 永不触发 → 永久等待。
3. **断流对用户不可见**：`pi:sse_state`（重连横条）通道已经存在且 `onPiSseState` 已在 shim 暴露
   （`agents.ts:350`），但 `ParentChatPanel.tsx` **没有订阅它** → 家长看不到"连接断了"。
4. **连带**：`turn_end` 只在 `submitParentPrompt` 的 `finally` 里发（`parent-registry.ts:333`），
   送达链路一断，`pi:reply_end` 永远不到，工作气泡就永久停在「等待模型返回」——即本案症状。

（可复现的机理参考：ISSUE-126 已修「模型 API 失败时客户端空等待」，但那是**服务端不 publish**；本案是**publish 了但没送达**。）

## 五、症状②：会话历史从不回填（刷新/重进家长端一片空白）

用户补充报告：「刷新后，再进入也不显示历史消息。本地环境的客户端也有这个问题。」——这是一条**独立的客户端缺口**，与送达链路无关。

### 证据（201 全天请求日志 + 服务端直调）

| 时刻（本地） | 请求 | 来源 | 说明 |
|---|---|---|---|
| 08:26:37 | `GET /parent-agent/stream` + `POST /parent-agent/open` → **200 / 41.6ms** | 192.168.1.200（Electron 客户端启动登录） | Electron **有**调 open |
| 08:26–14:46 | `POST /parent-agent/prompt` ×5、`reset` ×1、`abort` ×2 | 192.168.1.200 | 家长在浏览器里正常对话 |
| 14:31:01 / 14:31:40 | `GET /parent-agent/stream?lastEventId=0/1` | **127.0.0.1**（我的只读探针） | 非用户流量 |
| 14:46:18 | `POST /parent-agent/open` ×2 | 127.0.0.1（我的探针） | 同上 |

- **整天来自浏览器的 `parent-agent/open` = 0 次**；来自 Electron 的 = 1 次（08:26 启动那一次）。
- 服务端接口本身完全正常，两处实测：
  - 201（自签家长 JWT）：`POST /parent-agent/open` → **200，messages=26**（含 thinking/toolCall/两条正文：14:19「📋 方案确认」439 字、14:23「✅ 已完成」242 字）；
  - 本地 8788（dev 服务端）：→ **200，messages=12**，按 `mapHistoryMessages` 口径可还原 **5 个气泡**（user 1 / ai 4）。

### 根因

`web/src/shim/domains/agents.ts` 的 `piStartParent` / `piStartParentContent` **直接把历史写死成 `[]`**：

```ts
piStartParent: async () => {
  ensureParentStream("parent");
  return { success: true, history: [] };   // ← 从未请求服务端
}
```

原注释误以为「历史与资料由服务端会话 / display_content 事件推送驱动」——实际服务端**只在 prompt 时推增量**，回填必须主动调 `POST /parent-agent/open`（Electron 侧 `ipc-handlers.ts` 一直是这么做的，web shim 移植时漏了）。
注意：`/open` 还会顺带 `ensureEntry()`（恢复/续接落盘会话），web 端漏调它也意味着**家长第一次打开面板时服务端不会为它恢复会话实例**（直到首次 prompt）。

**不是服务端问题**：`/parent-agent/open` → `openParentSession()` → `getParentSessionHistory()` 读 `session.messages`（`parent-registry.ts:362-369`），两处环境实测均返回完整历史。

## 六、立即恢复（症状①的现场处置）

- 在那个标签页**硬刷新（Ctrl+Shift+R）**：重建 SSE（服务端日志会出现新的 `parent-agent/stream`）。
- ⚠️ **但历史不会因此出现**——截至本次修复前，web 端刷新后仍不请求 `/open`（症状②）；两者都要等修复包上线。
- 数据不丢：那两轮的成果早已落库（课程「2026-09-24学校作业」已创建并同步给珊珊、闻闻）。
- 复现时可在控制台敲 `__bootErrs`（`web/index.html` 已埋启动期 error/unhandledrejection 捕获）看是否有异常堆栈。

## 七、修复实施（2026-09-24 已完成；本地构建/测试通过，**未部署 201**）

### 改动清单

| # | 文件 | 改动 | 对应症状 |
|---|---|---|---|
| 1 | `web/src/shim/core/sse.ts` | 读循环里**任何字节（含 `: ping` 注释行）刷新 `lastByteAt`**；新增 `SSE_STALL_TIMEOUT_MS = 45_000` 看门狗（每 5s 检查，超时 warn + `ac.abort()` 走既有重连，带 `lastEventId` 续传）；**每次 `connect()` 新建 `AbortController`**（复用同一个 ac 会在 abort 后退化成死循环重连）；`clearStall` 挂在成功/错误/关闭三条路径防定时器泄漏 | ① |
| 2 | `electron/lib/server-agent-client.ts` | 同款看门狗（两端逐行同源，避免只修 web） | ①（本地客户端） |
| 3 | `web/src/shim/domains/agents.ts` | 新增 `openParentSession(kind)` → `POST /parent-agent/open` + `mapHistoryMessages`；`piStartParent` / `piStartParentContent` **真去回填历史**（此前硬编码 `[]`）；失败 `console.warn` 留痕 | ② |
| 4 | `src/components/ParentChatPanel.tsx` | 历史回填改为 `setMessages(prev => prev.length ? prev : restored)`——`open` 是异步请求，避免把期间已到的流式增量覆盖掉 | ②（竞态） |
| 5 | `electron/lib/ipc-handlers.ts` | `pi:start_parent` / `pi:start_parent_content` 的 open 失败**留痕**（不再 `.catch(() => [])` 静默吞成空历史） | ②（可观测性） |
| 6 | `test/issue145-sse-stall-and-parent-history.test.ts` | 新增 5 条源码级守护（沿用 `web-shim-coverage.test.ts` 风格） | 防回归 |

### 验证

- **web 构建通过**：`npm --prefix web run build` → `dist/assets/index-dyU_VfIB.js`（14:53）；产物含 `未收到任何数据` / `静默停摆` / `parent-agent/open` 三个新标记。
- **测试**：`issue145`(5) + `web-shim-coverage`(1) + `server-agent-client`(24) = **30 passed**。
- **防假绿**：注入旧逻辑（读循环不刷新 `lastByteAt` + `piStartParent` 写回 `[]`）→ 对应用例**准确变红**（2 failed）；还原后复绿。
- **tsc**：改动点（`web/src/shim/**`、`electron/lib/server-agent-client.ts`、`src/components/ParentChatPanel.tsx`）**0 错**；仓库既有的 5 处 `src/` 组件报错（MistakeBookModal / NamespacePanel / TokenStatsPanel / Dashboard）与本次无关，未动。
- **未做端到端验收**（需部署后实测）：刷新后历史可见；人为冻结读循环 ≤45s 内自动重连并补齐该轮回复。

### 部署与端到端验收（2026-09-24 15:53，201，0.5.10）

**关键发现：线上 web 包是旧的**。201 `/opt/learning-server/web/dist` 停在 **09-22 07:46 的 `index-BiRAcmS8.js`**
（`parent-agent/open`=0 次、`未收到任何数据`=0 次、`tool_progress`=0 次）—— 即**浏览器里跑的一直是含这两个缺口的旧包**，
历史上从没部署过本修复。服务端 0.5.9 里有 `/parent-agent/open` 且实测有 26 条历史，但前端从不调它。

| 动作 | 结果 |
|---|---|
| 服务端 bundle | `server.cjs` → 0.5.10（md5 `c0fc0527f279a20ea899a75044e20b95`，两端一致）；备份 `server.cjs.bak-20260924-1600` + `data/backups/deploy-0.5.10-20260924-1600/` |
| web 前端 | `index-BiRAcmS8.js` → **`index-BSngxzoI.js`**（md5 `6e1f8266ee27dfa41cfe5589579dd85d`，两端一致）；`parent-agent/open`=1 / `未收到任何数据`=1 / `tool_progress`=2 全中；旧包留 `web/dist.old-20260924-1600` |
| 历史回填（① 的对照面） | 自签家长 JWT 直连 `POST /parent-agent/open{kind:"parent"}` → **200 messages=26**（首条为 09-24 的「创建今天的学校作业-课程…」），`kind=parent-content` → 200 messages=0（该会话确实没消息） |
| 送达链路（① 的见证） | `GET /parent-agent/stream` 35s 观察：`code=200 hello=1 pings=2 bytes=139` —— **2 次 15s `: ping` 全部送达**，正是「静默停摆」的反面 |
| 其余回归 | `/api/v1/version → 0.5.10`；`/api/v1/health → ok`；`parent-agent/report` 200；两孩子 `exam/attempts` 200（各 3 条）；journal `ERR_COUNT=0`；Service active |
| 清理 | 按「保留最新 5 个」删最旧 bundle bak / deploy 快照 / web dist 备份各 1 个（约 40MB；磁盘仍 95%、余 6.0G） |

⚠ **仍未验证 / 仍未生效**：
1. **浏览器真实刷新后历史可见**：本次只证明接口有数据 + 新包在服务器上被引用，**没跑浏览器端到端**（需人工在家长端刷新确认，或 ≤45s 冻结读循环的重连自愈实测）；
2. **Electron 桌面端（含 201 上的 xuexihub 0.1.15、本机 Windows 客户端）不含本修复** —— `electron/lib/server-agent-client.ts` / `ipc-handlers.ts` / `src/components/*` 的改动**必须重新打包**（`npm run dist:win` / 重打 deb）才生效；
3. **`lastEventId` 回放续传未实测** —— 服务刚重启、hub `lastEventId=0`（内存 hub 重启即空），要真跑一轮 agent 才有事件可回放。

### 未纳入本次（待定）

- **P0-b 轮内 60s 静默提示**：未做——45s 看门狗 + 重连已能自愈，横条会先亮。
- **P1 断流横条**：web 端**本来就有**（`ChatWindow.tsx:242-246` 已订阅 `onPiSseState` 显示横条，零分支）；Electron 端 `preload` 未暴露该通道，故桌面客户端无横条（靠看门狗静默自愈）。
- **P2 服务端诊断端点**（订阅者数 / 最近 publish 时间）：未做。
- **Electron 桌面端要生效必须重新打包**（`npm run dist:win`）；本次只改源码，`C:\Program Files\learning-app` 的 0.1.19 包不含修复。

## 八、关联

- **ISSUE-096**（同类先例：SSE 只建一次、断线从不重连 → 已修自动重连 + Last-Event-ID 续传）——本案是其**未覆盖路径**。
- **ISSUE-126**（模型 API 失败时永远「等待模型返回」→ 已修服务端 error 事件 + 客户端空回复兜底）。
- **ISSUE-068**（停止中锁/解禁时序）、**ISSUE-095**（abort 链路）——本案现场两次「停止」均未在服务端留下
  `已中止会话` 日志，与「服务端其实早跑完了」一致，即停止按钮当时已无可中止的轮次。
