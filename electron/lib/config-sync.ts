/**
 * 配置同步（SPLIT M8-C，DESIGN-SPLIT §7）：服务端为配置唯一真源，客户端每 2 分钟轮询
 * /config/revision → 变化则拉全量 → 按「配置 key → 本地文件」映射写回（读取方无感）。
 * 家长设置保存：写本地文件 + pushConfig 同步服务端（跨设备最多 2min 生效）。
 *
 * 映射：key "app_settings" → app-settings.json；key "scheduler_config" → scheduler-config.json
 * （文件级粒度；多设备同时改同一文件后写覆盖，家长场景可接受）。
 */
import fs from "fs";
import path from "path";
import { getAppSettingsPath, getAuthPath, getDataDir, getSchedulerConfigPath } from "./config";
import { serverFetch, ServerError } from "./server-client";
import { currentSessionToken } from "./client-data";

export const CONFIG_POLL_INTERVAL_MS = 2 * 60 * 1000;

function revisionCachePath(): string {
  return path.join(getDataDir(), "cache", "config-revision.json");
}

function readLocalRevision(): number {
  try {
    return Number(JSON.parse(fs.readFileSync(revisionCachePath(), "utf-8")).revision) || 0;
  } catch {
    return 0;
  }
}

function writeLocalRevision(revision: number): void {
  fs.mkdirSync(path.dirname(revisionCachePath()), { recursive: true });
  fs.writeFileSync(revisionCachePath(), JSON.stringify({ revision }, null, 2), "utf-8");
}

function fileForKey(key: string): string {
  if (key === "app_settings") return getAppSettingsPath();
  if (key === "scheduler_config") return getSchedulerConfigPath();
  // 模型 API keys（auth.json）也随家长账号同步（2026-08-30 用户决策：key 上云多设备共享）
  if (key === "auth") return getAuthPath();
  return "";
}

function writeJsonFile(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value ?? {}, null, 2), "utf-8");
}

function readJsonSafe(p: string): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(p, "utf-8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/**
 * 密钥/模型配置补齐（2026-09-02，服务端 worker agent 与客户端同源）：
 * 服务端为真源（worker 直读服务端 settings 的 auth/app_settings），但客户端只在「保存」时推送，
 * 早期配置/推送失败/换服务端数据都会导致服务端缺 key → worker 报 No API key。
 * 本函数在每次拉取配置后执行「只补缺、不覆盖」：
 * - auth：本地有、服务端缺的 provider 条目 → 合并补传（服务端已有 provider 保持不变，避免多设备互相覆盖）；
 * - app_settings：本地有、服务端缺的模型字段（defaultModel/programmingModel/visionModel）→ 合并补传。
 */
async function reconcileMissingSecrets(serverConfig: Record<string, unknown>): Promise<void> {
  try {
    const srvAuth = (serverConfig.auth ?? {}) as Record<string, unknown>;
    const localAuth = readJsonSafe(getAuthPath());
    const mergedAuth: Record<string, unknown> = { ...srvAuth };
    let authChanged = false;
    for (const [k, v] of Object.entries(localAuth)) {
      if (!srvAuth[k] && v && typeof v === "object") {
        mergedAuth[k] = v;
        authChanged = true;
      }
    }
    if (authChanged && Object.keys(mergedAuth).length > 0) {
      await pushConfig("auth", mergedAuth);
      console.log("[config-sync] 已补齐服务端缺失的模型密钥:", Object.keys(mergedAuth).join(", "));
    }

    const srvAs = (serverConfig.app_settings ?? {}) as Record<string, unknown>;
    const localAs = readJsonSafe(getAppSettingsPath());
    const mergedAs: Record<string, unknown> = { ...srvAs };
    let asChanged = false;
    for (const k of ["defaultModel", "programmingModel", "visionModel"]) {
      if (!srvAs[k] && localAs[k]) {
        mergedAs[k] = localAs[k];
        asChanged = true;
      }
    }
    if (asChanged) {
      await pushConfig("app_settings", mergedAs);
      console.log("[config-sync] 已补齐服务端缺失的模型字段");
    }
  } catch (err) {
    // 服务端不可达/未登录：静默（下次轮询再试），不影响主流程
    console.debug("[config-sync] reconcileMissingSecrets skipped:", (err as Error).message);
  }
}

/**
 * 合并写回（2026-08-30 修复「重启后模型为空」）：
 * 服务端配置只覆盖本地同名 key，**本地独有字段保留**（模型配置/API key 选择是设备本地为主，
 * server 旧快照缺字段时不再把本地 defaultModel/programmingModel/visionModel 清空）。
 *
 * ISSUE-053 加固：scheduler_config 是「按 childId 嵌套」结构，浅合并 `{...local,...incoming}`
 * 会把 incoming.children 整段替换——若服务端某 child 快照缺 classTimes/archiveLimit 等非任务字段
 * （或服务端少了本地某 child），回拉即把本地已存的课程时间段等清空（症状：设置当天正常、第二天
 * 课程时间段消失需重设）。故对 scheduler_config 做**按 childId 字段级深合并**：
 *   顶层 `{...local,...incoming}`（parent/backup/eventPoll 本地独有保留）；
 *   children 按 childId 逐个 `{...本地 child, ...服务端 child}`——服务端缺的字段保留本地，
 *   服务端不认识的本地 child 也整体保留。
 * 其余 key（app_settings/auth）维持原浅合并。
 *
 * 额外防丢失：服务端某 child 的 classTimes 若「缺键或空数组」而本地非空，视为服务端快照过期/未同步到
 * （classTimes 是家长设备本地配置、非任务驱动，见 server task-runs 注释「客户端据此合并 classTimes 推回」），
 * 保留本地，避免回拉把已配课程表清空。其余字段（recording/todo/autoNewSession/archiveLimit/classAlertMode）
 * 一律以服务端为准。
 */
const CLASS_FIELD = "classTimes" as const;

function hasContent(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : !!v;
}

function mergeChildConfigs(
  localChildren: Record<string, unknown>,
  incomingChildren: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  // 先把本地全部 child 铺底，保证服务端缺的本地 child 不丢
  for (const [cid, c] of Object.entries(localChildren)) {
    merged[cid] = c && typeof c === "object" ? { ...(c as Record<string, unknown>) } : c;
  }
  // 服务端有该 child → 字段级覆盖（保留本地有、服务端缺的字段）
  for (const [cid, c] of Object.entries(incomingChildren)) {
    const localChild =
      merged[cid] && typeof merged[cid] === "object" ? (merged[cid] as Record<string, unknown>) : {};
    const incomingChild = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
    const next = { ...localChild, ...incomingChild };
    // 服务端 classTimes 空/缺而本地非空 → 保留本地课程表（防 ISSUE-053 数据丢失）
    if (hasContent(localChild[CLASS_FIELD]) && !hasContent(incomingChild[CLASS_FIELD])) {
      next[CLASS_FIELD] = localChild[CLASS_FIELD];
    }
    merged[cid] = next;
  }
  return merged;
}

function mergeJsonFile(key: string, p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let local: Record<string, unknown> = {};
  try {
    local = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    local = {};
  }
  const incoming = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  let merged: Record<string, unknown>;
  if (key === "scheduler_config") {
    merged = { ...local, ...incoming };
    // children 必须按 childId 深合并，绝不能整段替换（否则服务端缺 child / 缺字段会清本地 classTimes）
    const localChildren = (local.children && typeof local.children === "object" ? local.children : {}) as Record<
      string,
      unknown
    >;
    const incomingChildren = (incoming.children && typeof incoming.children === "object"
      ? incoming.children
      : {}) as Record<string, unknown>;
    merged.children = mergeChildConfigs(localChildren, incomingChildren);
  } else {
    merged = { ...local, ...incoming };
  }
  fs.writeFileSync(p, JSON.stringify(merged, null, 2), "utf-8");
}

/**
 * 拉取一次配置：
 * - force=true（登录首拉，2026-08-30 用户决策：**每次登录都去 server 拉一次**）：忽略 revision 直接全量合并；
 * - force=false（2 分钟轮询）：revision 未变且本地 auth.json 已存在 → 不动作；auth.json 缺失也强制拉
 *   （新设备/新家长目录首次登录要能拿到 key，不能只依赖 revision 变化）。
 * 网络/未登录失败静默（下次轮询重试），返回 changed 供调用方判断。
 */
export async function syncOnce(force = false): Promise<{ changed: boolean }> {
  const token = currentSessionToken();
  if (!token) return { changed: false };
  try {
    const rev = await serverFetch<{ revision: number }>("/config/revision", { token });
    const local = readLocalRevision();
    const authMissing = !fs.existsSync(getAuthPath());
    if (!force && rev.revision === local && !authMissing) return { changed: false };
    const full = await serverFetch<{ revision: number; config: Record<string, unknown> }>("/config", {
      token,
    });
    for (const [key, value] of Object.entries(full.config ?? {})) {
      const file = fileForKey(key);
      if (file) mergeJsonFile(key, file, value);
    }
    writeLocalRevision(full.revision);
    // 密钥/模型补齐：本地有、服务端缺 → 补传（worker agent 与服务端同源，见 reconcileMissingSecrets）
    await reconcileMissingSecrets(full.config ?? {});
    return { changed: true };
  } catch (err) {
    // 未配置服务端 / 网络不可达：静默（保持本地配置可用）
    if (err instanceof ServerError && err.status === 0) return { changed: false };
    return { changed: false };
  }
}

/** 设置保存时同步服务端（写本地文件由调用方负责），成功则更新本地 revision。 */
export async function pushConfig(key: string, value: unknown): Promise<void> {
  const data = await serverFetch<{ ok: boolean; revision: number }>("/config/set", {
    method: "POST",
    body: { key, value },
    token: currentSessionToken(),
  });
  if (data.ok) writeLocalRevision(data.revision);
}

// ---- 2 分钟轮询 ----

let pollTimer: NodeJS.Timeout | null = null;

export function startConfigSync(): void {
  if (pollTimer) return;
  // 登录首拉：每次登录都强制去 server 拉一次全量（含模型 key，2026-08-30 用户决策）
  void syncOnce(true);
  pollTimer = setInterval(() => {
    void syncOnce();
  }, CONFIG_POLL_INTERVAL_MS);
}

export function stopConfigSync(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
