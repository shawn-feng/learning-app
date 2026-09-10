## [ISSUE-010] 聊天消息输入框：语音输入（按住说话）按钮消失，需补回

- **类型**：bug / 功能回归
- **描述**：消息输入框里的「按住说话」语音输入按钮（Mic）不见了，需要补回来。
- **现状 / 排查入口**（已定位根因链）：
  - `src/components/ChatWindow.tsx:827-838`：Mic 按钮是**条件渲染** `voiceEnabled && (<button className="mic-button" …>…)`——`voiceEnabled` 为 false 时按钮完全不渲染。
  - `voiceEnabled` 来源：ChatWindow.tsx:169 初始 `false`，:279-280 启动后 `window.api.voiceConfigGet()` → `r.config.enabled` 赋值。
  - IPC：`voice:config:get`（`electron/lib/ipc-handlers.ts:1349`）→ `getMaskedConfig()` → `loadVoiceConfig()` 读 `getSharedDir()/voice-config.json`。
  - **根因候选**：`voice-config.ts:21` 默认 `enabled: false`——若 `voice-config.json` 不存在/丢失/被重置（SPLIT 迁移、清数据、换设备、路径变化），`loadVoiceConfig` catch 直接返回默认 false → 按钮消失；或用户在语音设置页（VoiceSettings.tsx:67 `enabled`）手动关闭；或 `voiceConfigSet` 曾写入 enabled:false。
  - 修复方向：① 排查/修复 `voice-config.json` 为何 enabled=false（文件丢失则恢复开启或默认开启）；② 或按用户期望让按钮**始终显示**（去掉 voiceEnabled 条件 / 无配置时点击引导去语音设置开启）。
- **优先级**：已完成（2026-08-30 实施：Mic 按钮**始终渲染**（去掉 voiceEnabled 条件，voice-config 丢失/未开启不再消失）；未开启时点击给引导提示「语音输入未开启：请家长在设置 → 语音输入 中开启」；root 根因=DEFAULT_CONFIG.enabled=false + 本机无 voice-config.json）
- **记录时间**：2026-08-30
