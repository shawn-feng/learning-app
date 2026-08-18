// Fix: WorkBuddy's Electron shell sets ELECTRON_RUN_AS_NODE=1
// which prevents require('electron') from working correctly
delete process.env.ELECTRON_RUN_AS_NODE;

import { app, BrowserWindow, dialog, session } from "electron";
import path from "path";
import { getDataDir, getCloudApiBase } from "./lib/config";
import { initSharedSkills } from "./lib/user-init";
import { registerIpcHandlers } from "./lib/ipc-handlers";
import { disposeAllSessions } from "./lib/pi-session";
import { startScheduler, runCatchUp } from "./lib/scheduler";
import { syncAllChildren } from "./lib/sync-manager";
import { registerMediaScheme, registerMediaProtocol } from "./lib/media-protocol";

let mainWindow: BrowserWindow | null = null;
const APP_VERSION = "0.1.0";

// 必须在 app ready 之前注册自定义 scheme（media:// 用于沙盒 iframe 内播放本地音视频）
registerMediaScheme();

function getMainWindow() {
  return mainWindow;
}

async function checkForUpdates() {
  try {
    const res = await fetch(`${getCloudApiBase()}/api/version`);
    if (!res.ok) return;
    const info = await res.json();
    console.log("Version check: current=%s, latest=%s", APP_VERSION, info.version);

    if (info.version !== APP_VERSION) {
      const result = await dialog.showMessageBox({
        type: "info",
        title: "发现新版本",
        message: `学习伙伴 ${info.version} 已发布！`,
        detail: info.release_notes || "包含功能改进和问题修复。",
        buttons: ["前往下载", "稍后提醒"],
        defaultId: 0,
      });
      if (result.response === 0 && info.download_url) {
        const { shell } = require("electron");
        shell.openExternal(info.download_url);
      }
    }
  } catch (e) {
    // Silently fail - version check is non-critical
    console.debug("Version check failed:", (e as Error).message);
  }
}

function createWindow() {
  const preloadPath = path.join(__dirname, "..", "preload", "index.js");
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    frame: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 转发最大化状态变化给渲染进程，用于切换标题栏的最大化/还原图标
  mainWindow.on("maximize", () => {
    mainWindow?.webContents.send("window:maximized-changed", true);
  });
  mainWindow.on("unmaximize", () => {
    mainWindow?.webContents.send("window:maximized-changed", false);
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    // Built output: out/main/index.js -> renderer at out/renderer/index.html
    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }
}

app.whenReady().then(() => {
  console.log("cwd:", process.cwd());
  console.log("app.isPackaged:", app.isPackaged);
  console.log("dataDir:", getDataDir());
  getDataDir();
  try {
    initSharedSkills();
    console.log("Shared skills initialized at:", path.join(getDataDir(), "shared", "skills"));
  } catch (e) {
    console.error("Failed to init shared skills:", e);
  }
  // 放行麦克风权限（语音输入需要 getUserMedia({audio:true})）
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });

  // 注册 media:// 协议，把沙盒 iframe 里的音视频请求映射到本地媒体文件
  registerMediaProtocol();

  registerIpcHandlers(getMainWindow);
  startScheduler();
  runCatchUp().catch((e) => console.error("Catch-up failed:", e));
  // Sync: pull latest data from cloud on startup (non-blocking)
  syncAllChildren().then((results) => {
    console.log("Sync complete:", JSON.stringify(results));
  }).catch((e) => {
    console.error("Sync failed on startup:", e?.message || e);
  });
  createWindow();
  // Check for updates (non-blocking, runs after window is shown)
  checkForUpdates().catch((e) => console.debug("Version check error:", e));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  disposeAllSessions().catch(() => {});
});
