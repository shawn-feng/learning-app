## [ISSUE-009] 聊天消息 markdown：字体放大一倍便于孩子阅读；行间不留空行、保持正常行距

- **类型**：UI / 需求
- **描述**：
  1. 聊天消息框里的 markdown **字体再放大一倍**（当前 `.markdown-body` font-size 15px → 约 30px），方便孩子阅读。
  2. **行与行之间不要有空行**：当前 `p` 的 `margin-bottom: 8px`（ul/ol 亦 8px）让段落之间留白、消息框被拉得很长——改为正常行间距（紧凑段落边距，行高保持可读）。
- **现状 / 排查入口**：
  - 渲染：`src/components/ChatWindow.tsx:651-660`（`bubble bubble-md` 内 ReactMarkdown + remarkGfm，仅 AI 消息）。
  - 样式：全局 `.markdown-body`（`src/styles.css:2399-2427`，font-size 15px / line-height 1.7 / p margin-bottom 8px / ul、ol margin-bottom 8px）。
  - ⚠️ **作用域注意**：`.markdown-body` 为全局共享（家长端聊天、资料面板 markdown 详情也用），需确认「放大字体」仅孩子聊天生效（如给孩子聊天专属 class 或在 ChatWindow 内联覆盖），还是家长端一并放大。
- **优先级**：已完成（2026-08-30 实施：ChatWindow AI 气泡加 `bubble-md-child`（仅孩子聊天 owner!=="parent"）；styles.css 覆盖：正文 30px（翻倍）、p/ul/ol margin 收窄（紧凑行距）、标题/代码块等比放大；家长端聊天与资料面板 .markdown-body 不受影响）
- **记录时间**：2026-08-30
