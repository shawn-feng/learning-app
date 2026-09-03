/**
 * 会话 jsonl 增量同步上云（方案B 阶段①，客户端侧）。
 * - 游标：data/children/<childId>/.pi/sync-state.json（files:[name]:{syncedBytes,lineCount}）
 * - 幂等：以「字节偏移 + 行号」增量上传；仅服务端 ack 后才推进游标（离线/失败天然安全，无需持久队列）。
 * - 触发：每轮对话后（pi:prompt 挂钩）即时同步 + 定时 5min 批量兜底 + 退出前 flush。
 */
import fs from "fs";
import path from "path";
import { getChildDir } from "./config";
import { currentSessionToken } from "./client-data";
import { serverFetch } from "./server-client";
import { listChildren } from "./child-auth";
import {
  markSyncAttempt,
  markSyncSuccess,
  markSyncFailure,
  markSyncSkip,
  type SyncTrigger,
} from "./sync-logger";

interface FileSyncState {
  syncedBytes: number;
  lineCount: number;
  lastTs: number;
}
interface SyncState {
  files: Record<string, FileSyncState>;
}

interface Delta {
  name: string;
  fromOffset: number;
  fromIndex: number;
  lines: string[];
}

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
const syncing = new Set<string>();

function syncStatePath(childId: string): string {
  return path.join(getChildDir(childId), ".pi", "sync-state.json");
}

function sessionsDirOf(childId: string): string {
  return path.join(getChildDir(childId), ".pi", "agent", "sessions");
}

function loadSyncState(childId: string): SyncState {
  const p = syncStatePath(childId);
  if (!fs.existsSync(p)) return { files: {} };
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as SyncState;
  } catch {
    return { files: {} };
  }
}

function saveSyncState(childId: string, state: SyncState): void {
  const p = syncStatePath(childId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
}

/** 扫描 sessions 目录，返回每文件未同步的增量（字节游标切片，UTF-8 安全）。 */
function collectDeltas(childId: string, state: SyncState): Delta[] {
  const dir = sessionsDirOf(childId);
  if (!fs.existsSync(dir)) return [];
  const out: Delta[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const full = path.join(dir, f);
    const prev = state.files[f] ?? { syncedBytes: 0, lineCount: 0, lastTs: 0 };
    let buf: Buffer;
    try {
      buf = fs.readFileSync(full);
    } catch {
      continue;
    }
    if (buf.length <= prev.syncedBytes) continue;
    const deltaText = buf.subarray(prev.syncedBytes).toString("utf-8");
    const lines = deltaText
      .split(/\r?\n/)
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    out.push({ name: f, fromOffset: prev.syncedBytes, fromIndex: prev.lineCount, lines });
  }
  return out;
}

/** 同步单个孩子的增量会话到服务端（幂等；服务端 ack 后推进本地游标）。
 * @param trigger 触发源：prompt（每轮对话后）/ timer（5min 定时）/ quit（退出前）/ manual（手动立即同步）
 */
export async function syncChildSessions(childId: string, trigger: SyncTrigger = "manual"): Promise<void> {
  if (syncing.has(childId)) return;
  const token = currentSessionToken();
  if (!token) return;
  const state = loadSyncState(childId);
  const deltas = collectDeltas(childId, state);
  if (deltas.length === 0) {
    markSyncSkip(childId);
    return;
  }

  // 本次待同步字节（各 delta 行拼接后的近似字节数），用于面板展示「还有多少没上云」
  const pendingBytes = deltas.reduce((acc, d) => acc + d.lines.join("\n").length + d.lines.length, 0);
  markSyncAttempt(childId, trigger, pendingBytes);

  syncing.add(childId);
  try {
    const res = await serverFetch<{
      ok: boolean;
      files: Array<{ name: string; syncedBytes: number; lineCount: number }>;
    }>(`/sessions/${encodeURIComponent(childId)}/sync`, {
      method: "POST",
      token,
      body: { files: deltas },
      timeoutMs: 30000,
    });
    if (res?.ok && Array.isArray(res.files)) {
      const next = loadSyncState(childId);
      for (const ack of res.files) {
        if (next.files[ack.name]) {
          next.files[ack.name].syncedBytes = ack.syncedBytes;
          next.files[ack.name].lineCount = ack.lineCount;
          next.files[ack.name].lastTs = Date.now();
        } else {
          next.files[ack.name] = {
            syncedBytes: ack.syncedBytes,
            lineCount: ack.lineCount,
            lastTs: Date.now(),
          };
        }
      }
      saveSyncState(childId, next);
      markSyncSuccess(childId, trigger, pendingBytes);
    } else {
      // 服务端返回了但 ok=false：异常，记入失败（游标不推进，下次重试）
      markSyncFailure(childId, trigger, "server", "服务端未确认同步（ok=false）");
      console.warn(`[session-sync] child ${childId} 同步被服务端拒绝（保留游标待重试）`);
    }
  } catch (err) {
    // 失败不推进游标，下次触发（每轮对话/5min/退出）自动重试
    const e = err as { status?: number; message?: string };
    const errType = typeof e?.status === "number" && e.status > 0 ? `http:${e.status}` : "network";
    const errMsg = e?.message || String(err);
    markSyncFailure(childId, trigger, errType, errMsg);
    console.warn(`[session-sync] child ${childId} 同步失败（保留游标待重试，类型=${errType}）:`, errMsg);
  } finally {
    syncing.delete(childId);
  }
}

/** 定时批量兜底：每 5 分钟对所有孩子同步一次（未登录时跳过）。 */
export function startSessionSyncTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      const token = currentSessionToken();
      if (!token) return;
      void listChildren()
        .then((children) => {
          for (const c of children) {
            void syncChildSessions(c.childId, "timer").catch(() => {});
          }
        })
        .catch(() => {});
    } catch {
      /* 忽略 */
    }
  }, SYNC_INTERVAL_MS);
  if (typeof (timer as NodeJS.Timeout).unref === "function") {
    (timer as NodeJS.Timeout).unref();
  }
}

/** 退出前兜底同步一次（fire-and-forget，不阻塞退出）。 */
export function flushSessionSync(): void {
  try {
    const token = currentSessionToken();
    if (!token) return;
    void listChildren()
      .then((children) => {
        for (const c of children) {
          void syncChildSessions(c.childId, "quit").catch(() => {});
        }
      })
      .catch(() => {});
  } catch {
    /* 忽略 */
  }
}
