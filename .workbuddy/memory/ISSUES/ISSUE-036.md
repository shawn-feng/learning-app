## [ISSUE-036] 聊天框上传应支持任意文件类型（JSON 等现被拦截）

- **类型**：UX / 文件上传（聊天框附件；涉及 `src/components/ChatWindow.tsx` 的 `accept` 属性、`processFiles` 路由、待发送附件状态）
- **描述**：聊天框上传文件时，**应能上传任何类型的文件**。目前上传 `.json` 文件时被阻止了——既选不进来，拖进去也提示「暂不支持的文件类型」。
- **现状 / 根因（已查证代码，双层拦截）**：
  - **① 选择框层就挡住**：`<input type="file" accept="image/*,audio/*,text/plain,.txt,.md">`（`ChatWindow.tsx:935-937`）——`accept` 只放行图片/音频/txt/md，**JSON 在系统文件对话框里直接灰掉选不了**。
  - **② 处理路由层也拒**：`processFiles`（`ChatWindow.tsx:377-403`）按 mime 分支——`image/*`→预览、`audio/*`→转写、`text/plain`/`.txt/.md`→读取，落到 `else` 分支（`:399-401`）直接 `setFileError("暂不支持的文件类型：${f.name}")`。JSON 的 mime 是 `application/json` 或空，**必走 else 被拒**（即便从拖拽绕过 accept 也无效）。
  - **发送侧无通用文件通道**：当前待发送附件只有 `pendingImages`/`pendingTextFiles`/`pendingAudios` 三类（`ChatWindow.tsx:212-213`），发送逻辑（`:315-324`）只认 `opts.images`/`opts.textFiles`；**没有「通用文件附件」状态**，接收侧虽有 `bubble-file`（`:770-800）渲染落盘文件，但发送侧没有对应挂起态。
- **改造方向**：
  1. **放开选择**：`accept` 改为 `.*` 或干脆移除（拖拽本就不过滤，对称一致）；tooltip 文案同步更新（加「任意文件」）。
  2. **`processFiles` 兜底分支改为「通用文件」**：`else` 不再报错，改 `persistUpload(f)` 落盘 + 推入新增的 `pendingFiles`（通用附件：`{ name, path, mime }`），渲染成 `📎 文件名` 小 chip（仿 `:875` 的 `attachment-file`，带移除按钮）；发送时 `opts.files = pendingFiles` 一并带出，agent 经 cwd（`uploads/`）读取内容（JSON 等文本类文件也可在此分支里顺手 `readFileAsText` 把内容塞进 `textFiles` 方便 agent 直接读到，与 .txt/.md 同待遇）。
  3. **新增 `pendingFiles` 状态 + 发送/清空**：`useState<FileAttachment[]>` + 发送后置空（仿 `setPendingTextFiles([])` `:324`）+ `void` 无关类型不阻断。
  4. **大小/类型安全阀（可选）**：超大文件（如 >50MB）给友好提示而非静默；二进制（如 .exe/.zip）仅落盘+引用，不尝试读取内容。
  5. **回归**：图片/音频/txt/md 现有行为不变；JSON/任意文本/二进制拖拽均能进、能发送、孩子(上传目录 `children/<id>/uploads/`)与家长(上传目录 `parents/<pid>/uploads/`，ISSUE-044)隔离路径仍正确。
- **优先级**：已实施（2026-09-02）
- **实施记录（2026-09-02）**：
  - `ChatWindow.tsx`：新增 `FileAttachment` 接口；`SendOptions`/`ChatMessage` 加 `files?`；新增 `pendingFiles` 状态；`processFiles` else 分支改为先 `readFileAsText`（json/csv 等文本类→textFiles 含内容），失败则仅 `persistUpload` + `pendingFiles`（二进制→引用）；`accept` 改为 `*/*`；tooltip 文案更新；发送时 `opts.files = pendingFiles`、发送后清空；新增 `📎 文件名` chip 渲染。
  - 验证：`tsc --noEmit` 0 业务错误；图片/音频/txt/md 现有行为不变。
- **记录时间**：2026-09-02
