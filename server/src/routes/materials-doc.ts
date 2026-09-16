/**
 * 文档网关（Web 前端 Phase 0，附加式）：
 *  - GET /api/v1/materials/doc/:id?token=&font=
 *    读 html 材料 → 跟随 <meta http-equiv=refresh> 占位跳转 → 相对资源改写为
 *    /api/v1/materials/content/<base64url(相对路径)>?token= 绝对 URL → 注入 PiBridge 桥脚本
 *    → text/html 返回。纯浏览器 Web 前端据此在 iframe 里用真实 URL 加载学习资料文档。
 *
 * 渲染管线对齐 electron/lib/material-doc.ts（fetchMaterialContent → followHtmlRedirectRemote
 * → rewriteMaterialHtmlForRender → injectBridge）；桥脚本复用根项目 src/lib/page-bridge.ts 的
 * injectBridge 纯函数（该文件零 import、无渲染层依赖，可在服务端直接引用；勿向其引入 React）。
 *
 * 与 Electron 版的两处刻意差异：
 * 1. 不注入 <base>：content 路由的 :id 是单段 base64url，无法表达「目录」语义（相对 URL 解析
 *    会整段替换最后一段），base 注入对 Web 无效；静态 src/href 引用已全部改写为绝对 content URL，
 *    仅「课程 JS 运行期动态拼接的相对路径」（如英语音标页 'emma/'+x+'.mp4'）在 Phase 0 不支持
 *    （Electron 版靠 media:// base 解决）。
 *    ▶ 2026-09-16 已补齐：新增目录前缀路由 GET /materials/p/:token/*（见下方 page 路由），
 *      <base> 指向文档所在目录，静态与动态拼接的相对路径全部正确解析。
 * 2. 相对引用不再要求「落在 主题/... 之下」：content 路由服务 materials 根下任意文件，无
 *    asset/media 协议白名单分层；越出 materials 根（../）的引用仍不改写（与 Electron 越界不跟一致）。
 *
 * page 路由（GET /api/v1/materials/p/:token/*，2026-09-16）：
 *  - token 在**路径**里：课程 JS 运行期动态拼接的媒体请求（video.src='emma/x.mp4'）既带不了
 *    Authorization 头也不会继承 base 的 query，只有路径段能跟随相对解析自动携带凭证。
 *  - html：跟随 meta refresh → 注 <base href=".../p/<token>/<dir>/"> + 注桥 → text/html。
 *    静态 src/href 同时改写为 content 绝对 URL（双保险，绝对 URL 不受 base 影响）。
 *  - 非 html：磁盘直读流式返回（MIME/Range/206 语义与 content 路由逐行对齐——**该表为副本，
 *    修改 MIME/Range 行为时两处需同步**），按磁盘定位不查 materials 索引（对齐 Electron
 *    asset:// 协议直读语义，resolveSafe 保证不越出该家长 materials 根）。
 *  - token 经 URL 传递会进入访问日志（与 content/doc 路由的 ?token= 同一暴露面，本机部署场景可接受）。
 */
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { encodeMaterialId, materialsRoot } from "../db/materials.js";
import { injectBridge } from "../../../src/lib/page-bridge.js";

interface MaterialDocDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

/**
 * 宽松认证（与 materials/files 的 GET 二进制路由同规则）：Authorization 头优先，无头时回退
 * ?token= query（浏览器 iframe 无法携带自定义请求头）。
 */
function authParentFlexible(
  req: { headers: Record<string, string | string[] | undefined>; query?: unknown },
  secret: string
): string {
  const header = req.headers.authorization;
  let token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) {
    const q = (req.query ?? {}) as { token?: unknown };
    token = typeof q.token === "string" ? q.token.trim() : "";
  }
  if (!token) throw new ApiError(401, "缺少 session token");
  try {
    return verifySession(token, secret).parent_id;
  } catch {
    throw new ApiError(401, "session 无效或已过期，请重新登录");
  }
}

/** 解析相对路径并校验落在材料根目录内（防目录穿越，与 materials.ts 的 resolveSafe 一致）。 */
function resolveSafe(root: string, relPosix: string): string {
  const abs = path.resolve(root, relPosix);
  if (!abs.startsWith(path.resolve(root) + path.sep)) {
    throw new ApiError(403, "非法路径");
  }
  return abs;
}

/** 读材料相对路径的文本内容（utf-8）；不存在/越界/不可读返回 null。 */
function readMaterialText(root: string, relPosix: string): string | null {
  let abs: string;
  try {
    abs = resolveSafe(root, relPosix);
  } catch {
    return null;
  }
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return fs.readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

/** 提取 <meta http-equiv="refresh" content="0; url=..."> 中的 url 目标；无则返回 null。
 *  移植自 electron/lib/parent-library.ts extractRedirectTarget，保持一致。 */
function extractRedirectTarget(html: string): string | null {
  const metaRe = /<meta[^>]*http-equiv=["']?refresh["']?[^>]*>/i;
  const m = html.match(metaRe);
  if (!m) return null;
  const c = m[0].match(/content=["']([^"']+)["']/i);
  if (!c) return null;
  const u = c[1].match(/url\s*=\s*([^\s"']+)/i);
  return u ? u[1] : null;
}

/**
 * 磁盘版跟随 <meta http-equiv="refresh"> 相对跳转（移植自 electron/lib/parent-library.ts
 * followHtmlRedirectRemote）：最多 8 跳、visited 防环；仅跟随落在 materials 根内的
 * 相对 .html/.htm 目标，越界/无效时原样返回 startRel。
 */
function followHtmlRedirectOnDisk(root: string, startRel: string, startContent: string): { rel: string; content: string } {
  let curRel = startRel;
  let content = startContent;
  const visited = new Set<string>([startRel]);
  for (let i = 0; i < 8; i++) {
    const target = extractRedirectTarget(content);
    if (!target) break;
    const clean = target.split(/[?#]/)[0];
    if (!clean) break;
    const nextRel = path.posix.normalize(path.posix.join(path.posix.dirname(curRel), clean));
    if (nextRel === ".." || nextRel.startsWith("../")) break; // 越界不跟
    if (visited.has(nextRel)) break;
    if (!/\.(html|htm)$/i.test(nextRel)) break;
    visited.add(nextRel);
    const next = readMaterialText(root, nextRel);
    if (next === null) break;
    curRel = nextRel;
    content = next;
  }
  return { rel: curRel, content };
}

/**
 * 把 html 内 href/src 上的相对资源引用改写为 content 路由绝对 URL（Web 版 rewriteMaterialHtmlForRender）。
 * 另处理 Electron 协议 URL 固化（2026-09-16）：资料生成时把音视频写成
 * `media://local/parent/<default|parentId>/<topic>/media/<file>`——浏览器无法加载该 scheme，
 * <base> 对带 scheme 的绝对 URL 也不生效。此处提取 rest（materials 相对路径）改写为 page 路由
 * 绝对 URL（磁盘定位不依赖 materials 索引；路径段逐段编码，支持中文文件名）。
 * 跳过规则对齐 Electron 版 rewriteHtmlAssetRefs：其余任意 scheme（http/https/data…）、//、#锚点、
 * data:/blob:/mailto:、绝对路径不改写；解析后越出 materials 根（../）不改写。
 * 原 query/hash 后缀保留。
 */
function rewriteRefsToContentUrls(html: string, fileDir: string, token: string): string {
  const RE = /(\b(?:href|src)\s*=\s*["'])([^"']+?)(["'])/gi;
  return html.replace(RE, (m, pre: string, val: string, post: string) => {
    const trimmed = val.trim();
    // Electron media:// 协议 URL → page 路由（磁盘直读，Range 可用）
    const mediaM = trimmed.match(/^media:\/\/local\/parent\/[^/]+\/(.+)$/i);
    if (mediaM) {
      let rest: string;
      try {
        rest = decodeURIComponent(mediaM[1]);
      } catch {
        rest = mediaM[1];
      }
      const encToken = encodeURIComponent(token);
      const segs = rest
        .split("/")
        .map((s) => encodeURIComponent(s))
        .join("/");
      return pre + `/api/v1/materials/p/${encToken}/${segs}` + post;
    }
    if (
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || // 任何 scheme（http/https/media/data…）
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:") ||
      trimmed.startsWith("mailto:") ||
      path.posix.isAbsolute(trimmed)
    ) {
      return m;
    }
    // 拆分 query/hash（如有）并保留
    let core = trimmed;
    let suffix = "";
    const qIdx = core.search(/[?#]/);
    if (qIdx >= 0) {
      suffix = core.slice(qIdx);
      core = core.slice(0, qIdx);
    }
    if (!core) return m;
    // 相对文档所在目录解析（posix 语义；材料相对路径统一 posix）
    let rel: string;
    try {
      rel = path.posix.normalize(path.posix.join(fileDir === "." ? "" : fileDir, core));
    } catch {
      return m;
    }
    if (!rel || rel === "." || rel === ".." || rel.startsWith("../")) return m; // 越出材料根不改写
    const url = `/api/v1/materials/content/${encodeMaterialId(rel)}?token=${encodeURIComponent(token)}`;
    if (suffix.startsWith("?")) suffix = "&" + suffix.slice(1);
    return pre + url + suffix + post;
  });
}

export function registerMaterialDocRoutes(app: FastifyInstance, deps: MaterialDocDeps): void {
  app.get("/api/v1/materials/doc/:id", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParentFlexible(req, deps.config.jwtSecret);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    const query = (req.query ?? {}) as { token?: unknown; font?: unknown };
    const token = typeof query.token === "string" ? query.token.trim() : "";
    // 子资源改写需把 token 拼进 content URL（浏览器标签带不了头）→ 网关强制要求 ?token=
    if (!token) {
      return reply.code(400).send({ error: "doc 网关需要 ?token=（资源改写需把 session token 拼入子资源 URL）" });
    }

    const { id } = req.params as { id: string };
    // 与 content 路由同编码：id = base64url(相对路径)（Buffer.from 对非法输入不抛错，产出乱码路径 → 下面扩展名校验兜底）
    const relPosix = Buffer.from(id, "base64url").toString("utf-8");
    if (!/\.(html|htm)$/i.test(relPosix)) {
      return reply.code(400).send({ error: "doc 网关仅接受 .html/.htm 材料" });
    }
    // 归属校验与 content 路由一致：按 (id, parent_id) 查索引（Electron 端 fetchMaterialContent 亦经 content 路由，同语义）
    const row = deps.db
      .prepare("SELECT path FROM materials WHERE id = ? AND parent_id = ?")
      .get(id, parentId) as { path: string } | undefined;
    if (!row) return reply.code(404).send({ error: "材料不存在" });

    const root = materialsRoot(deps.config.dataDir, parentId);
    const raw = readMaterialText(root, row.path);
    if (raw === null) return reply.code(404).send({ error: "材料文件不存在" });

    // 1) 跟随 <meta http-equiv=refresh> 占位跳转（与 material-doc.ts 相同：占位页落到真实 html）
    let finalRel = row.path;
    let content = raw;
    if (/http-equiv\s*=\s*["']?refresh/i.test(content)) {
      const jumped = followHtmlRedirectOnDisk(root, finalRel, content);
      if (jumped.rel !== finalRel) {
        finalRel = jumped.rel;
        content = jumped.content;
      }
    }

    // 2) 相对资源 → content 绝对 URL（携带 token；音视频同路由，Range 天然可用）
    const fileDir = path.posix.dirname(finalRel);
    const rewritten = rewriteRefsToContentUrls(content, fileDir, token);

    // 3) 注入 PiBridge 桥脚本（与 material-doc.ts 一致：font 经 injectBridge 写入 window.__PI_MAT_FONT 初始值）
    const fontPx = Number.parseInt(String(query.font ?? ""), 10);
    const html = injectBridge(rewritten, Number.isFinite(fontPx) && fontPx >= 8 ? fontPx : undefined);

    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    return reply.send(html);
  });

  // ── 目录前缀路由：/materials/p/:token/*（2026-09-16，修复课程动态拼接媒体无法播放）──
  // 非 html 分支的 MIME 表为 content 路由（materials.ts）的副本，两处需同步维护。
  const PAGE_MIME: Record<string, string> = {
    html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
    css: "text/css", js: "text/javascript", json: "application/json",
    md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
    aac: "audio/aac", flac: "audio/flac",
    mp4: "video/mp4", webm: "video/webm",
    pdf: "application/pdf",
  };

  app.get("/api/v1/materials/p/:token/*", async (req, reply) => {
    const params = req.params as { token?: string; "*": string };
    const query = (req.query ?? {}) as { font?: unknown };
    // 认证：Authorization 头优先（同源 fetch 场景），无头回退路径段 token（iframe/媒体标签场景）
    let parentId: string;
    const header = req.headers.authorization;
    const headerToken = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
    try {
      if (headerToken) {
        parentId = verifySession(headerToken, deps.config.jwtSecret).parent_id;
      } else {
        if (!params.token) throw new ApiError(401, "缺少 session token");
        parentId = verifySession(params.token, deps.config.jwtSecret).parent_id;
      }
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      return reply.code(401).send({ error: "session 无效或已过期，请重新登录" });
    }

    // 通配段即材料相对路径（Fastify 已做一次 URL 解码；posix 语义，与索引 path 一致）
    const relPosix = path.posix.normalize(String(params["*"] ?? "").replace(/\\/g, "/"));
    if (!relPosix || relPosix === "." || relPosix.startsWith("..")) {
      return reply.code(403).send({ error: "非法路径" });
    }
    // 页面内相对跳转/拼接以当前目录为 base：目录形态请求（无扩展名）不是合法材料，直接 404
    const root = materialsRoot(deps.config.dataDir, parentId);

    const ext = path.extname(relPosix).toLowerCase().replace(".", "");
    if (ext === "html" || ext === "htm") {
      // ── 文档分支：跟随 refresh → 改写 + base + 注桥（对齐 doc 网关管线，base 为新增）──
      const raw = readMaterialText(root, relPosix);
      if (raw === null) return reply.code(404).send({ error: "材料文件不存在" });
      let finalRel = relPosix;
      let content = raw;
      if (/http-equiv\s*=\s*["']?refresh/i.test(content)) {
        const jumped = followHtmlRedirectOnDisk(root, finalRel, content);
        if (jumped.rel !== finalRel) {
          finalRel = jumped.rel;
          content = jumped.content;
        }
      }
      // 静态 src/href → content 绝对 URL（绝对 URL 不受 base 影响；动态拼接交给下面的 base）
      const pathToken = headerToken || params.token || "";
      const fileDir = path.posix.dirname(finalRel);
      const rewritten = rewriteRefsToContentUrls(content, fileDir, pathToken);
      // <base> = 本路由的文档目录：JS 运行期拼接的相对路径（'emma/x.mp4'）据此解析，
      // 相对请求自动携带路径段 token（动态请求带不了 query/头）。
      const baseDir = fileDir === "." ? "" : `/${fileDir}`;
      const baseHref = `/api/v1/materials/p/${encodeURIComponent(pathToken)}${baseDir}/`;
      const baseTag = `<base href="${baseHref}">`;
      let withBase: string;
      if (/<head[^>]*>/i.test(rewritten)) {
        withBase = rewritten.replace(/<head[^>]*>/i, (m) => m + baseTag);
      } else if (/<!doctype[^>]*>/i.test(rewritten)) {
        withBase = rewritten.replace(/<!doctype[^>]*>/i, (m) => m + baseTag);
      } else {
        withBase = baseTag + rewritten;
      }
      const fontPx = Number.parseInt(String(query.font ?? ""), 10);
      const html = injectBridge(withBase, Number.isFinite(fontPx) && fontPx >= 8 ? fontPx : undefined);
      reply.header("Content-Type", "text/html; charset=utf-8");
      reply.header("Cache-Control", "no-store");
      return reply.send(html);
    }

    // ── 子资源分支：磁盘直读流式（MIME/Range 与 content 路由逐行对齐）──
    let abs: string;
    try {
      abs = resolveSafe(root, relPosix);
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return reply.code(404).send({ error: "材料文件不存在" });
    }
    const size = fs.statSync(abs).size;
    reply.header("Content-Type", PAGE_MIME[ext] ?? "application/octet-stream");
    reply.header("Accept-Ranges", "bytes");
    reply.header("Cache-Control", "no-store");
    const range = typeof req.headers.range === "string" ? req.headers.range : "";
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (start >= size || start > end) {
        return reply.code(416).header("Content-Range", `bytes */${size}`).send();
      }
      end = Math.min(end, size - 1);
      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
      reply.header("Content-Length", String(end - start + 1));
      return reply.send(fs.createReadStream(abs, { start, end }));
    }
    reply.header("Content-Length", String(size));
    return reply.send(fs.createReadStream(abs));
  });
}
