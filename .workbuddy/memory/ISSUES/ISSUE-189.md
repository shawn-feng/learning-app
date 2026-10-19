# ISSUE-189：音量检测扩到所有录音环节（ASR 前拦截）+ 孩子端「声音检测」弹框

- **类型**：需求（ISSUE-183 的延伸：从"考核朗读/背诵题"扩到"所有录音"）
- **优先级**：中（直接影响 ASR 识别质量与孩子对"自己声音小"的感知）
- **记录时间**：2026-10-18
- **关联 issue**：**ISSUE-183**（`ISSUES/ISSUE-183.md`，用户说的「检测录音音频音量」的 issue）——它已落地「考核朗读/背诵题每段录音平均音量前置校验 + 实时音量条 + 家长阈值」，但**生效范围仅考核口语题**（原文「日常聊天录音、ASR 转写不受影响」）。
- **用户原话**：「查找一个issue，是关于检测录音音频音量的。我现在要把音频音量检测应用到所有录音环节，包括输入框的语音输入，如果音量不够，不要发送给ASR服务。同时在客户端app孩子界面增加音量检测功能，icon放到左边，点击后，弹框显示一个音量检测界面，让孩子录一段音，然后检测音量是否达标。」

## 背景与现状（代码已核，2026-10-18）

**现有音量基建（ISSUE-183，可直接复用）**：解码后 PCM 全程 RMS → `norm = clamp(round((20·log10(rms)+60)×100/60), 0, 100)`（-60dBFS→0、0dBFS→100、-35dBFS→42）。服务端 `server/src/assessment/volume.ts`、考核 iframe `src/lib/exam-template.ts` 各有一份（iframe 独立 HTML 不能 import，注释互指）。客户端渲染层**没有**可复用的音量工具。

**全仓录音 → ASR 的调用点（`voiceTranscribe`）只有两处**：

| # | 环节 | 代码 | 现状 |
|---|---|---|---|
| 1 | 输入框「按住说话」语音输入（孩子端 + 家长端共用 `ChatWindow`） | `src/components/ChatWindow.tsx` `handlePressEnd` | 录完直接用整段 blob 调 `voiceTranscribe`，**无任何音量判断** → 声音再小也送去识别（浪费配额、识别结果乱） |
| 2 | 音频附件条「转写」按钮（上传/拖入的音频，ISSUE-181） | `src/components/ChatWindow.tsx` `transcribeAudioAttachment` | 同上，点击即送 ASR |
| 3 | 考核 iframe（文字题录音答完自动识别） | `src/lib/exam-template.ts` `pushSegment` → `postMessage({type:"exam:asr"})` → `ExamView` → `voiceTranscribe` | 文字题**完全没有音量门**（只有口语/背诵题有 ISSUE-183 的段级校验） |

另外 `AssessmentSettings`（家长端「测试评测」录音）只送发音评测、不送 ASR；考核口语/背诵题也不走 ASR（走 SSECP 评测）——两者不属于"送 ASR 的录音环节"，本次不改其判定口径。

**孩子端"声音够不够大"不可见**：考核页有音量条，但平时聊天/朗读没有；孩子不知道自己的设备收音偏小，家长也很难远程判断（默认阈值 42 至今未按真实孩子录音校准）。

## 方案（F1~F4）

| 项 | 设计 |
|---|---|
| **F1 统一客户端音量口径** | 新增 `src/lib/audio-volume.ts`：公式/阈值解析/结论文案/音量条着色 + `measureBlobVolumeNorm(blob)`（解码整段 PCM 算平均音量，解码失败返回 `null`）+ `createVolumeMeter(stream)`（AnalyserNode 逐帧实时电平），与 `server/src/assessment/volume.ts`、`exam-template.ts` 同公式 |
| **F2 所有 ASR 调用前加音量门** | 阈值 = 家长配置的 `minVolumeNorm`（`useVolumeThreshold`，0=关闭；读不到回退默认 42）：`isVolumeTooLow(norm, min)` = 测不出放行 / 阈值为 0 放行 / 低于线拦下。**拦下 = 不调用 `voiceTranscribe`**（不发往 ASR 服务），提示儿童友好文案 + 本次/达标线数值，让孩子重说 |
| **F3 录音中实时音量条** | 输入框录音时显示音量条（绿/黄/红 + 家长配置的达标线；0 时不画线），复用 `useAudioRecorder` 暴露的 `streamRef`（同一路麦克风，不重复 getUserMedia） |
| **F4 孩子端「声音检测」弹框** | 左侧图标栏新增 🎤 入口 → 弹框：录一段音（点开始/点停止）→ 实时音量条 + 当前音量 → 录完显示平均音量结论（✅ 声音够大 / 🙂 还差一点点 / 🔈 声音太小啦）+ 回放 + 再测一次。达标线 = 家长配置那条线（**这里达标 = 录音能送去识别**）；家长设 0 时只显示音量、不做判定 |

**阈值口径（2026-10-18 定案；同日按用户确认订正为「家长配置唯一真源」）**：
- **唯一真源 = 家长端「设置 → 发音评测 → 录音最低平均音量」**（`assessment_config.minVolumeNorm`，0=不校验）。这就是 ISSUE-183 已有的那条家长滑条，本次文案由「考核录音最低平均音量」改为通用「录音最低平均音量」，说明里补上「聊天按住说话/音频转写同样生效」。
- **子端读取方式**：新增 `useVolumeThreshold()` → `assessmentConfigGet()`（孩子进入学习页仍是家长会话、同一接口，见下文核实）→ `parseVolumeThreshold(config.minVolumeNorm, 默认 42)`；模块级 60s 缓存，读不到（离线/接口失败/Web 无通道）回退默认 42。
- **考核 iframe**：`GET /exam/config` 下发的 `examRules.minVolumeNorm`（同一份配置）——口语题判分门 + 文字题 ASR 门同用；设 0 则考核内不拦。
- **聊天语音输入 / 音频附件转写 / 声音检测弹框**：都读同一个 `useVolumeThreshold()`；家长设 0 时聊天不拦、弹框只显示音量不做判定（弹框里写明「家长没有设置达标线」）。
- 测不出音量（解码失败/环境不支持 AudioContext）一律放行，不因测不出而卡住孩子。

## 实施（2026-10-18）

**新增/改动文件**：

| 文件 | 改动 |
|---|---|
| `src/lib/audio-volume.ts`（新增） | 音量口径客户端唯一实现：`VOLUME_NORM_FLOOR_DB`、`DEFAULT_MIN_VOLUME_NORM=42`、`MIN_ASR_VOLUME_NORM=42`（**仅作读不到家长配置时的兜底默认**）、`rmsToVolumeNorm`、`parseVolumeThreshold`、`isVolumeGateEnabled`、`isVolumeTooLow`（类型谓词 `norm is number`）、`volumeVerdict`（ok/close/low 三档文案）、`volumeBarColor`、`averageVolumeNormOfBuffer`、`measureBlobVolumeNorm`（decodeAudioData → 全程 RMS；失败 null）、`createVolumeMeter`（AnalyserNode，`getNorm()`/`close()`） |
| `src/hooks/useVolumeThreshold.ts`（新增） | 达标线唯一读取入口：`assessmentConfigGet()` → `parseVolumeThreshold(config.minVolumeNorm, 42)`；模块级 60s 缓存；离线/失败回退 42。**值来自家长设置页那条滑条**（`assessment_config.minVolumeNorm`），与考核 `examRules.minVolumeNorm` 同源 |
| `src/hooks/useAudioRecorder.ts` | 暴露 `streamRef`（录音中的 MediaStream；停止/取消/出错置空）——实时音量条复用同一路流 |
| `src/components/ChatWindow.tsx` | ①`handlePressEnd`：整段解码算平均音量，`isVolumeTooLow(norm, minNorm)` → **不调 `voiceTranscribe`**，提示「声音太小…这次没有送去识别，请靠近麦克风大声再说一遍」；②`transcribeAudioAttachment`：转写前同样校验，不达标在附件条显示「声音太小（本次 N，需要 M），没有送去识别」；③录音中实时音量条（`.voice-live-meter`，rAF 逐帧上色 + 家长配置达标线，0 不画线）；④Web 兜底：被拦时调 `voiceDictationDiscard` 清掉并行听写的一次性账本（否则旧文本会串到下一次识别） |
| `src/lib/exam-template.ts` | 音量门从"仅口语题"改为**全题型**：`volPaintArea` 家长开启校验即显示音量条；`startRec` 录完统一 `volMeasureBlob` → 不达标 `return`（口语题不入答案=没答；文字题**不发 `exam:asr`**）→ 提示重录；文字题题干补「声音太轻会听不清（这次就不会送去识别）」 |
| `src/components/VolumeCheckModal.tsx`（新增） | 孩子端声音检测弹框：开始/停止录音、实时音量条（达标线=家长配置）+ 当前音量、时长、录完平均音量结论、回放刚录的音频、再测一次、关闭释放麦克风；纯本地（不调 ASR/不落盘/不上传），家长关了语音输入也能用；家长设 0 时只显示音量、不做判定 |
| `src/pages/Learn.tsx` | 左侧图标栏（`sidebar-actions`）新增 🎤「声音检测」按钮（`sidebar-icon-btn-voice`）→ `VolumeCheckModal` |
| `src/styles.css` | `.voice-live-meter*`（聊天实时条）+ `.volume-check-*`（检测弹框：轨道/达标线/大按钮/结论三色+中性态/动作按钮） |
| `src/components/AssessmentSettings.tsx` | 家长端滑条文案改成通用口径：「录音音量与朗读评分」+「录音最低平均音量」，说明补上「聊天按住说话/音频转写同样生效」（读写链路不变，仍是 `assessmentConfigGet/Set`） |
| `web/src/shim/domains/voice.ts` | 新增 Web 专属 `voiceDictationDiscard()`（清掉听写账本，`consumeDictationResult`），配合 ChatWindow 被拦时的清理 |

**未改服务端**：本次只是客户端前置拦截（不发请求就不产生 ASR 调用）；ASR 服务端不做音量兜底（与 ISSUE-183 的 `/assessment/assess` 兜底不同，ASR 侧保持"收什么转什么"）。

## 验收场景

1. 小声按住说话 → 松手后**提示声音太小、输入框没有文字**，服务端 `/asr/transcribe` **零请求**；大声重说 → 正常出文字；
2. 录音中能看到实时音量条随声音变化，达标线 = 家长设置页配的值（默认 42）；明显低于线时条是红色；
3. 上传/拖入一段很轻的音频点「转写」→ 附件条显示"声音太小…没有送去识别"，不产生 ASR 请求；
4. 考核文字题小声录 → 不送识别、提示重说；大声录 → 正常识别出文字；口语/背诵题小声录 → 仍按 ISSUE-183「不算数、重录」；
5. 家长把「录音最低平均音量」改成 60 → 孩子端 42 分的录音被拦、检测弹框达标线显示 60（60 分才 ✅）；**设为 0（关闭）→ 聊天/考核/检测弹框都不再拦**，检测弹框只显示音量并注明"家长没有设置达标线"；
6. 孩子端点左侧 🎤 → 弹框录音：小声 → 红色结论「声音太小啦（本次 N，需要 M）」；大声 → 绿色「声音够大」；可回放、可再测；关闭后麦克风释放（系统麦克风指示消失）。

## 测试与验证（2026-10-18）

- 新增 `test/issue189-volume-gate.test.ts`（**16 例全绿**）：公式锚点（静音 0 / 0dBFS 100 / -35dBFS 42 / 越界夹取）、默认值锁定（兜底 42）、AudioBuffer 平均音量（单/双声道同值）、阈值解析、`isVolumeGateEnabled`/`isVolumeTooLow`（低拦/达标放行/测不出放行/关闭放行/**家长把线改成 50 或 40 时门随之变化**）、结论文案三档、音量条着色三色、node 环境 `measureBlobVolumeNorm` 返回 null 不抛错；**接线守卫**——ChatWindow 每次 `voiceTranscribe` 前必须有 `isVolumeTooLow`+`measureBlobVolumeNorm`、阈值走 `useVolumeThreshold` 且不再写死 42、弹框同样读配置且处理 0、家长设置页文案含语音输入/音频转写、`useVolumeThreshold` 走 `assessmentConfigGet` 并回退默认 42、考核 iframe 不再用 `q.questionType && volMin > 0`、Learn 有入口与弹框。
- 类型：`tsc -p tsconfig.json --noEmit`（用 server 侧 TS 5.9 复核，客户端本地 TS7 原生包在本机报全局 lib 缺失=环境问题）→ 本次改动文件**零错误**（仓库既有 electron 侧类型债与本次无关）。
- 构建：`npm run build`（Electron 主进程/preload/渲染层）与 `npm run web:build` 均通过（本机 `%TEMP%` 有 ACL 问题需 `TEMP=<workspace>/tmp/esbuild-tmp`，属环境问题，见 ISSUE-187/188 记录）。
- 考核 iframe 内联脚本 `new Function()` 语法检查通过（`tmp/check-exam-script.cjs`）。
- ⚠️ 未跑：真实麦克风端到端（需打包后在客户端实测小声/大声、双端 web 听写账本清理）。

## 待办 / 边界

- 客户端 0.1.32 **已全平台打包（Windows 本机 + Linux/macOS GitHub Actions tag `v0.1.32`，产物在 `dist/`，未发布）**；**201 已部署 0.1.32（2026-10-19 17:51，deb 升级自 0.1.30，桌面验证 UI 正常）**；Web 需重新部署 `web/dist`。
- 阈值由家长配置（默认 42≈-35dBFS），仍待真实孩子录音校准——家长可在「设置 → 发音评测 → 录音最低平均音量」自行调低/调高/关闭。
- 家长设 0（关闭）时：聊天/附件/考核/检测弹框都不拦，检测弹框只显示音量不做判定（文案已注明）。
- 配置读取有 60s 模块级缓存：家长改完设置，孩子端最迟重新打开检测弹框（或聊天窗重挂载）后生效。
