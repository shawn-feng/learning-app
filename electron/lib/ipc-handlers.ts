import { ipcMain, BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron";
import { loginAndCache, registerAndCache, checkAuth, getCachedLicense, clearCachedLicense, verifyParentPassword, verifyLicenseWithCloud } from "./auth-manager";
import { addChild, listChildren, authChild, getProfile, deleteChild, resetChildPassword, updateChildProfile, changeChildPassword } from "./child-auth";
import { getSkillsDir, getChildDir } from "./config";
import { getChildSession, getParentSession, disposeChildSession, getActiveSession, getSessionHistory, getSessionMaterials, resetChildSession, listChildSessions, readChildSessionMessages } from "./pi-session";
import { getAvailableModels, setProviderApiKey, checkProviderAuth } from "./pi-runtime";
import { getSharedRuntime } from "./pi-runtime";
import fs from "fs";
import path from "path";
import { getMaskedConfig, applyVoiceConfigPatch, transcribeAudio, synthesize } from "./voice";
import { getLearningSummary } from "./learning-summary";
import { getChildSchedulerConfig, setChildSchedulerConfig } from "./scheduler";
import { getMaterialsLimit, setMaterialsLimit, getDefaultModelKey, setDefaultModelKey } from "./app-settings";

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
    const childDir = getChildDir(childId);
    const p = path.join(childDir, "AGENTS.md");
    if (fs.existsSync(p)) {
      return { content: fs.readFileSync(p, "utf-8") };
    }
    return { content: "" };
  });

  ipcMain.handle("child:saveAgentsMd", async (_e, childId: string, content: string) => {
    try {
      fs.writeFileSync(path.join(getChildDir(childId), "AGENTS.md"), content, "utf-8");
      return { success: true };
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
      return { success: true, configs };
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

  ipcMain.handle("pi:prompt", async (_e: IpcMainInvokeEvent, childId: string, text: string) => {
    console.log(`[pi:prompt] child=${childId} text="${text.slice(0, 50)}"`);
    try {
      const session = await getChildSession(childId);
      console.log(`[pi:prompt] session ready, calling prompt()...`);
      await session.prompt(text);
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
      await session.prompt(text);
      return { success: true };
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

  // ---- Sync handlers ----

  ipcMain.handle("sync:pull", async () => {
    try {
      const { syncAllChildren } = await import("./sync-manager");
      const results = await syncAllChildren();
      return { success: true, results };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("sync:push", async (_e: IpcMainInvokeEvent, childId: string) => {
    try {
      const { pushChildChanges } = await import("./sync-manager");
      const result = await pushChildChanges(childId);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("sync:full", async (_e: IpcMainInvokeEvent, childId: string) => {
    try {
      const { fullSnapshot } = await import("./sync-manager");
      const result = await fullSnapshot(childId);
      return { success: true, ...result };
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
