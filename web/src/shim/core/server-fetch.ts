/**
 * Web 版服务端通信层（设计方案 §2 #1/#2）：
 * 对齐 electron/lib/server-client.ts 的语义 —— 同路由前缀（/api/v1）、同鉴权
 * （Authorization: Bearer <token>）、同 15s 默认超时、同错误语义：
 *   - 超时（AbortError/TimeoutError）→「响应超时（任务仍在后台执行）」
 *   - 其它网络错误            →「无法连接服务端」
 *   - 非 2xx                   → 透传服务端 JSON body 的 {error} 字段
 *
 * 差异（Web 环境决定）：
 *   - 基址 = localStorage "web.serverBase"，空串 = 同源（dev 期经 Vite proxy /api → 127.0.0.1:8788；
 *     服务端无 CORS，跨源直连不可行）；Electron 版未配置地址会显式报错，Web 版同源是合法默认。
 *   - token/许可持久化在 localStorage（web.token / web.license / web.parentId），对齐
 *     electron/lib/auth-manager.ts 的 data/license.json 字段语义。
 */

/** 对齐 ServerError：status = 0 表示网络/配置错误，其余为 HTTP 状态码。 */
export class WebServerError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "WebServerError";
  }
}

// ---------------------------------------------------------------------------
// localStorage 存取（key 语义见文件头注释）
// ---------------------------------------------------------------------------

const LS_KEY_SERVER_BASE = "web.serverBase";
const LS_KEY_TOKEN = "web.token";
const LS_KEY_LICENSE = "web.license";
const LS_KEY_PARENT_ID = "web.parentId";

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式/配额异常时静默（凭证不持久化仅影响下次需重新登录）
  }
}

function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 忽略
  }
}

/** 服务端基址；空串 = 同源。 */
export function getServerBase(): string {
  return (lsGet(LS_KEY_SERVER_BASE) || "").trim();
}

/** 写入服务端基址（传空串 = 回到同源模式）。 */
export function setServerBase(url: string): string {
  const v = (url || "").trim();
  lsSet(LS_KEY_SERVER_BASE, v);
  return v;
}

/** 当前 session token（登录后由服务端签发）。 */
export function getStoredToken(): string {
  return lsGet(LS_KEY_TOKEN) || "";
}

/** 登录态凭证（对齐 electron License 结构：license.json 的 JSON 内容）。 */
export interface WebLicense {
  parent_id: string;
  email: string;
  plan: string;
  max_children: number;
  features: string;
  starts_at: string;
  expires_at: string;
  status: string;
  is_expired: boolean;
  /** 服务端签发的 session token */
  token: string;
  cached_at: string;
}

export function getStoredLicense(): WebLicense | null {
  const raw = lsGet(LS_KEY_LICENSE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WebLicense;
  } catch {
    return null;
  }
}

/** 缓存凭证（对齐 auth-manager.ts cacheLicense + activateParentSession 的持久化面）。 */
export function saveLicense(license: WebLicense): void {
  lsSet(LS_KEY_LICENSE, JSON.stringify(license));
  lsSet(LS_KEY_TOKEN, license.token || "");
  lsSet(LS_KEY_PARENT_ID, license.parent_id || "default");
}

/** 清除凭证（对齐 clearCachedLicense）。 */
export function clearStoredLicense(): void {
  lsRemove(LS_KEY_LICENSE);
  lsRemove(LS_KEY_TOKEN);
  // 与 Electron 一致：登出回到 default 隔离区
  lsSet(LS_KEY_PARENT_ID, "default");
}

/** 当前登录家长 id（对齐 <data>/.session.json 的只读语义）。 */
export function getStoredParentId(): string {
  return lsGet(LS_KEY_PARENT_ID) || "default";
}

// ---------------------------------------------------------------------------
// HTTP 核心
// ---------------------------------------------------------------------------

export interface HttpOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** 覆盖默认 token（缺省读 localStorage web.token；显式传 null/"" 则不带） */
  token?: string | null;
  timeoutMs?: number;
  /** true：直接返回 Response（流式/自定义解析用），不做 JSON 解析与错误翻译 */
  raw?: boolean;
  headers?: Record<string, string>;
}

/**
 * 把 fetch 层异常翻译成语义化提示 —— 逐字对齐 electron/lib/server-client.ts 的
 * describeFetchError：超时与「真连不上」必须区分，避免长任务被误报成断连。
 */
function describeFetchError(err: unknown, timeoutMs: number): string {
  const name = (err as { name?: string })?.name ?? "";
  const msg = ((err as Error)?.message ?? "").toLowerCase();
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    msg.includes("timeout") ||
    msg.includes("aborted")
  ) {
    return `服务端响应超时（等待 ${Math.round(timeoutMs / 1000)} 秒）——长任务通常仍在服务端后台执行，请稍候查看结果，勿重复提交`;
  }
  return "无法连接服务端，请检查服务端地址或网络";
}

/** 组装完整 URL：base 为空 → 同源相对路径（dev 经 Vite proxy）。 */
export function apiUrl(path: string): string {
  const base = getServerBase();
  return `${base}/api/v1${path}`;
}

/**
 * 材料 id 编解码（Phase 3）：与 Electron 端（electron/lib/media-protocol.ts）及服务端
 * （server/src/db/materials.ts encodeMaterialId）一致的 base64url(相对 materials 根的 posix 路径)。
 * 供 materials/parent 域与渲染层 web 分支（doc 网关 URL 拼接）共用。
 */
export function encodeMaterialId(relPosix: string): string {
  const bytes = new TextEncoder().encode(relPosix);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 非 2xx → WebServerError（透传服务端 {error} 字段）。 */
async function raiseHttpError(res: Response): Promise<never> {
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
  throw new WebServerError(res.status, detail);
}

async function request(path: string, opts: HttpOptions, defaultTimeoutMs: number): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined && !(opts.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  const token = opts.token !== undefined ? opts.token : getStoredToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: opts.method ?? "GET",
      headers,
      body:
        opts.body === undefined
          ? undefined
          : opts.body instanceof FormData
            ? opts.body
            : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new WebServerError(0, describeFetchError(e, timeoutMs));
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) await raiseHttpError(res);
  return res;
}

/** JSON 请求（对齐 serverFetch）。raw: true 时返回原始 Response。 */
export async function http<T = unknown>(path: string, opts: HttpOptions = {}): Promise<T> {
  const res = await request(path, opts, 15000);
  if (opts.raw) return res as unknown as T;
  return (await res.json()) as T;
}

/** 二进制下载（对齐 serverFetchBinary，默认 60s 超时）。 */
export async function httpBinary(path: string, opts: HttpOptions = {}): Promise<ArrayBuffer> {
  const res = await request(path, opts, 60000);
  return await res.arrayBuffer();
}

/** multipart 上传（对齐 serverUploadFile，默认 120s 超时）。 */
export async function uploadMultipart<T = unknown>(
  path: string,
  file: Blob | File,
  fields: Record<string, string> = {},
  opts: { timeoutMs?: number; token?: string | null } = {}
): Promise<T> {
  const form = new FormData();
  form.append("file", file, file instanceof File ? file.name : "upload.bin");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await request(
    path,
    { method: "POST", body: form, token: opts.token, timeoutMs: opts.timeoutMs ?? 120000 },
    120000
  );
  return (await res.json()) as T;
}
