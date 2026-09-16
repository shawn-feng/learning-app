/**
 * config 域：通用设置（资料数量上限）+ 云端事件轮询配置 + **config-sync 轮询**。
 *
 * 实现口径（对照 electron）：
 * - materialsLimitGet/Set：服务端 app_settings 是唯一真源（ISSUE-097 收口）——
 *   GET /models/settings 读 materialsLimit、POST /models/app_settings 合并写入
 *   （对齐 electron/lib/app-settings.ts：本地文件仅离线回退，Web 无本地文件）。
 * - eventPollConfigGet/Set：设备级配置（对齐 scheduler-config.json 的 eventPoll 段），
 *   Web 存 localStorage（同「设备级、不随账号漫游」语义）；返回**裸配置对象**
 *   （ipc 两通道不经 {success} 包装，直接返回 getEventPollConfig/setEventPollConfig 结果）。
 * - config-sync（electron/lib/config-sync.ts 的 Web 等价）：2min 轮询 GET /config/revision，
 *   变化则 GET /config 全量。Electron 把 scheduler_config/app_settings/auth 合并写本地文件；
 *   Web 只需把 **scheduler_config** 更新进内存缓存（scheduler 域消费；app_settings 走
 *   /models/settings 直读、auth 走 /models/apikey 直写，均无需本地镜像）。
 *   Electron 的同步不向渲染层发任何事件（仅本地 pi:set_default_model 主动发）→ Web 同样不发。
 *
 * 启动：startConfigSyncLoop() 由 misc.ts 的 startMiscLoops() 聚合（协调方在 install.ts 接线）；
 * schedulerConfigGet 首次调用时也会惰性 ensure（兜底，未接线也能工作）。
 */
import { http, getStoredToken } from "../core/server-fetch";

export const configDomain = {
  /** materialsLimitGet: () => Promise<{ success: boolean; limit?: number; error?: string }>（settings:materials_limit:get） */
  materialsLimitGet: async (): Promise<{ success: boolean; limit?: number; error?: string }> => {
    try {
      const s = await http<{ appSettings: Record<string, unknown> }>("/models/settings");
      const n = Number((s.appSettings as { materialsLimit?: unknown })?.materialsLimit);
      return { success: true, limit: Number.isFinite(n) && n > 0 ? Math.floor(n) : 20 };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** materialsLimitSet: (n: number) => Promise<{ success: boolean; limit?: number; error?: string }>（settings:materials_limit:set，服务端合并端点只动 materialsLimit） */
  materialsLimitSet: async (n: number): Promise<{ success: boolean; limit?: number; error?: string }> => {
    const valid = Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
    try {
      await http("/models/app_settings", { method: "POST", body: { materialsLimit: valid } });
      return { success: true, limit: valid };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** eventPollConfigGet: () => SchedulerEventPollConfig（eventpoll:config:get，裸对象返回；设备级 → localStorage） */
  eventPollConfigGet: (): { enabled: boolean; intervalMinutes: number } => {
    return loadEventPollConfig();
  },

  /** eventPollConfigSet: (cfg) => SchedulerEventPollConfig（eventpoll:config:set；clamp 1..60 对齐 setEventPollConfig） */
  eventPollConfigSet: (cfg: { enabled?: boolean; intervalMinutes?: number }): { enabled: boolean; intervalMinutes: number } => {
    return saveEventPollConfig(cfg);
  },
};

// ---------------------------------------------------------------------------
// eventPoll（设备级，localStorage）
// ---------------------------------------------------------------------------

const LS_KEY_EVENT_POLL = "web.eventPollConfig";
/** 默认关闭（对齐 DEFAULT_EVENT_POLL_CONFIG：云端消息交换已废弃，全部走自建服务端）。 */
const DEFAULT_EVENT_POLL = { enabled: false, intervalMinutes: 2 };

function loadEventPollConfig(): { enabled: boolean; intervalMinutes: number } {
  try {
    const raw = localStorage.getItem(LS_KEY_EVENT_POLL);
    if (!raw) return { ...DEFAULT_EVENT_POLL };
    const v = JSON.parse(raw) as { enabled?: unknown; intervalMinutes?: unknown };
    const interval = Number.isFinite(Number(v.intervalMinutes))
      ? Math.min(60, Math.max(1, Math.floor(Number(v.intervalMinutes))))
      : DEFAULT_EVENT_POLL.intervalMinutes;
    const enabled = typeof v.enabled === "boolean" ? v.enabled : DEFAULT_EVENT_POLL.enabled;
    return { enabled, intervalMinutes: interval };
  } catch {
    return { ...DEFAULT_EVENT_POLL };
  }
}

function saveEventPollConfig(cfg: { enabled?: boolean; intervalMinutes?: number }): {
  enabled: boolean;
  intervalMinutes: number;
} {
  const interval = Number.isFinite(Number(cfg?.intervalMinutes))
    ? Math.min(60, Math.max(1, Math.floor(Number(cfg.intervalMinutes))))
    : DEFAULT_EVENT_POLL.intervalMinutes;
  const next = { enabled: cfg?.enabled ?? DEFAULT_EVENT_POLL.enabled, intervalMinutes: interval };
  try {
    localStorage.setItem(LS_KEY_EVENT_POLL, JSON.stringify(next));
  } catch {
    /* 隐私模式等场景静默（仅本设备记忆丢失） */
  }
  return next;
}

// ---------------------------------------------------------------------------
// config-sync（electron/lib/config-sync.ts 的 Web 等价）
// ---------------------------------------------------------------------------

const CONFIG_POLL_INTERVAL_MS = 2 * 60 * 1000;
const LS_KEY_CONFIG_REVISION = "web.configRevision";

/** 服务端 scheduler_config 当前值（children + parent + backup/eventPoll 等段落整体）。 */
let schedulerConfigCache: Record<string, unknown> | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncing = false;

function readStoredRevision(): number {
  try {
    return Number(JSON.parse(localStorage.getItem(LS_KEY_CONFIG_REVISION) || "").revision) || 0;
  } catch {
    return 0;
  }
}

function writeStoredRevision(revision: number): void {
  try {
    localStorage.setItem(LS_KEY_CONFIG_REVISION, JSON.stringify({ revision }));
  } catch {
    /* 忽略 */
  }
}

/**
 * 拉一次配置（对齐 syncOnce）：force（登录首拉）忽略 revision 直接全量；
 * 未登录/网络失败静默返回（下次轮询重试）。
 */
async function syncOnce(force = false): Promise<void> {
  if (!getStoredToken()) return;
  if (syncing) return;
  syncing = true;
  try {
    const rev = await http<{ revision: number }>("/config/revision");
    if (!force && rev.revision === readStoredRevision()) return;
    const full = await http<{ revision: number; config: Record<string, unknown> }>("/config");
    const sc = full.config?.scheduler_config;
    if (sc && typeof sc === "object") schedulerConfigCache = sc as Record<string, unknown>;
    writeStoredRevision(full.revision);
  } catch {
    /* 服务端不可达：保持内存缓存可用，下次轮询重试 */
  } finally {
    syncing = false;
  }
}

/** 启动 2min 轮询（幂等）。登录/首拉 force 语义由调用方保证：misc.startMiscLoops 在 install 后调用即等价「启动即强拉一次」。 */
export function startConfigSyncLoop(): void {
  if (syncTimer) return;
  void syncOnce(true);
  syncTimer = setInterval(() => void syncOnce(false), CONFIG_POLL_INTERVAL_MS);
}

/** 惰性兜底：schedulerConfigGet 等首次调用时启动（未接线 install.ts 也能工作）。 */
export function ensureConfigSyncStarted(): void {
  startConfigSyncLoop();
}

/** 当前内存中的 scheduler_config（可能为 null=尚未同步到）。 */
export function getCachedSchedulerConfig(): Record<string, unknown> | null {
  return schedulerConfigCache;
}

/** 服务端拉取 scheduler_config 并更新缓存（schedulerConfigGet 首次/回源用）。 */
export async function loadSchedulerConfigFromServer(): Promise<Record<string, unknown>> {
  const full = await http<{ revision: number; config: Record<string, unknown> }>("/config");
  const sc = full.config?.scheduler_config;
  schedulerConfigCache = sc && typeof sc === "object" ? (sc as Record<string, unknown>) : {};
  writeStoredRevision(full.revision);
  return schedulerConfigCache;
}

/** 整键推送 scheduler_config（对齐 pushConfig("scheduler_config", config)）并更新本地 revision/缓存。 */
export async function pushSchedulerConfig(config: Record<string, unknown>): Promise<void> {
  const r = await http<{ ok: boolean; revision: number }>("/config/set", {
    method: "POST",
    body: { key: "scheduler_config", value: config },
  });
  if (r.ok) {
    schedulerConfigCache = config;
    writeStoredRevision(r.revision);
  }
}
