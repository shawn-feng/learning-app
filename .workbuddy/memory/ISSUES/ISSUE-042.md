## [ISSUE-042] 家长 agent 也要支持 /reset、新建会话等会话管理命令（对齐孩子端）

- **类型**：功能缺口 / 会话管理（家长聊天 `src/components/ParentChatPanel.tsx` + `electron/preload.ts` + `electron/lib/ipc-handlers.ts` + `electron/lib/pi-session.ts`；对比孩子端 `src/pages/Learn.tsx`）
- **描述**：孩子端聊天支持 `/reset`（清空当前会话+学习资料面板、旧会话归档）、`/help` 等斜杠命令，会话可被手动/自动重置（新开会话、旧文件保留为历史）。家长端右侧常驻聊天（`ParentChatPanel`）目前**没有任何斜杠命令，也无法手动重置/新建会话**——长聊后只能堆在同一会话里，不能像孩子端那样一键清空重来。用户要求家长 agent 也实现 `/reset`、新建会话等能力，与孩子端对齐。
- **现状 / 根因（已查代码，与孩子端逐项对照）**：
  - **前端无任何命令解析**：`ParentChatPanel.tsx` 的 `handleSend`（:169-244）直接把文本发往 `piPromptParent`，**没有 `/` 前缀拦截**；对比孩子端 `Learn.tsx:696-702` 在 `handleSend` 里 `if (trimmed.startsWith("/")) handleCommand(...)` 拦截；孩子端 `COMMANDS`（:646-649）={reset,help}、`handleCommand`（:681-694）、`runResetCommand`（:660-678，调 `window.api.piReset(child.childId)`）。家长端全缺。
  - **IPC 仅孩子可用**：`preload.ts:91` 只暴露 `piReset(childId)` → `ipcMain.handle("pi:reset", …)`（ipc-handlers.ts:1327-1338），内部**只走孩子链路**：`getChildSchedulerConfig(childId)` + `resetChildSession(childId, …)` + `getChildSession(childId)` + `attachSessionEvents(session, childId, …)`——**无 childId="parent" 分支、无 `piResetParent`**。家长会话目录是 `getParentSessionsDir("parent")`（pi-session.ts:494/524），与孩子 `childDir/.pi/agent/sessions` 不同。
  - **缺 `resetParentSession` 后端实现**：`pi-session.ts` 有 `resetChildSession`（:631-660，热路径 `entry.session.sessionManager.newSession()` + 清 `agent.state.messages=[]` + `pruneArchivedSessions`），但**无对应 `resetParentSession`**。家长会话单例 `cachedParentSession` 走 `getParentSession`（:498-549，同样 `SessionManager.continueRecent(dataDir, getParentSessionsDir("parent"))` + 热路径 `mgr.newSession()`，:526-529），结构可直接照搬 child 的 newSession 重置。
  - **「新建会话」语义同源**：本架构 `/reset` 即 `mgr.newSession()`（归档旧文件、开新空会话），与孩子端「自动新建会话」（scheduler `auto_new_session` 任务，最终也是 newSession）同构。家长端 SchedulerSettings 已有「家长会话（自动新建会话）」配置区（SchedulerSettings.tsx:159-206）+ 任务类型 `auto_new_session`，但该任务落到家长会话时**仍缺 `resetParentSession` 同款后端**，家长自动新建会话很可能未真正生效（与手动 /reset 同源缺口）。
  - **家长有 2 个会话单例**：通用 "parent"（:498）+ 教学内容 "parent-content"（:556），重置范围需明确（本次先修通用，parent-content 同法可加）。
- **改造方向（对齐孩子端已验证范式，前后端各补一块）**：
  1. **后端 `pi-session.ts` 新增 `resetParentSession(archiveLimit?)`**：照搬 `resetChildSession`（:631-660）但作用于家长会话——从 `cachedParentSession`/`activeSessions.get("parent")` 取 `entry`；热路径 `entry.session.sessionManager.newSession()` + 清 `agent.state.messages=[]` + `pruneArchivedSessions(getParentSessionsDir("parent"), entry.session.sessionFile, limit)`；冷路径仅 prune（与 child 同语义，接受「未落盘空会话 reset 后重载会回到旧会话」边界）。
  2. **IPC `ipc-handlers.ts` + `preload.ts`**：推荐新增 `piResetParent` preload 方法 + `ipcMain.handle("pi:reset_parent", …)`，内部 `resetParentSession(limit)` + `getParentSession()` + `attachSessionEvents(session,"parent",…)`，返回 `{success:true, history:[]}`；或最小改动把 `pi:reset` 加 childId==="parent" 分支（复用 `resetParentSession`）。
  3. **前端 `ParentChatPanel.tsx` 加命令解析**：照搬 `Learn.tsx:645-694`——`COMMANDS` 加 `reset`/`help`（可加 `new` 作为显式「新建会话」别名，同调 resetParentSession）；`handleSend` 开头 `if (trimmed.startsWith("/")) { handleCommand(trimmed); return; }`；`runResetCommand` 调 `window.api.piResetParent()`（或 `piReset("parent")`），成功后 `setMessages([{重置提示}])`（家长无资料面板，不需 `setMaterials`）；`/help` 列出命令。
  4. **事件重挂**：reset 后下一次 `piPromptParent` 必须可用——handler 内 `getParentSession()` 重新拿（或复用 cached）并 `attachSessionEvents`（对齐 child 端 :1332-1333，避免 reset 后发消息无响应）。
  5. **边界**：① 家长会话 childId 标识字面量 `"parent"`，各 `onPi*` listener 已用 `data.childId==="parent"` 过滤（ParentChatPanel 已正确），重置后气泡 ID 继续用 `parent-msg-` 前缀（`nextId`，:6-8）② 手动「新建会话」与「自动新建会话」共用 `resetParentSession`，不重复造轮子 ③ parent-content 会话若也要重置，同法加 `resetParentContentSession`（本次先通用）。
  6. **回归**：家长聊天输入 `/reset` → 历史清空、提示「已重置」、旧会话保留为归档、下次发消息正常；`/help` 列出命令；退再进历史恢复仍正常（ISSUE-039）；自动新建会话任务（家长）真正生效；孩子端 /reset 不受影响（两套 IPC 独立）。
- **优先级**：已实施（2026-09-02）
- **实施记录（2026-09-02）**：
  - `pi-session.ts`：新增 `resetParentSession(archiveLimit?)` — 热路径 `cachedParentSession.sessionManager.newSession()` + 清 agent state messages + `pruneArchivedSessions`；冷路径仅 prune。与 `resetChildSession` 同构。
  - `ipc-handlers.ts`：新增 `pi:reset_parent` handler — 调 `resetParentSession()` + `getParentSession()` + `attachSessionEvents`，返回 `{success:true, history:[]}`。
  - `preload.ts`：新增 `piResetParent()` 方法。
  - `ParentChatPanel.tsx`：新增 `COMMANDS`（reset/help）、`showHelp`、`runResetCommand`（调 `piResetParent`，成功后 `setMessages([{重置提示}])`）、`handleCommand`；`handleSend` 开头加 `/` 命令拦截。
  - 验证：`tsc --noEmit` 0 业务错误；孩子端 /reset 不受影响。
- **记录时间**：2026-09-02
