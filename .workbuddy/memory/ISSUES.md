# 待解决问题清单 (Open Issues)

> 本文件用于记录待解决/待实现的问题，不在此处修改项目或展开讨论。

## [ISSUE-001] 语音朗读默认速度 0.7 → 1.0

- **类型**：功能调整 / TTS 体验
- **描述**：当前语音朗读（浏览器 Web Speech API，`SpeechSynthesisUtterance`）的默认语速为 `0.7`，需改为 `1.0`（正常语速）。
- **影响范围**（按设计记忆，待在实现时复核具体文件）：
  - IPA 音标学习页（以 `longman_cache.jsonl` 为音标源，phoneme 音频来自 emma 目录）
  - `grammar.html` 语法学习页
  - 练习页 `practice.html`（紫色主题，积极词汇按音节数分组）
- **实现要点**：
  - 找到设置 `utter.rate = 0.7`（或默认 rate）的位置，改为 `1.0`。
  - 注意 TTS 策略：优先 `en-GB` 英音，无英音降级美音；改的是默认语速，不影响音种选择逻辑。
  - 若页面多处复用同一朗读函数，确保统一改到默认常量，避免遗漏。
- **当前状态 / 备注**：
  - 本次记录时，在 `C:\Users\79734\Documents\pi` 工作区（「学习伙伴」Electron 项目）内**未找到** wowenglish 的 IPA / grammar / practice 页面文件，也未搜到 `rate = 0.7` 的 TTS 默认设置。该页面可能位于本工作区之外的教学材料目录，或尚未落地到当前仓库。
  - 实施前需先定位实际文件（在对应教学材料目录 `grep` `rate` / `0.7` / `SpeechSynthesisUtterance`），确认默认速度常量所在，再统一改为 `1.0`。
- **优先级**：待定（用户未标注）
- **记录时间**：2026-08-18

## [ISSUE-002] 孩子模式引导学习时每步都重发学习资料（应发一次后不再发）

- **类型**：行为 bug / 排查
- **现象**：引导孩子学习时，每一步都会重新发送学习资料；但 method 里明确要求「发送了 html 学习资料后就不要再发送别的资料了」，实际行为与之不符。需排查原因（本会话仅记录，不修改、不讨论）。
- **规则所在（要发给孩子的资料只展示一次）**：
  - 各主题 `method.md`：`data/children/<childId>/learning/<主题>/method.md`
    - 例：`data/children/1f050a7f-.../learning/lunyu/method.md` 第 17 行：
      > 引导时用 `display_content(path="learning/lunyu/materials/{课程名}.html")` 把预生成的 html 资料展示给孩子，html资料是专门做给孩子看的，**只展示html资料，不需要再自己编资料发给孩子**。
  - 同文件第 124 行：`用 display_content 工具展示学习资料：优先 display_content(path=...{课程名}.html)`（预生成的含音频资料）。
- **发送/重建相关代码（排查入口）**：
  - 发送工具：`electron/lib/custom-tools.ts`（`display_content` 工具定义，第 13 行起）。
  - 会话系统提示与孩子模式：`electron/lib/pi-session.ts`
    - 第 21-22 行：孩子模式「读该主题的 method.md，按其中描述的教学方法引导孩子学习」。
    - 第 276 行起：`rebuildMaterialsFromHistory()` 从 session 历史重建「学习资料」列表（学习资料面板靠历史重建，而非应用层去重）。
    - 第 187 行：孩子模式 tools 含 `display_content`。
  - 前端面板：`src/pages/Learn.tsx`（学习资料面板，materials 列表）、`src/components/MaterialsPanel.tsx`。
  - 会话历史恢复/截断：孩子模式用 `SessionManager.continueRecent` + `getSessionHistory`，并对上下文长度做截断（见记忆）。
- **排查方向（待实施时验证，非结论）**：
  1. **上下文截断导致「遗忘已发」**：孩子模式对历史做截断，若较早的 `display_content` 工具调用被截断出模型上下文，模型会以为还没展示过资料，于是每步重新发送。→ 检查 `getSessionHistory` 截断逻辑是否把 toolCall 也截掉。
  2. **method 只说「别编别的资料」，没说「只发一次」**：当前文案约束的是「不要自己编其他资料」，并未显式禁止「每步重复 display 同一份 html」。模型可能把每步标准提示语理解为「这步也要展示资料」。→ 排查时确认是否要在 method 中补一句「资料只发一次，进入后续步骤不再重复 display_content」。
  3. **应用层无去重守卫**：`rebuildMaterialsFromHistory` 仅按历史重建列表，没有「同一资料已展示则不再触发/不再入列」的防护。若希望从工程上兜底，可在 `display_content` 调用或重建逻辑里加去重（但需先确认设计意图，避免误伤连学多课场景）。
- **优先级**：待定（用户未标注）
- **记录时间**：2026-08-18
