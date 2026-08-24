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

// 必须在 app ready 之前调用，注册 scheme 为 standard + stream
export function registerMediaScheme(): void {
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
