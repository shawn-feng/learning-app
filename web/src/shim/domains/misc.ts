/**
 * misc 域（Phase 2 实现）：服务端连接配置、应用版本、应用日志、token 统计、
 * 自动更新（Web 天然最新）+ **后台轮询启动器**。
 *
 * - getAppVersion：返回 {success, version}（对齐 ipc app:get_version 形态，
 *   GeneralSettings 按 r.success/r.version 消费）；版本号 = 根 package.json version + "-web"。
 * - 自动更新：对齐 updater.ts 开发模式（!app.isPackaged）返回形状——checkUpdate →
 *   {ok:false, status:"disabled", error}（GeneralSettings 的 disabled 分支条件是
 *   !r.ok && r.status === "disabled"）、downloadUpdate → {ok:false, error}；
 *   quitAndInstall → {success:true}；onUpdateStatus/onUpdateProgress 为永不触发的
 *   no-op 订阅，返回清理函数对齐 preload 形态。
 * - 应用日志：浏览器无 client-log.jsonl → getLogTail 返回空 entries（结构对齐
 *   app:getLogTail 的 {success, entries}），exportLog 返回明确「不支持」错误
 *   （GeneralSettings 显示 error 文案，对齐 ipc 失败分支 {success:false, error}）。
 * - token 统计：Electron 数据源是主进程本地 token-log.jsonl（electron/lib/token-stats.ts），
 *   服务端无对应端点 → 返回与「空日志」一致的结构（TokenStatsPanel 对空 summary/entries
 *   有兜底聚合，面板显示全零，不报错）。
 * - startMiscLoops()：聚合计时器类后台任务（config-sync 2min 轮询 + 提醒 60s 轮询），
 *   **需要协调方在 install.ts 接线**（本域文件所有权不含 install.ts）：
 *   `import { startMiscLoops } from "./domains/misc"` 并在 installWebApi() 末尾调用。
 *   未接线时 schedulerConfigGet / childSelect / childAuth 会惰性 ensure，功能不缺失。
 */
import { getServerBase, setServerBase } from "../core/server-fetch";
import { eventBus } from "../core/event-bus";
import { startConfigSyncLoop } from "./config";
import { ensureReminderLoop } from "./scheduler";

/** Web 版本号（根 package.json version + "-web" 后缀） */
const WEB_APP_VERSION = "0.1.15-web";

/** token 汇总空结构（字段名对齐 src/components/TokenStatsPanel.tsx 的 Summary）。 */
const EMPTY_TOKEN_SUMMARY = {
  rounds: 0,
  totalInput: 0,
  totalOutput: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  totalCost: 0,
  totalTokens: 0,
  lastTs: null,
  byModel: {} as Record<string, { rounds: number; input: number; output: number; cost: number }>,
};

export const miscDomain = {
  // ---- 服务端连接配置（真实现） ----

  /** serverGetConfig: () => Promise<{ url: string }>（server:get_config → {url}） */
  serverGetConfig: async (): Promise<{ url: string }> => {
    const base = getServerBase();
    return { url: base || window.location.origin };
  },

  /** serverSetConfig: (url) => Promise<{ url: string }>（消费方读 r.url；Web 空串 = 同源） */
  serverSetConfig: async (url: string): Promise<{ url: string }> => {
    const saved = setServerBase(url);
    return { url: saved };
  },

  // ---- 应用版本（真实现，对齐 ipc app:get_version 返回形态） ----

  /** getAppVersion: () => Promise<{ success: boolean; version: string }> */
  getAppVersion: async (): Promise<{ success: boolean; version: string }> => {
    return { success: true, version: WEB_APP_VERSION };
  },

  // ---- 应用日志（Web 无本地日志文件；结构对齐 ipc app:exportLog / app:getLogTail） ----

  /** appExportLog: () => Promise<{ success: false; error: string }>（浏览器环境无 client-log.jsonl） */
  appExportLog: async (): Promise<{ success: boolean; error?: string }> => {
    return { success: false, error: "Web 版不支持导出应用日志（浏览器环境无本地日志文件）" };
  },

  /** appGetLogTail: (limit?) => Promise<{ success: true; entries: [] }>（空日志） */
  appGetLogTail: async (_limit?: number): Promise<{ success: boolean; entries: unknown[] }> => {
    return { success: true, entries: [] };
  },

  // ---- token 统计（服务端无端点 → 空结构；对齐 ipc token:summary / token:list 形态） ----

  /** getTokenSummary: (childId?) => Promise<{ success: true; summary }>（childId 参数对齐 preload，Web 无本地 token 日志，恒空汇总） */
  getTokenSummary: async (
    _childId?: string
  ): Promise<{ success: boolean; summary: typeof EMPTY_TOKEN_SUMMARY }> => {
    return { success: true, summary: { ...EMPTY_TOKEN_SUMMARY, byModel: {} } };
  },

  /** getTokenList: (childId?, limit?) => Promise<{ success: true; entries: [] }> */
  getTokenList: async (
    _childId?: string,
    _limit?: number
  ): Promise<{ success: boolean; entries: unknown[] }> => {
    return { success: true, entries: [] };
  },

  // ---- 自动更新（Web 天然最新；对齐 updater.ts 开发模式 disabled 语义） ----

  /** checkUpdate: () => Promise<{ ok: false; status: "disabled"; error: string }>（渲染层 !r.ok && status==="disabled" 进 disabled 分支） */
  checkUpdate: async (): Promise<{ ok: boolean; status: string; error?: string }> => {
    return { ok: false, status: "disabled", error: "Web 版不支持自动更新（刷新页面即为最新版本）" };
  },

  /** downloadUpdate: () => Promise<{ ok: false; error: string }>（对齐 updater.ts downloadUpdate 开发模式返回） */
  downloadUpdate: async (): Promise<{ ok: boolean; error?: string }> => {
    return { ok: false, error: "Web 版不支持自动更新（刷新页面即为最新版本）" };
  },

  /** quitAndInstall: () => Promise<{ success: true }>（对齐 ipc app:quit_and_install 恒返回） */
  quitAndInstall: async (): Promise<{ success: boolean }> => {
    return { success: true };
  },

  /** onUpdateStatus: (callback) => 取消订阅函数（app:update_status，Web 永不触发） */
  onUpdateStatus: (callback: (data: { status: string; info?: any; error?: string }) => void): (() => void) => {
    return eventBus.on("app:update_status", (data) => callback(data));
  },

  /** onUpdateProgress: (callback) => 取消订阅函数（app:update_progress，Web 永不触发） */
  onUpdateProgress: (callback: (data: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  }) => void): (() => void) => {
    return eventBus.on("app:update_progress", (data) => callback(data));
  },
};

// ---------------------------------------------------------------------------
// 后台轮询启动器（协调方在 install.ts 接线）
// ---------------------------------------------------------------------------

/**
 * 启动 Web 版后台轮询（幂等）：
 *   1. config-sync：2min GET /config/revision + 启动强拉一次（对齐 Electron 登录后 startConfigSync）；
 *   2. 提醒轮询：60s GET /scheduler/reminders?childId=（对齐主进程 node-cron 每分钟检查）。
 * install.ts 接线示例：installWebApi() 末尾追加 startMiscLoops()。
 */
export function startMiscLoops(): void {
  startConfigSyncLoop();
  ensureReminderLoop();
}
