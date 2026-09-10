## [ISSUE-023] 孩子聊天框字号设为可调节设置项，入口放孩子左侧边栏

- **类型**：Feature / 设置项（孩子端聊天字号调节）
- **描述**：把聊天框里的字体大小变成可调设置项，调节入口放在孩子界面的左侧边栏（与现有「朗读语速」并列），方便家长/孩子随时放大或缩小聊天文字。
- **现状 / 根因（已查证代码）**：
  - **孩子聊天字号当前硬编码**：`.bubble-md-child { font-size: 30px }`（`styles.css:2797`，ISSUE-009 将 15px 放大一倍为 30px）；其内 h1–h6 为绝对 px（h1 36 / h2 34 / h3 32 / h4–h6 30，`styles.css:2830-2835`），`pre` 代码块 22px（`:2838`）。所有值写死，家长端 `.markdown-body`（`:2401` 15px）不受影响——字号调节**仅孩子聊天的 `.bubble-md-child` 作用域**。
  - **边栏已有同类设置范式**：左侧边栏 `sidebar-rate` 区块（`Learn.tsx:713-739`）即「朗读语速」设置——展开态显示 `sidebar-section-label`+ `rate-grid` 按钮组、折叠态显示图标按钮（`Gauge`），状态 `rate` 为 `Learn.tsx:119` 的 `useState("+0%")`，经 `ChatWindow` 的 `rate` prop（`:836`）下传。字号设置**完全可套用同一骨架**（新增 `fontSize` state + 同类 UI 区块）。
  - **持久化先例**：`useChatPanel.ts`（`:7/12/19/34/42`）用 `localStorage` 按 `chat:${key}:collapsed/width` 持久化聊天面板状态，刷新后保留；而当前 `rate` 仅 `useState`、**未持久化**（刷新即回默认）。字号设置建议**复用 localStorage 范式按 childId 持久化**，避免每次进 app 重调。
- **改造方向**：
  ① **CSS 变量化**：给 `.bubble-md-child` 改 `font-size: var(--child-chat-font, 30px)`，并将 h1–h6/pre 改为相对单位（如 `1.2em`/`0.9em`）或同样引用变量派生，使一处字号即整体等比缩放；`Learn.tsx` 聊天容器设 `style={{ "--child-chat-font": fontSizePx }}`（经 `ChatWindow` 透传或外层包裹）。
  ② **边栏入口**：在 `sidebar-rate` 之后新增「聊天字号」区块（`Learn.tsx:739` 后），复用 `sidebar-section-label` + 控件：低龄友好建议**离散档位按钮**（小 22px / 中 30px(默认) / 大 38px / 特大 46px，沿用 `rate-grid` 样式），或 `<input type="range" min=16 max=48>` 滑块；折叠态给图标按钮（`Type`/`TextSize`）。
  ③ **状态与持久化**：`Learn.tsx` 加 `const [fontSize, setFontSize] = useState(...)`，`useEffect` 从 `localStorage.getItem(\`chat:${childId}:fontSize\`)` 初始化、变更时写回；默认 30px 与现状一致。
  ④ **作用域隔离**：仅对 `owner!=="parent"`（孩子聊天 `.bubble-md-child`）生效；家长端 `.markdown-body` 与资料面板不受影响（遵循 ISSUE-009 意图）。
  ⑤ **回归**：ISSUE-009 放大/紧凑行距、ISSUE-017 资料查词浮层、`.bubble-md-child` 渲染（ChatWindow）不受影响；字号滑块拖动实时生效、跨刷新保留。
- **优先级**：已完成（2026-08-31 实施：`.bubble-md-child` 改 `font-size: var(--child-chat-font, 30px)`，h1–h6/pre 改相对单位（1.2em/1.13em/1.07em/1em/0.73em）随基准等比缩放；`Learn.tsx` 边栏「朗读语速」后新增「聊天字号」区块（4 档按钮 22/30/38/46，折叠态 `Type` 图标，复用 rate-grid 样式）；`fontSize` state + localStorage 按 `chat:<childId>:fontSize` 持久化（默认 30px）；CSS 变量在 `.learn-chat` 容器下发，仅孩子聊天生效、家长端 `.markdown-body` 不受影响）
- **⚠️ 二轮修复（2026-08-31 用户实测）**：点击字号按钮气泡字体不变——根因=CSS 特异性：基础 `.message .bubble { font-size: 15px }`（0,0,2,0）压过 `.bubble-md-child`（0,0,1,0），正文一直 15px（ISSUE-009 时标题因同特异性后置规则生效、正文未放大，未被察觉）。修复=主规则提为 `.message .bubble.bubble-md-child { font-size: var(--child-chat-font,30px) }`（0,0,3,0）；标题/代码块同特异性后置已覆盖无需改。**教训：新增覆盖规则前先查基础规则特异性（.message .bubble / .markdown-body 等）**。
- **记录时间**：2026-08-31
