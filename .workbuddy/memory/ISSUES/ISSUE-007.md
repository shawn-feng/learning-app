## [ISSUE-007] 孩子详情页：点击孩子卡片进入详情页（标签页组织进度/主题/prompt 等），不再用弹窗

- **类型**：需求 / UI 重构（演进 ISSUE-005 的 icon+弹窗方案；ISSUE-005/006 已于 commit 912c4fe 实施）
- **描述**：
  1. 点击**孩子卡片本身**（而非仅 icon）进入该孩子的**详细页面**。
  2. 不再以弹窗形式展示：学习进度、分配学习主题（ChildTopicsModal）、编辑 AI 提示词（AgentPromptEditor）、重置密码（reset modal）等内容——全部改为详情页内的**标签页（tabs）**（如：学习进度 / 学习主题 / AI 提示词 / 账号密码）。
  3. 每个标签页内容**占满该区域**（整个 dashboard 内容区，而非弹窗），详情页提供返回（回孩子列表）。
- **现状 / 排查入口**：
  - `src/pages/Dashboard.tsx`：孩子卡片（:196-244）现为 5 个 icon 按钮（学习进度 BarChart3 / 重置密码 KeyRound / 学习主题 ListTree / 编辑 AI 提示词 Pencil / 删除 Trash2）；对应弹窗：
    - 学习进度 modal（:273-294，`progressChild`，内嵌 `LearningDashboard`）
    - `ChildTopicsModal`（:266-271，`topicsChild`）
    - 重置密码 modal（:296-314，`resetChildId`）
    - `AgentPromptEditor`（:316-320，`agentPrompt`）
  - 改造方向：卡片整体 onClick 进入详情页视图（新增 state / `view === "childDetail"`），详情页用 tabs 承载上述 4 块内容，各 tab **复用现有组件**（LearningDashboard / 主题分配逻辑 / AgentPromptEditor / 重置密码表单）；现有弹窗入口与 state（progressChild/topicsChild/agentPrompt/resetChildId）随之迁移到 tab 视图。
  - 关联：ISSUE-005（icon 入口 + 弹窗进度）为过渡方案，本 ISSUE 落地后卡片上的功能 icon 可简化或并入卡片点击。
- **优先级**：已完成（2026-08-30 实施：新建 `ChildDetailPage.tsx`（tabs：学习进度 LearningDashboard / 学习主题 / AI 提示词 / 账号密码(重置+删除)）；`ChildTopicsModal`/`AgentPromptEditor` 拆出 `ChildTopicsContent`/`AgentPromptContent` 平铺组件（弹窗容器保留复用）；`Dashboard.tsx` 卡片整体点击进详情页、删除原 4 个弹窗与 state（progressChild/topicsChild/agentPrompt/resetChildId）与 5 个 icon 按钮）
- **记录时间**：2026-08-30
