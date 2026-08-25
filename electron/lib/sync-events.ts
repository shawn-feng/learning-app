/**
 * 家长↔孩子事件信箱（ISSUE-041 层 C）。
 *
 * 设计：事件 = 唤醒信号，数据 = 文件同步（storage/{parent_id}/{child_id}/）。
 * - 家长侧：写事件（send_materials / assign_topic / request_progress）。
 * - 孩子侧：定时轮询 pending 事件 → 触发一次对应同步 → ack。
 * 全异步、低频（默认 30 分钟轮询一次），云端无需实时推送。
 */
import { getCloudApiBase } from "./config";
import { getCachedLicense } from "./auth-manager";
import { cloudFetch } from "./cloud-net";

export type SyncEventType = "assign_topic" | "send_materials" | "request_progress";

export interface SyncEvent {
  id: string;
  type: SyncEventType;
  payload: Record<string, unknown>;
  created_at: string;
}

// 轮询间隔由 scheduler-config.json 的 eventPoll 段配置（默认 2 分钟，见 scheduler.ts
// DEFAULT_EVENT_POLL_CONFIG）；此处不再持有常量，避免双源漂移。

async function apiCall(endpoint: string, options: RequestInit = {}): Promise<any> {
  const license = getCachedLicense();
  if (!license) throw new Error("Not authenticated");
  const url = `${getCloudApiBase()}${endpoint}`;
  const res = await cloudFetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${license.token}`,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(`Sync API error ${res.status}: ${err.detail}`);
  }
  return res.json();
}

/** 家长写入一条待处理事件（发送给指定孩子）。 */
export async function writeEvent(
  childId: string,
  type: SyncEventType,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await apiCall(`/api/sync/events/${childId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, payload }),
  });
}

/** 孩子端轮询该孩子的 pending 事件。 */
export async function pollEvents(childId: string): Promise<SyncEvent[]> {
  const resp = await apiCall(`/api/sync/events/${childId}`);
  return Array.isArray(resp?.events) ? (resp.events as SyncEvent[]) : [];
}

/** 孩子端确认事件处理完成。 */
export async function ackEvents(childId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await apiCall(`/api/sync/events/${childId}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ids),
  });
}

/** 家长异地查进度：直读云端孩子数据（无需孩子电脑在线）。 */
export async function queryCloudProgress(childId: string): Promise<any> {
  return apiCall(`/api/sync/progress/${childId}`);
}

/**
 * 孩子端处理一轮事件（scheduler 定时调用）：
 * - assign_topic / send_materials → 拉取孩子数据 + 家长库（材料真源）
 * - request_progress → 推送孩子最新数据到云端
 * 处理完统一 ack（幂等；单终端学习，多设备同时处理也无害）。
 */
export async function handleChildEvents(
  childId: string
): Promise<{ handled: number; error?: string }> {
  try {
    const events = await pollEvents(childId);
    if (!events.length) return { handled: 0 };
    const { syncChild, syncParentLibrary } = await import("./sync-manager");
    for (const ev of events) {
      try {
        if (ev.type === "assign_topic" || ev.type === "send_materials") {
          await syncChild(childId);
          await syncParentLibrary();
        } else if (ev.type === "request_progress") {
          await syncChild(childId);
        }
      } catch (e) {
        console.error(`handleChildEvents: event ${ev.type} failed:`, e);
      }
    }
    await ackEvents(
      childId,
      events.map((e) => e.id)
    );
    return { handled: events.length };
  } catch (e) {
    return { handled: 0, error: (e as Error).message };
  }
}

/** 家长推送资料到云端：同步家长库 + 给指定孩子写 send_materials 事件。 */
export async function pushParentLibraryWithEvent(childIds: string[]): Promise<any> {
  const { syncParentLibrary } = await import("./sync-manager");
  const r = await syncParentLibrary();
  for (const cid of childIds) {
    try {
      await writeEvent(cid, "send_materials", { at: new Date().toISOString() });
    } catch (e) {
      console.error(`writeEvent(send_materials) failed for ${cid}:`, e);
    }
  }
  return r;
}

/** 家长请求最新进度：写 request_progress + 返回当前云端进度（异步生效）。 */
export async function requestAndQueryProgress(childId: string): Promise<any> {
  try {
    await writeEvent(childId, "request_progress", { at: new Date().toISOString() });
  } catch {
    /* 云不可达时仍尝试直读 */
  }
  return queryCloudProgress(childId);
}
