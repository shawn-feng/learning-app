import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import fs from "fs";
import path from "path";
import { getLearningSummary, progressSummaryToMarkdown } from "./learning-summary";
import {
  dailyToMarkdown,
  insertCourse,
  insertDailyEntry,
  progressToMarkdown,
  queryDaily,
  queryTags,
  queryTopicProgress,
  queryTopicsMeta,
  tagsToMarkdown,
  updateDailyField,
  updateProgress,
} from "./kb-sqlite";
import { generateHtmlLesson } from "./programming-agent";

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

/**
 * ===== 知识库结构化工具（kb_query / kb_insert / kb_update）=====
 * 依据 LEARNING-DATA-SPEC.md 5.3 与 ISSUE-023 P2（SQLite 唯一真源）：
 * 数据全部存 `data/children/<childId>/kb.sqlite`，查询只回目标内容、写入内容不进 LLM 上下文。
 * markdown 为历史归档（一次性迁移后不再读写），agent 不再碰数据文件。
 */

/**
 * kb_query（SQL 结构化查询）。
 *
 * 支持四类查询（query 必填）：
 *   "daily"    —— daily 记录：date（精确）/ month（YYYY-MM 聚合）+ block（学习/生活/问答/任务）+ title + listOnly
 *   "topics"   —— 主题清单 + 进度摘要（topics/rules/topic_progress 聚合）
 *   "progress" —— 某主题进度（learned/total/next/updated + 条目清单）：topic 必填 + listOnly
 *   "tags"     —— 标签倒排：tag（缺省全部）+ kind（knowledge/life）
 *
 * 全部走 SQLite 索引，**不读任何 markdown 数据文件**。
 */
export const kbQueryTool = defineTool({
  name: "kb_query",
  label: "SQL 查询知识库",
  description:
    "从 SQLite 查询知识库数据（daily 记录 / 主题进度 / 标签定义），**只返回目标内容，不读 markdown 全文，省 token**（ISSUE-013/ISSUE-023）。\n\n" +
    "**query 类型**：\n" +
    "- `query: \"daily\"`：查 daily 记录。定位：`date`（YYYY-MM-DD）或 `month`（YYYY-MM 聚合）+ `block`（学习/生活/问答/任务）+ `title`（条目标题）+ `tag`（按标签过滤，如 诚实）+ `listOnly`（只回标题清单）。非 listOnly 返回条目原文（字段由 method 定义）。\n" +
    "- `query: \"topics\"`：查主题清单与进度摘要（无需其它参数）。\n" +
    "- `query: \"progress\"`：查某主题进度，`topic` 必填（如 lunyu）+ `tag`（按课程标签过滤）+ `listOnly`（只回课程清单，不看字段）。\n" +
    "- `query: \"tags\"`：查**标签定义**（词表 + 判断标准，打标签前先查此表，只能从下表选择），`tag`（缺省 = 全部）。\n" +
    "**返回**：结构化 markdown，可直接用于教学反查相关生活事件、确认下一课、回顾某天记录。\n" +
    "**优先于 read 数据文件**：daily/、life/、inquiries/、tasks/、tags/、learning 进度文件都是 SQLite 管理的，不要用 read 读它们。",
  parameters: Type.Object({
    query: Type.String({ description: "查询类型：daily | topics | progress | tags" }),
    date: Type.Optional(Type.String({ description: "daily 查询：精确日期 YYYY-MM-DD" })),
    month: Type.Optional(Type.String({ description: "daily 查询：月份聚合 YYYY-MM（配合 block + listOnly）" })),
    block: Type.Optional(Type.String({ description: "daily 查询：区块（学习/生活/问答/任务）" })),
    title: Type.Optional(Type.String({ description: "daily 查询：条目标题精确匹配" })),
    listOnly: Type.Optional(Type.Boolean({ description: "true 时只返回条目标题清单，不返回内容" })),
    topic: Type.Optional(Type.String({ description: "progress 查询：主题名（如 lunyu）" })),
    tag: Type.Optional(Type.String({ description: "标签过滤：daily 查生活事件、progress 查课程、tags 查标签定义（如 诚实）；缺省 = 全部" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const childDir = ctx.cwd;

    switch (params.query) {
      case "daily": {
        const entries = queryDaily(childDir, {
          date: params.date,
          month: params.month,
          block: params.block,
          title: params.title,
          tag: params.tag,
          listOnly: params.listOnly,
        });
        const scope = params.date
          ? `${params.date}${params.block ? ` ${params.block}` : ""}`
          : params.month
            ? `${params.month}${params.block ? ` ${params.block}` : ""}`
            : "全部 daily";
        return {
          content: [{ type: "text" as const, text: `${scope}记录：\n${dailyToMarkdown(entries, params.listOnly)}` }],
        };
      }
      case "topics": {
        const topics = queryTopicsMeta(childDir);
        const progress = queryTopicProgress(childDir);
        if (topics.length === 0) {
          return { content: [{ type: "text" as const, text: "暂无学习主题。" }] };
        }
        const lines: string[] = ["主题清单："];
        for (const t of topics) {
          const dirName = t.file.split("/")[0];
          const p = progress.find((x) => x.topic === dirName);
          const next = p?.next?.trim() ? `，下一课「${p.next.trim()}」` : "";
          const daily = t.rules.daily ? ` 每日目标 ${t.rules.daily} 课` : "";
          const type = t.rules.type ? `（${t.rules.type}）` : "";
          lines.push(`- ${t.name}${type}：已学 ${p?.learned ?? 0}/${p?.total ?? 0}${next}${daily}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }
      case "progress": {
        if (!params.topic) throw new Error("kb_query progress 需要 topic 参数（如 lunyu）");
        const progress = queryTopicProgress(childDir, params.topic, params.tag);
        if (progress.length === 0) {
          return { content: [{ type: "text" as const, text: `主题「${params.topic}」暂无进度记录。` }] };
        }
        return {
          content: [{ type: "text" as const, text: progressToMarkdown(progress, params.listOnly) }],
        };
      }
      case "tags": {
        const defs = queryTags(childDir, params.tag);
        return {
          content: [
            {
              type: "text" as const,
              text: `${params.tag ? `标签「${params.tag}」定义：` : ""}${tagsToMarkdown(defs)}`,
            },
          ],
        };
      }
      default:
        throw new Error(`kb_query 支持 query: daily | topics | progress | tags（当前: ${params.query}）`);
    }
  },
});

/**
 * kb_insert（SQL 插入新条目）。
 *
 * 支持两类写入（table 必填）：
 *   "daily"  —— 写 daily 新条目：date（YYYY-MM-DD）+ block（学习/生活/问答/任务）+ content（### 标题 + 字段行原文；
 *                **生活事件在 content 里写 `- 标签：诚实,亲情`（从 tags 定义表选）**，工具自动解析进 tags 列）
 *   "course" —— 新增课程（courses 表）：topic（主题目录名，如 lunyu）+ title（课程名，如 论语先进篇第二十一章）
 *                （"progress" 是旧别名，兼容保留，新调用请用 "course"）
 *
 * 写入内容不进 LLM 上下文。data 主键已存在时返回 false（daily 是 append-only 历史，不覆盖）。
 */
export const kbInsertTool = defineTool({
  name: "kb_insert",
  label: "插入知识库条目（SQL）",
  description:
    "向 SQLite 知识库插入新条目，**内容不进上下文**（ISSUE-023 P2，SQLite 唯一真源）。\n\n" +
    "**table: \"daily\"**：写 daily 记录。`date`（YYYY-MM-DD）+ `block`（学习/生活/问答/任务）+ `content`（一条完整条目，`### 标题` 开头 + 字段行，**直接用已在回复中输出给孩子的学习总结原文**）。生活事件需在 content 里写 `- 标签：诚实,亲情` 字段行（标签只能从 `kb_query {query:\"tags\"}` 的定义表选）。\n" +
    "**table: \"course\"**：新增课程（courses 表）。`topic`（主题目录名，如 lunyu）+ `title`（课程名）；可选 `status`（⬜/✅）/ `mastery`（掌握度）/ `material`（教学资料）/ `sendMaterial`（要发送的学习资料）/ `tags`（课程标签，逗号分隔）。\n" +
    "**重复插入**：同主键已存在时返回 false（daily 历史不改，不覆盖）。\n" +
    "**注意**：只用于数据写入；method.md / materials/ 等内容文件仍用 write/edit。",
  parameters: Type.Object({
    table: Type.String({ description: "写入目标：daily | course（旧名 progress 兼容）" }),
    date: Type.Optional(Type.String({ description: "daily：日期 YYYY-MM-DD" })),
    block: Type.Optional(Type.String({ description: "daily：区块（学习/生活/问答/任务）" })),
    content: Type.Optional(Type.String({ description: "daily：完整条目文本（### 标题 + 字段行，生活事件含 - 标签：行）" })),
    topic: Type.Optional(Type.String({ description: "course：主题目录名（如 lunyu）" })),
    title: Type.Optional(Type.String({ description: "course：新课程名（如 论语先进篇第二十一章）" })),
    status: Type.Optional(Type.String({ description: "course：初始掌握状态（⬜/✅，缺省 ⬜）" })),
    mastery: Type.Optional(Type.String({ description: "course：初始掌握度（method 定义语义，如 良好）" })),
    material: Type.Optional(Type.String({ description: "course：教学资料（路径指针或描述，method 决定写法）" })),
    sendMaterial: Type.Optional(Type.String({ description: "course：要发送的学习资料" })),
    tags: Type.Optional(Type.String({ description: "course：课程标签（逗号分隔，从 tags 定义表选）" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const childDir = ctx.cwd;
    if (params.table === "daily") {
      if (!params.date || !params.block || !params.content) {
        throw new Error("kb_insert daily 需要 date + block + content");
      }
      const ok = insertDailyEntry(childDir, { date: params.date, block: params.block, title: params.content.match(/^###\s+(.+)$/m)?.[1]?.trim() ?? "", content: params.content });
      return {
        content: [
          {
            type: "text" as const,
            text: ok
              ? `已写入 daily ${params.date}「${params.block}」：${params.content.match(/^###\s+(.+)$/m)?.[1]?.trim() ?? "条目"}`
              : `daily ${params.date}「${params.block}」已存在同名条目，未重复写入（历史不改）`,
          },
        ],
      };
    }
    if (params.table === "course" || params.table === "progress") {
      if (!params.topic || !params.title) {
        throw new Error("kb_insert course 需要 topic + title（新课程名）");
      }
      const ok = insertCourse(childDir, {
        topic: params.topic,
        title: params.title,
        status: params.status,
        mastery: params.mastery,
        material: params.material,
        sendMaterial: params.sendMaterial,
        tags: params.tags,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: ok ? `已新增课程：${params.topic}「${params.title}」` : `课程已存在：${params.topic}「${params.title}」（未重复插入）`,
          },
        ],
      };
    }
    throw new Error(`kb_insert 支持 table: daily | course（当前: ${params.table}）`);
  },
});

/**
 * kb_update（SQL 更新字段）。
 *
 * 支持两类更新（table 必填）：
 *   "daily"  —— daily 条目字段：date + block + title + field + value
 *   "course" —— 课程进度字段（操作 courses 表）：topic + item（课程名）+ field + value；
 *     field 支持：状态/掌握状态（⬜/✅）、掌握度、首次学习(时间)、最近复习/复习时间/上次复习、
 *     复习次数（value 传 "+1" 自动递增）、教学资料、学习资料/要发送的学习资料、tags。
 *     **learned/total/next/updated 为视图自动计算，无需（也不可）手动更新。**
 *     （"progress" 是旧别名，兼容保留，新调用请用 "course"）
 *
 * 无需提供旧值，写入内容不进上下文。目标不存在返回 false。
 */
export const kbUpdateTool = defineTool({
  name: "kb_update",
  label: "更新知识库字段（SQL）",
  description:
    "按结构定位更新 SQLite 知识库的字段值，**无需提供旧值、内容不进上下文**（替代「读全文 + edit 重写」）。\n\n" +
    "**table: \"daily\"**：`date` + `block` + `title`（定位条目）+ `field` + `value`（新值）。\n" +
    "**table: \"course\"**：更新某门课程（courses 表）。`topic`（如 lunyu）+ `item`（**课程名必填**，如 论语先进篇第十七章）+ `field`（状态/掌握状态/掌握度/首次学习/最近复习/复习时间/上次复习/复习次数/教学资料/学习资料/tags）+ `value`。\n" +
    "**进度自动计算**：learned/total/next/updated 由视图实时计算，**不要**手动更新（传这些字段会被拒绝）。复习次数传 `value: \"+1\"` 自动递增。\n" +
    "**字段缺失时自动追加**（如新学一课补「掌握度/首次学习」）。\n" +
    "**只用于数据写入**；method.md / materials/ 等内容文件请用 write/edit。",
  parameters: Type.Object({
    table: Type.String({ description: "更新目标：daily | course（旧名 progress 兼容）" }),
    date: Type.Optional(Type.String({ description: "daily：日期 YYYY-MM-DD" })),
    block: Type.Optional(Type.String({ description: "daily：区块（学习/生活/问答/任务）" })),
    title: Type.Optional(Type.String({ description: "daily：条目标题" })),
    topic: Type.Optional(Type.String({ description: "course：主题名（如 lunyu）" })),
    item: Type.Optional(Type.String({ description: "course：课程名（必填，如 论语先进篇第十七章）" })),
    field: Type.String({ description: "字段名（course：状态/掌握度/首次学习/最近复习/复习次数/教学资料/学习资料/tags）" }),
    value: Type.String({ description: "新值（整字段替换）" }),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const childDir = ctx.cwd;
    if (params.table === "daily") {
      if (!params.date || !params.block || !params.title) {
        throw new Error("kb_update daily 需要 date + block + title + field + value");
      }
      const ok = updateDailyField(childDir, { date: params.date, block: params.block, title: params.title, field: params.field, value: params.value });
      if (!ok) throw new Error(`daily 条目不存在: ${params.date}「${params.block}」${params.title}`);
      return {
        content: [
          {
            type: "text" as const,
            text: `已更新 daily ${params.date}「${params.block}」${params.title}：${params.field}=${params.value}`,
          },
        ],
      };
    }
    if (params.table === "course" || params.table === "progress") {
      if (!params.topic) throw new Error("kb_update course 需要 topic（如 lunyu）");
      if (!params.item) throw new Error("kb_update course 需要 item（课程名，如 论语先进篇第十七章）");
      const ok = updateProgress(childDir, { topic: params.topic, item: params.item, field: params.field, value: params.value });
      if (!ok) throw new Error(`进度更新失败：主题「${params.topic}」课程「${params.item}」不存在`);
      return {
        content: [
          {
            type: "text" as const,
            text: `已更新 ${params.topic}「${params.item}」：${params.field}=${params.value}`,
          },
        ],
      };
    }
    throw new Error(`kb_update 支持 table: daily | course（当前: ${params.table}）`);
  },
});

/**
 * create_html_lesson（ISSUE-020）：把需求交给「编程 agent」生成/修改一份自包含 HTML 学习资料。
 *
 * 设计：学习 agent 不自己拼 HTML，而是把需求摘要（标题 + 结构要求 + 输出相对路径）传给编程 agent
 * （独立会话、可配置模型、cwd=孩子学习目录），编程 agent 只负责把 HTML 写到指定路径。
 * 生成成功后学习 agent 再用 display_content 展示（走既有 MaterialsPanel 链路，前端无需改）。
 *
 * 未配置「编程 agent 模型」时（设置页为空）会抛错并提示家长去设置页配置，不静默回退。
 */
export const createHtmlLessonTool = defineTool({
  name: "create_html_lesson",
  label: "编程 agent 生成/修改 HTML 学习资料",
  description:
    "把一份 HTML 学习资料的生成或修改需求交给「编程 agent」完成，产出落盘文件。\n\n" +
    "**用途**：当需要给孩子展示一份 html 格式学习资料、而该文件还不存在或需要修改时，先调用本工具生成/更新文件，再用 display_content 展示。\n\n" +
    "**参数**：`title`（课程标题）、`requirement`（需求描述：页面结构、内容要点、交互要求，尽可能具体）、`outputPath`（输出路径，相对学习目录，如 `learning/lunyu/materials/论语先进篇第十三章.html`，必须以 .html 结尾）、`sessionKey`（可选，同一份资料的生成与后续修改传相同值以复用上下文；缺省按 outputPath 自动派生）。\n\n" +
    "**返回**：生成的文件相对路径。成功后请立即用 display_content 展示给孩子。\n\n" +
    "**未配置时**：若家长未在设置页配置「编程 agent 模型」，本工具会报错，请告诉家长到设置页配置后重试。",
  parameters: Type.Object({
    title: Type.String({ description: "课程标题（如 论语先进篇第十三章）" }),
    requirement: Type.String({ description: "需求描述：页面结构、内容要点、交互要求（尽量具体，直接决定产出质量）" }),
    outputPath: Type.String({ description: "输出路径（相对学习目录，.html/.htm 结尾），如 learning/lunyu/materials/论语先进篇第十三章.html" }),
    sessionKey: Type.Optional(Type.String({ description: "会话键：同一份资料的生成/修改复用同一编程会话；缺省按 outputPath 派生" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    if (!params.title || !params.requirement || !params.outputPath) {
      throw new Error("create_html_lesson 需要 title / requirement / outputPath 参数");
    }
    const childId = path.basename(ctx.cwd);
    const result = await generateHtmlLesson({
      childId,
      title: params.title,
      requirement: params.requirement,
      outputPath: params.outputPath,
      sessionKey: params.sessionKey,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `已生成/更新 HTML 学习资料：${result.title}\n文件路径：${result.relPath}\n请用 display_content 展示给孩子。`,
        },
      ],
      details: { relPath: result.relPath, title: result.title },
    };
  },
});
