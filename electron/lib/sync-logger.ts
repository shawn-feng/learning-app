/**
 * 会话同步日志 + 内存状态快照（ISSUE-043 完善：同步失败不再静默吞掉）
 *
 * 背景：原 session-sync.ts 只在失败时用 console.warn 打到 stdout，打包 app 不落盘、
 * 家长/孩子均看不到「回看空白是因为没连上服务端」。这里把每次同步的成败、连的哪个
 * server、待同步字节、失败类型都落盘 + 维护内存快照，供前端「会话同步」面板实时展示。
 *
 * 落点：data/sync-log.jsonl（全局，所有孩子混合，append-only，带轮转上限）。
 * 每行一条 JSON（见 SyncLogEntry）。
 */
import fs from "fs";
import path from "path";
import { getDataDir, getServerUrl } from "./config";

export type SyncTrigger = "prompt" | "timer" | "quit" | "manual";
export type SyncResult = "ok" | "fail" | "skip" | "pending";

export interface SyncLogEntry {
  ts: string; // ISO
  childId: string;
  trigger: SyncTrigger;
  serverUrl: string; // 本次尝试连的 server（来自 server-connection.json 配置）
  ok: boolean;
  errType?: string; // network | http:<status> | server
  errMsg?: string;
  bytes?: number; // 本次同步/待同步字节
}

export interface ChildSyncStatus {
  childId: string;
  lastSyncAt: string | null; // 最近一次尝试 ISO
  lastResult: SyncResult;
  consecutiveFails: number;
  lastError: string | null;
  connectedServer: string; // 配置的 server 地址（反映连的哪个 server）
  pendingBytes: number; // 最近一次尝试时仍未同步的字节
  lastTrigger: SyncTrigger | null;
}

/** 日志保留上限（行）。超出行数截断保留最近 N 行，避免无限膨胀。 */
export const MAX_SYNC_LOG_LINES = 2000;

const LOG_PATH = path.join(getDataDir(), "sync-log.jsonl");

const statusMap = new Map<string, ChildSyncStatus>();

function ensureStatus(childId: string): ChildSyncStatus {
  let s = statusMap.get(childId);
  if (!s) {
    s = {
      childId,
      lastSyncAt: null,
      lastResult: "pending",
      consecutiveFails: 0,
      lastError: null,
      connectedServer: getServerUrl() || "(未配置)",
      pendingBytes: 0,
      lastTrigger: null,
    };
    statusMap.set(childId, s);
  }
  return s;
}

function appendLog(entry: SyncLogEntry): void {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
    pruneLog();
  } catch {
    /* 日志绝不应影响主流程 */
  }
}

function pruneLog(): void {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const stat = fs.statSync(LOG_PATH);
    if (stat.size < 200 * MAX_SYNC_LOG_LINES) return; // 粗略预估：行数没超就不读
    const lines = fs.readFileSync(LOG_PATH, "utf-8").split("\n");
    if (lines.length <= MAX_SYNC_LOG_LINES + 1) return;
    fs.writeFileSync(LOG_PATH, lines.slice(-MAX_SYNC_LOG_LINES).join("\n"), "utf-8");
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 同步尝试开始（收集完增量、发请求前调用）：刷新连的 server + 待同步字节 + 触发源。不写日志（避免尝试刷屏）。 */
export function markSyncAttempt(childId: string, trigger: SyncTrigger, pendingBytes: number): void {
  const s = ensureStatus(childId);
  s.connectedServer = getServerUrl() || "(未配置)";
  s.pendingBytes = pendingBytes;
  s.lastTrigger = trigger;
}

/** 同步成功：清连续失败、清待同步字节、写一条 ok 日志。 */
export function markSyncSuccess(childId: string, trigger: SyncTrigger, bytes: number): void {
  const s = ensureStatus(childId);
  const now = new Date().toISOString();
  s.lastSyncAt = now;
  s.lastResult = "ok";
  s.consecutiveFails = 0;
  s.lastError = null;
  s.pendingBytes = 0;
  s.lastTrigger = trigger;
  appendLog({ ts: now, childId, trigger, serverUrl: s.connectedServer, ok: true, bytes });
}

/** 同步失败：连续失败 +1、记错误、写一条 fail 日志（含错误类型，便于排查是网络还是 http）。 */
export function markSyncFailure(childId: string, trigger: SyncTrigger, errType: string, errMsg: string): void {
  const s = ensureStatus(childId);
  const now = new Date().toISOString();
  s.lastSyncAt = now;
  s.lastResult = "fail";
  s.consecutiveFails += 1;
  s.lastError = `${errType}: ${errMsg}`;
  s.lastTrigger = trigger;
  appendLog({ ts: now, childId, trigger, serverUrl: s.connectedServer, ok: false, errType, errMsg });
}

/** 无增量可同步（deltas 空）：不动失败计数，仅清待同步字节；首条前把 pending 标记为 ok 避免一直「待同步」。 */
export function markSyncSkip(childId: string): void {
  const s = ensureStatus(childId);
  if (s.lastResult === "pending") s.lastResult = "ok";
  s.pendingBytes = 0;
}

/** 返回当前内存快照（前端面板用）。 */
export function getSyncStatus(): ChildSyncStatus[] {
  return Array.from(statusMap.values()).map((s) => ({ ...s }));
}

/** 读取最近 limit 条日志（从尾部截取，忽略坏行）。 */
export function getSyncLog(limit = 100): SyncLogEntry[] {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const lines = fs.readFileSync(LOG_PATH, "utf-8").split("\n").filter(Boolean);
    const out: SyncLogEntry[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 跳过坏行 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 读取完整日志文本（导出用）。 */
export function readSyncLogFile(): string {
  try {
    if (!fs.existsSync(LOG_PATH)) return "";
    return fs.readFileSync(LOG_PATH, "utf-8");
  } catch {
    return "";
  }
}

/** 预建某孩子的状态条目（可选，便于面板在从未同步过时也显示该孩子）。 */
export function ensureChildStatus(childId: string): void {
  ensureStatus(childId);
}
