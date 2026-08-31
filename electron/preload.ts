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
  // ISSUE-019：课程时间段提醒（上课/下课，家长在定时任务里按孩子配置）
  onClassReminder: (callback: (data: { childId: string; type: "start" | "end"; label: string }) => void) =>
    registerListener("class:reminder", callback),
  // 图片上传时主进程自动切换到视觉模型的通知（前端据此提示）
  onPiVisionModelSwitched: (callback: (data: { childId: string; modelId: string }) => void) =>
    registerListener("pi:vision_model_switched", callback),

  // Page bridge（iframe 学习资料感知与操作）：上行事件上报 + 下行指令回执 + 下行指令监听
  pageEvent: (childId: string, event: any) =>
    ipcRenderer.invoke("pi:page:event", { childId, event }),
  // ISSUE-015：取走待随下一轮消息附带的页面操作（发送后即清空）
  pageTakePending: (childId: string) => ipcRenderer.invoke("pi:page:pending", childId),
  pageExecResult: (childId: string, requestId: string, result: any) =>
    ipcRenderer.invoke("pi:page:exec:result", { childId, requestId, result }),
  onPageExec: (callback: (data: { childId: string; requestId: string; action: string; params: any }) => void) =>
    registerListener("pi:page:exec", callback),

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
  // 家长聊天框上传落盘（ISSUE-044 修正）：保存到 data/parents/<parentId>/uploads/，与孩子隔离
  saveParentUpload: (parentId: string, name: string, mime: string, data: ArrayBuffer) =>
    ipcRenderer.invoke("file:save_upload_parent", { parentId, name, mime, data }),
  // 用本地默认程序打开家长 uploads 目录内已落盘的上传文件
  openParentUpload: (parentId: string, relPath: string) =>
    ipcRenderer.invoke("file:open_upload_parent", parentId, relPath),
  // 读取家长 uploads 目录内文件内容（base64），用于家长聊天历史消息播放语音录音
  readParentUpload: (parentId: string, relPath: string) =>
    ipcRenderer.invoke("file:read_upload_parent", parentId, relPath),
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
  // 方案B 阶段①：家长「对话回顾」（读服务端同步上云的会话）
  sessionReviewDates: (childId: string) => ipcRenderer.invoke("sessions:reviewDates", childId),
  sessionReviewMessages: (childId: string, date: string) =>
    ipcRenderer.invoke("sessions:reviewMessages", childId, date),
  piGetModels: () => ipcRenderer.invoke("pi:get_models"),
  piSwitchModel: (childId: string, provider: string, modelId: string) =>
    ipcRenderer.invoke("pi:switch_model", childId, provider, modelId),
  piGetDefaultModel: () => ipcRenderer.invoke("pi:get_default_model"),
  piSetDefaultModel: (key: string) => ipcRenderer.invoke("pi:set_default_model", key),
  piGetProgrammingModel: () => ipcRenderer.invoke("pi:get_programming_model"),
  piSetProgrammingModel: (key: string) => ipcRenderer.invoke("pi:set_programming_model", key),
  piGetVisionModel: () => ipcRenderer.invoke("pi:get_vision_model"),
  piSetVisionModel: (key: string) => ipcRenderer.invoke("pi:set_vision_model", key),
  piGetTtsConfig: () => ipcRenderer.invoke("pi:get_tts_config"),
  piSetTtsConfig: (patch: any) => ipcRenderer.invoke("pi:set_tts_config", patch),
  onPiDefaultModelChanged: (callback: (key: string) => void) => {
    const wrapper = (_e: any, data: any) => callback(data);
    ipcRenderer.on("pi:default_model_changed", wrapper);
    return () => ipcRenderer.removeListener("pi:default_model_changed", wrapper);
  },
  piSetApiKey: (provider: string, apiKey: string) =>
    ipcRenderer.invoke("pi:set_api_key", provider, apiKey),
  piCheckProvider: (provider: string) => ipcRenderer.invoke("pi:check_provider", provider),

  // Auth（SPLIT：认证经服务端转发公网；服务端地址在设置中配置）
  authLogin: (email: string, password: string) =>
    ipcRenderer.invoke("auth:login", email, password),
  authRegister: (email: string, password: string) =>
    ipcRenderer.invoke("auth:register", email, password),
  authCheck: () => ipcRenderer.invoke("auth:check"),
  authLogout: () => ipcRenderer.invoke("auth:logout"),
  authVerify: (email: string, password: string) =>
    ipcRenderer.invoke("auth:verify", email, password),

  // SPLIT：服务端连接配置
  serverGetConfig: () => ipcRenderer.invoke("server:get_config"),
  serverSetConfig: (url: string) => ipcRenderer.invoke("server:set_config", url),

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
  // 选择目录（备份目标等，ISSUE-041）
  pickDirectory: (title?: string) => ipcRenderer.invoke("dialog:pick_dir", title),
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
  agentsGet: (scope: string, ref: string) =>
    ipcRenderer.invoke("agents:get", scope, ref),
  agentsSave: (scope: string, ref: string, content: string) =>
    ipcRenderer.invoke("agents:save", scope, ref, content),
  agentsHistory: (scope: string, ref: string) =>
    ipcRenderer.invoke("agents:history", scope, ref),
  agentsRestore: (scope: string, ref: string, updated: string) =>
    ipcRenderer.invoke("agents:restore", scope, ref, updated),

  // Progress
  getProgress: (childId: string) => ipcRenderer.invoke("progress:get", childId),
  learningSummary: (childId: string) => ipcRenderer.invoke("learning:summary", childId),
  learningTopic: (childId: string, topic: string) =>
    ipcRenderer.invoke("learning:topic", childId, topic),
  learningCourseSummary: (childId: string, topicName: string, title: string) =>
    ipcRenderer.invoke("learning:courseSummary", childId, topicName, title),

  // Parent library (ISSUE-029)
  parentListTopics: () => ipcRenderer.invoke("parent:listTopics"),
  parentListCourses: (topicDir: string) => ipcRenderer.invoke("parent:listCourses", topicDir),
  parentGetTags: () => ipcRenderer.invoke("parent:getTags"),
  parentUpsertTag: (tag: string, dimension?: string, criteria?: string) =>
    ipcRenderer.invoke("parent:upsertTag", tag, dimension, criteria),
  parentAllocate: (childId: string, topicDir: string) =>
    ipcRenderer.invoke("parent:allocate", childId, topicDir),
  parentListChildTopics: (childId: string) =>
    ipcRenderer.invoke("parent:listChildTopics", childId),
  parentSetChildTopicDaily: (childId: string, topicDir: string, daily: string, type: string) =>
    ipcRenderer.invoke("parent:setChildTopicDaily", childId, topicDir, daily, type),
  parentDeallocate: (childId: string, topicDir: string) =>
    ipcRenderer.invoke("parent:deallocate", childId, topicDir),
  parentUpsertCourse: (topicDir: string, course: any) =>
    ipcRenderer.invoke("parent:upsertCourse", topicDir, course),
  parentUpsertTopic: (topic: any) => ipcRenderer.invoke("parent:upsertTopic", topic),
  parentDeleteCourse: (topicDir: string, title: string) =>
    ipcRenderer.invoke("parent:deleteCourse", topicDir, title),
  parentMoveCourse: (topicDir: string, title: string, direction: -1 | 1) =>
    ipcRenderer.invoke("parent:moveCourse", topicDir, title, direction),
  parentReadMaterial: (relPath: string) =>
    ipcRenderer.invoke("parent:readMaterial", relPath),
  parentListMaterials: (topicDir: string) =>
    ipcRenderer.invoke("parent:listMaterials", topicDir),
  parentUploadMaterial: (topicDir: string, subDir?: string) =>
    ipcRenderer.invoke("parent:uploadMaterial", topicDir, subDir),
  parentListTopicMaterials: (topicDir: string) =>
    ipcRenderer.invoke("parent:listTopicMaterials", topicDir),
  parentDeleteMaterial: (topicDir: string, relPath: string) =>
    ipcRenderer.invoke("parent:deleteMaterial", topicDir, relPath),

  // Scheduler config (per-child, managed in parent settings)
  schedulerConfigGet: () => ipcRenderer.invoke("scheduler:config:get"),
  schedulerConfigSet: (childId: string, config: any) =>
    ipcRenderer.invoke("scheduler:config:set", childId, config),
  // 家长会话配置（autoNewSession 等，2026-08-24）
  schedulerParentConfigSet: (config: any) =>
    ipcRenderer.invoke("scheduler:parent_config:set", config),

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

  // Backup / restore (ISSUE-003)：服务端数据 zip 备份到本地 / 上传 zip 覆盖服务端
  createBackup: () => ipcRenderer.invoke("backup:create"),
  restoreBackup: () => ipcRenderer.invoke("backup:restore"),
  backupConfigGet: () => ipcRenderer.invoke("backup:config:get"),
  backupConfigSet: (cfg: any) => ipcRenderer.invoke("backup:config:set", cfg),
  // 云端事件轮询配置（ISSUE-041 层 C，设备级）
  eventPollConfigGet: () => ipcRenderer.invoke("eventpoll:config:get"),
  eventPollConfigSet: (cfg: any) => ipcRenderer.invoke("eventpoll:config:set", cfg),

  // ISSUE-025：孩子 Todolist（今日计划）——孩子端「今日计划」弹框与「我的执行力」趋势数据源
  todoGet: (childId: string, date?: string) => ipcRenderer.invoke("todo:get", childId, date),
  todoStatsList: (childId: string, range?: number) =>
    ipcRenderer.invoke("todo:stats:list", childId, range),

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

  // App updates (ISSUE-040)
  getAppVersion: () => ipcRenderer.invoke("app:get_version"),
  checkUpdate: () => ipcRenderer.invoke("app:check_update"),
  downloadUpdate: () => ipcRenderer.invoke("app:download_update"),
  quitAndInstall: () => ipcRenderer.invoke("app:quit_and_install"),
  // 更新状态/进度事件（独立 listener，避免被 piRemoveListeners 误清）
  onUpdateStatus: (callback: (data: { status: string; info?: any; error?: string }) => void) => {
    const wrapper = (_e: any, data: any) => callback(data);
    ipcRenderer.on("app:update_status", wrapper);
    return () => ipcRenderer.removeListener("app:update_status", wrapper);
  },
  onUpdateProgress: (callback: (data: { percent: number; transferred: number; total: number; bytesPerSecond: number }) => void) => {
    const wrapper = (_e: any, data: any) => callback(data);
    ipcRenderer.on("app:update_progress", wrapper);
    return () => ipcRenderer.removeListener("app:update_progress", wrapper);
  },
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
