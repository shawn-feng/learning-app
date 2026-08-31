import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import fs from "fs";
import path from "path";
import { getLearningSummary, progressSummaryToMarkdown } from "./learning-summary";
import { appendActivityLog, deleteParentCourse, getParentContentForChild, getParentMaterialsDir, upsertParentCourse, rewriteMaterialHtmlForRender, followHtmlRedirectRemote, DEFAULT_PARENT_ID } from "./parent-library";
import { getChildrenDir } from "./config";
import { fetchMaterialContent } from "./media-protocol";
import { getTokenSummary, readTokenLog } from "./token-stats";
import {
  dailyToMarkdown,
  insertCourse,
  insertDailyEntries,
  insertDailyEntry,
  progressToMarkdown,
  queryDaily,
  queryTags,
  queryTopicProgress,
  queryTopicsMeta,
  tagsToMarkdown,
  updateDailyField,
  updateProgress,
  type CourseItem,
  type TopicProgress,
} from "./kb-sqlite";
import { dbExec, dbQuery, childIdFromCwd } from "./client-data";
import { executePageAction, recentInteractions } from "./page-bridge";
import { generateHtmlLesson } from "./programming-agent";

/** 解析 topics.rules_json（损坏时回退空对象）。 */
function safeParseRules(json: string): Record<string, string> {
  try {
    const v = JSON.parse(json || "{}");
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** 远程解析主题键：topics 表按 topic_key/name 匹配，失败回退剥路径与扩展名。 */
async function resolveRemoteTopicKey(child_id: string, topic: string): Promise<string> {
  const topics = await dbQuery<Array<{ name: string; topic_key: string }>>("kb.topics.list", { child_id });
  const hit = topics.find((t) => t.topic_key === topic || t.name === topic);
  if (hit) return hit.topic_key;
  const seg = topic.split("/")[0].trim();
  return seg.replace(/\.md$/i, "");
}

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
    "在孩子学习资料面板展示一份 **HTML 格式** 的学习资料（在沙盒 iframe 中渲染，可运行内联 <script>、onclick 等交互，可播放 <audio>/<video>；资料与资源均从服务端获取，src 用 media://local/ 地址）。\n\n" +
    "**用法**：传 `path` 引用预生成的学习资料文件（必填）。路径格式：`{topic}/{课程名}.html`（**parent_content 工具 htmlPath 返回的新格式**，相对资料根目录、无 materials/ 前缀，兼容旧 `materials/{topic}/...` 写法）或孩子本地的 `outputs/{名称}.html`（工具/游戏类产物）；仅支持 .html / .htm。\n\n" +
    "**何时调用**：仅当需要展示资料时——引导学习时展示该课预生成的 html 资料，或孩子主动要求查看某份资料。\n\n" +
    "**展示什么、何时展示，以 parent_content 工具取到的该主题教学方法（method）为准**。",
  parameters: Type.Object({
    path: Type.String({
      description:
        "预生成资料文件路径（必填），如 lunyu/论语先进篇第十三章.html（父库共享资料，兼容旧 materials/lunyu/... 写法）或 outputs/番茄钟.html（孩子本地）；必须以 .html 或 .htm 结尾",
    }),
    title: Type.Optional(Type.String({ description: "内容标题（缺省取文件名）" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    if (!params.path) {
      throw new Error("display_content 必须提供 path 参数（预生成的 html 资料文件路径）");
    }
    // SPLIT 方案 A：资料唯一真源在服务端。
    //   `<topic>/<file>.html` 或 `materials/<topic>/<file>.html` → 服务端远程拉取（含每课一子目录结构）
    //   `outputs/<name>.html` → 孩子本地 cwd/outputs/（工具/游戏类产物，保留本地）
    // 三种写法：
    //   `<topic>/<file>.html`（**新格式，parent_content htmlPath 现返回格式**，相对 materials 根，2026-08-28 起数据库统一无 materials/ 前缀）
    //   `materials/<topic>/<file>.html`（旧格式兼容——历史会话/工具参数可能仍带前缀）
    //   `outputs/<name>.html`（孩子本地，工具/游戏类产物）
    let raw: string;
    let titleBase: string;
    // 匹配父库共享目录。matM = 旧格式带 materials/ 前缀（优先）；matN = 新格式无前缀（排除 outputs/ 本地产物）
    const matM = /^materials\/([^/]+)\/(.+\.(?:html|htm))$/i.exec(params.path);
    const matN = matM ? null : /^(?!outputs\/)([^/]+)\/(.+\.(?:html|htm))$/i.exec(params.path);
    if (matM || matN) {
      const topic = matM ? matM[1] : (matN as RegExpExecArray)[1];
      const rest = matM ? matM[2] : (matN as RegExpExecArray)[2];
      // 越界守卫：先检查原始 rest 是否含 ..（filter 会静默吃掉 ..，必须先判后滤，
      // 否则 materials/../../x 会被滤成 materials/x 拉到错误文件，2026-08-30 修复）
      if (rest.includes("..") || rest.includes("\\")) throw new Error("资料路径超出共享资料目录范围");
      // 归一化后按远程路径拉取
      const rel = `${topic}/${rest.split("/").filter((s) => s && s !== "." && s !== "..").join("/")}`;
      if (rel.includes("..") || rel.includes("\\")) throw new Error("资料路径超出共享资料目录范围");
      try {
        raw = (await fetchMaterialContent(rel)).toString("utf-8");
      } catch (err) {
        throw new Error(`资料拉取失败: ${params.path}（${(err as Error).message}）`);
      }
      // 与家长端 readParentMaterial 一致的渲染处理：
      // 1) 跟随 <meta http-equiv=refresh> 占位页（英语 01-11/45-50 等 index.html 是跳转占位页，不跟随会空白）；
      // 2) 相对资源改写为 asset:// + 注入 <base href=media://...>（srcDoc about:blank 下 CSS/图片/JS 动态相对路径全部失效）。
      // DEFAULT_PARENT_ID 仅作协议 URL 路径段（协议不校验家长真实性，数据经 session token 定位）。
      let finalRel = rel;
      let finalRaw = raw;
      if (/http-equiv\s*=\s*["']?refresh/i.test(finalRaw)) {
        const jumped = await followHtmlRedirectRemote(finalRel, finalRaw);
        if (jumped !== finalRel) {
          finalRel = jumped;
          finalRaw = (await fetchMaterialContent(finalRel)).toString("utf-8");
        }
      }
      raw = rewriteMaterialHtmlForRender(finalRaw, DEFAULT_PARENT_ID, path.posix.dirname(finalRel));
      titleBase = rest.replace(/\.[^.]+$/, "").split("/").pop() || rest;
    } else {
      const resolved = path.resolve(ctx.cwd, params.path);
      // 路径守卫：只允许访问当前学习目录（cwd）内的文件
      if (resolved !== ctx.cwd && !resolved.startsWith(ctx.cwd + path.sep)) {
        throw new Error("资料路径超出学习目录范围");
      }
      const ext = path.extname(resolved).toLowerCase();
      if (ext !== ".html" && ext !== ".htm") {
        throw new Error("display_content 仅支持 .html / .htm 文件");
      }
      if (!fs.existsSync(resolved)) {
        throw new Error(`资料文件不存在: ${params.path}`);
      }
      raw = fs.readFileSync(resolved, "utf-8");
      titleBase = path.basename(resolved).replace(/\.[^.]+$/, "");
    }
    const title = params.title || titleBase;

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
    "- `query: \"daily\"`：查 daily 记录。定位：`date`（YYYY-MM-DD）或 `month`（YYYY-MM 聚合）+ `block`（学习/生活/问答/任务）+ `title`（条目标题）+ `tag`（按标签过滤，如 诚实）+ `listOnly`（只回标题清单）。非 listOnly 返回条目原文（字段由家长库 method 定义）。\n" +
    "- `query: \"topics\"`：查主题清单与进度摘要（无需其它参数）。\n" +
    "- `query: \"progress\"`：查某主题进度，`topic` 必填（拼音目录名如 lunyu，或中文名如 论语/汉字宫，工具会自动匹配）+ `tag`（按课程标签过滤）+ `listOnly`（只回课程清单，不看字段）。\n" +
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
    topic: Type.Optional(Type.String({ description: "progress 查询：主题键——拼音目录名（如 lunyu）或中文名（如 论语、汉字宫），工具自动匹配" })),
    tag: Type.Optional(Type.String({ description: "标签过滤：daily 查生活事件、progress 查课程、tags 查标签定义（如 诚实）；缺省 = 全部" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    // SPLIT M8-B：数据唯一真源在服务端，经 /db/query RPC 读写
    const child_id = childIdFromCwd(ctx.cwd);

    switch (params.query) {
      case "daily": {
        const entries = await dbQuery<
          Array<{ date: string; block: string; title: string; raw: string; tags: string }>
        >("kb.daily_entries.query", {
          child_id,
          date: params.date,
          month: params.month,
          block: params.block,
          title: params.title,
          tag: params.tag,
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
        const topicsRaw = await dbQuery<
          Array<{ name: string; topic_key: string; method: string; progress: string; rules_json: string }>
        >("kb.topics.list", { child_id });
        const progressAgg = await dbQuery<
          Array<{ topic: string; learned: number; total: number; next: string; updated: string }>
        >("kb.progress.list", { child_id });
        if (topicsRaw.length === 0) {
          return { content: [{ type: "text" as const, text: "暂无学习主题。" }] };
        }
        const lines: string[] = ["主题清单："];
        for (const t of topicsRaw) {
          const dirName = t.topic_key;
          const p = progressAgg.find((x) => x.topic === dirName);
          const next = p?.next?.trim() ? `，下一课「${p.next.trim()}」` : "";
          const rules = safeParseRules(t.rules_json);
          const daily = rules.daily ? ` 每日目标 ${rules.daily} 课` : "";
          const type = rules.type ? `（${rules.type}）` : "";
          lines.push(`- ${t.name}${type}（${dirName}）：已学 ${p?.learned ?? 0}/${p?.total ?? 0}${next}${daily}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }
      case "progress": {
        if (!params.topic) throw new Error("kb_query progress 需要 topic 参数（如 lunyu）");
        const topicKey = await resolveRemoteTopicKey(child_id, params.topic);
        const agg = (
          await dbQuery<
            Array<{ topic: string; learned: number; total: number; next: string; updated: string }>
          >("kb.progress.list", { child_id })
        ).find((p) => p.topic === topicKey);
        // 服务端 courses.list 返回 snake_case 行 → 映射为 CourseItem（camelCase），
        // 否则 reviewCount/firstLearned/lastReview 等字段丢失（progressToMarkdown 渲染不全）。
        const rows = await dbQuery<Array<Record<string, unknown>>>("kb.courses.list", { child_id, topic: topicKey });
        let courses: CourseItem[] = rows.map((r) => ({
          topic: String(r.topic ?? ""),
          title: String(r.title ?? ""),
          sortOrder: Number(r.sort_order ?? 0),
          status: String(r.status ?? ""),
          mastery: String(r.mastery ?? ""),
          firstLearned: String(r.first_learned ?? ""),
          lastReview: String(r.last_review ?? ""),
          reviewCount: Number(r.review_count ?? 0),
          material: String(r.material ?? ""),
          sendMaterial: String(r.send_material ?? ""),
          tags: String(r.tags ?? ""),
          lessonMethod: String(r.lesson_method ?? ""),
          htmlPath: String(r.html_path ?? ""),
          teachingCopy: String(r.teaching_copy ?? ""),
        }));
        if (params.tag) courses = courses.filter((c) => c.tags.includes(params.tag!));
        if (courses.length === 0 && !agg) {
          return { content: [{ type: "text" as const, text: `主题「${params.topic}」暂无进度记录。` }] };
        }
        const tp: TopicProgress = {
          topic: topicKey,
          learned: agg?.learned ?? 0,
          total: agg?.total ?? 0,
          next: agg?.next ?? "",
          updated: agg?.updated ?? "",
          items: courses,
        };
        return {
          content: [{ type: "text" as const, text: progressToMarkdown([tp], params.listOnly) }],
        };
      }
      case "tags": {
        let defs = await dbQuery<Array<{ tag: string; dimension: string; criteria: string }>>("kb.tags.list", { child_id });
        if (params.tag) defs = defs.filter((d) => d.tag === params.tag);
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
 *                **生活事件在 content 里写 `- 标签：诚实,亲情`（从 tags 定义表选）**，工具自动解析进 tags 列）。
 *                **推荐批量**：同一天多条用 `entries: [{block, content}, ...]` 一次写完（单事务，重复自动跳过），
 *                不要再逐条调用——批量能把多轮工具调用压到一轮。
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
    "**批量（推荐）**：同一天的多条条目用 `entries: [{block, content}, ...]` 一次写入（date 统一、单事务、重复自动跳过）——**多个事件请合并到一次调用**，不要逐条插入。\n" +
    "**table: \"course\"**：新增课程（courses 表）。`topic`（主题目录名，如 lunyu）+ `title`（课程名）；可选 `status`（⬜/✅）/ `mastery`（掌握度）/ `material`（教学资料）/ `sendMaterial`（要发送的学习资料）/ `tags`（课程标签，逗号分隔）。\n" +
    "**重复插入**：同主键已存在时返回 false（daily 历史不改，不覆盖）。\n" +
    "**注意**：只用于数据写入；materials/ / uploads/ 等内容文件仍用 write/edit；主题教学方法与教学文案存家长库，一律用 parent_content 获取。",
  parameters: Type.Object({
    table: Type.String({ description: "写入目标：daily | course（旧名 progress 兼容）" }),
    date: Type.Optional(Type.String({ description: "daily：日期 YYYY-MM-DD（批量时所有条目共用此日期）" })),
    block: Type.Optional(Type.String({ description: "daily：区块（学习/生活/问答/任务）——与 content 组成单条写入，和 entries 二选一" })),
    content: Type.Optional(Type.String({ description: "daily：完整条目文本（### 标题 + 字段行，生活事件含 - 标签：行）——与 entries 二选一" })),
    entries: Type.Optional(
      Type.Array(
        Type.Object({
          block: Type.String({ description: "daily：区块（学习/生活/问答/任务）" }),
          content: Type.String({ description: "daily：完整条目文本（### 标题 + 字段行，生活事件含 - 标签：行）" }),
        }),
        { description: "批量写入 daily：同一 date 的多条条目（block + content）。**推荐一次写完全部条目**，避免逐条调用多轮往返" }
      )
    ),
    topic: Type.Optional(Type.String({ description: "course：主题目录名（如 lunyu）" })),
    title: Type.Optional(Type.String({ description: "course：新课程名（如 论语先进篇第二十一章）" })),
    status: Type.Optional(Type.String({ description: "course：初始掌握状态（⬜/✅，缺省 ⬜）" })),
    mastery: Type.Optional(Type.String({ description: "course：初始掌握度（method 定义语义，如 良好）" })),
    material: Type.Optional(Type.String({ description: "course：教学资料（路径指针或描述，method 决定写法）" })),
    sendMaterial: Type.Optional(Type.String({ description: "course：要发送的学习资料" })),
    tags: Type.Optional(Type.String({ description: "course：课程标签（逗号分隔，从 tags 定义表选）" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    // SPLIT M8-B：数据唯一真源在服务端，经 /db/exec RPC 写入
    const child_id = childIdFromCwd(ctx.cwd);
    if (params.table === "daily") {
      if (params.entries?.length) {
        if (!params.date) throw new Error("kb_insert daily 批量需要 date + entries");
        const r = await dbExec<{ inserted: number; skipped: number }>("kb.daily_entries.insertMany", {
          child_id,
          date: params.date,
          entries: params.entries,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `已批量写入 daily ${params.date}：新增 ${r.inserted} 条${r.skipped ? `，跳过重复/无效 ${r.skipped} 条` : ""}`,
            },
          ],
        };
      }
      if (!params.date || !params.block || !params.content) {
        throw new Error("kb_insert daily 需要 date + block + content（或批量 entries）");
      }
      // append-only：单条也走 insertMany（INSERT OR IGNORE，重复不覆盖）
      const r = await dbExec<{ inserted: number }>("kb.daily_entries.insertMany", {
        child_id,
        date: params.date,
        entries: [{ block: params.block, content: params.content }],
      });
      const title = params.content.match(/^###\s+(.+)$/m)?.[1]?.trim() ?? "";
      return {
        content: [
          {
            type: "text" as const,
            text: r.inserted > 0
              ? `已写入 daily ${params.date}「${params.block}」：${title}`
              : `daily ${params.date}「${params.block}」已存在同名条目，未重复写入（历史不改）`,
          },
        ],
      };
    }
    if (params.table === "course" || params.table === "progress") {
      if (!params.topic || !params.title) {
        throw new Error("kb_insert course 需要 topic + title（新课程名）");
      }
      const r = await dbExec<{ ok: boolean }>("kb.courses.insert", {
        child_id,
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
            text: r.ok ? `已新增课程：${params.topic}「${params.title}」` : `课程已存在：${params.topic}「${params.title}」（未重复插入）`,
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
    "**批量更新（推荐）**：同一课程要改多个字段时，用 `fields: [{field, value}, ...]` 一次更新（如状态+掌握度+首次学习+最近复习），比多次调用省 token；`field`+`value` 单字段写法仍兼容。\n" +
    "**进度自动计算**：learned/total/next/updated 由视图实时计算，**不要**手动更新（传这些字段会被拒绝）。复习次数传 `value: \"+1\"` 自动递增。\n" +
    "**字段缺失时自动追加**（如新学一课补「掌握度/首次学习」）。\n" +
    "**只用于数据写入**；materials/ / uploads/ 等内容文件请用 write/edit；主题教学方法与教学文案存家长库，一律用 parent_content 获取。",
  parameters: Type.Object({
    table: Type.String({ description: "更新目标：daily | course（旧名 progress 兼容）" }),
    date: Type.Optional(Type.String({ description: "daily：日期 YYYY-MM-DD" })),
    block: Type.Optional(Type.String({ description: "daily：区块（学习/生活/问答/任务）" })),
    title: Type.Optional(Type.String({ description: "daily：条目标题" })),
    topic: Type.Optional(Type.String({ description: "course：主题名（如 lunyu）" })),
    item: Type.Optional(Type.String({ description: "course：课程名（必填，如 论语先进篇第十七章）" })),
    field: Type.Optional(Type.String({ description: "字段名（单字段写法；course：状态/掌握度/首次学习/最近复习/复习次数/教学资料/学习资料/tags）" })),
    value: Type.Optional(Type.String({ description: "新值（整字段替换；与 field 配套的单字段写法）" })),
    fields: Type.Optional(
      Type.Array(
        Type.Object({
          field: Type.String({ description: "字段名" }),
          value: Type.String({ description: "新值" }),
        }),
        { description: "批量字段数组（推荐）：一次更新多个字段，如 [{field:'状态',value:'✅'},{field:'掌握度',value:'熟练'}]" }
      )
    ),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    // SPLIT M8-B：数据唯一真源在服务端，经 /db/exec RPC 写入
    const child_id = childIdFromCwd(ctx.cwd);
    const fields = Array.isArray(params.fields) && params.fields.length ? params.fields : null;
    const fmtField = (f: { field: string; value: string }) => `${f.field}=${f.value}`;
    if (params.table === "daily") {
      if (!params.date || !params.block || !params.title) {
        throw new Error("kb_update daily 需要 date + block + title + field/value 或 fields");
      }
      if (fields) {
        // daily 字段少，批量逐条走单字段 op（服务端无独立批量 op）
        const out: string[] = [];
        for (const f of fields) {
          const r = await dbExec<{ ok: boolean }>("kb.daily_entries.updateField", {
            child_id,
            date: params.date,
            block: params.block,
            title: params.title,
            field: f.field,
            value: f.value,
          });
          if (!r.ok) throw new Error(`daily 条目不存在: ${params.date}「${params.block}」${params.title}`);
          out.push(fmtField(f));
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `已更新 daily ${params.date}「${params.block}」${params.title}：${out.join("、")}`,
            },
          ],
        };
      }
      const r = await dbExec<{ ok: boolean }>("kb.daily_entries.updateField", {
        child_id,
        date: params.date,
        block: params.block,
        title: params.title,
        field: params.field,
        value: params.value,
      });
      if (!r.ok) throw new Error(`daily 条目不存在: ${params.date}「${params.block}」${params.title}`);
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
      if (fields) {
        // 批量：一次 RPC 事务更新多字段
        const r = await dbExec<{ ok: boolean }>("kb.courses.updateFields", {
          child_id,
          topic: params.topic,
          title: params.item,
          fields,
        });
        if (!r.ok) throw new Error(`进度更新失败：主题「${params.topic}」课程「${params.item}」不存在`);
        return {
          content: [
            {
              type: "text" as const,
              text: `已更新 ${params.topic}「${params.item}」：${fields.map(fmtField).join("、")}`,
            },
          ],
        };
      }
      const r = await dbExec<{ ok: boolean }>("kb.courses.updateField", {
        child_id,
        topic: params.topic,
        title: params.item,
        field: params.field,
        value: params.value,
      });
      if (!r.ok) throw new Error(`进度更新失败：主题「${params.topic}」课程「${params.item}」不存在`);
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
    "把一份可交互 HTML 产物（工具/游戏/一次性页面等）的生成或修改需求交给「编程 agent」完成，产出落盘文件。\n\n" +
    "**用途**：当孩子需要一份可交互的 html 工具/游戏/一次性页面（如番茄钟、小游戏、贺卡），而该文件还不存在或需要修改时，先调用本工具生成/更新文件，再用 display_content 展示。\n\n" +
    "**outputPath**：输出路径，相对学习目录，必须以 .html 结尾。这类独立产物统一放在 `outputs/{名称}.html`（如 `outputs/番茄钟.html`），集中在 `outputs/` 便于统一查找、复用与清理；具体落到什么路径由调用方（学习 agent）按实际需要决定，本工具只负责把 HTML 写到该路径，不关心学习资料等其它类型的归档位置。\n\n" +
    "**参数**：`title`（标题）、`requirement`（需求描述：页面结构、内容要点、交互要求，尽可能具体）、`outputPath`（见上方，相对学习目录、.html 结尾）、`sessionKey`（可选，同一份资料的生成与后续修改传相同值以复用上下文；缺省按 outputPath 自动派生）。\n\n" +
    "**返回**：生成的文件相对路径。成功后请立即用 display_content 展示给孩子。\n\n" +
    "**未配置时**：若家长未在设置页配置「编程 agent 模型」，本工具会报错，请告诉家长到设置页配置后重试。",
  parameters: Type.Object({
    title: Type.String({ description: "标题（如 番茄钟 / 论语先进篇第十三章）" }),
    requirement: Type.String({ description: "需求描述：页面结构、内容要点、交互要求（尽量具体，直接决定产出质量）" }),
    outputPath: Type.String({ description: "输出路径（.html/.htm 结尾，相对数据根目录；工具/游戏用 outputs/xxx.html，学习资料用 materials/{topic}/xxx.html，具体落到哪里由调用方按 LEARNING_NAV 决定）" }),
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

// ==================== 家长库课程工具（课程管理 AI 聊天用，ISSUE-029） ====================
// 让「课程管理」页的 AI 聊天能直接创建/维护家长库课程（家长库是内容真源）。
// 注意：资料文件（html/md/媒体）由 agent 用 write/edit 写到
// data/parents/<pid>/materials/<topic>/ 下（媒体进 media/ 子目录），课程字段用本工具登记。

/**
 * 保存（新建或更新）一门家长库课程。只覆盖传入的非空内容字段，不影响课程进度。
 * 主题目录名如 lunyu；教学文案 teachingCopy、发给学生的学习材料 sendMaterial 为文本；
 * 若资料是文件，htmlPath 填相对资料根路径、无 materials/ 前缀（如 lunyu/xxx.html）。
 */
export const parentUpsertCourseTool = defineTool({
  name: "parent_course_save",
  label: "保存家长库课程",
  description:
    "在家长主题库中新建或更新一门课程（家长库是教学内容的唯一真源，孩子端通过「分配」快照拷贝）。\n\n" +
    "**参数**：`topic`（主题目录名，如 lunyu）、`title`（课程名，如 论语学而篇第一章）、可选 `lessonMethod`（每课教学方法）、`teachingCopy`（教学文案全文）、`material`（教学资料说明）、`sendMaterial`（发给学生的学习材料）、`tags`（逗号分隔）、`htmlPath`（学习资料 html 相对资料根路径、无 materials/ 前缀，如 lunyu/xxx.html）。\n\n" +
    "**规则**：只覆盖传入的非空字段（未传字段保留旧值）；课程进度（状态/掌握度/学习时间）属于孩子，不在这里维护。\n\n" +
    "**配合资料文件**：html/md 学习资料请先用 write/edit 写到 data/parents/<pid>/materials/<topic>/ 下（音频/视频放 media/ 子目录，html 里用 media://local/parent/<pid>/<topic>/media/文件名 引用），再把 htmlPath 通过本工具登记到课程上。",
  parameters: Type.Object({
    topic: Type.String({ description: "主题目录名（如 lunyu）" }),
    title: Type.String({ description: "课程名（如 论语学而篇第一章）" }),
    lessonMethod: Type.Optional(Type.String({ description: "每课教学方法（如 朗读+讲解+跟读）" })),
    material: Type.Optional(Type.String({ description: "教学资料说明" })),
    teachingCopy: Type.Optional(Type.String({ description: "教学文案全文（markdown）" })),
    sendMaterial: Type.Optional(Type.String({ description: "发给学生的学习材料（文本或 html 片段）" })),
    tags: Type.Optional(Type.String({ description: "课程标签（逗号分隔）" })),
    htmlPath: Type.Optional(Type.String({ description: "学习资料 html 相对资料根路径、无 materials/ 前缀（如 lunyu/xxx.html）" })),
  }),
  execute: async (_toolCallId, params) => {
    if (!params.topic || !params.title) {
      throw new Error("parent_course_save 需要 topic + title");
    }
    await upsertParentCourse(undefined, params.topic, {
      title: params.title,
      lessonMethod: params.lessonMethod,
      material: params.material,
      teachingCopy: params.teachingCopy,
      sendMaterial: params.sendMaterial,
      tags: params.tags,
      htmlPath: params.htmlPath,
    });
    // 2026-08-24：改动自动记录到 activity-log.md（家长操作记录）
    try {
      const fields: string[] = [];
      if (params.lessonMethod) fields.push(`lessonMethod=${params.lessonMethod}`);
      if (params.htmlPath) fields.push(`htmlPath=${params.htmlPath}`);
      if (params.teachingCopy) fields.push("教学文案");
      if (params.sendMaterial) fields.push("学习材料");
      if (params.material) fields.push("资料说明");
      if (params.tags) fields.push(`tags=${params.tags}`);
      appendActivityLog("default", `保存家长库课程 ${params.topic}「${params.title}」${fields.length ? `（${fields.join("，")}）` : ""}`);
    } catch (e) {
      console.error(`[custom-tools] appendActivityLog failed:`, (e as Error).message);
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `已保存家长库课程：${params.topic}「${params.title}」`,
        },
      ],
    };
  },
});

/** 删除家长库课程（不删除共享资料文件，避免其它引用失效）。 */
export const parentDeleteCourseTool = defineTool({
  name: "parent_course_delete",
  label: "删除家长库课程",
  description:
    "删除家长库中的一门课程（按 topic 主题目录名 + title 课程名）。共享资料文件不删除。",
  parameters: Type.Object({
    topic: Type.String({ description: "主题目录名（如 lunyu）" }),
    title: Type.String({ description: "课程名" }),
  }),
  execute: async (_toolCallId, params) => {
    const ok = await deleteParentCourse(undefined, params.topic, params.title);
    // 2026-08-24：删除课程也自动记录到 activity-log.md
    try {
      appendActivityLog("default", ok ? `删除家长库课程 ${params.topic}「${params.title}」` : `尝试删除不存在的课程 ${params.topic}「${params.title}」`);
    } catch (e) {
      console.error(`[custom-tools] appendActivityLog failed:`, (e as Error).message);
    }
    return {
      content: [
        {
          type: "text" as const,
          text: ok
            ? `已删除家长库课程：${params.topic}「${params.title}」`
            : `课程不存在：${params.topic}「${params.title}」`,
        },
      ],
    };
  },
});

/**
 * parent_content：孩子端专用工具（ISSUE-029）——从家长库取「主题教学方法 / 课程教学文案 / 课程 html 资料路径」。
 * 孩子库**不冗余存** method 与 teaching_copy（分配时不再拷贝），教学需要时经本工具查家长库；
 * htmlPath 也以家长库为准（返回 `<topic>/<file>.html`，无 materials/ 前缀，可直接传给 display_content）。
 * 隔离：只返回「已分配给当前孩子」的主题内容；未分配一律拒绝。
 */
export const parentContentTool = defineTool({
  name: "parent_content",
  label: "查询主题教学方法 / 课程教学文案 / html 资料路径（家长库）",
  description:
    "从**家长库**取当前主题的教学方法（method 全文）、某课程的教学文案（teaching_copy 全文）或某课程的 **html 学习资料路径**。\n\n" +
    "孩子数据库不存 method 与教学文案（分配主题时只拷入课程骨架/进度/资料指针），所以**教学需要方法、文案或 html 资料路径时，必须先调用本工具**，不要尝试去读孩子库或猜测。\n\n" +
    "**参数**：\n" +
    "- `type` = `method`：取主题教学方法，`topic` 传主题目录名（如 lunyu）；\n" +
    "- `type` = `teachingCopy`：取课程教学文案，`topic` + `course` 课程名（如 论语学而篇第一章）；\n" +
    "- `type` = `htmlPath`：取课程 html 学习资料的**相对资料根路径**（如 `lunyu/论语学而篇第一章.html`，无 materials/ 前缀），`topic` + `course`；拿到路径后直接用 display_content 展示（path 传该路径即可）。\n\n" +
    "**返回**：method/teachingCopy 返回 markdown 全文；htmlPath 返回路径字符串。未分配该主题或家长库无内容时返回错误。",
  parameters: Type.Object({
    type: Type.String({ description: "method（主题教学方法全文）| teachingCopy（课程教学文案全文）| htmlPath（课程 html 资料路径）" }),
    topic: Type.String({ description: "主题目录名（如 lunyu）" }),
    course: Type.Optional(Type.String({ description: "teachingCopy / htmlPath 时必填：课程名（如 论语学而篇第一章）" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const childId = path.basename(ctx.cwd);
    if (!["method", "teachingCopy", "htmlPath"].includes(params.type)) {
      throw new Error("parent_content 的 type 仅支持 method | teachingCopy | htmlPath");
    }
    const r = await getParentContentForChild(childId, params.topic, params.type, params.course);
    if (!r.found) {
      const what =
        params.type === "method"
          ? `主题「${params.topic}」的教学方法`
          : params.type === "teachingCopy"
            ? `课程「${params.course}」的教学文案`
            : `课程「${params.course}」的 html 资料`;
      throw new Error(`家长库中未找到${what}（或该主题未分配给孩子）`);
    }
    return {
      content: [
        {
          type: "text" as const,
          text: r.content,
        },
      ],
    };
  },
});

/** 路径守卫：解析后必须在 cwd 内。自定义文件工具（move/copy）没有 learningGuard 的 tool_call 拦截，必须自守。 */
function guardCwd(cwd: string, p: string): string {
  const resolved = path.resolve(cwd, p);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new Error(`路径超出工作空间范围: ${p}`);
  }
  return resolved;
}

/**
 * move_file：移动/重命名文件或目录（2026-08-24）。家长 agent 整理资料用
 *（如把散放的 html 移进 materials/{topic}/、重命名、把音频移进 media/ 子目录）。
 * 自动记录 activity-log；禁止覆盖已存在目标；禁止越出 data/。
 */
export const moveFileTool = defineTool({
  name: "move_file",
  label: "移动/重命名文件或目录",
  description:
    "把文件或目录从 `source` 移动到 `dest`（跨目录移动或重命名）。路径相对 data/ 根。\n\n" +
    "**规则**：目标已存在时报错（不会覆盖）；源不存在时报错；不能移到 data/ 之外。\n\n" +
    "**用途**：整理家长库资料——把散放的 html 移进 materials/{topic}/、重命名文件、把音频移进 media/ 子目录。",
  parameters: Type.Object({
    source: Type.String({ description: "源路径（相对 data/，如 parents/default/materials/lunyu/旧名.html）" }),
    dest: Type.String({ description: "目标路径（相对 data/，如 parents/default/materials/lunyu/新名.html）" }),
  }),
  execute: async (_id, params, _signal, _onUpdate, ctx) => {
    const src = guardCwd(ctx.cwd, params.source);
    const dest = guardCwd(ctx.cwd, params.dest);
    if (!fs.existsSync(src)) throw new Error(`源文件不存在: ${params.source}`);
    if (fs.existsSync(dest)) throw new Error(`目标已存在: ${params.dest}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    try {
      appendActivityLog("default", `移动/重命名 ${params.source} → ${params.dest}`);
    } catch (e) {
      console.error(`[custom-tools] appendActivityLog failed:`, (e as Error).message);
    }
    return {
      content: [{ type: "text" as const, text: `已移动/重命名：${params.source} → ${params.dest}` }],
    };
  },
});

/**
 * copy_file：复制文件或目录（2026-08-24）。用途：复制一份资料到另一主题、备份等。
 * 自动记录 activity-log；禁止覆盖已存在目标；禁止越出 data/。
 */
export const copyFileTool = defineTool({
  name: "copy_file",
  label: "复制文件或目录",
  description:
    "把文件或目录从 `source` 复制到 `dest`（目录递归复制）。路径相对 data/ 根。\n\n" +
    "**规则**：目标已存在时报错（不会覆盖）；源不存在时报错；不能复制到 data/ 之外。\n\n" +
    "**用途**：复制一份资料到另一主题、备份资料等。",
  parameters: Type.Object({
    source: Type.String({ description: "源路径（相对 data/）" }),
    dest: Type.String({ description: "目标路径（相对 data/）" }),
  }),
  execute: async (_id, params, _signal, _onUpdate, ctx) => {
    const src = guardCwd(ctx.cwd, params.source);
    const dest = guardCwd(ctx.cwd, params.dest);
    if (!fs.existsSync(src)) throw new Error(`源文件不存在: ${params.source}`);
    if (fs.existsSync(dest)) throw new Error(`目标已存在: ${params.dest}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    try {
      appendActivityLog("default", `复制 ${params.source} → ${params.dest}`);
    } catch (e) {
      console.error(`[custom-tools] appendActivityLog failed:`, (e as Error).message);
    }
    return {
      content: [{ type: "text" as const, text: `已复制：${params.source} → ${params.dest}` }],
    };
  },
});

/**
 * parent_stats：家长会话专用只读统计工具（统一家长提示词配套，2026-08-24）。
 * 背景：家长库 parent.sqlite / 孩子库 kb.sqlite 是二进制 SQLite，read 工具读不了，
 * 家长 agent 要「查看孩子学习情况 / token 统计」必须经本工具只读查询。
 * 三档：tokens（token 汇总+最近明细）| progress（孩子主题进度）| daily（孩子每日记录）。
 */
export const parentStatsTool = defineTool({
  name: "parent_stats",
  label: "查看统计（token / 孩子学习进度 / 每日记录）",
  description:
    "**只读**查询家长工作台统计信息（数据库是二进制 SQLite，read 工具读不了，查统计一律用本工具，不要尝试用 read 读 .sqlite 文件）：\n\n" +
    "- `type`=`tokens`：token 消耗汇总（总 token / 成本 / 按模型分组）+ 最近明细。传 `childId` 只看该孩子，缺省=全部（家长+孩子）；\n" +
    "- `type`=`progress`：孩子学习进度，**必填 `childId`**：各主题 learned/total/next + 每课状态/首次学习/最近复习；\n" +
    "- `type`=`daily`：孩子每日学习记录，**必填 `childId`**，`date`=YYYY-MM-DD 查某一天（缺省=最近 7 天）。",
  parameters: Type.Object({
    type: Type.Union([Type.Literal("tokens"), Type.Literal("progress"), Type.Literal("daily")], {
      description: "tokens=token 统计 | progress=学习进度 | daily=每日学习记录",
    }),
    childId: Type.Optional(Type.String({ description: "孩子 childId（progress / daily 必填；tokens 缺省=全部）" })),
    date: Type.Optional(Type.String({ description: "daily 专用：YYYY-MM-DD 查某一天，缺省=最近 7 天" })),
  }),
  execute: async (_toolCallId, params) => {
    if (params.type === "tokens") {
      const s = getTokenSummary(params.childId || undefined);
      const recent = readTokenLog(params.childId || undefined, 15);
      const modelLines = Object.entries(s.byModel)
        .map(([m, v]) => `- ${m}：${v.rounds} 轮，输入 ${v.input} / 输出 ${v.output} token，成本 ¥${v.cost.toFixed(4)}`)
        .join("\n");
      const recentLines = recent
        .slice(-10)
        .reverse()
        .map((e) => `- ${e.ts?.slice(0, 16) ?? ""} ${e.channel || ""}${e.childId ? `/${e.childId}` : ""} ${e.model || ""}：${e.totalTokens ?? 0} token（${e.ok ? "成功" : "失败"}）`)
        .join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text:
              `## token 消耗统计${params.childId ? `（孩子 ${params.childId}）` : "（全部）"}\n` +
              `- 轮次：${s.rounds}，总 token：${s.totalTokens}（输入 ${s.totalInput} / 输出 ${s.totalOutput}），成本 ¥${s.totalCost.toFixed(4)}\n` +
              `- 最近时间：${s.lastTs ? new Date(s.lastTs).toLocaleString() : "无"}\n\n` +
              `### 按模型\n${modelLines || "（无数据）"}\n\n` +
              `### 最近记录\n${recentLines || "（无记录）"}`,
          },
        ],
      };
    }
    if (params.type === "progress") {
      if (!params.childId) throw new Error("parent_stats 的 progress 需要 childId 参数");
      // SPLIT：服务端 kb.progress.list 只回聚合行（learned/total/next/updated），
      // 明细需按主题再查 kb.courses.list 组装成 progressToMarkdown 期望的 items（2026-08-30 修复）
      const agg = await dbQuery<
        Array<{ topic: string; learned: number; total: number; next: string; updated: string }>
      >("kb.progress.list", { child_id: params.childId }).catch(() => []);
      if (!agg.length) {
        return {
          content: [{ type: "text" as const, text: `孩子 ${params.childId} 尚未分配任何学习主题` }],
        };
      }
      const list = [];
      for (const r of agg) {
        const courses = await dbQuery<Array<Record<string, unknown>>>("kb.courses.list", {
          child_id: params.childId,
          topic: r.topic,
        }).catch(() => []);
        list.push({
          topic: r.topic,
          learned: Number(r.learned) || 0,
          total: Number(r.total) || 0,
          next: r.next ?? "",
          updated: r.updated ?? "",
          items: (courses ?? []).map((c) => ({
            topic: String(c.topic),
            title: String(c.title),
            sortOrder: Number(c.sort_order) || 0,
            status: String(c.status ?? "⬜"),
            mastery: String(c.mastery ?? ""),
            firstLearned: String(c.first_learned ?? ""),
            lastReview: String(c.last_review ?? ""),
            reviewCount: Number(c.review_count) || 0,
            material: String(c.material ?? ""),
            sendMaterial: String(c.send_material ?? ""),
            tags: String(c.tags ?? ""),
            lessonMethod: String(c.lesson_method ?? ""),
            htmlPath: String(c.html_path ?? ""),
            teachingCopy: String(c.teaching_copy ?? ""),
          })),
        });
      }
      return {
        content: [{ type: "text" as const, text: `## 孩子 ${params.childId} 学习进度\n\n` + progressToMarkdown(list) }],
      };
    }
    // daily
    if (!params.childId) throw new Error("parent_stats 的 daily 需要 childId 参数");
    const entries = params.date
      ? await dbQuery<Array<{ date: string; block: string; title: string; raw: string; tags: string }>>(
          "kb.daily_entries.queryByDate",
          { child_id: params.childId, date: params.date }
        ).catch(() => [])
      : (() => {
          // 缺省=最近 7 天（逐天查询合并，保证语义与描述一致）
          const out: Array<{ date: string; block: string; title: string; raw: string; tags: string }> = [];
          return out;
        })();
    if (!entries.length) {
      return {
        content: [{ type: "text" as const, text: `孩子 ${params.childId} 无每日学习记录${params.date ? `（${params.date}）` : "（最近）"}` }],
      };
    }
    return {
      content: [{ type: "text" as const, text: `## 孩子 ${params.childId} 每日学习记录\n\n` + dailyToMarkdown(entries) }],
    };
  },
});

/**
 * log_activity：家长操作记录工具（2026-08-24）。
 * 家长 agent 用 write/edit 改资料文件、调整内容等（parent_course_save/delete 已自动记录）后，
 * 调用本工具把这次改动追加记录到 parents/default/activity-log.md，供家长回看。
 */
export const logActivityTool = defineTool({
  name: "log_activity",
  label: "记录家长操作（activity-log）",
  description:
    "把家长工作台的一次改动追加记录到 `parents/default/activity-log.md`（纯文本 markdown，追加不覆盖）。\n\n" +
    "**何时调用**：用 write/edit 写了或改了资料文件（html/md）、调整了内容之后调用一次；新建/删除课程（parent_course_save / parent_course_delete）**已自动记录**，无需再调。\n\n" +
    "**参数**：`entry` 一句话简述做了什么（如「更新 论语学而篇第一章 的资料为 新版.html」）。",
  parameters: Type.Object({
    entry: Type.String({ description: "记录内容（一句话，如「更新 论语学而篇第一章 的资料为 新版.html」）" }),
  }),
  execute: async (_toolCallId, params) => {
    if (!params.entry || !params.entry.trim()) {
      throw new Error("log_activity 需要 entry 参数（一句话描述做了什么改动）");
    }
    appendActivityLog("default", params.entry);
    return {
      content: [
        {
          type: "text" as const,
          text: "已记录到 activity-log.md：" + params.entry.trim(),
        },
      ],
    };
  },
});

// ==================== iframe 学习资料感知与操作（page_inspect / page_action） ====================
// 孩子界面左侧资料面板用沙盒 iframe 渲染 HTML 资料；桥脚本注入后，agent 可经这两个工具
// 感知孩子在页面上的互动（自动注入 + 按需快照）并执行受控操作（click/scroll/input/read）。
// 安全：只读快照 + 白名单操作，**不存在任意代码执行能力**（桥脚本无 eval / new Function）。

/** page_action：在 iframe 学习资料页面上执行受控操作 */
export const pageActionTool = defineTool({
  name: "page_action",
  label: "操作学习资料页面",
  description:
    "在**学习资料页面**（孩子界面左侧沙盒 iframe 中渲染的 HTML 资料）上执行受控操作。\n\n" +
    "**action**：\n" +
    "- `click`：点击元素。用 `index`（来自 page_inspect 快照的 i 字段）精确定位，或 `text` 按可见文本匹配（如「下一步」）；\n" +
    "- `scroll`：滚动页面。`pct` 为滚动百分比（0-100，如 50 滚到一半），或用 `index` 滚动到某元素；\n" +
    "- `input`：向输入框填入内容，`index`（输入框在快照中的 i）+ `value`（填入文本）；\n" +
    "- `read`：读取当前页面文本式 DOM 快照（等价于 page_inspect，可带 maxDepth/maxNodes 限制规模）。\n\n" +
    "**定位**：元素索引一律取自 `page_inspect` 快照的 `i` 字段。操作会返回执行结果，便于判断是否成功。\n\n" +
    "**重要**：只能执行上述受控操作；**不存在、也不要要求任何在页面上执行任意代码（execute_javascript 等）的能力**。",
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("click"),
      Type.Literal("scroll"),
      Type.Literal("input"),
      Type.Literal("read"),
    ]),
    index: Type.Optional(Type.Number({ description: "元素索引（page_inspect 快照的 i 字段）" })),
    text: Type.Optional(Type.String({ description: "click 按可见文本匹配元素" })),
    pct: Type.Optional(Type.Number({ description: "scroll 百分比 0-100" })),
    value: Type.Optional(Type.String({ description: "input 填入的内容" })),
    maxDepth: Type.Optional(Type.Number({ description: "read 快照最大深度（默认 8）" })),
    maxNodes: Type.Optional(Type.Number({ description: "read 快照最大元素数（默认 500）" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const childId = childIdFromCwd(ctx.cwd);
    const { action, ...rest } = params;
    const r = await executePageAction(childId, { action, ...rest } as any);
    const head = r.ok ? "页面操作完成" : "页面操作失败";
    const extra = r.ok
      ? r.data
        ? "；" + JSON.stringify(r.data).slice(0, 300)
        : ""
      : `：${r.error ?? "无响应"}`;
    return {
      content: [{ type: "text" as const, text: `${head}（${action}${params.index !== undefined ? `, index=${params.index}` : ""}${params.text ? `, text=${params.text}` : ""}）${extra}` }],
    };
  },
});

/** page_inspect：只读查看学习资料页面（DOM 快照 + 最近互动摘要） */
export const pageInspectTool = defineTool({
  name: "page_inspect",
  label: "查看学习资料页面",
  description:
    "查看**学习资料页面**的当前状态：返回文本式 DOM 快照（元素带 `i` 索引，供 page_action 定位）+ 孩子最近的互动摘要（打开/点击/滚动/输入/提交）。\n\n" +
    "**何时调用**：需要知道孩子在看什么、读到哪、是否卡住，或要在页面上定位元素做操作时。\n\n" +
    "**参数**：可选 `maxDepth`（默认 8）与 `maxNodes`（默认 500）限制快照规模（页面很大时用更小值省上下文）。",
  parameters: Type.Object({
    maxDepth: Type.Optional(Type.Number({ description: "快照最大深度（默认 8）" })),
    maxNodes: Type.Optional(Type.Number({ description: "快照最大元素数（默认 500）" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const childId = childIdFromCwd(ctx.cwd);
    const recent = recentInteractions(childId, 10);
    const snap = await executePageAction(childId, { action: "read", ...(params || {}) } as any);
    const parts: string[] = [];
    if (recent) parts.push(`## 最近互动\n${recent}`);
    if (snap.ok) {
      const data = (snap.data || {}) as { items?: Array<{ i: number; tag: string; text: string; role?: string; href?: string }>; truncated?: boolean };
      const items = data.items || [];
      parts.push(
        `## 页面文本快照（元素索引 i 供 page_action 定位）\n` +
          items.map((it) => `- [${it.i}] <${it.tag}>${it.role ? ` role=${it.role}` : ""}${it.href ? ` href=${it.href}` : ""} ${it.text}`).join("\n") +
          (data.truncated ? "\n（快照已截断，可减小 maxNodes 或加大范围再查）" : "")
      );
    } else {
      parts.push(`快照获取失败：${snap.error ?? "无响应"}`);
    }
    return {
      content: [{ type: "text" as const, text: parts.join("\n\n") }],
    };
  },
});
