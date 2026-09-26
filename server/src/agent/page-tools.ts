/**
 * 资料页工具（P3）：page_inspect / page_action / scene_command 的**服务端形态**。
 *
 * 修正一个早期误判：这两个工具之所以过去在客户端，不是因为「资料在客户端」，而是因为**渲染态**在客户端。
 * 资料源（html 真源）本就在服务端，所以：
 *  - 内容感知：server 直接读材料源文件（无需设备）；
 *  - 孩子互动：PiBridge 事件经 `POST /agent/:childId/events` 上行，由桥格式化后进入上下文；
 *  - 受控操作/实时 DOM：经 SSE 下发 `page_cmd` 到客户端执行端点（`MaterialsPanel.appCmd`），回执经
 *    `POST /agent/:childId/page-result` 回来 —— 传输层从本地 IPC 换成 HTTP/SSE，**客户端侧实现不动**。
 */
import { Type } from "typebox";
import { defineTool } from "./tool-kit.js"; // ISSUE-134：统一还原字符串化参数
import { createCorePaths } from "@pi/agent-core";
import type { PageExecParams } from "@pi/agent-core";
import type { DatabaseSync } from "node:sqlite";
import { hubFor } from "./page-hub.js";

export interface PageToolDeps {
  db: DatabaseSync;
  dataDir: string;
  parentId: string;
  childId: string;
  /** 会话流键（`<parentId>:<childId>`），用于下行 SSE */
  streamKey: string;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

function snapshotText(items: Array<{ i: number; tag: string; text: string; role?: string; href?: string }>, truncated?: boolean) {
  if (!items.length) return "（页面快照为空）";
  return (
    items
      .map((it) => `- [${it.i}] <${it.tag}>${it.role ? ` role=${it.role}` : ""}${it.href ? ` href=${it.href}` : ""} ${it.text}`)
      .join("\n") + (truncated ? "\n（快照已截断，可减小 maxNodes 重试）" : "")
  );
}

export function createPageTools(deps: PageToolDeps) {
  const hub = hubFor(deps.streamKey, deps.childId);
  const paths = createCorePaths(deps.dataDir);

  const pageActionTool = defineTool({
    name: "page_action",
    label: "操作学习资料页面",
    description:
      "在**学习资料页面**（孩子正在看的沙盒 iframe 里的 HTML 资料）上执行受控操作。\n\n" +
      "**action**：`click`（用 index 精确定位，或 text 按可见文本匹配）/ `scroll`（pct 0-100 或 index）/ " +
      "`input`（index + value）/ `read`（读取当前页面文本式 DOM 快照）。\n\n" +
      "**定位**：元素索引一律取自 page_inspect 快照的 i 字段。\n" +
      "**注意**：只能执行上述受控操作；**不存在也不要要求任何在页面上执行任意代码的能力**。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("click"), Type.Literal("scroll"), Type.Literal("input"), Type.Literal("read")]),
      index: Type.Optional(Type.Number({ description: "元素索引（page_inspect 快照的 i 字段）" })),
      text: Type.Optional(Type.String({ description: "click 按可见文本匹配元素" })),
      pct: Type.Optional(Type.Number({ description: "scroll 百分比 0-100" })),
      value: Type.Optional(Type.String({ description: "input 填入的内容" })),
      maxDepth: Type.Optional(Type.Number({ description: "read 快照最大深度（默认 8）" })),
      maxNodes: Type.Optional(Type.Number({ description: "read 快照最大元素数（默认 500）" })),
    }),
    execute: async (_id: string, params: PageExecParams) => {
      const { action, ...rest } = params;
      const r = await hub.executeAction(deps.childId, { action, ...rest } as PageExecParams);
      const head = r.ok ? "页面操作完成" : "页面操作失败";
      const extra = r.ok
        ? r.data
          ? "；" + JSON.stringify(r.data).slice(0, 300)
          : ""
        : `：${r.error ?? "无响应"}（请确认已先用 display_content 展示该资料页、页面已在客户端打开，再重试）`;
      return ok(`${head}（${action}${params.index !== undefined ? `, index=${params.index}` : ""}${params.text ? `, text=${params.text}` : ""}）${extra}`);
    },
  });

  const pageInspectTool = defineTool({
    name: "page_inspect",
    label: "查看学习资料页面",
    description:
      "查看**学习资料页面**当前状态：孩子最近的互动摘要 + 文本式 DOM 快照（元素带 i 索引，供 page_action 定位）。\n\n" +
      "**何时调用**：需要知道孩子在看什么、读到哪、是否卡住，或要在页面上定位元素做操作时。\n" +
      "**大小控制**：maxDepth（默认 8）、maxNodes（默认 500）——页面很大时用更小值省上下文。",
    parameters: Type.Object({
      maxDepth: Type.Optional(Type.Number({ description: "快照最大深度（默认 8）" })),
      maxNodes: Type.Optional(Type.Number({ description: "快照最大元素数（默认 500）" })),
    }),
    execute: async (_id: string, params: { maxDepth?: number; maxNodes?: number }) => {
      const recent = hub.recentInteractions(deps.childId, 10);
      const snap = await hub.executeAction(deps.childId, { action: "read", ...(params || {}) } as PageExecParams);
      const parts: string[] = [];
      if (recent) parts.push(`## 最近互动\n${recent}`);
      else parts.push("## 最近互动\n（暂无页面互动事件）");
      if (snap.ok) {
        const data = (snap.data || {}) as { items?: any[]; truncated?: boolean };
        parts.push(`## 页面文本快照（元素索引 i 供 page_action 定位）\n${snapshotText(data.items || [], data.truncated)}`);
      } else {
        // 快照失败时给「服务端可自查」的替代路径：资料源就在服务端，可直接读文件
        const ws = paths.childWorkspaceDir(deps.parentId, deps.childId);
        parts.push(
          `快照获取失败：${snap.error ?? "无响应"}\n` +
            `（可能原因：页面未在客户端打开。若只是想看资料内容，可直接用 read 读工作区或让家长侧确认资料路径；` +
            `工作区：${ws}）`
        );
      }
      return ok(parts.join("\n\n"));
    },
  });

  // scene_command（驱动场景页演出）已随「场景会话下线」删除（2026-09-25）：
  // 场景页现在就是普通资料页，孩子的对话一律走主会话，不再有「游戏主持人」这条独立角色链路。

  return { pageActionTool, pageInspectTool };
}

export const PAGE_TOOL_NAMES = ["page_action", "page_inspect"];
