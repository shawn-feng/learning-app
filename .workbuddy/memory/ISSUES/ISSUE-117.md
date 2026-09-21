# ISSUE-117：agent 工具并发调用——框架已支持并行（默认 parallel），实际串行卡在「模型一轮一调用」习惯；方案：批量工具 + prompt 鼓励并发

- **类型**：架构 / 性能（问题定位 + 并发方案；家长/孩子 agent 通用）
- **问题描述**：家长 agent 调 `parent_build_material` 做多份资料时，一份做完才能做下一份（每份 HTML 生成是完整编程 agent 多轮循环，动辄几十秒~几分钟），N 份资料纯串行等待。问：框架是否不支持并发？能否并发？
- **定位结论（已核实到 SDK bundle 源码级）**：
  - **框架层默认就是并行**：pi SDK 的 agent 循环里 `executeToolCalls()` 逻辑为——若 `config.toolExecution === "sequential"` **或** 批次内任一工具声明 `executionMode === "sequential"` 则串行，**否则走 `executeToolCallsParallel`**（server.cjs:260783-260789）；Agent 构造默认 `toolExecution ?? "parallel"`（:261181）。服务端 `session-registry.ts`/`parent-registry.ts` **没有覆盖**为 sequential；全仓（含内建 read/write/edit）**没有任何工具声明 executionMode**。⇒ **同一条 assistant 消息里的多个工具调用，SDK 会并发执行**。
  - **`parent_build_material` 实现本身并发安全**（`programming-agent.ts`）：每次调用起**独立编程 agent 会话**，会话 key=`parentId:${sessionKey ?? outputPath}`——**不同资料路径=不同会话，天然可并发**；同 path 修改复用同会话（上下文连续设计，串行合理）。无全局锁；`sessions` Map 在 JS 单线程下读写安全。
  - **实际串行的根因 = 模型行为**：LLM 对重型工具几乎总是**一轮只发一个调用**——发 1 个 `parent_build_material` → 等结果 → 评估 → 再发下一个（下一份资料的命名/需求常依赖上一份是否成功）。**不是框架限制，是模型没有同消息批量发调用的习惯**。
- **并发方案（建议组合）**：
  ① **批量工具（确定性，推荐主方案）**：新增 `parent_build_material_batch(materials: [{title, requirement, path}, ...])`——工具内部 `Promise.all` 起多个编程会话**框架强制并发**（并发上限如 3，防模型 API rate limit/超时雪崩），返回逐份成败汇总（单份失败不影响其它，失败项带原因）。绕开「模型一轮一调用」习惯，由工具边界吸收并发复杂度。孩子侧 `create_html_lesson` 同构可复用。
  ② **prompt + 工具描述鼓励并发（零代码辅助）**：家长 agent prompt 与工具 description 加指引「相互独立的多份资料，可在同一条消息里一次发出多个 `parent_build_material` 调用，系统会并发执行；有依赖关系时才逐个调用」。效果依模型对 parallel tool call 的支持度（不一定听），作为 ① 的补充。
  ③ **注意事项**：并发 N 份 = N 路编程 agent 循环同时打同一编程模型——**rate limit/成本放大**（并发上限必须设）；编程会话 `sessions` Map 并发创建两个同 key 会话的竞态（JS 单线程下 `get→set` 间无 await，实际安全，但加注释防未来改动破坏）；批量工具内的单份失败语义要明确（部分成功即返回成功+失败清单，不整批回滚）。
- **回归**：单个 `parent_build_material` 调用行为不变；同 path 修改仍复用会话串行（语义保持）；并发不改变资料落盘路径/真源校验/100B 落盘校验；家长会话单消息单循环模型不受影响（并发只发生在 turn 内的工具层）。
- **关联**：ISSUE-116 自定义任务（无头执行）若未来一次跑多操作，同样受益于批量并发范式；ISSUE-056（资料制作注意事项：H.264/上传接口）在批量场景同样适用。
- **优先级**：中（多份资料制作是家长高频操作，串行等待体感明显；方案①改动小、收益确定）
- **记录时间**：2026-09-19
