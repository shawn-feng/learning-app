# [ISSUE-096] 服务端重启后家长/孩子 agent「永远思考中」：SSE 流只建一次、断线从不重连

- **类型**：bug（薄客户端 SSE 无重连机制，服务端重启/网络闪断后事件全部丢失）
- **优先级**：高
- **状态**：✅ 已解决（2026-09-14）
- **记录时间**：2026-09-14
- **标签**：`SSE` `server-agent-client` `断线重连` `Last-Event-ID` `家长agent`

---

## 一、现象（2026-09-14 10:49 实测）

本地服务端重启后，家长 agent 发「你好」→ 气泡一直「思考中」，无任何输出；多次重发同样。服务端侧一切正常。

## 二、根因（日志 + 会话落盘实锤）

服务端**完全正常**：`server-log.jsonl` 显示每次 POST /prompt 200；parent 会话 jsonl 落盘里每条用户消息都有完整 assistant 回复（「你好」→「你好！😊 有什么可以帮您的吗？」，stopReason: stop）。问题纯在**事件送达链路**：

- `electron/lib/server-agent-client.ts` 的 `openSse` 是一次性连接：断开后 `onError` 触发一次即死；
- `ipc-handlers.ts` 的 `ensureParentStream`/`ensureChildStream` 用 `agentStreams` Map 缓存句柄且 `if (agentStreams.has(key)) return`——**死句柄永远占位、无任何重连**；
- 服务端 10:48 重启 → SSE 断 → 此后所有 prompt 的 text_delta / message_end / turn_end 全部丢失 → 前端永远等不到 `pi:reply_end` →「思考中」卡死。
- 日志时间线吻合：10:49:05 用户点停止（ISSUE-095 abort 真实生效，服务端日志「已中止会话…的当前一轮」）→ 后续多轮服务端均正常回复落盘，前端全部看不到。

**触发条件**：服务端重启（或任何网络闪断）之后，客户端不重启。此前一直存在，只是没人重启过服务端。

## 三、修复（2026-09-14）

`openSse` 重写为**自动重连 + Last-Event-ID 续传**（`streamChildAgent` / `streamParentAgent` 改传 URL 构建器）：

1. 每次连接重建 URL（取最新 `serverBase()` / `sessionToken()` / `lastEventId`）；
2. 断线/服务端关闭 → 静默指数退避重连（2s 起步、每次 +2s、上限 15s），不报错不打扰；
3. 重连时带 `?lastEventId=`，服务端回放缺失事件——断线期间正在跑的那一轮（含 turn_end）也能自动补齐显示；
4. 仅 401/403（登录态失效，重连无意义）才回调 onError 终止并提示重新登录；
5. `close()` 清理重连定时器 + abort（退出应用不泄漏）。

`ensure*Stream` 的「Map 缓存 + has 即返回」语义由此变正确：句柄常驻且永远自愈。前端零改动。

## 四、验证

- 根 `tsc --noEmit` 通过（仅 5 条预存环境级错误）。
- 实机：重启服务端 → 客户端不重启 → 发消息应正常回复；重启期间若有一轮在跑，重连后该轮回复应自动补齐。

## 五、关联

- ISSUE-095（pi:abort no-op）修复时发现并定位本 issue；ISSUE-095 的 abort 链路本身已在实测中验证生效。
- 服务端 SSE 路由本就支持 `Last-Event-ID` 头与 `?lastEventId=` 查询参数回放（`routes/agent.ts` / `routes/parent-agent.ts`），客户端此前一直没用上。
