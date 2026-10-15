# ISSUE-181：聊天框拖拽/选择上传的音频文件被强制自动 ASR——应改为普通附件上传（服务端处理用），转写留给麦克风录音或手动触发

- **类型**：需求变更 / 交互修正
- **优先级**：中
- **记录时间**：2026-10-13
- **用户原话**：「在聊天框拖拽上传的音频文件不要自动调 ASR 服务转文字。因为有时候只是上传音频文件到服务端处理。」
- **状态**：✅ **已实施（2026-10-13，F1~F3 落地；F4 一期不做按原案挂起）**，实施记录见文末

## 现状（代码已核）

`src/components/ChatWindow.tsx` 的 `processFiles()`（`:485`，**上传按钮多选与拖拽 drop 共用**）里，`audio/*` 分支（`:497-498`）**无条件**调 `transcribeAudioFile()`（`:525-540`）：

1. `persistUpload(file)` 落盘原始文件（失败不阻断）；
2. `window.api.voiceTranscribe(buf)` → IPC `voice:transcribe`（`electron/lib/ipc-handlers.ts:2321`）→ ffmpeg 转 16k wav → `POST /asr/transcribe`（凭证服务端化，ISSUE-165）；
3. 成功：把转写文本**追加进输入框**（`setInput(prev + r.text)`）——原文件**不会**作为附件挂上（不进 `pendingFiles`，agent 拿不到 `files/<id>` 引用）；
4. 失败：仅报「音频识别失败」——文件虽然落了盘，但界面上什么附件都没有，用户既没得到转写也没能发送文件。

⇒ 拖一个 mp3/wav/m4a 进聊天框 = 被迫走一次 ASR：费时费额度；ASR 挂了文件也发不出去；「只是想把音频文件传给服务端/agent 处理」这个诉求完全没有通路。

孩子端 `Learn.tsx` 无此分支（只有麦克风录音落盘路径），不受影响。

## 方案

| # | 改动 | 位置 | 说明 |
|---|---|---|---|
| F1 (P0) | **`audio/*` 分支改走通用附件路径**：`persistUploadForPending(f)` 落盘拿 ref → 进 `pendingFiles`（mime=audio/*，附件条标注 🎵 音频），**不调 `voiceTranscribe`**；附件标记沿用 `attachment-ref`（ref 优先、path 兜底），agent 收到 `files/<id>` 引用 | `ChatWindow.tsx:497-498`（删除该分支即落入 ：507 兜底路径，但建议显式分支以给音频专属附件条 UI） | 上传 ≠ 语音输入，两个语义分开 |
| F2 (P0) | **麦克风录音路径保持现状**：`useAudioRecorder` 语音输入的自动转写**不变**——那是「说话给 AI 听」，与「上传一个音频文件」是两回事 | `useAudioRecorder.ts`（零改动，写进回归清单） | 防止矫枉过正 |
| F3 (P1) | 音频附件条加手动「转写」按钮：用户点了才调 ASR，转写文本插入输入框（沿用现 `voiceTranscribe` 链路），失败在附件条上显示原因 | `ChatWindow.tsx` 附件条渲染 | 想要转写的人仍有一步可达 |
| F4 (P2，可选) | agent 侧工具 `transcribe_audio`（入参 `files/<id>`，服务端调 /asr 后回文本）——「上传音频到服务端处理」的 agent 闭环：孩子/家长传音频说"帮我听一下"，agent 自己转写。可复用 ISSUE-124/125 的读附件工具模式登记白名单 | `server/src/agent/parent-tools.ts` / child 侧 + `/asr/transcribe` 复用 | 没有它 agent 只能拿到文件引用但听不了内容；一期可先不做，看真实使用 |

## 验收场景

1. 拖拽 mp3 → 聊天框出现音频附件条（无 ASR 请求、无「音频识别失败」）→ 发送 → agent 收到 `【附件音频：名|files/<id>】` 引用；
2. ASR 服务不可用时拖拽上传不受任何影响；
3. 点麦克风说话 → 仍自动转写（F2 回归）；
4. （F3 后）附件条点「转写」→ 文本进输入框。

## 实施记录（2026-10-13）

### F1 音频上传改普通附件（P0）

`src/components/ChatWindow.tsx` `processFiles()` 的 `audio/*` 分支重写：`persistUploadForPending(f)` 落盘+上送服务端拿 ref → 进 `pendingFiles`（mime=audio/*），**不再调 `voiceTranscribe`**。配套：

- `FileAttachment` 加 `uid?`（客户端内部标识，不随消息发往 agent）；新增 `audioFileBlobsRef`（uid → 原 File 句柄，供手动转写重读字节；发送/移除/组件卸载释放）；任意类型兜底分支同样带 uid（mime 缺失但实为音频的文件，转写按钮仍可用）。
- 附件条拆两组渲染：🎵 音频组（带「转写」按钮与状态）与 📎 通用组（原样式，移除按钮统一走 `removePendingFile(uid)`，顺带释放 File 句柄）。
- 上传按钮提示文案同步（「音频→附件（可在附件条手动转写）」）。

### F3 附件条手动「转写」（P1）

新增 `transcribeAudioAttachment(uid)`：从 `audioFileBlobsRef` 取原 File → `arrayBuffer()` → 既有 `voiceTranscribe` IPC 链路（ffmpeg 16k wav → `/asr/transcribe`）→ 成功文本**插入输入框**（可编辑后发送）；busy 显示「转写中…」并禁用按钮，失败原因**显示在附件条上**（原实现塞全局 fileError，现按附件粒度）。每条音频独立转写、互不阻塞。

### 附件标记分流（验收 1）

- 家长端 `ParentChatPanel`：`attachmentMarker(f.mime?.startsWith("audio/") ? "音频" : "文件", f.name, f)` → agent 收到 `【附件音频：名|files/<id>】`（ref 优先、path 兜底，attachment-ref 语义不变；`AttachmentKind` 本就含「音频」，历史恢复正则 `RESTORE_ATTACHMENT_RE` 天然兼容）。
- **孩子端顺带修复**：`Learn.tsx` 发送侧此前**不消费 `opts.files`**——ISSUE-036 的通用附件通道在孩子端被静默丢弃（附件条有、发送没影）。补上 files 循环（音频标【附件音频】，其余【附件文件】，ref 优先），孩子端上传的音频/通用附件从此真正送达 agent。

### F2 麦克风录音不受影响（回归项，零改动）

`pendingAudios`（多段 base64 webm → `voice:merge` 拼接 → 落盘+【附件音频】标记）与 `useAudioRecorder` 自动转写链路一行未动；`transcribing` 状态仍只服务麦克风路径。「说话给 AI 听」与「上传音频文件」两个语义彻底分开。

### F4（P2，可选）不实施

agent 侧 `transcribe_audio` 工具按原案「一期可先不做，看真实使用」挂起——F1/F3 落地后 agent 至少能拿到 `files/<id>` 引用；真要「帮我听一下」的闭环时再立项（复用 ISSUE-124/125 upload-ref 模式 + `/asr/transcribe`）。

### 验证

- `test/attachment-ref.test.ts` 8/8、`test/page-bridge.test.ts` 39/39 全绿（附件标记契约与桥脚本无回归）；
- electron-vite build 与 web build 均通过（服务端本 issue 零改动）。

### 待验证（下批客户端包发布后）

按验收场景实测：①拖拽 mp3 → 🎵 附件条（无 ASR 请求）→ 发送 → agent 收到【附件音频：名|files/<id>】；②ASR 停机时拖拽上传不受影响；③麦克风说话仍自动转写；④附件条点「转写」→ 文本进输入框；失败原因显示在附件条上。