/**
 * 会话消息索引与查询（服务端唯一真源）。
 * - 服务端 agent 把对话落盘到 data/agent-sessions/<parentId>/<childId>-<slot>/*.jsonl（9/12 迁移后客户端不再同步）。
 * - indexAgentSessionsIntoDb 把新增 jsonl 增量写入 server.sqlite 的 session_messages（供家长回顾查询，游标去重）。
 * - session_files 表仅记录 agent-sessions 的索引游标（child_id + file + line_count），幂等重跑安全。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 本地时区 YYYY-MM-DD（服务端本地时区；部署在家庭局域网，与客户端同区）。 */
export function localDateOf(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type Statement = ReturnType<DatabaseSync["prepare"]>;

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
 * 服务端读取某天对话文本（无头 worker recording + agent summarize_conversation 工具共用）。
 * 唯一来源：服务端 agent 持久会话 data/agent-sessions/<parentId>/<childId>-<slot>/
 * （9/12 迁移后客户端不再同步会话，所有孩子对话真实落盘于此，slot = main / scene / course-*）。
 * 当天无会话返回空串。
 */
export function readServerDailyConversation(
  dataDir: string,
  parentId: string,
  childId: string,
  date: string
): string {
  const [y, m, d] = date.split("-").map(Number);
  const start = new Date(y, m - 1, d).getTime();
  const end = start + 24 * 3600 * 1000;

  // 服务端 agent 会话（扫描 <cid>-<slot> 目录，slot=main/scene/course-*）
  const agentRoot = path.join(dataDir, "agent-sessions", parentId);
  const agentDirs: string[] = [];
  if (fs.existsSync(agentRoot)) {
    for (const e of fs.readdirSync(agentRoot, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith(`${childId}-`)) {
        agentDirs.push(path.join(agentRoot, e.name));
      }
    }
  }

  const msgs = collectDailyMessages(agentDirs, start, end);
  msgs.sort((a, b) => a.ts - b.ts);
  return msgs.map((m) => `${m.role === "user" ? "孩子" : "饺子"}: ${m.text}`).join("\n\n");
}

/**
 * 服务端回看索引（9/12 迁移后唯一真源，替代原客户端同步写入）：
 * 扫描 data/agent-sessions/<parentId>/<childId>-<slot>/*.jsonl，把新增的 user/assistant 消息
 * 增量写入 server.sqlite 的 session_messages，供家长端「对话回顾」页读取。
 * 幂等：复用 session_files 游标（按 child_id+file 记 line_count），仅处理游标之后的行；
 * indexMessageLine 本身 INSERT OR REPLACE（主键 child_id+file+line_index），重复索引安全。
 */
export function indexAgentSessionsIntoDb(
  db: DatabaseSync,
  dataDir: string,
  parentId: string,
  childId: string
): void {
  const agentRoot = path.join(dataDir, "agent-sessions", parentId);
  if (!fs.existsSync(agentRoot)) return;
  const dirs: string[] = [];
  for (const e of fs.readdirSync(agentRoot, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith(`${childId}-`)) {
      dirs.push(path.join(agentRoot, e.name));
    }
  }
  if (dirs.length === 0) return;

  const insert = db.prepare(
    `INSERT OR REPLACE INTO session_messages
       (child_id, file, line_index, ts, date, role, text, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const getCursor = db.prepare(
    "SELECT line_count FROM session_files WHERE child_id = ? AND file = ?"
  );
  const setCursor = db.prepare(
    `INSERT INTO session_files (child_id, file, synced_bytes, line_count, updated)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(child_id, file) DO UPDATE SET
       synced_bytes = excluded.synced_bytes,
       line_count = excluded.line_count,
       updated = excluded.updated`
  );

  for (const dir of dirs) {
    const files: string[] = [];
    const collect = (cur: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) collect(full);
        else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(full);
      }
    };
    collect(dir);

    for (const f of files) {
      const fileKey = path.relative(agentRoot, f).split(path.sep).join("/");
      const lineCount =
        (getCursor.get(childId, fileKey) as { line_count: number } | undefined)?.line_count ?? 0;
      let rawLines: string[];
      try {
        rawLines = fs.readFileSync(f, "utf-8").split("\n").filter(Boolean);
      } catch {
        continue;
      }
      if (rawLines.length <= lineCount) continue;
      const newLines = rawLines.slice(lineCount);
      for (let i = 0; i < newLines.length; i++) {
        indexMessageLine(insert, childId, fileKey, lineCount + i, newLines[i]);
      }
      setCursor.run(childId, fileKey, fs.statSync(f).size, rawLines.length, new Date().toISOString());
    }
  }
}

interface DailyMsg {
  ts: number;
  role: string;
  text: string;
}

/** 从一组目录（递归）收集某天窗口内的 user/assistant 文本消息。 */
function collectDailyMessages(dirs: string[], start: number, end: number): DailyMsg[] {
  const msgs: DailyMsg[] = [];
  // ISSUE-051：english 课程子会话 jsonl 在子目录（english-<title>/），需递归收集
  const files: string[] = [];
  const collect = (cur: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) collect(full);
      else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(full);
    }
  };
  for (const dir of dirs) {
    if (fs.existsSync(dir)) collect(dir);
  }
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    for (const line of fs.readFileSync(f, "utf-8").split("\n").filter(Boolean)) {
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
  return msgs;
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
