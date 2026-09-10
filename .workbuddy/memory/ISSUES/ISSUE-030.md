## [ISSUE-030] 学习资料显示字号可调（孩子左侧边栏加「资料字号」按钮）

- **类型**：UX / 设置项（复用 ISSUE-023 聊天字号范式；仅孩子端 `Learn.tsx` + `MaterialsPanel.tsx` + `styles.css`）
- **描述**：在孩子的左侧边栏（图标栏）增加一个「资料字号」按钮，点击弹框提供字号档位（小/中/大/特大），用于调整**左侧展示的学习资料**的字体大小；按孩子持久化，跨刷新保留。与已实施的「聊天字号」(ISSUE-023) 并列，是同一范式在孩子端第二处字号入口。
- **现状 / 根因（已查证代码）**：
  - **现有字号设置只有聊天**：`Learn.tsx:28-35` `FONT_OPTIONS`/`DEFAULT_FONT_PX`、`:263` `showFont`、`:275` `fontSize`、`:278/:290` 按 `childId` 存 localStorage、`:896-902` 侧栏 `Type` 图标按钮、`:1160-1182` 弹框；经 CSS 变量 `--child-chat-font` 下传到 `.learn-chat`（`:1030`），仅作用于 `.bubble-md-child`。**学习资料目前无任何字号设置入口**。
  - **学习资料有三处字号表面，需分别处理**：
    1. **资料列表**（`MaterialsPanel.tsx:401-430` `.material-list`）：`.material-list-title` 16px(`styles.css:1052`)、`.material-list-count` 12px(`:1058`)、`.material-row-title` 16px(`:1105`)、`.material-row-time` 12px(`:1114`)——纯 CSS，改选择器即可。
    2. **markdown 资料正文**（`MaterialsPanel.tsx:387` `<div className="markdown-body">`）：全局 `.markdown-body` 字号——需作用域限定到资料容器（如 `.material-content .markdown-body`）再套 CSS 变量，避免影响家长端/聊天 markdown。
    3. **HTML 资料正文**（`MaterialsPanel.tsx:95` `<iframe srcDoc className="html-frame">`）：opaque origin，父页面 CSS **无法穿透**——必须经现有 `injectBridge`/`BRIDGE_SCRIPT` postMessage 通道（ISSUE-017 选词浮层同路）向 iframe 内注入 `font-size` 样式（与「不改资料 html」的约束一致）。
- **改造方向**：
  ① **侧栏加按钮**：紧邻聊天字号（`:903` 后）插入「资料字号」`sidebar-icon-btn`（如 `Type` 或 `TextSize` 图标）+ `showMatFont` state + 弹框（复制聊天字号弹框 `:1160`，复用 `FONT_OPTIONS`/`handleFontSize` 逻辑）。
  ② **状态 + 持久化**：新增 `matFontSize` state + 按 `childId` 存 localStorage（key 如 `chat:${childId}:matFontSize`，复用 `:278/:290` 模式），默认 16px（列表现状基准）。
  ③ **CSS 变量下传（列表 + markdown）**：在 `view==="materials"` 分支（`:995-1004`）给 `<MaterialsPanel>` 外层或组件内根节点设 `--material-font`；`.material-list-title/.material-row-title/.material-row-time/.material-list-count` 及资料 `.markdown-body`（作用域限定）改用 `var(--material-font, 16px)`。
  ④ **HTML 资料注入（iframe）**：经 bridge 把目标 font-size 下发给 iframe 内注入脚本（在 `BRIDGE_SCRIPT` 增 `kind:"fontSize"` 分支 + `MaterialsPanel` 收消息后 `postMessage` 下发）；脚本 `document.body.style.fontSize` 或注入 `<style>` 覆盖——复用 ISSUE-017 注入通道，资料 html 仍不改动。
  ⑤ **作用域隔离**：仅孩子端学习资料生效，家长端/聊天字号不受影响；低龄档位沿用 `FONT_OPTIONS`(22/30/38/46)。
- **⚠️ 回归**：ISSUE-023 聊天字号变量、ISSUE-026 边栏折叠/弹框、ISSUE-008/016 展示区折叠、iframe 选词(ISSUE-017)/拖拽(ISSUE-024)均不受影响；重点测「markdown 资料 + HTML 资料字号均随设置变化、刷新后保留、且不波及聊天字号」。
- **实施记录（2026-09-01）**：已落地，三处字号表面统一由 `--material-font` CSS 变量（Learn 层按 childId 存 localStorage `chat:${childId}:matFontSize`，默认 16px）驱动：
  ① 侧栏 `TextSelect` 图标按钮 + `showMatFont` 弹框（复用 `MAT_FONT_OPTIONS`/`rate-grid`，档位 16/22/30/38）；
  ② 列表（`.material-list-title/.material-list-count/.material-row-title/.material-row-time/.material-title`）改 `var(--material-font, <原px>)`；
  ③ 正文 markdown 作用域限定 `.content-panel .markdown-body, .content-panel .markdown-body *` 强制统一字号（不波及家长端/聊天 markdown）；
  ④ HTML 资料经 `page-bridge` 桥：初始字号由 `injectBridge(html, matFontPx)` 前置 `window.__PI_MAT_FONT` 注入、iframe 加载即套用；运行期变化由 MaterialsPanel 在 matFontSize 变更时 `postMessage({type:"page:mat-font",px})` 下发，桥脚本注入 `<style>`（`html,body,body * { font-size: Npx !important }`）——**不改资料 html 本体**；用 font-size（非 zoom）以免破坏查词浮层坐标。
- **优先级**：已实施（待回归验证）
- **记录时间**：2026-09-01
