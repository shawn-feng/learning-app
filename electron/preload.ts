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
  piPrompt: (childId: string, text: string) => ipcRenderer.invoke("pi:prompt", childId, text),
  piPromptParent: (text: string) => ipcRenderer.invoke("pi:prompt_parent", text),
  piAbort: (childId: string) => ipcRenderer.invoke("pi:abort", childId),
  piDispose: (childId: string) => ipcRenderer.invoke("pi:dispose", childId),
  piGetModels: () => ipcRenderer.invoke("pi:get_models"),
  piSwitchModel: (childId: string, provider: string, modelId: string) =>
    ipcRenderer.invoke("pi:switch_model", childId, provider, modelId),
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

  // Skills
  skillsList: () => ipcRenderer.invoke("skills:list"),
  skillImportFolder: () => ipcRenderer.invoke("skill:import_folder"),
  skillRead: (skillName: string, filePath: string) =>
    ipcRenderer.invoke("skill:read", skillName, filePath),
  skillWrite: (skillName: string, filePath: string, content: string) =>
    ipcRenderer.invoke("skill:write", skillName, filePath, content),
  skillListFiles: (skillName: string) =>
    ipcRenderer.invoke("skill:list_files", skillName),

  // Sync
  syncPull: () => ipcRenderer.invoke("sync:pull"),
  syncPush: (childId: string) => ipcRenderer.invoke("sync:push", childId),
  syncFull: (childId: string) => ipcRenderer.invoke("sync:full", childId),

  // Voice (STT + TTS)
  voiceConfigGet: () => ipcRenderer.invoke("voice:config:get"),
  voiceConfigSet: (patch: any) => ipcRenderer.invoke("voice:config:set", patch),
  voiceTranscribe: (audio: ArrayBuffer) => ipcRenderer.invoke("voice:transcribe", audio),
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
