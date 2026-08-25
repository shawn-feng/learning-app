// Fix: WorkBuddy's Electron shell sets ELECTRON_RUN_AS_NODE=1
// which prevents require('electron') from working correctly
delete process.env.ELECTRON_RUN_AS_NODE;

import { app, BrowserWindow, session } from "electron";
import path from "path";
import { getDataDir } from "./lib/config";
import { initSharedSkills } from "./lib/user-init";
import { registerIpcHandlers } from "./lib/ipc-handlers";
import { disposeAllSessions } from "./lib/pi-session";
import { startScheduler, runCatchUp } from "./lib/scheduler";
import { syncAllData } from "./lib/sync-manager";
import { lintAllChildren } from "./lib/kb-lint";
import { registerMediaScheme, registerMediaProtocol } from "./lib/media-protocol";
import { initUpdater, silentCheckForUpdates } from "./lib/updater";

let mainWindow: BrowserWindow | null = null;

// 必须在 app ready 之前注册自定义 scheme（media:// 用于沙盒 iframe 内播放本地音视频）
registerMediaScheme();

function getMainWindow() {
  return mainWindow;
}

// ISSUE-040: 版本号统一走 app.getVersion()（读 package.json，消除与云端硬编码的双源漂移）

// 启动时网络请求错峰延迟：等窗口创建、network service 稳定后再发起，
// 避免在 Chromium network service 刚初始化时多路请求并发扎堆
// （Windows 上这是 "Network service crashed or was terminated, restarting service" 的常见诱因）。
const STARTUP_NETWORK_DELAY_MS = 1500;
const STARTUP_TASK_TIMEOUT_MS = 30_000;

/** 给启动任务加超时保护：单步卡死（如云端不可达）时不阻塞后续步骤 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * 启动期网络任务串行执行：sync（最重）→ catch-up → 版本检查（最轻）。
 * 每一步独立 try/catch + 超时，单步失败/超时不影响后续步骤；
 * 整条链不阻塞 whenReady，窗口立即可用。
 */
async function runStartupNetworkTasks(): Promise<void> {
  // 1) 云同步（数据拉取，最重，放最前）——ISSUE-041 层 B：孩子（云端∪本地）+ 家长空间
  try {
    const results = await withTimeout(syncAllData(), STARTUP_TASK_TIMEOUT_MS, "Sync");
    console.log("Sync complete:", JSON.stringify(results));
  } catch (e) {
    console.error("Sync failed on startup:", e?.message || e);
  }
  // 2) 定时任务补跑（默认全部关闭，通常立即返回）
  try {
    await withTimeout(runCatchUp(), STARTUP_TASK_TIMEOUT_MS, "Catch-up");
  } catch (e) {
    console.error("Catch-up failed:", e);
  }
  // 3) 版本检查（最轻，放最后）——ISSUE-040: 自动更新（electron-updater），失败降级云端手动下载
  try {
    await withTimeout(silentCheckForUpdates(), STARTUP_TASK_TIMEOUT_MS, "Version check");
  } catch (e) {
    console.debug("Version check error:", e);
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
  startScheduler(); // 本地 cron，无网络请求，立即注册

  // 数据格式校验（SPEC 5.5）：启动时跑一次 + 运行期间每 24h。只报告不修改，
  // 报告落各孩子目录 lint-report.md；error=0 时结构健康（warning 为字段不在白名单的历史基线）。
  const lintOnce = () => {
    try {
      const results = lintAllChildren(getDataDir());
      const errs = results.reduce(
        (n, r) => n + r.issues.filter((i) => (i.severity ?? "error") === "error").length,
        0
      );
      const warnings = results.reduce(
        (n, r) => n + r.issues.filter((i) => i.severity === "warning").length,
        0
      );
      console.log(`[kb-lint] 检查 ${results.length} 个孩子: error=${errs} warning=${warnings}（报告见各孩子 lint-report.md）`);
      if (errs > 0) console.warn(`[kb-lint] ⚠️ ${errs} 条结构性违规，详见各孩子 lint-report.md`);
    } catch (e) {
      console.error("[kb-lint] 检查失败:", e);
    }
  };
  lintOnce();
  setInterval(lintOnce, 24 * 60 * 60 * 1000);
  createWindow();
  // ISSUE-040: 注册自动更新事件推送（需在窗口创建后，事件才能送达渲染层）
  initUpdater(getMainWindow);
  // 启动网络请求串行 + 错峰：窗口先出，network service 稳定后再逐个发起
  setTimeout(() => {
    runStartupNetworkTasks().catch((e) => console.error("Startup network tasks failed:", e));
  }, STARTUP_NETWORK_DELAY_MS);

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
