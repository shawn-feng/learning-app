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

export function createDisplayContentTool(deps: DisplayToolDeps) {
  const paths = createCorePaths(deps.dataDir);

  return defineTool({
    name: "display_content",
    label: "展示 HTML 资料",
    description:
      "在孩子学习资料面板展示一份 **HTML 格式** 的学习资料（沙盒 iframe 渲染，可含内联 script、可播放音视频）。\n\n" +
      "**用法**：传 `path` 引用预生成的资料文件——`{topic}/{课程名}.html`（家长库共享资料，相对资料根，兼容旧 `materials/{topic}/...` 写法）" +
      "或 `outputs/{名称}.html`（你为孩子产出的工具/游戏类页面）。仅支持 .html / .htm。\n\n" +
      "**何时调用**：引导学习时展示该课预生成的资料，或孩子主动要看某份资料。\n" +
      "展示什么、何时展示，以 parent_content 取到的该主题教学方法（method）为准。",
    parameters: Type.Object({
      path: Type.String({ description: "资料文件路径（必须 .html/.htm 结尾），如 lunyu/论语先进篇第十三章.html 或 outputs/番茄钟.html" }),
      title: Type.Optional(Type.String({ description: "内容标题（缺省取文件名）" })),
    }),
    execute: async (_id: string, params: { path: string; title?: string }, _signal: any, _onUpdate: any, ctx: any) => {
      const raw = String(params?.path ?? "").trim();
      if (!raw) throw new Error("display_content 必须提供 path（预生成的 html 资料路径）");
      if (!/\.html?$/i.test(raw)) throw new Error(`display_content 只支持 .html/.htm，收到：${raw}`);

      // 与客户端旧实现一致的三种写法归一
      let rel = raw.replace(/^\/+/, "");
      if (rel.startsWith(REMOTE_PREFIX)) rel = rel.slice(REMOTE_PREFIX.length);

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
          `资料不存在：${raw}\n（在 ${where} 中未找到；请核对路径，或用 ls / parent_list_materials 先看有什么）` +
            (ctx?.cwd ? `\n当前工作区：${ctx.cwd}` : "")
        );
      }

      const title = params.title?.trim() || rel.split("/").pop()!.replace(/\.html?$/i, "");
      const source = isWorkspace ? "workspace" : "materials";
      // 正文随事件一起推送：渲染层收到即可直接 iframe 渲染（多端同看、无需再拉文件）。
      // 读取失败（竞态/权限）不阻断——前端拿不到正文会走 materialsRefresh 兜底。
      let content = "";
      try {
        content = fs.readFileSync(abs, "utf-8");
      } catch {
        content = "";
      }
      const ts = Date.now();
      agentStreamHub.publish(deps.streamKey, "display_content", { path: rel, source, title, content, ts });
      // ISSUE-113：登记到孩子库（会话重进回填左侧资料列表）；失败不影响推送
      try {
        registerDisplay(deps.dataDir, deps.parentId, deps.childId, deps.sessionKey, {
          path: rel, title, source, content, ts,
        });
      } catch (err) {
        console.warn(`[display_content] 登记失败（不影响推送）：${(err as Error).message}`);
      }
      return {
        content: [{ type: "text" as const, text: `已展示资料「${title}」（${rel}）——孩子端资料面板会即时打开。` }],
        details: {},
      };
    },
  });
}

export const DISPLAY_TOOL_NAME = "display_content";
