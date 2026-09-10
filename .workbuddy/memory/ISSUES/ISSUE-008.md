## [ISSUE-008] 孩子界面：学习资料展示区可折叠；display_content 调用时自动展开并展示最新内容

- **类型**：需求 / UI
- **描述**：
  1. 孩子界面（Learn.tsx）中间的「学习资料」展示区域（MaterialsPanel，`view === "materials"`）**可以折叠**（收起后聊天区占据更多空间，展开恢复）。当前只有左侧导航栏 `learn-sidebar` 可折叠（`sidebarCollapsed`），资料区本身没有折叠能力。
  2. 当 AI 调用 **display_content** 要展示内容时，**自动展开**资料区并**展示最新内容**（即便当前处于折叠状态）。
- **现状 / 排查入口**：
  - `src/pages/Learn.tsx`：`learn-body` 内 MaterialsPanel 挂载（:763-769，仅 `view === "materials"` 时渲染）；左侧导航栏折叠参考（:622 `learn-sidebar collapsed`，state :112 `sidebarCollapsed`）；**display_content 自动打开最新资料的现有链路**（:202 注释 + :215 `data.toolName === "display_content"` → 自动打开最新一份，ISSUE-014 已实现）——折叠态自动展开可在此链路上叠加（收到 display_content 时若折叠则展开 + 定位最新资料）。
  - `src/components/MaterialsPanel.tsx`：列表 / 详情两态（详情 :184 起，列表 :232 起）；详情态已有「返回列表」（onBack），可参照加折叠按钮；`exec` 经 `useImperativeHandle` 暴露（:176），display_content 指令走 page:exec 链路。
- **优先级**：已完成（2026-08-30 实施：`MaterialsPanel` 加 `onCollapse` + 折叠按钮（详情/列表态均可用，PanelRightClose）；`Learn.tsx` 加 `materialsCollapsed` state，折叠显示窄条展开按钮；display_content 链路（materials 变化 effect）自动展开+选中最新）
- **记录时间**：2026-08-30
