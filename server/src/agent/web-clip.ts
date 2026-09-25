/**
 * KB P3 阶段④：**网页落袋**（2026-09-25）。
 *
 * ## 为什么需要它（方案 §2.2 缺口 B / §5.3）
 * 家长想「只给孩子看这一个网页」，今天两条路都不通：
 * 让 `display_content` 直接开外网 URL = **把整个互联网放进孩子的屏幕**（从那一页能点出去）；
 * 让家长手动"另存为"再上传，单文件 HTML 常丢样式丢图片。
 *
 * **落袋**：服务端抓取 → 存成**单个自包含 HTML**（图片内联 base64、外链剥掉、可见性收紧到"这一页"）
 * → 落进 `materials/`，挂到条目上。三个好处正好对上家长的三个担心：
 * - 孩子**点不出去**（导航元素与脚本全剥、再叠一层 CSP）→「网络资讯太复杂」
 * - **家长审的就是孩子看的**（同一份字节，不是"大概一样"）→「不知道适不适合」
 * - 与"磁盘即真源"一致（**存成文件，不存 URL**）→ 铁律 2
 *
 * ## 两段式设计（**网络在一边，变换在另一边**）
 * `fetchPage()` 负责网络与 SSRF 防线；`sanitizeClippedHtml()` 是**纯变换**，
 * 靠注进来的 `resolve` 回调取资源。这样"剥脚本/剥外链/内联图片/注入 CSP"这一整套
 * **可以完全离线单测**——而它恰恰是最容易出错、也最该被钉住的部分。
 *
 * ## SSRF 防线（家长给的是任意 URL，= 让服务端替他发请求，必须当成不可信输入）
 * 1. 只允许 `http:` / `https:`（`file:`/`data:`/`javascript:` 一律拒）；
 * 2. 主机名先按**字面量**筛（localhost / `*.local` / 元数据主机）；
 * 3. **解析 DNS 后逐个 IP 筛**（回环/私网/链路本地/唯一本地/CGNAT/保留段）——只筛字面量挡不住
 *    `http://内网域名/` 这种；
 * 4. **手动跟重定向**，每一跳都重跑上面三条（只筛首跳等于没筛）；
 * 5. 响应体**流式限量**，超限即断（防一个无限流把内存吃掉）。
 */

/** 抓取的总字节上限（zlib 解压后的正文长度） */
export const CLIP_MAX_HTML_BYTES = 3 * 1024 * 1024;
/** **产出**上限：`putMaterial` 有 2MB 硬上限，这里留出余量，超了就不再内联图片并如实标注 */
export const CLIP_MAX_OUTPUT_BYTES = 1_800_000;
export const CLIP_MAX_IMAGES = 24;
export const CLIP_MAX_IMAGE_BYTES = 400 * 1024;
export const CLIP_TIMEOUT_MS = 20_000;
export const CLIP_MAX_REDIRECTS = 5;

export interface ClipStats {
  scripts: number;
  frames: number;
  forms: number;
  anchors: number;
  metas: number;
  imagesInlined: number;
  imagesDropped: number;
  cssInlined: number;
}

export interface ClipResult {
  html: string;
  title: string;
  finalUrl: string;
  stats: ClipStats;
  /** 如实告诉家长发生了什么（截断、丢了图、剥了多少东西） */
  warnings: string[];
}

// ==================== SSRF：地址与形状 ====================

/** 私网/保留 IPv4 段（含 CGNAT 与各类特殊用途段） */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // 解析不出来的一律当不安全
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地（云元数据就在这）
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // 组播/保留
  return false;
}

/** 私网/保留 IPv6（含 IPv4 映射与 NAT64 形式） */
function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (s === "::" || s === "::1") return true;
  if (s.startsWith("fe80") || s.startsWith("fec0")) return true; // 链路/站点本地
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true; // 唯一本地 fc00::/7
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  // ::ffff:7f00:1 这类十六进制映射
  if (s.startsWith("::ffff:")) return true;
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const s = String(ip ?? "").trim();
  if (!s) return true;
  return s.includes(":") ? isPrivateIPv6(s) : isPrivateIPv4(s);
}

/**
 * 只查 **URL 形状**（不查 DNS）：协议、主机名字面量。纯函数，便于离线单测。
 * DNS 那一层在 `assertResolvablePublicHost()`——分开是为了让"形状规则"能脱离网络被钉住。
 */
export function assertUrlShape(raw: string): URL {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error(`这不是一个完整的网址：${raw}\n（要以 http:// 或 https:// 开头，例如 https://example.com/article）`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`只支持 http / https 开头的网址，收到：${u.protocol}//\n（本机文件、内网地址、javascript: 这类都不能抓——这是替服务端发请求，必须当成不可信输入）`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new Error(`网址里没有主机名：${raw}`);
  // 云元数据服务的常见主机名：**先判它**，否则会被下面的 `.internal` 规则抢走，
  // 报出"不能抓内网地址"这种不如"不能抓云元数据地址"具体的消息
  if (host === "metadata.google.internal" || host === "169.254.169.254") {
    throw new Error(`不能抓云元数据地址：${host}`);
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`不能抓本机/内网地址：${host}`);
  }
  // 字面量 IP 直接筛掉
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIPv4(host)) {
    throw new Error(`不能抓内网/保留地址：${host}`);
  }
  if (host.includes(":") && isPrivateIPv6(host)) {
    throw new Error(`不能抓内网/保留地址：${host}`);
  }
  return u;
}

/** 形状过关后再解析 DNS，**每一个**解析结果都必须是公网地址。 */
export async function assertResolvablePublicHost(u: URL): Promise<void> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return; // 已经是字面量，前面筛过了
  const { lookup } = await import("node:dns/promises");
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`域名解析不了：${host}（检查网址是否写对，或换一个能打开的页面）`);
  }
  if (!addrs.length) throw new Error(`域名没有解析结果：${host}`);
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new Error(`这个域名指向内网地址（${a.address}），不抓：${host}`);
    }
  }
}

// ==================== HTML → 自包含（纯变换，可离线测） ====================

export type AssetResolver = (absUrl: string, kind: "img" | "css") => Promise<string | null>;

export interface SanitizeOptions {
  baseUrl: string;
  resolve: AssetResolver;
  maxOutputBytes?: number;
  maxImages?: number;
}

const CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 相对 URL → 绝对（失败返回 null；`data:`/`javascript:` 一律 null） */
export function absolutize(src: string, baseUrl: string): string | null {
  const s = String(src ?? "").trim();
  if (!s || /^(data|javascript|mailto|tel|blob):/i.test(s) || s.startsWith("#")) return null;
  try {
    return new URL(s, baseUrl).toString();
  } catch {
    return null;
  }
}

/** 逐个替换 `url(...)`（CSS 里的资源引用） */
async function inlineCssUrls(css: string, baseUrl: string, resolve: AssetResolver, stats: ClipStats): Promise<string> {
  const refs = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => m[1]!);
  let out = css;
  for (const ref of new Set(refs)) {
    const abs = absolutize(ref, baseUrl);
    if (!abs) continue;
    const data = await resolve(abs, "img");
    if (!data) continue;
    out = out.split(ref).join(data);
    stats.imagesInlined++;
  }
  return out;
}

/**
 * 把抓回来的 HTML 变成**一个自包含页面**。纯变换（资源靠 `resolve` 注入）。
 *
 * 顺序很讲究：**先剥"能发起请求/能导航出去"的东西，再内联资源**——
 * 反过来的话，剥 `<script>` 之前就已经把外链图 fetch 过了（那正是我们要避免的"帮页面访问外网"）。
 *
 * 具体剥什么、为什么：
 * | 剥掉的 | 为什么 |
 * |---|---|
 * | `<script>` | 脚本能发请求、能跳转、能读 DOM。**保留它就等于把"点得出去"留在页面里** |
 * | `<iframe>/<object>/<embed>` | 都是"再开一个页面"，等于把互联网再塞一层进来 |
 * | `<form>` | 能提交数据出去（孩子误填/误点） |
 * | `<meta http-equiv="refresh">` | 一行就能跳走，最容易被忽略的导航方式 |
 * | `<a href>` → `<span>` | **点不出去**：保留可见文字，去掉可点性 |
 * | `on*=` 内联事件 | 与脚本同理 |
 * | `<link>` 非 stylesheet | preload/prefetch 会预取外网资源 |
 * 最后再叠一层 **CSP**（`default-src 'none'`）：即便上面漏了什么，浏览器也不会发出去。
 */
export async function sanitizeClippedHtml(html: string, opts: SanitizeOptions): Promise<{ html: string; title: string; stats: ClipStats; warnings: string[] }> {
  const maxOutputBytes = opts.maxOutputBytes ?? CLIP_MAX_OUTPUT_BYTES;
  const maxImages = opts.maxImages ?? CLIP_MAX_IMAGES;
  const stats: ClipStats = { scripts: 0, frames: 0, forms: 0, anchors: 0, metas: 0, imagesInlined: 0, imagesDropped: 0, cssInlined: 0 };
  const warnings: string[] = [];
  let out = String(html ?? "");

  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(out)?.[1] ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // ── 1) 剥"能发请求 / 能导航出去"的东西 ──
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<script\b[\s\S]*?<\/script\s*>/gi, () => (stats.scripts++, ""));
  out = out.replace(/<script\b[^>]*\/?>/gi, () => (stats.scripts++, ""));
  out = out.replace(/<(iframe|object|embed|applet|frame|frameset)\b[\s\S]*?<\/\1\s*>/gi, () => (stats.frames++, ""));
  out = out.replace(/<(iframe|object|embed|applet|frame|frameset)\b[^>]*\/?>/gi, () => (stats.frames++, ""));
  out = out.replace(/<form\b[\s\S]*?<\/form\s*>/gi, () => (stats.forms++, ""));
  out = out.replace(/<form\b[^>]*\/?>/gi, () => (stats.forms++, ""));
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, () => (stats.metas++, ""));
  out = out.replace(/<link\b[^>]*>/gi, (m) => {
    if (/rel\s*=\s*["']?stylesheet/i.test(m)) return m; // 样式表留着，下面内联
    stats.metas++;
    return "";
  });
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // 外链只保留文字（点不出去）
  out = out.replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, inner) => {
    stats.anchors++;
    return `<span>${inner}</span>`;
  });

  // ── 2) 内联样式表 ──
  const links = [...out.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  for (const tag of links) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
    const abs = absolutize(href, opts.baseUrl);
    const css = abs ? await opts.resolve(abs, "css") : null;
    if (!css) {
      out = out.split(tag).join("");
      stats.imagesDropped += 0;
      continue;
    }
    const inlined = await inlineCssUrls(css, abs ?? opts.baseUrl, opts.resolve, stats);
    out = out.split(tag).join(`<style>${inlined}</style>`);
    stats.cssInlined++;
  }

  // ── 3) 内联图片（受数量与总大小双重约束）──
  const imgs = [...out.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  for (const tag of imgs) {
    const src = /src\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    const abs = absolutize(src, opts.baseUrl);
    const budgetLeft = maxOutputBytes - Buffer.byteLength(out, "utf-8");
    const data = abs && stats.imagesInlined < maxImages && budgetLeft > CLIP_MAX_IMAGE_BYTES ? await opts.resolve(abs, "img") : null;
    if (!data) {
      stats.imagesDropped++;
      out = out.split(tag).join("");
      continue;
    }
    const clean = tag
      .replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*')/gi, "")
      .replace(/\sloading\s*=\s*("[^"]*"|'[^']*')/gi, "")
      .replace(/\scrossorigin\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/\ssrc\s*=\s*("[^"]*"|'[^']*')/i, ` src="${escapeAttr(data)}"`);
    out = out.split(tag).join(clean);
    stats.imagesInlined++;
  }
  // 样式内联里的 url() 也换一遍
  const styleBlocks = [...out.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]!);
  for (const block of styleBlocks) {
    const inlined = await inlineCssUrls(block, opts.baseUrl, opts.resolve, stats);
    if (inlined !== block) out = out.split(block).join(inlined);
  }
  out = out.replace(/(<[^>]+\sstyle\s*=\s*["'])([^"']*)(["'])/gi, (_m, pre, css, post) => `${pre}${css}${post}`);

  if (stats.imagesDropped) warnings.push(`有 ${stats.imagesDropped} 张图没能一起存下来（取不到或超出体积预算），页面里会缺这些图。`);

  // ── 4) 注入 CSP + 出处标记 ──
  const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  const mark = `<!-- 落袋自 ${escapeAttr(opts.baseUrl)}（抓取时内联化；脚本/外链/表单已剥除） -->`;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}\n${head}\n${mark}`);
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${head}${mark}</head>`);
  else out = `${head}${mark}\n${out}`;

  const bytes = Buffer.byteLength(out, "utf-8");
  if (bytes > maxOutputBytes) {
    warnings.push(`存下来这一页有 ${Math.round(bytes / 1024)}KB，超过本库单份资料上限，已截断尾部——可能需要家长确认内容是否完整。`);
    out = Buffer.from(out, "utf-8").subarray(0, maxOutputBytes).toString("utf-8");
  }
  return { html: out, title, stats, warnings };
}

// ==================== 抓取（网络那一半） ====================

/** 带尺寸上限的流式读取 */
async function readLimited(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > limit) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - limit))));
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          /* 取消失败无所谓 */
        }
        break;
      }
      chunks.push(value);
    }
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8"), truncated };
}

/** 单次请求（手动跟重定向，每一跳都过 SSRF 检查） */
async function fetchFollowingRedirects(startUrl: URL): Promise<{ res: Response; finalUrl: string }> {
  let current = startUrl;
  for (let hop = 0; hop <= CLIP_MAX_REDIRECTS; hop++) {
    await assertResolvablePublicHost(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CLIP_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current.toString(), {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; xuexihub-kb-clip/1.0)", accept: "text/html,application/xhtml+xml" },
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = (e as Error)?.name === "AbortError" ? `抓取超时（${CLIP_TIMEOUT_MS / 1000} 秒）` : `抓取失败：${(e as Error).message}`;
      throw new Error(`${msg}\n网址：${current.toString()}\n（换一个能打开的页面，或让家长把要点口述成一句说法）`);
    }
    clearTimeout(timer);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`服务器返回 ${res.status} 但没有给出跳转地址：${current.toString()}`);
      const next = absolutize(loc, current.toString());
      if (!next) throw new Error(`跳转地址无法解析：${loc}`);
      current = assertUrlShape(next); // 每一跳都重筛
      continue;
    }
    return { res, finalUrl: current.toString() };
  }
  throw new Error(`跳转次数太多（>${CLIP_MAX_REDIRECTS}），放弃：${startUrl.toString()}`);
}

/**
 * 抓一个网页并落成**自包含 HTML**。
 * 失败一律抛**可操作**的错误（"换一个能打开的页面 / 让家长口述一段说法"），不返回半成品。
 */
export async function clipWebPage(
  rawUrl: string,
  opts?: { maxBytes?: number; maxImages?: number }
): Promise<ClipResult> {
  const start = assertUrlShape(rawUrl);
  const { res, finalUrl } = await fetchFollowingRedirects(start);
  if (!res.ok) {
    throw new Error(`这个网址打不开（HTTP ${res.status}）：${finalUrl}\n（确认网址是否有效，或让家长把要点口述成一句说法）`);
  }
  const ctype = String(res.headers.get("content-type") ?? "").toLowerCase();
  if (ctype && !ctype.includes("html")) {
    throw new Error(`这个地址返回的不是网页（${ctype}）：${finalUrl}\n（只支持抓 HTML 页面；图片/PDF 这些请直接上传到资料库）`);
  }
  const warnings: string[] = [];
  const { text, truncated } = await readLimited(res, opts?.maxBytes ?? CLIP_MAX_HTML_BYTES);
  if (truncated) warnings.push("这一页太长，只抓了前面一部分。");

  const sanitized = await sanitizeClippedHtml(text, {
    baseUrl: finalUrl,
    maxImages: opts?.maxImages,
    resolve: async (abs, kind) => {
      try {
        const u = assertUrlShape(abs);
        await assertResolvablePublicHost(u);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CLIP_TIMEOUT_MS);
        const r = await fetch(u.toString(), { signal: ctrl.signal, redirect: "follow" });
        clearTimeout(timer);
        if (!r.ok) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.byteLength > CLIP_MAX_IMAGE_BYTES) return null;
        const mt =
          kind === "css"
            ? "text/css; charset=utf-8"
            : String(r.headers.get("content-type") ?? "image/png").split(";")[0]!.trim();
        return `data:${mt};base64,${buf.toString("base64")}`;
      } catch {
        return null; // 单张资源失败不影响整页
      }
    },
  });

  return {
    html: sanitized.html,
    title: sanitized.title,
    finalUrl,
    stats: sanitized.stats,
    warnings: [...warnings, ...sanitized.warnings],
  };
}
