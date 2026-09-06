/**
 * 客户端统一应用日志（ISSUE-044：客户端 + 服务端统一日志系统）
 *
 * 背景：打包 app 的 console.* 只打 stdout、不落盘，远程 Mac/Ubuntu 客户端拿不到，
 * 出问题难定位是哪一端、哪个环节。本模块提供一份持久化、结构化、可导出取回的
 * 中央日志，并可选把 console.* 与进程级异常重定向进来，避免「崩得无声」。
 *
 * 落点：data/client-log.jsonl（全局，append-only，行数 + 体积双上限轮转）。
 * 每行一条 JSON（见 ClientLogEntry）。
 *
 * 隐私红线：绝不记录 prompt/消息正文、auth token、密钥——本 logger 只收调用方
 * 显式传入的字符串与结构化字段，不偷窥任何业务内容。
 */
import fs from "fs";
import path from "path";
import { getDataDir } from "./config";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface ClientLogEntry {
  ts: string; // ISO
  level: LogLevel;
  scope: "client";
  component: string; // 模块标签：main / ipc / pi-session / sync / scheduler / kb-lint / mac 等
  msg: string;
  childId?: string;
  parentId?: string;
  reqId?: string;
  err?: string; // 错误堆栈
  durMs?: number; // 耗时
  [k: string]: unknown; // 允许额外结构字段（长度/数量等，不含正文）
}

/** 日志保留上限（行）。超出行数截断保留最近 N 行，避免无限膨胀。 */
export const MAX_LOG_LINES = 5000;
/** 触发轮转的体积粗略阈值（字节）。体积超限且行数过多时收缩。 */
const MAX_LOG_BYTES = 20 * 1024 * 1024;

function logPath(): string {
  return path.join(getDataDir(), "client-log.jsonl");
}

let consoleRedirected = false;
let crashHandlersInstalled = false;
/** installConsoleRedirect 捕获的原始 console.error，供 crash handler 回显真实栈（避免被自身重定向吞掉）。 */
let origConsoleError: (...args: unknown[]) => void = () => {};

/* ------------------------------------------------------------------ *
 *  低层写入（复制 sync-logger 的 append + prune + 吞异常范式）
 * ------------------------------------------------------------------ */

function appendEntry(entry: ClientLogEntry): void {
  try {
    const p = logPath();
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
    if (stat.size < MAX_LOG_BYTES) return; // 体积未超则不读文件
    const lines = fs.readFileSync(p, "utf-8").split("\n");
    if (lines.length <= MAX_LOG_LINES + 1) return;
    fs.writeFileSync(p, lines.slice(-MAX_LOG_LINES).join("\n"), "utf-8");
  } catch {
    /* 清理失败不影响主流程 */
  }
}

function baseEntry(level: LogLevel, component: string): ClientLogEntry {
  return { ts: new Date().toISOString(), level, scope: "client", component, msg: "" };
}

/* ------------------------------------------------------------------ *
 *  对外 API
 * ------------------------------------------------------------------ */

export function log(level: LogLevel, component: string, msg: string, meta: Partial<ClientLogEntry> = {}): void {
  appendEntry({ ...baseEntry(level, component), msg, ...meta });
}
export function logInfo(component: string, msg: string, meta: Partial<ClientLogEntry> = {}): void {
  log("INFO", component, msg, meta);
}
export function logWarn(component: string, msg: string, meta: Partial<ClientLogEntry> = {}): void {
  log("WARN", component, msg, meta);
}
export function logError(component: string, msg: string, meta: Partial<ClientLogEntry> = {}): void {
  log("ERROR", component, msg, meta);
}

/** 读取最近 limit 条日志（尾部截取，忽略坏行）。 */
export function getClientLog(limit = 200): ClientLogEntry[] {
  try {
    const p = logPath();
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean);
    const out: ClientLogEntry[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line) as ClientLogEntry);
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
export function readClientLogFile(): string {
  try {
    const p = logPath();
    if (!fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 *  console.* 重定向 + 进程级异常捕获
 * ------------------------------------------------------------------ */

/**
 * 把 console.log/warn/error/debug 接到本日志（写 client-log.jsonl + 仍回显 stdout）。
 * 必须在主进程早期调用一次（幂等）。
 */
export function installConsoleRedirect(): void {
  if (consoleRedirected) return;
  consoleRedirected = true;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  origConsoleError = console.error.bind(console);
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
    origConsoleError(...args);
    appendEntry({
      ...baseEntry("ERROR", "console"),
      msg: stringifyArgs(args),
      err: firstErrorStack(args),
    });
  };
}

/** 捕获未捕获异常 / 未处理 rejection，写 ERROR 级，防崩无声。可选退出码。 */
export function installCrashHandlers(exitOnUncaught = true): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;

  process.on("uncaughtException", (err) => {
    appendEntry({
      ...baseEntry("ERROR", "crash"),
      msg: "uncaughtException",
      err: err?.stack ?? (err as Error)?.message ?? String(err),
    });
    origConsoleError("uncaughtException:", err);
    if (exitOnUncaught) process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    appendEntry({
      ...baseEntry("ERROR", "crash"),
      msg: "unhandledRejection",
      err: err?.stack ?? err?.message,
    });
    origConsoleError("unhandledRejection:", reason);
  });
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
