import { protocol } from "electron";
import path from "path";
import { getServerUrl } from "./config";
import { currentSessionToken } from "./client-data";

// media:// + asset:// 协议：把沙盒 iframe(srcDoc，来源 about:blank) 里的音视频/资源引用
// 映射到**服务端**材料（SPLIT 方案 A：无本地缓存，全部远程直取）。
//
// URL 格式（父库共享，与 childId 解耦，单一真源）：
//   media://local/parent/{parentId}/{topic}/media/{文件}
//   asset://local/parent/{parentId}/{topic}/{rel...}
//     → 服务端 /api/v1/materials/content/{id}（id = base64url(相对 materials 根的路径)）
// 注意：standard scheme 下 'local' 是 host（不在 pathname 里），pathname 从 /parent/... 开始。
// URL 里的 parentId 仅为占位（服务端按 session token 的 parent_id 路由，客户端不据此取路径）。
const ALLOWED_EXT = new Set([
  ".mp3", ".mp4", ".ogg", ".wav", ".webm", ".m4a", ".aac", ".flac", ".m3u8",
]);

const ASSET_ALLOWED_EXT = new Set([
  ".css", ".js", ".mjs", ".cjs",
  ".html", ".htm",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".json", ".map", ".txt",
]);

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css", js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript",
  json: "application/json", map: "application/json", txt: "text/plain; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
  mp3: "audio/mpeg", mp4: "video/mp4", ogg: "audio/ogg", wav: "audio/wav",
  webm: "video/webm", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", m3u8: "application/vnd.apple.mpegurl",
};

function mimeFor(rel: string): string {
  const ext = path.extname(rel).toLowerCase().replace(".", "");
  return MIME[ext] ?? "application/octet-stream";
}

/** 与客户端/服务端一致的 material id：base64url(相对 materials 根的 posix 路径)。 */
function encodeMaterialId(relPosix: string): string {
  return Buffer.from(relPosix, "utf-8").toString("base64url");
}

/** 从服务端拉取材料文件（二进制），带 session token。 */
export async function fetchMaterialContent(relPosix: string): Promise<Buffer> {
  const base = getServerUrl();
  if (!base) throw new Error("未配置服务端地址");
  const token = currentSessionToken();
  const id = encodeMaterialId(relPosix);
  const res = await fetch(`${base}/api/v1/materials/content/${id}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`材料获取失败 (HTTP ${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 远程代理：把协议请求转发到服务端材料 content 接口。
 * - **转发 Range 头**（video 播放/seek、moov 尾部 metadata 加载的关键，Chromium 发 Range 期望 206）；
 * - **流式透传响应体**（大视频不再全量 arrayBuffer 进内存）；
 * - 转发服务端状态码（200/206/416）+ Content-Range/Content-Length，Content-Type 用本地 MIME 表。
 */
async function proxyMaterial(relPosix: string, request: Request): Promise<Response> {
  const base = getServerUrl();
  if (!base) return new Response("server not configured", { status: 503 });
  const token = currentSessionToken();
  const id = encodeMaterialId(relPosix);
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const range = request.headers.get("range");
  if (range) headers["Range"] = range;
  const upstream = await fetch(`${base}/api/v1/materials/content/${id}`, { headers });
  const out = new Headers();
  out.set("Content-Type", mimeFor(relPosix));
  // 上游关键响应头透传（服务端重启后 Range 生效，返回 206 + Content-Range；未生效时 200 全量流式）
  const cr = upstream.headers.get("content-range");
  if (cr) out.set("Content-Range", cr);
  const cl = upstream.headers.get("content-length");
  if (cl) out.set("Content-Length", cl);
  out.set("Accept-Ranges", "bytes");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

/**
 * 解析 media:// URL 的 pathname 为材料相对路径（posix，相对 materials/<parentId>/ 根）。
 * 返回 null 表示格式非法 / 目录穿越 / 扩展名不在白名单。
 * @param pathname 如 `/parent/default/lunyu/media/论语.mp3`
 */
export function resolveMediaTarget(pathname: string): string | null {
  const segs = decodeURIComponent(pathname).replace(/^\/+/, "").split("/").filter(Boolean);
  if (segs.length < 2 || segs[0] !== "parent" || segs.length < 4) return null;
  const parentId = segs[1];
  if (!parentId || parentId.includes("..") || parentId.includes("\\")) return null;
  const topic = segs[2];
  const rest = segs.slice(3).join("/");
  if (!rest || rest.includes("..") || rest.includes("\\")) return null;
  const rel = `${topic}/${rest}`;
  if (!ALLOWED_EXT.has(path.extname(rel).toLowerCase())) return null;
  return rel;
}

// 必须在 app ready 之前调用且只能调用一次（Electron 要求 registerSchemesAsPrivileged
// 合并注册全部自定义 scheme，多次调用会互相覆盖导致部分 scheme 丢失特权）。
export function registerCustomSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: "asset", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    // app://bundle/... = 生产渲染层顶层（替代 file://）：标准+secure scheme 让顶层有真实源，
    // Chromium 的 Permissions-Policy 默认 allowlist 'self' 才能匹配到考试 iframe（srcdoc 同源继承），
    // 否则 Linux(Chromium143) 下 file:// 顶层的无源 iframe 一律被拒 getUserMedia（见 main.ts 注释）。
    { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
  ]);
}

export function registerMediaProtocol(): void {
  protocol.handle("media", async (request) => {
    try {
      const url = new URL(request.url);
      const rel = resolveMediaTarget(url.pathname);
      if (!rel) return new Response("forbidden", { status: 403 });
      return await proxyMaterial(rel, request);
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

/**
 * 解析 asset:// URL 的 pathname 为材料相对路径（posix）。
 * URL 形如 asset://local/parent/{parentId}/{topic}/{rel...}；standard scheme 下
 * 'local' 是 host（不在 pathname 里），pathname 从 /parent/... 开始（与 media:// 同理）。
 */
export function resolveAssetTarget(pathname: string): string | null {
  const segs = decodeURIComponent(pathname).replace(/^\/+/, "").split("/").filter(Boolean);
  if (segs.length < 4 || segs[0] !== "parent") return null;
  const parentId = segs[1];
  if (!parentId || parentId.includes("..") || parentId.includes("\\")) return null;
  const topic = segs[2];
  if (!topic || topic.includes("..") || topic.includes("\\")) return null;
  const rest = segs.slice(3).join("/");
  if (!rest || rest.includes("..") || rest.includes("\\")) return null;
  const rel = `${topic}/${rest}`;
  const ext = path.extname(rel).toLowerCase();
  if (!ASSET_ALLOWED_EXT.has(ext)) return null;
  return rel;
}

/** 由 (parentId, topic, 相对主题目录的路径) 拼出 asset:// 绝对 URL（纯函数；parentId 仅占位）。 */
export function buildAssetUrl(parentId: string, topic: string, relPathFromTopic: string): string {
  const clean = relPathFromTopic.replace(/\\/g, "/").replace(/^\/+/, "");
  return `asset://local/parent/${parentId}/${topic}/${clean}`;
}

export function registerAssetProtocol(): void {
  protocol.handle("asset", async (request) => {
    try {
      const url = new URL(request.url);
      const rel = resolveAssetTarget(url.pathname);
      if (!rel) return new Response("forbidden", { status: 403 });
      return await proxyMaterial(rel, request);
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

/**
 * app://bundle = 生产渲染层顶层加载（替代 file://，ISSUE-048，2026-09-04）。
 *
 * 为什么需要：Ubuntu(Chromium 143) 下用 loadFile(file://) 加载顶层时，文件 URL 无真实源，
 * Chromium Permissions-Policy 默认 allowlist('self') 匹配不到任何 frame → 考核页
 * srcDoc 沙盒 iframe 里的 getUserMedia 被 policy 直接拒绝（"Permissions policy violation:
 * microphone is not allowed"），即便 sandbox/allow/permission handler 都放行。
 * 用 standard+secure 的 app://bundle 顶层则有真实源：srcdoc iframe 同源继承 'self' 即被允许，
 * 并对顶层文档响应显式注入 Permissions-Policy 头（microphone/camera 允许所有 frame）双保险。
 * 资源路径与文件相对引用兼容：app://bundle/index.html → ./assets/x.js 解析为 app://bundle/assets/x.js。
 */
import fs from "fs";

function rendererDir(): string {
  // production: out/main/index.js → app.asar/out/renderer（asar 内 fs 可读）
  return path.join(__dirname, "..", "renderer");
}

/** 仅允许渲染层 bundle 内的静态资源（防目录穿越）。 */
function resolveBundlePath(pathname: string): string | null {
  const clean = decodeURIComponent(pathname).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.includes("..")) return null;
  const p = path.join(rendererDir(), clean);
  return p.startsWith(rendererDir() + path.sep) ? p : null;
}

export function registerAppProtocol(): void {
  protocol.handle("app", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== "bundle") return new Response("not found", { status: 404 });
      const filePath = resolveBundlePath(url.pathname) ?? path.join(rendererDir(), "index.html");
      const buf = await fs.promises.readFile(filePath);
      const headers = new Headers();
      headers.set("Content-Type", mimeFor(filePath));
      // 顶层文档显式放行 media（对 srcdoc 无源 iframe 也要能采集）
      if (filePath.endsWith(".html")) {
        headers.set("Permissions-Policy", "microphone=*, camera=*");
        // 允许本 app 跨源访问服务端（与 file:// 时代一致：服务端 CORS 已放行）
        headers.set("Access-Control-Allow-Origin", "*");
      }
      return new Response(buf, { headers });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
