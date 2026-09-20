import {
  getCurrentParentId, ipcMain, app, BrowserWindow, dialog, shell, screen, type IpcMainInvokeEvent } from "electron";
import { loginAndCache, registerAndCache, checkAuth, getCachedLicense, clearCachedLicense, verifyParentPassword, verifyLicenseWithCloud } from "./auth-manager";
import { addChild, listChildren, authChild, getProfile, deleteChild, resetChildPassword, updateChildProfile, changeChildPassword } from "./child-auth";
import { getSkillsDir, getChildDir, getUploadsDir, pruneUploads, getServerUrl, setServerUrl , getCurrentParentId } from "./config";
import { getAgentPrompt, saveAgentPrompt, listAgentPromptHistory, restoreAgentPromptVersion, prefetchAgents, fetchAgentPromptRemote } from "./agent-prompts";
import { startConfigSync, stopConfigSync } from "./config-sync";
import { listModels, setModelApiKey, checkProviderAuth, setAppSettings, getModelSettings, streamChildAgent, streamParentAgent, promptChild, promptParent, abortChildAgent, abortParentAgent, bridgeChildAgentEvents, bridgeParentAgentEvents, examGenerateCourse, examGrade, openChildSession, openParentSession, resetChildSession as resetChildSessionServer, resetParentSession as resetParentSessionServer, extractSceneLines, postPageResult } from "./server-agent-client";
import { fetchMaterialContent } from "./media-protocol";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getMaskedConfig, applyVoiceConfigPatch, transcribeAudio, synthesize, prewarmTexts, TTS_VOICES, getMaskedTtsConfig, applyTtsConfigPatch } from "./voice";
import { getLearningSummary, getTopicProgress, getCourseDailySummary, fetchProgressRemote } from "./learning-summary";
import { dbQuery, currentSessionToken } from "./client-data";
import { serverFetch } from "./server-client";
import { formatLocalDate } from "./dates";
import { listChildren } from "./child-auth";
import { readClientLogFile, getClientLog } from "./app-logger";
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
import { getMaterialsLimit, setMaterialsLimit } from "./app-settings";
import { readTokenLog, getTokenSummary } from "./token-stats";
import { getExamConfig, getExamCoursesForSchedule, uploadExamVoice, submitExamAttempt, listExamAttempts, getExamCourseRecords, getExamAudioDataUrl, getExamPending, getExamSchedules, createExamSchedule, startExamSchedule, completeExamSchedule, cancelExamSchedule, getFixedExamConfig, saveFixedExamConfig, getCourseStatus } from "./exam";
import { listWechatBindRequests, decideWechatBindRequest, listWechatBindings, addWechatBinding, removeWechatBinding, getFeishuConfig, saveFeishuConfig } from "./wechat";
import { listNamespaces, decideNamespace, setNamespaceStatus } from "./namespaces";
import { mistakeReport, mistakesList, mistakeAction } from "./mistakes";
import { checkForUpdatesManually, downloadUpdate, quitAndInstall } from "./updater";
import {
  queuePageEvent,
  resolvePageAction,
  setPageExecTransport,
  takePendingPageEvents,
} from "./page-bridge";

/** ISSUE-049：孩子 daily 条目精简结构（对齐 kb.sqlite daily_entries 行，供渲染端左列/右栏展示）。 */
interface DailyEntryLite {
  date: string; // YYYY-MM-DD
  block: string; // 学习/生活/问答/任务
  title: string;
  raw: string; // markdown 风格原文（右栏渲染）
  tags: string;
}

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
    async (_e, payload: { childId?: string; requestId: string; result: any }) => {
      resolvePageAction(payload?.requestId ?? "", payload?.result ?? {});
      // 服务端 agent 下发的受控操作（page_cmd）回执：把渲染层执行结果回传服务端配对 requestId。
      // 否则服务端 scene_command 等工具会一直等到「页面无响应（10s 超时）」。
      if (payload?.requestId) {
        void postPageResult(payload.childId ?? "", payload.requestId, payload?.result ?? { ok: true });
      }
      return { ok: true };
    }
  );

  // agent 中断（停止按钮）支持：记录当前运行中的 prompt 对应的 abort 句柄，
  // 前端点「停止」时调 session.abort() 打断本轮（Pi SDK AgentSession.abort()）。
  // stopped 标记用于 prompt 收尾时跳过正常回复/错误回发（避免 abort 后被前端追加多余气泡）。
  let childPromptAbort: { stopped: boolean; abort: () => Promise<void> } | null = null;
  let parentPromptAbort: { stopped: boolean; abort: () => Promise<void> } | null = null;
  let parentContentPromptAbort: { stopped: boolean; abort: () => Promise<void> } | null = null; // ISSUE-068：家长教学内容会话在途守卫

  // ---- 服务端 agent 流桥（P4 薄客户端）----
  // 孩子/家长对话改走服务端 agent：pi:start_* 建立 SSE 流（事件桥回渲染层 pi:* 通道），
  // pi:prompt* 走 POST（await 到本轮结束），渲染层契约（pi:reply/pi:reply_end/pi:streaming/...）不变。
  const agentStreams = new Map<string, { close: () => void }>();
  const sendToRenderer = (channel: string, payload: any) => {
    getMainWindow()?.webContents.send(channel, payload);
  };
  // 场景台词收集器：场景对话（scene session）与主会话共用同一条孩子流，
  // 但场景页监听 scene:* 通道。这里在流事件上额外把「scene_command say 台词 / 正文 / 结束 / 错误」
  // 派发给当前挂载的场景收集器（仅场景对话期间挂载，其余时间无监听不产生副作用）。
  const sceneCollectors = new Map<string, Array<{ onSay: (speaker: string, text: string) => void; onText: (text: string) => void; onEnd: () => void; onError: (err: string) => void }>>();
  const routeSceneEvent = (childId: string, e: { type: string; data: any }) => {
    const collectors = sceneCollectors.get(childId);
    if (!collectors?.length) return;
    if (e.type === "message_end") {
      const { lines, texts } = extractSceneLines(e.data?.message);
      for (const l of lines) for (const c of collectors) c.onSay(l.speaker, l.text);
      if (!lines.length) for (const t of texts) for (const c of collectors) c.onText(t);
    } else if (e.type === "turn_end" || e.type === "agent_end") {
      for (const c of collectors) c.onEnd();
    } else if (e.type === "error") {
      for (const c of collectors) c.onError(String(e.data?.message ?? "未知错误"));
    }
  };
  const ensureChildStream = (childId: string) => {
    const key = `child:${childId}`;
    if (agentStreams.has(key)) return;
    agentStreams.set(
      key,
      streamChildAgent({
        childId,
        onEvent: (e) => {
          bridgeChildAgentEvents(e, childId, sendToRenderer);
          routeSceneEvent(childId, e);
        },
        onError: (err) => {
          sendToRenderer("pi:reply_error", { childId, error: err });
          sendToRenderer("pi:reply_end", { childId });
          for (const c of sceneCollectors.get(childId) ?? []) c.onError(err);
        },
      })
    );
  };
  const ensureParentStream = (kind: "parent" | "parent-content" | "parent-data") => {
    const key = `parent:${kind}`;
    if (agentStreams.has(key)) return;
    agentStreams.set(
      key,
      streamParentAgent({
        kind,
        onEvent: (e) => bridgeParentAgentEvents(e, kind, sendToRenderer),
        onError: (err) => {
          sendToRenderer("pi:reply_error", { childId: kind, error: err });
          sendToRenderer("pi:reply_end", { childId: kind });
        },
      })
    );
  };
  // 在途守卫（薄客户端版）：与本地 session.abort 解耦，只防「上一轮未结束时重复发送」。
  let childBusy = false;
  let parentBusy = false;
  let parentContentBusy = false;
  let parentDataBusy = false;

  // SPLIT：服务端连接配置（纯服务端模式必需）
  ipcMain.handle("server:get_config", async () => {
    return { url: getServerUrl() };
  });
  ipcMain.handle("server:set_config", async (_e, url: string) => {
    setServerUrl(typeof url === "string" ? url : "");
    return { ok: true, url: getServerUrl() };
  });

  // 导出统一应用日志（client-log.jsonl）到本机（主进程弹保存对话框）——ISSUE-044
  ipcMain.handle("app:exportLog", async (e: IpcMainInvokeEvent) => {
    try {
      const content = readClientLogFile();
      if (!content) return { success: false, error: "暂无应用日志（应用尚未写入 client-log）" };
      const win = BrowserWindow.fromWebContents(e.sender) ?? getMainWindow();
      const res = await dialog.showSaveDialog(win!, {
        title: "导出应用日志",
        defaultPath: `client-log-${new Date().toISOString().slice(0, 10)}.jsonl`,
        filters: [{ name: "JSON Lines", extensions: ["jsonl", "log", "txt"] }],
      });
      if (res.canceled || !res.filePath) return { success: true, canceled: true };
      fs.writeFileSync(res.filePath, content, "utf-8");
      return { success: true, filePath: res.filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 读取最近 limit 条统一应用日志（供诊断面板展示，可选增强）——ISSUE-044
  ipcMain.handle("app:getLogTail", async (_e, limit?: number) => {
    try {
      return { success: true, entries: getClientLog(limit ?? 200) };
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

  // —— 微信桥：绑定请求与绑定管理（家长 JWT，2026-09-17）——
  ipcMain.handle("wechat:bindRequests", async () => {
    try {
      return { success: true, data: await listWechatBindRequests() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("wechat:bindDecide", async (_e, payload: { id: string; action: "confirm" | "reject"; role?: "parent" | "child"; childId?: string; label?: string }) => {
    try {
      return { success: true, data: await decideWechatBindRequest(payload) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("wechat:bindings", async () => {
    try {
      return { success: true, data: await listWechatBindings() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("wechat:bindingAdd", async (_e, payload: { wechatId: string; role: "parent" | "child"; childId?: string; label?: string }) => {
    try {
      return { success: true, data: await addWechatBinding(payload) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("wechat:bindingRemove", async (_e, wechatId: string) => {
    try {
      return { success: true, data: await removeWechatBinding(wechatId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("wechat:feishuGet", async () => {
    try {
      return { success: true, data: await getFeishuConfig() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("wechat:feishuSave", async (_e, payload: { appId: string; appSecret?: string; enabled: boolean }) => {
    try {
      return { success: true, data: await saveFeishuConfig(payload) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // —— Tier 2 自定义数据场景（F15b：设计器草案确认 + 已生效启停）——
  // —— 错题/生字本（ISSUE-114）：查词上报 / 清单 / 掌握与忽略 ——
  ipcMain.handle("mistake:report", async (_e, payload: { childId: string; kind: "unknown_word" | "wrong_question" | "weak_point"; content: string; detail?: string; source?: string; course?: string }) => {
    try {
      return { success: true, data: await mistakeReport(payload.childId, payload) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("mistake:list", async (_e, payload: { childId: string; status?: string; kind?: string; limit?: number }) => {
    try {
      return { success: true, data: await mistakesList(payload.childId, payload) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("mistake:action", async (_e, payload: { childId: string; id: string; action: "mastered" | "dismiss" | "reopen" }) => {
    try {
      return { success: true, data: await mistakeAction(payload.childId, payload.id, payload.action) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("ns:list", async () => {
    try {
      return { success: true, data: await listNamespaces() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("ns:decide", async (_e, payload: { ns: string; action: "confirm" | "reject" }) => {
    try {
      return { success: true, data: await decideNamespace(payload) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("ns:status", async (_e, payload: { ns: string; action: "disable" | "enable" }) => {
    try {
      return { success: true, data: await setNamespaceStatus(payload) };
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
    const { content: userVer, status } = await fetchAgentPromptRemote("child", childId);
    return { content: userVer !== null ? userVer : getDefaultPrompt("child", childId), network: status === "network" };
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
    const { content: userVer, status } = await fetchAgentPromptRemote(scope, ref);
    if (userVer !== null) return { content: userVer, customized: true, network: status === "network" };
    // 无用户版本：区分 scope——家长默认提示词不可整体改，编辑器显示空、只填「追加补充」
    // （buildParentPrompt 会把它追加在默认后）；孩子 AGENTS 可整体定制，返回代码默认当编辑底稿。
    return { content: scope === "parent" ? "" : getDefaultPrompt(scope, ref), customized: false, network: status === "network" };
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

  // ISSUE-049：家长端孩子「每日记录」标签页 —— 按日期范围取 daily 条目（服务端 child kb，倒序）。
  // from/to 形如 YYYY-MM-DD；可选 filters：block(分类)/tag(标签)/title(标题模糊)。
  // 返回 {success, entries}；entries 供渲染端左列展示、右栏显 raw 原文。
  ipcMain.handle(
    "parent:childDaily",
    async (
      _e: IpcMainInvokeEvent,
      childId: string,
      from: string,
      to: string,
      filters?: { block?: string; tag?: string; title?: string }
    ): Promise<{ success: boolean; entries?: DailyEntryLite[]; error?: string }> => {
      try {
        const entries = await dbQuery<DailyEntryLite[]>("kb.daily_entries.queryByRange", {
          child_id: childId,
          from,
          to,
          ...(filters?.block ? { block: filters.block } : {}),
          ...(filters?.tag ? { tag: filters.tag } : {}),
          ...(filters?.title ? { title: filters.title } : {}),
        });
        return { success: true, entries: entries ?? [] };
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

  ipcMain.handle("scheduler:task:create", async (_e, payload: { name: string; type: string; time: string; extra?: Record<string, unknown>; instruction?: string }) => {
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

  // —— ISSUE-047：孩子端 agent 自建定时提醒 ——
  // 创建提醒（关联孩子 + 频率/语音）；取消走 scheduler:task:delete，列举走 scheduler:reminder:list。
  ipcMain.handle(
    "scheduler:reminder:create",
    async (
      _e,
      payload: {
        childId: string;
        name: string;
        text: string;
        time: string;
        frequency: "once" | "daily" | "weekly" | "interval";
        weekday?: number;
        intervalMinutes?: number;
        voice?: boolean;
        fireAt?: string;
        owner?: "parent" | "child";
      }
    ) => {
      try {
        const token = currentSessionToken();
        if (!token) return { success: false, error: "未登录" };
        const data = await serverFetch<{ ok: boolean; id?: string }>("/scheduler/reminders", {
          method: "POST",
          token,
          body: payload,
        });
        return { success: !!data?.ok, id: data?.id };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  );

  ipcMain.handle("scheduler:reminder:list", async (_e, childId: string) => {
    try {
      const token = currentSessionToken();
      if (!token) return { success: false, error: "未登录" };
      const data = await serverFetch<{ reminders?: unknown[] }>(
        `/scheduler/reminders/list?childId=${encodeURIComponent(childId)}`,
        { token }
      );
      return { success: true, reminders: data?.reminders ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 客户端每分钟轮询：取该孩子到期且未播报的提醒（服务端已就地标记，幂等）
  ipcMain.handle("scheduler:reminder:due", async (_e, childId: string) => {
    try {
      const token = currentSessionToken();
      if (!token) return { success: false, error: "未登录" };
      const data = await serverFetch<{ reminders?: Array<{ id: string; text: string; voice: boolean }> }>(
        `/scheduler/reminders?childId=${encodeURIComponent(childId)}`,
        { token }
      );
      return { success: true, reminders: data?.reminders ?? [] };
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
      const s = await getModelSettings();
      return { success: true, key: (s.appSettings?.defaultModel as string) ?? "" };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:set_default_model", async (_e: IpcMainInvokeEvent, key: string) => {
    try {
      await setAppSettings({ defaultModel: key || "" });
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
      const s = await getModelSettings();
      return { success: true, key: (s.appSettings?.programmingModel as string) ?? "" };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:set_programming_model", async (_e: IpcMainInvokeEvent, key: string) => {
    try {
      await setAppSettings({ programmingModel: key || "" });
      return { success: true, key: key || "" };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 默认视觉模型（图片上传自动切换，缺省 qwen/qwen3-vl-flash）
  ipcMain.handle("pi:get_vision_model", async () => {
    try {
      const s = await getModelSettings();
      return { success: true, key: (s.appSettings?.visionModel as string) ?? "" };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:set_vision_model", async (_e: IpcMainInvokeEvent, key: string) => {
    try {
      await setAppSettings({ visionModel: key || "" });
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

  // 孩子端「今日计划」弹框 + 「我的执行力」趋势数据源（2026-09-10 计划域重构版）。
  // 数据真源在服务端孩子 kb：todolist = 三张计划表里窗口覆盖当天的行（/api/v1/plans/today），
  // 趋势 = reward_daily_stats 按日汇总（/api/v1/rewards/:childId）。
  ipcMain.handle("todo:get", async (_e, childId: string, date?: string) => {
    try {
      const d = typeof date === "string" && date ? date : formatLocalDate(new Date());
      const res = await serverFetch<{ ok: boolean; date: string; items: unknown[] }>(
        `/plans/today?childId=${encodeURIComponent(childId)}&date=${encodeURIComponent(d)}`,
        { token: currentSessionToken(), timeoutMs: 20000 }
      );
      return { success: true, date: res.date ?? d, items: res.items ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 近 N 天完成情况（趋势；来自 reward_daily_stats 按日汇总）
  ipcMain.handle("todo:stats:list", async (_e, childId: string, range?: number) => {
    try {
      const n = typeof range === "number" ? Math.min(365, Math.max(1, Math.floor(range))) : 30;
      const res = await serverFetch<{ ok: boolean; recentStats: unknown[] }>(
        `/rewards/${encodeURIComponent(childId)}?days=${n}`,
        { token: currentSessionToken(), timeoutMs: 20000 }
      );
      return { success: true, rows: res.recentStats ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ==================== 计划域 / 积分域（2026-09-10） ====================
  /** 积分详情：余额 + 当日结算（含未解锁）+ 近 N 天趋势 + 流水 */
  ipcMain.handle("reward:get", async (_e, childId: string, opts?: { date?: string; limit?: number; days?: number }) => {
    try {
      const q = new URLSearchParams();
      if (opts?.date) q.set("date", opts.date);
      if (opts?.limit) q.set("limit", String(opts.limit));
      if (opts?.days) q.set("days", String(opts.days));
      const res = await serverFetch<Record<string, unknown>>(
        `/rewards/${encodeURIComponent(childId)}${q.toString() ? `?${q}` : ""}`,
        { token: currentSessionToken(), timeoutMs: 20000 }
      );
      return { success: true, ...(res as object) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  /** 积分奖罚设置（分档 + 门控阈值） */
  ipcMain.handle("reward:config:get", async (_e, childId: string) => {
    try {
      const res = await serverFetch<{ ok: boolean; config: unknown }>(
        `/rewards/${encodeURIComponent(childId)}/config`,
        { token: currentSessionToken(), timeoutMs: 20000 }
      );
      return { success: true, config: res.config };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("reward:config:set", async (_e, childId: string, config: Record<string, unknown>) => {
    try {
      await serverFetch(`/rewards/${encodeURIComponent(childId)}/config`, {
        method: "PUT",
        token: currentSessionToken(),
        body: config,
        timeoutMs: 20000,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  /** 家长审计与修正：取消计划 / 撤销判定 / 代判完成 */
  ipcMain.handle(
    "plan:setStatus",
    async (_e, plan: { childId: string; planId: string; kind: string; action: string; note?: string }) => {
      try {
        const res = await serverFetch<{ ok: boolean; status: string }>("/plans/status", {
          method: "POST",
          token: currentSessionToken(),
          body: plan,
          timeoutMs: 20000,
        });
        return { success: true, status: res.status };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  );

  // ISSUE-033 重构（2026-09-04）：学习计划只读展示（家长面板；数据真源=服务端 study_plans，一课一行，
  // done 由服务端按课程当天活动下发——客户端不再本地剥文本前缀现算）。
  ipcMain.handle("studyPlan:list", async (_e, childId: string, opts?: { from?: string; to?: string }) => {
    try {
      const res = await serverFetch<{ ok: boolean; rows: unknown[] }>(
        `/study-plans?childId=${encodeURIComponent(childId)}`,
        { token: currentSessionToken() }
      );
      let rows = res.rows ?? [];
      if (opts?.from) rows = rows.filter((r: any) => r.date >= opts!.from!);
      if (opts?.to) rows = rows.filter((r: any) => r.date <= opts!.to!);
      return { success: true, rows };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // today：某天的排期聚合（date 缺省=本地今天；items 每课一行含 mode/carry/done）
  ipcMain.handle("studyPlan:today", async (_e, childId: string, date?: string) => {
    try {
      const d = typeof date === "string" && date ? date : formatLocalDate(new Date());
      const res = await serverFetch<{ ok: boolean; date: string; items: unknown[] }>(
        `/study-plans/today?childId=${encodeURIComponent(childId)}&date=${encodeURIComponent(d)}`,
        { token: currentSessionToken() }
      );
      return { success: true, date: res.date ?? d, items: res.items ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
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

  ipcMain.handle(
    "pi:start_child",
    async (_e: IpcMainInvokeEvent, childId: string, courseKey?: string) => {
      try {
        // 薄客户端：建立服务端 agent 事件流（SSE → pi:* 通道），会话由服务端持久管理。
        ensureChildStream(childId);
        // 会话历史回填（ISSUE-100 F1 冷路径：走 /open，服务端跨天自动新建裁决后返回当天历史）
        const session = courseKey ? `course:${courseKey}` : "main";
        const open = await openChildSession(childId, session === "main" ? undefined : session).catch(
          () => ({ messages: [] as any[], materials: [] })
        );
        const history = open.messages;
        // ISSUE-041：孩子打开会话时立即处理一轮云端收件箱（分配包/进度请求），不等定时轮询
        try {
          const { handleCloudInbox } = await import("./delivery");
          handleCloudInbox(childId)
            .then((r) => {
              if (r.applied > 0 || r.pushed) console.log(`[start_child] inbox: applied=${r.applied} pushed=${r.pushed}`);
            })
            .catch(() => {});
        } catch { /* 忽略 */ }
        // 历史与资料由服务端会话驱动（ISSUE-100 历史 + ISSUE-113 展示登记），进会话一并回填
        return { success: true, history, materials: open.materials, materialsLimit: getMaterialsLimit() };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  );

  ipcMain.handle("pi:start_parent", async () => {
    try {
      ensureParentStream("parent");
      // 会话历史回填（ISSUE-107：服务端 /parent-agent/open 返回现会话全部历史，家长不做跨天裁决）
      const history = await openParentSession("parent").catch(() => [] as any[]);
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
      images: Array<{ type: "image"; mimeType: string; data: string }> | null,
      courseKey?: string
    ) => {
      const imgCount = images?.length || 0;
      console.log(
        `[pi:prompt] child=${childId}${courseKey ? ` course=${courseKey}` : ""} text="${text.slice(0, 50)}" images=${imgCount}`
      );
      // 在途守卫：上一轮未结束时拒绝（服务端也会 409 busy，这里给友好提示）
      if (childBusy) {
        return { success: false, error: "上一条消息还在收尾或停止中，请稍候再发。" };
      }
      childBusy = true;
      try {
        // 薄客户端：交给服务端 agent。courseKey → course:<key> 会话；主会话 = main。
        ensureChildStream(childId);
        const session = courseKey ? (`course:${courseKey}` as const) : ("main" as const);
        await promptChild(childId, text, { session, images: images ?? undefined });
        return { success: true };
      } catch (err) {
        console.error(`[pi:prompt] error:`, (err as Error).message);
        _e.sender.send("pi:reply_error", { childId, error: friendlyError((err as Error).message) });
        _e.sender.send("pi:reply_end", { childId });
        return { success: false, error: (err as Error).message };
      } finally {
        childBusy = false;
      }
    }
  );

  // ISSUE-061：场景对话会话 prompt —— 语音球/场景键盘输入走独立 scene agent（专职扮演，与课程会话解耦）
  let scenePromptAbort: { stopped: boolean; abort: () => void } | null = null;
  // 场景对话常用台词预热（首次进入场景会话时后台合成落盘，正式播放命中磁盘缓存零等待）
  const scenePrewarmDone = new Set<string>();
  const SCENE_PREWARM_TEXT = [
    "Hello! Hi!", "I'm Steve.", "What's your name?", "My name is ...", "How are you?", "I'm fine, thank you!",
    "Nice to meet you!", "Welcome to my home!", "Look! This is my living room.",
    "What is this?", "This is a sofa.", "This is a table.", "This is a lamp.", "This is a TV.", "This is a window.", "This is a plant.",
    "What color is it?", "It's black.", "It's red.", "It's yellow.", "It's green.", "It's blue.",
    "Can you say it?", "Say it with me.", "Let's play together!", "Great job!", "Sit down, please.", "Stand up!",
    "Goodbye! See you next time!",
    "sofa", "table", "lamp", "TV", "window", "plant", "picture", "cup",
  ];
  // 每个场景课程只预热一次（首次会话准备 / 首条 prompt 都会触发）
  const sceneTryPrewarm = (childId: string, courseKey: string) => {
    const k = `${childId}|${courseKey}`;
    if (scenePrewarmDone.has(k)) return;
    scenePrewarmDone.add(k);
    // 预热不阻塞对话：失败静默（下次真实合成兜底）
    void prewarmTexts(SCENE_PREWARM_TEXT, { provider: "edge-tts" }).catch(() => {});
  };
  // ISSUE-061：场景「准备」（场景页就绪后由 Learn 调用）——预建 scene 会话/取课文 + 后台预热 TTS，
  // 让第一次说话不必等会话初始化；无任何 LLM 对话产出。
  ipcMain.handle("scene:prepare", async (_e: IpcMainInvokeEvent, childId: string, courseKey: string) => {
    try {
      // 薄客户端：场景会话在服务端，这里只确保孩子流已建 + 预热台词 TTS（TTS 仍在客户端合成）
      ensureChildStream(childId);
      sceneTryPrewarm(childId, courseKey);
      return { success: true };
    } catch (err: any) {
      console.error("[scene:prepare] 失败:", err?.message || err);
      return { success: false, error: String(err?.message || err) };
    }
  });
  ipcMain.handle("scene:prompt", async (_e: IpcMainInvokeEvent, childId: string, courseKey: string, text: string) => {
    ensureChildStream(childId);
    sceneTryPrewarm(childId, courseKey);
    // 场景台词收集器：挂到孩子流上，本轮结束时把「say 台词 / 兜底正文」一次性回发 scene:reply。
    const lines: Array<{ speaker: string; text: string }> = [];
    const texts: string[] = [];
    const collector = {
      onSay: (speaker: string, t: string) => lines.push({ speaker, text: t }),
      onText: (t: string) => texts.push(t),
      onEnd: () => {
        if (lines.length) {
          _e.sender.send("scene:reply", { childId, courseKey, text: lines.map((l) => `${l.speaker} ${l.text}`.trim()).join("\n") });
        } else if (texts.length) {
          for (const t of texts) _e.sender.send("scene:reply", { childId, courseKey, text: t });
        }
        _e.sender.send("scene:reply_end", { childId, courseKey });
      },
      onError: (err: string) => {
        _e.sender.send("scene:reply_error", { childId, courseKey, error: err });
        _e.sender.send("scene:reply_end", { childId, courseKey });
      },
    };
    const arr = sceneCollectors.get(childId) ?? [];
    arr.push(collector);
    sceneCollectors.set(childId, arr);
    try {
      await promptChild(childId, text, { session: "scene" });
      return { success: true };
    } catch (err) {
      _e.sender.send("scene:reply_error", { childId, courseKey, error: friendlyError((err as Error).message) });
      _e.sender.send("scene:reply_end", { childId, courseKey });
      return { success: false, error: (err as Error).message };
    } finally {
      const a2 = sceneCollectors.get(childId) ?? [];
      const i = a2.indexOf(collector);
      if (i >= 0) a2.splice(i, 1);
      if (a2.length) sceneCollectors.set(childId, a2);
      else sceneCollectors.delete(childId);
    }
  });

  // scene 会话历史：场景对话在服务端持久；走 /open（ISSUE-100 F1 跨天裁决），返回当天场景会话历史。
  ipcMain.handle("scene:history", async (_e: IpcMainInvokeEvent, childId: string, courseKey: string) => {
    try {
      const history = (await openChildSession(childId, "scene").catch(() => ({ messages: [] as any[], materials: [] }))).messages;
      return { success: true, history: history.slice(-80) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 结束场景对话：服务端会话持久，无需显式释放；仅返回成功。
  ipcMain.handle("scene:stop", async (_e: IpcMainInvokeEvent, childId: string, courseKey: string) => {
    return { success: true };
  });

  // 场景转交：孩子离开场景时，让课程会话收尾。转交的逐字摘要需场景会话历史（服务端），
  // 当前简化为「一句转交指令」，不含逐句记录（联调点：服务端提供场景摘要后补回）。
  ipcMain.handle("scene:transfer", async (_e: IpcMainInvokeEvent, childId: string, courseKey: string) => {
    try {
      const inject =
        `[系统] 孩子刚刚结束了场景英语的场景互动。请你用在场景里陪伴孩子的角色口吻，` +
        `给孩子一句简短收尾（英文为主、可带一句中文，不要总结式说教）。`;
      await promptChild(childId, inject, { session: `course:${courseKey}` });
      return { success: true };
    } catch (err) {
      console.error(`[scene:transfer] error:`, (err as Error).message);
      _e.sender.send("pi:reply_error", { childId, error: friendlyError((err as Error).message) });
      _e.sender.send("pi:reply_end", { childId });
      return { success: false, error: (err as Error).message };
    }
  });

  // ISSUE-037：家长发送支持 images（对齐 pi:prompt）
  ipcMain.handle("pi:prompt_parent", async (_e: IpcMainInvokeEvent, text: string, images?: Array<{ type: "image"; mimeType: string; data: string }>) => {
    // 在途守卫：上一轮未结束时拒绝
    if (parentBusy) {
      return { success: false, error: "上一条消息还在收尾或停止中，请稍候再发。" };
    }
    parentBusy = true;
    try {
      // 薄客户端：家长会话走服务端（图片暂未随 prompt 上送——联调点：家长识图走 parent_read_image 工具）
      ensureParentStream("parent");
      await promptParent(text, { kind: "parent" });
      return { success: true };
    } catch (err) {
      console.error(`[pi:prompt_parent] error:`, (err as Error).message);
      _e.sender.send("pi:reply_error", { childId: "parent", error: friendlyError((err as Error).message) });
      _e.sender.send("pi:reply_end", { childId: "parent" });
      return { success: false, error: (err as Error).message };
    } finally {
      parentBusy = false;
    }
  });

  // ---- 教学内容生成专用会话（ISSUE-026）：与通用家长助手解耦，专门引导家长制作教学内容 ----
  ipcMain.handle("pi:start_parent_content", async () => {
    try {
      ensureParentStream("parent-content");
      // 会话历史回填（ISSUE-107：同 pi:start_parent，parent-content 槽同样返回现会话全部历史）
      const history = await openParentSession("parent-content").catch(() => [] as any[]);
      return { success: true, history };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:prompt_parent_content", async (_e: IpcMainInvokeEvent, text: string) => {
    // 在途守卫：上一轮未结束时拒绝
    if (parentContentBusy) {
      return { success: false, error: "上一条消息还在收尾或停止中，请稍候再发。" };
    }
    parentContentBusy = true;
    try {
      ensureParentStream("parent-content");
      await promptParent(text, { kind: "parent-content" });
      return { success: true };
    } catch (err) {
      console.error(`[pi:prompt_parent_content] error:`, (err as Error).message);
      _e.sender.send("pi:reply_error", { childId: "parent-content", error: friendlyError((err as Error).message) });
      _e.sender.send("pi:reply_end", { childId: "parent-content" });
      return { success: false, error: (err as Error).message };
    } finally {
      parentContentBusy = false;
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
    // ISSUE-095：接通服务端中止——childId 为 "parent"/"parent-content" 时中止家长会话，
    // 否则视为孩子 id 中止其全部会话（main/scene/course）正在跑的一轮。
    // 服务端 session.abort() 等待 agent idle 后返回；结束经 SSE turn_end 推送，前端忙碌态正常解禁。
    try {
      if (childId === "parent" || childId === "parent-content") {
        await abortParentAgent(childId);
      } else {
        await abortChildAgent(childId);
      }
      return { success: true };
    } catch (err) {
      // 中止失败仅记录：前端已有「已停止」UI + 5s 兜底解禁，不阻塞渲染层
      console.error(`[pi:abort] 中止失败（${childId}）:`, (err as Error).message);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:get_models", async () => {
    try {
      const models = await listModels();
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
    // 薄客户端：模型为家长级（服务端 app_settings.defaultModel），不再有「会话级」模型切换。
    return { success: false, error: "模型已改为家长级（服务端），请在设置页修改默认模型。" };
  });

  ipcMain.handle("pi:set_api_key", async (_e: IpcMainInvokeEvent, provider: string, apiKey: string) => {
    try {
      await setModelApiKey(provider, apiKey);
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
    // 薄客户端：服务端会话持久、由服务端管理生命周期，客户端无需显式释放。
    return { success: true };
  });

  // 会话重置：清空孩子当前会话上下文（服务端 newSession），重新开始。
  // 触发来源：聊天 /reset 命令 或 家长设置的定时任务（scheduler.ts 调用 resetChildSession）。
  ipcMain.handle("pi:reset", async (_e: IpcMainInvokeEvent, childId: string) => {
    try {
      await resetChildSessionServer(childId);
      return { success: true, history: [], materials: [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ISSUE-042：家长会话重置（对齐 pi:reset）
  ipcMain.handle("pi:reset_parent", async () => {
    try {
      await resetParentSessionServer("parent");
      return { success: true, history: [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ---- 独立「数据管理 agent」会话（parent-data）：统一数据 API 操作家长内容库全部表 ----
  ipcMain.handle("pi:start_parent_data", async () => {
    try {
      ensureParentStream("parent-data");
      const history = await openParentSession("parent-data").catch(() => [] as any[]);
      return { success: true, history };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("pi:prompt_parent_data", async (_e: IpcMainInvokeEvent, text: string) => {
    if (parentDataBusy) {
      return { success: false, error: "上一条消息还在收尾或停止中，请稍候再发。" };
    }
    parentDataBusy = true;
    try {
      ensureParentStream("parent-data");
      await promptParent(text, { kind: "parent-data" });
      return { success: true };
    } catch (err) {
      console.error(`[pi:prompt_parent_data] error:`, (err as Error).message);
      _e.sender.send("pi:reply_error", { childId: "parent-data", error: friendlyError((err as Error).message) });
      _e.sender.send("pi:reply_end", { childId: "parent-data" });
      return { success: false, error: (err as Error).message };
    } finally {
      parentDataBusy = false;
    }
  });

  ipcMain.handle("pi:reset_parent_data", async () => {
    try {
      await resetParentSessionServer("parent-data");
      return { success: true, history: [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 列出孩子的历史归档会话（排除当前活跃会话），供前端「显示历史会话」调阅。
  ipcMain.handle("pi:listSessions", async (_e: IpcMainInvokeEvent, childId: string) => {
    // 薄客户端：服务端「历史会话列表」尚未提供，返回空（联调点）。
    return { success: true, sessions: [] };
  });

  // 直接读取指定历史会话文件（按文件名）的活跃路径消息，供前端显示（不加载进 agent 上下文）。
  ipcMain.handle("pi:getSessionMessages", async (_e: IpcMainInvokeEvent, childId: string, file: string) => {
    // 薄客户端：服务端「历史会话逐字稿」尚未提供，返回空（联调点）。
    return { success: true, messages: [] };
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

  // MATERIAL 保鲜：恢复会话展示的资料内容可能滞后于服务端文件更新（尤其场景/课程 html 改版后）。
  // 渲染层在恢复资料后对“服务端共享 html”（filePath 形如 {topic}/...html，非 outputs/）调用本通道，
  // 拉最新内容就地替换 → 资料面板自动载入新版本（不需要 agent 重新 display）。
  ipcMain.handle("materials:refresh", async (_e: IpcMainInvokeEvent, filePath: string) => {
    const rel = String(filePath || "").replace(/^materials\//, "");
    if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]+\/.+\.(html|htm)$/i.test(rel) || rel.startsWith("outputs/")) {
      return { success: false, error: "非服务端共享资料，跳过刷新" };
    }
    try {
      const buf = await fetchMaterialContent(rel);
      const content = buf.toString("utf-8");
      return { success: true, content };
    } catch (err: any) {
      return { success: false, error: String(err?.message || err) };
    }
  });

  // ISSUE-061：场景对话的孩子语音落盘 → data/children/<childId>/voice/scene/<日期>/<时间>.webm
  // （独立于 uploads/，便于后续挑选分析/发音评测；path=相对 data/，rel=相对该孩子 cwd）
  ipcMain.handle("voice:scene_save", async (_e: IpcMainInvokeEvent, childId: string, data: ArrayBuffer | Buffer) => {
    try {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const dateDir = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const dir = path.join(getChildDir(childId), "voice", "scene", dateDir);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Date.now().toString(36)}.webm`;
      const full = path.join(dir, name);
      fs.writeFileSync(full, Buffer.from(data));
      return {
        success: true,
        path: path.join("children", childId, "voice", "scene", dateDir, name).replace(/\\/g, "/"),
        rel: path.join("voice", "scene", dateDir, name).replace(/\\/g, "/"),
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

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

  // ISSUE-078：向 renderer 暴露当前登录家长 id（只读，源自 <data>/.session.json）。
  // 家长聊天面板据此把真实 parentId 传给 ChatWindow，使上传落到 data/parents/<登录家长>/uploads/
  // （此前 renderer 拿不到 id，ChatWindow 兜底 "default"，上传全部落 parents/default，隔离失效）。
  ipcMain.handle("session:get_parent_id", async () => {
    return { success: true, parentId: getCurrentParentId() };
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
  // 2026-09-13：凭证与评测计算统一收归服务端（授权都在 server 端），主进程仅做代理转发。
  ipcMain.handle("assessment:config:get", async () => {
    try {
      const data = await serverFetch<{ config: unknown }>("/assessment/config", {
        method: "GET",
        token: currentSessionToken(),
        timeoutMs: 15000,
      });
      return { success: true, config: data.config };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("assessment:config:set", async (_e, patch: any) => {
    try {
      const data = await serverFetch<{ config: unknown }>("/assessment/config", {
        method: "POST",
        body: patch,
        token: currentSessionToken(),
        timeoutMs: 15000,
      });
      return { success: true, config: data.config };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // 测试：上传录音到服务端（拿 fileId）→ 调服务端 /assessment/assess 计算（无具体孩子上下文，childId 留空）
  ipcMain.handle(
    "assessment:test",
    async (_e, audio: ArrayBuffer, provider?: string, refText?: string) => {
      try {
        const childId = "";
        const fileId = await uploadExamVoice(childId, "assessment-test.webm", audio);
        const data = await serverFetch<{ audioFileId: string; assessmentId: string; result: unknown }>(
          "/assessment/assess",
          {
            method: "POST",
            body: { childId, audioFileId: fileId, refText: refText || "hello", provider },
            token: currentSessionToken(),
            timeoutMs: 60000,
          }
        );
        return { success: true, result: data.result };
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
    // 选课 LLM 已废弃（2026-09-09 起固定档 = 计划周期内必学课全考，内置规则），服务端不再提供选课。
    return { success: false, error: "选课已由服务端内置规则处理（计划周期内必学课全考），无需再调用选课。" };
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
  // 口语/听说题判分（考核内）：上传语音（保留回放）→ 调服务端 /assessment/assess 计算（评测已在 server 端完成，凭证统一收归服务端）。
  // 返回结构与旧版一致 { audioFileId, assessmentId, result }，渲染层无需改动。
  ipcMain.handle(
    "exam:assessSpeech",
    async (
      _e,
      childId: string,
      name: string,
      buffer: ArrayBuffer,
      questionType: string,
      refText: string,
      opts?: { topic?: string; course?: string; isExam?: boolean; examAttemptId?: string }
    ) => {
      try {
        // 上传语音用于家长端回放（使用原始录音 buffer）
        const fileId = await uploadExamVoice(childId, name, buffer);
        // 服务端评测：按配置 provider 自动分流（腾讯智聆 / 阿里声希），音频在服务端统一转 16k wav
        const data = await serverFetch<{ audioFileId: string; assessmentId: string; result: unknown }>(
          "/assessment/assess",
          {
            method: "POST",
            body: { childId, audioFileId: fileId, refText: refText || "", provider: opts?.provider },
            token: currentSessionToken(),
            timeoutMs: 60000,
          }
        );
        return {
          success: true,
          data: { audioFileId: data.audioFileId, assessmentId: data.assessmentId, result: data.result },
        };
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
  // 课程综合学习情况「一站式」（全景：学习/复习/考核），供家长端课程列表与单课详情
  ipcMain.handle("course:status", async (_e, childId: string) => {
    try {
      return { success: true, data: await getCourseStatus(childId) };
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
      // 一次性出题（流式出题路径用 exam:generateCourse；本接口兼容旧调用，逐课并发走服务端）
      const courses = Array.isArray(topicConfig?.courses) ? topicConfig.courses : [];
      const out: any[] = [];
      for (const c of courses) {
        try {
          const r = await examGenerateCourse(childId, { topicName: topicConfig?.name ?? "", courseTitle: c?.title ?? "", childName: "" });
          out.push(...r.questions);
        } catch {
          /* 单课失败跳过，与旧实现一致 */
        }
      }
      return { success: true, data: out };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 流式出题（ISSUE-049）：单门课程出题一次（首门就绪即可开考，其余课程后台逐门生成后增量追加）
  // 考核内容结构化：课程内容 / 该题考核记录（家长端课程详情浏览）
  ipcMain.handle("assess:questionList", async () => {
    try {
      const { listAssessQuestions } = await import("./assess-admin");
      const data = await listAssessQuestions();
      return { success: true, data: data.questions || [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("assess:courseContent", async (_e, topic: string, title: string) => {
    try {
      const { getCourseAssess } = await import("./assess-admin");
      const { course } = await getCourseAssess(String(topic), String(title));
      return { success: true, data: course };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("assess:questionRecords", async (_e, questionId: string) => {
    try {
      const { questionAssessRecords } = await import("./assess-admin");
      const data = await questionAssessRecords(String(questionId));
      return { success: true, data: data.records || [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("exam:generateCourse", async (_e, childId: string, topicName: string, course: any, childName: string) => {
    try {
      const r = await examGenerateCourse(childId, { topicName: topicName || "", courseTitle: course?.title ?? "", childName: childName || "" });
      return { success: true, data: r.questions };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  // 判分：走服务端（判分口径单一真源，不接受客户端传入的 prompt）
  ipcMain.handle("exam:score", async (_e, childId: string, scoringPrompt: string, answers: any[]) => {
    try {
      const result = await examGrade(childId, answers as any);
      return { success: true, data: { perQuestion: result.perQuestion, courseMastery: {}, reinforcePlan: {}, score: 0, overall: result.overall } };
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

/** JSON 解析兜底：toolCall arguments 可能为字符串或对象；解析失败返回 null。 */
function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ════════════ 场景会话历史 → 聊天展示记录（scene:history）════════════
// scene 会话的 jsonl 是对话真源，但 UI 聊天框从不回填——重进孩子模式场景对话「消失」。
// 恢复时不能原样展示 messages：user 侧混有语音识别前缀/页面事件尾巴/开场指令，
// assistant 侧混有模型的总结正文（与字幕不一致）。以下按与 scene:prompt 实时回发
// 完全相同的规则清洗：user 只留孩子的话；assistant 有 say 台词就用台词、无才用正文。

function sceneContentText(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === "object" && (c as any).type === "text" && typeof (c as any).text === "string") {
        parts.push((c as any).text);
      }
    }
  }
  return parts.join("");
}

/** 清洗 scene 会话的 user 文本为「孩子实际说的话」；系统注入/无孩子话语返回空串。 */
function cleanSceneUserText(raw: string): string {
  if (!raw) return "";
  let t = raw.replace(/\s+/g, " ").trim();
  // 系统注入消息（页面就绪清单 / 开场指令 / 课程进入）整体不显示为孩子气泡
  if (/^\[(页面操作|场景就绪|开场|进入|课堂|系统)[^\]]*\]/.test(t)) return "";
  // 语音输入格式：「[语音识别输入…] / 文本 / 【附件音频：…】」→ 取中间段
  const vm = /^\[[^\]]*\]\s*\/\s*([\s\S]*?)(?:\s*\/\s*【附件音频[\s\S]*)?$/.exec(t);
  if (vm) {
    t = vm[1].trim();
  } else {
    // 剥掉可能残留的 [xxx] 前缀
    t = t.replace(/^\[[^\]]*\]\s*/, "");
    // 截断「[页面操作]…」尾巴（可能是「 / [页面操作]」分隔、直接跟在文本后、或换行后）
    const pi = t.indexOf("[页面操作]");
    if (pi > 0) t = t.slice(0, pi).replace(/\s*\/?\s*$/, "");
    t = t.replace(/【附件音频：[\s\S]*?】/g, "");
    t = t.replace(/\s*\/\s*$/, "").trim();
  }
  if (!t || t.startsWith("[") || t.startsWith("【")) return "";
  return t;
}

/** 按「轮」把 scene 会话 messages 组装成聊天展示记录（规则同 scene:prompt 实时回发）。 */
function composeSceneHistoryDisplay(messages: any[]): Array<{ role: "user" | "ai"; text: string; time: string }> {
  const out: Array<{ role: "user" | "ai"; text: string; time: string }> = [];
  const fmtClock = (msStr: string) => {
    const n = Number(msStr);
    if (!Number.isFinite(n) || n <= 0) return "";
    const d = new Date(n);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  let say: string[] = [];
  let texts: string[] = [];
  let lastTs = "";
  const flush = () => {
    if (say.length) {
      out.push({ role: "ai", text: say.join("\n"), time: fmtClock(lastTs) });
    } else if (texts.length) {
      out.push({ role: "ai", text: texts.join("\n"), time: fmtClock(lastTs) });
    }
    say = [];
    texts = [];
  };
  for (const m of messages || []) {
    const role = m?.role;
    const ts = m?.timestamp ? String(m.timestamp) : "";
    if (role === "user") {
      flush();
      const t = cleanSceneUserText(sceneContentText(m.content));
      if (t) {
        out.push({ role: "user", text: t, time: fmtClock(ts) });
      }
      if (ts) lastTs = ts;
    } else if (role === "assistant") {
      if (ts) lastTs = ts;
      const cs = m.content || [];
      for (const c of cs) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
          texts.push(c.text.trim());
        }
        if (c.type === "toolCall" && c.name === "scene_command") {
          const args = typeof c.arguments === "string" ? safeJsonParse(c.arguments) : c.arguments;
          const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
          if (a.command === "say" && typeof a.text === "string" && a.text.trim()) {
            const cid = String(a.character || "").trim();
            const sp = cid ? cid.charAt(0).toUpperCase() + cid.slice(1) + ":" : "";
            say.push(`${sp} ${a.text.trim()}`.trim());
          }
        }
      }
    }
  }
  flush();
  return out;
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
