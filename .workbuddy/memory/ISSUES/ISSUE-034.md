## [ISSUE-034] 聊天气泡 markdown 渲染空行过多、消息被拉长（需紧凑化）

- **类型**：UI / CSS（聊天气泡内 agent 回复的 markdown 渲染后块级元素间距过大；涉及 `styles.css` 的 `.bubble-md` / `.bubble-md-child` / `.markdown-body` margin 规则）
- **描述**：消息框内 agent 回复的消息，在气泡里用 markdown 渲染后，**块级元素之间空行太多**（标题与列表之间、列表项之间、段落之间），导致整条消息被拉得很长。用户截图标注了多处红框空白区域（如「必学课」标题前、每个有序列表项之间、「复习课」标题前后等），要求**去掉这些多余空行，让消息更紧凑**。
- **现状 / 根因（已查证代码 + 截图对照）**：
  - **截图来源判断**：从字体大小看是**家长端聊天**（`.bubble-md`，基础字号 15px），非孩子端 30px 大字。孩子端 `.bubble-md-child` 在 ISSUE-009/023 已做过一轮「行距紧凑」但只改了 child 侧。
  - **家长端 `.bubble-md` 的 margin 值偏大**（`styles.css:1801-1837`）：
    - `h1-h6`: `margin: 14px 0 8px` —— **14px 上边距**，标题前有大段空白；
    - `ul, ol`: `margin: 4px 0 8px` —— 列表底部 8px；
    - `li`: `margin: 2px 0` —— 单项本身还行，但列表容器 margin 叠加后间距仍大。
  - **全局 `.markdown-body` 规则也叠加**（`styles.css:2548-2595`）：
    - `h1/h2`: `margin: 16px 0 8px` —— 比 `.bubble-md` 的 14px 还大（但 `.bubble-md` 选择器特异性更高应覆盖）；
    - `p`: `margin-bottom: 8px`；
    - `ul, ol`: `margin-bottom: 8px` + `padding-left: 24px`；
    - `blockquote`: `margin: 12px 0`；
    - `pre`: `margin: 12px 0` + `padding: 16px`。
  - **更关键的可能根因——空 `<p>` 标签**：LLM 输出的 markdown 常有连续空行（`\n\n\n` 或更多），经 markdown 渲染器转成**空的 `<p></p>` 或 `<p><br></p>`**，这些空标签虽无文字内容但有 `margin-bottom: 8px`（来自 `.bubble-md p` 或 `.markdown-body p`），叠加后形成截图中红框标注的大段空白。**这是最可能的「罪魁祸首」**——截图里红框位置往往正好在两个可见元素中间、且空白高度明显超过正常单倍 margin。
  - **已有「紧凑」先例但未覆盖家长端**：ISSUE-009/023 对 `.bubble-md-child`（孩子聊天）做了紧凑化（`p margin 0 0 4px`、`ul/ol margin 2px 0 4px`、`li margin 0`、`h1-h6 margin 10px 0 4px`），但 `.bubble-md`（家长聊天）**完全没做同样处理**，仍用原始宽松值。
- **改造方向**：
  1. **消除空标签空白（最优先，预计解决 80% 问题）**：给 `.bubble-md p:empty, .bubble-md p:has(> br:only-child)` 加 `margin: 0; padding: 0; height: 0; display: none;` —— 空段落不占任何空间。同时 `.markdown-body` 全局也加同样的空标签规则（防漏）。
  2. **收窄 `.bubble-md` 块级 margin（家长端对齐孩子端的紧凑值）**：
     - `h1-h6`: `14px 0 8px` → `8px 0 4px`（对标 `.bubble-md-child` 的 `10px 0 4px`）；
     - `ul, ol`: `4px 0 8px` → `2px 0 4px`；
     - `p`: `0 0 4px`（同 child）；
     - `li > ul, li > ol`: `2px 0` → `0`。
  3. **全局 `.markdown-body` 同步收窄**（影响资料面板等非聊天区域）：`h1/h2 margin-top` 从 16px 降到 10px、`p/ul/ol margin-bottom` 从 8px 降到 4px；或限定只在 `.bubble` 内生效避免波及资料面板。
  4. **⚠️ 不破坏孩子端 `.bubble-md-child` 已有的紧凑规则**（特异性更高不受影响）；资料面板 `.content-panel .markdown-body` 可保持原样（阅读场景适当宽松合理）。
- **优先级**：已实施（2026-09-02）
- **实施记录（2026-09-02）**：
  - **关键事实更正**：查证 `ChatWindow.tsx:728` 气泡容器为 `bubble bubble-md`（孩子端追加 `bubble-md-child`），**不带 `markdown-body` 类**，故全局 `.markdown-body` 规则根本不作用于气泡——原 issue「markdown-body 叠加」判断基于旧代码已不成立。因此只改 `.bubble-md` 即可，资料面板完全不受影响（契合「限定在 .bubble 内、不波及资料面板」）。
  - **（初版误判，非主因）空标签消除**：`.bubble-md p:empty, .bubble-md p:has(> br:only-child)` → `display:none`。这条对「连续空行产生空 `<p>`」有效，但**不是本次"大量空格"的主因**——闻闻最新两条消息实测用的是**单空行段落分隔（`\n\n`）**，根本不产生空 `<p>`，故该选择器对其完全无效；只起兜底作用。
  - **收窄 `.bubble-md` 块级 margin**（对齐孩子端紧凑值）：`h1-h6` `14px 0 8px`→`8px 0 4px`；`p` `0 0 8px`→`0 0 4px`；`ul,ol` `4px 0 8px`→`2px 0 4px`（padding 不变）；`li>ul,li>ol` `2px 0`→`0`。
  - 未动 `.markdown-body` / `.content-panel .markdown-body` / `.bubble-md-child`：资料面板阅读场景、孩子端既有紧凑规则均保留。
  - **⚠️ 二次修复（2026-09-02，真正根因）**：用 react-markdown 实测闻闻最新两条消息，确认 DOM 由 `<p>/<ol>/<hr>` 正常组成、无空 `<p>`——但渲染层 `.bubble-md` 的 `white-space: normal` 被 `.message .bubble` 的 `white-space: pre-wrap` **按特异性压死**（两者同为 0,2,0，但 `.message .bubble` 在前）。结果 markdown 文本里**每个 `\n` 都被当真实换行**，单空行 `\n\n` 直接变成一整行空白，叠加数次即"大量空格"。修法：把 `.bubble-md` 的 `normal` 改为 `.bubble.bubble-md`（0,2,0，靠后出现胜出）真正压过 `pre-wrap`；同时把 `.bubble-md hr` 的 `margin` 收紧到 `8px 0`（原 UA 默认 0.5em，孩子端 30px 大字下撑出 ~30px 空白）。用户气泡（仅 `bubble` 类）保留 `pre-wrap`，不受影响。
  - 验证：纯 CSS 改动，无 TS 影响；建议 dev 硬刷后回归（闻闻会话空行消失、消息明显变短）。
- **记录时间**：2026-09-02
