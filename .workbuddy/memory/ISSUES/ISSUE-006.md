## [ISSUE-006] 学习进度：孩子模式点主题后看不到详细课程学习情况；两模式界面/操作需完全一致

- **类型**：bug / 需求
- **描述**：
  1. **孩子模式**：学习进度看板里**点击一个主题后，无法查看该主题详细课程的学习情况**（每课状态 / 掌握度 / 当课总结）。
  2. **一致性要求**：家长模式和孩子模式的学习进度界面与操作功能必须**完全一样**（都支持「主题 → 每课 → 当课」三级下钻），家长模式落地见 ISSUE-005。
- **现状 / 排查入口**：
  - 前端组件**代码层面已具备下钻**：`src/components/LearningDashboard.tsx`——总览主题列表（openTopic :96）→ `learning:topic` IPC → 主题内每课列表（:167 起渲染 CourseItem[]）→ openCourse → `CourseDetail` 单课详情（CourseDetail.tsx 含状态/掌握度行）。**但用户实测点主题后看不到课程明细**，疑点在数据层：
    - `electron/lib/ipc-handlers.ts:294` `learning:topic` → `getTopicProgress(childId, topic)`：SPLIT 后进度真源在服务端，需确认该函数**是否真实返回每课 CourseItem 明细**（learned/status/mastery）；若 items 为空或抛错，主题页显示空态/报错，表现为「点主题没反应」。
    - `learning:courseSummary`（:305）→ getCourseDailySummary（关联 daily_entries block='学习'），确认当课总结数据是否存在。
  - 家长模式：暂无进度看板入口（见 ISSUE-005），落地后需与孩子模式**共用 LearningDashboard**（或同构组件）保证界面与操作一致。
- **优先级**：已完成（2026-08-30 实施：`learning-summary.ts` `getTopicProgress` 改为并行查 `kb.progress.list`（聚合行）+ `kb.courses.list`（按 topic 过滤，每课 CourseItem 明细）组装 `TopicDetail{...items}`；根因=原只返回视图行无 items，组件 `d.items.filter` 崩溃/空白。实测：english items=51、lunyu items=512（✅305/⬜207 与 progress 一致）、论语当课总结 2 条、三级下钻全通）
- **记录时间**：2026-08-30
