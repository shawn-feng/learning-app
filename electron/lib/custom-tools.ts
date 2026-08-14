import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export interface PanelContent {
  format: "markdown" | "html";
  content: string;
  title?: string;
}

export const displayContentTool = defineTool({
  name: "display_content",
  label: "展示内容",
  description:
    "在学习内容面板展示教学内容。支持 markdown 和 html 两种格式。html 格式在沙盒 iframe 中渲染，可运行内联 <script> 和 onclick 等交互逻辑（如番茄钟、点击游戏、可交互卡片），按钮可以真正点击。当需要向孩子展示课文原文、图片、知识点卡片、交互式练习时使用。",
  parameters: Type.Object({
    format: Type.Union([Type.Literal("markdown"), Type.Literal("html")], {
      description: "内容格式：markdown 或 html",
    }),
    content: Type.String({ description: "要展示的内容" }),
    title: Type.Optional(Type.String({ description: "内容标题" })),
  }),
  execute: async (_toolCallId, params) => {
    return {
      content: [
        {
          type: "text" as const,
          text: `已展示内容: ${params.title || "教学内容"}`,
        },
      ],
      details: { panelContent: params },
    };
  },
});

export const getDateTool = defineTool({
  name: "get_date",
  label: "获取当前日期",
  description:
    "返回今天的确切日期（YYYY-MM-DD 格式，含星期几）。当需要写 daily 日志文件、更新学习进度文件里的日期字段（如 updated、首次学习、最近复习）时，必须先调用本工具获取准确日期，不要自行猜测或从文件名推断。",
  promptSnippet: "get_date - 获取今天的准确日期（YYYY-MM-DD，含星期几）",
  parameters: Type.Object({}),
  execute: async () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    const weekday = weekdays[d.getDay()];
    return {
      content: [
        {
          type: "text" as const,
          text: `今天是 ${dateStr}（${weekday}）。`,
        },
      ],
      details: { date: dateStr, weekday },
    };
  },
});
