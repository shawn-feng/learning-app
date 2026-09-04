/**
 * 服务端无头 worker 的工具集（方案B 阶段②）。
 * 与客户端 custom-tools.ts 的 kb 三件套 / todo_list / get_date 语义对齐，
 * 但**不经过 /db/query|exec RPC**：直接用服务端 handler（routes/db.ts 导出的 queryHandlers/execHandlers）
 * 读写孩子 kb，减少一层网络往返且归属校验（children.parent_id）同样生效。
 * 格式化为紧凑 markdown（worker 任务用已提供上下文为主，kb_query 仅作核对）。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import { runKbQuery, runKbExec } from "../routes/db.js";

export interface WorkerBindings {
  dataDir: string;
  mainDb: DatabaseSync;
  parentId: string;
  childId: string;
}

// ---------- 格式化（紧凑版，与客户端 kb-sqlite 渲染语义对齐） ----------

/** 工具返回辅助：SDK 的 AgentToolResult 要求 details 字段（服务端副本类型更严格）。 */
function ok(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function tagsToMarkdownLite(defs: Array<{ tag: string; dimension: string; criteria: string }>): string {
  if (!defs.length) return "（无标签定义）";
  return defs.map((d) => `- ${d.tag}（${d.dimension}）：${d.criteria}`).join("\n");
}

function dailyToMarkdownLite(
  entries: Array<{ date: string; block: string; title: string; raw: string; tags: string }>,
  listOnly?: boolean
): string {
  if (!entries.length) return "（无记录）";
  const blocks = ["学习", "生活", "问答", "任务"] as const;
  const lines: string[] = [];
  for (const b of blocks) {
    const inBlock = entries.filter((e) => e.block === b);
    if (!inBlock.length) continue;
    lines.push(`【${b}】`);
    for (const e of inBlock) {
      if (listOnly) lines.push(`- ${e.title}`);
      else lines.push(e.raw.trimEnd());
    }
  }
  return lines.join("\n");
}

function progressToMarkdownLite(
  rows: Array<{ topic: string; learned: number; total: number; next: string; updated: string }>,
  listOnly?: boolean
): string {
  if (!rows.length) return "（暂无学习主题进度）";
  return rows
    .map(
      (p) =>
        `- ${p.topic}（${p.topic}）：已学 ${p.learned}/${p.total}` +
        (p.next?.trim() ? `，下一课「${p.next.trim()}」` : "") +
        (p.updated?.trim() ? `，最近更新 ${p.updated}` : "")
    )
    .join("\n");
}

// ---------- 工具工厂（按家长+孩子绑定） ----------

/** 创建 worker ephemeral 会话使用的工具（kb_query / kb_insert / kb_update / todo_list / get_date）。 */
export function createWorkerKbTools(b: WorkerBindings) {
  const query = <T = unknown>(op: string, args: Record<string, unknown>): T =>
    runKbQuery(b.dataDir, b.mainDb, b.parentId, op, { child_id: b.childId, ...args }) as T;
  const exec = <T = unknown>(op: string, args: Record<string, unknown>): T =>
    runKbExec(b.dataDir, b.mainDb, b.parentId, op, { child_id: b.childId, ...args }) as T;

  const getDateTool = defineTool({
    name: "get_date",
    label: "获取当前日期时间",
    description: "返回当前的准确日期和时间（YYYY-MM-DD 星期几 HH:mm:ss）。",
    promptSnippet: "get_date - 获取当前的准确日期和时间",
    parameters: Type.Object({}),
    execute: async () => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
      return {
        content: [{ type: "text" as const, text: `现在是 ${dateStr}（${weekdays[d.getDay()]}）${timeStr}。` }],
        details: { date: dateStr, time: timeStr },
      };
    },
  });

  const kbQueryTool = defineTool({
    name: "kb_query",
    label: "SQL 查询知识库",
    description:
      "从 SQLite 查询知识库数据（daily 记录 / 主题进度 / 标签定义），只返回目标内容，省 token。\n" +
      "query 类型：\n" +
      "- `daily`：查 daily 记录。`date`（YYYY-MM-DD）或 `month`（YYYY-MM）+ `block`（学习/生活/问答/任务）+ `title` + `tag` + `listOnly`。\n" +
      "- `topics`：查主题清单与进度摘要（无需其它参数）。\n" +
      "- `progress`：查某主题进度，`topic` 必填（拼音目录名或中文名）+ `tag`（课程标签过滤）+ `listOnly`。\n" +
      "- `tags`：查标签定义（词表 + 判断标准），`tag`（缺省=全部）。",
    parameters: Type.Object({
      query: Type.String({ description: "查询类型：daily | topics | progress | tags" }),
      date: Type.Optional(Type.String({ description: "daily 查询：精确日期 YYYY-MM-DD" })),
      month: Type.Optional(Type.String({ description: "daily 查询：月份聚合 YYYY-MM" })),
      block: Type.Optional(Type.String({ description: "daily 查询：区块（学习/生活/问答/任务）" })),
      title: Type.Optional(Type.String({ description: "daily 查询：条目标题精确匹配" })),
      listOnly: Type.Optional(Type.Boolean({ description: "true 只返回标题清单" })),
      topic: Type.Optional(Type.String({ description: "progress 查询：主题键（lunyu 或 论语）" })),
      tag: Type.Optional(Type.String({ description: "标签过滤" })),
    }),
    execute: async (_tc, params) => {
      switch (params.query) {
        case "daily": {
          const entries = query<Array<{ date: string; block: string; title: string; raw: string; tags: string }>>(
            "kb.daily_entries.query",
            { date: params.date, month: params.month, block: params.block, title: params.title, tag: params.tag }
          );
          const scope = params.date
            ? `${params.date}${params.block ? ` ${params.block}` : ""}`
            : params.month
              ? `${params.month}${params.block ? ` ${params.block}` : ""}`
              : "全部 daily";
          return ok(`${scope}记录：\n${dailyToMarkdownLite(entries, params.listOnly)}`);
        }
        case "topics": {
          const topics = query<Array<{ name: string; topic_key: string; rules_json: string }>>("kb.topics.list", {});
          const agg = query<Array<{ topic: string; learned: number; total: number; next: string; updated: string }>>("kb.progress.list", {});
          if (!topics.length) return ok("暂无学习主题。");
          const lines: string[] = ["主题清单："];
          for (const t of topics) {
            const p = agg.find((x) => x.topic === t.topic_key);
            let rules: Record<string, string> = {};
            try { rules = JSON.parse(t.rules_json || "{}"); } catch { rules = {}; }
            // rules_json.daily（每日目标）已停用（ISSUE-033）：每天学什么以学习计划为准，勿再注入旧目标
            const type = rules.type ? `（${rules.type}）` : "";
            lines.push(`- ${t.name}${type}（${t.topic_key}）：已学 ${p?.learned ?? 0}/${p?.total ?? 0}${p?.next?.trim() ? `，下一课「${p.next.trim()}」` : ""}`);
          }
          return ok(lines.join("\n"));
        }
        case "progress": {
          if (!params.topic) throw new Error("kb_query progress 需要 topic 参数（如 lunyu）");
          const agg = query<Array<{ topic: string; learned: number; total: number; next: string; updated: string }>>("kb.progress.list", {});
          const rows = query<Array<{ topic: string; title: string; status: string; tags: string }>>("kb.courses.list", { topic: params.topic });
          let courses = rows;
          if (params.tag) courses = courses.filter((c) => c.tags?.includes(params.tag!));
          if (!courses.length && !agg.length) {
            return ok(`主题「${params.topic}」暂无进度记录。`);
          }
          const lines: string[] = [];
          lines.push(`主题「${params.topic}」：已学 ${agg.find((p) => p.topic === params.topic)?.learned ?? 0}/${agg.find((p) => p.topic === params.topic)?.total ?? 0}`);
          if (!params.listOnly) {
            for (const c of courses) {
              lines.push(`- ${c.status} ${c.title}${c.tags ? `（${c.tags}）` : ""}`);
            }
          } else {
            lines.push(...courses.map((c) => `- ${c.title}`));
          }
          return ok(lines.join("\n"));
        }
        case "tags": {
          const defs = query<Array<{ tag: string; dimension: string; criteria: string }>>("kb.tags.list", {});
          const filtered = params.tag ? defs.filter((d) => d.tag === params.tag) : defs;
          return ok(`${params.tag ? `标签「${params.tag}」定义：` : ""}${tagsToMarkdownLite(filtered)}`);
        }
        default:
          throw new Error(`kb_query 支持 query: daily | topics | progress | tags（当前: ${params.query}）`);
      }
    },
  });

  const kbInsertTool = defineTool({
    name: "kb_insert",
    label: "插入知识库条目（SQL）",
    description:
      "向 SQLite 知识库插入新条目，内容不进上下文。\n" +
      "**table: \"daily\"**：`date` + `block`（学习/生活/问答/任务）+ `content`（### 标题开头 + 字段行；生活事件含 `- 标签：诚实,亲情` 行，自动解析）。**批量推荐**：同一天多条用 `entries: [{block, content}, ...]` 一次写入（单事务，重复自动跳过）。\n" +
      "**table: \"course\"**：新增课程，`topic`（主题目录名）+ `title`（课程名）；可选 status/mastery/material/sendMaterial/tags。",
    parameters: Type.Object({
      table: Type.String({ description: "写入目标：daily | course" }),
      date: Type.Optional(Type.String({ description: "daily：日期 YYYY-MM-DD（批量时共用）" })),
      block: Type.Optional(Type.String({ description: "daily：区块（学习/生活/问答/任务）" })),
      content: Type.Optional(Type.String({ description: "daily：完整条目文本（### 标题 + 字段行）" })),
      entries: Type.Optional(
        Type.Array(
          Type.Object({
            block: Type.String({ description: "区块" }),
            content: Type.String({ description: "条目文本" }),
          }),
          { description: "批量写入 daily：同一 date 的多条条目" }
        )
      ),
      topic: Type.Optional(Type.String({ description: "course：主题目录名（如 lunyu）" })),
      title: Type.Optional(Type.String({ description: "course：新课程名" })),
      status: Type.Optional(Type.String({ description: "course：初始掌握状态（⬜/✅）" })),
      mastery: Type.Optional(Type.String({ description: "course：掌握度" })),
      material: Type.Optional(Type.String({ description: "course：教学资料" })),
      sendMaterial: Type.Optional(Type.String({ description: "course：要发送的学习资料" })),
      tags: Type.Optional(Type.String({ description: "course：课程标签（逗号分隔）" })),
    }),
    execute: async (_tc, params) => {
      if (params.table === "daily") {
        if (params.entries?.length) {
          if (!params.date) throw new Error("kb_insert daily 批量需要 date + entries");
          const r = exec<{ inserted: number; skipped: number }>("kb.daily_entries.insertMany", {
            date: params.date,
            entries: params.entries,
          });
          return ok(`已批量写入 daily ${params.date}：新增 ${r.inserted} 条${r.skipped ? `，跳过重复/无效 ${r.skipped} 条` : ""}`);
        }
        if (!params.date || !params.block || !params.content) {
          throw new Error("kb_insert daily 需要 date + block + content（或批量 entries）");
        }
        const r = exec<{ inserted: number }>("kb.daily_entries.insertMany", {
          date: params.date,
          entries: [{ block: params.block, content: params.content }],
        });
        return ok(r.inserted ? "已写入 daily。" : "该条目已存在，跳过。");
      }
      if (params.table === "course") {
        if (!params.topic || !params.title) throw new Error("kb_insert course 需要 topic + title");
        const r = exec<{ ok: boolean }>("kb.courses.insert", {
          topic: params.topic,
          title: params.title,
          status: params.status,
          mastery: params.mastery,
          material: params.material,
          send_material: params.sendMaterial,
          tags: params.tags,
        });
        return ok(r.ok ? `已新增课程「${params.title}」。` : `课程「${params.title}」已存在，未重复插入。`);
      }
      throw new Error(`kb_insert 的 table 仅支持 daily / course（当前: ${params.table}）`);
    },
  });

  const kbUpdateTool = defineTool({
    name: "kb_update",
    label: "更新知识库字段（SQL）",
    description:
      "更新知识库已有条目字段。\n" +
      "**table: \"course\"**：按 `topic` + `title` 更新课程，`fields: [{field, value}, ...]` 批量（状态/掌握状态/掌握度/首次学习/最近复习/复习时间/上次复习/复习次数(+1 自增)/教学资料/学习资料/tags）。learned/next/updated 为视图自动计算，勿手动更新。\n" +
      "**table: \"daily\"**：按 `date` + `block` + `title` 更新，`field` + `value`（字段缺失自动追加；field=标签 时同步 tags 列）。",
    parameters: Type.Object({
      table: Type.String({ description: "更新目标：course | daily" }),
      topic: Type.Optional(Type.String({ description: "course：主题目录名（如 lunyu）或中文名" })),
      title: Type.Optional(Type.String({ description: "course：课程名 / daily：条目标题" })),
      fields: Type.Optional(
        Type.Array(
          Type.Object({ field: Type.String({ description: "字段名" }), value: Type.String({ description: "新值" }) }),
          { description: "course 批量字段（推荐一次写完）" }
        )
      ),
      date: Type.Optional(Type.String({ description: "daily：日期 YYYY-MM-DD" })),
      block: Type.Optional(Type.String({ description: "daily：区块（学习/生活/问答/任务）" })),
      field: Type.Optional(Type.String({ description: "daily：字段名（如 状态/标签）" })),
      value: Type.Optional(Type.String({ description: "daily：新值" })),
    }),
    execute: async (_tc, params) => {
      if (params.table === "course") {
        if (!params.topic || !params.title) throw new Error("kb_update course 需要 topic + title");
        const fields = Array.isArray(params.fields) ? params.fields : [];
        if (!fields.length) throw new Error("kb_update course 需要 fields 数组");
        const r = exec<{ ok: boolean; updated?: number }>("kb.courses.updateFields", {
          topic: params.topic,
          title: params.title,
          fields,
        });
        return ok(r.ok ? `已更新课程「${params.title}」${r.updated ?? fields.length} 个字段。` : "未找到该课程。");
      }
      if (params.table === "daily") {
        if (!params.date || !params.block || !params.title || !params.field) {
          throw new Error("kb_update daily 需要 date + block + title + field");
        }
        const r = exec<{ ok: boolean }>("kb.daily_entries.updateField", {
          date: params.date,
          block: params.block,
          title: params.title,
          field: params.field,
          value: params.value ?? "",
        });
        return ok(r.ok ? "已更新。" : "未找到该 daily 条目。");
      }
      throw new Error(`kb_update 的 table 仅支持 course / daily（当前: ${params.table}）`);
    },
  });

  const todoListTool = defineTool({
    name: "todo_list",
    label: "读写孩子 Todolist（一事一条）",
    description:
      "读写孩子当天的 Todolist。每件事是一条结构化记录（非 markdown）。\n" +
      "**read**：`action:\"read\"` + `date`(缺省=今天) 返回当天清单，每条含 id/标题/来源(家长|孩子)/是否完成/截止时间(due)/备注。\n" +
      "**add**：`action:\"add\"` + `title`（+可选 date,note,due_time）新增一条**孩子自规划项**。\n" +
      "  孩子说了「几点前要完成」（如『我 3 点前写完数学』）时，把时刻填进 **due_time**（HH:MM，如 15:00），title 只写干净的事（数学作业），不要把时间写进标题。\n" +
      "**check**：`action:\"check\"` + `id` 把某条标记完成（系统会记下真实完成时刻）；`action:\"uncheck\"` + `id` 取消。\n" +
      "**remove**：`action:\"remove\"` + `id` 删除（仅孩子自规划项）。\n" +
      "**规则**：来源=家长 的项（来自学习计划）**绝不能删除或改标题**，只能由系统按课程实际学习核对完成；孩子自规划项（来源=孩子）孩子可增删、可自行 check/uncheck。",
    parameters: Type.Object({
      action: Type.String({ description: "read=读取 | add=新增 | check=完成 | uncheck=取消完成 | remove=删除" }),
      date: Type.Optional(Type.String({ description: "日期 YYYY-MM-DD（缺省=今天）" })),
      title: Type.Optional(Type.String({ description: "add 时必填：事项标题（干净，不带时间）" })),
      due_time: Type.Optional(Type.String({ description: "add 时可选：约定截止时刻 HH:MM（如 15:00），孩子说几点前完成时填这" })),
      id: Type.Optional(Type.String({ description: "check/uncheck/remove 时必填：事项 id（read 返回）" })),
      note: Type.Optional(Type.String({ description: "add 时可带备注" })),
    }),
    execute: async (_tc, params) => {
      const date = params.date || formatLocalDate(new Date());
      if (params.action === "read") {
        const rows = query<Array<Record<string, unknown>>>("kb.todo.list", { date });
        if (!rows || rows.length === 0) {
          return ok(`${date} 还没有安排 Todolist——今天没有具体任务（空天 = 不要求学）。`);
        }
        const lines = rows.map((r) => {
          const src = r.source === "parent" ? "[家长] " : "";
          const st = r.status === "done" ? "x" : " ";
          const due = r.due_time ? ` ⏰${String(r.due_time)}前` : "";
          const note = r.note ? `（${r.note}）` : "";
          return `- [${st}] ${src}${r.title}${due}${note} [id=${String(r.id).slice(0, 8)}]`;
        });
        return ok(`「${date}」的 Todolist：\n${lines.join("\n")}`);
      }
      if (params.action === "add") {
        if (!params.title || !String(params.title).trim()) throw new Error("todo_list add 需要 title");
        const r = exec<{ ok: boolean; id: string }>("kb.todo.add", {
          date,
          title: params.title,
          note: params.note ?? "",
          due_time: params.due_time ?? "",
        });
        const dueMsg = params.due_time ? `，约定 ${params.due_time} 前完成` : "";
        return ok(`已新增自规划项「${params.title}」${dueMsg}。`);
      }
      if (params.action === "check" || params.action === "uncheck") {
        if (!params.id) throw new Error("todo_list check/uncheck 需要 id");
        const r = exec<{ ok: boolean }>("kb.todo.set", { id: params.id, status: params.action === "check" ? "done" : "pending" });
        if (r.ok) return ok(params.action === "check" ? "已标记完成。" : "已取消完成。");
        return ok("未找到该事项。");
      }
      if (params.action === "remove") {
        if (!params.id) throw new Error("todo_list remove 需要 id");
        exec("kb.todo.remove", { id: params.id });
        return ok("已删除该自规划项。");
      }
      throw new Error("todo_list 的 action 仅支持 read / add / check / uncheck / remove");
    },
  });

  return [getDateTool, kbQueryTool, kbInsertTool, kbUpdateTool, todoListTool];
}

/** 本地时区 YYYY-MM-DD。 */
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
