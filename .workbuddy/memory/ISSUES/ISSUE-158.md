# ISSUE-158：家长/孩子界面布局精简——家长中心去标题+动作移侧栏、侧栏折叠态（icon+悬浮名称）、双端标题栏去 File/Edit/View/Window 菜单只留全屏切换

- **类型**：UI / 需求（两块界面精简）
- **需求描述（用户两点）**：
  1. **家长界面**：顶部不要「家长中心」字样；「返回主页」「注销登录」移到左侧边栏；侧栏「菜单」两字取消；侧栏可**折叠**——折叠后只显示 icon,鼠标悬浮显示菜单名；
  2. **家长和孩子界面顶部**：去掉 File/Edit/View/Window 菜单按钮,只保留一个**全屏/退出全屏**切换按钮。
- **现状（已核实代码）**：
  - 家长中心：`Dashboard.tsx:92-102`——`dashboard-header`（h1「家长中心」+ actions 区的返回主页/注销登录 IconButton）+ `dashboard-sidebar`（`section-title`「菜单」+ 9 个 child-card 菜单项,均为 emoji+文字,无折叠态）；样式 styles.css:233-255；
  - 标题栏：`TitleBar.tsx`（App.tsx:94 挂载,**双端共用**——家长 Dashboard 与孩子 Learn 都在其下）——左上 `MENUS` 数组硬编码 File/Edit/View/Window 四组下拉（全屏目前埋在 View 菜单里,`windowFullscreenToggle` 通道现成 preload.ts:383 / ipc:2217）;右上最小化/最大化/关闭（Web 版隐藏,TitleBar.tsx:59-60 已有 `isWeb` 判定）。
- **改造方向（建议）**：
  ① **家长中心**：删 `dashboard-header` 整块；「返回主页」「注销登录」改为侧栏顶部两个 icon 项（与菜单项同排,IconButton 现成）；删「菜单」section-title；
  ② **侧栏折叠**：侧栏加折叠开关（收纳为侧栏顶部一个 icon,或贴边窄条）；折叠态宽 ~56px 只显示 emoji（现有菜单项 emoji 天然是 icon,无需换图）；展开态不变；悬浮 tooltip 用原生 `title` 即可（低龄/家长都用得上,无需自建浮层）；折叠状态 localStorage 持久化（对齐 useChatPanel 范式）；CSS：sidebar 宽度过渡 + 折叠态 child-card 只渲染 emoji（文字 `display:none`）；
  ③ **标题栏**：`MENUS` 数组与下拉渲染整块删除；原位置放一个全屏切换 IconButton（全屏态切换图标 Maximize/Minimize,需监听 fullscreen 状态事件——ipc 有 `window:fullscreen-toggle`,需补一个 fullscreen-changed 推送或轮询 `windowIsMaximized` 同款模式）；缩放/开发者工具/撤销重做/窗口控制等原菜单功能：窗口控制右上三键已有,缩放/DevTools 属调试功能可移除（或 DevTools 挂到某处,待拍板,默认删）；**Edit 的剪切/复制/粘贴/撤销**：Electron 默认快捷键（Ctrl+C/V 等）在可编辑区域原生生效,菜单删除不影响——需回归确认输入框/textarea 场景；
  ④ **孩子端同款**：TitleBar 双端共用,③ 一次改完两端自动生效；孩子端如另有 header 需同查（Learn 顶部目前无 File 菜单之外的重复元素）。
- **回归**：Web 版标题栏（isWeb 分支）正常（无窗口控制,全屏按钮在浏览器里改用 document.fullscreen 或保留隐藏,待实现时定）；家长九项菜单折叠后悬浮可辨认、点击热区不缩小；折叠状态跨刷新保留；全屏切换在孩子端弹框/语音浮层之上正常；Edit 快捷键回归（输入框、textarea、聊天框）。
- **优先级**：低-中（纯界面精简,无数据/链路风险；③ 的全屏状态监听是唯一小新功能）
- **记录时间**：2026-09-27

---

## 实施记录（2026-09-27）

- **标题栏（TitleBar.tsx 重写）**：`MENUS` 数组、下拉渲染、openMenu state、onClickOutside 监听整组删除；左上角原菜单位置改放**全屏切换 IconButton**（Maximize/Minimize 图标随全屏态切换，双端同款——Web 走浏览器 Fullscreen API）。右上窗口三键、居中标题不变。
- **全屏状态链路（新）**：main.ts 加 `enter-full-screen`/`leave-full-screen` → 推送 `window:fullscreen-changed`；ipc 加 `window:is-fullscreen`；preload 加 `windowIsFullscreen`/`onWindowFullscreen`；web-shim window 域同名（`document.fullscreenElement` 初值 + `fullscreenchange` 事件）。
- **死桩三层删除**（菜单移除后无消费方）：ipc `edit:undo/redo/cut/copy/paste` 与 `view:devtools/zoom-in/zoom-out/zoom-reset`、preload `editUndo/…/viewZoom*`、web-shim 同名方法。**Edit 快捷键不受影响**：可编辑区域的 Ctrl+C/V/X/Z 由 Chromium 原生处理，不依赖菜单（输入框/textarea/聊天框回归点）。
- **家长中心（Dashboard.tsx）**：`dashboard-header` 整块删除（不再有「家长中心」标题条）；「返回主页（孩子模式）/退出登录」移入侧栏顶部工具行（`sidebar-tools`：折叠开关 + Home + LogOut）；「菜单」section-title 删除；每个菜单项补原生 `title` 悬浮提示。
- **侧栏折叠**：`sidebarCollapsed` state（localStorage `parent:sidebarCollapsed` 持久化，对齐 useChatPanel 范式）；折叠态 CSS `width:68px`、`child-info display:none`（只显 emoji）、child-avatar 缩至 40px、工具行纵向排列、宽度 0.15s 过渡；报表未读红点 absolute 定位折叠态下仍可见。
- **回归核验**：根 tsc 无新增错误（web 侧 5 个 tsc 错误经 stash 对照确认全部为 HEAD 既有，含并行会话遗留）；双端 `npm run build` 通过；web-shim 覆盖测试通过；TitleBar 双端共用，孩子端自动生效。
