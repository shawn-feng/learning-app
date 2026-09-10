## [ISSUE-039] 家长 agent 会话历史退出再进不显示（落盘有、进入不加载）

- **类型**：功能缺口 / 会话历史加载（家长聊天；涉及 `electron/lib/ipc-handlers.ts`、`src/components/ParentChatPanel.tsx`，对比孩子端 `src/pages/Learn.tsx`）
- **描述**：家长 agent 会话 jsonl 确实落盘了（退出时数据已写磁盘），但**退出 app 再进入（或家长中心切到别的 view 再回到聊天）时，聊天框是空的、历史消息全没了**。孩子端同样落盘却能在进入时恢复历史，家长端缺这一步。
- **现状 / 根因（已查证代码，与孩子端逐项对照）**：
  - **落盘真实存在**：`getParentSession`（pi-session.ts:494-545）用 `SessionManager.continueRecent(dataDir, getParentSessionsDir("parent"))`（:520-522），session 的 jsonl 写入 `data/.pi/agent/sessions/parent/`——用户判断正确，**文件确实落盘了**。
  - **断点①（IPC 不返回历史）**：`pi:start_parent`（ipc-handlers.ts:1003-1011）只 `return { success: true }`，**没有 history 字段**；而孩子端 `pi:start_child`（:982-997）明确 `const history = getSessionHistory(session)`（:986）并 `return { success:true, history, materials, materialsLimit }`（:997）。家长端缺这一行。
  - **断点②（前端不加载历史）**：`ParentChatPanel.tsx:25-43` 的初始化 `useEffect` 只 `piStartParent().then` 检查 `r?.success`、失败才塞一条错误提示，**完全没读 `r.history` 回填 `messages`**；`messages` 初始 `useState([])`（:13），仅发送/流式时往里 push。孩子端 `Learn.tsx:373-394` 进入时 `if (Array.isArray(r.history) && r.history.length>0) setMessages(r.history.map(...))` 回填（含 `restoreAttachments`、role 映射、`thinking`/`tools` 还原，:377-392）——家长端照搬这段即可。
  - **结论**：落盘链路完好，缺的是「进入时把 jsonl 历史读回 UI」，与文件是否损坏无关。
- **改造方向（对齐孩子端已验证范式，改动量极小）**：
  1. **`ipc-handlers.ts` `pi:start_parent`**：插入 `const history = getSessionHistory(session);`（与 :986 完全一致），并把 `return { success: true }` 改为 `return { success: true, history };`（家长通用会话无 materials，先不加 materials 回填）。
  2. **`ParentChatPanel.tsx:25-43`**：在 `piStartParent().then` 成功分支内，`if (Array.isArray(r.history) && r.history.length>0) setMessages(r.history.map((m:any)=>({ id: nextId(), role: m.role==="user"?"user":"ai", text: restoreAttachments(...).text, attachments: m.role==="user"?restored.attachments:undefined, textFiles:..., audioPath:..., time: m.time||nowLabel(), thinking: m.role==="ai"?m.thinking:undefined, tools: m.role==="ai"?m.tools:undefined })))`——**整体照搬 Learn.tsx:377-392**（ParentChatPanel 当前从 ChatWindow 导入 `nowTime`，但孩子端用 `nowLabel`；统一用 `nowTime()` 即可，或引入 `nextId`/`restoreAttachments` 同款工具）。
  3. **`getSessionHistory` 返回结构**：孩子端已验证为 `{role, text, time?, thinking?, tools?}` 数组，家长端复用同一映射函数无需重写。
  4. **边界**：家长端无学习资料列表，不强行加 materials；parent-content 会话（TopicDetail 用）若也要恢复历史，同理在该组件入口加回填（本次先修通用家长会话）。
  5. **回归**：退出 app 再进入 / 家长中心切 view 再回聊天 → 历史消息完整恢复（含 AI 思考/工具调用，点 🧠 可看）；新发消息正常追加；孩子端历史恢复不受影响（两套 IPC 独立）。
- **优先级**：已实施（2026-09-02）
- **实施记录（2026-09-02）**：
  - `ipc-handlers.ts` `pi:start_parent`（:1003-1011）：插入 `const history = getSessionHistory(session)` 并在返回值增加 `history` 字段（与 `pi:start_child` 对齐）。家长会话无 materials，未加。
  - `ParentChatPanel.tsx`：新增 `nextId()`（ID 前缀 `parent-msg-`）+ `stripInstructions(text)`（剥离 `[内部指令]` 方括号内容）；`piStartParent()` 成功分支增加 `if (Array.isArray(r.history) && r.history.length>0) setMessages(...)` 回填历史——role 映射、thinking/tools 恢复、time 兜底均对齐 Learn.tsx:377-392 范式；无附件（parent-chat 不传图片/文件），未加 attachments/textFiles/audioPath。
  - 验证：`tsc --noEmit` 对两个改动文件 0 业务错误。待 dev 回归：退出 app 再进入 / 家长中心切 view 再回聊天，历史消息完整恢复（含思考/工具点 🧠 可看）。孩子端不受影响（两套 IPC 独立）。
- **记录时间**：2026-09-02
