## [ISSUE-018] 孩子界面：每学完一课压缩当前会话历史，节省 token

- **类型**：需求 / 性能（token 优化）
- **描述**：孩子每课学习都是新内容，与前面课程关系不大。希望**每学完一课后，把当前会话里前面课程的对话压缩/摘要掉**，只保留最近本课上下文与学习进度，从而节省 token（长课/多轮尤其明显）。
- **现状 / 排查入口（已查证）**：
  - **已有被动 compaction（非「每课」主动压）**：`electron/lib/user-init.ts:54` `buildChildSettings()` 返回 settings，`compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 10000 }`——SDK 在上下文接近模型上限（contextWindow - reserveTokens）时自动把旧消息摘要化、保留最近 10k token。**这是「满了才压」的被动机制，不是「每课结束主动压」，长课中途不省 token。**
  - **按天总结（非压缩当前会话）**：`electron/lib/daily-summary.ts` `summarizeDailyConversation`（按天把对话摘要写入 daily 文件）+ `summarizeConversationTool`（`summarize_conversation` 工具，供 agent 主动调）；`pi-session.ts:357` `maybeSummarizeBeforeNewSession` 在**开新会话前**对「今天之前最后有会话的一天」做按天汇总写入 daily（fire-and-forget）。这些是「持久化到 daily 供新会话首轮注入」，不压缩/缩减**当前会话**历史本身。
  - **自动 newSession 归档**：`pi-session.ts:425` `shouldAutoNewSession` 跨天/过时间节点时 `mgr.newSession()`（旧会话文件归档为历史、开空会话）——与「压缩当前会话」不同（归档=另开新会话，旧历史脱离当前上下文但不摘要替换；触发条件是时间而非「课」）。
  - **session API 面**：当前用到 `session.setThinkingLevel` / `dispose` / `sessionManager.newSession`（`pi-session.ts:455/568/615/429`），**未见手动 `compact()` 调用**；compaction 由 settings 被动驱动，疑似无公开手动触发接口（待确认）。
- **改造方向**：
  ① **确认 SDK 是否暴露手动 compact**：查 `node_modules/@earendil-works/pi-coding-agent` 的 AgentSession 类型/方法（如 `session.compact()`）；若有直接调用；若无，自实现如下②。
  ② **自实现「压缩当前会话」**：取当前会话 jsonl 历史 → 调 LLM 摘要（复用 `summarizeDailyConversation` 的摘要 prompt/逻辑）→ 将旧消息替换为一条/几条摘要消息，**保留最近本课对话 + 学习进度摘要**（progressContext 类），丢弃前面课程逐轮细节。与 SDK 自动 compaction 互补（主动压=提前省 token，被动压=满了兜底）。
  ③ **「一课完成」触发信号（关键，需确定）**：
     - 推荐：**display_content 切换到不同课程资料时**（`Learn.tsx` 的 display_content 链路 :202-215 materials 变化 effect）——孩子打开新课资料意味上一课告一段落，触发对上一课对话压缩；
     - 备选：新增 agent 工具 `compact_session`（让 agent 判断一课学完后自调）；或 UI（孩子/家长端）加「本课完成·压缩会话」按钮。
  ④ **防误压**：仅在「课程切换 / 明确一课完成」时触发，不每轮压；压缩前可顺带把本课要点写 daily（与现有 summarize 互补）。
  ⑤ **兼容性**：压缩后系统提示/AGENTS/进度概览仍由 SDK 首轮自动附加（`pi-session.ts:404` systemPromptOverride + progressContext），不受影响。
- **优先级**：⏸ 暂缓 / 暂不处理（用户 2026-08-31 标注：后续再讨论，本期不动）
- **记录时间**：2026-08-31
