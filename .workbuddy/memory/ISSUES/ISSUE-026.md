## [ISSUE-026] 孩子左侧边栏常驻折叠，所有交互统一改为点击 icon 弹框（不再内联展开）

- **类型**：UX / 交互重构（仅孩子端 `Learn.tsx` 左侧边栏；家长端 `Dashboard` 边栏不在范围）
- **描述**：孩子端左侧边栏**始终保持折叠（图标栏）状态**，不再提供「展开成宽侧栏」的能力；点击任意功能 icon，**统一用弹框（modal/popup）承载该功能的完整交互**，而不是把整个侧栏内联撑开。即把当前「折叠→点 icon→整栏展开」的交互，收敛为「折叠图标栏→点 icon→弹框」——与现有 Todolist/AI 设置/修改密码按钮已用的弹框模式一致。
- **现状 / 根因（已查证代码 `src/pages/Learn.tsx`）**：
  - **折叠状态可切换**：`sidebarCollapsed` state（`:277`），`sidebar-toggle` 按钮（`:878-884`，`PanelLeftOpen`/`PanelLeftClose`）`onClick` 翻转；折叠时 `learn-sidebar` 加 `collapsed` 类（`:877`）。
  - **折叠态下，各功能 icon 点击 = 整栏内联展开**（这正是要改掉的）：
    - 模型（`:948-966`）：折叠态 `sidebar-icon-btn`（`Bot` 图标）`onClick={() => setSidebarCollapsed(false)}`（`:953`）→ 整栏展开后显示 `ModelSelector`。
    - 朗读语速（`:968-994`）：折叠态图标（`:973`）`setSidebarCollapsed(false)` → 展开显示 `rate-grid` 按钮组。
    - 聊天字号（`:996-1023`）：折叠态图标（`:1002`）`setSidebarCollapsed(false)` → 展开显示字号档位。
    - 今日课程（`:1025-1032`）：`SidebarClassSchedule` 收 `collapsed` + `onExpand={() => setSidebarCollapsed(false)}`（`:1030`），折叠态点图标→整栏展开看完整课表。
  - **切换展示页**用浮层 popover（`:899-946`，`view-switcher-popover`）——也是「内联展开」的一种，应一并改为弹框。
  - **已经是弹框的（目标范式，证明可行）**：`sidebar-menu`（`:1034-1065`）的「今日计划」(`setShowTodo(true)`)、「AI 伙伴设置」(`setShowAiSettings(true)`)、「修改密码」(`setShowChangePassword(true)`) 三个按钮——点 icon 直接开弹框，侧栏不展开。本项目已有成熟的弹框包裹（AI 设置 / 修改密码 / `TodoModal`），本次只需把前四类（模型/语速/字号/课程/展示页）也改成同范式。
  - **关键约束（勿踩）**：`ModelSelector` 必须**常驻挂载**（`:958` 注释：折叠时仅 CSS `display:none` 隐藏，避免卸载重挂导致重置回默认模型）。改弹框后，弹框里放 `ModelSelector` 时**仍需保持挂载**（如弹框常驻隐藏实例、或 ModelSelector 在 Learn 顶层常挂、弹框内只显示其容器），否则选中的模型会丢。
- **改造方向**：
  ① **常驻折叠**：`sidebarCollapsed` 默认置 `true`（`:277`），并**移除「展开」入口**——删 `sidebar-toggle` 的翻转折叠按钮（或其只保留「收起态」语义、不再展开）；`Learn` 全量去掉 `setSidebarCollapsed(false)` 的调用（`:953/973/1002/1030` 等）。侧栏成为固定图标栏。
  ② **功能 icon → 弹框**：为四类（模型 / 朗读语速 / 聊天字号 / 今日课程）各增一个弹框状态（如 `showModelModal` 等）+ 弹框组件（复用现有 Modal 包裹）：
     - 模型弹框内放 `ModelSelector`（**保持挂载**，见约束）；
     - 语速弹框内放 `rate-grid`（沿用现有档位按钮）；
     - 字号弹框内放 `FONT_OPTIONS` 档位（沿用 `handleFontSize`）；
     - 今日课程弹框内放完整 `SidebarClassSchedule`（去掉 `collapsed`/`onExpand` 的折叠分支，直接全量展示）；
     - 切换展示页 → 弹框版 `view-switcher`（去掉 popover 的 hover 缝隙逻辑，ISSUE-020 一并根治），点选项切换 `view`。
  ③ **图标栏只留 icon**：折叠态的 `sidebar-icon-btn`/`sidebar-btn` 全部改为「点击开对应弹框」，不再内联展开；`sidebar-profile` 折叠态仅显示头像（`:886-897` 现状已如此，保留）。
  ④ **样式收敛**：`styles.css` 巩固 `.learn-sidebar.collapsed` 固定宽度（如 56px），删/停用展开态的 inline 布局依赖；新增各弹框样式复用现有 modal class。
  ⑤ **回归**：ISSUE-025 的 TodoModal（`:1038` 已在 menu）、AI 设置 / 修改密码弹框不受影响；ISSUE-016 折叠、ISSUE-019 横幅、ISSUE-023 字号变量（弹框内字号调节仍生效）、ISSUE-024 拖拽、iframe 资料区均不受影响；重点测「点模型/语速/字号/课程/展示页 icon 均弹出对应框、且模型选择不丢」。
- **优先级**：已完成（2026-09-01 实施：`Learn.tsx` 边栏常驻折叠——删 `sidebarCollapsed` state 与 `sidebar-toggle` 展开按钮，`learn-sidebar` 恒 `collapsed`（64px 图标栏）；模型/朗读语速/聊天字号/今日课程/切换展示页 5 类交互全部改为 icon 按钮 + 弹框（新增 `showModel/showRate/showFont/showClass/showView` state，`sidebar-actions` 图标栏容器）；`SidebarClassSchedule` 去掉 collapsed/onExpand 改全量渲染；view-switcher popover 逻辑整体移除（viewMenuOpen/ref/timer/click-outside 全删，ISSUE-020 的缝隙问题不再存在）；**模型弹框常驻挂载**（overlay `display` 控制显隐，`ModelSelector` 不卸载，避免重挂拉模型切回默认）；弹框复用现有 modal/rate-grid/view-option 样式 + 新增 `.sidebar-actions`/`.view-options-modal`。tsc 0 业务错误、build 通过）
- **记录时间**：2026-08-31
