## [ISSUE-020] 孩子端左侧「切换展示页」浮层：鼠标移到选项框就消失、难选中

- **类型**：Bug / 交互（孩子端左侧边栏）
- **描述**：孩子界面左侧边栏的「切换展示页」（学习进度 / 学习资料等）弹出框，鼠标从触发按钮移向浮层选项时，浮层就消失，很难选中目标项；移动越慢越容易出现。
- **现状 / 根因（已查证代码）**：
  - 浮层是纯 hover 驱动：`.view-switcher`（`Learn.tsx:657-661`）挂 `onMouseEnter={() => setViewMenuOpen(true)}` / `onMouseLeave={() => setViewMenuOpen(false)}`，按钮**无 onClick 切换**，只有悬停才显示（`Learn.tsx:662-690`：`<button className="view-switcher-btn">` 仅 title，无 onClick；popover `viewMenuOpen && <div className="view-switcher-popover">` 为其 DOM 子元素）。
  - **致命间隙**：`styles.css:861-863` `.view-switcher-popover { position:absolute; left: calc(100% + 6px); top:0 }`——popover 左缘相对触发器右缘外移了 **6px**，二者之间存在一条**不属于任何元素**的空白缝隙。
  - 原生 `mouseleave`（React `onMouseLeave` 语义：移到子元素不触发，但离开元素边界到空白会触发）在鼠标穿过这 6px 空白时于 `.view-switcher` 上触发 → `setViewMenuOpen(false)` → popover 卸载 → 浮层消失。慢移时鼠标精确穿越缝隙，必然触发（"慢一点就消失"）；快移有时因轨迹略斜而侥幸不触发。
  - 注：popover 虽是 `.view-switcher` 的 DOM 子节点，但视觉偏移在容器外，且中间有 6px 真空气隙，故 hover 链断裂。
- **改造方向（按稳健性递进）**：
  ① **消除间隙（首选，低成本）**：popover 改 `left: 100%`（去掉 `+6px`），并用透明桥接伪元素覆盖缝隙——`.view-switcher-popover::before { content:""; position:absolute; left:-8px; top:0; width:8px; height:100% }`，使触发热区连续无断点。
  ② **关闭延时（兜底）**：`onMouseLeave` 不直接置 false，而设 ~150-200ms 定时器 `setTimeout(() => setViewMenuOpen(false), 180)`，期间 `onMouseEnter` 取消定时器；给孩子越过缝隙的容错时间（即使仍有小缝也不关）。
  ③ **点击切换（更适合低龄）**：给 `view-switcher-btn` 加 `onClick={() => setViewMenuOpen(v => !v)}` 变真下拉，hover 仅作辅助；选中项或点外部（`click-outside`）才关闭——不依赖 hover 几何，选中最可靠。
  ④ 组合 ①②③ 最稳；另确认 `PANEL_VIEWS` 顺序含「学习进度 / 学习资料」且 `setView(v.key)` 切换无误（现有 `:677-680` 已正确）。
- **优先级**：已完成（2026-08-31 实施：组合 ①②③——popover 改 `left:100%` + `::before` 透明桥接覆盖缝隙（8px 宽、上下各延展 6px）；`onMouseLeave` 改 ~180ms 延时关闭（`onMouseEnter` 取消定时器）；按钮加 `onClick` 切换真下拉 + 文档级 click-outside 关闭（viewSwitcherRef 判断）；卸载清理定时器）
- **记录时间**：2026-08-31
