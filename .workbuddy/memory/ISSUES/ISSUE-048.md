## [ISSUE-048] 考核录音在 Ubuntu+Mac(Chromium143) 报 permission denied + 「下一题」点亮却点不动

- **类型**：缺陷 / 跨平台（Chromium 143 行为回归 + 模板交互 bug 两个独立问题）
- **现象**：客户端 0.1.11（Electron 43.3.0 / Chrome 143）在 **Ubuntu(201) 和 Mac** 上：考核页按住说话 →「无法录音：permission denied」；且录上音后「下一题」按钮变亮但**点击无反应**。Windows 未报（file:// media 有平台豁免）。
- **根因 A（录音）**：生产顶层用 `loadFile(file://)`。Chromium 143 下 file:// 顶层无真实源，**Permissions-Policy 默认 allowlist('self') 匹配不到 frame** → 考核页 srcDoc iframe 的 getUserMedia 被 policy 直接拒（日志：`Permissions policy violation: microphone is not allowed in this document.`，MediaStreamManager `PERMISSION_DENIED`）。发生在 Electron `setPermissionCheckHandler` **之前**——ISSUE-046 只补了 handler，所以 Linux 上修了仍无效。**Electron webRequest 不拦 file://**，注入响应头也无效。
  - **修复**：生产顶层改自定义 **`app://bundle`**（standard+secure scheme，`electron/lib/media-protocol.ts` 新增 `registerAppProtocol`；main.ts createWindow 改 `loadURL("app://bundle/index.html")`）→ 顶层有真实源、srcdoc iframe 同源继承 'self' 即放行；协议响应同时带 `Permissions-Policy: microphone=*, camera=*` 双保险。renderer 资源为相对引用（./assets/...），app:// 下兼容。
  - Mac 额外注意：还需「系统设置→隐私与安全性→麦克风」给「学习伙伴」授权（TCC），否则仍 NotAllowedError。
- **根因 B（下一题点不动）**：exam-template `nextBtn` 的 enabled 判定用 `curHasContent()`（录上音即亮），但 **click handler 却要求 `a.locked`**（锁定要等切走 `saveCurrent()` 才置位）→ 亮着但点下被 `if(a && !a.locked) return` 拦掉。**修复**：改为「当前题有内容即可切题」（无内容才禁止防偷看）；切走自动锁、ASR 晚到文本仍并入已锁题（asr:done 已支持）。
- **验证**：Ubuntu 201 实测通过（录音通、下一题可切）；临时用本地 build 的 asar 替换 /opt 验证（0.1.11 未正式发布此修复）。
- **版本**：客户端 0.1.11 → **0.1.12**（纯客户端；服务端不变）。
- **优先级**：P0（两平台已复现；0.1.12 需出 linux deb + mac dmg + win nsis）
- **记录时间**：2026-09-05
