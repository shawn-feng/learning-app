import {
  getCurrentParentId, ipcMain, app, BrowserWindow, dialog, shell, screen, type IpcMainInvokeEvent } from "electron";
import { loginAndCache, registerAndCache, checkAuth, getCachedLicense, clearCachedLicense, verifyParentPassword, verifyLicenseWithCloud } from "./auth-manager";
import { addChild, listChildren, authChild, getProfile, deleteChild, resetChildPassword, updateChildProfile, changeChildPassword } from "./child-auth";
import { getSkillsDir, getChildDir, getUploadsDir, pruneUploads, getServerUrl, setServerUrl , getCurrentParentId } from "./config";
import { getChildSession, getParentSession, getParentContentSession, disposeChildSession, getActiveSession, getSessionHistory, getSessionMaterials, resetChildSession, resetParentSession, listChildSessions, readChildSessionMessages, getDefaultPrompt } from "./pi-session";
import { getAgentPrompt, saveAgentPrompt, listAgentPromptHistory, restoreAgentPromptVersion, prefetchAgents, fetchAgentPromptRemote } from "./agent-prompts";
import { startConfigSync, stopConfigSync } from "./config-sync";
import { getAvailableModels, setProviderApiKey, checkProviderAuth, getSharedRuntime, getVisionModel } from "./pi-runtime";
import fs from "fs";
import path from "path";
import { getMaskedConfig, applyVoiceConfigPatch, transcribeAudio, synthesize, TTS_VOICES, getMaskedTtsConfig, applyTtsConfigPatch } from "./voice";
import {
  assessAudio,
  getMaskedAssessmentConfig,
  applyAssessmentConfigPatch,
  type AssessmentProviderId,
} from "./assessment";
import { getLearningSummary, getTopicProgress, getCourseDailySummary, fetchProgressRemote } from "./learning-summary";
import { dbQuery, currentSessionToken } from "./client-data";
import { serverFetch } from "./server-client";
import { formatLocalDate } from "./daily-summary";
import { syncChildSessions } from "./session-sync";
import { listChildren } from "./child-auth";
import { getSyncStatus, getSyncLog, readSyncLogFile } from "./sync-logger";
import {
  allocateTopicToChild,
  copyMaterialIntoParent,
  deleteParentCourse,
  deallocateChildTopic,
  listChildAllocatedTopics,
  listParentMaterials,
  listParentTopicMaterials,
  deleteParentMaterial,
  setChildTopicDaily,
  listParentTopics,
  listParentTopicCourses,
  moveParentCourse,
  readParentMaterial,
  upsertParentCourse,
  upsertParentTopic,
  getParentUploadsDir,
  queryParentTags,
  upsertParentTag,
} from "./parent-library";
import { getChildSchedulerConfig, setChildSchedulerConfig, getParentSchedulerConfig, setParentSchedulerConfig, getBackupSchedulerConfig, setBackupSchedulerConfig, getEventPollConfig, setEventPollConfig } from "./scheduler";
import { getMaterialsLimit, setMaterialsLimit, getDefaultModelKey, setDefaultModelKey, getProgrammingModelKey, setProgrammingModelKey, getVisionModelKey, setVisionModelKey } from "./app-settings";
import { logRound, readTokenLog, getTokenSummary } from "./token-stats";
import { getExamConfig, getExamCoursesForSchedule, uploadExamVoice, submitExamAttempt, listExamAttempts, getExamCourseRecords, getExamAudioDataUrl, getExamPending, getExamSchedules, createExamSchedule, startExamSchedule, completeExamSchedule, cancelExamSchedule, getFixedExamConfig, saveFixedExamConfig } from "./exam";
import { generateExamQuestions, scoreExamAttempt, selectCoursesForSchedule } from "./exam-engine";
import { checkForUpdatesManually, downloadUpdate, quitAndInstall } from "./updater";
import {
  queuePageEvent,
  resolvePageAction,
  setPageExecTransport,
  takePendingPageEvents,
} from "./page-bridge";

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null) {
  // iframe 学习资料 ↔ agent 双向通讯（page-bridge）：
  // 下行指令经主窗口 webContents 下发到渲染层；上行事件注入用 getActiveSession 拿会话。
  setPageExecTransport((childId, requestId, action, params) => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) {
      w.webContents.send("pi:page:exec", { childId, requestId, action, params });
    }
  });
  // ISSUE-015：孩子发消息时取走待附带的页面操作（不自动注入 agent）
  ipcMain.handle("pi:page:pending", (_e, childId: string) => {
    return { text: takePendingPageEvents(childId ?? "") };
  });

  ipcMain.handle("pi:page:event", async (_e, payload: { childId: string; event: any }) => {
    try {
      queuePageEvent(payload?.childId ?? "", payload?.event ?? {});
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(
    "pi:page:exec:result",
    async (_e, payload: { requestId: string; result: any }) => {
      resolvePageAction(payload?.requestId ?? "", payload?.result ?? {});
      return { ok: true };
    }
  );

  // agent 中断（停止按钮）支持：记录当前运行中的 prompt 对应的 abort 句柄，
  // 前端点「停止」时调 session.abort() 打断本轮（Pi SDK AgentSession.abort()）。
  // stopped 标记用于 prompt 收尾时跳过正常回复/错误回发（避免 abort 后被前端追加多余气泡）。
  let childPromptAbort: { stopped: boolean; abort: () => Promise<void> } | null = null;
  let parentPromptAbort: { stopped: boolean; abort: () => Promise<void> } | null = null;
  // SPLIT：服务端连接配置（纯服务端模式必需）
  ipcMain.handle("server:get_config", async () => {
    return { url: getServerUrl() };
  });
  ipcMain.handle("server:set_config", async (_e, url: string) => {
    setServerUrl(typeof url === "string" ? url : "");
    return { ok: true, url: getServerUrl() };
  });

  // ---- 会话同步状态 / 日志（ISSUE-043 完善：失败可感知、可手动重试、可导出）----
  // 当前各孩子的同步状态快照（最近同步时间 / 成败 / 连续失败数 / 连的 server / 待同步字节）
  ipcMain.handle("sessions:syncStatus", async () => {
    try {
      return { success: true, status: getSyncStatus() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 最近 N 条同步日志
  ipcMain.handle("sessions:syncLog", async (_e, limit?: number) => {
    try {
      return { success: true, entries: getSyncLog(limit ?? 100) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 手动立即同步（家长在「会话同步」面板点按钮触发）；fire-and-forget，结果看状态快照
  ipcMain.handle("sessions:forceSync", async () => {
    try {
      void listChildren()
        .then((children: any[]) => {
          for (const c of children) void syncChildSessions(c.childId, "manual").catch(() => {});
        })
        .catch(() => {});
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 导出同步日志到本机文件（主进程弹保存对话框）
  ipcMain.handle("sessions:exportLog", async (e: IpcMainInvokeEvent) => {
    try {
      const content = readSyncLogFile();
      if (!content) return { success: false, error: "暂无同步日志（会话同步尚未发生过）" };
      const win = BrowserWindow.fromWebContents(e.sender) ?? getMainWindow();
      const res = await dialog.showSaveDialog(win!, {
        title: "导出会话同步日志",
        defaultPath: `session-sync-log-${new Date().toISOString().slice(0, 10)}.jsonl`,
        filters: [{ name: "JSON Lines", extensions: ["jsonl", "log", "txt"] }],
      });
      if (res.canceled || !res.filePath) return { success: true, canceled: true };
      fs.writeFileSync(res.filePath, content, "utf-8");
      return { success: true, filePath: res.filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

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
      // SPLIT M8-B/C：登录后预热 AGENTS 缓存 + 启动配置 2min 轮询
      void prefetchAgents().catch(() => {});
      startConfigSync();
      return { success: true, license };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("auth:check", async () => {
    const r = await checkAuth();
    // 启动恢复登录态（缓存 license）：同样要启动配置同步（登录强拉 + 2min 轮询），
    // 否则新装的 app 重启后模型 key/配置不会从服务端拉取（2026-08-30 修复）。
    if (r.authenticated) {
      void prefetchAgents().catch(() => {});
      startConfigSync();
    }
    return r;
  });

  ipcMain.handle("auth:verify", async (_e, email: string, password: string) => {
    return verifyParentPassword(email, password);
  });

  ipcMain.handle("auth:logout", async () => {
    clearCachedLicense();
    stopConfigSync();
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
        const children = await listChildren();
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
    return await listChildren();
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
    await deleteChild(childId);
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
    // ISSUE-033 + SPLIT M8-B：AGENTS 用户版本唯一真源在服务端（本地缓存为离线降级）。
    // 编辑器实时读：先远程取，无用户版本返回代码默认（buildAgentsMd）。
    const userVer = await fetchAgentPromptRemote("child", childId);
    if (userVer !== null) return { content: userVer };
    return { content: getDefaultPrompt("child", childId) };
  });

  ipcMain.handle("child:saveAgentsMd", async (_e, childId: string, content: string) => {
    try {
      // SPLIT M8-B：AGENTS 用户版本唯一真源在服务端，本地缓存同步更新
      await saveAgentPrompt("child", childId, content);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ---- AGENTS / 系统提示词「用户可编辑版本」通用接口（ISSUE-033）----
  ipcMain.handle("agents:get", async (_e, scope: string, ref: string) => {
    // 家长提示词按家长隔离（2026-08-30）：parent scope 的 ref 统一为当前家长 id
    if (scope === "parent") ref = getCurrentParentId();
    // SPLIT M8-B：编辑器实时读服务端（远程取 + 缓存兜底）
    const userVer = await fetchAgentPromptRemote(scope, ref);
    if (userVer !== null) return { content: userVer, customized: true };
    // 无用户整体版本：返回当前默认内容（孩子=buildAgentsMd 代码默认，家长=代码默认提示词），
    // 让家长在默认基础上修改（ISSUE-033 修：此前返回空串导致编辑器空白）。
    return { content: getDefaultPrompt(scope, ref), customized: false };
  });

  ipcMain.handle("agents:save", async (_e, scope: string, ref: string, content: string) => {
    // 家长提示词按家长隔离（2026-08-30）：parent scope 的 ref 统一为当前家长 id
    if (scope === "parent") ref = getCurrentParentId();
    try {
      // SPLIT M8-B：保存走服务端 RPC（prompts 当前版 + prompt_history 历史版），并更新本地缓存
      await saveAgentPrompt(scope, ref, content);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("agents:history", async (_e, scope: string, ref: string) => {
    // 家长提示词按家长隔离（2026-08-30）：parent scope 的 ref 统一为当前家长 id
    if (scope === "parent") ref = getCurrentParentId();
    try {
      return { success: true, data: await listAgentPromptHistory(scope, ref) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("agents:restore", async (_e, scope: string, ref: string, updated: string) => {
    // 家长提示词按家长隔离（2026-08-30）：parent scope 的 ref 统一为当前家长 id
    if (scope === "parent") ref = getCurrentParentId();
    try {
      return { success: true, data: await restoreAgentPromptVersion(scope, ref, updated) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("learning:summary", async (_e, childId: string) => {
    try {
      // SPLIT：进度真源在服务端，先远程预取（新设备/未开过会话也能拿到），再读本地缓存汇总
      await fetchProgressRemote(childId);
      return { success: true, data: await getLearningSummary(childId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 单主题进度明细（含每课 CourseItem 列表）—— 进度看板「主题 → 每课 → 当课汇总」钻取数据源
  ipcMain.handle("learning:topic", async (_e, childId: string, topic: string) => {
    try {
      return { success: true, data: await getTopicProgress(childId, topic) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 单课「学习情况的总结」：关联 daily_entries（block='学习'，数据库唯一真源）
  ipcMain.handle(
    "learning:courseSummary",
    async (_e, childId: string, topicName: string, title: string) => {
      try {
        return { success: true, data: await getCourseDailySummary(childId, topicName, title) };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  );

  // ---- 家长库（ISSUE-029：主题/资料统一管理 + 分配给孩子）----

  ipcMain.handle("parent:listTopics", async () => {
    try {
      return { success: true, data: await listParentTopics() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("parent:listCourses", async (_e, topicDir: string) => {
    try {
      return { success: true, data: await listParentTopicCourses(undefined, topicDir) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ISSUE-045：标签选项从父库 tags 定义表获取（家长可编辑课程标签的下拉源）
  ipcMain.handle("parent:getTags", async () => {
    try {
      return { success: true, data: await queryParentTags(undefined) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ISSUE-045：家长自由新增标签写回父库 tags 定义表
  ipcMain.handle("parent:upsertTag", async (_e, tag: string, dimension?: string, criteria?: string) => {
    try {
      await upsertParentTag(undefined, tag, dimension || "", criteria || "");
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 新建/更新家长库主题（课程管理页「新建主题」，method 全文、courses 可空）
  ipcMain.handle("parent:upsertTopic", async (_e, topic: any) => {
    try {
      const r = await upsertParentTopic(undefined, topic, topic.courses || []);
      return { success: true, data: r };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("parent:allocate", async (_e, childId: string, topicDir: string) => {
    try {
      const data = await allocateTopicToChild(undefined, childId, topicDir);
      // ISSUE-041 架构转向：跨机分发 = 只传「分配数据包」（不含文件），孩子端本地落库。
      // 家长端生成包上传云端暂存（fire-and-forget，失败静默）；本地分配已生效（同机可用）。
      try {
        const { buildAllocPackage, uploadDelivery } = await import("./delivery");
        uploadDelivery(childId, await buildAllocPackage(topicDir)).catch((e) =>
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
      return { success: true, data: await listChildAllocatedTopics(childId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ISSUE-004：移除孩子某主题的分配（保留学习记录，仅取消分配）
  ipcMain.handle("parent:deallocate", async (_e, childId: string, topicDir: string) => {
    try {
      return { success: true, data: await deallocateChildTopic(childId, topicDir) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ISSUE-031/ISSUE-033：设置孩子某主题的「主题类型」（type=必学/选学/复习，考核选题标注）+ 清空遗留
  // daily（旧「每天学习量」已停用，学习安排改由学习计划 study_plans 决定）——写入孩子库 topics.rules_json
  ipcMain.handle(
    "parent:setChildTopicDaily",
    async (_e, childId: string, topicDir: string, daily: string, type: string) => {
      try {
        return { success: true, data: await setChildTopicDaily(childId, topicDir, daily, type) };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  );

  // 一次性存量迁移（html 上移父库 + method 改全文）。破坏性操作，调用方需先备份。

  // 家长库课程管理（课程管理页）
  ipcMain.handle("parent:upsertCourse", async (_e, topicDir: string, course: any) => {
    try {
      await upsertParentCourse(undefined, topicDir, course);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("parent:deleteCourse", async (_e, topicDir: string, title: string) => {
    try {
      return { success: true, data: await deleteParentCourse(undefined, topicDir, title) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("parent:moveCourse", async (_e, topicDir: string, title: string, direction: -1 | 1) => {
    try {
      return { success: true, data: await moveParentCourse(undefined, topicDir, title, direction) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("parent:readMaterial", async (_e, relPath: string) => {
    try {
      return { success: true, data: await readParentMaterial(undefined, relPath) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("parent:listMaterials", async (_e, topicDir: string) => {
    try {
      return { success: true, data: await listParentMaterials(undefined, topicDir) };
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
      const files = await Promise.all(
        result.filePaths.map(async (p) => {
          const rel = await copyMaterialIntoParent(undefined, topicDir, p, subDir);
          return { name: path.basename(p), relPath: rel };
        })
      );
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
      await deleteParentMaterial(undefined, topicDir, relPath);
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
      const children = await listChildren();
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

  // ---- 定时任务管理（新模型：先建任务 → 分配给孩子 → 执行结果查询；数据在服务端）----

  ipcMain.handle("scheduler:tasks:list", async () => {
    try {
      const token = currentSessionToken();
      if (!token) return { success: false, error: "未登录" };
      const data = await serverFetch<{ tasks?: unknown[] }>("/scheduler/tasks", { token });
      return { success: true, tasks: data?.tasks ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("scheduler:task:create", async (_e, payload: { name: string; type: string; time: string; extra?: Record<string, unknown> }) => {
    try {
      const token = currentSessionToken();
      if (!token) return { success: false, error: "未登录" };
      const data = await serverFetch<{ ok: boolean; task?: unknown }>("/scheduler/tasks", {
        method: "POST",
        token,
        body: payload,
      });
      return { success: !!data?.ok, task: data?.task };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("scheduler:task:update", async (_e, id: string, patch: { name?: string; time?: string; enabled?: boolean; extra?: Record<string, unknown> }) => {
    try {
      const token = currentSessionToken();
      if (!token) return { success: false, error: "未登录" };
      const data = await serverFetch<{ ok: boolean }>(`/scheduler/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        token,
        body: patch,
      });
      return { success: !!data?.ok };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("scheduler:task:delete", async (_e, id: string) => {
    try {
      const token = currentSessionToken();
      if (!token) return { success: false, error: "未登录" };
      const data = await serverFetch<{ ok: boolean }>(`/scheduler/tasks/${encodeURIComponent(id)}`, {
        method: "DELETE",
        token,
      });
      return { success: !!data?.ok };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("scheduler:task:assign", async (_e, id: string, childId: string, enabled: boolean) => {
    try {
      const token = currentSessionToken();
      if (!token) return { success: false, error: "未登录" };
      const data = await serverFetch<{ ok: boolean }>(`/scheduler/tasks/${encodeURIComponent(id)}/assign`, {
        method: "POST",
        token,
        body: { childId, enabled },
      });
      return { success: !!data?.ok };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("scheduler:runs:list", async (_e, opts: { childId?: string; limit?: number } = {}) => {
    try {
      const token = currentSessionToken();
      if (!token) return { success: false, error: "未登录" };
      const q = new URLSearchParams();
      if (opts.childId) q.set("childId", opts.childId);
      if (opts.limit) q.set("limit", String(opts.limit));
      const data = await serverFetch<{ runs?: unknown[] }>(`/scheduler/runs${q.toString() ? `?${q}` : ""}`, { token });
      return { success: true, runs: data?.runs ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("scheduler:effective_config:get", async () => {
    try {
      const token = currentSessionToken();
      if (!token) return { success: false, error: "未登录" };
      const data = await serverFetch<{ children?: Record<string, unknown> }>("/scheduler/effective-config", { token });
      return { success: true, children: data?.children ?? {} };
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

  // 默认视觉模型（图片上传自动切换，缺省 qwen/qwen3-vl-flash）
  ipcMain.handle("pi:get_vision_model", async () => {
    try {
      return { success: true, key: getVisionModelKey() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:set_vision_model", async (_e: IpcMainInvokeEvent, key: string) => {
    try {
      setVisionModelKey(key || "");
      return { success: true, key: key || "" };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 语音合成（TTS）配置：provider + 各 provider 的 apiKey（留空复用模型配置）+ 默认音色。
  // config 为打码后的配置（apiKey 不返回明文）；voices = 可选音色清单（设置页下拉用）
  ipcMain.handle("pi:get_tts_config", async () => {
    try {
      return { success: true, config: getMaskedTtsConfig(), voices: TTS_VOICES };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:set_tts_config", async (_e: IpcMainInvokeEvent, patch: any) => {
    try {
      const cfg = applyTtsConfigPatch(patch || {});
      return { success: true, config: getMaskedTtsConfig(), provider: cfg.provider };
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

  // ISSUE-025：孩子 Todolist（今日计划）读取——孩子端「今日计划」弹框与「我的执行力」趋势数据源。
  // 数据真源在服务端 child_todos / child_todo_stats 表（SPLIT，kb.todo.* handler），这里只读返回。
  ipcMain.handle("todo:get", async (_e, childId: string, date?: string) => {
    try {
      const d = typeof date === "string" && date ? date : formatLocalDate(new Date());
      const todo = await dbQuery<{ itemsMd: string; updated: string } | null>("kb.todo.get", {
        child_id: childId,
        date: d,
      }).catch(() => null);
      return { success: true, date: d, itemsMd: todo?.itemsMd ?? "", updated: todo?.updated ?? "" };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("todo:stats:list", async (_e, childId: string, range?: number) => {
    try {
      const rows = await dbQuery<unknown[]>("kb.todo.stats.list", {
        child_id: childId,
        range: typeof range === "number" ? Math.min(365, Math.max(1, Math.floor(range))) : 30,
      }).catch(() => []);
      return { success: true, rows };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ISSUE-033：学习计划只读展示（家长面板；数据真源=服务端 study_plans，编辑走家长对话）
  // 完成态 = 课程「当天活动」判定（2026-09-03）：计划里某课可能是复习（status 早已 ✅），
  // 只看 status 无法判断当天是否真的学/复习了 → 取 courses.first_learned / last_review
  // 是否等于目标日期（today=请求的 date；list 每行用 r.date）。
  // list：排期行列表（服务端 date 倒序最多 500；from/to 在此做日期段过滤，与服务端同步）
  ipcMain.handle("studyPlan:list", async (_e, childId: string, opts?: { from?: string; to?: string }) => {
    try {
      const res = await serverFetch<{ ok: boolean; rows: unknown[] }>(
        `/study-plans?childId=${encodeURIComponent(childId)}`,
        { token: currentSessionToken() }
      );
      let rows = res.rows ?? [];
      if (opts?.from) rows = rows.filter((r: any) => r.date >= opts!.from!);
      if (opts?.to) rows = rows.filter((r: any) => r.date <= opts!.to!);
      const doneOf = await loadCourseDoneMap(childId);
      const enriched = rows.map((r: any) => ({
        ...r,
        content: (r.content ?? []).map((it: any) => ({ ...it, done: doneOf(r.date, it.topicKey, it.text) })),
      }));
      return { success: true, rows: enriched };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // today：某天的排期聚合（date 缺省=本地今天；items 含 carry 标记，供面板高亮今天/顺延项）
  ipcMain.handle("studyPlan:today", async (_e, childId: string, date?: string) => {
    try {
      const d = typeof date === "string" && date ? date : formatLocalDate(new Date());
      const [res, doneOf] = await Promise.all([
        serverFetch<{ ok: boolean; date: string; items: unknown[] }>(
          `/study-plans/today?childId=${encodeURIComponent(childId)}&date=${encodeURIComponent(d)}`,
          { token: currentSessionToken() }
        ),
        loadCourseDoneMap(childId),
      ]);
      const items = (res.items ?? []).map((it: any) => ({ ...it, done: doneOf(d, it.topicKey, it.text) }));
      return { success: true, date: res.date ?? d, items };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * 计划项文本 → 真实课程名（家长对已学课会安排「复习：<课程名>」等带动作前缀的项，
   * courses 表真实标题不含前缀；匹配须先剥前缀，与服务端 ../plan-text.ts 同口径）。
   */
  function planTextToCourseText(text: string): string {
    const t = (text || "").trim();
    if (!t) return "";
    const m = /^(?:复习|温习|学习|预习|背诵|朗读|跟读|听读|挑战|巩固|掌握)\s*[:：]\s*(.+)$/.exec(t);
    if (m) return m[1].trim();
    const s = /^(.*?)[（(](?:复习|温习|回看)[）)]\s*$/.exec(t);
    if (s && s[1].trim()) return s[1].trim();
    return t;
  }

  /**
   * 构建计划项→课程「当天活动」判定（2026-09-03，与服务端 stat 的 courseDoneFor 同口径）：
   * 学习计划里某课可能是「复习」（该课 status 早已 ✅）——只看 status 无法判断目标日期当天
   * 是否真的学/复习了。判定 = 课程的 首次学习(first_learned) 或 最近复习(last_review) 等于
   * 目标日期 → true；课程存在但当天无记录 → false；无对应课程 → undefined。
   * 匹配键：(topic,title) 精确（topicKey+text 剥动作前缀后的课程名），title 兜底。
   */
  async function loadCourseDoneMap(
    childId: string
  ): Promise<(date: string, topicKey: string | undefined, text: string) => boolean | undefined> {
    try {
      const courses = await dbQuery<
        Array<{ topic: string; title: string; status: string; first_learned: string; last_review: string }>
      >("kb.courses.list", { child_id: childId }).catch(
        () => [] as Array<{ topic: string; title: string; status: string; first_learned: string; last_review: string }>
      );
      const byTopicTitle = new Map<string, { first_learned: string; last_review: string }>();
      const byTitle = new Map<string, { first_learned: string; last_review: string }>();
      for (const c of courses ?? []) {
        const title = (c.title || "").trim();
        if (!title) continue;
        const rec = { first_learned: (c.first_learned || "").trim(), last_review: (c.last_review || "").trim() };
        byTopicTitle.set(`${c.topic}\u0000${title}`, rec);
        if (!byTitle.has(title)) byTitle.set(title, rec);
      }
      return (date, topicKey, text) => {
        const t = (text || "").trim();
        if (!t) return undefined;
        // 复习项计划文本与真实课程名差一个「复习：」前缀 → 归一后再查（匹配失败返回 undefined 保持原样）
        const ct = planTextToCourseText(t);
        if (!ct) return undefined;
        let rec = topicKey ? byTopicTitle.get(`${topicKey}\u0000${ct}`) : undefined;
        if (!rec) rec = byTitle.get(ct);
        if (!rec) return undefined;
        return rec.first_learned === date || rec.last_review === date;
      };
    } catch {
      return () => undefined;
    }
  }

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
      const materials = (await getSessionMaterials(session, getChildDir(childId))).slice(-getMaterialsLimit());
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
      // ISSUE-039：返回会话历史，前端进入时回填聊天记录
      const history = getSessionHistory(session);
      return { success: true, history };
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
            // 用设置页配置的默认视觉模型（缺省 qwen/qwen3-vl-flash，见 getVisionModel）
            const vl = await getVisionModel();
            if (vl) {
              await session.setModel(vl);
              _e.sender.send("pi:vision_model_switched", { childId, modelId: vl.id });
              console.log(`[pi:prompt] switched to vision model ${vl.id} for image input`);
            }
          }
        }
        console.log(`[pi:prompt] session ready, calling prompt()...`);
        const beforeCount = (session as any).messages?.length ?? 0;
        childPromptAbort = { stopped: false, abort: () => session.abort() };
        await session.prompt(text, imgCount > 0 ? { images: images! } : undefined);
        console.log(`[pi:prompt] prompt() completed`);
        // 方案B 阶段①：每轮对话后即时增量同步会话 jsonl 上云（失败由 5min 定时/退出兜底重试）
        void syncChildSessions(childId, "prompt").catch(() => {});
        // 用户点「停止」中断了本轮：跳过正常回复/错误回发，只发结束事件（前端已自行收起工作气泡）
        if (childPromptAbort?.stopped) {
          _e.sender.send("pi:reply_end", { childId });
          return { success: true, stopped: true };
        }

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

      // ISSUE-016：一次 prompt 内 agent 可能产生**多条 assistant 消息**（工具调用轮中间的
      // 文本 + 最终回复）。原实现只提取最后一条 → 中间文本实时丢失（jsonl 已写入，历史
      // 恢复才显示两条）。改为按消息逐条回发：第一条替换前端工作气泡、后续追加新气泡，
      // 与历史恢复的呈现一致（同一轮回复的多段内容各自成气泡）。
      const replyTexts: string[] = [];
      for (let i = Math.max(0, beforeCount); i < messages.length; i++) {
        const m = messages[i];
        if (m.role === "assistant") {
          let t = "";
          for (const c of (m.content || [])) {
            if (c.type === "text") t += c.text;
          }
          if (t.trim()) replyTexts.push(t);
        }
      }
      if (replyTexts.length > 0) {
        for (const t of replyTexts) {
          _e.sender.send("pi:reply", { childId, text: t });
        }
      } else {
        // 没有可展示的文本回复（异常兜底，正常应有 text）
        _e.sender.send("pi:reply_error", { childId, error: "没有收到回复，请重试" });
      }
      _e.sender.send("pi:reply_end", { childId });
      // ISSUE-010：正常轮记账（真实 input/output + 已有/新增估算）
      logRound({ session, beforeCount, channel: "child", childId, ok: true, replyLength: replyTexts.join("").length });

      return { success: true };
    } catch (err) {
      // abort 中断导致 prompt reject：不当作错误回发（前端已自行收起工作气泡）
      if (childPromptAbort?.stopped) {
        _e.sender.send("pi:reply_end", { childId });
        return { success: true, stopped: true };
      }
      console.error(`[pi:prompt] error:`, (err as Error).message);
      _e.sender.send("pi:reply_error", { childId, error: friendlyError((err as Error).message) });
      return { success: false, error: (err as Error).message };
    } finally {
      childPromptAbort = null;
    }
  });

  // ISSUE-037：家长发送支持 images（对齐 pi:prompt）
  ipcMain.handle("pi:prompt_parent", async (_e: IpcMainInvokeEvent, text: string, images?: Array<{ type: "image"; mimeType: string; data: string }>) => {
    try {
      const session = await getParentSession();
      const beforeCount = (session as any).messages?.length ?? 0;
      parentPromptAbort = { stopped: false, abort: () => session.abort() };
      const imgCount = images?.length || 0;
      await session.prompt(text, imgCount > 0 ? { images: images! } : undefined);
      // 用户点「停止」中断了本轮：跳过正常回复/错误回发，只发结束事件
      if (parentPromptAbort?.stopped) {
        _e.sender.send("pi:reply_end", { childId: "parent" });
        return { success: true, stopped: true };
      }
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

      // ISSUE-016：与孩子分支一致——本轮新增的每条 assistant 消息逐条回发（多条成多个气泡）
      const replyTexts: string[] = [];
      const messages: any[] = (session as any).messages || [];
      for (let i = Math.max(0, beforeCount); i < messages.length; i++) {
        const m = messages[i];
        if (m.role === "assistant") {
          let t = "";
          for (const c of m.content || []) {
            if (c.type === "text") t += c.text;
          }
          if (t.trim()) replyTexts.push(t);
        }
      }
      if (replyTexts.length > 0) {
        for (const t of replyTexts) {
          _e.sender.send("pi:reply", { childId: "parent", text: t });
        }
      } else {
        // 没有可展示的文本回复（异常兜底，正常应有 text）
        _e.sender.send("pi:reply_error", { childId: "parent", error: "没有收到回复，请重试" });
      }
      _e.sender.send("pi:reply_end", { childId: "parent" });
      // ISSUE-010：正常轮记账
      logRound({ session, beforeCount, channel: "parent", ok: true, replyLength: replyTexts.join("").length });
      return { success: true };
    } catch (err) {
      // abort 中断导致 prompt reject：不当作错误回发
      if (parentPromptAbort?.stopped) {
        _e.sender.send("pi:reply_end", { childId: "parent" });
        return { success: true, stopped: true };
      }
      console.error(`[pi:prompt_parent] error:`, (err as Error).message);
      _e.sender.send("pi:reply_error", { childId: "parent", error: friendlyError((err as Error).message) });
      _e.sender.send("pi:reply_end", { childId: "parent" });
      return { success: false, error: (err as Error).message };
    } finally {
      parentPromptAbort = null;
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

      // ISSUE-016：与孩子分支一致——本轮新增的每条 assistant 消息逐条回发（多条成多个气泡）
      const replyTexts: string[] = [];
      const messages: any[] = (session as any).messages || [];
      for (let i = Math.max(0, beforeCount); i < messages.length; i++) {
        const m = messages[i];
        if (m.role === "assistant") {
          let t = "";
          for (const c of m.content || []) {
            if (c.type === "text") t += c.text;
          }
          if (t.trim()) replyTexts.push(t);
        }
      }
      if (replyTexts.length > 0) {
        for (const t of replyTexts) {
          _e.sender.send("pi:reply", { childId: "parent-content", text: t });
        }
      } else {
        _e.sender.send("pi:reply_error", { childId: "parent-content", error: "没有收到回复，请重试" });
      }
      _e.sender.send("pi:reply_end", { childId: "parent-content" });
      logRound({ session, beforeCount, channel: "parent", ok: true, replyLength: replyTexts.join("").length });
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
    // 标记当前运行中的 prompt 已被停止，收尾时跳过正常回复/错误回发（避免追加多余气泡）
    if (childId === "parent") {
      if (parentPromptAbort && !parentPromptAbort.stopped) parentPromptAbort.stopped = true;
    } else {
      if (childPromptAbort && !childPromptAbort.stopped) childPromptAbort.stopped = true;
    }
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
        // 保留 input（如 ["text","image"]），前端「视觉配置」据此过滤多模态模型
        input: m.input || [],
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

  // ISSUE-042：家长会话重置（对齐 pi:reset）
  ipcMain.handle("pi:reset_parent", async () => {
    try {
      await resetParentSession();
      // 重建干净会话并重新挂载事件（ParentChatPanel 仍挂载，需保证下一次 piPromptParent 可用）
      const session = await getParentSession();
      attachSessionEvents(session, "parent", getMainWindow);
      return { success: true, history: [] };
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

  // ---- 方案B 阶段①：家长「对话回顾」（读服务端同步上云的会话，完整逐字稿）----

  // 有会话消息的日期列表（服务端 session_messages 聚合）
  ipcMain.handle("sessions:reviewDates", async (_e: IpcMainInvokeEvent, childId: string) => {
    try {
      const token = currentSessionToken();
      if (!token) return { success: false, error: "未登录" };
      const data = await serverFetch<{ dates?: Array<{ date: string; count: number }> }>(
        `/sessions/${encodeURIComponent(childId)}/dates`,
        { token }
      );
      return { success: true, dates: data?.dates ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 某天完整逐字稿（剔除 thinking，assistant 附工具调用）
  ipcMain.handle("sessions:reviewMessages", async (_e: IpcMainInvokeEvent, childId: string, date: string) => {
    try {
      const token = currentSessionToken();
      if (!token) return { success: false, error: "未登录" };
      const data = await serverFetch<{
        messages?: Array<{
          ts: number;
          role: string;
          text: string;
          toolCalls?: Array<{ id: string; name: string; arguments: string }>;
        }>;
      }>(`/sessions/${encodeURIComponent(childId)}?date=${encodeURIComponent(date)}`, { token });
      return { success: true, messages: data?.messages ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ---- Backup handlers（ISSUE-003：服务端数据 zip 备份 / 恢复）----

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
      return { success: true, restored: r.restored, skipped: r.skipped, preRestore: r.preRestore };
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

  // 发音评测（智聆 / 阿里儿童）— 家长设置页配置 + 测试
  ipcMain.handle("assessment:config:get", async () => {
    return { success: true, config: getMaskedAssessmentConfig() };
  });

  ipcMain.handle("assessment:config:set", async (_e, patch: any) => {
    try {
      applyAssessmentConfigPatch(patch);
      return { success: true, config: getMaskedAssessmentConfig() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(
    "assessment:test",
    async (_e, audio: ArrayBuffer, provider?: string, refText?: string) => {
      try {
        const buf = Buffer.from(audio);
        const result = await assessAudio(buf, {
          provider: (provider as AssessmentProviderId) || undefined,
          refText: refText || "hello",
        });
        return { success: true, result };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  );

  // ===== 窗口控制（自定义标题栏）=====
  ipcMain.handle("window:minimize", () => {
    getMainWindow()?.minimize();
  });

  // macOS 下无边框窗口的 win.maximize() 不会像 Windows 那样占满整个工作区，
  // 故改为按当前所在屏幕的 workArea 精确填满（即系统原生「缩放」行为，顶部留出菜单栏，
  // 与系统其它 App 一致）；Windows/Linux 沿用原生 maximize()。
  let macMaximizedPrevBounds: Electron.Rectangle | null = null;
  ipcMain.handle("window:maximize-toggle", () => {
    const w = getMainWindow();
    if (!w) return;
    if (process.platform === "darwin") {
      if (macMaximizedPrevBounds) {
        w.setBounds(macMaximizedPrevBounds);
        macMaximizedPrevBounds = null;
        w.webContents.send("window:maximized-changed", false);
      } else {
        macMaximizedPrevBounds = w.getBounds();
        const display = screen.getDisplayMatching(macMaximizedPrevBounds);
        w.setBounds(display.workArea);
        w.webContents.send("window:maximized-changed", true);
      }
    } else {
      if (w.isMaximized()) w.unmaximize();
      else w.maximize();
    }
  });

  ipcMain.handle("window:close", () => {
    getMainWindow()?.close();
  });

  ipcMain.handle("window:is-maximized", () => {
    const w = getMainWindow();
    if (!w) return false;
    return process.platform === "darwin" ? macMaximizedPrevBounds !== null : (w.isMaximized() ?? false);
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

  // ==================== 学习考核（EXAM-REQUIREMENTS.md） ====================
  // 取孩子考核配置（v3 两段式：无 courses → 选课段 selectionPrompt+candidates；带 courses → 出卷段 rubric+scoringPrompt；
  // 自定义排期 scope 直接返回课程；无 scheduleId 时兼容旧行为）
  ipcMain.handle("exam:config", async (_e, childId: string, scheduleId?: string, courses?: string) => {
    try {
      if (scheduleId && courses) {
        return { success: true, data: await getExamCoursesForSchedule(childId, scheduleId, String(courses).split(",")) };
      }
      return { success: true, data: await getExamConfig(childId, scheduleId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 选课（v3 §14.9）：客户端独立内存 session 按服务端下发的选课 prompt（家长可编辑）从候选课程中挑课
  ipcMain.handle("exam:selectCourses", async (_e, childId: string, selectionPrompt: string) => {
    try {
      const titles = await selectCoursesForSchedule(selectionPrompt, childId);
      return { success: true, data: titles };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 待考核提醒（v2：排期到期未完成数；孩子端边栏角标用）
  ipcMain.handle("exam:pending", async (_e, childId: string) => {
    try {
      return { success: true, data: await getExamPending(childId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 考核排期 v2：列表（服务端懒生成固定排期）/ 自定义创建 / 开始 / 完成
  ipcMain.handle("exam:schedules", async (_e, childId: string) => {
    try {
      return { success: true, data: await getExamSchedules(childId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("exam:scheduleCreate", async (_e, childId: string, scheduledAt: string, scope: any) => {
    try {
      return { success: true, data: await createExamSchedule(childId, scheduledAt, scope) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("exam:scheduleStart", async (_e, id: string) => {
    try {
      return { success: true, data: await startExamSchedule(id) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("exam:scheduleComplete", async (_e, id: string, attemptId: string) => {
    try {
      return { success: true, data: await completeExamSchedule(id, attemptId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("exam:scheduleCancel", async (_e, id: string) => {
    try {
      return { success: true, data: await cancelExamSchedule(id) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 固定考核配置（家长端「设置 → 学习考核」）
  ipcMain.handle("exam:fixedConfig", async () => {
    try {
      return { success: true, data: await getFixedExamConfig() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("exam:fixedConfigSave", async (_e, patch: any) => {
    try {
      return { success: true, data: await saveFixedExamConfig(patch) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 提交一次考核结果（含各题语音 buffer 上传；payload 见 ExamAttemptPayload）
  ipcMain.handle(
    "exam:submit",
    async (_e, payload: any, voices: Array<{ qid: string; buffer: ArrayBuffer; name: string }>) => {
      try {
        const childId = String(payload?.childId ?? "");
        for (const v of voices ?? []) {
          const fileId = await uploadExamVoice(childId, v.name, v.buffer);
          const q = (payload.perQuestion ?? []).find((x: any) => x.qid === v.qid);
          if (q) q.audioFileId = fileId;
        }
        const r = await submitExamAttempt(payload);
        return { success: true, data: r };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  );
  // 家长查询考核记录列表 / 每课程考核记录表 / 语音原音（data URL）
  ipcMain.handle("exam:attempts", async (_e, childId: string) => {
    try {
      return { success: true, data: await listExamAttempts(childId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("exam:courseRecords", async (_e, childId: string) => {
    try {
      return { success: true, data: await getExamCourseRecords(childId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("exam:audio", async (_e, fileId: string) => {
    try {
      return { success: true, data: await getExamAudioDataUrl(fileId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 出卷：客户端独立内存 session 按考核方法说明 + 各课考核要点生成全主观题
  ipcMain.handle("exam:generate", async (_e, childId: string, topicConfig: any) => {
    try {
      const questions = await generateExamQuestions(topicConfig, childId);
      return { success: true, data: questions };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 判分：客户端独立内存 session，prompt 取自服务端（单一真源），仅返回结构化结果
  ipcMain.handle("exam:score", async (_e, childId: string, scoringPrompt: string, answers: any[]) => {
    try {
      const result = await scoreExamAttempt(scoringPrompt, answers, childId);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
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
