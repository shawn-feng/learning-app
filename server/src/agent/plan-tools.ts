/**
 * 服务端孩子 agent 的计划域 + 家长教学方法工具（P3 补漏，2026-09-12 / 2026-09-13 重构）。
 *
 * 命名约定：孩子端工具一律 `child_` 前缀；家长端工具一律 `parent_` 前缀（parent-plans.ts）。
 *
 * 孩子端计划工具（均与家长的同名工具对称，但只读 / 仅能改自己创建的加分项）：
 * - child_study_plan_list：查看我的学习计划（只读，默认今天窗口）
 * - child_exam_plan_list：查看我的考核计划（只读，默认今天窗口）
 * - child_life_plan_create：创建自己的生活计划（加分项，creator=child）
 * - child_life_plan_list：查看我的生活计划（含家长的必须完成项）
 * - child_life_plan_update：修改/删除自己创建的生活计划（仅 creator=child 行）
 * - parent_content：查家长库的主题教学方法 / 课程教学文案 / 考核要点 / html 资料路径
 *
 * 数据源：计划表在孩子 kb（openKb(dataDir, parentId, childId)），窗口覆盖当天 = 「今天的计划」。
 * 教学方法在家长库（openParentLib(dataDir, parentId)）。
 */
import crypto from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import { openKb } from "../db/kb.js";
import { openParentLib } from "../db/parent-lib.js";

export interface PlanToolsDeps {
  dataDir: string;
  parentId: string;
  childId: string;
}

function localDateStr(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function validDate(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d);
}

// ---------- 学习计划（孩子只读） ----------

export function createChildStudyPlanListTool(deps: PlanToolsDeps) {
  return defineTool({
    name: "child_study_plan_list",
    label: "查看我的学习计划",
    description:
      "查看**你今天/某天的学习计划**（一课一行，含新学/复习、完成态）。\n" +
      "**何时用**：孩子问「今天要学什么 / 我的学习计划是什么」时先调本工具，不要自己猜或拟定计划——计划是家长规划好的。\n" +
      "**参数**：date 可选 YYYY-MM-DD（缺省=今天）；from/to 可选（查某段日期范围，含边界）。",
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "哪天，YYYY-MM-DD；缺省 = 今天" })),
      from: Type.Optional(Type.String({ description: "只看此日期（含）之后的排期行" })),
      to: Type.Optional(Type.String({ description: "只看此日期（含）之前的排期行" })),
    }),
    execute: async (_tc, params) => {
      const d = String(params?.date ?? "").trim();
      const day = validDate(d) ? d : localDateStr();
      const kb = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        let rows = kb
          .prepare(
            `SELECT id, course_name AS title, mode, creator, status, start_at AS startAt, due_at AS dueAt
               FROM study_plans WHERE active = 1 AND status != 'cancelled'
                 AND (start_at = '' OR substr(start_at,1,10) <= ?) AND (due_at = '' OR substr(due_at,1,10) >= ?)
               ORDER BY due_at, created_at`
          )
          .all(day, day) as unknown as Array<{ id: string; title: string; mode: string; creator: string; status: string; startAt: string; dueAt: string }>;
        if (params?.from) rows = rows.filter((r) => (r.startAt || "").slice(0, 10) >= params.from!);
        if (params?.to) rows = rows.filter((r) => (r.dueAt || "").slice(0, 10) <= params.to!);
        if (!rows.length) return { content: [{ type: "text" as const, text: `（${day} 没有学习计划。）` }], details: {} };
        const lines = rows.slice(0, 120).map(
          (r) =>
            `- ${r.id.slice(0, 8)}｜${(r.startAt || "").slice(0, 10)}｜${r.title}｜${r.mode === "review" ? "复习" : "新学"}｜${r.status === "done" ? "✅ 已学" : "⬜ 待学"}${r.creator === "child" ? "（自己）" : ""}`
        );
        return { content: [{ type: "text" as const, text: `你的学习计划（共 ${rows.length} 行，行 id 取前 8 位）：\n${lines.join("\n")}` }], details: {} };
      } finally {
        kb.close();
      }
    },
  });
}

// ---------- 考核计划（孩子只读） ----------

export function createChildExamPlanListTool(deps: PlanToolsDeps) {
  return defineTool({
    name: "child_exam_plan_list",
    label: "查看我的考核计划",
    description:
      "查看**你今天/某天的考核计划**（含考核标题、日期、完成态、分数）。\n" +
      "**参数**：date 可选（缺省=今天）；from/to 可选（查某段日期范围，含边界）。",
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "哪天，YYYY-MM-DD；缺省 = 今天" })),
      from: Type.Optional(Type.String({ description: "只看此日期（含）之后的排期" })),
      to: Type.Optional(Type.String({ description: "只看此日期（含）之前的排期" })),
    }),
    execute: async (_tc, params) => {
      const d = String(params?.date ?? "").trim();
      const day = validDate(d) ? d : localDateStr();
      const kb = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        let rows = kb
          .prepare(
            `SELECT id, title, status, score, start_at AS startAt, due_at AS dueAt
               FROM exam_plans WHERE active = 1 AND status != 'cancelled'
                 AND (start_at = '' OR substr(start_at,1,10) <= ?) AND (due_at = '' OR substr(due_at,1,10) >= ?)
               ORDER BY due_at, created_at`
          )
          .all(day, day) as unknown as Array<{ id: string; title: string; status: string; score: number | null; startAt: string; dueAt: string }>;
        if (params?.from) rows = rows.filter((r) => (r.startAt || "").slice(0, 10) >= params.from!);
        if (params?.to) rows = rows.filter((r) => (r.dueAt || "").slice(0, 10) <= params.to!);
        if (!rows.length) return { content: [{ type: "text" as const, text: `（${day} 没有考核计划。）` }], details: {} };
        const lines = rows.slice(0, 120).map((r) => {
          const st = r.status === "done" ? `✅ 已完成${r.score != null ? `（${r.score}分）` : ""}` : r.status === "missed" ? "❌ 未完成" : "⬜ 待考";
          return `- ${r.id.slice(0, 8)}｜${(r.startAt || "").slice(0, 10)}｜${r.title}｜${st}`;
        });
        return { content: [{ type: "text" as const, text: `你的考核计划（共 ${rows.length} 行）：\n${lines.join("\n")}` }], details: {} };
      } finally {
        kb.close();
      }
    },
  });
}

// ---------- 家长库教学方法（parent_content） ----------

/** 把 topic 参数（目录名 lunyu 或中文名 论语）归一为 topic_key。 */
function resolveTopicKey(lib: DatabaseSync, topic: string): string {
  const byKey = lib.prepare("SELECT topic_key FROM topics WHERE topic_key = ?").get(topic) as
    | { topic_key?: string }
    | undefined;
  if (byKey?.topic_key) return byKey.topic_key;
  const byName = lib.prepare("SELECT topic_key FROM topics WHERE name = ?").get(topic) as
    | { topic_key?: string }
    | undefined;
  return byName?.topic_key ?? topic;
}

export function createParentContentTool(deps: PlanToolsDeps) {
  return defineTool({
    name: "parent_content",
    label: "查主题教学方法 / 课程教学文案 / html 资料路径（家长库）",
    description:
      "从家长库读取当前主题的教学方法全文、某课程的教学文案、考核要点、或 html 学习资料路径。\n" +
      "孩子数据库不存 method 与教学文案（分配主题时只拷贝课程骨架/进度/资料指针），所以**教学需要方法、文案或 html 资料路径、考核需要要点时，必须先调本工具**，不要尝试读孩子库或猜测。\n" +
      "- type=method：取主题教学方法全文，传 `topic`（主题目录名 lunyu 或中文名）。\n" +
      "- type=teachingCopy：取课程教学文案，传 `topic` + `course`（课程名）。\n" +
      "- type=assessRubric：取课程考核要点，传 `topic` + `course`。\n" +
      "- type=htmlPath：取课程 html 资料相对路径（拿到后用 display_content 展示，path 传该路径），传 `topic` + `course`。",
    parameters: Type.Object({
      type: Type.String({ description: "method | teachingCopy | assessRubric | htmlPath" }),
      topic: Type.String({ description: "主题目录名（如 lunyu）或中文名" }),
      course: Type.Optional(Type.String({ description: "teachingCopy / assessRubric / htmlPath 必填：课程名" })),
    }),
    execute: async (_tc, params) => {
      const type = String(params?.type ?? "");
      const topic = String(params?.topic ?? "").trim();
      if (!["method", "teachingCopy", "assessRubric", "htmlPath"].includes(type)) {
        throw new Error("parent_content 的 type 仅支持 method | teachingCopy | assessRubric | htmlPath");
      }
      if (!topic) throw new Error("parent_content 需要 topic（主题目录名或中文名）");
      const lib = openParentLib(deps.dataDir, deps.parentId);
      try {
        if (type === "method") {
          const row = lib
            .prepare("SELECT name, method FROM topics WHERE topic_key = ? OR name = ? LIMIT 1")
            .get(topic, topic) as { name?: string; method?: string } | undefined;
          if (!row) throw new Error(`家长库中未找到主题「${topic}」（可能未分配或主题名有差异）。`);
          if (!row.method?.trim()) throw new Error(`主题「${row.name ?? topic}」在家长库尚未填写教学方法。`);
          return { content: [{ type: "text" as const, text: row.method }], details: {} };
        }

        const course = String(params?.course ?? "").trim();
        if (!course) throw new Error(`parent_content 的 type=${type} 需要 course（课程名）。`);
        const topicKey = resolveTopicKey(lib, topic);
        const row = lib
          .prepare(
            "SELECT title, teaching_copy, assess_rubric, html_path FROM courses WHERE topic = ? AND title = ? LIMIT 1"
          )
          .get(topicKey, course) as
          | { title?: string; teaching_copy?: string; assess_rubric?: string; html_path?: string }
          | undefined;
        if (!row) {
          throw new Error(
            `家长库中未找到课程「${course}」（主题 ${topicKey}）。请先用 kb_query(query=progress + topic + listOnly) 列出该主题的准确课程标题。`
          );
        }
        if (type === "teachingCopy") {
          const v = row.teaching_copy?.trim();
          if (!v) throw new Error(`课程「${course}」尚未填写教学文案。`);
          return { content: [{ type: "text" as const, text: v }], details: {} };
        }
        if (type === "assessRubric") {
          const v = row.assess_rubric?.trim();
          if (!v) throw new Error(`课程「${course}」尚未填写考核要点。`);
          return { content: [{ type: "text" as const, text: v }], details: {} };
        }
        const v = row.html_path?.trim();
        if (!v) {
          throw new Error(
            `课程「${course}」已存在，但尚未登记 html 学习资料（html_path 为空）——不是路径找不到，是还没关联资料文件。`
          );
        }
        return { content: [{ type: "text" as const, text: v }], details: {} };
      } finally {
        lib.close();
      }
    },
  });
}

// ---------- 生活计划（孩子自建：增 / 查 / 改 / 删，与家长的 life 工具对称） ----------

interface LifeRow {
  id: string;
  title: string;
  creator: string;
  origin: string;
  start_at: string;
  due_at: string;
  status: string;
  done_at: string;
}

function childLifePlans(deps: PlanToolsDeps): LifeRow[] {
  const kb = openKb(deps.dataDir, deps.parentId, deps.childId);
  try {
    return kb
      .prepare("SELECT * FROM life_plans WHERE active = 1 AND status != 'cancelled' ORDER BY due_at, created_at")
      .all() as unknown as LifeRow[];
  } finally {
    kb.close();
  }
}

/** 孩子自己安排一条生活计划（加分项，creator=child；与 /plans/life 默认分支一致）。 */
export function createChildLifePlanCreateTool(deps: PlanToolsDeps) {
  return defineTool({
    name: "child_life_plan_create",
    label: "创建自己的生活计划（加分项）",
    description:
      "孩子自己安排一条**生活计划**（加分项，制定人=孩子自己）：例如「我想每天睡前读 20 分钟书」。\n" +
      "**参数**：title 必填；date 可选（缺省=今天，YYYY-MM-DD）；time 可选（HH:mm 截止时刻）。\n" +
      "**语义**：你自己给自己安排的事，算**加分项**（optional）——完成后有积分奖励；与家长的「必须完成项」不同，不做不会扣分。同日同标题已存在会自动跳过。",
    parameters: Type.Object({
      title: Type.String({ description: "要做的事（干净表述，时间放 time 参数）" }),
      date: Type.Optional(Type.String({ description: "哪天做，YYYY-MM-DD；缺省 = 今天" })),
      time: Type.Optional(Type.String({ description: "截止时刻 HH:mm（可选），如 20:30" })),
    }),
    execute: async (_tc, params) => {
      const title = String(params?.title ?? "").trim();
      if (!title) throw new Error("child_life_plan_create 需要 title（要做的事）");
      if (title.length > 200) throw new Error("title 过长（≤200 字）");
      const d = String(params?.date ?? "").trim();
      const date = validDate(d) ? d : localDateStr();
      const time = String(params?.time ?? "").trim();
      if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`time 格式应为 HH:mm：${time}`);
      const kb = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        const dup = kb
          .prepare(
            `SELECT id FROM life_plans WHERE title = ? AND creator = 'child' AND active = 1 AND status IN ('pending')
               AND substr(start_at,1,10) <= ? AND substr(due_at,1,10) >= ?`
          )
          .get(title, date, date) as { id: string } | undefined;
        if (dup) {
          return { content: [{ type: "text" as const, text: `「${title}」当天已存在（待完成），未重复创建。` }], details: {} };
        }
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        kb.prepare(
          `INSERT INTO life_plans
             (id,parent_id,child_id,title,creator,origin,carry_from,recurrence_id,start_at,due_at,status,result,done_at,
              task_type,count_in_rate,points,active,created_at,updated_at)
           VALUES (?,?,?,?,?,'conversation','','',?,?,'pending','','',?,1,0,1,?,?)`
        ).run(id, deps.parentId, deps.childId, title, "child", `${date} 00:00:00`, time ? `${date} ${time}:00` : `${date} 23:59:59`, "optional", now, now);
        return {
          content: [{ type: "text" as const, text: `已为你添加生活计划「${title}」${time ? `（${time} 前）` : ""}（加分项，完成有积分奖励）。` }],
          details: {},
        };
      } finally {
        kb.close();
      }
    },
  });
}

/** 查看自己的生活计划（含家长制定的必须完成项与自己的加分项）。 */
export function createChildLifePlanListTool(deps: PlanToolsDeps) {
  return defineTool({
    name: "child_life_plan_list",
    label: "查看我的生活计划",
    description:
      "查看**你自己的**生活计划（含家长制定的必须完成项与你自己的加分项）：title / 制定人 / 日期 / 完成态 / **行 id**（改删前先 list）。\n" +
      "**可选过滤**：from / to（YYYY-MM-DD，含边界）。",
    parameters: Type.Object({
      from: Type.Optional(Type.String({ description: "只看此日期（含）之后的计划行" })),
      to: Type.Optional(Type.String({ description: "只看此日期（含）之前的计划行" })),
    }),
    execute: async (_tc, params) => {
      let rows = childLifePlans(deps);
      if (params?.from) rows = rows.filter((r) => (r.start_at || "").slice(0, 10) >= params.from!);
      if (params?.to) rows = rows.filter((r) => (r.due_at || "").slice(0, 10) <= params.to!);
      if (!rows.length) return { content: [{ type: "text" as const, text: "你当前没有生活计划。" }], details: {} };
      const lines = rows
        .slice(0, 120)
        .map(
          (r) =>
            `- ${r.id.slice(0, 8)}｜${(r.start_at || "").slice(0, 10)}｜${r.title}｜${r.creator === "parent" ? "必须完成项(家长)" : "加分项(自己)"}｜${r.status === "done" ? "✅ 已完成" : r.status === "missed" ? "❌ 未完成" : "⬜ 待完成"}${r.origin === "carry" ? "｜📋 顺延" : ""}`
        );
      return {
        content: [{ type: "text" as const, text: `你的生活计划（共 ${rows.length} 行，行 id 取前 8 位）：\n${lines.join("\n")}` }],
        details: {},
      };
    },
  });
}

/** 修改/删除自己创建的生活计划（仅 creator=child 行，权限边界）。 */
export function createChildLifePlanUpdateTool(deps: PlanToolsDeps) {
  return defineTool({
    name: "child_life_plan_update",
    label: "修改/删除我的生活计划（仅自己创建的加分项）",
    description:
      "修改**你自己创建**的生活计划（加分项；先 child_life_plan_list 拿行 id）。三种动作：\n" +
      "- `delete` + `id`：删除该条\n" +
      "- `reschedule` + `id` + `date`：改到另一天（保留原截止时刻）\n" +
      "- `rename` + `id` + `title`：改事项名称\n" +
      "**权限边界**：只能改你自己的加分项；家长制定的「必须完成项」你无权改动（需家长操作）。想放弃家长的必须完成项，可以请家长帮你取消。",
    parameters: Type.Object({
      act: Type.String({ description: "动作：delete | reschedule | rename" }),
      id: Type.String({ description: "行 id（child_life_plan_list 返回；可传前 8 位）" }),
      date: Type.Optional(Type.String({ description: "reschedule 时必填：改到哪天 YYYY-MM-DD" })),
      title: Type.Optional(Type.String({ description: "rename 时必填：新名称" })),
    }),
    execute: async (_tc, params) => {
      const act = String(params?.act ?? "").trim();
      if (!["delete", "reschedule", "rename"].includes(act)) {
        throw new Error("child_life_plan_update 的 act 仅支持 delete / reschedule / rename");
      }
      const wantId = String(params?.id ?? "").trim();
      const kb = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        const rows = kb
          .prepare("SELECT * FROM life_plans WHERE active = 1 AND creator = 'child' AND id LIKE ?")
          .all(`${wantId}%`) as unknown as LifeRow[];
        const row = rows.find((r) => r.id === wantId || r.id.startsWith(wantId));
        if (!row) throw new Error("找不到你自己创建的生活计划行（行 id 来自 child_life_plan_list；只能改自己创建的加分项）。");
        if (act === "delete") {
          kb.prepare("DELETE FROM life_plans WHERE id = ?").run(row.id);
          return { content: [{ type: "text" as const, text: `已删除你的生活计划「${row.title}」。` }], details: {} };
        }
        if (act === "reschedule") {
          const date = String(params?.date ?? "").trim();
          if (!validDate(date)) throw new Error(`reschedule 需要 date（YYYY-MM-DD）：${date}`);
          const oldTime = (row.start_at || "").length > 11 ? (row.start_at || "").slice(11) : "00:00:00";
          kb.prepare("UPDATE life_plans SET start_at = ?, due_at = ?, updated_at = ? WHERE id = ?").run(
            `${date} 00:00:00`, `${date} ${oldTime.slice(0, 8)}`, new Date().toISOString(), row.id
          );
          return { content: [{ type: "text" as const, text: `已将「${row.title}」改到 ${date}。` }], details: {} };
        }
        const title = String(params?.title ?? "").trim();
        if (!title) throw new Error("rename 需要 title（新名称）");
        if (title.length > 200) throw new Error("title 过长（≤200 字）");
        kb.prepare("UPDATE life_plans SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), row.id);
        return { content: [{ type: "text" as const, text: `已将生活计划改名为「${title}」。` }], details: {} };
      } finally {
        kb.close();
      }
    },
  });
}

// ---------- 学习计划（孩子自建：加分项，creator=child） ----------

/** 家长库 courses 反查：course 名 → { topic, uuid }（跨主题；同名取首个），并给出全部课程名供纠错提示。 */
function parentCourseLookup(deps: PlanToolsDeps): {
  byTitle: Map<string, { topic: string; uuid: string }>;
  titles: string[];
} {
  const byTitle = new Map<string, { topic: string; uuid: string }>();
  const titles: string[] = [];
  try {
    const lib = openParentLib(deps.dataDir, deps.parentId);
    try {
      const rows = lib
        .prepare("SELECT topic, title, uuid FROM courses ORDER BY topic, sort_order, title")
        .all() as Array<{ topic: string; title: string; uuid: string | null }>;
      for (const r of rows) {
        const t = String(r.title || "").trim();
        if (!t) continue;
        if (!titles.includes(t)) titles.push(t);
        if (!byTitle.has(t)) byTitle.set(t, { topic: String(r.topic || ""), uuid: r.uuid ? String(r.uuid) : "" });
      }
    } finally {
      lib.close();
    }
  } catch {
    /* 家长库不可用时留空，由调用方按「课程名不存在」提示 */
  }
  return { byTitle, titles };
}

/** 「复习：<课程名>」前缀 → mode=review（与家长工具 / 路由一致）。 */
function splitStudyPrefix(raw: string): { mode: "new" | "review"; courseName: string } {
  const t = String(raw ?? "").trim();
  const m = /^复习[:：]\s*(.+)$/.exec(t);
  if (m) return { mode: "review", courseName: m[1]!.trim() };
  return { mode: "new", courseName: t };
}

/** 孩子自己安排一条学习计划（加分项，creator=child；与家长的 study_plan_create 对称）。 */
export function createChildStudyPlanCreateTool(deps: PlanToolsDeps) {
  return defineTool({
    name: "child_study_plan_create",
    label: "创建自己的学习计划（加分项）",
    description:
      "孩子自己安排**某天想学哪几门课**（加分项，制定人=孩子自己）：例如「我明天想学《论语学而篇》」「我想复习昨天那课」。\n" +
      "**参数**：`courses` 必填（课程名数组，一项一课；要复习的课在名字前加「复习：」前缀）；`date` 可选（缺省=今天，YYYY-MM-DD）。\n" +
      "**语义**：你自己给自己安排的学习任务，算**加分项**（optional）——完成后有积分奖励；不做不会扣分。同日同课已存在会自动跳过。\n" +
      "**课程名必须真实存在**（在家长给你的主题课程内）：不确定课程名时，先 `child_study_plan_list` 看已排的课，或问 AI 伙伴/家长确认，不要自己编名字。",
    parameters: Type.Object({
      courses: Type.Array(Type.String({ description: "课程名数组（复习加「复习：」前缀）" })),
      date: Type.Optional(Type.String({ description: "哪天学，YYYY-MM-DD；缺省 = 今天" })),
    }),
    execute: async (_tc, params) => {
      const raw = Array.isArray(params?.courses) ? params.courses.map((c) => String(c).trim()).filter(Boolean) : [];
      if (!raw.length) throw new Error("child_study_plan_create 需要 courses（至少一门课）");
      if (raw.length > 20) throw new Error("courses 过多（单次 ≤20 门）");
      const d = String(params?.date ?? "").trim();
      const date = validDate(d) ? d : localDateStr();
      const items = raw.map((t) => splitStudyPrefix(t));
      const { byTitle, titles } = parentCourseLookup(deps);
      const missing = items.filter((it) => !byTitle.has(it.courseName)).map((it) => it.courseName);
      if (missing.length) {
        const hint = titles.length ? `现有课程：${titles.slice(0, 40).join("、")}${titles.length > 40 ? "…" : ""}` : "家长尚未分配任何课程，请先请家长分配学习主题";
        throw new Error(`课程名不存在：${missing.join("、")}。请用准确课程名（${hint}）。`);
      }
      const kb = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        const existing = kb
          .prepare(
            `SELECT topic_key, course_name, mode FROM study_plans
               WHERE active = 1 AND creator = 'child' AND status = 'pending'
                 AND substr(start_at,1,10) <= ? AND substr(due_at,1,10) >= ?`
          )
          .all(date, date) as unknown as Array<{ topic_key: string; course_name: string; mode: string }>;
        const have = new Set(existing.map((r) => `${r.topic_key}\u0000${r.course_name}\u0000${r.mode}`));
        const inserted: string[] = [];
        const skipped: string[] = [];
        for (const it of items) {
          const info = byTitle.get(it.courseName)!;
          const dedupKey = `${info.topic}\u0000${it.courseName}\u0000${it.mode}`;
          if (have.has(dedupKey)) {
            skipped.push(it.courseName);
            continue;
          }
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          kb.prepare(
            `INSERT INTO study_plans
               (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,recurrence_id,
                start_at,due_at,status,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,'child','conversation','','',?,?,'pending','','','optional',1,0,1,?,?)`
          ).run(id, deps.parentId, deps.childId, info.topic, info.uuid, it.courseName, it.mode, `${date} 00:00:00`, `${date} 23:59:59`, now, now);
          have.add(dedupKey);
          inserted.push(`${it.courseName}（${it.mode === "review" ? "复习" : "新学"}）`);
        }
        const parts: string[] = [];
        if (inserted.length) parts.push(`已添加 ${inserted.length} 项（${inserted.join("、")}）`);
        if (skipped.length) parts.push(`${skipped.join("、")} 当天已存在，跳过`);
        return {
          content: [{ type: "text" as const, text: `你的 ${date} 学习计划：${parts.join("；")}。这是加分项，完成后有积分奖励。` }],
          details: {},
        };
      } finally {
        kb.close();
      }
    },
  });
}

// ---------- 考核计划（孩子自建：加分项，creator=child） ----------

/** 孩子自己安排一次考核（加分项，creator=child，kind='self'；与 /plans/exam 路由一致）。 */
export function createChildExamPlanCreateTool(deps: PlanToolsDeps) {
  return defineTool({
    name: "child_exam_plan_create",
    label: "创建自己的考核计划（加分项）",
    description:
      "孩子自己安排**某天想考一次**（加分项，制定人=孩子自己）：例如「我想周六考一次上次学的英语课」。\n" +
      "**参数**：`title` 必填（这次考核的名字/范围，如「英语食物课小测」）；`date` 可选（缺省=今天，YYYY-MM-DD）；`note` 可选（给自己的说明）。\n" +
      "**语义**：这是「哪天想考」的自我安排（加分项 optional），会出现在「今日计划」里；实际考试仍在考核页进行。同日同名已存在会自动跳过。\n" +
      "**说明**：真正的考核范围由家长安排的考核排期决定；本工具只登记孩子的自愿意向。",
    parameters: Type.Object({
      title: Type.String({ description: "这次考核的名字/范围（如「英语食物课小测」）" }),
      date: Type.Optional(Type.String({ description: "哪天考，YYYY-MM-DD；缺省 = 今天" })),
      note: Type.Optional(Type.String({ description: "给自己的说明（可空）" })),
    }),
    execute: async (_tc, params) => {
      const title = String(params?.title ?? "").trim();
      if (!title) throw new Error("child_exam_plan_create 需要 title（这次考核的名字/范围）");
      if (title.length > 200) throw new Error("title 过长（≤200 字）");
      const d = String(params?.date ?? "").trim();
      const date = validDate(d) ? d : localDateStr();
      const note = String(params?.note ?? "").trim();
      const kb = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        const dup = kb
          .prepare(
            `SELECT id FROM exam_plans WHERE title = ? AND creator = 'child' AND active = 1 AND status = 'pending'
               AND substr(start_at,1,10) <= ? AND substr(due_at,1,10) >= ?`
          )
          .get(title, date, date) as { id: string } | undefined;
        if (dup) {
          return { content: [{ type: "text" as const, text: `「${title}」当天已存在（待考），未重复创建。` }], details: {} };
        }
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const scopeJson = JSON.stringify(note ? { note } : {});
        kb.prepare(
          `INSERT INTO exam_plans
             (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,start_at,due_at,status,
              attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
           VALUES (?,?,?,?,'child','self','',?,'conversation','',?,?, 'pending','','','','', 'optional',1,0,1,?,?)`
        ).run(id, deps.parentId, deps.childId, title, scopeJson, `${date} 00:00:00`, `${date} 23:59:59`, now, now);
        return {
          content: [{ type: "text" as const, text: `已为你添加考核计划「${title}」（${date}）${note ? `（${note}）` : ""}。这是加分项，到考核页参加后计分。` }],
          details: {},
        };
      } finally {
        kb.close();
      }
    },
  });
}

// ---------- 学习计划（孩子自建：改/删，仅自己创建的加分项） ----------

/** 修改/删除自己创建的学习计划（仅 creator=child 行；权限边界与 life 一致）。 */
export function createChildStudyPlanUpdateTool(deps: PlanToolsDeps) {
  return defineTool({
    name: "child_study_plan_update",
    label: "修改/删除我的学习计划（仅自己创建的加分项）",
    description:
      "修改**你自己创建**的学习计划（加分项；先 child_study_plan_list 拿行 id）。两种动作：\n" +
      "- `delete` + `id`：删除该条（已完成的不允许删）\n" +
      "- `reschedule` + `id` + `date`：改到另一天\n" +
      "**权限边界**：只能改你自己创建的加分项；家长排的学习计划你无权改动（需要时请家长调整）。",
    parameters: Type.Object({
      act: Type.String({ description: "动作：delete | reschedule" }),
      id: Type.String({ description: "行 id（child_study_plan_list 返回；可传前 8 位）" }),
      date: Type.Optional(Type.String({ description: "reschedule 时必填：改到哪天 YYYY-MM-DD" })),
    }),
    execute: async (_tc, params) => {
      const act = String(params?.act ?? "").trim();
      if (!["delete", "reschedule"].includes(act)) {
        throw new Error("child_study_plan_update 的 act 仅支持 delete / reschedule");
      }
      const wantId = String(params?.id ?? "").trim();
      const kb = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        const rows = kb
          .prepare("SELECT * FROM study_plans WHERE active = 1 AND creator = 'child' AND id LIKE ?")
          .all(`${wantId}%`) as unknown as Array<{ id: string; course_name: string; status: string; start_at: string }>;
        const row = rows.find((r) => r.id === wantId || r.id.startsWith(wantId));
        if (!row) {
          throw new Error("找不到你自己创建的学习计划行（行 id 来自 child_study_plan_list；只能改自己创建的加分项）。");
        }
        if (row.status === "done") {
          throw new Error(`「${row.course_name}」已完成，不能${act === "delete" ? "删除" : "改期"}（记录需保留）。`);
        }
        if (act === "delete") {
          kb.prepare("DELETE FROM study_plans WHERE id = ?").run(row.id);
          return { content: [{ type: "text" as const, text: `已删除你的学习计划「${row.course_name}」。` }], details: {} };
        }
        const date = String(params?.date ?? "").trim();
        if (!validDate(date)) throw new Error(`reschedule 需要 date（YYYY-MM-DD）：${date}`);
        kb.prepare("UPDATE study_plans SET start_at = ?, due_at = ?, updated_at = ? WHERE id = ?").run(
          `${date} 00:00:00`,
          `${date} 23:59:59`,
          new Date().toISOString(),
          row.id
        );
        return { content: [{ type: "text" as const, text: `已将「${row.course_name}」改到 ${date}。` }], details: {} };
      } finally {
        kb.close();
      }
    },
  });
}

// ---------- 考核计划（孩子自建：改/删，仅自己创建的加分项） ----------

/** 修改/删除自己创建的考核计划（仅 creator=child 行；已考完的不允许动）。 */
export function createChildExamPlanUpdateTool(deps: PlanToolsDeps) {
  return defineTool({
    name: "child_exam_plan_update",
    label: "修改/删除我的考核计划（仅自己创建的加分项）",
    description:
      "修改**你自己创建**的考核计划（自请考核，加分项；先 child_exam_plan_list 拿行 id）。两种动作：\n" +
      "- `delete` + `id`：删除该条（已考完的不允许删）\n" +
      "- `reschedule` + `id` + `date`：改到另一天\n" +
      "**权限边界**：只能改你自己创建的自请考核；家长安排的考核排期与场次你无权改动。",
    parameters: Type.Object({
      act: Type.String({ description: "动作：delete | reschedule" }),
      id: Type.String({ description: "行 id（child_exam_plan_list 返回；可传前 8 位）" }),
      date: Type.Optional(Type.String({ description: "reschedule 时必填：改到哪天 YYYY-MM-DD" })),
    }),
    execute: async (_tc, params) => {
      const act = String(params?.act ?? "").trim();
      if (!["delete", "reschedule"].includes(act)) {
        throw new Error("child_exam_plan_update 的 act 仅支持 delete / reschedule");
      }
      const wantId = String(params?.id ?? "").trim();
      const kb = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        const rows = kb
          .prepare("SELECT * FROM exam_plans WHERE active = 1 AND creator = 'child' AND id LIKE ?")
          .all(`${wantId}%`) as unknown as Array<{ id: string; title: string; status: string; start_at: string }>;
        const row = rows.find((r) => r.id === wantId || r.id.startsWith(wantId));
        if (!row) {
          throw new Error("找不到你自己创建的考核计划行（行 id 来自 child_exam_plan_list；只能改自己创建的加分项）。");
        }
        if (row.status === "done") {
          throw new Error(`「${row.title}」已考完，不能${act === "delete" ? "删除" : "改期"}（成绩需保留）。`);
        }
        if (act === "delete") {
          kb.prepare("DELETE FROM exam_plans WHERE id = ?").run(row.id);
          return { content: [{ type: "text" as const, text: `已删除你的考核计划「${row.title}」。` }], details: {} };
        }
        const date = String(params?.date ?? "").trim();
        if (!validDate(date)) throw new Error(`reschedule 需要 date（YYYY-MM-DD）：${date}`);
        kb.prepare("UPDATE exam_plans SET start_at = ?, due_at = ?, updated_at = ? WHERE id = ?").run(
          `${date} 00:00:00`,
          `${date} 23:59:59`,
          new Date().toISOString(),
          row.id
        );
        return { content: [{ type: "text" as const, text: `已将「${row.title}」改到 ${date}。` }], details: {} };
      } finally {
        kb.close();
      }
    },
  });
}
