## [ISSUE-062] 设计讨论：用「会话树分支」让一个课程/主题成为 pi 会话树的一支，以节省 token 缓存消耗（prompt cache）
- **类型**：设计讨论（与 ISSUE-054 同类，属架构权衡，非 bug）
- **需求（用户 9/7 原话）**：讨论 pi 的会话树的应用——为了节省 token 的缓存消耗，能否一个学习课程或一个主题是一个 pi 的会话树的分支。
- **现状（已读代码，确认会话模型）**：
  - 当前**每个课程是独立 `.jsonl` 文件 + `newSession()`**，不是树分支。`createChildSession`（pi-session.ts:567）按 `sessionKey=childId|courseKey` 建会话；课程会话落 `sessions/<topic>-<title>/` 独立子目录（:638-640），进入即 `mgr.newSession()` 开干净窗口（:647），**不复用上次本课对话**。主会话在 `sessions/` 根。
  - SDK 两种原语（pi-session.ts:1010-1015 注释明确）：`newSession()`=另开**独立文件**、旧文件归档、前缀不共享；`resetLeaf()`=**同文件内分叉**，从当前 leaf 开兄弟分支，**共享祖先前缀**（即对话树/分支语义，是「尝试多种可能性」原语，会在一个文件里堆叠分支）。
  - 用量已可观测：`token-stats.ts` 已追踪 `cacheRead`/`cacheWrite`（:49-50/:137-138），可按 child/course 看前缀缓存命中率。
- **核心讨论点（关键反直觉结论）**：
  1. **独立文件 ≠ 不能共享前缀缓存**：主流 provider 的 prompt cache 按「前缀内容哈希」**全局去重**（跨会话、跨文件）。当前各课程文件的 system prompt 前缀（`buildChildPrompt` 的 身份+profile+AGENTS 行为规范+技能索引）文本完全相同 → **已经跨文件命中 cacheRead**，未必需要改造成树。树的收益主要在「共享不止 system prompt、还要共享对话历史前缀」，而 ISSUE-029/054 恰恰**刻意不共享**跨课程对话历史（防串味/污染）。所以树能省的「额外」缓存 = 共享课程对话历史，正是被设计排除的。
  2. **当前实现反而挡住了共享**：`courseLesson`（教法）作为第 5 参数注入 `systemPromptOverride`（buildChildPrompt，pi-session.ts:620）→ 每个课程的 **system prompt 前缀都不同** → 跨课程无法共享前缀缓存。这是比「是否用树」更前置的问题：先让稳定前缀（身份+profile+AGENTS）在所有课程间一致，才能谈省缓存。
  3. **缓存收益受三因素钳制**：① **模型/provider 是否支持 prefix caching**（child 默认模型 + qwen token-plan 是否支持需实测确认；不支持则树零收益）；② **TTL 通常分钟级**（跨天基本失效，真实收益只在「一天内连上几门课」的窗口）；③ **前缀稳定性**（日期注入/动态内容变前缀即失效——learning-guard 每轮注入当前时间，若落在前缀区会破坏缓存）。
- **设计建议（收敛结论，讨论向）**：
  - **不急于改造成树**。先验证再决定：①读 `token-stats` 的 cacheRead/cacheWrite 占比，确认当前稳定前缀是否已在复用；②把 `courseLesson` 从「缓存前缀」移出（改为第一条 user message 注入、或置于 cache breakpoint 之后），使 identity+profile+AGENTS 这一稳定前缀跨课程一致。这两步零结构风险，且若 provider 全局去重成立，独立文件已能拿到前缀缓存收益。
  - **若数据证明「一天内多门课」场景 cacheWrite 高、cacheRead 低**，再考虑树。方案：每个孩子的「主会话管理器」作**树根**（稳定前缀=identity+profile+AGENTS，日期注入放前缀之后），每个课程/主题 = `resetLeaf()` 从根分叉；需解决：①**分支累积**（resetLeaf 堆叠，须「每课一个分支、续接复用而非每次分叉」+ 归档清理，参考 resetChildSession 的 pruneArchivedSessions 思路）；②**分支导航/历史浏览 UI**（当前 UI 按文件读消息，需分支列表 API）；③**resetChildSession 语义**（不能误删所有课程分支）；④确认 SDK `continueRecent` 能否定位到指定课程分支续接；⑤provider 缓存支持。
  - **权衡**：树牺牲了「每课独立文件」的简洁隔离与易清理/易回看，换来「共享前缀缓存」；但若共享的仅是 system prompt，独立文件靠全局前缀去重已得同等收益。故树的**净收益有限、风险不小** → 当前标记为「待数据验证的优化项」，不建议立即实施。
- **修改入口 / 方向（若未来实施）**：
  - `electron/lib/pi-session.ts`：`createChildSession`（:642 的 `mgr.newSession()` 改为从树根 `resetLeaf()` 分叉；`courseSessionsSubdir` 逻辑改为「孩子单树 + 分支命名」）、`resetChildSession`（:1032 分支语义调整，避免误清所有分支）、`disposeChildCourseSession`（分支清理而非删文件）。
  - `electron/lib/pi-session.ts` `buildChildPrompt`（:620）：将 `courseLesson` 移出 `systemPromptOverride` 缓存前缀。
  - `electron/lib/token-stats.ts`（:49）：加「按 child/course 维度」的 cacheRead/cacheWrite 占比报表，作为改造决策依据。
  - SDK 侧需确认：`resetLeaf` / `continueRecent` 的分支导航 API、分支列表读取。
- **优先级**：低（优化项，待数据验证；与 ISSUE-054 的「按课程隔离」目标存在张力——隔离靠独立文件、省缓存靠共享前缀，二者需取舍）
- **记录时间**：2026-09-07（讨论，未开工）
