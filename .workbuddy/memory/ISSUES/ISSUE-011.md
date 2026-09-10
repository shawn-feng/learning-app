## [ISSUE-011] 学习资料 html 里的语音（朗读按钮）音色与聊天语音不一致，需统一

- **类型**：bug / 需求
- **描述**：学习资料（MaterialsPanel 渲染的课程 html）里的「🔊 朗读」语音，音色与聊天消息框里的语音（TTS 朗读）不一样。需要统一为同一语音服务 / 同一音色。
- **根因（已定位）**：
  - **资料 html 用的是 Web Speech API**：课程 html 内嵌脚本（如 hanzigong `lesson-*/index.html` 的 `speak(btn, text)` 函数）调 `window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))`，并尝试挑选 Edge 在线神经语音（`cvInitVoices`：优先 `Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)` → Xiaoxiao/Yunxi Online → 本地 zh 兜底）。该机制**依赖 Chromium 暴露的语音列表，而 Electron（Chromium 内核）根本不提供这些在线神经语音**——详见 ISSUE-013 根因：`Xiaoxiao Online (Natural)` 是 **Edge 浏览器特供**的 TTS 云服务语音，Chromium 的 `getVoices()` 无此条目；Chromium 唯一在线语音是 Google network speech（需 Google API key，Electron 默认无）→ 在线分支全部落空 → fallback 系统本地 SAPI 语音（机械、难听）。⚠️ 与 iframe sandbox **无关**（speechSynthesis 不受 sandbox 限制，见 ISSUE-013）。
  - **聊天语音走主进程 edge-tts**：`window.api.voiceTts(text, {rate})`（preload.ts:242 → `voice:tts` IPC）→ `electron/lib/voice/tts.ts` 按 `tts-config.ts`（默认 provider "edge-tts"，音色由用户配置决定）合成播放，音质/音色稳定统一。
- **排查 / 修改入口**：
  - 资料 html 示例：`server/data/materials/<pid>/hanzigong/lesson-000-日月生辉/index.html:786` speak()、:745-785 cvInitVoices 语音选择；english/learn/*.html 同类。
  - 桥接方案（**推荐，课程 html 无需逐个改动**）：`src/lib/page-bridge.ts:336` `injectBridge` 注入的桥脚本里**接管/替换 `window.speechSynthesis`（speak/cancel/getVoices）**，把文本经 postMessage 上抛 → `MaterialsPanel`（或父页面）→ `window.api.voiceTts(text, {rate})` 走与聊天同一条主进程 edge-tts 链路 → 音色天然一致；需保留按钮 playing 高亮 / 停止等交互语义（可回传事件）。PageAction 已有下行通道（page-bridge.ts:58 click/scroll/input/read），可扩展或加独立上行事件。
  - 备选：改课程 html 生成模板脚本（hanzigong/english 生成器），把 speak() 改为调桥接口——需全量重生成 html，且存量文件不受影响，通用性差。
- **优先级**：已完成（2026-08-30 实施：BRIDGE_SCRIPT 注入 speechSynthesis shim——getVoices 返回模拟 Edge 在线语音（课程 cvInitVoices 选中 Xiaoxiao Online）、speak 上抛 kind=tts、cancel 上抛 tts-cancel、父级回执 page:tts:done 触发 utterance.onend 按钮复位；MaterialsPanel 处理 tts 事件走 window.api.voiceTts（edge-tts 与聊天同链路）、播完回执 iframe、cancel/卸载停止、不进页面操作记录；PageEventKind 扩展 tts/tts-cancel；page-bridge.test 新增 shim 行为测试）
- **记录时间**：2026-08-30
