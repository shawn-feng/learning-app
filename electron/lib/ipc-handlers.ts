import { ipcMain, app, BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from "electron";
import { loginAndCache, registerAndCache, checkAuth, getCachedLicense, clearCachedLicense, verifyParentPassword, verifyLicenseWithCloud } from "./auth-manager";
import { addChild, listChildren, authChild, getProfile, deleteChild, resetChildPassword, updateChildProfile, changeChildPassword } from "./child-auth";
import { getSkillsDir, getChildDir, getUploadsDir, pruneUploads } from "./config";
import { getChildSession, getParentSession, getParentContentSession, disposeChildSession, getActiveSession, getSessionHistory, getSessionMaterials, resetChildSession, listChildSessions, readChildSessionMessages, getDefaultPrompt } from "./pi-session";
import { getAgentPrompt, saveAgentPrompt, listAgentPromptHistory, restoreAgentPromptVersion } from "./agent-prompts";
import { getAvailableModels, setProviderApiKey, checkProviderAuth, getSharedRuntime, DEFAULT_VISION_MODEL } from "./pi-runtime";
import fs from "fs";
import path from "path";
import { getMaskedConfig, applyVoiceConfigPatch, transcribeAudio, synthesize } from "./voice";
import { getLearningSummary, getTopicProgress, getCourseDailySummary } from "./learning-summary";
import {
  allocateTopicToChild,
  copyMaterialIntoParent,
  deleteParentCourse,
  listChildAllocatedTopics,
  listParentMaterials,
  listParentTopicMaterials,
  deleteParentMaterial,
  setChildTopicDaily,
  listParentTopics,
  listParentTopicCourses,
  migrateChildrenToParent,
  moveParentCourse,
  readParentMaterial,
  upsertParentCourse,
  upsertParentTopic,
  getParentUploadsDir,
  queryParentTags,
  upsertParentTag,
} from "./parent-library";
import { getChildSchedulerConfig, setChildSchedulerConfig, getParentSchedulerConfig, setParentSchedulerConfig, getBackupSchedulerConfig, setBackupSchedulerConfig, getEventPollConfig, setEventPollConfig } from "./scheduler";
import { getMaterialsLimit, setMaterialsLimit, getDefaultModelKey, setDefaultModelKey, getProgrammingModelKey, setProgrammingModelKey } from "./app-settings";
import { logRound, readTokenLog, getTokenSummary } from "./token-stats";
import { checkForUpdatesManually, downloadUpdate, quitAndInstall } from "./updater";

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle("auth:register", async (_e, email: string, password: string) => {
    try {
      const license = await registerAndCache(email, password);
      return { success: true, license };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("auth:login", async (_e, email: string, password: string) => {
    try {
      const license = await loginAndCache(email, password);
      return { success: true, license };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("auth:check", async () => {
    return checkAuth();
  });

  ipcMain.handle("auth:verify", async (_e, email: string, password: string) => {
    return verifyParentPassword(email, password);
  });

  ipcMain.handle("auth:logout", async () => {
    clearCachedLicense();
    return { success: true };
  });

  ipcMain.handle("child:add", async (_e, data: any) => {
    try {
      const license = getCachedLicense();
      if (license) {
        // 孩子上限以云端为准（防改本地 license.json 的 max_children 绕过）
        let maxChildren = license.max_children;
        const cloud = await verifyLicenseWithCloud(license.token);
        if (cloud !== null) {
          maxChildren = cloud.max_children;
        }
        const children = listChildren();
        if (children.length >= maxChildren) {
          return { success: false, error: "已达孩子数量上限" };
        }
      }
      const profile = await addChild(data);
      return { success: true, profile };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("child:list", async () => {
    return listChildren();
  });

  ipcMain.handle("child:select", async (_e, childId: string) => {
    const profile = getProfile(childId);
    if (!profile) return { success: false, error: "孩子不存在" };
    return { success: true, profile };
  });

  ipcMain.handle("child:auth", async (_e, childId: string, password: string) => {
    const ok = await authChild(childId, password);
    return { success: ok };
  });

  ipcMain.handle("child:delete", async (_e, childId: string) => {
    deleteChild(childId);
    return { success: true };
  });

  // ISSUE-016: 渲染进程的 confirm() 是原生模态对话框，Windows 上关闭后可能不归还窗口键盘焦点
  // （表现为回到主页后点击输入框无光标、需最小化再打开才恢复）。改为主进程 dialog.showMessageBox
  // 从根上消除焦点残留；按钮顺序「取消 | 确认」（defaultId=取消，删除等危险操作默认不触发）。
  ipcMain.handle("dialog:confirm", async (_e, opts: { title?: string; message: string; detail?: string; confirmLabel?: string; cancelLabel?: string }) => {
    const win = getMainWindow();
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      title: opts.title || "确认",
      message: opts.message,
      detail: opts.detail,
      buttons: [opts.cancelLabel || "取消", opts.confirmLabel || "确定"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return { confirmed: result.response === 1 };
  });

  // 选择目录（备份目标等，ISSUE-041）
  ipcMain.handle("dialog:pick_dir", async (_e, title?: string) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win) return { canceled: true };
    const res = await dialog.showOpenDialog(win, {
      title: title || "选择目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    return { canceled: false, path: res.filePaths[0] };
  });

  ipcMain.handle("child:resetPassword", async (_e, childId: string, newPassword: string) => {
    await resetChildPassword(childId, newPassword);
    return { success: true };
  });

  ipcMain.handle("child:changePassword", async (_e, childId: string, oldPassword: string, newPassword: string) => {
    const ok = await changeChildPassword(childId, oldPassword, newPassword);
    return { success: ok, error: ok ? undefined : "旧密码不正确" };
  });

  ipcMain.handle("child:updateProfile", async (_e, childId: string, updates: Record<string, string>) => {
    try {
      const profile = updateChildProfile(childId, updates as any);
      return { success: true, profile };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("child:getAgentsMd", async (_e, childId: string) => {
    // ISSUE-033：AGENTS 纯 SQLite（data/agents.sqlite）——优先返回用户版本（整体替换权威），
    // 无用户版本返回代码默认（buildAgentsMd）。无任何物理 AGENTS 文件。
    const userVer = getAgentPrompt("child", childId);
    if (userVer !== null) return { content: userVer };
    return { content: getDefaultPrompt("child", childId) };
  });

  ipcMain.handle("child:saveAgentsMd", async (_e, childId: string, content: string) => {
    try {
      // 修改后的 AGENTS 只存 SQLite（data/agents.sqlite），不落任何物理文件
      saveAgentPrompt("child", childId, content);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ---- AGENTS / 系统提示词「用户可编辑版本」通用接口（ISSUE-033）----
  ipcMain.handle("agents:get", async (_e, scope: string, ref: string) => {
    const userVer = getAgentPrompt(scope, ref);
    if (userVer !== null) return { content: userVer, customized: true };
    // 无用户整体版本：返回当前默认内容（孩子=buildAgentsMd 代码默认，家长=代码默认提示词），
    // 让家长在默认基础上修改（ISSUE-033 修：此前返回空串导致编辑器空白）。
    return { content: getDefaultPrompt(scope, ref), customized: false };
  });

  ipcMain.handle("agents:save", async (_e, scope: string, ref: string, content: string) => {
    try {
      // 保存只写 SQLite（data/agents.sqlite，prompts 当前版 + prompt_history 历史版），
      // 不再落任何物理 AGENTS 文件（ISSUE-033：查看/编辑均在家长页面，SQLite 为唯一真源）
      saveAgentPrompt(scope, ref, content);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("agents:history", async (_e, scope: string, ref: string) => {
    try {
      return { success: true, data: listAgentPromptHistory(scope, ref) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("agents:restore", async (_e, scope: string, ref: string, updated: string) => {
    try {
      return { success: true, data: restoreAgentPromptVersion(scope, ref, updated) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("learning:summary", async (_e, childId: string) => {
    try {
      return { success: true, data: getLearningSummary(childId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 单主题进度明细（含每课 CourseItem 列表）—— 进度看板「主题 → 每课 → 当课汇总」钻取数据源
  ipcMain.handle("learning:topic", async (_e, childId: string, topic: string) => {
    try {
      return { success: true, data: getTopicProgress(childId, topic) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 单课「学习情况的总结」：关联 daily_entries（block='学习'，数据库唯一真源）
  ipcMain.handle(
    "learning:courseSummary",
    async (_e, childId: string, topicName: string, title: string) => {
      try {
        return { success: true, data: getCourseDailySummary(childId, topicName, title) };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  );

  // ---- 家长库（ISSUE-029：主题/资料统一管理 + 分配给孩子）----

  ipcMain.handle("parent:listTopics", async () => {
    try {
      return { success: true, data: listParentTopics() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("parent:listCourses", async (_e, topicDir: string) => {
    try {
      return { success: true, data: listParentTopicCourses(undefined, topicDir) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ISSUE-045：标签选项从父库 tags 定义表获取（家长可编辑课程标签的下拉源）
  ipcMain.handle("parent:getTags", async () => {
    try {
      return { success: true, data: queryParentTags(undefined) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ISSUE-045：家长自由新增标签写回父库 tags 定义表
  ipcMain.handle("parent:upsertTag", async (_e, tag: string, dimension?: string, criteria?: string) => {
    try {
      upsertParentTag(undefined, tag, dimension || "", criteria || "");
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 新建/更新家长库主题（课程管理页「新建主题」，method 全文、courses 可空）
  ipcMain.handle("parent:upsertTopic", async (_e, topic: any) => {
    try {
      const r = upsertParentTopic(undefined, topic, topic.courses || []);
      return { success: true, data: r };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("parent:allocate", async (_e, childId: string, topicDir: string) => {
    try {
      const data = allocateTopicToChild(undefined, childId, topicDir);
      // ISSUE-041 架构转向：跨机分发 = 只传「分配数据包」（不含文件），孩子端本地落库。
      // 家长端生成包上传云端暂存（fire-and-forget，失败静默）；本地分配已生效（同机可用）。
      try {
        const { buildAllocPackage, uploadDelivery } = await import("./delivery");
        uploadDelivery(childId, buildAllocPackage(topicDir)).catch((e) =>
          console.error("uploadDelivery failed:", e)
        );
      } catch (e) {
        console.error("delivery upload skipped:", e);
      }
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 孩子已分配的主题清单（孩子管理页「添加学习主题」展示用）
  ipcMain.handle("parent:listChildTopics", async (_e, childId: string) => {
    try {
      return { success: true, data: listChildAllocatedTopics(childId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ISSUE-031：设置孩子某主题的每天学习量（daily + type），写入孩子库 topics.rules_json
  ipcMain.handle(
    "parent:setChildTopicDaily",
    async (_e, childId: string, topicDir: string, daily: string, type: string) => {
      try {
        return { success: true, data: setChildTopicDaily(childId, topicDir, daily, type) };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  );

  // 一次性存量迁移（html 上移父库 + method 改全文）。破坏性操作，调用方需先备份。
  ipcMain.handle("parent:migrate", async () => {
    try {
      return { success: true, data: migrateChildrenToParent() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 家长库课程管理（课程管理页）
  ipcMain.handle("parent:upsertCourse", async (_e, topicDir: string, course: any) => {
    try {
      upsertParentCourse(undefined, topicDir, course);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("parent:deleteCourse", async (_e, topicDir: string, title: string) => {
    try {
      return { success: true, data: deleteParentCourse(undefined, topicDir, title) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("parent:moveCourse", async (_e, topicDir: string, title: string, direction: -1 | 1) => {
    try {
      return { success: true, data: moveParentCourse(undefined, topicDir, title, direction) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("parent:readMaterial", async (_e, relPath: string) => {
    try {
      return { success: true, data: readParentMaterial(undefined, relPath) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("parent:listMaterials", async (_e, topicDir: string) => {
    try {
      return { success: true, data: listParentMaterials(undefined, topicDir) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 上传课程资料：主进程弹文件选择框 → 复制进父库共享 materials/<topicDir>/（未指定 subDir 时媒体进 media/ 子目录）
  ipcMain.handle("parent:uploadMaterial", async (e: IpcMainInvokeEvent, topicDir: string, subDir?: string) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender) ?? getMainWindow();
      const result = await dialog.showOpenDialog(win!, {
        title: "上传课程资料",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "资料文件", extensions: ["html", "htm", "md", "pdf", "jpg", "jpeg", "png", "webp", "mp3", "mp4", "webm", "ogg", "wav", "m4a", "aac", "flac"] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, data: { files: [] } };
      }
      const files = result.filePaths.map((p) => {
        const rel = copyMaterialIntoParent(undefined, topicDir, p, subDir);
        return { name: path.basename(p), relPath: rel };
      });
      return { success: true, data: { files } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 列出某主题全部学习资料（含 media/ 子目录），供课程详情「学习资料管理」弹框
  ipcMain.handle("parent:listTopicMaterials", async (_e, topicDir: string) => {
    try {
      return { success: true, data: listParentTopicMaterials(undefined, topicDir) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 删除某主题学习资料文件（弹框删除用），relPath 为相对 materials/<topicDir>/ 的路径
  ipcMain.handle("parent:deleteMaterial", async (_e, topicDir: string, relPath: string) => {
    try {
      deleteParentMaterial(undefined, topicDir, relPath);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ---- 学习主题文件（家长在「教学内容」里管理）----

  ipcMain.handle("learning:list", async (_e, childId: string) => {
    try {
      const learningDir = path.join(getChildDir(childId), "learning");
      if (!fs.existsSync(learningDir)) {
        return { success: true, rootFiles: [], topics: [] };
      }
      const rootFiles: string[] = [];
      const topics: { topic: string; files: string[]; subdirs: string[] }[] = [];
      for (const e of fs.readdirSync(learningDir, { withFileTypes: true })) {
        if (e.isFile()) rootFiles.push(e.name);
        else if (e.isDirectory()) {
          const topicDir = path.join(learningDir, e.name);
          const files: string[] = [];
          const subdirs: string[] = [];
          for (const se of fs.readdirSync(topicDir, { withFileTypes: true })) {
            if (se.isFile()) files.push(se.name);
            else subdirs.push(se.name);
          }
          topics.push({ topic: e.name, files, subdirs });
        }
      }
      return { success: true, rootFiles, topics };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("learning:read", async (_e, childId: string, relPath: string) => {
    try {
      const learningDir = path.resolve(getChildDir(childId), "learning");
      const full = path.resolve(learningDir, relPath);
      if (full !== learningDir && !full.startsWith(learningDir + path.sep)) {
        return { success: false, error: "路径超出学习目录" };
      }
      if (!fs.existsSync(full)) return { success: true, content: "" };
      return { success: true, content: fs.readFileSync(full, "utf-8") };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("learning:write", async (_e, childId: string, relPath: string, content: string) => {
    try {
      const learningDir = path.resolve(getChildDir(childId), "learning");
      const full = path.resolve(learningDir, relPath);
      if (full !== learningDir && !full.startsWith(learningDir + path.sep)) {
        return { success: false, error: "路径超出学习目录" };
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf-8");
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ---- 定时任务配置（家长在设置里管理，每个孩子独立，默认关闭）----

  ipcMain.handle("scheduler:config:get", async () => {
    try {
      const children = listChildren();
      const configs: Record<string, unknown> = {};
      for (const child of children) {
        configs[child.childId] = getChildSchedulerConfig(child.childId);
      }
      // ISSUE-037 续：家长会话配置（autoNewSession）随 children 一起返回
      return { success: true, configs, parent: getParentSchedulerConfig() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("scheduler:config:set", async (_e, childId: string, config: any) => {
    try {
      const saved = setChildSchedulerConfig(childId, config);
      return { success: true, config: saved };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("scheduler:parent_config:set", async (_e, config: any) => {
    try {
      const saved = setParentSchedulerConfig(config);
      return { success: true, config: saved };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ---- 通用设置（学习资料保留数量）----

  ipcMain.handle("settings:materials_limit:get", async () => {
    try {
      return { success: true, limit: getMaterialsLimit() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("settings:materials_limit:set", async (_e, n: number) => {
    try {
      return { success: true, limit: setMaterialsLimit(n) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ---- 软件更新（ISSUE-040）----
  // 当前版本号统一读 app.getVersion()（package.json），与云端 /api/version 对比
  ipcMain.handle("app:get_version", async () => {
    return { success: true, version: app.getVersion() };
  });

  // 手动检查更新：状态/进度经 app:update_status / app:update_progress 事件推送
  ipcMain.handle("app:check_update", async () => {
    return checkForUpdatesManually();
  });

  // 手动触发下载（前端「available」状态下显式下载时用；默认 available 后自动下载）
  ipcMain.handle("app:download_update", async () => {
    return downloadUpdate();
  });

  // 重启并安装（下载完成后）
  ipcMain.handle("app:quit_and_install", async () => {
    quitAndInstall();
    return { success: true };
  });

  // 默认模型（与渲染侧 Settings / ModelSelector 同源，存于 app-settings.json）
  ipcMain.handle("pi:get_default_model", async () => {
    try {
      return { success: true, key: getDefaultModelKey() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:set_default_model", async (_e: IpcMainInvokeEvent, key: string) => {
    try {
      setDefaultModelKey(key || "");
      // 通知所有渲染窗口：默认模型变了（孩子模式侧边栏自动预选新默认）
      getMainWindow()?.webContents.send("pi:default_model_changed", key || "");
      return { success: true, key: key || "" };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ISSUE-020：编程 agent 模型（未配置 = 空串，create_html_lesson 不可用）
  ipcMain.handle("pi:get_programming_model", async () => {
    try {
      return { success: true, key: getProgrammingModelKey() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:set_programming_model", async (_e: IpcMainInvokeEvent, key: string) => {
    try {
      setProgrammingModelKey(key || "");
      return { success: true, key: key || "" };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("progress:get", async (_e, childId: string) => {
    const childDir = getChildDir(childId);
    const result: Record<string, any> = {};

    const topicsPath = path.join(childDir, "study-topics.md");
    if (fs.existsSync(topicsPath)) {
      result.studyTopics = fs.readFileSync(topicsPath, "utf-8");
    }

    const rulesPath = path.join(childDir, "study-rules.md");
    if (fs.existsSync(rulesPath)) {
      result.studyRules = fs.readFileSync(rulesPath, "utf-8");
    }

    const dailyLogsDir = path.join(childDir, "daily-logs");
    if (fs.existsSync(dailyLogsDir)) {
      result.dailyLogs = fs.readdirSync(dailyLogsDir).map((f) => ({
        name: f,
        content: fs.readFileSync(path.join(dailyLogsDir, f), "utf-8"),
      }));
    }

    const lifeEventsPath = path.join(childDir, "life-events.md");
    if (fs.existsSync(lifeEventsPath)) {
      result.lifeEvents = fs.readFileSync(lifeEventsPath, "utf-8");
    }

    return result;
  });

  ipcMain.handle("skills:list", async () => {
    const skillsDir = getSkillsDir();
    if (!fs.existsSync(skillsDir)) return [];
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  });

  ipcMain.handle("skill:import_folder", async () => {
    try {
      const win = getMainWindow();
      const result = await dialog.showOpenDialog(win!, {
        properties: ["openDirectory"],
        title: "选择 Skill 文件夹",
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { cancelled: true };
      }
      const srcDir = result.filePaths[0];
      const name = path.basename(srcDir);
      const destDir = path.join(getSkillsDir(), name);
      if (fs.existsSync(destDir)) {
        return { success: false, error: `技能 "${name}" 已存在` };
      }
      copyDir(srcDir, destDir);
      return { success: true, name };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("skill:read", async (_e, skillName: string, filePath: string) => {
    try {
      const full = path.resolve(getSkillsDir(), skillName, filePath);
      const skillsRoot = path.resolve(getSkillsDir());
      if (!full.startsWith(skillsRoot + path.sep)) {
        return { success: false, error: "路径超出技能目录" };
      }
      if (!fs.existsSync(full)) return { success: true, content: "" };
      return { success: true, content: fs.readFileSync(full, "utf-8") };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("skill:write", async (_e, skillName: string, filePath: string, content: string) => {
    try {
      const full = path.resolve(getSkillsDir(), skillName, filePath);
      const skillsRoot = path.resolve(getSkillsDir());
      if (!full.startsWith(skillsRoot + path.sep)) {
        return { success: false, error: "路径超出技能目录" };
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf-8");
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("skill:list_files", async (_e, skillName: string) => {
    const dir = path.join(getSkillsDir(), skillName);
    if (!fs.existsSync(dir)) return [];
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else files.push(path.relative(dir, full).replace(/\\/g, "/"));
      }
    };
    walk(dir);
    return files;
  });

  // ---- Pi session handlers ----

  ipcMain.handle("pi:start_child", async (_e: IpcMainInvokeEvent, childId: string) => {
    try {
      const session = await getChildSession(childId);
      attachSessionEvents(session, childId, getMainWindow);
      const history = getSessionHistory(session);
      const materials = getSessionMaterials(session, getChildDir(childId)).slice(-getMaterialsLimit());
      // ISSUE-041：孩子打开会话时立即处理一轮云端收件箱（分配包/进度请求），不等定时轮询
      try {
        const { handleCloudInbox } = await import("./delivery");
        handleCloudInbox(childId)
          .then((r) => {
            if (r.applied > 0 || r.pushed) console.log(`[start_child] inbox: applied=${r.applied} pushed=${r.pushed}`);
          })
          .catch(() => {});
      } catch { /* 忽略 */ }
      return { success: true, history, materials, materialsLimit: getMaterialsLimit() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:start_parent", async () => {
    try {
      const session = await getParentSession();
      attachSessionEvents(session, "parent", getMainWindow);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(
    "pi:prompt",
    async (
      _e: IpcMainInvokeEvent,
      childId: string,
      text: string,
      images: Array<{ type: "image"; mimeType: string; data: string }> | null
    ) => {
      const imgCount = images?.length || 0;
      console.log(`[pi:prompt] child=${childId} text="${text.slice(0, 50)}" images=${imgCount}`);
      try {
        const session = await getChildSession(childId);
        // 图片上传：若当前模型不支持图像输入，自动切换到视觉模型（ISSUE-008）。
        // 切换是会话级、持久的（qwen3-vl 也能正常聊文字），仅切一次，不做切换提示状态回退。
        if (imgCount > 0) {
          const cur: any = session.model;
          const supportsImage = Array.isArray(cur?.input) && cur.input.includes("image");
          if (!supportsImage) {
            const runtime = await getSharedRuntime();
            const vl = runtime.getModel(DEFAULT_VISION_MODEL.provider, DEFAULT_VISION_MODEL.modelId);
            if (vl) {
              await session.setModel(vl);
              _e.sender.send("pi:vision_model_switched", { childId, modelId: vl.id });
              console.log(`[pi:prompt] switched to vision model ${vl.id} for image input`);
            }
          }
        }
        console.log(`[pi:prompt] session ready, calling prompt()...`);
        const beforeCount = (session as any).messages?.length ?? 0;
        await session.prompt(text, imgCount > 0 ? { images: images! } : undefined);
        console.log(`[pi:prompt] prompt() completed`);

      const messages: any[] = session.messages || [];

      // 关键：session.prompt() 出错时不抛异常，而是把 stopReason="error" +
      // errorMessage 记在最后一条 assistant 消息里（content 为空）。
      // 若忽略它，下面的提取逻辑会回退到旧回复，导致断网时反复显示同一条旧消息。
      const lastAssistant = findLastAssistant(messages);
      const errMsg = assistantError(lastAssistant);
      if (errMsg) {
        const friendly = friendlyError(errMsg);
        console.error(`[pi:prompt] LLM 调用失败:`, errMsg);
        // ISSUE-010：失败轮也记账（input 通常已实际发生），ok=false
        logRound({ session, beforeCount, channel: "child", childId, ok: false });
        _e.sender.send("pi:reply_error", { childId, error: friendly });
        _e.sender.send("pi:reply_end", { childId });
        return { success: false, error: friendly };
      }

      // Extract last assistant text and send as direct reply
      let replyText = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "assistant") {
          for (const c of (m.content || [])) {
            if (c.type === "text") replyText = c.text + replyText;
          }
          if (replyText) break;
        }
      }
      if (replyText) {
        _e.sender.send("pi:reply", { childId, text: replyText });
      } else {
        // 没有可展示的文本回复（异常兜底，正常应有 text）
        _e.sender.send("pi:reply_error", { childId, error: "没有收到回复，请重试" });
      }
      _e.sender.send("pi:reply_end", { childId });
      // ISSUE-010：正常轮记账（真实 input/output + 已有/新增估算）
      logRound({ session, beforeCount, channel: "child", childId, ok: true, replyLength: replyText.length });

      return { success: true };
    } catch (err) {
      console.error(`[pi:prompt] error:`, (err as Error).message);
      _e.sender.send("pi:reply_error", { childId, error: friendlyError((err as Error).message) });
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:prompt_parent", async (_e: IpcMainInvokeEvent, text: string) => {
    try {
      const session = await getParentSession();
      const beforeCount = (session as any).messages?.length ?? 0;
      await session.prompt(text);
      // ISSUE-037：session.prompt() 出错时不抛异常，而是把 stopReason="error" + errorMessage
      // 记在最后一条 assistant 消息里。必须像孩子会话（pi:prompt）一样显式检查并回发
      // pi:reply_error / pi:reply，否则前端（SkillEditor 等）只靠 streaming 事件、无任何错误反馈，
      // 表现为「发送后完全没反应、输入框一直转圈」。
      const lastAssistant = findLastAssistant((session as any).messages || []);
      const errMsg = assistantError(lastAssistant);
      if (errMsg) {
        const friendly = friendlyError(errMsg);
        console.error(`[pi:prompt_parent] LLM 调用失败:`, errMsg);
        // ISSUE-010：失败轮也记账（input 通常已实际发生），ok=false
        logRound({ session, beforeCount, channel: "parent", ok: false });
        _e.sender.send("pi:reply_error", { childId: "parent", error: friendly });
        _e.sender.send("pi:reply_end", { childId: "parent" });
        return { success: false, error: friendly };
      }

      // 提取最后一条 assistant 文本，作为最终回复回发（与流式 delta 同源，前端替换式展示，不重复）
      let replyText = "";
      const messages: any[] = (session as any).messages || [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "assistant") {
          for (const c of m.content || []) {
            if (c.type === "text") replyText = c.text + replyText;
          }
          if (replyText) break;
        }
      }
      if (replyText) {
        _e.sender.send("pi:reply", { childId: "parent", text: replyText });
      } else {
        // 没有可展示的文本回复（异常兜底，正常应有 text）
        _e.sender.send("pi:reply_error", { childId: "parent", error: "没有收到回复，请重试" });
      }
      _e.sender.send("pi:reply_end", { childId: "parent" });
      // ISSUE-010：正常轮记账
      logRound({ session, beforeCount, channel: "parent", ok: true, replyLength: replyText.length });
      return { success: true };
    } catch (err) {
      console.error(`[pi:prompt_parent] error:`, (err as Error).message);
      _e.sender.send("pi:reply_error", { childId: "parent", error: friendlyError((err as Error).message) });
      _e.sender.send("pi:reply_end", { childId: "parent" });
      return { success: false, error: (err as Error).message };
    }
  });

  // ---- 教学内容生成专用会话（ISSUE-026）：与通用家长助手解耦，专门引导家长制作教学内容 ----
  ipcMain.handle("pi:start_parent_content", async () => {
    try {
      const session = await getParentContentSession();
      attachSessionEvents(session, "parent-content", getMainWindow);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:prompt_parent_content", async (_e: IpcMainInvokeEvent, text: string) => {
    try {
      const session = await getParentContentSession();
      const beforeCount = (session as any).messages?.length ?? 0;
      await session.prompt(text);
      // ISSUE-037：同 pi:prompt_parent——prompt 失败不抛异常，错误在最后一条 assistant 消息里，
      // 必须显式检查并回发 pi:reply_error / pi:reply（childId=parent-content，前端 TopicDetail /
      // TopicEditor 据此展示），否则家长「课程管理」页聊天发送后静默无反应、busy 卡死。
      const lastAssistant = findLastAssistant((session as any).messages || []);
      const errMsg = assistantError(lastAssistant);
      if (errMsg) {
        const friendly = friendlyError(errMsg);
        console.error(`[pi:prompt_parent_content] LLM 调用失败:`, errMsg);
        logRound({ session, beforeCount, channel: "parent", ok: false });
        _e.sender.send("pi:reply_error", { childId: "parent-content", error: friendly });
        _e.sender.send("pi:reply_end", { childId: "parent-content" });
        return { success: false, error: friendly };
      }

      let replyText = "";
      const messages: any[] = (session as any).messages || [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "assistant") {
          for (const c of m.content || []) {
            if (c.type === "text") replyText = c.text + replyText;
          }
          if (replyText) break;
        }
      }
      if (replyText) {
        _e.sender.send("pi:reply", { childId: "parent-content", text: replyText });
      } else {
        _e.sender.send("pi:reply_error", { childId: "parent-content", error: "没有收到回复，请重试" });
      }
      _e.sender.send("pi:reply_end", { childId: "parent-content" });
      logRound({ session, beforeCount, channel: "parent", ok: true, replyLength: replyText.length });
      return { success: true };
    } catch (err) {
      console.error(`[pi:prompt_parent_content] error:`, (err as Error).message);
      _e.sender.send("pi:reply_error", { childId: "parent-content", error: friendlyError((err as Error).message) });
      _e.sender.send("pi:reply_end", { childId: "parent-content" });
      return { success: false, error: (err as Error).message };
    }
  });

  // ---- token 统计读取（ISSUE-010）：家长端只读汇总 / 最近日志 ----
  // childId 缺省时返回全局（家长会话）统计；传 childId 时返回该孩子隔离统计。
  ipcMain.handle("token:summary", async (_e, childId?: string) => {
    try {
      return { success: true, summary: getTokenSummary(childId || undefined) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("token:list", async (_e, childId?: string, limit?: number) => {
    try {
      return { success: true, entries: readTokenLog(childId || undefined, limit ?? 50) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:abort", async (_e: IpcMainInvokeEvent, childId: string) => {
    const session = getActiveSession(childId);
    if (session) await session.abort();
    return { success: true };
  });

  ipcMain.handle("pi:get_models", async () => {
    try {
      const models = await getAvailableModels();
      return models.map((m: any) => ({
        provider: m.provider,
        id: m.id,
        name: m.name || m.id,
      }));
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:switch_model", async (_e: IpcMainInvokeEvent, childId: string, provider: string, modelId: string) => {
    try {
      const session = getActiveSession(childId);
      if (!session) throw new Error("No active session");
      const runtime = await getSharedRuntime();
      const model = runtime.getModel(provider, modelId);
      if (!model) throw new Error("Model not found");
      await session.setModel(model);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:set_api_key", async (_e: IpcMainInvokeEvent, provider: string, apiKey: string) => {
    try {
      await setProviderApiKey(provider, apiKey);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:check_provider", async (_e: IpcMainInvokeEvent, provider: string) => {
    try {
      return { success: true, status: await checkProviderAuth(provider) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:dispose", async (_e: IpcMainInvokeEvent, childId: string) => {
    await disposeChildSession(childId);
    return { success: true };
  });

  // 会话重置：清空孩子当前会话上下文 + 学习资料面板，重新开始。
  // 触发来源：聊天 /reset 命令 或 家长设置的定时任务（scheduler.ts 调用 resetChildSession）。
  ipcMain.handle("pi:reset", async (_e: IpcMainInvokeEvent, childId: string) => {
    try {
      const archiveLimit = getChildSchedulerConfig(childId).archiveLimit;
      await resetChildSession(childId, archiveLimit);
      // 重建干净会话并重新挂载事件（Learn 页面仍挂载，需保证下一次 pi:prompt 可用）
      const session = await getChildSession(childId);
      attachSessionEvents(session, childId, getMainWindow);
      return { success: true, history: [], materials: [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 列出孩子的历史归档会话（排除当前活跃会话），供前端「显示历史会话」调阅。
  ipcMain.handle("pi:listSessions", async (_e: IpcMainInvokeEvent, childId: string) => {
    try {
      const sessions = await listChildSessions(childId);
      return { success: true, sessions };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 直接读取指定历史会话文件（按文件名）的活跃路径消息，供前端显示（不加载进 agent 上下文）。
  ipcMain.handle("pi:getSessionMessages", async (_e: IpcMainInvokeEvent, childId: string, file: string) => {
    try {
      const messages = await readChildSessionMessages(childId, file);
      return { success: true, messages };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ---- ISSUE-041 消息交换（跨机课程分发 + 进度查询）----
  // 云端只做消息交换：分配包（家长→孩子，投递即删）+ 进度摘要（孩子→家长，只存最新）。
  // 不再有整库云同步；多 PC 数据迁移走本地 zip 备份/恢复。

  // 家长云端查进度：打「请求刷新」标记 + 返回当前云端进度摘要（孩子端轮询后会上传新摘要）
  ipcMain.handle("sync:query_progress", async (_e: IpcMainInvokeEvent, childId: string) => {
    try {
      const { fetchProgressSummary } = await import("./delivery");
      const data = await fetchProgressSummary(childId, true);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ---- Backup handlers（ISSUE-041 层 A：本地 zip 备份 / 恢复）----

  ipcMain.handle("backup:create", async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      if (!win) return { success: false, error: "无窗口" };
      const res = await dialog.showOpenDialog(win, {
        title: "选择备份保存目录",
        properties: ["openDirectory", "createDirectory"],
      });
      if (res.canceled || !res.filePaths[0]) return { success: false, canceled: true };
      const { createBackup } = await import("./backup");
      const r = await createBackup(res.filePaths[0]);
      return { success: true, file: r.file, count: r.count, bytes: r.bytes };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("backup:restore", async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      if (!win) return { success: false, error: "无窗口" };
      const res = await dialog.showOpenDialog(win, {
        title: "选择备份文件（zip）",
        properties: ["openFile"],
        filters: [{ name: "备份文件", extensions: ["zip"] }],
      });
      if (res.canceled || !res.filePaths[0]) return { success: false, canceled: true };
      const { restoreBackup } = await import("./backup");
      const r = await restoreBackup(res.filePaths[0]);
      return { success: true, restored: r.restored, skipped: r.skipped };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("backup:config:get", () => getBackupSchedulerConfig());

  ipcMain.handle("backup:config:set", (_e, cfg: any) => setBackupSchedulerConfig(cfg));

  // ISSUE-041 层 C：云端事件轮询配置（设备级，默认开启 2 分钟）
  ipcMain.handle("eventpoll:config:get", () => getEventPollConfig());
  ipcMain.handle("eventpoll:config:set", (_e, cfg: any) => setEventPollConfig(cfg));

  // 文件上传落盘（ISSUE-008）：保存到 data/children/<childId>/uploads/，按 childId 隔离
  ipcMain.handle(
    "file:save_upload",
    async (
      _e: IpcMainInvokeEvent,
      payload: { childId: string; name: string; mime: string; data: ArrayBuffer | Buffer }
    ) => {
      try {
        const uploadsDir = getUploadsDir(payload.childId);
        fs.mkdirSync(uploadsDir, { recursive: true });
        // 安全文件名：只取 basename（防目录穿越）→ 剔除危险字符 → 前缀时间戳防重名
        const rawBase = path
          .basename(payload.name || "file")
          .replace(/[^\w.\-\u4e00-\u9fa5()]/g, "_")
          .slice(0, 80);
        const finalName = `${Date.now()}-${rawBase || "file"}`;
        const full = path.join(uploadsDir, finalName);
        // 双保险：解析后必须仍在 uploads 目录内
        if (path.dirname(path.resolve(full)) !== path.resolve(uploadsDir)) {
          throw new Error("非法上传路径");
        }
        fs.writeFileSync(full, Buffer.from(payload.data));
        pruneUploads(uploadsDir);
        return {
          success: true,
          // 相对路径（相对 data/），统一正斜杠，便于前端展示/后续读取
          path: path.join("children", payload.childId, "uploads", finalName).replace(/\\/g, "/"),
          size: Buffer.byteLength(payload.data),
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  );

  // 点击气泡附件：用本地默认程序打开 uploads 目录内的文件（严格限定，防路径穿越）
  ipcMain.handle("file:open_upload", async (_e: IpcMainInvokeEvent, childId: string, relPath: string) => {
    try {
      const uploadsDir = getUploadsDir(childId);
      // 只取 basename 后拼入 uploads 目录并 resolve 双校验：杜绝任何穿越可能
      const full = path.resolve(uploadsDir, path.basename(relPath));
      if (path.dirname(full) !== path.resolve(uploadsDir)) throw new Error("非法路径");
      if (!fs.existsSync(full)) throw new Error("文件不存在（可能已被清理）");
      const err = await shell.openPath(full);
      if (err) return { success: false, error: err };
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 读取 uploads 目录内文件内容（base64），用于历史消息播放语音录音（防路径穿越同 open_upload）
  ipcMain.handle("file:read_upload", async (_e: IpcMainInvokeEvent, childId: string, relPath: string) => {
    try {
      const uploadsDir = getUploadsDir(childId);
      const full = path.resolve(uploadsDir, path.basename(relPath));
      if (path.dirname(full) !== path.resolve(uploadsDir)) throw new Error("非法路径");
      if (!fs.existsSync(full)) throw new Error("文件不存在（可能已被清理）");
      const buf = fs.readFileSync(full);
      return { success: true, data: buf.toString("base64") };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 家长聊天框上传落盘（ISSUE-044 修正）：保存到 data/parents/<parentId>/uploads/，与孩子的 children/<id>/uploads 隔离。
  // 完全镜像 file:save_upload，仅落盘根目录从孩子切换到家长。
  ipcMain.handle(
    "file:save_upload_parent",
    async (
      _e: IpcMainInvokeEvent,
      payload: { parentId: string; name: string; mime: string; data: ArrayBuffer | Buffer }
    ) => {
      try {
        const uploadsDir = getParentUploadsDir(payload.parentId);
        fs.mkdirSync(uploadsDir, { recursive: true });
        // 安全文件名：只取 basename（防目录穿越）→ 剔除危险字符 → 前缀时间戳防重名
        const rawBase = path
          .basename(payload.name || "file")
          .replace(/[^\w.\-\u4e00-\u9fa5()]/g, "_")
          .slice(0, 80);
        const finalName = `${Date.now()}-${rawBase || "file"}`;
        const full = path.join(uploadsDir, finalName);
        // 双保险：解析后必须仍在 uploads 目录内
        if (path.dirname(path.resolve(full)) !== path.resolve(uploadsDir)) {
          throw new Error("非法上传路径");
        }
        fs.writeFileSync(full, Buffer.from(payload.data));
        pruneUploads(uploadsDir);
        return {
          success: true,
          // 相对路径（相对 data/），统一正斜杠，便于前端展示/后续读取
          path: path.join("parents", payload.parentId, "uploads", finalName).replace(/\\/g, "/"),
          size: Buffer.byteLength(payload.data),
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  );

  // 点击气泡附件：用本地默认程序打开家长 uploads 目录内的文件（严格限定，防路径穿越）
  ipcMain.handle("file:open_upload_parent", async (_e: IpcMainInvokeEvent, parentId: string, relPath: string) => {
    try {
      const uploadsDir = getParentUploadsDir(parentId);
      // 只取 basename 后拼入 uploads 目录并 resolve 双校验：杜绝任何穿越可能
      const full = path.resolve(uploadsDir, path.basename(relPath));
      if (path.dirname(full) !== path.resolve(uploadsDir)) throw new Error("非法路径");
      if (!fs.existsSync(full)) throw new Error("文件不存在（可能已被清理）");
      const err = await shell.openPath(full);
      if (err) return { success: false, error: err };
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 读取家长 uploads 目录内文件内容（base64），用于历史消息播放语音录音（防路径穿越同 open_upload_parent）
  ipcMain.handle("file:read_upload_parent", async (_e: IpcMainInvokeEvent, parentId: string, relPath: string) => {
    try {
      const uploadsDir = getParentUploadsDir(parentId);
      const full = path.resolve(uploadsDir, path.basename(relPath));
      if (path.dirname(full) !== path.resolve(uploadsDir)) throw new Error("非法路径");
      if (!fs.existsSync(full)) throw new Error("文件不存在（可能已被清理）");
      const buf = fs.readFileSync(full);
      return { success: true, data: buf.toString("base64") };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Voice (STT) config + transcribe
  ipcMain.handle("voice:config:get", async () => {
    return { success: true, config: getMaskedConfig() };
  });

  ipcMain.handle("voice:config:set", async (_e, patch: any) => {
    try {
      applyVoiceConfigPatch(patch);
      return { success: true, config: getMaskedConfig() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("voice:transcribe", async (_e, audio: ArrayBuffer, onlyProvider?: string) => {
    try {
      const buf = Buffer.from(audio);
      const text = await transcribeAudio(buf, onlyProvider);
      // 返回原始录音（base64，webm/opus），供前端播放
      return { success: true, text, audio: buf.toString("base64") };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ISSUE-021：把一次输入的多段 webm 语音拼接成单个 WAV 落盘（按 childId 隔离）。
  // 前端多次按住说话产生多段，发送时调用此接口合并，消息附带单个可播放音频。
  ipcMain.handle(
    "voice:merge",
    async (_e: IpcMainInvokeEvent, childId: string, segments: string[]) => {
      try {
        if (!Array.isArray(segments) || segments.length < 2) {
          return { success: false, error: "需要至少两段录音才能合并" };
        }
        const bufs = segments.map((s) => Buffer.from(s, "base64"));
        const { mergeWebmSegments } = await import("./voice/audio");
        const merged = await mergeWebmSegments(bufs);
        const uploadsDir = getUploadsDir(childId);
        fs.mkdirSync(uploadsDir, { recursive: true });
        const finalName = `${Date.now()}-merged.wav`;
        const full = path.join(uploadsDir, finalName);
        // 双保险：解析后必须仍在 uploads 目录内（防目录穿越）
        if (path.dirname(path.resolve(full)) !== path.resolve(uploadsDir)) {
          throw new Error("非法上传路径");
        }
        fs.writeFileSync(full, merged);
        pruneUploads(uploadsDir);
        return {
          success: true,
          // 相对路径（相对 data/），统一正斜杠，便于前端展示/后续读取
          path: path.join("children", childId, "uploads", finalName).replace(/\\/g, "/"),
          // 合并后 WAV 的 base64，供前端立即播放（无需二次读取落盘文件）
          data: merged.toString("base64"),
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  );

  // Voice (TTS) — Edge 神经语音合成，返回 MP3
  ipcMain.handle("voice:tts", async (_e, text: string, opts: any) => {
    try {
      const mp3 = await synthesize(text, opts || {});
      return { success: true, audio: mp3 };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ===== 窗口控制（自定义标题栏）=====
  ipcMain.handle("window:minimize", () => {
    getMainWindow()?.minimize();
  });

  ipcMain.handle("window:maximize-toggle", () => {
    const w = getMainWindow();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });

  ipcMain.handle("window:close", () => {
    getMainWindow()?.close();
  });

  ipcMain.handle("window:is-maximized", () => {
    return getMainWindow()?.isMaximized() ?? false;
  });

  ipcMain.handle("window:fullscreen-toggle", () => {
    const w = getMainWindow();
    if (!w) return;
    w.setFullScreen(!w.isFullScreen());
  });

  // Edit 菜单：作用于当前聚焦的可编辑元素
  ipcMain.handle("edit:undo", () => getMainWindow()?.webContents.undo());
  ipcMain.handle("edit:redo", () => getMainWindow()?.webContents.redo());
  ipcMain.handle("edit:cut", () => getMainWindow()?.webContents.cut());
  ipcMain.handle("edit:copy", () => getMainWindow()?.webContents.copy());
  ipcMain.handle("edit:paste", () => getMainWindow()?.webContents.paste());

  // View 菜单
  ipcMain.handle("view:devtools", () => getMainWindow()?.webContents.toggleDevTools());
  ipcMain.handle("view:zoom-in", () => {
    const wc = getMainWindow()?.webContents;
    if (wc) wc.setZoomLevel(wc.getZoomLevel() + 0.5);
  });
  ipcMain.handle("view:zoom-out", () => {
    const wc = getMainWindow()?.webContents;
    if (wc) wc.setZoomLevel(wc.getZoomLevel() - 0.5);
  });
  ipcMain.handle("view:zoom-reset", () => getMainWindow()?.webContents.setZoomLevel(0));
}

// 防止同一个 session 被重复订阅（attachSessionEvents 可能被多次调用）
const subscribedSessions = new WeakSet<any>();

// thinking 增量缓冲：按 childId 聚合，节流发送，避免海量 delta 打垮 IPC 与 React
const thinkingBuffers = new Map<
  string,
  { text: string; timer: ReturnType<typeof setTimeout> | null }
>();

function queueThinking(childId: string, delta: string, win: () => BrowserWindow | null) {
  let entry = thinkingBuffers.get(childId);
  if (!entry) {
    entry = { text: "", timer: null };
    thinkingBuffers.set(childId, entry);
  }
  entry.text += delta;
  if (entry.timer === null) {
    entry.timer = setTimeout(() => {
      const cur = thinkingBuffers.get(childId);
      if (!cur) return;
      cur.timer = null;
      const chunk = cur.text;
      cur.text = "";
      if (chunk) {
        const w = win();
        if (w && !w.isDestroyed()) {
          w.webContents.send("pi:thinking", { childId, delta: chunk });
        }
      }
    }, 120);
  }
}

function flushThinking(childId: string, win: () => BrowserWindow | null) {
  const entry = thinkingBuffers.get(childId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  const chunk = entry.text;
  entry.text = "";
  if (chunk) {
    const w = win();
    if (w && !w.isDestroyed()) {
      w.webContents.send("pi:thinking", { childId, delta: chunk });
    }
  }
}

function previewArgs(toolName: string, args: any): string {
  try {
    if (args && typeof args === "object") {
      const p = args.path || args.filePath || args.file_path;
      if (typeof p === "string") return p;
      if (toolName === "display_content") return args.format || "";
      const parts: string[] = [];
      for (const k of Object.keys(args).slice(0, 3)) {
        const v = args[k];
        if (typeof v === "string") parts.push(`${k}=${v.length > 32 ? v.slice(0, 32) + "…" : v}`);
        else parts.push(k);
      }
      return parts.join(", ");
    }
    return "";
  } catch {
    return "";
  }
}

function previewResult(toolName: string, result: any, isError: boolean): string {
  if (isError) return "执行出错";
  if (toolName === "display_content") return "内容已展示";
  try {
    if (result && typeof result === "object" && Array.isArray(result.content)) {
      const text = result.content
        .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join(" ");
      if (text) return text.slice(0, 120);
    }
    const s = typeof result === "string" ? result : JSON.stringify(result ?? "");
    return s.slice(0, 120);
  } catch {
    return "";
  }
}

function attachSessionEvents(session: any, childId: string, win: () => BrowserWindow | null) {
  if (subscribedSessions.has(session)) return;
  subscribedSessions.add(session);

  session.subscribe((event: any) => {
    try {
      console.log(`[pi:event] child=${childId} type=${event.type}`);
      const w = win();
      if (!w || w.isDestroyed()) {
        return;
      }

      switch (event.type) {
        case "message_update":
          if (event.assistantMessageEvent?.type === "text_delta") {
            w.webContents.send("pi:streaming", { childId, delta: event.assistantMessageEvent.delta });
          } else if (event.assistantMessageEvent?.type === "thinking_delta") {
            queueThinking(childId, event.assistantMessageEvent.delta, win);
          }
          break;
        case "tool_execution_start":
          w.webContents.send("pi:tool_start", {
            childId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            argsPreview: previewArgs(event.toolName, event.args),
          });
          break;
        case "tool_execution_end":
          w.webContents.send("pi:tool_end", {
            childId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
            resultPreview: previewResult(event.toolName, event.result, event.isError),
          });
          break;
        case "agent_end":
          flushThinking(childId, win);
          w.webContents.send("pi:agent_end", { childId });
          break;
        case "message_end":
          flushThinking(childId, win);
          if (event.message?.role === "assistant") {
            w.webContents.send("pi:message_end", { childId, message: event.message });
          }
          break;
        case "error":
          flushThinking(childId, win);
          w.webContents.send("pi:error", `会话错误: ${event.error || event.message || "未知错误"}`);
          break;
        default:
          break;
      }
    } catch (err) {
      const w = win();
      if (w && !w.isDestroyed()) {
        w.webContents.send("pi:error", `事件处理错误: ${(err as Error).message}`);
      }
    }
  });
}

function findLastAssistant(messages: any[]): any {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return null;
}

// 若 assistant 消息是错误（stopReason=error 或带 errorMessage），返回错误信息；否则返回 null
function assistantError(m: any): string | null {
  if (!m) return null;
  if (m.stopReason === "error" || m.errorMessage) {
    return m.errorMessage || "模型调用失败";
  }
  return null;
}

// 把底层错误映射为对孩子/家长友好的提示
function friendlyError(msg: string): string {
  const m = (msg || "").toLowerCase();
  if (/(connection|fetch|network|timeout|econnrefused|enotfound|econnreset|abort|socket|unreachable)/.test(m)) {
    return "网络连接失败，请检查网络后重试";
  }
  return msg || "模型调用失败";
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
