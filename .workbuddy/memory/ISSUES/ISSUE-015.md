## [ISSUE-015] 孩子页面操作不自动投递 agent，随下一轮消息附带发送

- **类型**：需求 / 行为调整
- **描述**：孩子在左侧学习资料页面上的操作（打开/点击/滚动/输入/提交）目前会**自动注入 agent 会话**，导致 agent 对每一个操作环节都要回复一次。改为：
  1. 操作事件**仅记录**（环形缓冲保留，供 `page_inspect` / 上下文读取）；
  2. **不自动发送给 agent**（去掉自动注入）；
  3. 在孩子的**下一轮消息**里，把这段时间的页面操作作为一段说明附带发送，并**注明「这部分是孩子在页面的操作」**；发送后清空。
- **现状 / 排查入口（已定位）**：
  - 事件上报：iframe 桥 → `src/pages/Learn.tsx:340` `handlePageEvent` → `window.api.pageEvent`（`pi:page:event` IPC）→ `queuePageEvent`（`electron/lib/page-bridge.ts:169`）：① 入环形缓冲（`bufferFor` 容量 50，供 `recentInteractions` / page_inspect 读，:223）；② **600ms 批处理后自动注入**（:183 `injectToSession`）。
  - **自动注入（根因）**：`injectToSession`（page-bridge.ts:135）：会话空闲 → `session.followUp(text)`（**立即投递** → agent 回复）；运行中 → `session.steer(text)`（排队注入）。注入文本前缀 `[页面事件]`（`buildInjectionText` :132）——这就是「agent 对每个操作环节都要回复」的来源。
  - 改造方向：
    ① `queuePageEvent` 停止自动注入（保留环形缓冲；600ms 批处理改为只累积 `pending` 待发送列表，或直接停用投递）；
    ② 按 childId 维护「待附带页面操作」列表（可直接复用缓冲：下一轮发送时取 `recentInteractions` 合并）；
    ③ 注入点：孩子发消息 `src/pages/Learn.tsx:433` `handleSend`（组装 `promptText` :528）——把 pending 页面操作以「[页面操作] 孩子在页面的操作：…」附加进消息，发送后清空；或主进程在孩子 user 消息进入会话时统一拼接（pi-session 消息入口）；
    ④ `page_inspect` / `page_action`（agent 主动查看/操作页面）能力保持不变。
- **优先级**：已完成（2026-08-30 实施：queuePageEvent 停用自动注入（删除 injectToSession/setSessionProvider 链路），事件只入环形缓冲（page_inspect 可读）+ 累积 pendingByChild；新增 takePendingPageEvents + IPC pi:page:pending + preload pageTakePending；Learn.tsx handleSend 取走并以「[页面操作] 这部分是孩子在页面上的操作：…」附到下一轮消息、发送后清空；page-bridge.test.ts 旧注入测试重写为新语义）
- **记录时间**：2026-08-30
