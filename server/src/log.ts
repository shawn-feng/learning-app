/**
 * 服务端统一日志（ISSUE-044：客户端 + 服务端统一日志系统）
 *
 * 背景：Fastify({logger:true}) 只打 stdout；worker/providers/tasks 用裸 console.*。
 * 201 无头 worker 跑在 systemd 下 stdout 未必可靠留存，远程难取证。本模块提供
 * 一份持久化、结构化 JSONL 落盘，供 `tail -f data/logs/server-log.jsonl` 远程取回。
 *
 * 落点：SERVER_DATA_DIR/logs/server-log.jsonl（append-only，行数 + 体积双上限轮转）。
 * 每行一条 JSON（见 ServerLogEntry）。
 *
 * 设计：不用 pino transport（依赖 worker 线程，esbuild 单文件打包 + pkg 部署下易断），
 * 直接 appendFileSync，与客户端 app-logger 对称。日志绝不影响主流程（吞异常）。
 */
import fs from "node:fs";
import path from "node:path";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface ServerLogEntry {
  ts: string; // ISO
  level: LogLevel;
  scope: "server";
  component: string; // http / worker / scheduler / task / provider / db / auth / boot
  msg: string;
  childId?: string;
  parentId?: string;
  taskType?: string; // worker 任务类型
  reqId?: string;
  method?: string;
  path?: string;
  status?: number;
  durMs?: number;
  ip?: string;
  err?: string;
  [k: string]: unknown;
}

export const MAX_LOG_LINES = 5000;
const MAX_LOG_BYTES = 20 * 1024 * 1024;

let logDir: string | null = null;
let logFile: string | null = null;

/** 设置日志目录（由 index.ts 在 loadConfig 后调用一次；重复调用覆盖）。 */
export function initServerLog(dataDir: string): void {
  logDir = path.join(dataDir, "logs");
  logFile = path.join(logDir, "server-log.jsonl");
  fs.mkdirSync(logDir, { recursive: true });
}

function filePath(): string {
  // 未 init 时兜底到 cwd/data/logs（正常流程总会 init）
  if (!logFile) {
    const fallback = path.join(process.cwd(), "data", "logs");
    fs.mkdirSync(fallback, { recursive: true });
    return path.join(fallback, "server-log.jsonl");
  }
  return logFile;
}

function appendEntry(entry: ServerLogEntry): void {
  try {
    const p = filePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
    pruneLog(p);
  } catch {
    /* 日志绝不应影响主流程 */
  }
}

function pruneLog(p: string): void {
  try {
    if (!fs.existsSync(p)) return;
    const stat = fs.statSync(p);
    if (stat.size < MAX_LOG_BYTES) return;
    const lines = fs.readFileSync(p, "utf-8").split("\n");
    if (lines.length <= MAX_LOG_LINES + 1) return;
    fs.writeFileSync(p, lines.slice(-MAX_LOG_LINES).join("\n"), "utf-8");
  } catch {
    /* ignore */
  }
}

export function log(level: LogLevel, component: string, msg: string, meta: Partial<ServerLogEntry> = {}): void {
  const entry: ServerLogEntry = { ts: new Date().toISOString(), level, scope: "server", component, msg, ...meta };
  appendEntry(entry);
}
export function logInfo(component: string, msg: string, meta: Partial<ServerLogEntry> = {}): void {
  log("INFO", component, msg, meta);
}
export function logWarn(component: string, msg: string, meta: Partial<ServerLogEntry> = {}): void {
  log("WARN", component, msg, meta);
}
export function logError(component: string, msg: string, meta: Partial<ServerLogEntry> = {}): void {
  log("ERROR", component, msg, meta);
}

/** 读取最近 limit 条（尾部，忽略坏行）。 */
export function getServerLog(limit = 200): ServerLogEntry[] {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return [];
    const out: ServerLogEntry[] = [];
    for (const line of fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).slice(-limit)) {
      try {
        out.push(JSON.parse(line) as ServerLogEntry);
      } catch {
        /* ignore bad line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 *  console.* 重定向（对称客户端：worker/routes 裸 console 统一落盘）
 * ------------------------------------------------------------------ */

let consoleRedirected = false;

/**
 * 把 console.log/warn/error/debug 接到本文件日志（仍回显 stdout），幂等。
 * 在 initServerLog 后、worker/routes 开始打印前调用一次即可。
 */
export function installServerConsoleRedirect(): void {
  if (consoleRedirected) return;
  consoleRedirected = true;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr = console.error.bind(console);
  const origDebug = console.debug.bind(console);

  console.debug = (...args: unknown[]) => {
    origDebug(...args);
  };
  console.log = (...args: unknown[]) => {
    origLog(...args);
    appendEntry({ ...baseEntry("INFO", "console"), msg: stringifyArgs(args) });
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    appendEntry({ ...baseEntry("WARN", "console"), msg: stringifyArgs(args) });
  };
  console.error = (...args: unknown[]) => {
    origErr(...args);
    appendEntry({
      ...baseEntry("ERROR", "console"),
      msg: stringifyArgs(args),
      err: firstErrorStack(args),
    });
  };
}

function baseEntry(level: LogLevel, component: string): ServerLogEntry {
  return { ts: new Date().toISOString(), level, scope: "server", component, msg: "" };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        const s = JSON.stringify(a);
        return s === undefined ? String(a) : s;
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function firstErrorStack(args: unknown[]): string | undefined {
  for (const a of args) {
    if (a instanceof Error && a.stack) return a.stack;
  }
  return undefined;
}
