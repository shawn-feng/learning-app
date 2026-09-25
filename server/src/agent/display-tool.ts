/**
 * display_content 的**服务端形态**（P3）：从「客户端渲染调用」改为「服务端登记 + SSE 推送」。
 *
 * 语义对齐客户端旧实现：agent 给一个资料路径（`<topic>/x.html`、旧写法 `materials/<topic>/x.html`、
 * 或孩子工作区的 `outputs/x.html`），由客户端资料面板渲染。上移后服务端不渲染，只做两件事：
 *  1. 校验路径确实存在（在材料真源或孩子工作区内），避免推送一个渲染必然失败的空地址；
 *  2. 通过 SSE 推 `display_content` 事件（含 path/title/source），所有打开了该孩子会话的端各自渲染。
 *
 * 好处（除架构统一外）：多端同时在线时，孩子桌面端与家长手机可以同时看到同一份资料；
 * 且「想看什么资料」这件事变成可回放的事件（Last-Event-ID 重连后仍能恢复）。
 */
import fs from "node:fs";
import { Type } from "typebox";
import { defineTool } from "./tool-kit.js"; // ISSUE-134：统一还原字符串化参数
import { createCorePaths, resolveWithin } from "@pi/agent-core";
import { resolveMaterialFile } from "../db/materials.js";
import { registerDisplay } from "../db/displays.js";
import { agentStreamHub } from "./stream-hub.js";

export interface DisplayToolDeps {
  dataDir: string;
  parentId: string;
  childId: string;
  streamKey: string;
  /** 会话种类（main / course:<key> / scene）：登记按会话走，重进回填、/reset 清空（ISSUE-113） */
  sessionKey: string;
}

const REMOTE_PREFIX = "materials/";

/**
 * 可展示类型（**从扩展名现算，不查任何字段**——`kb_entry_assets.role` 当初就是因为"纯派生数据"
 * 被删掉的，见 docs/知识库-完整方案-2026-09-26.md §3.3.5）。
 *
 * KB P1（2026-09-27）放开白名单的理由：不放，**材料类条目等于残废**——
 * 家长挂了纪录片，孩子放不出来（原实现只认 `.html/.htm`）。
 */
export type DisplayKind = "html" | "text" | "image" | "audio" | "video" | "pdf";

const KIND_BY_EXT: Record<string, DisplayKind> = {
  html: "html", htm: "html",
  txt: "text", md: "text",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", bmp: "image",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", aac: "audio", flac: "audio",
  mp4: "video", webm: "video",
  // PDF（KB P2）：P1 曾以「自定义 scheme 下不保证渲染」为由拒绝，P2 探针实测推翻
  // （Electron 43 自带阅读器，不需要 plugins:true）。渲染走 `<iframe>` + `#toolbar=0`。
  pdf: "pdf",
};

const KIND_ZH: Record<DisplayKind, string> = {
  html: "网页", text: "文本", image: "图片", audio: "音频", video: "视频", pdf: "PDF",
};

/** 从相对路径推展示类型；不支持返回 null（调用方给可操作的话） */
export function displayKindOf(relPath: string): DisplayKind | null {
  const ext = String(relPath ?? "").toLowerCase().split(".").pop() ?? "";
  return KIND_BY_EXT[ext] ?? null;
}

/** 正文随事件内联（html 供沙箱 iframe 渲染、text 直接显示）；二进制只给路径，由渲染层按 kind 取流 */
function kindIsInline(kind: DisplayKind): boolean {
  return kind === "html" || kind === "text";
}

export function createDisplayContentTool(deps: DisplayToolDeps) {
  const paths = createCorePaths(deps.dataDir);

  return defineTool({
    name: "display_content",
    label: "展示资料",
    description:
      "在孩子学习资料面板展示一份资料：**网页 / 图片 / 音频 / 视频 / 文本 / PDF**（网页走沙盒 iframe，媒体走原生播放器）。\n\n" +
      "**用法**：传 `path` 引用真实存在的资料文件——`{topic}/...`（家长资料库共享资料，相对资料根，兼容旧 `materials/{topic}/...` 写法）" +
      "或 `outputs/{名称}.html`（你为孩子产出的页面）。\n\n" +
      "**何时调用**：引导学习时展示该课预生成的资料，孩子主动要看某份资料，或知识条目里给了「可展示」的资料。\n" +
      "**两条纪律**：① **一次只放一份**，放之前先问她想不想看（她正专心听时弹东西会打断）；② 展示什么、何时展示，以「家长准备的说法」" +
      "（kb_lookup 返回的「用法」）或该主题教学方法为准。\n" +
      "**放不出来时不要承诺「我去网上找」**：面板只能放资料库里已有的文件，没有就如实说没有。",
    parameters: Type.Object({
      path: Type.String({ description: "资料文件路径，如 lunyu/论语先进篇第十三章.html 或 preqin/media/甲骨文-卜辞拓片.jpg" }),
      title: Type.Optional(Type.String({ description: "内容标题（缺省取文件名）" })),
    }),
    execute: async (_id: string, params: { path: string; title?: string }, _signal: any, _onUpdate: any, ctx: any) => {
      const raw = String(params?.path ?? "").trim();
      if (!raw) throw new Error("display_content 必须提供 path（要展示的资料路径）");

      // 与客户端旧实现一致的三种写法归一
      let rel = raw.replace(/^\/+/, "");
      if (rel.startsWith(REMOTE_PREFIX)) rel = rel.slice(REMOTE_PREFIX.length);

      const kind = displayKindOf(rel);
      if (!kind) {
        throw new Error(
          `display_content 放不了这一类文件：${raw}\n` +
            `（面板支持 网页 .html/.htm ｜ 图片 .png/.jpg/.jpeg/.gif/.webp/.svg/.bmp ｜ 音频 .mp3/.wav/.ogg/.m4a/.aac/.flac ｜ 视频 .mp4/.webm ｜ 文本 .txt/.md ｜ PDF .pdf）\n` +
            `如果是别的格式：**如实告诉孩子这份放不了**，改用你的话讲，或让家长换一份（不要承诺"我去网上找"）。`
        );
      }

      // ISSUE-131 P2 三源：孩子 outputs/（孩子工作区）、家长 materials（新根，孩子会话可解析展示/
      // 读授权放行——孩子 fs 工具仍不可写不可见）、存量旧根 materials/<pid>（兼容层，不迁移）。
      const isWorkspace = rel.startsWith("outputs/");
      const workspace = paths.childWorkspaceDir(deps.parentId, deps.childId);
      let abs: string;
      try {
        abs = isWorkspace
          ? resolveWithin(workspace, rel)
          : resolveMaterialFile(deps.dataDir, deps.parentId, rel);
      } catch (err) {
        throw new Error(`资料路径非法：${(err as Error).message}`);
      }
      if (!fs.existsSync(abs)) {
        const where = isWorkspace ? `孩子工作区（${workspace}）` : `家长资料库（${resolveMaterialFile(deps.dataDir, deps.parentId, rel)}）`;
        throw new Error(
          `资料不存在：${raw}\n（在 ${where} 中未找到；请核对路径；条目里的「可展示」路径可直接用，` +
            `或让家长在对话里核对资料库）` +
            (ctx?.cwd ? `\n当前工作区：${ctx.cwd}` : "")
        );
      }

      const title = params.title?.trim() || rel.split("/").pop()!.replace(/\.[^.]+$/, "");
      const source = isWorkspace ? "workspace" : "materials";
      // 正文随事件一起推送（**仅 html/text**）：渲染层收到即可直接渲染，多端同看、无需再拉文件。
      // 二进制（图片/音视频）**不读正文**——既避免大文件进事件，也避免把字节当字符串。
      // 读取失败（竞态/权限）不阻断——前端拿不到正文会走 materialsRefresh 兜底。
      let content = "";
      if (kindIsInline(kind)) {
        try {
          content = fs.readFileSync(abs, "utf-8");
        } catch {
          content = "";
        }
      }
      const ts = Date.now();
      agentStreamHub.publish(deps.streamKey, "display_content", { path: rel, source, title, kind, content, ts });
      // ISSUE-113：登记到孩子库（会话重进回填左侧资料列表）；失败不影响推送
      try {
        registerDisplay(deps.dataDir, deps.parentId, deps.childId, deps.sessionKey, {
          path: rel, title, source, content, ts,
        });
      } catch (err) {
        console.warn(`[display_content] 登记失败（不影响推送）：${(err as Error).message}`);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `已展示资料「${title}」（${rel}，${KIND_ZH[kind]}）——孩子端资料面板会即时打开。放完继续引导她说说看到了什么。`,
          },
        ],
        details: {},
      };
    },
  });
}

export const DISPLAY_TOOL_NAME = "display_content";
