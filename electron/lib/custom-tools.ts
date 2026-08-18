import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import fs from "fs";
import path from "path";

export interface PanelContent {
  format: "markdown" | "html";
  content: string;
  title?: string;
}

export const displayContentTool = defineTool({
  name: "display_content",
  label: "展示内容",
  description:
    "在学习内容面板展示教学内容。支持 markdown 和 html 两种格式。html 格式在沙盒 iframe 中渲染，可运行内联 <script> 和 onclick 等交互逻辑，可播放 <audio>/<video>（src 用 media://local/ 开头的本地媒体地址）。\n\n两种用法：\n1. 直接传 content（现场拼内容）；\n2. 传 path 引用预生成的学习资料文件（推荐）：path 是相对当前学习目录的文件路径，如 `learning/lunyu/materials/论语先进篇第十三章.html`，格式按扩展名自动识别（.html→html，其余→markdown）。当孩子要学某一课时，优先用 path 引用该课预生成的 html 资料（含吟诵音频、翻译、道理讲解）。",
  parameters: Type.Object({
    format: Type.Optional(
      Type.Union([Type.Literal("markdown"), Type.Literal("html")], {
        description: "内容格式：markdown 或 html（用 path 时可选，自动按扩展名识别）",
      })
    ),
    content: Type.Optional(Type.String({ description: "要展示的内容（用 path 时可省略）" })),
    path: Type.Optional(
      Type.String({ description: "预生成资料文件路径，相对学习目录，如 learning/lunyu/materials/论语先进篇第十三章.html" })
    ),
    title: Type.Optional(Type.String({ description: "内容标题" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    let format = params.format || "markdown";
    let content = params.content || "";
    let title = params.title;

    // 引用预生成资料文件：读文件内容，避免 LLM 转述大段 html
    if (params.path) {
      const resolved = path.resolve(ctx.cwd, params.path);
      // 路径守卫：只允许访问当前学习目录（cwd）内的文件
      if (resolved !== ctx.cwd && !resolved.startsWith(ctx.cwd + path.sep)) {
        throw new Error("资料路径超出学习目录范围");
      }
      const raw = fs.readFileSync(resolved, "utf-8");
      const ext = path.extname(resolved).toLowerCase();
      format = ext === ".html" || ext === ".htm" ? "html" : "markdown";
      content = raw;
      if (!title) title = path.basename(resolved).replace(/\.[^.]+$/, "");
    }

    if (!content) throw new Error("content 与 path 至少提供其一");

    return {
      content: [
        {
          type: "text" as const,
          text: `已展示内容: ${title || "教学内容"}`,
        },
      ],
      details: { panelContent: { format, content, title } },
    };
  },
});

export const getDateTool = defineTool({
  name: "get_date",
  label: "获取当前日期时间",
  description:
    "返回当前的准确日期和时间（YYYY-MM-DD 星期几 HH:mm:ss）。当需要写 daily 日志文件、更新学习进度文件里的日期字段（如 updated、首次学习、最近复习），或回答\"今天几号\"\"星期几\"\"现在几点\"时，必须先调用本工具获取准确日期时间，不要自行猜测或从对话历史里推断（历史里的日期可能是过期的）。",
  promptSnippet: "get_date - 获取当前的准确日期和时间（YYYY-MM-DD 星期几 HH:mm:ss）",
  parameters: Type.Object({}),
  execute: async () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    const weekday = weekdays[d.getDay()];
    return {
      content: [
        {
          type: "text" as const,
          text: `现在是 ${dateStr}（${weekday}）${timeStr}。`,
        },
      ],
      details: { date: dateStr, time: timeStr, weekday },
    };
  },
});
