/**
 * 服务端孩子 agent 的计划域 + 家长教学方法工具（P3 补漏，2026-09-12）。
 *
 * 背景：P3 孩子 agent 上移时，漏掉了旧客户端（pi-session.ts L558-559 工具清单）里的
 * parent_content / plan_* / child_self_info，且「今日计划」在旧架构里靠「会话创建时预取 →
 * 注入 system prompt」（pi-session.ts getTodayPlan / planContext），服务端 buildServerChildPrompt
 * 既未注入、也未提供工具。kb_query 又不查计划三表 → 孩子问「今天学什么」时 agent 答不上。
 *
 * 本文件补齐两个有明确数据源、且 AGENTS 用户版明确要求的工具：
 * - get_today_plan：查当日三域计划（study_plans / life_plans / exam_plans，即动态 todolist）。
 * - parent_content：查家长库的主题教学方法 / 课程教学文案 / 考核要点 / html 资料路径。
 *
 * 数据源：
 * - 计划三表在孩子 kb（openKb(dataDir, parentId, childId)），窗口覆盖当天 = 「今天的计划」。
 * - 教学方法在家长库（openParentLib(dataDir, parentId)）：topics.method（主题级）、
 *   courses.teaching_copy / assess_rubric / html_path（课程级）。
 */
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

// ---------- 今日计划（动态 todolist：三张计划表窗口覆盖当天） ----------

interface TodayPlanRow {
  id: string;
  title: string;
  status: string;
  owner: string;
  dueAt: string;
}

export interface TodayPlans {
  date: string;
  study: TodayPlanRow[];
  life: TodayPlanRow[];
  exam: TodayPlanRow[];
}

/** 查某孩子某天的三域计划（复用 /api/v1/plans/today 的聚合 SQL）。 */
export function getTodayPlans(
  dataDir: string,
  parentId: string,
  childId: string,
  date: string
): TodayPlans {
  const kb = openKb(dataDir, parentId, childId);
  try {
    const window = (table: string, titleCol: string) =>
      kb
        .prepare(
          `SELECT id, ${titleCol} AS title, creator AS owner, due_at AS dueAt, status
             FROM ${table} WHERE active = 1
              AND (start_at = '' OR substr(start_at,1,10) <= ?) AND (due_at = '' OR substr(due_at,1,10) >= ?)
            ORDER BY due_at, created_at`
        )
        .all(date, date) as unknown as TodayPlanRow[];
    const study = window("study_plans", "course_name");
    const life = window("life_plans", "title");
    const exam = window("exam_plans", "title");
    return { date, study, life, exam };
  } finally {
    kb.close();
  }
}

const STATUS_TEXT: Record<string, string> = {
  pending: "⬜ 待完成",
  done: "✅ 已完成",
  missed: "❌ 未完成",
  cancelled: "🚫 已取消",
};

/** 把孩子友好地格式化三域计划为 markdown。 */
export function formatTodayPlans(plans: TodayPlans): string {
  const sections: string[] = [];
  const push = (label: string, rows: TodayPlanRow[]) => {
    if (!rows.length) return;
    sections.push(`【${label}】`);
    for (const r of rows) {
      const owner = r.owner === "child" ? "（自己安排）" : "";
      const st = STATUS_TEXT[r.status] ?? r.status;
      sections.push(`- ${st} ${r.title}${owner}`);
    }
  };
  push("学习", plans.study);
  push("生活", plans.life);
  push("考核", plans.exam);
  if (!sections.length) return `今天（${plans.date}）还没有安排计划。`;
  return `今天（${plans.date}）的计划：\n` + sections.join("\n");
}

export function createTodayPlanTool(deps: PlanToolsDeps) {
  return defineTool({
    name: "get_today_plan",
    label: "查询某天的计划（学习/生活/考核）",
    description:
      "查询孩子某天的学习、生活、考核计划（即家长安排的 todolist / 每日计划）。\n" +
      "**何时用**：孩子问「今天要学什么 / 今天有什么安排 / 我的计划是什么」时，**必须先调本工具**，不要自己猜或拟定计划——计划是家长规划好的，你只需照计划督促完成。\n" +
      "**参数**：`date` 可选 YYYY-MM-DD，缺省 = 今天。返回当天的学习计划（一课一行）、生活计划、考核计划及完成状态。",
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "哪一天，YYYY-MM-DD；缺省 = 今天" })),
    }),
    execute: async (_tc, params) => {
      const d = String(params?.date ?? "").trim();
      const date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : localDateStr();
      const plans = getTodayPlans(deps.dataDir, deps.parentId, deps.childId, date);
      return {
        content: [{ type: "text" as const, text: formatTodayPlans(plans) }],
        details: {},
      };
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
