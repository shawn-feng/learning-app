// ISSUE-040: App 自动更新（electron-updater + 阿里云 OSS generic 发布源）
//
// 状态机（推送给渲染层，家长设置页「软件更新」区块消费）：
//   idle → checking → available → downloading → downloaded → (quitAndInstall)
//                ↘ not-available
//                ↘ error（降级：打开 /api/version 的 download_url 手动下载）
//
// 两条触发流：
//   1. 启动静默检查（silentCheckForUpdates）：有新版本才打扰用户（dialog 引导下载/重启）。
//   2. 设置页手动检查（checkForUpdatesManually）：状态经 IPC 事件推给前端，前端展示进度条。
//
// 注意：electron-updater 依赖打包产物 resources/app-update.yml（由 build.publish 生成），
// 开发模式（app.isPackaged=false）没有该文件，全部流程直接返回 disabled。

import { app, dialog, BrowserWindow, shell } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import { getCloudApiBase, getUpdateFeedUrl } from "./config";
import { cloudFetch } from "./cloud-net";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"
  | "disabled";

let win: BrowserWindow | null = null;
let initialized = false;

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload);
}

function pushStatus(status: UpdateStatus, extra?: { info?: UpdateInfo | null; error?: string }): void {
  send("app:update_status", {
    status,
    info: extra?.info ?? null,
    error: extra?.error ?? "",
  });
}

/** 注册 autoUpdater 事件 → 渲染层 IPC。仅打包后真正生效；开发模式推 disabled。 */
export function initUpdater(getMainWindow: () => BrowserWindow | null): void {
  win = getMainWindow();
  if (initialized) return;
  initialized = true;

  if (!app.isPackaged) {
    pushStatus("disabled");
    return;
  }

  // 检查与下载分离：检查到新版本后由用户动作（dialog / 前端按钮）触发下载
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // ISSUE-040: 显式指定 feed（latest.yml + 安装包目录），覆盖打包内嵌的 app-update.yml
  autoUpdater.setFeedURL({ provider: "generic", url: getUpdateFeedUrl() });

  autoUpdater.on("checking-for-update", () => pushStatus("checking"));
  autoUpdater.on("update-available", (info: UpdateInfo) => pushStatus("available", { info }));
  autoUpdater.on("update-not-available", () => pushStatus("not-available"));
  autoUpdater.on("download-progress", (p) => {
    send("app:update_progress", {
      percent: Math.round(p.percent * 10) / 10,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => pushStatus("downloaded", { info }));
  autoUpdater.on("error", (err) => pushStatus("error", { error: (err as Error).message }));
}

/** 手动检查（家长设置页「检查更新」）。检查到新版本后自动开始下载，进度经事件推送。 */
export async function checkForUpdatesManually(): Promise<{ ok: boolean; status: UpdateStatus; error?: string }> {
  if (!app.isPackaged) {
    return { ok: false, status: "disabled", error: "开发模式不支持自动更新" };
  }
  try {
    // update-available → 自动下载（autoDownload=false，需显式触发）
    autoUpdater.once("update-available", () => {
      void autoUpdater.downloadUpdate().catch((e) => pushStatus("error", { error: (e as Error).message }));
    });
    await autoUpdater.checkForUpdates();
    return { ok: true, status: "checking" };
  } catch (e) {
    pushStatus("error", { error: (e as Error).message });
    return { ok: false, status: "error", error: (e as Error).message };
  }
}

/** 启动静默检查：有新版 → dialog「立即更新 / 稍后提醒」；下载完 → dialog「重启安装」。失败降级云端手动下载。 */
export async function silentCheckForUpdates(): Promise<void> {
  if (!app.isPackaged) return;
  try {
    const onAvailable = (info: UpdateInfo) => {
      void showUpdatePrompt(info);
    };
    autoUpdater.once("update-available", onAvailable);
    await autoUpdater.checkForUpdates();
  } catch (e) {
    console.debug("Auto-update check failed, falling back to manual download page:", (e as Error).message);
    await fallbackToManualDownload();
  }
}

async function showUpdatePrompt(info: UpdateInfo): Promise<void> {
  const buttons = ["立即更新", "稍后提醒"];
  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "发现新版本",
    message: `学习伙伴 ${info.version} 已发布！`,
    detail: info.releaseNotes || "包含功能改进和问题修复。",
    buttons,
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return; // 稍后提醒（不记忆，下次启动再提示）
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    console.error("Download update failed:", e);
    await fallbackToManualDownload();
    return;
  }
  const restart = await dialog.showMessageBox({
    type: "info",
    title: "更新已就绪",
    message: `新版本 ${info.version} 已下载完成。`,
    detail: "重启应用即可完成安装。",
    buttons: ["立即重启", "稍后"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (restart.response === 0) {
    autoUpdater.quitAndInstall();
  }
}

/** 手动触发下载（前端在 downloaded 状态点「重启并安装」前一般不直接调用）。 */
export async function downloadUpdate(): Promise<{ ok: boolean; error?: string }> {
  if (!app.isPackaged) return { ok: false, error: "开发模式不支持自动更新" };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    pushStatus("error", { error: (e as Error).message });
    return { ok: false, error: (e as Error).message };
  }
}

/** 重启并安装（下载完成后）。 */
export function quitAndInstall(): void {
  if (!app.isPackaged) return;
  autoUpdater.quitAndInstall();
}

/** 降级路径：electron-updater 不可用时，走云端 /api/version 手动下载（保留旧行为）。 */
async function fallbackToManualDownload(): Promise<void> {
  try {
    const res = await cloudFetch(`${getCloudApiBase()}/api/version`);
    if (!res.ok) return;
    const info = (await res.json()) as {
      version: string;
      release_notes?: string;
      download_url?: string | null;
    };
    if (info.version === app.getVersion()) return;
    const result = await dialog.showMessageBox({
      type: "info",
      title: "发现新版本",
      message: `学习伙伴 ${info.version} 已发布！`,
      detail: info.release_notes || "包含功能改进和问题修复。",
      buttons: ["前往下载", "稍后提醒"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0 && info.download_url) {
      await shell.openExternal(info.download_url);
    }
  } catch (e) {
    console.debug("Manual fallback version check failed:", (e as Error).message);
  }
}
