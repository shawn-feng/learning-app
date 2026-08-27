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
import { getAppSettingsPath, getDataDir, getSchedulerConfigPath } from "./config";
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
  return "";
}

function writeJsonFile(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value ?? {}, null, 2), "utf-8");
}

/**
 * 拉取一次配置：revision 未变 → 不动作；变化 → 全量写回本地文件。
 * 网络/未登录失败静默（下次轮询重试），返回 changed 供调用方判断。
 */
export async function syncOnce(): Promise<{ changed: boolean }> {
  const token = currentSessionToken();
  if (!token) return { changed: false };
  try {
    const rev = await serverFetch<{ revision: number }>("/config/revision", { token });
    const local = readLocalRevision();
    if (rev.revision === local) return { changed: false };
    const full = await serverFetch<{ revision: number; config: Record<string, unknown> }>("/config", {
      token,
    });
    for (const [key, value] of Object.entries(full.config ?? {})) {
      const file = fileForKey(key);
      if (file) writeJsonFile(file, value);
    }
    writeLocalRevision(full.revision);
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
  void syncOnce();
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
