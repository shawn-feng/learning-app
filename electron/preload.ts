import { contextBridge, ipcRenderer } from "electron";

// Store wrapper functions so they can be removed later
const listenerWrappers: Map<string, (...args: any[]) => void> = new Map();

function registerListener(channel: string, callback: (...args: any[]) => void) {
  const wrapper = (_e: any, data: any) => callback(data);
  listenerWrappers.set(channel, wrapper);
  ipcRenderer.on(channel, wrapper);
}

const api = {
  // Pi events (main -> renderer)
  onPiStreaming: (callback: (data: { childId: string; delta?: string; thinkingDelta?: string }) => void) =>
    registerListener("pi:streaming", callback),
  onPiThinking: (callback: (data: { childId: string; delta: string }) => void) =>
    registerListener("pi:thinking", callback),
  onPiToolStart: (callback: (data: any) => void) =>
    registerListener("pi:tool_start", callback),
  onPiToolEnd: (callback: (data: any) => void) =>
    registerListener("pi:tool_end", callback),
  onPiAgentEnd: (callback: (data: { childId: string }) => void) =>
    registerListener("pi:agent_end", callback),
  onPiMessageEnd: (callback: (data: any) => void) =>
    registerListener("pi:message_end", callback),
  onPiError: (callback: (error: string) => void) =>
    registerListener("pi:error", callback),
  onPiReply: (callback: (data: { childId: string; text: string }) => void) =>
    registerListener("pi:reply", callback),
  onPiReplyEnd: (callback: (data: { childId: string }) => void) =>
    registerListener("pi:reply_end", callback),
  onPiReplyError: (callback: (data: { childId: string; error: string }) => void) =>
    registerListener("pi:reply_error", callback),
  onPiSessionReset: (callback: (data: { childId: string }) => void) =>
    registerListener("pi:session_reset", callback),
  // 图片上传时主进程自动切换到视觉模型的通知（前端据此提示）
  onPiVisionModelSwitched: (callback: (data: { childId: string; modelId: string }) => void) =>
    registerListener("pi:vision_model_switched", callback),

  // Remove all Pi event listeners
  piRemoveListeners: () => {
    for (const [channel, wrapper] of listenerWrappers) {
      ipcRenderer.removeListener(channel, wrapper);
    }
    listenerWrappers.clear();
  },

  // Pi actions (renderer -> main)
  piStartChild: (childId: string) => ipcRenderer.invoke("pi:start_child", childId),
  piStartParent: () => ipcRenderer.invoke("pi:start_parent"),
  piPrompt: (childId: string, text: string, images?: Array<{ type: "image"; mimeType: string; data: string }> | null) =>
    ipcRenderer.invoke("pi:prompt", childId, text, images || null),
  // 文件上传落盘（ISSUE-008）：保存到 data/children/<childId>/uploads/，返回相对路径
  saveUpload: (childId: string, name: string, mime: string, data: ArrayBuffer) =>
    ipcRenderer.invoke("file:save_upload", { childId, name, mime, data }),
  // 用本地默认程序打开已落盘的上传文件（严格限定 uploads 目录内）
  openUpload: (childId: string, relPath: string) =>
    ipcRenderer.invoke("file:open_upload", childId, relPath),
  // 读取已落盘的上传文件内容（base64），用于历史消息播放语音录音
  readUpload: (childId: string, relPath: string) =>
    ipcRenderer.invoke("file:read_upload", childId, relPath),
  piPromptParent: (text: string) => ipcRenderer.invoke("pi:prompt_parent", text),
  piStartParentContent: () => ipcRenderer.invoke("pi:start_parent_content"),
  piPromptParentContent: (text: string) => ipcRenderer.invoke("pi:prompt_parent_content", text),
  piAbort: (childId: string) => ipcRenderer.invoke("pi:abort", childId),
  piDispose: (childId: string) => ipcRenderer.invoke("pi:dispose", childId),
  piReset: (childId: string) => ipcRenderer.invoke("pi:reset", childId),
  // Token 统计读取（ISSUE-010）：汇总 / 最近日志（childId 缺省为家长全局）
  getTokenSummary: (childId?: string) => ipcRenderer.invoke("token:summary", childId || null),
  getTokenList: (childId?: string, limit?: number) =>
    ipcRenderer.invoke("token:list", childId || null, limit ?? 50),
  piListSessions: (childId: string) => ipcRenderer.invoke("pi:listSessions", childId),
  piGetSessionMessages: (childId: string, file: string) =>
    ipcRenderer.invoke("pi:getSessionMessages", childId, file),
  piGetModels: () => ipcRenderer.invoke("pi:get_models"),
  piSwitchModel: (childId: string, provider: string, modelId: string) =>
    ipcRenderer.invoke("pi:switch_model", childId, provider, modelId),
  piGetDefaultModel: () => ipcRenderer.invoke("pi:get_default_model"),
  piSetDefaultModel: (key: string) => ipcRenderer.invoke("pi:set_default_model", key),
  piGetProgrammingModel: () => ipcRenderer.invoke("pi:get_programming_model"),
  piSetProgrammingModel: (key: string) => ipcRenderer.invoke("pi:set_programming_model", key),
  onPiDefaultModelChanged: (callback: (key: string) => void) => {
    const wrapper = (_e: any, data: any) => callback(data);
    ipcRenderer.on("pi:default_model_changed", wrapper);
    return () => ipcRenderer.removeListener("pi:default_model_changed", wrapper);
  },
  piSetApiKey: (provider: string, apiKey: string) =>
    ipcRenderer.invoke("pi:set_api_key", provider, apiKey),
  piCheckProvider: (provider: string) => ipcRenderer.invoke("pi:check_provider", provider),

  // Auth
  authLogin: (email: string, password: string) =>
    ipcRenderer.invoke("auth:login", email, password),
  authRegister: (email: string, password: string) =>
    ipcRenderer.invoke("auth:register", email, password),
  authCheck: () => ipcRenderer.invoke("auth:check"),
  authLogout: () => ipcRenderer.invoke("auth:logout"),
  authVerify: (email: string, password: string) =>
    ipcRenderer.invoke("auth:verify", email, password),

  // Children
  childAdd: (data: any) => ipcRenderer.invoke("child:add", data),
  childList: () => ipcRenderer.invoke("child:list"),
  childSelect: (childId: string) => ipcRenderer.invoke("child:select", childId),
  childAuth: (childId: string, password: string) =>
    ipcRenderer.invoke("child:auth", childId, password),
  childDelete: (childId: string) => ipcRenderer.invoke("child:delete", childId),
  // ISSUE-016: 原生确认对话框（替代渲染进程 confirm()，避免 Windows 模态对话框焦点残留）
  confirmDialog: (opts: { title?: string; message: string; detail?: string; confirmLabel?: string; cancelLabel?: string }) =>
    ipcRenderer.invoke("dialog:confirm", opts),
  childResetPassword: (childId: string, newPassword: string) =>
    ipcRenderer.invoke("child:resetPassword", childId, newPassword),
  childChangePassword: (childId: string, oldPassword: string, newPassword: string) =>
    ipcRenderer.invoke("child:changePassword", childId, oldPassword, newPassword),
  childUpdateProfile: (childId: string, updates: Record<string, string>) =>
    ipcRenderer.invoke("child:updateProfile", childId, updates),
  childGetAgentsMd: (childId: string) =>
    ipcRenderer.invoke("child:getAgentsMd", childId),
  childSaveAgentsMd: (childId: string, content: string) =>
    ipcRenderer.invoke("child:saveAgentsMd", childId, content),

  // Progress
  getProgress: (childId: string) => ipcRenderer.invoke("progress:get", childId),
  learningSummary: (childId: string) => ipcRenderer.invoke("learning:summary", childId),

  // Scheduler config (per-child, managed in parent settings)
  schedulerConfigGet: () => ipcRenderer.invoke("scheduler:config:get"),
  schedulerConfigSet: (childId: string, config: any) =>
    ipcRenderer.invoke("scheduler:config:set", childId, config),

  // General settings (materials limit)
  materialsLimitGet: () => ipcRenderer.invoke("settings:materials_limit:get"),
  materialsLimitSet: (n: number) => ipcRenderer.invoke("settings:materials_limit:set", n),

  // Skills
  skillsList: () => ipcRenderer.invoke("skills:list"),
  skillImportFolder: () => ipcRenderer.invoke("skill:import_folder"),
  skillRead: (skillName: string, filePath: string) =>
    ipcRenderer.invoke("skill:read", skillName, filePath),
  skillWrite: (skillName: string, filePath: string, content: string) =>
    ipcRenderer.invoke("skill:write", skillName, filePath, content),
  skillListFiles: (skillName: string) =>
    ipcRenderer.invoke("skill:list_files", skillName),

  // Learning topics (parent mode, 教学内容)
  learningList: (childId: string) => ipcRenderer.invoke("learning:list", childId),
  learningRead: (childId: string, relPath: string) =>
    ipcRenderer.invoke("learning:read", childId, relPath),
  learningWrite: (childId: string, relPath: string, content: string) =>
    ipcRenderer.invoke("learning:write", childId, relPath, content),

  // Sync
  syncPull: () => ipcRenderer.invoke("sync:pull"),
  syncPush: (childId: string) => ipcRenderer.invoke("sync:push", childId),
  syncFull: (childId: string) => ipcRenderer.invoke("sync:full", childId),

  // Voice (STT + TTS)
  voiceConfigGet: () => ipcRenderer.invoke("voice:config:get"),
  voiceConfigSet: (patch: any) => ipcRenderer.invoke("voice:config:set", patch),
  voiceTranscribe: (audio: ArrayBuffer, onlyProvider?: string) =>
    ipcRenderer.invoke("voice:transcribe", audio, onlyProvider),
  voiceMerge: (childId: string, segments: string[]) =>
    ipcRenderer.invoke("voice:merge", childId, segments),
  voiceTts: (text: string, opts?: any) => ipcRenderer.invoke("voice:tts", text, opts),

  // Window controls (custom title bar)
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowMaximizeToggle: () => ipcRenderer.invoke("window:maximize-toggle"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  windowFullscreenToggle: () => ipcRenderer.invoke("window:fullscreen-toggle"),
  onWindowMaximized: (callback: (maximized: boolean) => void) =>
    registerListener("window:maximized-changed", callback),

  // Edit menu
  editUndo: () => ipcRenderer.invoke("edit:undo"),
  editRedo: () => ipcRenderer.invoke("edit:redo"),
  editCut: () => ipcRenderer.invoke("edit:cut"),
  editCopy: () => ipcRenderer.invoke("edit:copy"),
  editPaste: () => ipcRenderer.invoke("edit:paste"),

  // View menu
  viewDevtools: () => ipcRenderer.invoke("view:devtools"),
  viewZoomIn: () => ipcRenderer.invoke("view:zoom-in"),
  viewZoomOut: () => ipcRenderer.invoke("view:zoom-out"),
  viewZoomReset: () => ipcRenderer.invoke("view:zoom-reset"),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
