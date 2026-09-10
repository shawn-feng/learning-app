## [ISSUE-068] 停止 agent 后仍报 "Agent is already processing"（会话中止后重发消息被 SDK 重入守卫拦截）
- **类型**：bug（并发/状态机）
- **需求（用户原话）**：在会话中已经中断了 agent，而且也提示已停止，但是再发消息仍然提示 agent is already processing.
- **现象**：孩子在会话中点「停止」→ 气泡显示「⏹ 已停止」、发送按钮恢复 → 用户紧接着发新消息 → 弹出/回复区出现英文报错 `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`（即用户说的 "agent is already processing"），新消息未被正常处理。
- **现状确认（已读真实代码，根因精确）**：
  1. **报错来源（SDK）**：`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:831-833`
     ```js
     if (this.isStreaming) {
       if (!options?.streamingBehavior) {
         throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
       }
       ...
     }
     ```
     即：**SDK 会话处于 `isStreaming`（上一轮 `prompt()` 仍在途）且调用方未传 `streamingBehavior` 时，直接抛此错**。这是字面报错的唯一起源。
  2. **SDK 的 abort 语义**：`agent-session.js:1168` `async abort()` 做 `this.agent.abort()` + `await this.waitForIdle()`——它会**等会话真正 idle（`isStreaming` 变 false）后才 resolve**。`isStreaming` 只在底层 LLM 流真正终止后才清零，依赖 provider 及时响应 abort 信号（网络/模型延迟会让这个窗口有长短）。
  3. **主进程的 prompt 入口**：`electron/lib/ipc-handlers.ts:1202` `pi:prompt`（孩子会话）在 `:1235` 设 `childPromptAbort = {stopped:false,...}`，在 `:1236` `await session.prompt(text)`，并在 `:1301` 的 `finally` 里才把 `childPromptAbort = null`。**也就是说：上一轮 `prompt()` 没真正跑完前，`childPromptAbort` 一直非 null，主进程从未对「已有在途 prompt」做拦截**。
  4. **主进程的 abort 入口**：`ipc-handlers.ts:1627` `pi:abort` 设 `childPromptAbort.stopped=true` 并 `await session.abort()`（会等 idle）。但它是个 IPC，前端并不等它完成。
  5. **前端的停止逻辑（关键诱因）**：`src/pages/Learn.tsx:894` `handleStop` 在调用 `window.api.piAbort(...)` 后**立即** `setBusy(false)` 并把工作气泡改成「⏹ 已停止」（`:900`），**不等 `piAbort`/SDK 真正 idle**。于是 UI 立刻解禁、显示「已停止」，但底层 SDK 会话可能仍是 `isStreaming`。
- **根因（竞态链）**：
  - 点停止 → 前端立刻 `busy=false` 且显示「已停止」，但 SDK 会话的 `isStreaming` 要等底层流真正终止才清零（`abort()` 内部 `await waitForIdle`）。
  - 用户看到「已停止」后**在 abort 真正完成前的窗口内**发新消息 → 新的 `pi:prompt` → `session.prompt()` 再次被调用，此时 SDK 仍 `isStreaming` → 命中 `:833` 守卫抛 `Agent is already processing.`。
  - 该异常被 `ipc-handlers.ts:1291` 的 `catch` 捕获；而本次新调用在 `:1235` 已把 `childPromptAbort` 重置为新的 `{stopped:false}`，所以 `childPromptAbort?.stopped` 为 false → 走 `_e.sender.send("pi:reply_error", {childId, error: friendlyError(...)})` → 前端把 `Agent is already processing...` 直接呈现给用户。
  - **本质**：重入保护完全依赖前端 `busy` 标志；而「停止」路径提前解禁 `busy`，破坏了这道保护；主进程 `pi:prompt` 自身又无任何在途拦截，直接把请求交给 SDK，SDK 用 cryptic 英文抛错。
- **影响范围**：所有走 `session.prompt()` 的会话入口都有同源隐患——孩子会话 `pi:prompt`（:1202）、家长会话 `pi:prompt_parent`（:1480）、家长内容 `pi:prompt_parent_content`（:1559）、场景会话（:1305+，用 `scenePromptAbort`）。用户当前报告在孩子端，但修复应覆盖全部。
- **修复方向（建议，两层防御）**：
  1. **前端加「停止中」锁（主防御，消除竞态窗口）**：`Learn.tsx:894` / `ParentChatPanel.tsx:313` 的 `handleStop` 不要立刻 `setBusy(false)`。改为进入 `stopping` 状态：发送按钮保持禁用（或仍显示「停止中…」），直到收到 `pi:reply_end`（SDK 在 abort 完成后会发，见 `ipc-handlers.ts:1242/1294/1300`）才真正 `setBusy(false)`、彻底解禁。这样用户在会话真正 idle 前无法发新消息，从源头避免命中 SDK 守卫。
  2. **主进程加在途拦截（兜底，把 cryptic 错变友好提示）**：在 `ipc-handlers.ts` 各 `pi:prompt*` 入口最顶部，判断「是否已有在途 prompt」——孩子用 `if (childPromptAbort) `、家长用 `if (parentPromptAbort)`、场景用 `if (scenePromptAbort)`（均为非 null 即表示上轮未结束，含正在停止）。若命中，直接 `return { success:false, error:"上一条消息还在收尾/停止中，请稍候再发" }`（符合 ISSUE-063「好报错」规范：what+next），**不要**调用 `session.prompt()`，避免把 SDK 的 `Agent is already processing.` 抛给用户。
  3. **（可选，进阶 UX）用 SDK 自带队列**：若希望「停止后立刻发的新消息能被真正处理」而非被拒，可在会话 `isStreaming` 时带 `streamingBehavior:'followUp'`（或 'steer'）调用 `session.prompt()`，让 SDK 把消息排队而非抛错。但注意语义：followUp 是把新消息挂到**上一个仍在进行（或被中止）的 turn** 上，与孩子「停止后开新话题」的预期不完全一致，需谨慎；建议默认走 1+2（拒绝并重试提示）即可。
- **修改入口**：
  - `src/pages/Learn.tsx:894` `handleStop`（加 `stopping` 态，待 `pi:reply_end` 再解禁 `busy`）
  - `src/components/ParentChatPanel.tsx:313` `handleStop`（同上）
  - `electron/lib/ipc-handlers.ts:1202` `pi:prompt`、`:1480` `pi:prompt_parent`、`:1559` `pi:prompt_parent_content`、场景 prompt（:1305+）：各自入口顶部加「在途（`*PromptAbort` 非 null）即返回友好错误」的兜底拦截
  - （核对）`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:831-833`（报错真源，仅供参考、勿改）
- **验证**：
  - 复现：孩子端发一条会触发长思考/多工具调用的消息 → 点「停止」→ 气泡变「⏹ 已停止」后**立刻**输入新消息回车 → 当前必现 `Agent is already processing.`；修复后应：要么发送按钮在「停止中」保持禁用、无法误发，要么误发时收到中文「上一条还在收尾，请稍候再发」而非英文原错。
  - 回归：正常停止后等 1~2 秒再发新消息应照常工作；停止后不误发也应正常。
  - 覆盖：家长端、场景对话同理验证。
- **优先级**：中（影响「停止后继续对话」这一高频交互；表现为报英文错、新消息丢失，体验差但非崩溃；修复小、风险低）
- **记录时间**：2026-09-09
- **状态**：✅ 已修复（2026-09-10，两层防御）
- **修复内容**：
  - **Layer 2（主进程兜底，把 cryptic 错变友好提示）** — `electron/lib/ipc-handlers.ts` 各 prompt 入口顶部加在途拦截，命中则返回 `{success:false, error:"上一条消息还在收尾或停止中，请稍候再发。"}`：
    - `pi:prompt`（孩子）：入口顶部 `if (childPromptAbort) return 友好错误`。
    - `pi:prompt_parent`：顶部 `if (parentPromptAbort) ...`。
    - `pi:prompt_parent_content`：新增模块级 `parentContentPromptAbort` 变量 + 入口顶部 `if (parentContentPromptAbort) ...`；并补上原本缺失的 abort 登记 `{stopped:false, abort}`、`stopped` 跳过回发、`finally` 复位；`pi:abort` 增加 `parent-content` 分支标记停止。
    - `scene:prompt`：顶部 `if (scenePromptAbort) ...`。
  - **Layer 1（前端「停止中」锁，消除竞态窗口）** — `src/pages/Learn.tsx` 与 `src/components/ParentChatPanel.tsx` 各加 `stopping` 态：
    - `handleStop` 不再立即 `setBusy(false)`，改为 `setStopping(true)` 保持发送禁用；气泡仍改「⏹ 已停止」；加 5s 安全兜底强制解禁（防 reply_end 未达致卡死）。
    - 所有结束/错误事件（`reply_end`/`agent_end`/`reply_error`/`error`）解禁时一并 `setStopping(false)`。
    - 发送按钮 `disabled`/`running` 改 `busy || stopping`。
  - **验证**：tsc 仅环境级全局类型噪音、编辑文件零报错；复现路径（长思考中点停止→立刻重发）应不再出现 `Agent is already processing.`，改为发送按钮「停止中」禁用或收到中文「上一条还在收尾…」。
