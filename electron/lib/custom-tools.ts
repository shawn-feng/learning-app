import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import fs from "fs";
import path from "path";
import { getLearningSummary, progressSummaryToMarkdown } from "./learning-summary";

export interface PanelContent {
  format: "html";
  content: string;
  title?: string;
  /** 资料文件路径（相对学习目录），用于前端去重与回看 */
  filePath: string;
}

export const displayContentTool = defineTool({
  name: "display_content",
  label: "展示 HTML 资料",
  description:
    "在孩子学习资料面板展示一份 **HTML 格式** 的学习资料（在沙盒 iframe 中渲染，可运行内联 <script>、onclick 等交互，可播放 <audio>/<video>，src 用 media://local/ 本地地址）。\n\n" +
    "**用法**：传 `path` 引用预生成的学习资料文件（必填）。path 是相对当前学习目录的文件路径，如 `learning/lunyu/materials/论语先进篇第十三章.html`；仅支持 .html / .htm，格式固定为 html。\n\n" +
    "**何时调用**：仅当需要展示资料时——引导学习时展示该课预生成的 html 资料，或孩子主动要求查看某份资料。\n\n" +
    "**展示什么、何时展示，以该主题 method.md 的规定为准**。",
  parameters: Type.Object({
    path: Type.String({
      description:
        "预生成资料文件路径（必填），相对学习目录，必须以 .html 或 .htm 结尾，如 learning/lunyu/materials/论语先进篇第十三章.html",
    }),
    title: Type.Optional(Type.String({ description: "内容标题（缺省取文件名）" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    if (!params.path) {
      throw new Error("display_content 必须提供 path 参数（预生成的 html 资料文件路径）");
    }
    const resolved = path.resolve(ctx.cwd, params.path);
    // 路径守卫：只允许访问当前学习目录（cwd）内的文件
    if (resolved !== ctx.cwd && !resolved.startsWith(ctx.cwd + path.sep)) {
      throw new Error("资料路径超出学习目录范围");
    }
    const ext = path.extname(resolved).toLowerCase();
    if (ext !== ".html" && ext !== ".htm") {
      throw new Error("display_content 仅支持 .html / .htm 文件");
    }
    const raw = fs.readFileSync(resolved, "utf-8");
    const title = params.title || path.basename(resolved).replace(/\.[^.]+$/, "");

    return {
      content: [
        {
          type: "text" as const,
          text: `已展示内容: ${title}`,
        },
      ],
      details: { panelContent: { format: "html", content: raw, title, filePath: params.path } },
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

/**
 * 查询学习进度（只回 frontmatter 摘要，绝不读进度文件正文）。
 *
 * 背景（ISSUE-006）：进度文件 `learning/{topic}/{topic}.md` 的正文是逐课列表
 * （论语可达 514 课、几百行），agent 过去为了拿一个 `next` 字段会 read 整个文件，
 * 极其浪费上下文。本工具只回 frontmatter 级摘要（learned/total/next/updated），
 * 日常教学流确认下一课、study-tracker 评估流核对进度都应优先用它，不要读正文。
 *
 * childId 由 ctx.cwd 推导（childDir 即 `children/<childId>`）。
 */
export const getProgressTool = defineTool({
  name: "get_progress",
  label: "查询学习进度（仅 frontmatter 摘要）",
  description:
    "返回当前孩子的学习进度摘要——**只含各主题 frontmatter 的 learned/total/next/updated，不含几百行的逐课正文**。" +
    "当你需要确认「下一课是什么」「已学多少」「今日是否已完成每日目标」时，使用本工具，" +
    "**不要**用 read 工具去读取进度文件（`learning/{topic}/{topic}.md`）的正文（那只为一个 next 字段而浪费大量上下文）。" +
    "日常教学流与 study-tracker 评估流都应优先用本工具确认进度；只有明确需要逐课状态时才读全文。",
  parameters: Type.Object({}),
  execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
    const childId = path.basename(ctx.cwd);
    const summary = getLearningSummary(childId);
    const text = summary.topics.length
      ? progressSummaryToMarkdown(summary)
      : "暂无学习主题进度。";
    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  },
});
