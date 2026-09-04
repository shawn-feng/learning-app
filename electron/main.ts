// Fix: WorkBuddy's Electron shell sets ELECTRON_RUN_AS_NODE=1
// which prevents require('electron') from working correctly
delete process.env.ELECTRON_RUN_AS_NODE;

import { app, BrowserWindow, session, systemPreferences } from "electron";
import path from "path";
import { getDataDir } from "./lib/config";
import { initSharedSkills } from "./lib/user-init";
import { registerIpcHandlers } from "./lib/ipc-handlers";
import { disposeAllSessions } from "./lib/pi-session";
import { startScheduler, runCatchUp } from "./lib/scheduler";
import { startSessionSyncTimer, flushSessionSync } from "./lib/session-sync";
import { startServerFeaturesSync } from "./lib/server-features";
import { lintAllChildren } from "./lib/kb-lint";
import { registerCustomSchemes, registerMediaProtocol, registerAssetProtocol, registerAppProtocol } from "./lib/media-protocol";
import { initUpdater, silentCheckForUpdates } from "./lib/updater";

let mainWindow: BrowserWindow | null = null;

// 必须在 app ready 之前注册自定义 scheme（media:// 播放本地音视频；asset:// 加载共享资料 css/js/图片），一次调用合并注册
registerCustomSchemes();

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
  // 1) 定时任务补跑（默认全部关闭，通常立即返回）
  try {
    await withTimeout(runCatchUp(), STARTUP_TASK_TIMEOUT_MS, "Catch-up");
  } catch (e) {
    console.error("Catch-up failed:", e);
  }
  // 2) 版本检查（最轻，放最后）——ISSUE-040: 自动更新（electron-updater），失败降级云端手动下载
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
    // Built output: 用 app://bundle 加载渲染层（ISSUE-048）。替代 loadFile(file://)——
    // Ubuntu/Chromium143 下 file:// 顶层无真实源，考核页 srcDoc iframe 的 getUserMedia 被
    // Permissions-Policy 拒绝；app:// 是 standard+secure scheme，顶层有源且响应带
    // Permissions-Policy: microphone=*,camera=*（见 registerAppProtocol）。
    mainWindow.loadURL("app://bundle/index.html");
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
  // 放行麦克风/摄像头权限（语音输入与考核录音需要 getUserMedia({audio:true})）。
  // 注意：仅实现 setPermissionRequestHandler 不够。getUserMedia 会先走权限「预检」
  // （setPermissionCheckHandler），预检被拒则直接抛 NotAllowedError —— 在 Linux(Ubuntu) 上
  // 不实现该 handler 时默认拒绝，表现为「没有权限」/ Permission denied，而 Windows/macOS 表现不同，
  // 因此只在 Windows/macOS 测过会漏掉这个 Linux 专属问题。这里同时实现 check 与 request 两个 handler。
  // 权限字符串：Electron 43 为 "media"；一并放行 "microphone"/"camera" 以兼容不同版本/分支。
  const allowMedia = (p: string) => p === "media" || p === "microphone" || p === "camera";
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowMedia(permission));
  });
  // ⚠️ Ubuntu 实测根因补充（2026-09-04，ISSUE-046 修复在 Linux 仍无效的深层原因）：
  // Chromium 的 Permissions-Policy（特性策略）在**权限 handler 之前**就已判定。考试页在
  // srcDoc 沙盒 iframe 里 getUserMedia，顶层文档（生产为 file:// 加载）若无
  // `Permissions-Policy` 响应头，Linux/Chromium 默认 allowlist 不向无源 iframe 开放 media →
  // console 报 "Permissions policy violation: microphone is not allowed in this document."，
  // MediaStreamManager 直接 PERMISSION_DENIED，setPermissionCheckHandler 放行也无效。
  // 修复：给主窗口顶层文档响应注入 Permissions-Policy，显式允许 microphone/camera 给所有 frame
  // （考试 iframe 自身已有 allow="microphone"，缺的是顶层文档背书）。
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    try {
      const rt = details.resourceType;
      // 只处理文档响应（顶层页面 + 其 iframe 页面）；file:// 主文档在 Electron 下也可被拦截
      if (rt === "mainFrame" || rt === "subFrame" || rt === "document") {
        const headers = details.responseHeaders ?? {};
        const add = "microphone=*, camera=*";
        // 合并已有 permissions-policy（若已存在则追加，逗号分隔），避免覆盖其它策略
        const existingKey = Object.keys(headers).find((k) => k.toLowerCase() === "permissions-policy");
        if (existingKey) {
          const cur = Array.isArray(headers[existingKey])
            ? headers[existingKey].join(",")
            : String(headers[existingKey]);
          headers[existingKey] = cur.trim().endsWith(",") ? [cur + add] : [cur + ", " + add];
        } else {
          headers["Permissions-Policy"] = [add];
        }
        callback({ responseHeaders: headers });
        return;
      }
    } catch (e) {
      console.error("[main] onHeadersReceived Permissions-Policy 注入失败:", e);
    }
    callback({});
  });

  // macOS 系统级麦克风权限：主动申请一次，让 app 出现在「系统设置→隐私与安全性→麦克风」
  // 列表并弹出授权询问。若缺 Info.plist 的 NSMicrophoneUsageDescription，系统会静默拒绝且 app 不登记。
  // 仅 macOS 需要；权限已决定（已授权/已拒绝）时 askForMediaAccess 直接返回、不再弹窗。
  if (process.platform === "darwin") {
    systemPreferences
      .askForMediaAccess("microphone")
      .then((granted) => console.log("[mac] microphone access granted:", granted))
      .catch((e) => console.error("[mac] askForMediaAccess failed:", e));
  }

  // 注册 media:// 协议，把沙盒 iframe 里的音视频请求映射到本地媒体文件
  registerMediaProtocol();
  // 注册 asset:// 协议，把沙盒 iframe(srcDoc) 里引用的共享资料文件映射到本地
  registerAssetProtocol();
  // 注册 app://bundle 协议，生产渲染层顶层（替代 file:// 加载，见 createWindow）
  registerAppProtocol();

  registerIpcHandlers(getMainWindow);
  startScheduler(); // 本地 cron，无网络请求，立即注册
  startSessionSyncTimer(); // 会话增量同步兜底（每 5min 批量；每轮对话后另有即时同步）
  startServerFeaturesSync(); // 服务端能力探测（worker 接管后本地 recording/todo 关闭，避免双跑）

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
  flushSessionSync(); // 退出前兜底同步一次（fire-and-forget）
  disposeAllSessions().catch(() => {});
});
