## [ISSUE-016] 孩子界面：中间展示区折叠按钮仅学习资料页有，学习进度等页也需支持折叠

- **类型**：需求 / UI 一致性
- **描述**：孩子界面（Learn.tsx）中间展示区（learn-body）在**学习资料页**（`view === "materials"`）可以折叠（`materialsCollapsed`：收起资料区、聊天区占满剩余空间，左侧有折叠条/展开按钮）；但在**学习进度等其它展示页**（`view === "progress"` 渲染 `LearningDashboard`）中间区**没有折叠能力**，聊天区被固定宽度限制、无法占满。希望**所有展示页**（学习资料、学习进度等）都提供同样的折叠/展开按钮，让聊天区能占满。
- **现状 / 排查入口（已定位）**：
  - 折叠 state：`src/pages/Learn.tsx:114` `const [materialsCollapsed, setMaterialsCollapsed] = useState(false)`——命名绑定 materials，语义上应泛化为「中间展示区折叠」。
  - 折叠条（仅 materials）：`Learn.tsx:777-785` `material-collapsed-bar`（条件 `view === "materials" && materialsCollapsed`）；MaterialsPanel 内折叠按钮 `onCollapse` (:793) → `setMaterialsCollapsed(true)`。
  - 中间区分支：`Learn.tsx:775-798` `view === "materials" ? <MaterialsPanel …/> : <LearningDashboard …/>`——progress 分支直接渲染 `LearningDashboard`，无折叠包裹。
  - 聊天区宽度：`Learn.tsx:799-809`（折叠时 `flex:1` 占满），同样绑定 `view === "materials" && materialsCollapsed`。
- **改造方向**：
  ① 将「中间展示区折叠」抽象为不依赖 view 的能力（state 重命名如 `panelCollapsed`，或保留 `materialsCollapsed` 但扩展语义到所有 view）；
  ② 中间区统一包裹：无论 `MaterialsPanel` 还是 `LearningDashboard`，外层容器支持折叠 → 折叠时显示窄条展开按钮、聊天区 `flex:1` 占满；
  ③ 各展示页（如 `LearningDashboard`）需暴露 `onCollapse`（类似 MaterialsPanel 的 `onCollapse`）或在 Learn 层统一加折叠控制；
  ④ 注意 `LearningDashboard` 自身内部可能有独立布局/滚动，折叠其**外层容器**即可，无需改动其内部。
- **优先级**：已完成（2026-08-31 实施：折叠能力泛化为 `panelCollapsed`（不再绑定 view/materials）；任意展示页折叠后显示窄条展开按钮、聊天区 flex:1 占满；`LearningDashboard` 等非资料视图外层包 `panel-collapse-host` + 右上角悬浮折叠按钮（panel-collapse-fab），不侵入组件内部布局；display_content 自动展开逻辑同步改 `setPanelCollapsed(false)`）
- **记录时间**：2026-08-30
