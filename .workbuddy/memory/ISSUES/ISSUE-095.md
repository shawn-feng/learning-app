# [ISSUE-095] 家长端点「停止」agent：UI 显示「已停止」但实际仍在运行（pi:abort 是 no-op，服务端无中止能力）

- **类型**：bug（agent 中止链路未接通，薄客户端遗留 no-op）
- **优先级**：中（功能正确性缺陷；可能导致用户以为停了、agent 仍继续执行工具/落库——如继续建课、改资料）
- **状态**：✅ 已解决（2026-09-14）
- **记录时间**：2026-09-14
- **解决摘要**：利用 SDK 原生 `AgentSession.abort(): Promise<void>`（"中止当前操作并等待 agent idle"）接通全链路——
  1. `server/src/agent/session-registry.ts` 新增 `abortSession(parentId, childId, kind?)`：kind 省略时中止该孩子全部会话（main/scene/course）中 busy 的一轮，返回中止数；
  2. `server/src/agent/parent-registry.ts` 新增 `abortParentSession(parentId, kind?)`：同构；
  3. `server/src/routes/agent.ts` 新增 `POST /api/v1/agent/:childId/abort`（家长 JWT + assertChildOwned，body.session 可选限定 main/scene/course:）；
  4. `server/src/routes/parent-agent.ts` 新增 `POST /api/v1/parent-agent/abort`（body.kind=parent|parent-content）；
  5. `electron/lib/server-agent-client.ts` 新增 `abortChildAgent` / `abortParentAgent`；
  6. `electron/lib/ipc-handlers.ts` 的 `pi:abort` 从 no-op 改为按 childId 语义（"parent"/"parent-content" → 家长会话，否则孩子会话）调服务端端点，失败仅记录不阻塞前端。
  中止后 submit 的 finally 清 busy 并经 SSE 推 turn_end → 前端 pi:reply_end 解禁忙碌态；前端 ParentChatPanel/Learn 的 handleStop 无需改动。
- **标签**：`家长agent` `agent中止` `pi:abort` `parent-agent` `no-op`

---

## 一、现象（用户反馈）

家长端（右侧「家长助手」面板）对话进行中，点发送按钮变成的「停止」按钮：
- 前端消息气泡立刻变成「⏹ 已停止」，按钮也恢复可用；
- **但 agent 实际并未停止**——服务端那一轮还在继续跑（继续调工具、出结果），直到自然结束。

即「显示停止了，实际没停」。

## 二、根因（已定位，精确）

停止动作分两段，第二段是空操作：

1. **前端（已正确）**：`src/components/ParentChatPanel.tsx` 的 `handleStop`（约 327–349 行）：
   - 把当前 working 气泡文案改成「⏹ 已停止」、`working:false`；
   - 置 `stopping/busy` 锁（避免窗口内误发）；
   - 调 `window.api.piAbort("parent")`；
   - 5s 兜底强制解禁。
   前端本身没问题，它**依赖 `piAbort` 真正去通知服务端中止**。

2. **主进程（no-op，根因）**：`electron/lib/ipc-handlers.ts` 的 `pi:abort` 处理器（约 1486–1489 行）：
   ```ts
   ipcMain.handle("pi:abort", async (_e, childId) => {
     // 薄客户端：服务端尚无「中止一轮」能力，此处为 no-op（联调点：服务端 agent abort）。
     return { success: true };
   });
   ```
   **它什么都不做就返回 success**——所以服务端那一轮 agent 完全不知道被「停止」，继续跑到底。

3. **服务端（无中止能力，根因的源头）**：agent 上移服务端后，运行循环（`server/src/agent/parent-registry.ts` 的 `submitParentPrompt` 驱动）没有接收任何「中止信号」的机制——没有 `AbortController`、没有 cancel 标志、没有 abort 路由。`server/src/routes/parent-agent.ts` 只暴露 `stream` / `prompt` / `reset`，**没有 `abort` 端点**。

→ 结论：这是 `ISSUE-080/081` agent 服务端化时已知的「联调点」（`pi:abort` 注释明写 no-op + 服务端尚无中止能力），一直没补。孩子端 `Learn.tsx` 走的是同一个 no-op `pi:abort`，因此**孩子端停止同样无效**（只是本次用户先发现家长端）。

## 三、影响范围

- **家长**：点停止后 agent 继续运行，可能继续创建课程、修改资料、调工具——用户误以为已中止，易产生非预期改动 / 浪费 token。
- **孩子**：同一 no-op 链路，停止同样不生效（历史已存在的隐性问题）。
- 仅 UI 状态正确、实际行为错误；不影响已正常结束的对话。

## 四、修复方向

接通「服务端中止一轮」能力：

1. **服务端 `parent-registry.ts`**：为每个活跃会话（`parent` / `parent-content`）持有一个 `AbortController`（或 `cancelled` 标志）；`submitParentPrompt` 的运行循环在「每步之间 / 每个工具调用前」检查 `signal.aborted`，命中则优雅退出（emit `turn_end` / `agent_end`，不再发最终回复、不再继续下一工具）。
2. **服务端 `routes/parent-agent.ts`**：新增 `POST /api/v1/parent-agent/abort?kind=parent|parent-content`（鉴权：家长 JWT），触发对应会话的 abort；孩子侧同理在 `routes/agent.ts` 加 `POST /api/v1/agent/:childId/abort`。
3. **主进程 `ipc-handlers.ts`**：把 `pi:abort` 从 no-op 改为调用上述服务端端点（按 scope 传 `parent` / `childId`），失败仅记录、不阻塞前端。
4. **前端**：`ParentChatPanel.handleStop` 与 `Learn.tsx` 的 stop 逻辑基本无需改（已正确依赖 abort），保留「已停止」UI + 兜底解禁即可。
5. **验证**：家长对话中点停止 → 服务端立刻停止（不再有后续工具调用 / 回复），气泡「已停止」且确实无后续内容；孩子端同样回归一次。用 `curl` 直接打 abort 端点确认服务端中止生效（隔离前端）。

## 五、关联

- 历史根因同源：`ISSUE-080`/`ISSUE-081`（agent 服务端化，P0~P4 已实施，但「中止一轮」能力列为联调点未补）。
- `ISSUE-068`（停止后误报 "Agent is already processing"）：当时修的是本地 SDK 重入守卫，未涉及服务端中止，故本 issue 与之互补而非重复。
- 前端：`src/components/ParentChatPanel.tsx`（`handleStop`）、`src/pages/Learn.tsx`（孩子端 stop）。
- 主进程：`electron/lib/ipc-handlers.ts`（`pi:abort` no-op 约 1486 行）。
- 服务端：`server/src/routes/parent-agent.ts`、`server/src/agent/parent-registry.ts`（`submitParentPrompt` 运行循环），以及 `server/src/routes/agent.ts`（孩子端同构补 abort）。
