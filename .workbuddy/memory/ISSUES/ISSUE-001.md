## [ISSUE-001] 家长界面孩子管理：孩子卡片上恢复学习进度展示

- **类型**：需求 / 功能回归（旧架构 ISSUE-019/027 曾实现家长页进度展示，SPLIT 拆分后未迁移）
- **描述**：家长界面「孩子管理」里，每个孩子卡片上要显示学习进度（如总进度 / 今日已学 / 最近学习），家长要能随时掌握孩子学习情况。当前卡片无任何进度信息。
- **现状 / 排查入口**：
  - 前端：`src/pages/Dashboard.tsx`（children 视图，`childList()` 拉列表渲染孩子卡片）——卡片无进度字段，`refresh()` 只取基础列表。
  - 服务端进度数据已存在、可复用：`server/src/routes/db.ts` 的 `kb.progress.list` / `parent_lib.progress.list`（topic_progress 视图：learned/total/next/updated），进度存服务端真源。
  - 建议：`server/src/routes/children.ts` 的 childList 聚合返回各孩子进度摘要（或新增独立接口），前端卡片渲染进度条 / 摘要；旧架构组件 `src/components/ProgressView.tsx` / `LearningDashboard.tsx` 可参考或复用。
- **优先级**：已完成（2026-08-30 实施：`children.ts` 聚合 topic_progress 返回 progress 摘要；`child-auth.ts` 透传；`Dashboard.tsx` 卡片加进度条 + 最近学习时间）
- **记录时间**：2026-08-30
