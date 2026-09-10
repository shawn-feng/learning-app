## [ISSUE-031] 查词浮层优化（拼音放大 + 多音字分行各有朗读 + 不显示意思）

- **类型**：UX / 交互优化（ISSUE-017 查词功能的增强；仅 `MaterialsPanel.tsx` + `styles.css`；字典 `dictionary.ts` 无需改）
- **描述**：优化孩子端学习资料「选中/双击中文 → 查词浮层」(ISSUE-017) 的展示：① **拼音字号放大**到与字同大（当前 14px、字 22px，太小看不清）；② **多音字的多个读音分行显示**，每个读音各有独立的 🔊 音频播放；③ **去掉释义**，浮层只显示读音（字 + 拼音）。
- **现状 / 根因（已查证代码）**：
  - 渲染在 `MaterialsPanel.tsx` `WordLookupOverlay`（`:111-159`）：每个 `LookupEntry` 渲染一个 `.word-lookup-item`（`:138-149`），内含 字(`.word-lookup-item-word`)、拼音(`.word-lookup-item-py`)、释义(`.word-lookup-item-meaning`)、一个朗读按钮（`onSpeak(en.text)`，`:142-149`）；`onSpeak` = `speakMaterialText`（`:408`）。
  - 字典 `LookupEntry.pinyin` = **空格分隔的多音**（dictionary.ts:19-20，如「行」→ "háng xíng"）；目前整串当一个 span 显示、只配一个朗读按钮（朗读的是 `en.text` 整字，TTS 会取默认音，无法区分多音）——不满足「每个读音各有朗读」。
  - 字号：`.word-lookup-item-word` 22px（styles.css:3178）、`.word-lookup-item-py` 14px（:3187）、`.word-lookup-item-meaning` 13px（:3193）——拼音显著小于字。
- **改造方向**：
  ① **拼音放大**：`.word-lookup-item-py` `font-size` 提至与字一致（22px，或直接 `var(--material-font, 22px)` 与 ISSUE-030 资料字号联动）；`.word-lookup-item-word` 维持 22px（或同变量）。
  ② **多音字分行 + 每音独立朗读**：渲染时把 `en.pinyin.split(/\s+/)` 拆成读音数组；每个读音单独一行（新样式如 `.word-lookup-reading`：拼音文本 + 独立 🔊 按钮）；按钮 `onSpeak` 传入**该读音的拼音串**（如 "háng"）以播对应音——⚠️ **音频源决策待确认**：TTS 直接读拼音字母串 vs 读该字在某词中的实际读音；建议先用拼音串 TTS，后续可加「载字的最小词」优化自然度；整字朗读按钮可保留也可去掉，以「每音一播」为准。
  ③ **去掉释义**：删除 `.word-lookup-item-meaning` 渲染（`MaterialsPanel.tsx:141`）及对应 CSS（styles.css:3193-3197）；浮层只留「字 + 分行拼音 + 每音朗读」。
  ④ **布局**：`.word-lookup-item` 改为「字在左/上，右侧或下方列出各读音行（每行拼音 + 🔊）」；保持 `align-items: baseline`、换行友好（`.word-lookup-item` 已是 flex + flex-wrap）。
- **⚠️ 回归**：ISSUE-017 的选中/双击捕获（page-bridge.ts:240-266）、lookup 上抛、click 关闭 grace（MaterialsPanel:263-277）、iframe 注入通道不受影响；仅浮层内部展示与朗读粒度变化；重点测「单音字正常、多音字分行各有 🔊、拼音清晰可读、无释义」。
- **优先级**：已实施（2026-09-01）
- **实施记录（2026-09-01）**：
  - `MaterialsPanel.tsx` `WordLookupOverlay`：删除 `.word-lookup-item-meaning` 渲染与释义；`en.pinyin.split(/\s+/).filter(Boolean)` 拆读音数组；每个读音一行（`.word-lookup-reading`：拼音 + 独立 🔊），`onSpeak(py)` 传该读音拼音串；无拼音时显示 `·` 占位；高度按条目/读音数动态估算避免溢出。
  - `styles.css`：`.word-lookup-item-word`/`.word-lookup-item-py` 字号改为 `var(--material-font, 22px)`（与 ISSUE-030 资料字号联动）；新增 `.word-lookup-readings`(纵向列)/`.word-lookup-reading`(拼音+按钮行)/`.word-lookup-py-none`；删除 `.word-lookup-item-meaning` 规则；朗读按钮改为 `flex:0 0 auto` 不再 `margin-left:auto`。
  - **音频源决策**：按 issue 建议先用「拼音串 TTS」（如 "háng"），后续可加「载字的最小词」优化自然度；整字朗读按钮已移除，以「每音一播」为准。
  - **二次优化（2026-09-01 22:5x）**：浮层头部新增「朗读选中文本」按钮（`word-lookup-play-all`，`onSpeak(state.text)`），播放**整段选中文本**（非单字/单音）；与每音朗读按钮区分（整段按钮在头部、逐音按钮在每行）。`MaterialsPanel.tsx` 头部加 `.word-lookup-head-actions`(flex 容器)+按钮；`styles.css` 加 `.word-lookup-head-actions`/`.word-lookup-play-all`。
  - **扩展到聊天框（2026-09-01 23:0x）**：把查词浮层抽成共享组件 `src/components/WordLookupOverlay.tsx`（导出 `LookupState` / `WordLookupOverlay`(forwardRef) / `useWordLookup` 选区捕获 hook）；`MaterialsPanel.tsx` 删本地副本改引用共享；`ChatWindow.tsx` 接入——`messagesRef` 容器内捕获中文选区 → `lookupText` → 浮层；新增 `speakText`(任意文本 edge-tts) 作 onSpeak；浮层渲染于 ChatWindow 根。灰盒：仅中文触发、点击外部/Esc 关闭、整段朗读可用。
  - 验证：`tsc --noEmit` 对 `MaterialsPanel.tsx`/`ChatWindow.tsx`/`WordLookupOverlay.tsx` 无业务错误（已过滤 @types/node26 环境告警）。
- **记录时间**：2026-09-01
