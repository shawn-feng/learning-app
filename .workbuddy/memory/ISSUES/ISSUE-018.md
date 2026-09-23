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
- **优先级**：⏸ 暂缓 / 暂不处理（用户 2026-08-31 标注：后续再讨论，本期不动；**2026-09-21 再次讨论后仍决定暂不实施**，设计方案登记如下）
- **记录时间**：2026-08-31

---

## 2026-09-21 设计讨论结论（暂不实施，仅登记）

> 背景：agent 已上移服务端，上面 2026-08-31 的排查入口（electron/pi-session.ts）已过时。本次基于服务端架构 + SDK 0.84.1 源码重新设计。

### 现状复核（服务端）

- **被动压缩**：SDK 阈值触发 auto-compaction（`shouldCompact(contextTokens, contextWindow)`，agent-session.js:1587）——「满了才压」，触发点由 token 数决定而非教学节奏，可能压在一课中间。
- **`summarize_conversation`**（kb-summary-tool.ts）：实为**记录工具**（读逐字稿写 daily 供家长回看），不缩减上下文，与压缩是两回事。

### 体积实测（2026-09-21，闻闻一家，脚本 `server/_prompt_size.mts` / `_tools_size.mts` 可重跑）

- 孩子 system prompt 4,383 字符 ≈ 1.5~2.2k token；**tools 载荷 16,947 字符（25 个工具）≈ 5.8~8k token**，每轮重发。
- 家长 system prompt 8,804 字符；tools 29,620 字符（45 工具）≈ 10.3~14.4k token。

### 方案定案：状态外置 + SDK 分支（不用 newSession、不用原地 compact）

- **哲学**：真状态（进度/错题/掌握度/约定）本来就归孩子库，对话只是过程——课包提取后落库核实，上下文里的历史即可整体丢弃。
- **关键裁定（用户提出）**：**不 newSession**——重建会话会让 system prompt（错题本块/日期会变）+ tools 前缀缓存全失效；用 **pi session 树分支**，同文件同前缀，缓存保留。
- **SDK 现成能力（0.84.1 已验证）**：
  - `session.navigateTree(targetId, {summarize: true, customInstructions, label})`（agent-session.d.ts:584）——一次调用：LLM 生成被弃分支摘要（支持课包口径自定义指令）→ `branchWithSummary(newLeafId|null, summary)` 建新分支 → 摘要成为新分支**第一条消息**（session-manager.js:182 `createBranchSummaryMessage`）。同文件，老分支条目留在树里（回看/审计不受影响）。
  - 服务端可直接调：session-registry.ts:350 `entry.session` 即完整 AgentSession。

### 实施链路（将来做时按此）

1. **`finish_lesson` 工具**：agent 课末调用，仅**打标记**——不能在 execute 里直接 navigate（运行中抽会话树会出事；compaction 进行中 prompt() 也抛错）。
2. **空闲/进场触发**：`agent_end` 后或下次 `ensureEntry` 兜底检查未归档标记 → 调 `navigateTree`（复用 ISSUE-100「重置在进会话时完成」模式，不阻塞发送路径）。
3. **课包口径**：`customInstructions` 写明「只保留：学到哪课/哪个环节、掌握与未掌握知识点（未掌握进错题本）、下次约定、孩子情绪与鼓励偏好；丢弃题目原文与对话细节」。
4. **快照式摘要**：每次从根部（或首条用户消息父节点）分支，课包 = 本课新事 + 上份快照仍有效的约定（滚动状态快照），不做摘要链——上下文恒为「一份快照 + 当前课轮次」。
5. **兜底**：保留 SDK 阈值 auto-compaction 不动（防单课过长撑爆窗口）。
6. 触发三层：finish_lesson（主）/ 进场兜底（必发生，孩子学完直接关页面是常态）/ 阈值（保底）。

### 注意点

- 课包摘要 prompt 必须按「状态快照」写，不能写成「本课流水」——否则几次课后旧约定丢失。
- 分支不重建 prompt：系统提示词里的错题本块保持会话创建时的旧内容，本课新错题靠课包快照与 KB 补位，跨天新会话自然刷新。
- 成本：每次课间一次 LLM 调用（对被弃分支，几千 token）；省的是之后每一轮。
- 会话文件随分支增长（树结构），daily 汇总按时间戳读不受影响，备份体积缓增。
- 关联：工具描述按需载入（tool_help + setActiveToolsByName）是另一条独立的省 token 线，本轮也已评估（SDK 支持 `setActiveToolsByName`，registry 固定、激活集可变，同运行内下一步生效），同样暂不做。
