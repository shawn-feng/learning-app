# ISSUE-106：孩子界面字号设置入口合并——聊天字号 + 资料字号收进同一个 icon 探出的页面

- **类型**：UI / 需求
- **描述**：孩子界面左侧边栏现有两个字号设置 icon（「聊天字号」Type 图标、「资料字号」TextSelect 图标），各自弹出独立弹框。需求：**合并为一个 icon**，点击弹出**一个页面**，里面同时提供聊天框字号和左侧资料字号两组调整，减少边栏图标数量、统一字号设置入口。
- **现状（已查证代码，均为 ISSUE-023 / ISSUE-030 落地形态）**：
  - **两个独立侧栏按钮**：`src/pages/Learn.tsx:1354-1360`（`Type` 图标，title=`聊天字号 ${fontSize}px`，onClick → `setShowFont(true)`）；`:1362-1368`（`TextSelect` 图标，title=`资料字号 ${matFontSize}px`，onClick → `setShowMatFont(true)`）。
  - **两个独立弹框**：`:1736-1757`（「聊天字号」，`FONT_OPTIONS` 22/30/38/46 档，`:30-37` 定义，默认 `DEFAULT_FONT_PX=30`）；`:1760-1781`（「资料字号」，`MAT_FONT_OPTIONS` 16/22/30/38 档，`:40-46` 定义，默认 `DEFAULT_MAT_FONT_PX=16`）。弹框均为 `modal-overlay` + `rate-grid` 档位按钮 + 关闭按钮的同一骨架。
  - **状态与持久化各自独立**：`showFont`（`:312`）/`fontSize`（`:324`，localStorage `chat:<childId>:fontSize`，`:327/:339`）；`showMatFont`（`:366`）/`matFontSize`（`:346`，localStorage `chat:<childId>:matFontSize`，`:349/:361`）。
- **改造方向**：
  ① **侧栏收口为一个按钮**：删除两个字号 icon，替换为一个（建议 `Type` 或 `TextSize`，title 汇总两组当前值，如 `字号（聊天 30px / 资料 16px）`），onClick 打开合并弹框（新增 `showFontPanel` 之类单一 state，替代 `showFont`/`showMatFont` 两个弹框开关）。
  ② **一个弹框内两个分组**：弹框内加两个小节标题「聊天字号」「资料字号」，各自一组 `rate-grid` 档位按钮（`FONT_OPTIONS` 与 `MAT_FONT_OPTIONS` 保持现有档位与默认值不变）；`fontSize`/`matFontSize` 两个 state、`handleFontSize`/`handleMatFontSize` 写回逻辑与 localStorage key **全部不动**，只聚合 UI。
  ③ **下传链路零改动**：`--child-chat-font`（`.learn-chat` 容器，`:1509`）与 `--material-font`（MaterialsPanel / iframe 注入）两条 CSS 变量链路不受影响。
- **回归**：ISSUE-023 聊天字号（含 CSS 特异性教训：`.message .bubble.bubble-md-child`）、ISSUE-030 资料三处字号表面（列表 / markdown 正文 / iframe 经 page-bridge 注入）行为不变；弹框与边栏折叠态交互遵循 ISSUE-026「点击 icon 弹框」范式；家长端不受影响。
- **优先级**：待定
- **记录时间**：2026-09-17

## 解决记录（2026-09-17）

### 落地内容
1. **侧栏收口为一个按钮**（`src/pages/Learn.tsx`）：删除「聊天字号」（Type）与「资料字号」（TextSelect）两个独立 icon，替换为一个 `Type` icon，title 汇总两组当前值（`字号（聊天 30px / 资料 16px）`），onClick 打开合并弹框；`TextSelect` import 移除。弹框开关聚合为单一 `showFontPanel` state（原 `showFont`/`showMatFont` 删除）。
2. **一个弹框两个分组**：弹框标题「字号设置」，内含 `.modal-section-label` 小节标题「聊天字号」「资料字号」，各自一组 `rate-grid` 档位按钮；`FONT_OPTIONS`（22/30/38/46，默认 30）/`MAT_FONT_OPTIONS`（16/22/30/38，默认 16）档位与默认值不变；`fontSize`/`matFontSize` 两 state、`handleFontSize`/`handleMatFontSize` 写回与 localStorage key（`chat:<childId>:fontSize` / `chat:<childId>:matFontSize`）**全部未动**。
3. **`src/styles.css` 新增 `.modal-section-label`**（13px/600/#667eea，对齐 `rate-btn` active 色系；`:first-of-type` 顶部免额外间距）。
4. **下传链路零改动**：`--child-chat-font`（.learn-chat 容器）与 `--material-font`（MaterialsPanel / iframe 注入）两条 CSS 变量链路不受影响。

### 验证
- `npm run build`（electron-vite：main + preload + renderer）通过；根 tsconfig `tsc --noEmit` 的全局类型报错为既有环境问题（与 `tsc-client.txt` 历史记录相同，非本次引入）。
- 残留引用检查：`showFont`/`showMatFont`/`TextSelect` 在 Learn.tsx 中无残留。
- 弹框骨架遵循 ISSUE-026「点击 icon 弹框」范式（modal-overlay + modal + rate-grid + 关闭按钮）；家长端不涉及。

### 未做
- 未部署 / 未实机走查 UI（Electron 客户端侧改动，随下次客户端构建生效）。
