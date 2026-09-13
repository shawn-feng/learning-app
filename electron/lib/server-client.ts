/**
 * 服务端通信层（SPLIT 客户端，DESIGN-SPLIT §3）：统一封装对
 * <serverUrl>/api/v1/* 的请求。纯服务端模式：未配置服务端地址时显式报错。
 */
import fs from "fs";
import { getServerUrl } from "./config";

export class ServerError extends Error {
  constructor(
    public status: number, // 0 = 网络/配置错误
    message: string
  ) {
    super(message);
  }
}

/**
 * 把 fetch 层异常翻译成语义化提示（实测踩坑）：AbortSignal.timeout 超时与「真连不上」
 * 都走同一个 catch，过去统一报「无法连接服务端」——agent 长工具轮（summarize 实测 3 分钟+）
 * 超过客户端超时后，明明服务端在正常执行却被误报成断连，家长/孩子都会被误导去重启服务端。
 * 这里区分：超时 → 明确告知是响应超时且任务仍在后台执行；其余 → 才是连接问题。
 */
function describeFetchError(err: unknown, timeoutMs: number): string {
  const name = (err as { name?: string })?.name ?? "";
  const msg = ((err as Error)?.message ?? "").toLowerCase();
  if (name === "TimeoutError" || name === "AbortError" || msg.includes("timeout") || msg.includes("aborted")) {
    return `服务端响应超时（等待 ${Math.round(timeoutMs / 1000)} 秒）——长任务通常仍在服务端后台执行，请稍候查看结果，勿重复提交`;
  }
  return "无法连接服务端，请检查服务端地址或网络";
}

/** 服务端基址；未配置时抛 ServerError（status 0）。 */
export function serverBase(): string {
  const url = getServerUrl();
  if (!url) {
    throw new ServerError(0, "未配置服务端地址，请先在设置中填写服务端地址");
  }
  return url;
}

export interface ServerFetchOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** 服务端 session token（登录后由服务端签发） */
  token?: string;
  timeoutMs?: number;
}

/**
 * 调用服务端 API。非 2xx 抛 ServerError（带 status 与语义化错误）；
 * 网络不可达抛 ServerError(0)。返回 JSON。
 */
export async function serverFetch<T = unknown>(
  path: string,
  opts: ServerFetchOptions = {}
): Promise<T> {
  const base = serverBase();
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  let res: Response;
  try {
    res = await fetch(`${base}/api/v1${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
  } catch (e) {
    throw new ServerError(0, describeFetchError(e, opts.timeoutMs ?? 15000));
  }

  if (!res.ok) {
    let detail = `服务端错误 (HTTP ${res.status})`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object") {
        const b = body as { error?: unknown };
        if (typeof b.error === "string" && b.error) detail = b.error;
      }
    } catch {
      /* 保留默认 detail */
    }
    throw new ServerError(res.status, detail);
  }
  return (await res.json()) as T;
}

/**
 * 二进制下载（ISSUE-003：备份 zip）。返回 Buffer（Node 环境 fetch → arrayBuffer）。
 * 非 2xx 抛 ServerError（语义同 serverFetch）。
 */
export async function serverFetchBinary(path: string, opts: ServerFetchOptions = {}): Promise<Buffer> {
  const base = serverBase();
  const headers: Record<string, string> = {};
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  let res: Response;
  try {
    res = await fetch(`${base}/api/v1${path}`, {
      method: opts.method ?? "GET",
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
    });
  } catch (e) {
    throw new ServerError(0, describeFetchError(e, opts.timeoutMs ?? 60000));
  }

  if (!res.ok) {
    let detail = `服务端错误 (HTTP ${res.status})`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object") {
        const b = body as { error?: unknown };
        if (typeof b.error === "string" && b.error) detail = b.error;
      }
    } catch {
      /* 保留默认 detail */
    }
    throw new ServerError(res.status, detail);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** 上传文件（ISSUE-003：恢复备份 zip，multipart）。 */
export async function serverUploadFile(
  path: string,
  filePath: string,
  token: string,
  opts: { timeoutMs?: number } = {}
): Promise<unknown> {
  const base = serverBase();
  const form = new FormData();
  form.append("file", new Blob([await fs.promises.readFile(filePath)]), "backup.zip");

  let res: Response;
  try {
    res = await fetch(`${base}/api/v1${path}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120000),
    });
  } catch (e) {
    throw new ServerError(0, describeFetchError(e, opts.timeoutMs ?? 120000));
  }
  if (!res.ok) {
    let detail = `服务端错误 (HTTP ${res.status})`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object") {
        const b = body as { error?: unknown };
        if (typeof b.error === "string" && b.error) detail = b.error;
      }
    } catch {
      /* 保留默认 detail */
    }
    throw new ServerError(res.status, detail);
  }
  return (await res.json()) as unknown;
}
