/**
 * 服务端能力探测（方案B）：拉取 /api/v1/version 的 features 数组并缓存。
 * - 客户端据此做特性切换：服务端支持 worker 后，客户端本地 recording/todo 调度关闭
 *   （避免与服务端无头 worker 双跑）；旧服务端无该标志 → 客户端保持本地调度，不破坏现状。
 */
import { serverFetch } from "./server-client";
import { currentSessionToken } from "./client-data";

let cached: { features: string[]; at: number } | null = null;
const TTL_MS = 10 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export async function refreshServerFeatures(): Promise<string[]> {
  try {
    const token = currentSessionToken();
    const data = await serverFetch<{ features?: string[] }>("/version", {
      token,
      timeoutMs: 8000,
    });
    cached = { features: Array.isArray(data?.features) ? data.features : [], at: Date.now() };
    return cached.features;
  } catch {
    // 服务端不可达：保留旧缓存（无缓存 = 空 = 按旧行为处理）
    return cached?.features ?? [];
  }
}

export function hasServerFeature(name: string): boolean {
  return cached?.features.includes(name) ?? false;
}

/** 启动即探 + 每 10 分钟刷新（失败静默保留旧值）。 */
export function startServerFeaturesSync(): void {
  void refreshServerFeatures();
  if (timer) return;
  timer = setInterval(() => {
    void refreshServerFeatures();
  }, TTL_MS);
  if (typeof timer.unref === "function") timer.unref();
}
