## [ISSUE-013] 知识记录：Electron 里 speechSynthesis 为什么选不到 Edge 在线神经语音

- **类型**：其他（调查结论 / 知识记录，为 ISSUE-011 提供根因依据）
- **结论**：**不是沙盒 iframe 导致的**——`speechSynthesis` 不受 iframe sandbox 限制（sandbox="allow-scripts …" 即可用）。真正原因是 **Electron 用的是 Chromium 内核，根本不提供 Edge 浏览器特供的微软在线神经语音**。
- **Chromium 的 getVoices() 语音来源**（Electron 与 Chrome 相同）：
  1. **本地系统语音**（Windows SAPI5 安装的语音包，如 Microsoft Huihui Desktop / Kangkang Desktop，`localService=true`）；
  2. **Google 在线语音**（network speech，`localService=false`）——需要 Google API key 且能连 Google 服务；**Electron 默认不带 key、国内也不可达** → 在线语音列表实际为空。
- **Edge 的 "Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)" 是 Edge 浏览器专属**：由微软 Edge 的 TTS 云服务提供，语音名只出现在 Edge 的 `getVoices()` 里；Chromium/Electron 的 `getVoices()` 中**根本没有这个名字**。
- **后果**（hanzigong/english 课程 html 的 `cvInitVoices` 选择策略）：精确匹配 Xiaoxiao Online → Xiaoxiao/Yunxi Online → 任意 Online(Natural) → `localService === false`——**这些分支在 Electron 里全部落空**，最终 fallback 到本地 SAPI 语音（机械音；系统未装中文语音时更差）。
- **推论**：要让资料 html 语音与聊天一致，唯一可靠路径是绕开 speechSynthesis，改走主进程 edge-tts 链路（ISSUE-011 的桥接方案）。
- **记录时间**：2026-08-30
