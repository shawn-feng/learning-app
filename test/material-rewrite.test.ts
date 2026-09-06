import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 纯 node 环境没有 electron：打桩（media-protocol import { protocol } from "electron"，仅绑定不执行）。
vi.mock("electron", () => ({ app: undefined, protocol: undefined }));

// config 数据根指向临时目录（rewriteMaterialHtmlForRender 纯本地拼接 URL，不触服务端/DB）。
const mockTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "material-rewrite-"));
vi.mock("../electron/lib/config", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../electron/lib/config")>();
  return {
    ...mod,
    getDataDir: () => mockTmpRoot,
    getLicensePath: () => path.join(mockTmpRoot, "license.json"),
    getChildrenDir: () => path.join(mockTmpRoot, "children"),
    getSharedDir: () => path.join(mockTmpRoot, "shared"),
    getSkillsDir: () => path.join(mockTmpRoot, "shared", "skills"),
  };
});

import { rewriteMaterialHtmlForRender } from "../electron/lib/parent-library";

describe("P1 material rewrite：html 相对引用按扩展名分流 asset:// / media://", () => {
  const PID = "86a84278-c8ae-415e-8fbc-6140b1b7c88e";

  it("相对引用的 mp4/mp3 音视频改写为 media://（此前误改 asset:// 致 403 播不出）", () => {
    const html = `<html><head></head><body>
      <video src="media/xingqiu1.mp4"></video>
      <audio src="media/旁白.mp3"></audio>
    </body></html>`;
    const out = rewriteMaterialHtmlForRender(html, PID, "xingqiu");
    expect(out).toContain(`media://local/parent/${PID}/xingqiu/media/xingqiu1.mp4`);
    expect(out).toContain(`media://local/parent/${PID}/xingqiu/media/旁白.mp3`);
    expect(out).not.toContain(`asset://local/parent/${PID}/xingqiu/media/xingqiu1.mp4`);
    // 注入的 base href 仍在
    expect(out).toContain(`<base href="media://local/parent/${PID}/xingqiu/">`);
  });

  it("相对引用的图片/css/js 仍改写为 asset://", () => {
    const html = `<html><head>
      <link rel="stylesheet" href="style.css">
      <script src="app.js"></script>
    </head><body>
      <img src="img/封面.png">
    </body></html>`;
    const out = rewriteMaterialHtmlForRender(html, PID, "xingqiu");
    expect(out).toContain(`asset://local/parent/${PID}/xingqiu/style.css`);
    expect(out).toContain(`asset://local/parent/${PID}/xingqiu/app.js`);
    expect(out).toContain(`asset://local/parent/${PID}/xingqiu/img/封面.png`);
    expect(out).not.toContain(`media://local/parent/${PID}/xingqiu/style.css`);
  });

  it("已写死的完整 media:// 绝对地址保持不动（跳过绝对化）", () => {
    const abs = `media://local/parent/${PID}/xingqiu/media/xingqiu1.mp4`;
    const html = `<html><head></head><body><video src="${abs}"></video></body></html>`;
    const out = rewriteMaterialHtmlForRender(html, PID, "xingqiu");
    expect(out).toContain(abs);
    expect(out).not.toContain(`asset://local/parent/${PID}/xingqiu/xingqiu1.mp4`);
  });

  it("html 在主题根(fileDir='.')、媒体在 topic/media/ 时相对路径正确上溯解析", () => {
    // fileDir="." → base 为 media://.../parentId/，src="lunyu/media/a.mp4"
    const html = `<html><head></head><body><video src="lunyu/media/a.mp4"></video></body></html>`;
    const out = rewriteMaterialHtmlForRender(html, PID, ".");
    expect(out).toContain(`media://local/parent/${PID}/lunyu/media/a.mp4`);
  });
});
