import { protocol, net } from "electron";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { getDataDir } from "./config";

// media://local 协议：把沙盒 iframe 里的音视频请求映射到本地媒体文件。
//
// URL 格式（父库共享，与 childId 解耦，单一真源）：
//   media://local/parent/{parentId}/{topic}/media/{文件}
//     → data/parents/{parentId}/materials/{topic}/media/{文件}
//
// 音视频固定存放在主题的 media/ 子目录下（不随 app 打包，作为主题包额外下载）。
const ALLOWED_EXT = new Set([
  ".mp3",
  ".mp4",
  ".ogg",
  ".wav",
  ".webm",
  ".m4a",
  ".aac",
  ".flac",
  ".m3u8",
]);

/**
 * 把 media:// URL 的 pathname 解析为本地文件绝对路径（纯函数，可单测）。
 * 返回 null 表示格式非法 / 目录穿越 / 越权。
 *
 * @param dataDir 数据根（getDataDir()）
 * @param pathname 如 `/parent/default/lunyu/media/论语.mp3`
 */
export function resolveMediaTarget(dataDir: string, pathname: string): string | null {
  const segs = decodeURIComponent(pathname)
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);
  if (segs.length < 2) return null;

  // 仅支持新格式（父库共享，与 childId 解耦）：
  //   media://local/parent/{parentId}/{topic}/media/{文件}
  if (segs[0] !== "parent") return null;
  if (segs.length < 4) return null;
  const [, parentId, topic, ...rest] = segs;
  if (!parentId || parentId.includes("..") || parentId.includes("\\")) return null;
  const base = path.join(dataDir, "parents", parentId, "materials", topic);
  const rel = rest; // media/<file>

  const filePath = path.resolve(base, ...rel);
  // 防目录穿越：解析后必须仍在 base 内
  if (filePath !== base && !filePath.startsWith(base + path.sep)) return null;
  return filePath;
}

// 必须在 app ready 之前调用且只能调用一次（Electron 要求 registerSchemesAsPrivileged
// 合并注册全部自定义 scheme，多次调用会互相覆盖导致部分 scheme 丢失特权）。
export function registerCustomSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "media",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
    {
      scheme: "asset",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

export function registerMediaProtocol(): void {
  const dataDir = getDataDir();
  protocol.handle("media", async (request) => {
    try {
      const url = new URL(request.url);
      const filePath = resolveMediaTarget(dataDir, url.pathname);
      if (!filePath) return new Response("forbidden", { status: 403 });

      const ext = path.extname(filePath).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) return new Response("forbidden", { status: 403 });
      if (!fs.existsSync(filePath)) return new Response("not found", { status: 404 });

      // 交给 Chromium 网络栈读取本地文件（支持 Range，audio/video 可 seek）
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

// ============================================================================
// asset:// 协议：把沙盒 iframe(srcDoc，来源 about:blank) 内引用的共享资料文件
// （css/js/图片/字体等，区别于仅限音视频的 media://）映射到本地。
//
// URL 格式：
//   asset://local/parent/{parentId}/{topic}/{rel...}
//     → data/parents/{parentId}/materials/{topic}/{rel...}
//
// 解决两类问题：
//   1) 此前用 <iframe srcDoc> 渲染课程 html，相对引用(../wowenglish.css、images/..)
//      在 about:blank 来源下失效 → css/图片不加载；
//   2) 改用 <iframe src="file://"> 后，dev(http 源)下 Chromium 禁止加载本地资源、
//      且 sandbox 与 file:// 组合也常被整页拒绝 → 所有主题资料空白。
// 改为把相对引用改写为 asset:// 绝对地址后继续用 srcDoc，dev/prod 均生效。
// 与 media:// 同特权(standard+secure)，可从任意源(含 http dev 源)访问，无混合内容告警。
const ASSET_ALLOWED_EXT = new Set([
  ".css", ".js", ".mjs", ".cjs",
  ".html", ".htm",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".json", ".map", ".txt",
]);

export function resolveAssetTarget(dataDir: string, pathname: string): string | null {
  const segs = decodeURIComponent(pathname).replace(/^\/+/, "").split("/").filter(Boolean);
  // URL 形如 asset://local/parent/{parentId}/{topic}/{rel...}；standard scheme 下
  // 'local' 是 host（不在 pathname 里），pathname 从 /parent/... 开始（与 media:// 同理）。
  if (segs.length < 4) return null;
  if (segs[0] !== "parent") return null;
  const parentId = segs[1];
  if (!parentId || parentId.includes("..") || parentId.includes("\\")) return null;
  const topic = segs[2];
  if (!topic || topic.includes("..") || topic.includes("\\")) return null;
  const base = path.join(dataDir, "parents", parentId, "materials", topic);
  const rest = segs.slice(3);
  if (rest.length === 0) return null;
  const filePath = path.resolve(base, ...rest);
  // 防目录穿越：解析后必须仍在 base 内
  if (filePath !== base && !filePath.startsWith(base + path.sep)) return null;
  const ext = path.extname(filePath).toLowerCase();
  if (!ASSET_ALLOWED_EXT.has(ext)) return null;
  return filePath;
}

/** 由 (parentId, topic, 相对主题目录的路径) 拼出 asset:// 绝对 URL（纯函数）。 */
export function buildAssetUrl(parentId: string, topic: string, relPathFromTopic: string): string {
  const clean = relPathFromTopic.replace(/\\/g, "/").replace(/^\/+/, "");
  return `asset://local/parent/${parentId}/${topic}/${clean}`;
}

export function registerAssetProtocol(): void {
  const dataDir = getDataDir();
  protocol.handle("asset", async (request) => {
    try {
      const url = new URL(request.url);
      const filePath = resolveAssetTarget(dataDir, url.pathname);
      if (!filePath) return new Response("forbidden", { status: 403 });
      if (!fs.existsSync(filePath)) return new Response("not found", { status: 404 });
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
