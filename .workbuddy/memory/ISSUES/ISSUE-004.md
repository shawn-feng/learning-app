## [ISSUE-004] 孩子管理·分配学习主题：支持移除某孩子的某主题，有学习记录则保留记录

- **类型**：需求
- **描述**：分配主题弹窗里可以对某个孩子「移除」某个已分配主题；若该主题已有学习记录（topic_progress / 学习记录），**只解除孩子与该主题的关联（取消分配），学习记录保留在服务端不删除**；若将来重新分配，进度应能续上。
- **现状 / 排查入口**：
  - 前端：`src/components/ChildTopicsModal.tsx`（allocated map :47，分配时写每天学习量 :77/:212/:259）——目前**无移除 UI**。
  - 服务端：`server/src/routes/db.ts` 主题分配相关（topics 表 / 孩子库 topic_progress），**无 deallocate / 移除分配接口**（grep 未命中）——需新增：移除孩子库分配关系，保留 topic_progress 学习记录。
  - 注意边界：移除后孩子 agent 不再查询该主题；移除确认需二次确认（有学习记录时提示「记录保留」）。
- **优先级**：已完成（2026-08-30 实施：`db.ts` 新增 exec op `kb.topics.deallocate`（只删 topics 分配行、保留 courses/进度）；`parent-library.ts` 加 deallocateChildTopic；`ipc-handlers/preload` 加 parent:deallocate；`ChildTopicsModal.tsx` 已添加主题行加「移除」按钮（confirmDialog 提示记录保留））
- **记录时间**：2026-08-30
