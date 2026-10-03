# ISSUE-169：家长中心进入孩子详情后，点左侧其它菜单不切换视图（退出详情才跳到刚点的菜单）

- **类型**：bug / UX（视图切换被详情页盖住）
- **现象**：家长中心进入孩子详情页后，点左侧边栏其它菜单（课程管理/题库/文件/定时任务/Token/设置/报表），内容区仍停留孩子详情；退出详情后页面才跳到刚才点的菜单项。
- **根因（已核实 Dashboard.tsx）**：详情渲染条件是 `{detailChild && <ChildDetailPage/>}`——**只看 detailChild、不看 view**；而其它所有视图都渲染成 `view === "x" && !detailChild`，被 detailChild 压住。侧栏菜单 onClick 只 `setView("x")`，view 状态变了但详情仍盖在最上层；退出详情（`setDetailChild(null)`）才露出早已切换的视图。连带影响 ISSUE-108 的报表推送（若在详情中推送，切到 report 也被盖住）。
- **修复（2026-09-28）**：把详情收归「孩子管理」视图的子页——渲染条件改为 `view === "children" && detailChild`，同时**去掉其它视图上的 `!detailChild` 压制**（courses/bank/files/scheduler/tokens/settings/report）。效果：任何 `setView` 都立即生效（详情随 view 离开自动卸载）；孩子管理菜单原有 `setDetailChild(null)` 保持详情关闭语义；从详情返回仍是列表。
- **验证**：electron-vite / web 双端构建过（Dashboard 为双端共享组件）；行为推演覆盖 4 条路径（详情→其它菜单立即切换、详情→孩子管理回列表、报表推送不再被详情盖住、详情内返回列表不变）。
- **优先级**：中（高频操作路径的交互困惑，但无数据风险）
- **记录时间**：2026-09-28（当日修复）
