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
import { createExamSchedule } from "./exam";
import { currentSessionToken } from "./client-data";
import { serverFetch } from "./server-client";
import { listChildren } from "./child-auth";

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
    // ISSUE-021：家长共享资料的课程真实名称（按 topic + html_path 匹配 courses 查出；
    // agent 显式 title 优先，查不到时回退文件名）
    let courseTitle: string | undefined;
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
      // ISSUE-021：课名下传——按归一化后的 `topic/xxx.html` 匹配 courses.html_path，
      // 取课程真实名称（如「论语学而篇第一章」）作默认标题；优先孩子库快照，未命中再查家长库。
      // 匹配失败静默（不影响展示，列表仍显示文件名）。
      try {
        const childId = childIdFromCwd(ctx.cwd);
        const normPath = (p: string) =>
          p.replace(/\\/g, "/").replace(/^materials\//, "").replace(/^\.?\//, "").replace(/\/+/g, "/").trim();
        const want = normPath(rel);
        const kbCourses = await dbQuery<Array<Record<string, unknown>>>("kb.courses.list", {
          child_id: childId,
          topic,
        }).catch(() => []);
        const hit = kbCourses.find((c) => normPath(String(c.html_path ?? "")) === want);
        if (hit && hit.title) courseTitle = String(hit.title);
        if (!courseTitle) {
          const pcCourses = await dbQuery<Array<Record<string, unknown>>>("parent_lib.courses.list", {
            topic,
          }).catch(() => []);
          const pcHit = pcCourses.find((c) => normPath(String(c.html_path ?? "")) === want);
          if (pcHit && pcHit.title) courseTitle = String(pcHit.title);
        }
      } catch {
        /* 课名查询失败不阻断展示 */
      }
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
    const title = params.title || courseTitle || titleBase;

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
    "当你需要确认「下一课是什么」「已学多少」时，使用本工具，" +
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
          // rules_json.daily（每日目标）已停用（ISSUE-033）：每天学什么以学习计划为准，勿再向 agent 注入旧目标
          const type = rules.type ? `（${rules.type}）` : "";
          lines.push(`- ${t.name}${type}（${dirName}）：已学 ${p?.learned ?? 0}/${p?.total ?? 0}${next}`);
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

/**
 * 自定义考核排期（EXAM-REQUIREMENTS §14.2）：家长对话「什么时间考什么内容」→ 生成一次性考核排期。
 * ⚠️ 信息不全（缺孩子/缺时间/缺内容范围）时**必须 throw 提示向家长确认齐全**，不要猜着创建。
 */
export const examScheduleCreateTool = defineTool({
  name: "exam_schedule_create",
  label: "创建自定义考核排期",
  description:
    "为某个孩子创建一次**自定义考核排期**（家长通过对话预约：什么时间考什么内容，到点后孩子可在考核页点击开始）。\n\n" +
    "**参数**：`childName`（孩子姓名，必填）、`scheduledAt`（考核时间，ISO 格式如 2026-09-05T20:00:00，必填——把家长的「周五晚上」等说法换算成具体时间）、`topics`（可选，考核的主题目录名数组，如 [\"lunyu\"]）、`courses`（可选，限定课程名数组，如 [\"论语为政篇第一章\"]，不填则考该主题全部已学课）、`note`（可选，给孩子的说明，如「复习为政篇前两章」）。\n\n" +
    "**信息不全时（缺少 childName / scheduledAt / 考核内容范围之一）必须向家长确认清楚再创建**，不要自行猜测时间或范围。",
  parameters: Type.Object({
    childName: Type.String({ description: "孩子姓名（必填）" }),
    scheduledAt: Type.String({ description: "考核时间 ISO 格式（必填），如 2026-09-05T20:00:00" }),
    topics: Type.Optional(Type.Array(Type.String({ description: "主题目录名，如 lunyu" }))),
    courses: Type.Optional(Type.Array(Type.String({ description: "课程名，如 论语为政篇第一章" }))),
    note: Type.Optional(Type.String({ description: "考核内容说明（给孩子的提示）" })),
  }),
  execute: async (_toolCallId, params) => {
    const childName = (params.childName || "").trim();
    const scheduledAt = (params.scheduledAt || "").trim();
    if (!childName || !scheduledAt) {
      throw new Error("exam_schedule_create 需要 childName + scheduledAt（请向家长确认考核时间与考核对象）");
    }
    const hasScope = (params.topics?.length ?? 0) > 0 || (params.courses?.length ?? 0) > 0 || !!params.note;
    if (!hasScope) {
      throw new Error("请确认这次要考的内容：主题（topics）或课程（courses）至少填一个，或写一句说明（note）");
    }
    if (Number.isNaN(new Date(scheduledAt).getTime())) {
      throw new Error(`考核时间无法解析：${scheduledAt}，请用明确的时间（如 本周五 20:00）`);
    }
    // 按姓名匹配孩子
    const children = await listChildren().catch(() => []);
    const child = children.find((c: any) => c.name === childName || c.childName === childName);
    if (!child) {
      const names = children.map((c: any) => c.name || c.childName).join("、");
      throw new Error(`找不到孩子「${childName}」${names ? `（现有孩子：${names}）` : ""}`);
    }
    const childId = child.childId || child.id;
    const r = await createExamSchedule(
      childId,
      scheduledAt,
      { topics: params.topics ?? [], courses: params.courses ?? [], note: params.note ?? "" }
    );
    return {
      content: [
        {
          type: "text" as const,
          text: `已为孩子「${childName}」创建自定义考核排期（${scheduledAt}），${params.note ? `内容：${params.note}；` : ""}孩子到点后可在考核页点击开始。`,
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
    "从**家长库**取当前主题的教学方法（method 全文）、某课程的教学文案（teaching_copy 全文）、某课程的 **html 学习资料路径**、或某课程的**考核要点**（assess_rubric 全文）。\n\n" +
    "孩子数据库不存 method 与教学文案（分配主题时只拷入课程骨架/进度/资料指针），所以**教学需要方法、文案或 html 资料路径、考核需要要点时，必须先调用本工具**，不要尝试去读孩子库或猜测。\n\n" +
    "**参数**：\n" +
    "- `type` = `method`：取主题教学方法，`topic` 传主题目录名（如 lunyu）；\n" +
    "- `type` = `teachingCopy`：取课程教学文案，`topic` + `course` 课程名（如 论语学而篇第一章）；\n" +
    "- `type` = `assessRubric`：取课程**考核要点**（家长写的期望答到要点，出题/判分锚定用），`topic` + `course`；\n" +
    "- `type` = `htmlPath`：取课程 html 学习资料的**相对资料根路径**（如 `lunyu/论语学而篇第一章.html`，无 materials/ 前缀），`topic` + `course`；拿到路径后直接用 display_content 展示（path 传该路径即可）。\n\n" +
    "**返回**：method/teachingCopy/assessRubric 返回 markdown 全文；htmlPath 返回路径字符串。未分配该主题或家长库无内容时返回错误。",
  parameters: Type.Object({
    type: Type.String({ description: "method（主题教学方法全文）| teachingCopy（课程教学文案全文）| assessRubric（课程考核要点全文）| htmlPath（课程 html 资料路径）" }),
    topic: Type.String({ description: "主题目录名（如 lunyu）" }),
    course: Type.Optional(Type.String({ description: "teachingCopy / assessRubric / htmlPath 时必填：课程名（如 论语学而篇第一章）" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const childId = path.basename(ctx.cwd);
    if (!["method", "teachingCopy", "assessRubric", "htmlPath"].includes(params.type)) {
      throw new Error("parent_content 的 type 仅支持 method | teachingCopy | assessRubric | htmlPath");
    }
    const r = await getParentContentForChild(childId, params.topic, params.type, params.course);
    if (!r.found) {
      const what =
        params.type === "method"
          ? `主题「${params.topic}」的教学方法`
          : params.type === "teachingCopy"
            ? `课程「${params.course}」的教学文案`
            : params.type === "assessRubric"
              ? `课程「${params.course}」的考核要点`
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

// ==================== ISSUE-025：Todolist（今日计划） ====================

/** 本地时区 YYYY-MM-DD（不用 toISOString：UTC 会跨到错误的「今天」）。 */
export function todoLocalDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 解析 todolist markdown 的任务统计（确定性计算，供统计点落库 / 工具返回）。
 * 约定：`- [ ]` / `- [x]` 的 checkbox 行算任务；行内带「[家长]」标记的算家长规定项，
 * 其余为孩子自规划项（「[自己]」标记可有可无，无标记也算自规划项）。
 */
export function countTodoTasks(md: string): {
  total: number;
  done: number;
  parentTotal: number;
  parentDone: number;
  selfTotal: number;
  selfDone: number;
} {
  let total = 0;
  let done = 0;
  let parentTotal = 0;
  let parentDone = 0;
  let selfTotal = 0;
  let selfDone = 0;
  for (const line of md.split("\n")) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/.exec(line);
    if (!m) continue;
    total++;
    const isDone = m[1].toLowerCase() === "x";
    if (isDone) done++;
    const isParent = /\[家长\]/.test(m[2]);
    if (isParent) {
      parentTotal++;
      if (isDone) parentDone++;
    } else {
      selfTotal++;
      if (isDone) selfDone++;
    }
  }
  return { total, done, parentTotal, parentDone, selfTotal, selfDone };
}

/**
 * todo_list：读写孩子 Todolist（今日计划）markdown。
 * - read：返回指定日期（缺省=今天）的完整 todolist markdown；
 * - update：整体写入指定日期的 todolist markdown（覆盖式；写入前请先 read 拿到当前内容再改，
 *   避免丢掉已有项——尤其[家长]项）。
 * 数据存服务端（child_todos 表），多设备共享。**[家长]项（来自学习规则）不可删除/改文字，
 * 只能把 `[ ]` 改成 `[x]` 标记完成**——此约束由孩子 agent 提示词强制，本工具不解析内容。
 */
export const todoListTool = defineTool({
  name: "todo_list",
  label: "读写今日计划（Todolist）",
  description:
    "读写孩子当天的 Todolist（今日计划，markdown 格式，`- [ ]` 未完成 / `- [x]` 已完成）。\n\n" +
    "**read**：`action: \"read\"`，返回指定日期（`date` 缺省=今天）的完整 todolist 文本。\n" +
    "**update**：`action: \"update\"` + `markdown`（完整内容），整体覆盖写入。⚠️ 先 read 再改，不要凭空重写，否则会丢掉已有项。\n\n" +
    "**规则**：`[家长]` 标记的项来自家长的学习规则，**绝不能删除或修改文字**，只能把 `[ ]` 改成 `[x]` 标记完成；其余项（孩子自规划）可增删改。",
  parameters: Type.Object({
    action: Type.String({ description: "read=读取；update=写入" }),
    date: Type.Optional(Type.String({ description: "日期 YYYY-MM-DD（缺省=今天，本地时区）" })),
    markdown: Type.Optional(Type.String({ description: "update 时必填：完整的 todolist markdown" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const child_id = childIdFromCwd(ctx.cwd);
    if (!child_id) throw new Error("无法从会话目录解析 childId");
    const date = params.date || todoLocalDate();
    if (params.action === "read") {
      const todo = await dbQuery<{ date: string; itemsMd: string; updated: string } | null>("kb.todo.get", {
        child_id,
        date,
      });
      const text = todo?.itemsMd?.trim()
        ? todo.itemsMd
        : `${date} 还没有 todolist。`;
      return { content: [{ type: "text" as const, text }] };
    }
    if (params.action === "update") {
      if (!params.markdown) throw new Error("todo_list update 需要 markdown 参数（完整 todolist 内容）");
      await dbExec("kb.todo.put", { child_id, date, items_md: params.markdown });
      const c = countTodoTasks(params.markdown);
      return {
        content: [
          {
            type: "text" as const,
            text: `已保存 ${date} 的 todolist：共 ${c.total} 项（已完成 ${c.done}，家长规定 ${c.parentTotal} 项，自规划 ${c.selfTotal} 项）。`,
          },
        ],
      };
    }
    throw new Error("todo_list 的 action 仅支持 read / update");
  },
});

// ==================== ISSUE-033：学习计划（家长对话制定 → 逐日排期表，服务端 study_plans） ====================

/** 本地时区 YYYY-MM-DD（同 todoLocalDate，学习计划工具默认「今天」用本地时区，不落 UTC）。 */
function studyPlanLocalDate(): string {
  return todoLocalDate();
}

/** 校验日期 YYYY-MM-DD；非法抛错提示（agent 必须把家长口语换算成具体日期后再落库）。 */
function assertPlanDate(d: string, what = "日期"): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`${what}「${d}」格式不对，应为 YYYY-MM-DD（如 2026-09-05）；把家长说的日期换算成具体年月日再调用`);
  }
}

/** 按姓名匹配孩子 → childId；找不到时列出已有孩子姓名（与 exam_schedule_create 同一口径）。 */
async function resolvePlanChild(childName: string): Promise<{ childId: string; name: string }> {
  const name = (childName || "").trim();
  if (!name) throw new Error("缺少孩子姓名（childName）");
  const children = await listChildren().catch(() => []);
  const child = children.find((c: any) => c.name === name || c.childName === name);
  if (!child) {
    const names = children.map((c: any) => c.name || c.childName).join("、");
    throw new Error(`找不到孩子「${name}」${names ? `（现有孩子：${names}）` : ""}`);
  }
  return { childId: String(child.childId || child.id), name };
}

/** 服务端 GET /study-plans/today 的返回（当日家长排期行展平 items，供生成 [家长] todo 与查看某天）。 */
interface PlanTodayItems {
  ok: boolean;
  date: string;
  items: Array<{ planId: string; text: string; topicKey?: string; carry: boolean }>;
}

/** 服务端 GET /study-plans（列表）的行结构（snake→camel 映射后）。 */
interface StudyPlanRowDto {
  id: string;
  childId: string;
  kind: string;
  date: string;
  origin: string;
  content: Array<{ text: string; topicKey?: string }>;
  updatedAt: string;
}

/** 服务端 GET /study-plans 原始行（snake_case）。 */
interface StudyPlanRowRaw {
  id: string;
  childId: string;
  kind: string;
  date: string;
  origin: string;
  content: string;
  updatedAt: string;
}

function mapPlanRows(rows: StudyPlanRowRaw[]): StudyPlanRowDto[] {
  return rows.map((r) => {
    let content: Array<{ text: string; topicKey?: string }> = [];
    try {
      const arr = JSON.parse(r.content);
      if (Array.isArray(arr)) content = arr;
    } catch {
      /* 损坏内容置空 */
    }
    return {
      id: r.id,
      childId: r.childId,
      kind: r.kind,
      date: r.date,
      origin: r.origin,
      content,
      updatedAt: r.updatedAt,
    };
  });
}

/** 按 id（支持唯一前缀）从列表里定位行：找不到/不唯一时给最近日期提示（date 作为 agent 记忆锚点）。 */
function findPlanRowById(rows: StudyPlanRowDto[], id: string): StudyPlanRowDto {
  const trimmed = (id || "").trim();
  const exact = rows.find((r) => r.id === trimmed);
  if (exact) return exact;
  const byPrefix = rows.filter((r) => r.id.startsWith(trimmed));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) {
    throw new Error(`id 前缀「${trimmed}」匹配到 ${byPrefix.length} 行，请用 study_plan_list 拿完整 id`);
  }
  const sample = rows.slice(0, 3).map((r) => `${r.date}(${r.id.slice(0, 8)}…)`).join("、");
  throw new Error(
    `找不到 id=${trimmed} 的排期行${sample ? `。最近的排期行：${sample}——先用 study_plan_list 找到正确的那行 id` : "（该孩子还没有排期行，用 study_plan_create 新建）"}`
  );
}

/** 把行转成可读 markdown（回显用）。 */
function planRowsToMarkdown(rows: StudyPlanRowDto[]): string {
  if (rows.length === 0) return "（暂无排期行）";
  return rows
    .map((r) => {
      const tags = [r.origin === "carry" ? "📌 延续" : "", r.kind !== "date" ? `kind=${r.kind}` : ""]
        .filter(Boolean)
        .join(" ");
      const head = `- ${r.date}${tags ? `（${tags}）` : ""} [id=${r.id.slice(0, 8)}]`;
      const body = r.content.map((it) => `    - ${it.text}`).join("\n");
      return `${head}\n${body}`;
    })
    .join("\n");
}

/** 学习计划 · 创建排期行（study_plan_create）：家长「做什么（模糊也行）→ 查结构 → 排到哪些天」一次落库。 */
export const studyPlanCreateTool = defineTool({
  name: "study_plan_create",
  label: "创建学习计划排期（逐日）",
  description:
    "为某孩子创建**学习计划排期行**（「每天学什么」的逐日安排，服务端真源）。一次调用可以同时排**多天**（如整个 9 月的某主题），也可只排一天多课。\n\n" +
    "**参数**：`childName`（孩子姓名，必填）、`days`（必填：要排的日期数组，每项 = `date`（YYYY-MM-DD，具体哪天学）+ `content`（当天内容：**课程/章节名文本数组**，如 [\"论语先进篇第二章\"]；一天排多课就放多项））。\n\n" +
    "**用前先查**：排内容前先用 `study_plan_sources` 查该孩子的主题/课程结构，按实际存在的课程名安排；数量节奏（每天几课）由你按家长意图起草，**日期与内容不确定时先问家长，不要猜**。\n\n" +
    "**语义**：空天 = 不要求学，所以只排「有内容的那些天」；同一天想追加内容再调一次即可（同文本自动去重合并）。未学完的内容会在次日自动顺延（服务端每日检查），家长无需手动补。",
  parameters: Type.Object({
    childName: Type.String({ description: "孩子姓名（必填）" }),
    days: Type.Array(
      Type.Object({
        date: Type.String({ description: "哪天学，YYYY-MM-DD（如 2026-09-05）；家长说「周五」等口语先换算成日期" }),
        content: Type.Array(Type.String({ description: "当天要学的课程/章节名，如 论语先进篇第二章（一项一课）" })),
      }),
      { description: "排期日期数组（必填）：每项 = 某天的学习内容安排" }
    ),
  }),
  execute: async (_toolCallId, params) => {
    const { childId, name } = await resolvePlanChild(params.childName);
    if (!Array.isArray(params.days) || params.days.length === 0) {
      throw new Error("study_plan_create 需要 days（至少一天的学习安排）");
    }
    const created: string[] = [];
    for (const day of params.days) {
      const date = (day.date || "").trim();
      assertPlanDate(date, "排期日期");
      const textItems = Array.isArray(day.content) ? day.content.map((t) => String(t).trim()).filter(Boolean) : [];
      if (textItems.length === 0) {
        throw new Error(`${date} 没有内容：content 至少一项（这天空着就不用排）`);
      }
      if (textItems.length > 100) throw new Error(`${date} 内容超过 100 项上限`);
      // 同一天重复调用时先查已排文本，避免 create 语义下也制造重复行（服务端不做幂等，客户端去重）
      const existing = await serverFetch<{ ok: boolean; rows: StudyPlanRowRaw[] }>(
        `/study-plans?childId=${encodeURIComponent(childId)}&date=${encodeURIComponent(date)}`,
        {
          method: "GET",
          token: currentSessionToken(),
        }
      );
      const seen = new Set<string>();
      for (const r of existing.rows ?? []) {
        for (const it of mapPlanRows([r])[0].content) seen.add(it.text);
      }
      const fresh = textItems.filter((t) => !seen.has(t));
      if (fresh.length === 0) {
        created.push(`${date}：内容已存在，跳过`);
        continue;
      }
      const res = await serverFetch<{ ok: boolean; row: StudyPlanRowRaw }>("/study-plans", {
        method: "POST",
        body: {
          childId,
          date,
          kind: "date",
          content: fresh.map((text) => ({ text, topicKey: undefined })),
        },
        token: currentSessionToken(),
        timeoutMs: 15000,
      });
      created.push(`${date}：${fresh.length} 项`);
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `已为「${name}」创建学习计划：\n${created.map((c) => `- ${c}`).join("\n")}\n（未学完会自动顺延到次日；想改某天直接说，用 study_plan_list 看当前安排）`,
        },
      ],
    };
  },
});

/**
 * 学习计划 · 查看排期行列表（study_plan_list）：家长问「现在计划是什么/这周排了什么」、
 * 或需要行 id 来做 update/delete 时调用。
 */
export const studyPlanListTool = defineTool({
  name: "study_plan_list",
  label: "查看孩子学习计划（排期行列表）",
  description:
    "查看某孩子的**全部生效学习计划排期行**（按日期倒序，最多 500 行）。每行含：`date`（哪天）、`content`（那天学什么，一项一课）、`origin`（conversation=家长排的 / carry=📌 未学完顺延来的）、`id`（行 id——**改/删某行时用它**）。\n\n" +
    "**何时调用**：家长问「孩子现在排了什么计划」「这周/这个月怎么安排的」「某天学什么」；或 study_plan_update / 删某天之前，先 list 确认要动的行 id。\n\n" +
    "**可选过滤**：`from` / `to`（YYYY-MM-DD，只看该日期段，含边界）。",
  parameters: Type.Object({
    childName: Type.String({ description: "孩子姓名（必填）" }),
    from: Type.Optional(Type.String({ description: "只看此日期（含）之后的排期行，YYYY-MM-DD" })),
    to: Type.Optional(Type.String({ description: "只看此日期（含）之前的排期行，YYYY-MM-DD" })),
  }),
  execute: async (_toolCallId, params) => {
    const { childId, name } = await resolvePlanChild(params.childName);
    const rowsRaw = await serverFetch<{ ok: boolean; rows: StudyPlanRowRaw[] }>(
      `/study-plans?childId=${encodeURIComponent(childId)}`,
      {
        method: "GET",
        token: currentSessionToken(),
        timeoutMs: 15000,
      }
    );
    let rows = mapPlanRows(rowsRaw.rows ?? []);
    if (params.from) {
      assertPlanDate(params.from, "from");
      rows = rows.filter((r) => r.date >= params.from!);
    }
    if (params.to) {
      assertPlanDate(params.to, "to");
      rows = rows.filter((r) => r.date <= params.to!);
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `「${name}」的学习计划：\n${planRowsToMarkdown(rows)}`,
        },
      ],
    };
  },
});

/**
 * 学习计划 · 查某天安排（study_plan_get）：展示某一天孩子要学什么（含顺延来的 carry 项）。
 * 家长问「今天/9 月 5 号学什么」时用；date 缺省 = 本地今天。
 */
export const studyPlanGetTool = defineTool({
  name: "study_plan_get",
  label: "查看某天学习安排",
  description:
    "查看某孩子**某一天**的学习安排（当天排期行展平后的清单；📌 = 前一天没学完自动顺延来的）。\n\n" +
    "**参数**：`childName`（必填）、`date`（可选，YYYY-MM-DD；缺省 = 今天）。\n\n" +
    "**何时调用**：家长问「今天/明天/9 月 5 号学什么」「昨天没学的顺延了吗」。",
  parameters: Type.Object({
    childName: Type.String({ description: "孩子姓名（必填）" }),
    date: Type.Optional(Type.String({ description: "哪天，YYYY-MM-DD（缺省 = 今天）" })),
  }),
  execute: async (_toolCallId, params) => {
    const { childId, name } = await resolvePlanChild(params.childName);
    const date = (params.date || "").trim() || studyPlanLocalDate();
    assertPlanDate(date, "查询日期");
    const res = await serverFetch<PlanTodayItems>(
      `/study-plans/today?childId=${encodeURIComponent(childId)}&date=${encodeURIComponent(date)}`,
      {
        method: "GET",
        token: currentSessionToken(),
        timeoutMs: 15000,
      }
    );
    const items = res.items ?? [];
    if (items.length === 0) {
      return {
        content: [{ type: "text" as const, text: `「${name}」${date} 没有排学习内容（空天 = 不要求学）。` }],
      };
    }
    const lines = items.map((it) => `- ${it.carry ? "📌 " : ""}${it.text}`);
    return {
      content: [{ type: "text" as const, text: `「${name}」${date} 的学习安排：\n${lines.join("\n")}` }],
    };
  },
});

/**
 * 学习计划 · 修改/删除排期行（study_plan_update）：家长「9 月 5 号改成 X」「把某天的某课删掉」「停掉某行」。
 * 先 study_plan_list 拿行 id；act = replace（整行内容换成 content）/ removeItems（删当天部分课）/ delete（删整行）。
 */
export const studyPlanUpdateTool = defineTool({
  name: "study_plan_update",
  label: "修改学习计划（改某天 / 删部分课 / 删整行）",
  description:
    "修改某孩子**已有的排期行**（先 study_plan_list 拿到要动的行 id）。三种动作：\n\n" +
    "- `act: \"replace\"` + `id` + `content`（string[]）：把那一行的当天内容**整体替换**为新清单（家长「9 月 5 号改成只学数学两课」）。\n" +
    "- `act: \"removeItems\"` + `id` + `content`（string[]）：只**删掉其中的几项**，其余保留（家长「把 9 月 5 号英语那项去掉」；传要删的课程名）。\n" +
    "- `act: \"delete\"` + `id`：**删除整行**（家长「把 9 月 5 号的安排都取消」）。\n\n" +
    "**carry 行（📌 顺延来的）也可以改/删**——删掉即放弃补学。改完要给孩子看到最新安排，可用 study_plan_get 核对当天。",
  parameters: Type.Object({
    childName: Type.String({ description: "孩子姓名（必填）" }),
    act: Type.String({ description: "动作：replace（整行替换）| removeItems（删其中几项）| delete（删整行）" }),
    id: Type.String({ description: "目标排期行 id（study_plan_list 返回，形如 xxxx-…-xxxx；可传完整或前 8 位）" }),
    content: Type.Optional(Type.Array(Type.String({ description: "课程/章节名文本数组（replace 的新内容 / removeItems 要删的项）" }))),
  }),
  execute: async (_toolCallId, params) => {
    const { childId, name } = await resolvePlanChild(params.childName);
    const act = (params.act || "").trim();
    if (!["replace", "removeItems", "delete"].includes(act)) {
      throw new Error("study_plan_update 的 act 仅支持 replace / removeItems / delete");
    }
    // 先取全量列表（服务端无单行 GET，list 即真源）
    const rowsRaw = await serverFetch<{ ok: boolean; rows: StudyPlanRowRaw[] }>(
      `/study-plans?childId=${encodeURIComponent(childId)}`,
      {
        method: "GET",
        token: currentSessionToken(),
        timeoutMs: 15000,
      }
    );
    const rows = mapPlanRows(rowsRaw.rows ?? []);
    const row = findPlanRowById(rows, (params.id || "").trim());
    if (!row) throw new Error(`找不到 id 前缀「${wantId}」的排期行（先 study_plan_list 核对）`);

    if (act === "delete") {
      await serverFetch<{ ok: boolean }>(`/study-plans/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
        token: currentSessionToken(),
        timeoutMs: 15000,
      });
      return {
        content: [
          { type: "text" as const, text: `已删除「${name}」${row.date} 的学习安排（整行）。` },
        ],
      };
    }
    const textItems = Array.isArray(params.content) ? params.content.map((t) => String(t).trim()).filter(Boolean) : [];
    if (textItems.length === 0) throw new Error(`study_plan_update ${act} 需要 content（至少一项课程/章节名）`);
    if (textItems.length > 100) throw new Error("content 超过 100 项上限");
    const oldTexts = row.content.map((it) => it.text);
    const next: Array<{ text: string; topicKey?: string }> =
      act === "replace" ? textItems.map((text) => ({ text })) : oldTexts.filter((t) => !textItems.includes(t));
    if (next.length === 0) {
      // 全删光了 → 等价于删整行
      await serverFetch<{ ok: boolean }>(`/study-plans/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
        token: currentSessionToken(),
        timeoutMs: 15000,
      });
      return {
        content: [
          { type: "text" as const, text: `「${name}」${row.date} 的内容已全部移除（该行已删除，成为空天）。` },
        ],
      };
    }
    const res = await serverFetch<{ ok: boolean; row: StudyPlanRowRaw }>(`/study-plans/${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      body: { content: next },
      token: currentSessionToken(),
      timeoutMs: 15000,
    });
    const changed = oldTexts.filter((t) => !next.some((n) => n.text === t)).length;
    return {
      content: [
        {
          type: "text" as const,
          text:
            act === "replace"
              ? `已将「${name}」${row.date} 的安排替换为 ${next.length} 项。`
              : `已从「${name}」${row.date} 移除 ${changed} 项，剩余 ${next.length} 项。`,
        },
      ],
    };
  },
});

/**
 * 学习计划 · 只读课程结构（study_plan_sources，R3 拍板形态）：起草排期前查孩子主题/课程结构。
 * 只读、最小权限：列主题 + 每主题课程数/已学/未学清单，不放开 kb_query 写能力。
 */
export const studyPlanSourcesTool = defineTool({
  name: "study_plan_sources",
  label: "查看孩子课程结构（起草计划用）",
  description:
    "查看某孩子的**课程结构**（只读，起草学习计划前先查这里，不猜课程名）：列出孩子每个主题（如 论语 lunyu）下**有哪些课、哪些还没学**，供你把家长意图落到具体课程/章节。\n\n" +
    "**参数**：`childName`（必填）、`topic`（可选，只查某个主题——主题键如 lunyu 或中文名；不填则列全部主题的概览 + 未学课程清单）。\n\n" +
    "**何时调用**：家长说「把先进篇排一下」「数学还有多少没学」等需要知道课程结构/数量才能安排的时候；已学完的课程不用再排。",
  parameters: Type.Object({
    childName: Type.String({ description: "孩子姓名（必填）" }),
    topic: Type.Optional(Type.String({ description: "主题键或中文名（如 lunyu / 论语）；缺省 = 全部主题" })),
  }),
  execute: async (_toolCallId, params) => {
    const { childId, name } = await resolvePlanChild(params.childName);
    const topics = await dbQuery<Array<{ name: string; topic_key: string; rules_json: string }>>("kb.topics.list", {
      child_id: childId,
    });
    if (topics.length === 0) {
      return {
        content: [{ type: "text" as const, text: `「${name}」还没有分配任何学习主题（先去「课程管理」给孩子分配主题，才能排计划）。` }],
      };
    }
    const aggAll = await dbQuery<Array<{ topic: string; learned: number; total: number; next: string }>>("kb.progress.list", {
      child_id: childId,
    });
    const wantTopic = (params.topic || "").trim();
    const targetTopic = wantTopic
      ? topics.find((t) => t.topic_key === wantTopic || t.name === wantTopic)
      : undefined;
    if (wantTopic && !targetTopic) {
      const keys = topics.map((t) => `${t.name}(${t.topic_key})`).join("、");
      throw new Error(`找不到主题「${wantTopic}」${keys ? `（孩子的主题：${keys}）` : ""}`);
    }
    const lines: string[] = [`「${name}」的课程结构：`];
    for (const t of wantTopic && targetTopic ? [targetTopic] : topics) {
      const key = t.topic_key;
      const agg = aggAll.find((p) => p.topic === key);
      const learned = agg?.learned ?? 0;
      const total = agg?.total ?? 0;
      const rules = safeParseRules(t.rules_json);
      const dailyNote = rules.daily ? `（旧规则曾设每天 ${rules.daily} 课，已停用；新计划在对话里说）` : "";
      // 取课程清单（含已学状态），未学的单列
      const rows = await dbQuery<Array<Record<string, unknown>>>("kb.courses.list", { child_id: childId, topic: key });
      const titles = rows.map((r) => String(r.title ?? ""));
      const statusOf = (title: string) => rows.find((r) => String(r.title) === title)?.status ?? "";
      const notLearned = titles.filter((ti) => statusOf(ti) !== "✅");
      lines.push(`- ${t.name}（${key}）：共 ${total} 课，已学 ${learned}${notLearned.length ? `，未学 ${notLearned.length} 课` : "，已全部学完 ✅"}${dailyNote}`);
      // 全主题模式只列未学；指定主题模式列全部课 + 状态（供「重排已学课复习」）
      const show = wantTopic ? titles.map((ti) => `${ti}${statusOf(ti) === "✅" ? "（已学）" : "（未学）"}`) : notLearned.map((ti) => `${ti}（未学）`);
      if (show.length > 0) {
        const cap = show.length > 40 ? show.slice(0, 40).concat([`… 其余 ${show.length - 40} 课略`]) : show;
        for (const s of cap) lines.push(`    - ${s}`);
      }
    }
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  },
});

// ==================== 家长库只读查询（parent_library_topics / parent_library_courses） ====================
// ISSUE-033 补充：家长 agent 制定学习计划前需要了解「家长库教学内容」（家长库 parent.sqlite 是权威名册），
// 与 study_plan_sources（孩子库已学/未学）互补——家长库含全部可学主题/课程（含未分配给孩子、孩子快照后
// 新增的课），起草与核对课程名以家长库为准。只读、最小权限，不放权写。
interface ParentLibTopicRow {
  name: string;
  topic_key: string;
  method: string;
  assess_method: string;
  rules_json: string;
}

async function loadParentLibTopics(): Promise<ParentLibTopicRow[]> {
  return dbQuery<ParentLibTopicRow[]>("parent_lib.topics.list", {}).catch(() => []);
}

/** 家长库主题总览：每个主题的课程数 / html 资料覆盖 / method / 考核方法状态。 */
export const parentLibraryTopicsTool = defineTool({
  name: "parent_library_topics",
  label: "家长库主题总览（只读）",
  description:
    "查看**家长库（教学内容库）的主题总览**：每个主题有多少门课程、html 资料齐不齐、教学方法和考核方法有没有写。\n\n" +
    "**何时调用**：家长要让某主题进学习计划，但不确定孩子库里有没有、或想了解家长库全部可学主题时（如「给 xx 排个计划」起草前核对主题内容）；**家长库是权威名册**——含还没分配给孩子、或孩子快照之后才新增的课程。要查某主题的具体课程清单用 parent_library_courses。",
  parameters: Type.Object({}),
  execute: async (_toolCallId, _params) => {
    const topics = await loadParentLibTopics();
    if (topics.length === 0) {
      return {
        content: [{ type: "text" as const, text: "家长库还没有主题。家长先在「课程管理」页新建主题/导入课程，之后才能给孩子排学习计划。" }],
      };
    }
    const allCourses = await dbQuery<Array<Record<string, unknown>>>("parent_lib.courses.list", {}).catch(() => []);
    const byTopic = new Map<string, Array<Record<string, unknown>>>();
    for (const c of allCourses ?? []) {
      const key = String(c.topic ?? "");
      if (!key) continue;
      const arr = byTopic.get(key) ?? [];
      arr.push(c);
      byTopic.set(key, arr);
    }
    const lines: string[] = [`家长库主题总览（共 ${topics.length} 个）：`];
    let grandTotal = 0;
    let grandHtml = 0;
    for (const t of topics) {
      const courses = byTopic.get(t.topic_key) ?? [];
      const total = courses.length;
      const html = courses.filter((c) => String(c.html_path ?? "").trim()).length;
      grandTotal += total;
      grandHtml += html;
      const methodTxt = t.method?.trim() ? "method 已写" : "method 未写";
      const assessTxt = t.assess_method?.trim() ? "考核方法已写" : "考核方法未写";
      let rules: Record<string, string> = {};
      try { rules = JSON.parse(t.rules_json || "{}"); } catch { rules = {}; }
      const typeTxt = rules.type ? ` · 类型 ${rules.type}` : "";
      const lack = total && html < total ? `（缺 ${total - html} 份资料）` : "";
      lines.push(`- ${t.name}（${t.topic_key}）：共 ${total} 课，html 资料 ${html}${lack} · ${methodTxt} · ${assessTxt}${typeTxt}`);
    }
    lines.push(`合计：${grandTotal} 课 / html 资料 ${grandHtml} 份。`);
    lines.push("提示：主题要先在「孩子管理 → 学习主题」分配给孩子，孩子才能学、也才能排进学习计划；某主题的课程名册用 parent_library_courses 查。");
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
});

/** 家长库某主题的课程名册（权威课程名）：起草排期按这里的中文课程名安排。 */
export const parentLibraryCoursesTool = defineTool({
  name: "parent_library_courses",
  label: "家长库课程名册（只读）",
  description:
    "查看**家长库某主题下的完整课程名册**（权威名册，含孩子快照后新增的课），每门课标注有无 html 资料与标签。\n\n" +
    "**参数**：`topic`（必填，主题键如 lunyu 或中文名 论语）、`keyword`（可选，只列标题包含该词的课，如「先进篇」）、`limit`（默认 80，1~200）、`offset`（翻页，默认 0）。\n\n" +
    "**何时调用**：给某主题起草学习计划、要按真实课程名逐日安排时（如家长说「把论语先进篇学完」，先查先进篇的课名清单）；**课程名以此工具返回为准，不要编造**。",
  parameters: Type.Object({
    topic: Type.String({ description: "主题键或中文名（如 lunyu / 论语），必填" }),
    keyword: Type.Optional(Type.String({ description: "只列标题包含此词的课程（如 先进篇 / 第 5 章）" })),
    limit: Type.Optional(Type.Number({ description: "最多列多少门（默认 80，最大 200）" })),
    offset: Type.Optional(Type.Number({ description: "跳过前 N 门（翻页用，默认 0）" })),
  }),
  execute: async (_toolCallId, params) => {
    const want = (params.topic || "").trim();
    if (!want) throw new Error("parent_library_courses 需要 topic（主题键如 lunyu 或中文名）");
    const topics = await loadParentLibTopics();
    const hit = topics.find((t) => t.topic_key === want || t.name === want);
    if (!hit) {
      const names = topics.map((t) => `${t.name}(${t.topic_key})`).join("、");
      throw new Error(`家长库找不到主题「${want}」${names ? `（现有主题：${names}）` : ""}`);
    }
    const rows = await dbQuery<Array<Record<string, unknown>>>("parent_lib.courses.list", { topic: hit.topic_key });
    let list = rows ?? [];
    const kw = (params.keyword || "").trim();
    if (kw) list = list.filter((c) => String(c.title ?? "").includes(kw));
    const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? 80)));
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const shown = list.slice(offset, offset + limit);
    const lines: string[] = [];
    lines.push(`「${hit.name}（${hit.topic_key}）」课程名册${kw ? `（标题含「${kw}」）` : ""}：共 ${list.length} 门，显示 ${offset + 1}~${offset + shown.length}：`);
    if (shown.length === 0) {
      lines.push("（没有匹配的课程）");
    }
    for (const c of shown) {
      const title = String(c.title ?? "").trim();
      if (!title) continue;
      const html = String(c.html_path ?? "").trim() ? "有资料" : "无资料";
      const tags = String(c.tags ?? "").trim();
      lines.push(`- ${title}（${html}）${tags ? `[${tags}]` : ""}`);
    }
    if (offset + shown.length < list.length) {
      lines.push(`… 其余 ${list.length - offset - shown.length} 门略（可加 keyword 过滤或用 offset=${offset + limit} 翻页）`);
    }
    lines.push("起草排期时课程名以此名册为准，不要编造。");
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
});
