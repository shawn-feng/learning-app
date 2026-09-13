/**
 * 家长 agent 的计划域工具（2026-09-13 上移补齐）：学习计划 / 生活计划 / 考核排期。
 *
 * 与旧客户端工具（P4 删除前）语义一一对应，但**不再走 HTTP 自调用**——直接读写
 * 服务端数据真源（孩子 kb 的 study_plans / life_plans + 主库 exam_schedules），
 * SQL 与各路由严格对齐（study-plans.ts / plans-rewards.ts / exam.ts），改路由须同步改这里。
 *
 * 工具清单（对应旧实现）：
 *   parent_list_children   孩子名单（childName 解析的基础，也是家长 agent 基础工具）
 *   study_plan_sources     孩子课程结构（起草案期前查，只读）
 *   study_plan_create      学习计划排期（days[]，一次可排多天；「复习：」前缀 → review）
 *   study_plan_list        排期行列表（含行 id，改/删前先 list）
 *   study_plan_get         某天安排（当日聚合，含 carry 顺延与生活计划）
 *   study_plan_update      delete / reschedule / setmode
 *   parent_plan_create     生活计划（必须完成项，creator=parent，防重）
 *   exam_schedule_create   自定义考核排期（courses 必须为精确课程名）
 */
import crypto from "node:crypto";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import { openKb } from "../db/kb.js";
import { openParentLib } from "../db/parent-lib.js";
import { runKbQuery } from "../routes/db.js";

export interface PlanToolDeps {
  db: DatabaseSync;
  dataDir: string;
  parentId: string;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

function validDate(d: unknown): d is string {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface ChildRow {
  id: string;
  name: string;
}

/** childName → { childId, name }（精确匹配；找不到列出可选名，不猜）。 */
function resolvePlanChild(db: DatabaseSync, parentId: string, childName: string): ChildRow {
  const kids = db.prepare("SELECT id, name FROM children WHERE parent_id = ?").all(parentId) as unknown as ChildRow[];
  const name = String(childName ?? "").trim();
  const hit = kids.find((k) => k.name === name);
  if (!hit) {
    const names = kids.map((k) => k.name).join("、");
    throw new Error(`找不到孩子「${name}」${names ? `（现有孩子：${names}）` : "（名下暂无孩子）"}`);
  }
  return hit;
}

interface SpRow {
  id: string;
  child_id: string;
  topic_key: string;
  course_uuid: string;
  course_name: string;
  mode: string;
  creator: string;
  origin: string;
  start_at: string;
  due_at: string;
  status: string;
  done_at: string;
  active: number;
  updated_at: string;
}

function readStudyPlans(dataDir: string, parentId: string, childId: string): SpRow[] {
  const kb = openKb(dataDir, parentId, childId);
  try {
    return kb
      .prepare("SELECT * FROM study_plans ORDER BY start_at DESC, created_at ASC LIMIT 2000")
      .all() as unknown as SpRow[];
  } finally {
    kb.close();
  }
}

/** 「复习：<课程名>」前缀 → mode=review（与旧客户端 splitActionPrefix 一致）。 */
function splitActionPrefix(raw: string): { mode: "new" | "review"; courseName: string } {
  const t = String(raw ?? "").trim();
  const m = /^复习[:：]\s*(.+)$/.exec(t);
  if (m) return { mode: "review", courseName: m[1]!.trim() };
  return { mode: "new", courseName: t };
}

/** 家长库 courses 反查表：title → { topic, uuid }（与 study-plans 路由的入库补全一致）。 */
function buildCourseLookup(dataDir: string, parentId: string): { titleToTopic: Map<string, string>; titleToUuid: Map<string, string> } {
  const titleToTopic = new Map<string, string>();
  const titleToUuid = new Map<string, string>();
  try {
    const pdb = openParentLib(dataDir, parentId);
    try {
      const crows = pdb.prepare("SELECT topic, title, uuid FROM courses").all() as Array<{
        topic: string;
        title: string;
        uuid: string | null;
      }>;
        for (const r of crows) {
          const t = (r.title || "").trim();
          if (t && !titleToTopic.has(t)) titleToTopic.set(t, r.topic);
          if (t && r.uuid && !titleToUuid.has(t)) titleToUuid.set(t, String(r.uuid));
        }
    } finally {
      pdb.close();
    }
  } catch {
    /* 家长库不可用时留空（不影响 gen/stat 完成判定） */
  }
  return { titleToTopic, titleToUuid };
}

export function createPlanDomainTools(deps: PlanToolDeps) {
  const { db, dataDir, parentId } = deps;

  const listChildrenTool = defineTool({
    name: "parent_list_children",
    label: "查看孩子名单",
    description: "列出名下所有孩子的名字。学习计划/生活计划/考核排期工具都按**孩子姓名**定位对象，不确定名字时先查这里。",
    parameters: Type.Object({}),
    execute: async () => {
      const kids = db.prepare("SELECT id, name FROM children WHERE parent_id = ? ORDER BY created_at").all(parentId) as unknown as ChildRow[];
      if (!kids.length) return ok("（名下暂无孩子）");
      return ok(`名下孩子：${kids.map((k) => k.name).join("、")}`);
    },
  });

  const sourcesTool = defineTool({
    name: "study_plan_sources",
    label: "查看孩子课程结构（起草计划用）",
    description:
      "查看某孩子的**课程结构**（只读，起草案期前先查这里，不猜课程名）：列出孩子每个主题下有哪些课、哪些还没学。\n" +
      "**参数**：`childName` 必填；`topic` 可选（主题键如 lunyu 或中文名，不填=全部主题概览 + 未学清单）。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      topic: Type.Optional(Type.String({ description: "主题键或中文名（如 lunyu / 论语）；缺省 = 全部主题" })),
    }),
    execute: async (_id: string, params: { childName: string; topic?: string }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const topics = runKbQuery<Array<{ name: string; topic_key: string; rules_json: string }>>(
        dataDir, db, parentId, "kb.topics.list", { child_id: child.id }
      );
      if (!topics?.length) return ok(`「${child.name}」还没有分配任何学习主题（先去「课程管理」分配主题才能排计划）。`);
      const aggAll = runKbQuery<Array<{ topic: string; learned: number; total: number; next: string }>>(
        dataDir, db, parentId, "kb.progress.list", { child_id: child.id }
      );
      const want = String(params.topic ?? "").trim();
      const target = want ? topics.find((t) => t.topic_key === want || t.name === want) : undefined;
      if (want && !target) {
        throw new Error(`找不到主题「${want}」（孩子的主题：${topics.map((t) => `${t.name}(${t.topic_key})`).join("、")}）`);
      }
      const lines: string[] = [`「${child.name}」的课程结构：`];
      for (const t of want && target ? [target] : topics) {
        const agg = aggAll?.find((p) => p.topic === t.topic_key);
        const learned = agg?.learned ?? 0;
        const total = agg?.total ?? 0;
        const rows = runKbQuery<Array<{ title: string; status: string }>>(
          dataDir, db, parentId, "kb.courses.list", { child_id: child.id, topic: t.topic_key }
        );
        const titles = (rows ?? []).map((r) => String(r.title ?? ""));
        const statusOf = (ti: string) => rows?.find((r) => String(r.title) === ti)?.status ?? "";
        const notLearned = titles.filter((ti) => statusOf(ti) !== "✅");
        lines.push(`- ${t.name}（${t.topic_key}）：共 ${total} 课，已学 ${learned}${notLearned.length ? `，未学 ${notLearned.length} 课` : "，已全部学完 ✅"}`);
        const show = want ? titles.map((ti) => `${ti}（${statusOf(ti) === "✅" ? "已学" : "未学"}）`) : notLearned.map((ti) => `${ti}（未学）`);
        const cap = show.length > 40 ? show.slice(0, 40).concat([`…其余 ${show.length - 40} 课略`]) : show;
        for (const s of cap) lines.push(`    - ${s}`);
      }
      return ok(lines.join("\n"));
    },
  });

  const createTool = defineTool({
    name: "study_plan_create",
    label: "创建学习计划排期（逐日）",
    description:
      "为某孩子创建**学习计划排期**（「每天学什么」的逐日安排，服务端真源）。一次调用可排**多天**，也可一天多课。\n" +
      "**参数**：`childName` 必填；`days` 必填数组，每项 = `date`（YYYY-MM-DD，口语「周五」先换算成日期）+ `content`（当天课程名数组，一项一课）。\n" +
      "**新学 / 复习**：库内每行带 mode 字段（new=新学 / review=复习）；排某课为复习时在内容前加「复习：」前缀（如 \"复习：论语学而篇第一章\"）。已学完的课要巩固就走复习。\n" +
      "**用前先查**：排前先 `study_plan_sources` 查孩子真实课程名，按**真实存在的课程名**安排；空天 = 不要求学。同日同课已存在会自动跳过；未学完次日自动顺延。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      days: Type.Array(
        Type.Object({
          date: Type.String({ description: "哪天学，YYYY-MM-DD" }),
          content: Type.Array(Type.String({ description: "当天要学的课程名（一项一课；复习加「复习：」前缀）" })),
        }),
        { description: "排期日期数组（必填）" }
      ),
    }),
    execute: async (_id: string, params: { childName: string; days: Array<{ date: string; content: string[] }> }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const days = Array.isArray(params.days) ? params.days : [];
      if (!days.length) throw new Error("study_plan_create 需要 days（至少一天的安排）");
      const created: string[] = [];
      for (const day of days) {
        const date = String(day.date ?? "").trim();
        if (!validDate(date)) throw new Error(`排期日期格式应为 YYYY-MM-DD：${date}`);
        const rawItems = Array.isArray(day.content) ? day.content.map((t) => String(t).trim()).filter(Boolean) : [];
        if (!rawItems.length) throw new Error(`${date} 没有内容：content 至少一项（这天空着就不用排）`);
        if (rawItems.length > 100) throw new Error(`${date} 内容超过 100 项上限`);
        const items = rawItems.map((t) => splitActionPrefix(t));
        // 去重：同日同课同 mode 已存在则跳过（与路由幂等语义一致）
        const existing = readStudyPlans(dataDir, parentId, child.id).filter(
          (r) => r.active === 1 && (r.start_at || "").slice(0, 10) === date
        );
        const have = new Set(existing.map((r) => `${r.topic_key}\u0000${r.course_name}\u0000${r.mode}`));
        // 先反查 topic_key/uuid，再用**反查后的 topicKey** 做去重（与路由顺序一致——
        // 若用空占位匹配，已存行的 topic_key 非空时防重会失效导致重复插入）
        const { titleToTopic, titleToUuid } = buildCourseLookup(dataDir, parentId);
        const withTopic = items.map((it) => ({ ...it, topicKey: titleToTopic.get(it.courseName) || "" }));
        const fresh = withTopic.filter((it) => !have.has(`${it.topicKey}\u0000${it.courseName}\u0000${it.mode}`));
        if (!fresh.length) {
          created.push(`${date}：内容已存在，跳过`);
          continue;
        }
        const kb = openKb(dataDir, parentId, child.id);
        const inserted: string[] = [];
        try {
          for (const it of fresh) {
            const topicKey = it.topicKey;
            const courseUuid = titleToUuid.get(it.courseName) || "";
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            kb.prepare(
              `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,recurrence_id,
                 start_at,due_at,status,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,'conversation','','',?,?,'pending','','',?,1,0,1,?,?)`
            ).run(id, parentId, child.id, topicKey, courseUuid, it.courseName, it.mode, "parent", `${date} 00:00:00`, `${date} 23:59:59`, "required", now, now);
            have.add(`${topicKey}\u0000${it.courseName}\u0000${it.mode}`);
            inserted.push(`${it.courseName}（${it.mode === "review" ? "复习" : "新学"}）`);
          }
        } finally {
          kb.close();
        }
        created.push(`${date}：新增 ${inserted.length} 项（${inserted.join("、")}）`);
      }
      return ok(`已为「${child.name}」创建学习计划：\n${created.map((c) => `- ${c}`).join("\n")}\n（未学完会自动顺延到次日；想改某天用 study_plan_list 看当前安排）`);
    },
  });

  const listTool = defineTool({
    name: "study_plan_list",
    label: "查看学习计划（排期行列表）",
    description:
      "查看某孩子的**全部生效学习计划排期行**（一课一行）：date / 课程 / mode（新学|复习）/ 完成态 / 来源（家长排 or 📋 顺延）/ **行 id**（改删某行用它）。\n" +
      "**可选过滤**：from / to（YYYY-MM-DD，含边界）。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      from: Type.Optional(Type.String({ description: "只看此日期（含）之后的排期行" })),
      to: Type.Optional(Type.String({ description: "只看此日期（含）之前的排期行" })),
    }),
    execute: async (_id: string, params: { childName: string; from?: string; to?: string }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      let rows = readStudyPlans(dataDir, parentId, child.id).filter((r) => r.active === 1);
      if (params.from) rows = rows.filter((r) => (r.start_at || "").slice(0, 10) >= params.from!);
      if (params.to) rows = rows.filter((r) => (r.start_at || "").slice(0, 10) <= params.to!);
      if (!rows.length) return ok(`「${child.name}」当前没有学习计划排期。`);
      const lines = rows
        .slice(0, 120)
        .map(
          (r) =>
            `- ${r.id.slice(0, 8)}｜${(r.start_at || "").slice(0, 10)}｜${r.course_name}｜${r.mode === "review" ? "复习" : "新学"}｜${r.status === "done" ? "✅ 已学" : "⬜ 待学"}${r.origin === "carry" ? "｜📋 顺延" : ""}`
        );
      return ok(`「${child.name}」的学习计划（共 ${rows.length} 行，行 id 取前 8 位即可）：\n${lines.join("\n")}`);
    },
  });

  const getTool = defineTool({
    name: "study_plan_get",
    label: "查看某天学习安排",
    description:
      "查看某孩子**某一天**的学习与生活安排（当日窗口聚合；📋 = 前一天没学完自动顺延来的）。\n" +
      "**参数**：`childName` 必填；`date` 可选（缺省 = 今天）。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      date: Type.Optional(Type.String({ description: "哪天，YYYY-MM-DD；缺省 = 今天" })),
    }),
    execute: async (_id: string, params: { childName: string; date?: string }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const day = String(params.date ?? "").trim() || localToday();
      if (!validDate(day)) throw new Error(`date 格式应为 YYYY-MM-DD：${day}`);
      const kb = openKb(dataDir, parentId, child.id);
      let studyRows: SpRow[] = [];
      let lifeRows: Array<{ id: string; title: string; creator: string; origin: string; status: string; done_at: string }> = [];
      try {
        studyRows = kb
          .prepare(
            `SELECT * FROM study_plans WHERE active = 1 AND status != 'cancelled'
               AND (start_at = '' OR substr(start_at,1,10) <= ?) AND (due_at = '' OR substr(due_at,1,10) >= ?)
             ORDER BY created_at ASC`
          )
          .all(day, day) as unknown as SpRow[];
        lifeRows = kb
          .prepare(
            `SELECT id, title, creator, origin, status, done_at FROM life_plans
             WHERE active = 1 AND status != 'cancelled'
               AND (start_at = '' OR substr(start_at,1,10) <= ?) AND (due_at = '' OR substr(due_at,1,10) >= ?)
             ORDER BY due_at, created_at ASC`
          )
          .all(day, day) as unknown as typeof lifeRows;
      } finally {
        kb.close();
      }
      if (!studyRows.length && !lifeRows.length) {
        return ok(`「${child.name}」${day} 没有安排（空天 = 不要求学）。`);
      }
      const lines: string[] = [`「${child.name}」${day} 的安排：`];
      for (const r of studyRows) {
        lines.push(`- [学习] ${r.origin === "carry" ? "📋 " : ""}${r.course_name}（${r.mode === "review" ? "复习" : "新学"}，${r.status === "done" ? "✅" : "⬜"}）`);
      }
      for (const r of lifeRows) {
        lines.push(`- [生活] ${r.origin === "carry" ? "📋 " : ""}${r.title}（${r.creator === "parent" ? "必须完成项" : "加分项"}，${r.status === "done" ? "✅" : "⬜"}）`);
      }
      return ok(lines.join("\n"));
    },
  });

  const updateTool = defineTool({
    name: "study_plan_update",
    label: "修改学习计划（删/挪天/改复习）",
    description:
      "修改某孩子**已有的一条排期**（一课一行；先 study_plan_list 拿行 id）。三种动作：\n" +
      "- `delete` + `id`：删除该课的这条排期\n" +
      "- `reschedule` + `id` + `date`：把该课挪到另一天\n" +
      "- `setmode` + `id` + `mode`（new|review）：新学 ↔ 复习\n" +
      "改完可用 study_plan_get 核对。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      act: Type.String({ description: "动作：delete | reschedule | setmode" }),
      id: Type.String({ description: "排期行 id（study_plan_list 返回；可传前 8 位）" }),
      date: Type.Optional(Type.String({ description: "reschedule 时必填：改到哪天 YYYY-MM-DD" })),
      mode: Type.Optional(Type.String({ description: "setmode 时必填：new=新学 / review=复习" })),
    }),
    execute: async (_id: string, params: { childName: string; act: string; id: string; date?: string; mode?: string }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const act = String(params.act ?? "").trim();
      if (!["delete", "reschedule", "setmode"].includes(act)) {
        throw new Error("study_plan_update 的 act 仅支持 delete / reschedule / setmode");
      }
      const wantId = String(params.id ?? "").trim();
      // 全部孩子的行里定位（行 id 可能截短；本工具按该孩子查找即可，家长只能动自己孩子的）
      let row: SpRow | undefined;
      const all = readStudyPlans(dataDir, parentId, child.id);
      row = all.find((r) => r.id === wantId || r.id.startsWith(wantId));
      if (!row) throw new Error("找不到排期行（先 study_plan_list 核对行 id）");
      const kb = openKb(dataDir, parentId, child.id);
      try {
        if (act === "delete") {
          kb.prepare("DELETE FROM study_plans WHERE id = ?").run(row.id);
          return ok(`已删除「${child.name}」${(row.start_at || "").slice(0, 10)} 的「${row.course_name}」排期。`);
        }
        if (act === "reschedule") {
          const date = String(params.date ?? "").trim();
          if (!validDate(date)) throw new Error(`reschedule 需要 date（YYYY-MM-DD）：${date}`);
          kb.prepare("UPDATE study_plans SET start_at = ?, due_at = ?, updated_at = ? WHERE id = ?").run(
            `${date} 00:00:00`, `${date} 23:59:59`, new Date().toISOString(), row.id
          );
          return ok(`已将「${child.name}」的「${row.course_name}」从 ${(row.start_at || "").slice(0, 10)} 改到 ${date}。`);
        }
        const mode = String(params.mode ?? "").trim().toLowerCase();
        if (mode !== "new" && mode !== "review") throw new Error("setmode 的 mode 仅支持 new / review");
        kb.prepare("UPDATE study_plans SET mode = ?, updated_at = ? WHERE id = ?").run(mode, new Date().toISOString(), row.id);
        return ok(`已将「${child.name}」的「${row.course_name}」设为${mode === "review" ? "复习" : "新学"}。`);
      } finally {
        kb.close();
      }
    },
  });

  const lifeCreateTool = defineTool({
    name: "parent_plan_create",
    label: "创建孩子生活计划（必须完成项）",
    description:
      "为孩子创建**生活计划**（必须完成项，制定人=家长）：日常任务类安排，如「每天整理书包」「周五前完成手工」「睡前阅读 20 分钟」。\n" +
      "**参数**：`childName` 必填；`days` 必填数组，每项 = `date` + `title`（要做的事，时间放 time）+ `time`（可选 HH:mm 截止时刻）。\n" +
      "**语义**：这些是必须完成项——当天没完成影响完成率与积分（可能扣分），到点未完成自动顺延。孩子端「今日计划」会显示为「必须完成项（家长制定）」。同天同标题已存在会自动跳过。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      days: Type.Array(
        Type.Object({
          date: Type.String({ description: "哪天做，YYYY-MM-DD（口语先换算成日期）" }),
          title: Type.String({ description: "要做的事（干净表述，时间放 time 参数）" }),
          time: Type.Optional(Type.String({ description: "截止时刻 HH:mm（可选），如 20:30" })),
        }),
        { description: "生活计划数组（必填）" }
      ),
    }),
    execute: async (_id: string, params: { childName: string; days: Array<{ date: string; title: string; time?: string }> }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const days = Array.isArray(params.days) ? params.days : [];
      if (!days.length) throw new Error("parent_plan_create 需要 days（至少一天的生活安排）");
      const created: string[] = [];
      for (const d of days) {
        const date = String(d.date ?? "").trim();
        if (!validDate(date)) throw new Error(`日期格式应为 YYYY-MM-DD：${date}`);
        const title = String(d.title ?? "").trim();
        if (!title) throw new Error(`${date} 缺少 title（要做的事）`);
        if (title.length > 200) throw new Error("title 过长（≤200 字）");
        const time = String(d.time ?? "").trim();
        if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`time 格式应为 HH:mm：${time}`);
        // 防重语义与 /plans/life 路由一致：同 title+creator 当天已有 pending 行则跳过
        const kb = openKb(dataDir, parentId, child.id);
        try {
          const dup = kb
            .prepare(
              `SELECT id FROM life_plans WHERE title = ? AND creator = 'parent' AND active = 1 AND status IN ('pending')
                 AND substr(start_at,1,10) <= ? AND substr(due_at,1,10) >= ?`
            )
            .get(title, date, date) as { id: string } | undefined;
          if (dup) {
            created.push(`${date}「${title}」（已存在，跳过）`);
            continue;
          }
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          kb.prepare(
            `INSERT INTO life_plans
               (id,parent_id,child_id,title,creator,origin,carry_from,recurrence_id,start_at,due_at,status,result,done_at,
                task_type,count_in_rate,points,active,created_at,updated_at)
             VALUES (?,?,?,?,?,'conversation','','',?,?,'pending','','',?,1,0,1,?,?)`
          ).run(id, parentId, child.id, title, "parent", `${date} 00:00:00`, time ? `${date} ${time}:00` : `${date} 23:59:59`, "required", now, now);
          created.push(`${date}「${title}」${time ? `（${time} 前）` : ""}`);
        } finally {
          kb.close();
        }
      }
      return ok(`已为「${child.name}」创建生活计划（必须完成项）：\n${created.map((c) => `- ${c}`).join("\n")}\n（当天未完成会影响完成率与积分，未完成自动顺延；想取消用家长端「积分」页的取消按钮。）`);
    },
  });

  const examCreateTool = defineTool({
    name: "exam_schedule_create",
    label: "创建自定义考核排期",
    description:
      "为某孩子创建一次**自定义考核排期**（家长对话预约：某天考什么内容；到当天孩子即可在考核页参加）。\n" +
      "**参数**：`childName` 必填；`scheduledAt` 考核日期（YYYY-MM-DD，按日期全天可考）；`courses` **必填**且必须是**精确课程名**数组。\n" +
      "**约束（2026-09-09 起）**：自定义考核不再做运行时选课——必须现在就把「考乡党篇最近学的 3 课」这类描述**解析成精确课程名**（可先 study_plan_sources / parent_library_courses 查），信息不全必须向家长确认，**不要自行猜测**。\n" +
      "`note` 可选（给孩子的说明）。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      scheduledAt: Type.String({ description: "考核日期 YYYY-MM-DD（口语先换算）" }),
      courses: Type.Array(Type.String({ description: "要考核的精确课程名（必填）" })),
      note: Type.Optional(Type.String({ description: "考核内容说明（给孩子的提示，可空）" })),
    }),
    execute: async (_id: string, params: { childName: string; scheduledAt: string; courses: string[]; note?: string }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const scheduledAt = String(params.scheduledAt ?? "").trim();
      if (!scheduledAt) throw new Error("exam_schedule_create 需要 scheduledAt（考核日期）");
      const courses = (params.courses ?? []).map((c) => String(c).trim()).filter(Boolean);
      if (!courses.length) {
        throw new Error("请先确定这次要考核的**具体课程**（courses）再创建：把家长说的内容范围解析成课程名（可先查孩子的课程/学习记录），或向家长确认。");
      }
      const parsedAt = new Date(scheduledAt);
      if (Number.isNaN(parsedAt.getTime())) throw new Error(`考核日期无法解析：${scheduledAt}`);
      const d = new Date(parsedAt.getTime());
      d.setHours(0, 0, 0, 0);
      const id = `sch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const scope = JSON.stringify({ topics: [], courses, note: String(params.note ?? "") });
      db.prepare(
        "INSERT INTO exam_schedules (id, parent_id, child_id, kind, freq, scheduled_at, scope, status, created_at) VALUES (?, ?, ?, 'custom', '', ?, ?, 'pending', ?)"
      ).run(id, parentId, child.id, new Date(d.getTime()).toISOString(), scope, new Date().toISOString());
      return ok(`已为孩子「${child.name}」创建自定义考核排期（${scheduledAt}），考核课程：${courses.join("、")}${params.note ? `；说明：${params.note}` : ""}。到当天孩子即可在考核页参加。`);
    },
  });

  return [
    listChildrenTool,
    sourcesTool,
    createTool,
    listTool,
    getTool,
    updateTool,
    lifeCreateTool,
    examCreateTool,
  ];
}

export const PLAN_DOMAIN_TOOL_NAMES = [
  "parent_list_children",
  "study_plan_sources",
  "study_plan_create",
  "study_plan_list",
  "study_plan_get",
  "study_plan_update",
  "parent_plan_create",
  "exam_schedule_create",
];
