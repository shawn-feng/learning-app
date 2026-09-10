## [ISSUE-002] 家长设置·定时任务：去掉「会话重置」，用「自动新建会话」即可

- **类型**：需求 / 功能移除
- **描述**：家长设置里的定时任务去掉「会话重置」（sessionReset），不再需要该功能——「自动新建会话」已覆盖其用途（跨天自动开新 + 每天定点开新），二者重叠，删除重置分支。
- **现状 / 排查入口**：
  - 前端：`src/components/SchedulerSettings.tsx:458-485`（session-reset 区块：开关 + 时/分）；:146 说明文字已注明「与每日会话重置功能重叠，二者择一即可」。
  - 配置模型：`SchedulerSettings.tsx:7` `sessionReset: { enabled, hour, minute }`，默认关闭（:38）。
  - 后端：会话重置执行逻辑（resetChildSession / runSessionReset / `pi:reset` IPC 链路）与「自动新建会话」共用调度框架，删 sessionReset 分支、保留新建会话分支。
- **优先级**：已完成（2026-08-30 实施：`SchedulerSettings.tsx` 删 UI 与配置字段；`scheduler.ts` 删 sessionReset 配置/分支/任务状态键；`pi:reset` 保留给聊天 /reset 与自动新建会话热路径）
- **记录时间**：2026-08-30
