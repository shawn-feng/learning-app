import { protocol, net } from "electron";
import path from "path";
import { pathToFileURL } from "url";
import { getDataDir } from "./config";

// media://local/{childId}/learning/{topic}/media/{文件}
// 映射到 data/children/{childId}/learning/{topic}/media/{文件}
// 音视频固定存放在学习主题目录的 media/ 子目录下（不随 app 打包，作为主题包额外下载）
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
  const childrenDir = path.join(getDataDir(), "children");
  protocol.handle("media", async (request) => {
    try {
      const url = new URL(request.url);
      // pathname 形如 /{childId}/learning/{topic}/media/{文件}
      const segs = decodeURIComponent(url.pathname)
        .replace(/^\/+/, "")
        .split("/")
        .filter(Boolean);
      const childId = segs[0];

      // childId 校验：非空、不含路径穿越片段
      if (!childId || childId.includes("..") || childId.includes("\\")) {
        return new Response("forbidden", { status: 403 });
      }

      const childDir = path.join(childrenDir, childId);
      const filePath = path.resolve(childDir, ...segs.slice(1));

      // 防目录穿越：解析后必须仍在当前孩子目录内
      if (filePath !== childDir && !filePath.startsWith(childDir + path.sep)) {
        return new Response("forbidden", { status: 403 });
      }
      const ext = path.extname(filePath).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        return new Response("forbidden", { status: 403 });
      }

      // 交给 Chromium 网络栈读取本地文件（支持 Range，audio/video 可 seek）
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
