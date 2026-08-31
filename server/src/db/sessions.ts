/**
 * 会话 jsonl 增量同步的存储与索引（方案B 阶段①）。
 * - 磁盘镜像：data/sessions/<parentId>/<childId>/<file>.jsonl（与客户端 jsonl 内容一致，仅追加）
 * - 索引：server.sqlite 的 session_messages（供家长回顾查询）+ session_files（同步游标，幂等）
 * 冲突策略 = 客户端权威：同一 (file, line_index) 用 INSERT OR REPLACE 覆盖。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 服务端会话镜像目录（按 parentId/childId 隔离）。 */
export function getSessionsDir(dataDir: string, parentId: string, childId: string): string {
  const dir = path.join(dataDir, "sessions", parentId, childId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 仅允许 basename 且 .jsonl 结尾（防目录穿越）。 */
export function sanitizeSessionFile(name: string): string {
  const base = path.basename(name);
  if (base !== name || !base.endsWith(".jsonl") || base.length > 128 || base.startsWith(".")) {
    throw new Error(`非法会话文件名: ${name}`);
  }
  return base;
}

/** 本地时区 YYYY-MM-DD（服务端本地时区；部署在家庭局域网，与客户端同区）。 */
export function localDateOf(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface SyncFileAck {
  name: string;
  syncedBytes: number;
  lineCount: number;
}

interface SessionFileRow {
  synced_bytes: number;
  line_count: number;
}

type Statement = ReturnType<DatabaseSync["prepare"]>;

/**
 * 幂等追加并索引一个会话文件的增量行。
 * 客户端传 fromOffset/fromIndex 作为已同步游标；服务端以自身 session_files 记录为权威，
 * 重叠部分跳过（不重复 append），只在自身 line_count 之后的行才落盘 + 索引。
 * 返回服务端权威游标，客户端据此推进本地 sync-state（离线重连天然安全）。
 */
export function appendAndIndexSession(
  db: DatabaseSync,
  dataDir: string,
  parentId: string,
  childId: string,
  name: string,
  fromOffset: number,
  fromIndex: number,
  lines: string[]
): SyncFileAck {
  const file = sanitizeSessionFile(name);
  const row = db
    .prepare("SELECT synced_bytes, line_count FROM session_files WHERE child_id = ? AND file = ?")
    .get(childId, file) as SessionFileRow | undefined;
  const synced = row ?? { synced_bytes: 0, line_count: 0 };

  const dir = getSessionsDir(dataDir, parentId, childId);
  const full = path.join(dir, file);

  // 以服务端行数为权威：只处理 index >= line_count 的行（fromIndex 落后则跳过重叠段）
  const skip = Math.max(0, synced.line_count - fromIndex);
  const newLines = lines.slice(skip);
  if (newLines.length === 0) {
    return {
      name: file,
      syncedBytes: fs.existsSync(full) ? fs.statSync(full).size : 0,
      lineCount: synced.line_count,
    };
  }

  const chunk = newLines.map((l) => (l.endsWith("\n") ? l : l + "\n")).join("");
  fs.appendFileSync(full, chunk, "utf-8");

  const insert = db.prepare(
    `INSERT OR REPLACE INTO session_messages
       (child_id, file, line_index, ts, date, role, text, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < newLines.length; i++) {
    indexMessageLine(insert, childId, file, synced.line_count + i, newLines[i]);
  }

  const newBytes = fs.statSync(full).size;
  const newLineCount = synced.line_count + newLines.length;
  db.prepare(
    `INSERT INTO session_files (child_id, file, synced_bytes, line_count, updated)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(child_id, file) DO UPDATE SET
       synced_bytes = excluded.synced_bytes,
       line_count = excluded.line_count,
       updated = excluded.updated`
  ).run(childId, file, newBytes, newLineCount, new Date().toISOString());
  return { name: file, syncedBytes: newBytes, lineCount: newLineCount };
}

/** 解析单行 jsonl 消息条目并写入 session_messages（只收 user/assistant，滤 thinking，带工具调用）。 */
function indexMessageLine(
  insert: Statement,
  childId: string,
  file: string,
  lineIndex: number,
  rawLine: string
): void {
  let entry: any;
  try {
    entry = JSON.parse(rawLine);
  } catch {
    return;
  }
  if (!entry || entry.type !== "message" || !entry.message) return;
  const msg = entry.message;
  const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(ts)) return;
  const role = msg.role;
  if (role !== "user" && role !== "assistant") return;
  const content = Array.isArray(msg.content) ? msg.content : [];
  const texts = content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("");
  const toolCalls = content
    .filter((p: any) => p?.type === "toolCall")
    .map((p: any) => ({
      id: typeof p.id === "string" ? p.id : "",
      name: typeof p.name === "string" ? p.name : "unknown",
      arguments:
        typeof p.arguments === "string"
          ? p.arguments
          : JSON.stringify(p.arguments ?? {}),
    }));
  if (!texts && toolCalls.length === 0) return;
  insert.run(childId, file, lineIndex, ts, localDateOf(ts), role, texts, JSON.stringify(toolCalls));
}

/** 某孩子有会话消息的日期列表（倒序，家长回顾页日期选择器用）。 */
export function listSessionDates(
  db: DatabaseSync,
  childId: string
): Array<{ date: string; count: number }> {
  return db
    .prepare(
      "SELECT date, COUNT(*) AS count FROM session_messages WHERE child_id = ? GROUP BY date ORDER BY date DESC"
    )
    .all(childId) as Array<{ date: string; count: number }>;
}

/** 按日期取完整逐字稿（剔除 thinking；assistant 附工具调用记录）。 */
export function querySessionMessages(
  db: DatabaseSync,
  childId: string,
  date: string
): Array<{ ts: number; role: string; text: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }> {
  const rows = db
    .prepare(
      "SELECT ts, role, text, tool_calls FROM session_messages WHERE child_id = ? AND date = ? ORDER BY ts, file, line_index"
    )
    .all(childId, date) as Array<{ ts: number; role: string; text: string; tool_calls: string }>;
  return rows.map((r) => ({
    ts: Number(r.ts),
    role: r.role,
    text: r.text,
    toolCalls: safeParse(r.tool_calls, []),
  }));
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/**
 * 服务端读取某天对话文本（无头 worker recording 用，镜像客户端 readDailyConversation 逻辑，
 * 数据源换为服务端镜像 data/sessions/）。当天无会话返回空串。
 */
export function readServerDailyConversation(
  dataDir: string,
  parentId: string,
  childId: string,
  date: string
): string {
  const dir = getSessionsDir(dataDir, parentId, childId);
  if (!fs.existsSync(dir)) return "";
  const [y, m, d] = date.split("-").map(Number);
  const start = new Date(y, m - 1, d).getTime();
  const end = start + 24 * 3600 * 1000;
  const msgs: { ts: number; role: string; text: string }[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(path.join(dir, f), "utf-8").split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message" || !entry.message) continue;
        const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        if (!Number.isFinite(ts) || ts < start || ts >= end) continue;
        const role = entry.message.role;
        if (role !== "user" && role !== "assistant") continue;
        const parts = Array.isArray(entry.message.content) ? entry.message.content : [];
        const texts = parts
          .filter((p: any) => p?.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text.trim())
          .filter(Boolean);
        if (texts.length === 0) continue;
        msgs.push({ ts, role, text: texts.join("\n") });
      } catch {
        // 单行损坏跳过
      }
    }
  }
  msgs.sort((a, b) => a.ts - b.ts);
  return msgs.map((m) => `${m.role === "user" ? "孩子" : "饺子"}: ${m.text}`).join("\n\n");
}

/** 服务端无头 worker 任务去重游标读取（ISO 字符串或空）。 */
export function getWorkerState(db: DatabaseSync, childId: string, task: string): string {
  const row = db
    .prepare("SELECT last_run FROM worker_state WHERE child_id = ? AND task = ?")
    .get(childId, task) as { last_run?: string } | undefined;
  return row?.last_run ?? "";
}

/** 任务去重扩展键读取（last_key；当前用于「当天已跑点集合」JSON，见 worker/scheduler.ts）。 */
export function getWorkerStateKey(db: DatabaseSync, childId: string, task: string): string {
  const row = db
    .prepare("SELECT last_key FROM worker_state WHERE child_id = ? AND task = ?")
    .get(childId, task) as { last_key?: string } | undefined;
  return row?.last_key ?? "";
}

export function setWorkerState(
  db: DatabaseSync,
  childId: string,
  task: string,
  lastRun: string,
  lastKey = ""
): void {
  db.prepare(
    `INSERT INTO worker_state (child_id, task, last_run, last_key) VALUES (?, ?, ?, ?)
     ON CONFLICT(child_id, task) DO UPDATE SET
       last_run = excluded.last_run,
       last_key = excluded.last_key`
  ).run(childId, task, lastRun, lastKey);
}
