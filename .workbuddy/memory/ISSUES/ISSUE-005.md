## [ISSUE-005] 家长模式：孩子卡片进度改为 icon 入口，点击进入详细进度看板（与孩子模式一致）

- **类型**：需求 / 交互调整（调整 ISSUE-001 的卡片直铺呈现方式）
- **描述**：
  1. 家长界面「孩子管理」里，**不再把孩子进度直接铺在卡片上**（当前 ISSUE-001 实现：进度条 + 进度摘要 + 最近学习时间），改为卡片上一个「学习进度」icon。
  2. 点击 icon 进入该孩子的**详细进度界面**，界面与孩子模式下的「学习进度看板」**完全一致**（主题总览 + 下钻），家长要能掌握孩子学习进度。
- **现状 / 排查入口**：
  - 家长模式：`src/pages/Dashboard.tsx` 孩子卡片（:206-233，ISSUE-001 渲染进度条/progressText/最近学习时间）——需改为 icon 按钮 + 点击后进入进度看板视图（弹窗或内嵌页）。
  - 可复用：`src/components/LearningDashboard.tsx`（孩子模式「学习进度看板」，`src/pages/Learn.tsx:30/:772` 挂载）——家长模式直接复用该组件（按 childId 传参即可）；如需孩子切换，可参考旧组件 `src/components/ProgressView.tsx` 的 props（childrenList/selectedChild/onSelectChild）。
  - ⚠️ `ProgressView.tsx` 当前**无人引用**（grep 全项目仅组件自身），是旧架构家长进度看板，可作参考或废弃。
  - 数据链路已通：`learning:summary` / `learning:topic` IPC（`electron/lib/ipc-handlers.ts:283/:294`）→ getLearningSummary / getTopicProgress，家长模式可复用。
- **优先级**：已完成（2026-08-30 实施：`Dashboard.tsx` 孩子卡片直铺进度改「📊 学习进度」icon（BarChart3）入口；点击弹窗复用孩子模式同一 `LearningDashboard` 组件（childId 传参）；侧栏列表同步去掉进度直铺；删除废弃 progressText 函数）
- **记录时间**：2026-08-30
