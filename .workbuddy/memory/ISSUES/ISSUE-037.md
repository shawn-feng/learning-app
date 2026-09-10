## [ISSUE-037] 家长聊天框支持上传文件，落到家长 uploads 目录且家长 agent 能读取

- **类型**：功能缺口 / 文件上传（家长聊天附件；涉及 `src/components/ParentChatPanel.tsx`、`ChatWindow.tsx`、`electron/preload.ts`、`electron/lib/ipc-handlers.ts`、`pi-session.ts`）
- **描述**：家长中心的聊天框也要能**上传文件**，且文件必须落到**家长的 uploads 目录**（`data/parents/<pid>/uploads/`），家长 agent 需要能**读到这些上传的文件**（比如上传一个 json/文档让 agent 处理）。ISSUE-044 已把「上传落盘到家长库」打通，但**「家长 agent 实际读到」这条链路没接上**——家长端上传后 agent 收不到任何文件信息。
- **现状 / 根因（已查证代码，对比孩子端范式）**：
  - **孩子端范式（可照搬）**：`Learn.tsx:704-798` `handleSend(opts)` 把附件拼成**可逆标记**塞进 `text`——`【附件文件：名|相对路径】`/`【附件图片：名|路径】`/`【附件音频：名|路径】`；图片另走 `window.api.piPrompt(childId, text, images)` 的 `images` 参数（base64）。agent 凭标记 `read uploads/xxx`（约定见 `pi-session.ts:55`「孩子上传的文本文件已保存在 uploads/…用 read 工具读取标记里的路径」）。
  - **家长端断点①（发送不转发附件）**：`ParentChatPanel.handleSend(text: string)`（`:140-183`）只接 `text`、调用 `window.api.piPromptParent(text)`——**`ChatWindow` 构造的 `opts`（images/textFiles/audios）被整个丢弃**（ChatWindow.tsx:320 把 `opts` 传给 `onSend`，家长端签名只收 `text`）。
  - **家长端断点②（IPC 无附件通道）**：`preload.ts:84` `piPromptParent: (text) => invoke("pi:prompt_parent", text)` 与 `ipc-handlers.ts:1112` `pi:prompt_parent`（`async (_e, text)` → `session.prompt(text)`，`:1112-1130`）**都只认 `text`**——不像孩子端 `pi:prompt(childId, text, images)`（preload.ts:64-65 / ipc-handlers.ts:1019-1043）带 `images` 参数。**连图片都传不过去，更别说文本/通用文件**。
  - **家长端断点③（消息无标记 + 提示词无约定）**：因①②，家长上传的文件**从未以 `【附件…】` 标记进入消息文本**，家长 agent 既看不到文件名/路径、也无指令引导去读。而 `buildParentPrompt` / `LEARNING_NAV_INSTRUCTIONS`（`pi-session.ts`）里**没有类似 `:55` 的「上传文件读取」约定**。
  - **好消息——落盘与读取能力已具备**：① 上传落盘 `data/parents/<pid>/uploads/`（ISSUE-044，`ipc-handlers.ts:1502-1529`，返回相对路径 `parents/<pid>/uploads/xxx.json`）；② 家长 agent `cwd: dataDir`（`pi-session.ts:505`）、有 `read`/`ls` 工具（`:539`）——该上传路径**相对 cwd 即可 `read parents/<pid>/uploads/xxx.json`**。**只差「把标记带进消息 + 提示词约定」这两步**。
- **改造方向（对齐孩子端已验证范式）**：
  1. **`ParentChatPanel.handleSend(text, opts)`**：签名加 `opts`，接收 `ChatWindow` 的 `images/textFiles/audios`（仿 `Learn.tsx:704`）。
  2. **`preload.ts` + `ipc-handlers.ts` 扩 `piPromptParent`**：加 `images`/`textFiles`/`audios` 参数（对齐 `pi:prompt`）；`pi:prompt_parent` 内 `session.prompt(text, { images })`（有图才带），文本/音频走标记文本。
  3. **拼标记进 `text`**：在 `ParentChatPanel.handleSend`（或 ChatWindow 抽公共函数）里，仿 `Learn.tsx:764-798` 把 `opts` 转成 `【附件文件：名|parents/<pid>/uploads/xxx】`/`【附件图片：…】`/`【附件音频：…】`  append 到 text（注意 `toRel`：家长上传路径 `saveParentUpload` 已返回相对 `dataDir` 的字符串，直接拼即可；可加 `parents/<pid>/uploads/` 前缀校验防止越界）。
  4. **提示词约定**：`buildParentPrompt` 加一段「家长上传的文件保存在 `parents/<pid>/uploads/`，消息里带 `【附件文件：名|路径】` 标记；需要内容时用 read 工具读取标记路径再回应」（镜像 `pi-session.ts:55` 孩子端约定）。
  5. **与 ISSUE-036 协同**：ISSUE-036 解决「任意类型可上传 + `pendingFiles` 通用挂起态 + `opts.files` 发送」。本 issue 的家长端发送需一并消费 `opts.files`（通用文件）走标记文本（路径 `parents/<pid>/uploads/…`），避免家长端只能传图/文本。
  6. **回归**：家长上传 json/文档/图片 → 家长 agent 能 `read` 到内容并据此回应；孩子端上传行为完全不受影响（两套 `prompt` IPC 独立）；`parents/<pid>/uploads/` 与 `children/<id>/uploads/` 隔离仍正确。
- **优先级**：已实施（2026-09-02）
- **实施记录（2026-09-02）**：
  - `ParentChatPanel.tsx`：`handleSend(text, opts?)` 签名扩展；附件走可逆标记 `【附件文件/图片：名|路径】` 塞进 promptText（对齐 Learn.tsx:764-798）；user 气泡存储 attachments/textFiles/files；images 走 `piPromptParent(text, sdkImages)` 带 images 参数。
  - `preload.ts`：`piPromptParent(text, images?)` 加可选 images 参数。
  - `ipc-handlers.ts`：`pi:prompt_parent` 加 images 参数，`session.prompt(text, {images})` 对齐 child 端。
  - `pi-session.ts` `buildParentPrompt`：数据目录加 `parents/default/uploads/`；新增「家长上传文件读取」约定段（标记格式 + read 工具指令，镜像 child 端 :55）。
  - 验证：`tsc --noEmit` 0 业务错误；与 ISSUE-036 协同（opts.files 通用文件一并消费）。
- **记录时间**：2026-09-02
