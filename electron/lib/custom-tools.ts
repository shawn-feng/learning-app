import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { getLearningSummary, progressSummaryToMarkdown } from "./learning-summary";
import {
  appendItemToBlock,
  extractFrontmatter,
  findBlock,
  findField,
  findItem,
  isItemChunk,
  listItemTitles,
  parseFieldLine,
  splitBlocks,
  splitItems,
  updateFieldValue,
} from "./kb-parser";
import { DAILY_BLOCKS, TAG_BLOCKS, detectDataFileKind, legalFieldsFor } from "./kb-schema";

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
 * ===== 知识库结构化工具（kb_read / kb_patch / kb_append）=====
 * 依据 LEARNING-DATA-SPEC.md 5.3：查询只回目标区块/条目，写入内容不进 LLM 上下文。
 * 共用 kb-parser（结构解析）+ kb-schema（字段白名单），Path Guard 同 display_content。
 */

/** 路径守卫：仅允许访问 cwd（孩子学习目录）内文件；返回解析后的绝对路径。 */
function resolveInCwd(cwd: string, file: string): string {
  const resolved = path.resolve(cwd, file);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new Error(`路径超出学习目录范围: ${file}`);
  }
  return resolved;
}

/** 拆解 ref 简写："daily/2026-08-13.md#生活" → { file, block }。无 # 时 block 为空。 */
function parseRef(ref: string): { file: string; block?: string } {
  const idx = ref.indexOf("#");
  if (idx < 0) return { file: ref };
  return { file: ref.slice(0, idx), block: ref.slice(idx + 1) || undefined };
}

export const kbReadTool = defineTool({
  name: "kb_read",
  label: "结构化读取知识库",
  description:
    "按结构定位读取知识库数据文件的目标区块/条目，**只返回目标内容，绝不整文件返回**（省 token）。\n\n" +
    "**定位**：`file`（相对学习目录，如 daily/2026-08-19.md）+ `block`（## 区块标题，如 生活）+ `item`（### 条目标题或 1-based 序号，如 2）。\n" +
    "**ref 简写**：`ref: \"daily/2026-08-19.md#生活\"` 等价于 `{file, block:\"生活\"}`（与数据文件里的指针写法一致，见 life 索引的「关联」行）。\n" +
    "**listOnly**：只返回该区块内全部条目标题清单（先看有哪些再定点读，比盲猜标题省 token）。\n" +
    "**month 聚合**：`{month: \"2026-08\", block: \"学习\", listOnly: true}` 提取该月所有 daily 文件指定区块的条目标题清单（按日期分组，按需生成不持久化）。",
  parameters: Type.Object({
    file: Type.Optional(Type.String({ description: "数据文件路径（相对学习目录）。与 ref 二选一，同传时 ref 优先" })),
    ref: Type.Optional(Type.String({ description: "指针简写：文件路径 + 可选 #区块锚点，如 daily/2026-08-19.md#生活" })),
    block: Type.Optional(Type.String({ description: "## 区块标题（缺省 = 整个文件正文）" })),
    item: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "### 条目标题或 1-based 序号" })),
    listOnly: Type.Optional(Type.Boolean({ description: "true 时只返回条目标题清单，不返回内容" })),
    month: Type.Optional(Type.String({ description: "month 聚合：YYYY-MM，配合 block（+listOnly）提取该月所有 daily 指定区块的条目标题" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const { file: fileFromRef, block: blockFromRef } = params.ref ? parseRef(params.ref) : { file: undefined, block: undefined };
    const file = params.file ?? fileFromRef ?? "";
    const block = params.block ?? blockFromRef;
    if (!file && !params.month) {
      throw new Error("kb_read 必须提供 file（或 ref / month 聚合）");
    }

    // month 聚合：读 daily/{month}-*.md，提取 block 的条目标题
    if (params.month) {
      if (!block) throw new Error("month 聚合必须提供 block（如 学习）");
      const dailyDir = path.join(ctx.cwd, "daily");
      let files: string[];
      try {
        files = (await fsp.readdir(dailyDir))
          .filter((f) => f.startsWith(params.month!) && f.endsWith(".md"))
          .sort();
      } catch {
        throw new Error(`daily 目录不存在或无 ${params.month} 文件`);
      }
      if (files.length === 0) throw new Error(`没有 ${params.month} 的 daily 文件`);
      const lines: string[] = [];
      for (const f of files) {
        const text = await fsp.readFile(path.join(dailyDir, f), "utf-8");
        const titles = listItemTitles(text, block);
        for (const t of titles) {
          for (const it of t.items) lines.push(`${f.replace(/\.md$/, "")} | ${it}`);
        }
      }
      return {
        content: [{ type: "text" as const, text: lines.length ? lines.join("\n") : `${params.month} 无 ${block} 条目` }],
      };
    }

    const resolved = resolveInCwd(ctx.cwd, file);
    let text: string;
    try {
      text = await fsp.readFile(resolved, "utf-8");
    } catch {
      throw new Error(`文件不存在: ${file}`);
    }
    const fm = extractFrontmatter(text);
    const bodyLines = (fm ? fm.body : text).split(/\r?\n/);
    const blocks = splitBlocks(bodyLines);

    // block 缺省 = 整个文件正文
    if (!block) {
      const body = (fm ? fm.body : text).replace(/\n+$/, "\n");
      return { content: [{ type: "text" as const, text: body || "(空文件)" }] };
    }
    const blk = findBlock(blocks, block);
    if (!blk) throw new Error(`区块不存在: ${block}（可选: ${blocks.map((b) => b.title).join("、") || "无"}）`);
    const items = splitItems(blk.lines);

    // listOnly：只回标题清单
    if (params.listOnly) {
      return {
        content: [
          {
            type: "text" as const,
            text: items.length ? items.map((it, i) => `${i + 1}. ${it.title}`).join("\n") : `「${block}」区块暂无条目`,
          },
        ],
      };
    }
    // 无 item：返回整个区块
    if (params.item === undefined) {
      return { content: [{ type: "text" as const, text: blk.lines.join("\n") }] };
    }
    const it = findItem(items, params.item);
    if (!it) {
      throw new Error(`条目不存在: ${params.item}（可选: ${items.map((i) => i.title).join("、") || "无"}）`);
    }
    return { content: [{ type: "text" as const, text: it.lines.join("\n") }] };
  },
});

export const kbPatchTool = defineTool({
  name: "kb_patch",
  label: "定位更新知识库字段",
  description:
    "按结构定位更新数据文件的某个字段值，**无需提供旧值、文件内容不进上下文**（替代「读全文 + edit 重写」）。\n\n" +
    "**定位**：`file` + `item`（### 条目标题或序号；frontmatter 用固定值 \"frontmatter\"）+ `field`（字段名，frontmatter 用 \"frontmatter:learned\" 形式）+ `value`（新值，整行替换）。\n" +
    "**批量**：`fields: [{field, value}, ...]` 一次更新同一条目多个字段。\n" +
    "**校验**：字段名必须在该文件类型的白名单内（daily 学习区块合法字段：课程名/考核/掌握度/难点/错题/孩子表现；进度条目：状态/掌握度/复习次数/最近复习/tags），非法字段名直接拒绝并提示合法值。\n" +
    "**只用于数据文件**（daily/、learning/、life/、inquiries/、tasks/、tags/），method.md / materials/ 等内容文件请用 write/edit。",
  parameters: Type.Object({
    file: Type.String({ description: "数据文件路径（相对学习目录）" }),
    item: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "### 条目标题或序号；更新 frontmatter 时传 \"frontmatter\"" })),
    field: Type.Optional(Type.String({ description: "字段名（如 掌握度）；frontmatter 用 frontmatter:key" })),
    value: Type.Optional(Type.String({ description: "新值（整行替换）" })),
    fields: Type.Optional(Type.Array(Type.Object({ field: Type.String(), value: Type.String() }), { description: "批量字段更新（同条目）" })),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const file = params.file;
    const kind = detectDataFileKind(file);
    if (!kind) {
      throw new Error(`kb_patch 仅支持数据文件（daily/、learning/、life|inquiries|tasks/、tags/）；${file} 是内容文件，请用 write/edit`);
    }
    const updates = params.fields ?? (params.field && params.value !== undefined ? [{ field: params.field, value: params.value }] : []);
    if (updates.length === 0) throw new Error("kb_patch 需要 field+value 或 fields[]");

    const resolved = resolveInCwd(ctx.cwd, file);
    const text = await fsp.readFile(resolved, "utf-8");

    // frontmatter 更新（field 形如 frontmatter:learned）
    const fmUpdates = updates.filter((u) => u.field.startsWith("frontmatter:"));
    const bodyUpdates = updates.filter((u) => !u.field.startsWith("frontmatter:"));

    // —— 字段白名单校验：daily 需要 block 定位，先解析定位再做字段校验 ——
    if (bodyUpdates.length > 0) {
      const fm = extractFrontmatter(text);
      const bodyLines = (fm ? fm.body : text).split(/\r?\n/);
      const blocks = splitBlocks(bodyLines);
      // daily 文件：需先按 block 定位条目（field 校验按区块）
      if (kind === "daily" && !params.block) {
        throw new Error(`kb_patch daily 文件需要 block 参数（## 区块标题，如 ${DAILY_BLOCKS.join("/")}）`);
      }
      const blk = params.block ? findBlock(blocks, params.block) : null;
      if (params.block && !blk) throw new Error(`区块不存在: ${params.block}`);
      const legalHere = legalFieldsFor(kind, blk?.title);
      const illegal = bodyUpdates.filter((u) => legalHere && !legalHere.includes(u.field));
      if (illegal.length > 0) {
        throw new Error(`非法字段: ${illegal.map((u) => u.field).join("、")}（${kind === "daily" ? `「${blk?.title}」区块` : "该文件"}合法字段: ${legalHere?.join("/") ?? "不限"}）`);
      }
    }

    // —— 执行更新（先整体解析验证，再做替换）——
    let result = text;
    // frontmatter 区更新
    if (fmUpdates.length > 0) {
      const fm = extractFrontmatter(text);
      if (!fm) throw new Error("文件没有 frontmatter，无法更新 frontmatter:key");
      let fmLines = fm.data.split(/\r?\n/);
      for (const u of fmUpdates) {
        const key = u.field.slice("frontmatter:".length);
        let found = false;
        fmLines = fmLines.map((line) => {
          const m = /^([A-Za-z_][\w]*):(.*)$/.exec(line);
          if (m && m[1] === key) {
            found = true;
            return `${m[1]}: ${u.value}`;
          }
          return line;
        });
        if (!found) fmLines.push(`${key}: ${u.value}`);
      }
      result = `---\n${fmLines.join("\n")}\n---\n${fm.body}`;
    }
    // 正文区更新
    if (bodyUpdates.length > 0) {
      const fm = extractFrontmatter(result);
      const bodyLines = (fm ? fm.body : result).split(/\r?\n/);
      const blocks = splitBlocks(bodyLines);
      // 进度文件等无 ## 区块的文件：把整个正文视为隐式区块（条目直接挂在文件级）
      const blk =
        (params.block ? findBlock(blocks, params.block) : blocks[0] ?? null) ??
        (blocks.length === 0 ? { title: "", start: 0, end: bodyLines.length, lines: bodyLines } : null);
      if (!blk) throw new Error("无法定位区块");
      const items = splitItems(blk.lines);
      if (params.item === undefined) throw new Error("kb_patch 正文更新需要 item（### 条目标题或序号，frontmatter 用 \"frontmatter\"）");
      const it = findItem(items, params.item);
      if (!it) throw new Error(`条目不存在: ${params.item}（可选: ${items.map((i) => i.title).join("、") || "无"}）`);
      let itemLines = [...it.lines];
      const missing: string[] = [];
      for (const u of bodyUpdates) {
        const r = updateFieldValue(itemLines, u.field, u.value);
        if (!r.hit) {
          missing.push(u.field);
        } else {
          itemLines = r.lines;
        }
      }
      // 字段不存在时自动追加到条目尾（recording 真实场景：新学一课要补「掌握度/首次学习」等原本没有的字段）。
      // 字段格式跟随条目内已有字段（`键:: 值` 或 `- 键：值`），无则按文件类型默认。
      if (missing.length > 0) {
        const existingSep = itemLines.map(parseFieldLine).find((h) => h !== null)?.sep ?? (kind === "daily" ? "dash-colon" : "dcolon");
        for (const f of missing) {
          const u = bodyUpdates.find((x) => x.field === f)!;
          itemLines.push(existingSep === "dash-colon" ? `- ${f}：${u.value}` : `${f}:: ${u.value}`);
        }
      }
      // 用更新后的条目行替换原区块中的条目
      const newBlockLines = [
        ...blk.lines.slice(0, it.start),
        ...itemLines,
        ...blk.lines.slice(it.end),
      ];
      const updatedLines = [...bodyLines.slice(0, blk.start), ...newBlockLines, ...bodyLines.slice(blk.end)];
      const newBody = updatedLines.join("\n");
      result = fm ? `---\n${fm.data}\n---\n${newBody}` : newBody;
    }

    await fsp.writeFile(resolved, result, "utf-8");
    return {
      content: [
        {
          type: "text" as const,
          text: `已更新 ${file}${params.block ? ` 「${params.block}」` : ""}${params.item !== undefined ? `「${typeof params.item === "string" ? params.item : `#${params.item}`}」` : ""}${updates.map((u) => `${u.field}=${u.value}`).join(", ")}`,
        },
      ],
    };
  },
});

export const kbAppendTool = defineTool({
  name: "kb_append",
  label: "向知识库区块追加条目",
  description:
    "向数据文件的指定区块尾部追加一条完整条目（如 daily 的新学习总结、life 月索引新行），**文件内容不进上下文**。\n\n" +
    "**定位**：`file` + `block`（## 区块标题；缺省 = 追加到文件尾）+ `content`（一条完整条目文本）。\n" +
    "daily 的 `content` 以 `### 标题` 开头——**通常直接使用 method 流程已在回复中输出给孩子的学习总结原文**（如 `### 论语先进篇第十七章\\n- 考核：…\\n- 孩子表现：…`），工具只校验结构（### 开头、区块合法），**不校验字段名**（字段质量由 method 输出流程保证，lint 定时兜底）。\n" +
    "life/inquiries/tasks 月索引的 content 以 `## 日期 标题` 开头（条目标题须与 daily 对应 ### 标题同名，见 SPEC 3.6）。\n" +
    "tags 倒排：block 为 关联知识点/关联生活事件。\n" +
    "**文件不存在时自动创建**（如当日 daily 首次写入），无需先用 write 建文件。",
  parameters: Type.Object({
    file: Type.String({ description: "数据文件路径（相对学习目录）" }),
    block: Type.Optional(Type.String({ description: "## 区块标题（缺省 = 追加到文件尾）" })),
    content: Type.String({ description: "要追加的条目文本（### 或 ## 标题开头 + 字段行）" }),
  }),
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    const { file, block, content } = params;
    const kind = detectDataFileKind(file);
    if (!kind || (kind !== "daily" && kind !== "index" && kind !== "tags")) {
      throw new Error(`kb_append 仅支持追加到 daily/、life|inquiries|tasks/、tags/ 文件；${file} 不允许追加`);
    }
    const resolved = resolveInCwd(ctx.cwd, file);
    const exists = fs.existsSync(resolved);

    // 结构校验（不做字段白名单校验：content 是 method 流程已输出给孩子的学习总结原文，直接追加；
    // 字段质量由 method 输出流程保证，事后由 lint（5.5）兜底）
    if (kind === "daily") {
      if (!block) throw new Error(`kb_append daily 文件需要 block 参数（${DAILY_BLOCKS.join("/")}）`);
      if (!(DAILY_BLOCKS as readonly string[]).includes(block)) {
        throw new Error(`非法区块: ${block}（合法: ${DAILY_BLOCKS.join("/")}）`);
      }
      if (!isItemChunk(content)) {
        throw new Error("daily 追加内容必须以 `### 标题` 开头");
      }
    } else if (kind === "tags") {
      if (block && !(TAG_BLOCKS as readonly string[]).includes(block)) {
        throw new Error(`非法区块: ${block}（合法: ${TAG_BLOCKS.join("/")}）`);
      }
    }

    // 文件不存在：自动创建（daily 当日文件、life 月索引等首次写入场景；内容不进上下文）
    if (!exists) {
      let created = "";
      if (kind === "daily") {
        const date = file.replace(/^daily\//, "").replace(/\.md$/, "");
        created = `# ${date}\n\n## ${block}\n\n${content}\n`;
      } else {
        created = `${content}\n`;
      }
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      await fsp.writeFile(resolved, created, "utf-8");
      return {
        content: [{ type: "text" as const, text: `已创建 ${file} 并写入「${block ?? "文件尾"}」` }],
      };
    }

    const text = await fsp.readFile(resolved, "utf-8");
    const fm = extractFrontmatter(text);
    const bodyLines = (fm ? fm.body : text).split(/\r?\n/);
    let updatedLines: string[];
    if (block) {
      const r = appendItemToBlock(bodyLines, block, content);
      if (!r.block) {
        // 区块不存在：在文件尾自动创建新区块（当天先写「学习」再追加「生活」等场景）
        const trimmed = bodyLines.filter((l) => l.trim() !== "");
        updatedLines = [...trimmed, "", `## ${block}`, "", ...content.split(/\r?\n/), ""];
      } else {
        updatedLines = r.lines;
      }
    } else {
      // 追加到文件尾
      const tail = bodyLines.filter((l) => l.trim() === "").length > 0 ? [] : [""];
      updatedLines = [...bodyLines, ...(bodyLines[bodyLines.length - 1]?.trim() === "" ? [] : [""]), ...content.split(/\r?\n/), ""];
    }
    const newText = fm ? `---\n${fm.data}\n---\n${updatedLines.join("\n")}` : updatedLines.join("\n");
    await fsp.writeFile(resolved, newText, "utf-8");
    return {
      content: [{ type: "text" as const, text: `已追加到 ${file}${block ? `「${block}」` : "文件尾"}` }],
    };
  },
});
