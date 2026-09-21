/**
 * 家长 agent 的计划域工具（2026-09-13 上移补齐）：学习计划 / 生活计划 / 考核排期。
 *
 * 与旧客户端工具（P4 删除前）语义一一对应，但**不再走 HTTP 自调用**——直接读写
 * 服务端数据真源（孩子 kb 的 study_plans / life_plans / exam_plans + plan_recurrences），
 * SQL 与各路由严格对齐（study-plans.ts / plans-rewards.ts / exam.ts），改路由须同步改这里。
 * 2026-09-14 考核域重构：exam_schedules 排期表已取消——自定义考核直接写孩子库 exam_plans；
 * 每日/每周固定考核为配置项（settings `exam_fixed:<parentId>`），worker 每天生成当天考核计划。
 *
 * 命名约定：家长端工具一律 `parent_` 前缀；孩子端工具一律 `child_` 前缀（plan-tools.ts）。
 * 工具清单（对应旧实现）：
 *   parent_list_children      孩子名单（childName 解析的基础，也是家长 agent 基础工具）
 *   parent_study_plan_sources     孩子课程结构（起草案期前查，只读）
 *   parent_study_plan_create      学习计划排期（days[]，一次可排多天；「复习：」前缀 → review）
 *   parent_study_plan_list        排期行列表（含行 id，改/删前先 list）
 *   parent_study_plan_get         某天安排（当日聚合，含 carry 顺延与生活计划）
 *   parent_study_plan_update      delete / reschedule / setmode
 *   parent_life_plan_create       生活计划（必须完成项，creator=parent，防重）
 *   parent_life_plan_list         查看孩子生活计划（行 id，改删前先 list）
 *   parent_life_plan_update       修改生活计划（delete / reschedule / rename；家长可操作任意 creator 行）
 *   parent_exam_plan_create       自定义考核计划（直接写孩子库 exam_plans；courses 必须为精确课程名）
 *   parent_exam_plan_list         查看孩子考核计划（孩子库 exam_plans；行 id，改/删/开考前先 list）
 *   parent_exam_plan_cancel       取消/删除孩子库考核计划（软删 active=0/status=cancelled，done 不可取消；实际考核场次在主库 exam_attempts）
 */
import crypto from "node:crypto";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import { openKb } from "../db/kb.js";
import { openParentLib } from "../db/parent-lib.js";
import {
  buildPlanSpecEntries,
  formatPlanCourses,
  inferReciteOnlyFromNote,
  parsePlanCourses,
  type PlanCourseSpec,
} from "../assess-selection.js";
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

/** 许可允许的最大孩子数（license_json.max_children；无/非法 → null 表示不限制）。 */
function maxChildrenAllowed(db: DatabaseSync, parentId: string): number | null {
  try {
    const row = db.prepare("SELECT license_json FROM parents WHERE id = ?").get(parentId) as
      | { license_json?: string | null }
      | undefined;
    const lic = row?.license_json ? (JSON.parse(row.license_json) as { max_children?: unknown }) : {};
    const n = Number(lic.max_children);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
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

interface LpRow {
  id: string;
  child_id: string;
  title: string;
  creator: string;
  origin: string;
  start_at: string;
  due_at: string;
  status: string;
  done_at: string;
}

function readLifePlans(dataDir: string, parentId: string, childId: string): LpRow[] {
  const kb = openKb(dataDir, parentId, childId);
  try {
    return kb
      .prepare("SELECT * FROM life_plans WHERE active = 1 ORDER BY due_at, created_at")
      .all() as unknown as LpRow[];
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

  const childCreateTool = defineTool({
    name: "parent_child_create",
    label: "添加孩子",
    description:
      "为家长添加一个**孩子**（只写档案，不设密码）。\n" +
      "**参数**：`name` 必填（孩子姓名）；可选 `aiName`（AI 伙伴名字）/ `aiEmoji`（头像表情）/ `aiPersonality`（AI 性格）/ `age`（年龄）/ `grade`（年级）/ `interests`（兴趣）。\n" +
      "**注意**：孩子登录密码**不能**由本工具设置——请家长到「孩子管理」里为孩子设置/重置密码。受家长账号的孩子数量上限约束。",
    parameters: Type.Object({
      name: Type.String({ description: "孩子姓名" }),
      aiName: Type.Optional(Type.String({ description: "AI 伙伴名字" })),
      aiEmoji: Type.Optional(Type.String({ description: "头像表情" })),
      aiPersonality: Type.Optional(Type.String({ description: "AI 伙伴性格" })),
      age: Type.Optional(Type.Number({ description: "年龄" })),
      grade: Type.Optional(Type.String({ description: "年级" })),
      interests: Type.Optional(Type.String({ description: "兴趣" })),
    }),
    execute: async (_id: string, params: Record<string, unknown>) => {
      const name = String(params.name ?? "").trim();
      if (!name) throw new Error("parent_child_create 需要 name（孩子姓名）");
      if (name.length > 40) throw new Error("姓名过长（≤40 字）");
      const max = maxChildrenAllowed(db, parentId);
      if (max != null) {
        const cnt = (db.prepare("SELECT COUNT(*) AS n FROM children WHERE parent_id = ?").get(parentId) as { n: number }).n;
        if (cnt >= max) throw new Error(`已到孩子数量上限（${max} 个）。如需增加请升级订阅或先删除不用的孩子。`);
      }
      const dup = db.prepare("SELECT id FROM children WHERE parent_id = ? AND name = ?").get(parentId, name);
      if (dup) throw new Error(`已存在名为「${name}」的孩子（请换名字或编辑现有孩子）。`);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const profile: Record<string, unknown> = { createdAt: now };
      if (String(params.aiName ?? "").trim()) profile.aiName = String(params.aiName).trim();
      if (String(params.aiEmoji ?? "").trim()) profile.aiEmoji = String(params.aiEmoji).trim();
      if (String(params.aiPersonality ?? "").trim()) profile.aiPersonality = String(params.aiPersonality).trim();
      if (params.age != null) profile.age = Number(params.age);
      if (String(params.grade ?? "").trim()) profile.grade = String(params.grade).trim();
      if (String(params.interests ?? "").trim()) profile.interests = String(params.interests).trim();
      db.prepare(
        "INSERT INTO children (id, parent_id, name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, parentId, name, JSON.stringify(profile), now, now);
      return ok(`已添加孩子「${name}」${String(params.aiName ?? "").trim() ? `（AI 伙伴：${String(params.aiName).trim()}）` : ""}。孩子登录密码请家长到「孩子管理」里设置。`);
    },
  });

  const childUpdateTool = defineTool({
    name: "parent_child_update",
    label: "编辑孩子档案",
    description:
      "编辑某孩子的档案（姓名 / AI 伙伴名字与性格 / 年龄 / 年级 / 兴趣）。\n" +
      "**参数**：`childName` 必填（现有孩子姓名，用于定位）；其余可选，只改你传的字段。\n" +
      "**注意**：不改密码（密码由家长在「孩子管理」里重置）。",
    parameters: Type.Object({
      childName: Type.String({ description: "现有孩子姓名（定位用）" }),
      name: Type.Optional(Type.String({ description: "新姓名（改名）" })),
      aiName: Type.Optional(Type.String({ description: "AI 伙伴名字" })),
      aiEmoji: Type.Optional(Type.String({ description: "头像表情" })),
      aiPersonality: Type.Optional(Type.String({ description: "AI 伙伴性格" })),
      age: Type.Optional(Type.Number({ description: "年龄" })),
      grade: Type.Optional(Type.String({ description: "年级" })),
      interests: Type.Optional(Type.String({ description: "兴趣" })),
    }),
    execute: async (_id: string, params: Record<string, unknown>) => {
      const child = resolvePlanChild(db, parentId, String(params.childName ?? ""));
      const row = db.prepare("SELECT profile_json FROM children WHERE id = ?").get(child.id) as
        | { profile_json?: string | null }
        | undefined;
      let merged: Record<string, unknown> = {};
      if (row?.profile_json) {
        try {
          merged = JSON.parse(row.profile_json) as Record<string, unknown>;
        } catch {
          merged = {};
        }
      }
      const changed: string[] = [];
      const newName = String(params.name ?? "").trim();
      if (newName) {
        db.prepare("UPDATE children SET name = ?, updated_at = ? WHERE id = ?").run(newName, new Date().toISOString(), child.id);
        changed.push(`改名「${newName}」`);
      }
      if (String(params.aiName ?? "").trim()) {
        merged.aiName = String(params.aiName).trim();
        changed.push("AI 伙伴名字");
      }
      if (String(params.aiEmoji ?? "").trim()) merged.aiEmoji = String(params.aiEmoji).trim();
      if (String(params.aiPersonality ?? "").trim()) {
        merged.aiPersonality = String(params.aiPersonality).trim();
        changed.push("AI 性格");
      }
      if (params.age != null) {
        merged.age = Number(params.age);
        changed.push("年龄");
      }
      if (String(params.grade ?? "").trim()) {
        merged.grade = String(params.grade).trim();
        changed.push("年级");
      }
      if (String(params.interests ?? "").trim()) {
        merged.interests = String(params.interests).trim();
        changed.push("兴趣");
      }
      db.prepare("UPDATE children SET profile_json = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify(merged),
        new Date().toISOString(),
        child.id
      );
      return ok(`已更新「${newName || child.name}」${changed.length ? `（${changed.join("、")}）` : "（无字段变化）"}。`);
    },
  });

  const sourcesTool = defineTool({
    name: "parent_study_plan_sources",
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
    name: "parent_study_plan_create",
    label: "创建学习计划排期（逐日）",
    description:
      "为某孩子创建**学习计划排期**（「每天学什么」的逐日安排，服务端真源）。一次调用可排**多天**，也可一天多课。\n" +
      "**参数**：`childName` 必填；`days` 必填数组，每项 = `date`（YYYY-MM-DD，口语「周五」先换算成日期）+ `content`（当天课程名数组，一项一课）。\n" +
      "**新学 / 复习**：库内每行带 mode 字段（new=新学 / review=复习）；排某课为复习时在内容前加「复习：」前缀（如 \"复习：论语学而篇第一章\"）。已学完的课要巩固就走复习。\n" +
      "**用前先查**：排前先 `parent_study_plan_sources` 查孩子真实课程名，按**真实存在的课程名**安排；空天 = 不要求学。同日同课已存在会自动跳过；未学完次日自动顺延。",
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
      if (!days.length) throw new Error("parent_study_plan_create 需要 days（至少一天的安排）");
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
      return ok(`已为「${child.name}」创建学习计划：\n${created.map((c) => `- ${c}`).join("\n")}\n（未学完会自动顺延到次日；想改某天用 parent_study_plan_list 看当前安排）`);
    },
  });

  const listTool = defineTool({
    name: "parent_study_plan_list",
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
      return ok(`「${child.name}」的学习计划（共 ${rows.length} 行，行 id 取前 8 位）：\n${lines.join("\n")}`);
    },
  });

  const getTool = defineTool({
    name: "parent_study_plan_get",
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
    name: "parent_study_plan_update",
    label: "修改学习计划（删/挪天/改复习）",
    description:
      "修改某孩子**已有的一条排期**（一课一行；先 parent_study_plan_list 拿行 id）。三种动作：\n" +
      "- `delete` + `id`：删除该课的这条排期\n" +
      "- `reschedule` + `id` + `date`：把该课挪到另一天\n" +
      "- `setmode` + `id` + `mode`（new|review）：新学 ↔ 复习\n" +
      "改完可用 parent_study_plan_get 核对。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      act: Type.String({ description: "动作：delete | reschedule | setmode" }),
      id: Type.String({ description: "排期行 id（parent_study_plan_list 返回；可传前 8 位）" }),
      date: Type.Optional(Type.String({ description: "reschedule 时必填：改到哪天 YYYY-MM-DD" })),
      mode: Type.Optional(Type.String({ description: "setmode 时必填：new=新学 / review=复习" })),
    }),
    execute: async (_id: string, params: { childName: string; act: string; id: string; date?: string; mode?: string }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const act = String(params.act ?? "").trim();
      if (!["delete", "reschedule", "setmode"].includes(act)) {
        throw new Error("parent_study_plan_update 的 act 仅支持 delete / reschedule / setmode");
      }
      const wantId = String(params.id ?? "").trim();
      // 全部孩子的行里定位（行 id 可能截短；本工具按该孩子查找即可，家长只能动自己孩子的）
      let row: SpRow | undefined;
      const all = readStudyPlans(dataDir, parentId, child.id);
      row = all.find((r) => r.id === wantId || r.id.startsWith(wantId));
      if (!row) throw new Error("找不到排期行（先 parent_study_plan_list 核对行 id）");
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
    name: "parent_life_plan_create",
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
      if (!days.length) throw new Error("parent_life_plan_create 需要 days（至少一天的生活安排）");
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

  const lifeListTool = defineTool({
    name: "parent_life_plan_list",
    label: "查看孩子生活计划",
    description:
      "查看某孩子的**全部生效生活计划**（必须完成项 + 加分项）：title / 制定人 / 日期 / 完成态 / **行 id**（改删前先 list）。\n" +
      "**可选过滤**：from / to（YYYY-MM-DD，含边界）。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      from: Type.Optional(Type.String({ description: "只看此日期（含）之后的计划行" })),
      to: Type.Optional(Type.String({ description: "只看此日期（含）之前的计划行" })),
    }),
    execute: async (_id: string, params: { childName: string; from?: string; to?: string }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      let rows = readLifePlans(dataDir, parentId, child.id);
      if (params.from) rows = rows.filter((r) => (r.start_at || "").slice(0, 10) >= params.from!);
      if (params.to) rows = rows.filter((r) => (r.due_at || "").slice(0, 10) <= params.to!);
      if (!rows.length) return ok(`「${child.name}」当前没有生活计划。`);
      const lines = rows
        .slice(0, 120)
        .map(
          (r) =>
            `- ${r.id.slice(0, 8)}｜${(r.start_at || "").slice(0, 10)}｜${r.title}｜${r.creator === "parent" ? "必须完成项" : "加分项"}｜${r.status === "done" ? "✅ 已完成" : r.status === "missed" ? "❌ 未完成" : "⬜ 待完成"}${r.origin === "carry" ? "｜📋 顺延" : ""}`
        );
      return ok(`「${child.name}」的生活计划（共 ${rows.length} 行，行 id 取前 8 位）：\n${lines.join("\n")}`);
    },
  });

  const lifeUpdateTool = defineTool({
    name: "parent_life_plan_update",
    label: "修改生活计划（标完成/删/挪天/改名）",
    description:
      "修改某孩子**已有的一条生活计划**（先 parent_life_plan_list 拿行 id）。四种动作：\n" +
      "- `complete` + `id`：把该条标记为**已完成**（孩子确实做了但系统没判出来的兜底；pending/missed 均可标）\n" +
      "- `delete` + `id`：删除该条生活计划\n" +
      "- `reschedule` + `id` + `date`：把该条改到另一天（保留原截止时刻）\n" +
      "- `rename` + `id` + `title`：改事项名称\n" +
      "家长可操作任意 creator 的行（含孩子自己创建的加分项）。改完可用 parent_life_plan_list 核对。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      act: Type.String({ description: "动作：complete | delete | reschedule | rename" }),
      id: Type.String({ description: "生活计划行 id（parent_life_plan_list 返回；可传前 8 位）" }),
      date: Type.Optional(Type.String({ description: "reschedule 时必填：改到哪天 YYYY-MM-DD" })),
      title: Type.Optional(Type.String({ description: "rename 时必填：新名称" })),
    }),
    execute: async (_id: string, params: { childName: string; act: string; id: string; date?: string; title?: string }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const act = String(params.act ?? "").trim();
      if (!["complete", "delete", "reschedule", "rename"].includes(act)) {
        throw new Error("parent_life_plan_update 的 act 仅支持 complete / delete / reschedule / rename");
      }
      const wantId = String(params.id ?? "").trim();
      const all = readLifePlans(dataDir, parentId, child.id);
      const row = all.find((r) => r.id === wantId || r.id.startsWith(wantId));
      if (!row) throw new Error("找不到生活计划行（先 parent_life_plan_list 核对行 id）");
      const kb = openKb(dataDir, parentId, child.id);
      try {
        if (act === "complete") {
          // ISSUE-099 F1：家长 agent 直标完成的兜底入口——recording 把生活计划判成 unknown、
          // 或 done 信号退化成 raw 文本时，家长可在对话里一句话确认完成。
          const nowTs = new Date().toISOString();
          const todayStr = nowTs.slice(0, 10);
          const r = kb
            .prepare("UPDATE life_plans SET status='done', done_at=?, result='生活完成（家长确认）', updated_at=? WHERE id=? AND status IN ('pending','missed')")
            .run(`${todayStr} 12:00:00`, nowTs, row.id);
          if (r.changes === 0) return ok(`「${row.title}」已是完成状态，无需再标。`);
          return ok(
            `已将「${child.name}」的生活计划「${row.title}」标记为完成 ✅` +
              (row.status === "missed" ? "（注：该条此前已判过期；积分结算为一次性，历史流水不追改）" : "")
          );
        }
        if (act === "delete") {
          kb.prepare("DELETE FROM life_plans WHERE id = ?").run(row.id);
          return ok(`已删除「${child.name}」的生活计划「${row.title}」。`);
        }
        if (act === "reschedule") {
          const date = String(params.date ?? "").trim();
          if (!validDate(date)) throw new Error(`reschedule 需要 date（YYYY-MM-DD）：${date}`);
          const oldTime = (row.start_at || "").length > 11 ? (row.start_at || "").slice(11) : "00:00:00";
          kb.prepare("UPDATE life_plans SET start_at = ?, due_at = ?, updated_at = ? WHERE id = ?").run(
            `${date} 00:00:00`, `${date} ${oldTime.slice(0, 8)}`, new Date().toISOString(), row.id
          );
          return ok(`已将「${child.name}」的生活计划「${row.title}」改到 ${date}。`);
        }
        const title = String(params.title ?? "").trim();
        if (!title) throw new Error("rename 需要 title（新名称）");
        if (title.length > 200) throw new Error("title 过长（≤200 字）");
        kb.prepare("UPDATE life_plans SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), row.id);
        return ok(`已将「${child.name}」的生活计划改名为「${title}」。`);
      } finally {
        kb.close();
      }
    },
  });

  const examCreateTool = defineTool({
    name: "parent_exam_plan_create",
    label: "创建自定义考核计划",
    description:
      "为某孩子创建一次**自定义考核计划**（家长对话预约：某天考什么内容；直接写入孩子库考核计划，到当天孩子即可在考核页参加）。\n" +
      "**参数**：`childName` 必填；`scheduledAt` 考核日期（YYYY-MM-DD，按日期全天可考）；`courses` **必填**且必须是**精确课程名**数组。\n" +
      "**约束（2026-09-09 起）**：自定义考核不再做运行时选课——必须现在就把「考乡党篇最近学的 3 课」这类描述**解析成精确课程名**（可先 parent_study_plan_sources / parent_library_courses 查），信息不全必须向家长确认，**不要自行猜测**。\n" +
      "**出题参数在创建时即完整约定（2026-09-14 定案）**：工具会把每门课展开成「考哪些知识点、各几题」写进计划（默认=主题考核方法过滤后全部知识点各 1 题）；**课程必须有知识点和题库题**，否则创建失败并提示先补充考核内容。出题环节严格按计划执行，不再有其它来源。\n" +
      "`note` 可选（给孩子的说明）。\n" +
      "`retake` 可选（**当天重考标准**，ISSUE-115）：家长的自然的语言描述，如「错两题以上当天原题重考」「背诵题不对的当天重新背诵」。**有值 = 考核评分结束后按该标准自动安排当天重考**（评分后经 LLM 生成重考计划，孩子当天考核页可见）；不传或空 = 不重考。家长说「考完错的当天再考一次」类需求时必须转成这个参数，不要只写进 note。\n" +
      "**本次方法覆盖 `methodSpec`（可选）**：当家长说「这次只考背诵 / 只考某几个知识点」等本次特殊要求时用它，只影响这一次考核：\n" +
      "  - `require`：只考这些**知识点**（键=知识点名，值=每个知识点抽几题，缺省 1）；\n" +
      "  - `exclude`：排除这些**知识点**（键=知识点名）；\n" +
      "  - `recitePass`：背诵/朗读题本次通过线（0-100，缺省 90）。\n" +
      "  **⚠️ 意图必须转成 methodSpec，不能只写进 note**（note 不参与出题范围的计算）。常见说法对照：\n" +
      "  「背诵考核 / 只背原文 / 只要背诵」→ `{\"require\":{\"背诵\":1}}`；「只考讲意思/句意」→ `{\"require\":{\"句意白话\":1}}`；\n" +
      "  「不考字词」→ exclude `字词`；「背诵+讲道理」→ `{\"require\":{\"背诵\":1,\"道理\":1}}`。\n" +
      "  不传且说明里含「只考背诵」类表述时，服务端会自动按只考背诵处理（并在返回里注明）。\n" +
      "`name` 可选（**考核名称**，ISSUE-121）：如「论语学而篇背诵考核」「数学口算周测」。**同一天可以有多场考核，靠名字区分**（如上午语文背诵、下午数学口测）；同一天**同名**的未考计划不会重复创建（需更换内容请先取消原计划，或换一个名字）。不传缺省「自定义考核」——**建议都取名字**，孩子端按名字识别是哪场考核。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      scheduledAt: Type.String({ description: "考核日期 YYYY-MM-DD（口语先换算）" }),
      courses: Type.Array(Type.String({ description: "要考核的精确课程名（必填）" })),
      name: Type.Optional(
        Type.String({
          description:
            "考核名称（如「论语学而篇背诵考核」）。同一天可多场考核，靠名字区分；同日同名未考计划不会重复创建。缺省「自定义考核」",
        })
      ),
      note: Type.Optional(Type.String({ description: "考核内容说明（给孩子的提示，可空）" })),
      retake: Type.Optional(
        Type.String({
          description:
            "当天重考标准（自然语言，如「错两题以上当天原题重考」）。有值=评分结束后按标准自动安排当天重考；不传=不重考",
        })
      ),
      methodSpec: Type.Optional(
        Type.Object({
          require: Type.Optional(
            Type.Record(Type.String(), Type.Number(), {
              description: "本次只考这些知识点：{知识点名或uuid: 抽题数}（缺省每个 1 题）",
            })
          ),
          exclude: Type.Optional(Type.Array(Type.String(), { description: "本次排除的知识点名或 uuid" })),
          recitePass: Type.Optional(Type.Number({ description: "背诵/朗读题本次通过线 0-100（缺省 90）" })),
        })
      ),
    }),
    execute: async (
      _id: string,
      params: {
        childName: string;
        scheduledAt: string;
        courses: string[];
        name?: string;
        note?: string;
        retake?: string;
        methodSpec?: { require?: Record<string, number>; exclude?: string[]; recitePass?: number };
      }
    ) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const scheduledAt = String(params.scheduledAt ?? "").trim();
      if (!scheduledAt) throw new Error("parent_exam_plan_create 需要 scheduledAt（考核日期）");
      const courses = (params.courses ?? []).map((c) => String(c).trim()).filter(Boolean);
      if (!courses.length) {
        throw new Error("请先确定这次要考核的**具体课程**（courses）再创建：把家长说的内容范围解析成课程名（可先查孩子的课程/学习记录），或向家长确认。");
      }
      const parsedAt = new Date(scheduledAt);
      if (Number.isNaN(parsedAt.getTime())) throw new Error(`考核日期无法解析：${scheduledAt}`);
      const pd = (n: number) => String(n).padStart(2, "0");
      const day = `${parsedAt.getFullYear()}-${pd(parsedAt.getMonth() + 1)}-${pd(parsedAt.getDate())}`;
      const id = `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // 2026-09-14 定案：**计划生成时即完整约定出题参数**——把课程展开成 [{title, kps:[{name,count}]}]
      // 写入 scope；课程必须有知识点且挂了题库题，否则拒绝创建（出题环节只按约定抽题，不走 LLM）。
      const methodSpec = params.methodSpec;
      // 兜底：家长把「只考背诵」写进了 note 而没转成 methodSpec（note 不参与出题范围计算）→ 自动推断
      const effSpec: { require?: Record<string, number>; exclude?: string[]; recitePass?: number } | null | undefined =
        methodSpec ?? inferReciteOnlyFromNote(String(params.note ?? ""));
      const specFromNote = !methodSpec && !!effSpec;
      const hasMethodSpec =
        !!effSpec && (!!effSpec.require || (effSpec.exclude?.length ?? 0) > 0 || effSpec.recitePass != null);
      const pl = openParentLib(dataDir, parentId);
      let entries: PlanCourseSpec[];
      try {
        const kb0 = openKb(dataDir, parentId, child.id);
        let rows: Array<{ title: string; topic: string }>;
        try {
          const qmarks = courses.map(() => "?").join(",");
          rows = kb0.prepare(`SELECT title, topic FROM courses WHERE title IN (${qmarks})`).all(...courses) as Array<{
            title: string;
            topic: string;
          }>;
        } finally {
          kb0.close();
        }
        if (rows.length < courses.length) {
          const found = new Set(rows.map((r) => r.title));
          const notFound = courses.filter((t) => !found.has(t));
          throw new Error(`这些课程在孩子库里不存在：${notFound.join("、")}`);
        }
        const r = buildPlanSpecEntries(pl, child.id, rows, hasMethodSpec ? effSpec! : null);
        if (r.missing.length) {
          throw new Error(
            `无法创建考核计划——以下课程还没有考核内容（需要先挂知识点和题库题）：${r.missing.map((m) => `${m.title}（${m.reason}）`).join("；")}`
          );
        }
        entries = r.entries;
      } finally {
        pl.close();
      }
      const scope = JSON.stringify({
        courses: entries,
        note: String(params.note ?? ""),
        ...(hasMethodSpec && effSpec?.recitePass != null ? { recitePass: Number(effSpec.recitePass) } : {}),
      });
      const kb = openKb(dataDir, parentId, child.id);
      try {
        // ISSUE-121：同日多场考核靠**名字**区分——去重收窄为「同日同名」，不同名可并存
        const title = String(params.name ?? "").trim() || "自定义考核";
        const dup = kb
          .prepare(
            "SELECT id FROM exam_plans WHERE child_id = ? AND kind = 'custom' AND creator = 'parent' AND active = 1 AND status = 'pending' AND substr(start_at,1,10) = ? AND title = ?"
          )
          .get(child.id, day, title) as { id: string } | undefined;
        if (dup) {
          return ok(
            `「${child.name}」${day} 已有同名未考考核计划「${title}」，未重复创建（换一个名字可同天多场；需更换内容请先取消原计划）。`
          );
        }
        const now = new Date().toISOString();
        // ISSUE-115：retake = 当天重考标准（自然语言）；''=不重考
        const retake = String(params.retake ?? "").trim();
        kb.prepare(
          `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
             start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at,retake)
           VALUES (?,?,?,?,'parent','custom','',?,'conversation','',?,?, 'pending','',NULL,'','','required',1,0,1,?,?,?)`
        ).run(id, parentId, child.id, title, scope, `${day} 00:00:00`, `${day} 23:59:59`, now, now, retake);
      } finally {
        kb.close();
      }
      const ovNote = hasMethodSpec
        ? `；本次方法覆盖：${[
            effSpec?.require ? `只考 ${Object.keys(effSpec.require).join("、")}` : "",
            effSpec?.exclude?.length ? `排除 ${effSpec.exclude.join("、")}` : "",
            effSpec?.recitePass != null ? `背诵通过线 ${effSpec.recitePass}` : "",
          ]
            .filter(Boolean)
            .join("；")}${specFromNote ? "（依据考核说明自动识别，如与家长意图不符请取消后重排并明确传入 methodSpec）" : ""}`
        : "";
      const perCourse = entries.map((e) => `${e.title}（${e.kps.map((k) => `${k.name}×${k.count}`).join("、")}）`).join("；");
      const examTitle = String(params.name ?? "").trim() || "自定义考核";
      return ok(
        `已为孩子「${child.name}」创建考核计划「${examTitle}」（${day}）。出题约定：${perCourse}${params.note ? `；说明：${params.note}` : ""}${ovNote}。到当天孩子即可在考核页参加。`
      );
    },
  });

  const examListTool = defineTool({
    name: "parent_exam_plan_list",
    label: "查看孩子考核计划",
    description:
      "查看某孩子的**考核计划**（孩子库 exam_plans，出现在「今日计划」；含固定档配置生成的、家长自定义的、孩子自请的三类）：日期 / 类型 / 制定人 / 状态 / 行 id。\n" +
      "每条还带**考核内容细节**：考哪些课程、每门课考哪些知识点各抽几题（`课程（知识点×题数）`）、计划级考核方法（只考/不考哪些知识点、背诵通过线）、说明。\n" +
      "固定档（kind=fixed）的课程由「本周期学习计划的必学课程」在开考时确定，**不固化在计划里**，因此不列具体课程——这是正常的，不是数据缺失。\n" +
      "**取消某条考核计划**用 parent_exam_plan_cancel。实际考核场次（孩子真正提交的考试，含逐题记录与得分）在主库 exam_attempts，可在家长端「考核记录」查看，不受取消影响。\n" +
      "**可选过滤**：from / to（YYYY-MM-DD，含边界）。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      from: Type.Optional(Type.String({ description: "只看此日期（含）之后的考核计划" })),
      to: Type.Optional(Type.String({ description: "只看此日期（含）之前的考核计划" })),
    }),
    execute: async (_id: string, params: { childName: string; from?: string; to?: string }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      let rows: Array<{
        id: string;
        title: string;
        creator: string;
        kind: string;
        freq: string;
        status: string;
        score: number | null;
        start_at: string;
        scope_json: string;
      }> = [];
      const kb = openKb(dataDir, parentId, child.id);
      try {
        rows = kb
          .prepare(
            "SELECT id, title, creator, kind, freq, status, score, start_at, scope_json FROM exam_plans WHERE child_id = ? AND active = 1 ORDER BY start_at DESC LIMIT 500"
          )
          .all(child.id) as unknown as typeof rows;
      } finally {
        kb.close();
      }
      if (params.from) rows = rows.filter((r) => (r.start_at || "").slice(0, 10) >= params.from!);
      if (params.to) rows = rows.filter((r) => (r.start_at || "").slice(0, 10) <= params.to!);
      if (!rows.length) return ok(`「${child.name}」当前没有考核计划。`);
      const lines = rows.slice(0, 120).map((r) => {
        // scope_json.courses 有两种历史格式（新=[{title,kps}] / 旧=["课程名"]），统一解析后再展示
        // ⚠️ 旧代码 `String(x)` 会把对象转成 "[object Object]" → 这里曾导致 agent 看不到考了哪些课
        let scope: {
          courses?: unknown;
          topics?: unknown;
          note?: unknown;
          prompt?: unknown;
          methodSpec?: { require?: Record<string, number>; exclude?: string[]; recitePass?: number };
        } = {};
        try {
          const parsed = JSON.parse(r.scope_json || "{}");
          if (parsed && typeof parsed === "object") scope = parsed;
        } catch {
          /* ignore */
        }
        const courseSpecs = parsePlanCourses(scope.courses);
        const courseText = formatPlanCourses(courseSpecs);
        const topics = (Array.isArray(scope.topics) ? scope.topics : [])
          .map((t) => (typeof t === "string" ? t : String((t as { name?: unknown })?.name ?? "")))
          .filter(Boolean);
        // 计划级考核方法（2026-09-14 起可随计划固化）：只考/不考哪些知识点、背诵通过线
        const ms = scope.methodSpec || {};
        const reqKeys = Object.keys(ms.require || {});
        const excKeys = Array.isArray(ms.exclude) ? ms.exclude : [];
        const msText =
          reqKeys.length || excKeys.length || ms.recitePass != null
            ? [
                reqKeys.length ? `只考 ${reqKeys.join("、")}` : "",
                excKeys.length ? `不考 ${excKeys.join("、")}` : "",
                ms.recitePass != null ? `背诵通过线 ${ms.recitePass} 分` : "",
              ]
                .filter(Boolean)
                .join("；")
            : "";
        const note = String(scope.note ?? scope.prompt ?? "").trim();

        const type = r.kind === "custom" ? "自定义" : r.kind === "fixed" ? `固定（${r.freq || "定档"}）` : r.kind || "考核";
        const who = r.creator === "child" ? "｜孩子自请" : "";
        const st =
          r.status === "done"
            ? `✅ 已完成${r.score != null ? `（${r.score} 分）` : ""}`
            : r.status === "missed"
              ? "❌ 未完成"
              : r.status === "cancelled"
                ? "🚫 已取消"
                : "⬜ 待考";
        // 固定档的课程由"本周期必学课程"在开考时决定，不固化在计划里 → 明确说明，避免被当成数据缺失
        const courseLine = courseText
          ? `\n    考核内容：${courseText}`
          : r.kind === "fixed"
            ? `\n    考核内容：按本周期学习计划的**必学课程**自动确定（固定档不固化在计划里）`
            : `\n    考核内容：（未约定具体课程）`;
        return (
          `- ${r.id.slice(0, 8)}｜${(r.start_at || "").slice(0, 10)}｜${type}${who}｜${r.title || "考核"}｜${st}` +
          courseLine +
          (topics.length ? `\n    主题：${topics.join("、")}` : "") +
          (msText ? `\n    考核方法：${msText}` : "") +
          (note ? `\n    说明：${note}` : "")
        );
      });
      return ok(
        `「${child.name}」的考核计划（共 ${rows.length} 行，行 id 取前 8 位；取消某条用 parent_exam_plan_cancel）：\n${lines.join("\n")}`
      );
    },
  });

  const examCancelTool = defineTool({
    name: "parent_exam_plan_cancel",
    label: "取消/删除考核计划",
    description:
      "取消某孩子**的一条考核计划**（孩子库 exam_plans，出现在「今日计划」。实际考核场次 = 主库 exam_attempts，孩子真正提交的考试及其逐题记录，不受本工具影响）。\n" +
      "考核计划一旦生成默认只增不删；本工具按**计划行 id**（先 parent_exam_plan_list 拿 id）做**软删除**：置 active=0、status='cancelled'，历史行保留供审计，但不再计入完成率/掌握度。\n" +
      "已考完（status='done'）的考核计划不允许取消（保留成绩）。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      id: Type.String({ description: "考核计划行 id（可传前 8 位）" }),
    }),
    execute: async (_id: string, params: { childName: string; id: string }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const wantId = String(params.id ?? "").trim();
      if (!wantId) throw new Error("parent_exam_plan_cancel 需要 id（考核计划行 id）");
      const kb = openKb(dataDir, parentId, child.id);
      try {
        const rows = kb
          .prepare("SELECT id, title, status FROM exam_plans WHERE child_id = ? AND active = 1")
          .all(child.id) as unknown as Array<{ id: string; title: string; status: string }>;
        const row = rows.find((r) => r.id === wantId || r.id.startsWith(wantId));
        if (!row) throw new Error("找不到考核计划（active 行里匹配不到该 id）");
        if (row.status === "done") {
          throw new Error(`考核计划「${row.title}」已考完，不能取消（成绩需保留，可在考核记录里查看）。`);
        }
        kb.prepare("UPDATE exam_plans SET active = 0, status = 'cancelled', updated_at = ? WHERE id = ?").run(
          new Date().toISOString(),
          row.id
        );
        return ok(`已取消「${child.name}」的考核计划「${row.title}」（软删除，历史保留、不计入完成率）。`);
      } finally {
        kb.close();
      }
    },
  });

  const recurrenceCreateTool = defineTool({
    name: "parent_recurrence_create",
    label: "创建重复计划（每日/每周固定项）",
    description:
      "为孩子创建**重复计划**（固定项）：系统每天按规则**自动展开成当天的计划行**，无需逐天排。\n" +
      "**参数**：`childName` 必填；`planType`（life 生活 / study 学习）；`rule`（daily 每天 / weekly 每周，weekly 必须给 `weekday` 0=周日…6=周六）；\n" +
      "  - planType=life：`title` 必填（要做的事，如「每天背 5 个单词」）；\n" +
      "  - planType=study：`courses` 必填（精确课程名数组，每门课生成一条规则）；\n" +
      "  可选：`startDate`（生效起始日，缺省今天）、`endDate`（结束日，含；缺省长期有效）。\n" +
      "**语义**：这些是家长制定的**必须完成项**（required），展开的行当天未完成会顺延。想停用/删除规则用 parent_recurrence_update。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      planType: Type.String({ description: "life（生活）| study（学习）" }),
      rule: Type.String({ description: "daily（每天）| weekly（每周）" }),
      weekday: Type.Optional(Type.Number({ description: "weekly 必填：0=周日 … 6=周六" })),
      startDate: Type.Optional(Type.String({ description: "生效起始日 YYYY-MM-DD（缺省=今天）" })),
      endDate: Type.Optional(Type.String({ description: "结束日 YYYY-MM-DD（含；缺省=长期有效）" })),
      title: Type.Optional(Type.String({ description: "planType=life 必填：要做的事" })),
      courses: Type.Optional(Type.Array(Type.String(), { description: "planType=study 必填：精确课程名数组" })),
    }),
    execute: async (
      _id: string,
      params: {
        childName: string;
        planType: string;
        rule: string;
        weekday?: number;
        startDate?: string;
        endDate?: string;
        title?: string;
        courses?: string[];
      }
    ) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const planType = String(params.planType ?? "").trim();
      if (planType !== "life" && planType !== "study") throw new Error("planType 仅支持 life / study");
      const rule = String(params.rule ?? "").trim();
      if (rule !== "daily" && rule !== "weekly") throw new Error("rule 仅支持 daily / weekly");
      let weekday: number | null = null;
      if (rule === "weekly") {
        const w = Number(params.weekday);
        if (!Number.isInteger(w) || w < 0 || w > 6) throw new Error("weekly 需要 weekday（0=周日 … 6=周六）");
        weekday = w;
      }
      const startDate = String(params.startDate ?? "").trim() || localToday();
      if (!validDate(startDate)) throw new Error(`startDate 格式应为 YYYY-MM-DD：${startDate}`);
      const endDate = String(params.endDate ?? "").trim();
      if (endDate && !validDate(endDate)) throw new Error(`endDate 格式应为 YYYY-MM-DD：${endDate}`);

      // 组装 payload（每类一条/多条；study 每门课一条）
      const payloads: Array<{ label: string; payload: Record<string, unknown> }> = [];
      if (planType === "life") {
        const title = String(params.title ?? "").trim();
        if (!title) throw new Error("planType=life 需要 title（要做的事）");
        if (title.length > 200) throw new Error("title 过长（≤200 字）");
        payloads.push({ label: title, payload: { title, creator: "parent", task_type: "required", count_in_rate: 1, points: 0 } });
      } else {
        const names = (params.courses ?? []).map((c) => String(c).trim()).filter(Boolean);
        if (!names.length) throw new Error("planType=study 需要 courses（课程名数组）");
        if (names.length > 20) throw new Error("courses 过多（≤20 门）");
        const { titleToTopic, titleToUuid } = buildCourseLookup(dataDir, parentId);
        const missing = names.filter((n) => !titleToTopic.has(n));
        if (missing.length) throw new Error(`课程名不存在：${missing.join("、")}（可先 parent_study_plan_sources / parent_library_courses 核对课程名）`);
        for (const n of names) {
          payloads.push({
            label: n,
            payload: {
              title: n,
              course_name: n,
              topic_key: titleToTopic.get(n) || "",
              course_uuid: titleToUuid.get(n) || "",
              mode: "new",
              creator: "parent",
              task_type: "required",
              count_in_rate: 1,
              points: 0,
            },
          });
        }
      }

      const kb = openKb(dataDir, parentId, child.id);
      try {
        const existing = kb
          .prepare("SELECT plan_type, rule, weekday, payload_json FROM plan_recurrences WHERE enabled = 1")
          .all() as unknown as Array<{ plan_type: string; rule: string; weekday: number | null; payload_json: string }>;
        const seen = new Set(
          existing.map((r) => {
            let p: Record<string, unknown> = {};
            try {
              p = JSON.parse(String(r.payload_json || "{}")) as Record<string, unknown>;
            } catch {
              /* ignore */
            }
            return `${r.plan_type}\u0000${r.rule}\u0000${r.weekday ?? ""}\u0000${String(p.title ?? p.course_name ?? "")}`;
          })
        );
        const created: string[] = [];
        const skipped: string[] = [];
        for (const p of payloads) {
          const key = `${planType}\u0000${rule}\u0000${weekday ?? ""}\u0000${p.label}`;
          if (seen.has(key)) {
            skipped.push(p.label);
            continue;
          }
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          kb.prepare(
            `INSERT INTO plan_recurrences
               (id,parent_id,child_id,plan_type,payload_json,rule,weekday,start_date,end_date,last_expanded_date,enabled,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,'',1,?,?)`
          ).run(id, parentId, child.id, planType, JSON.stringify(p.payload), rule, weekday, startDate, endDate, now, now);
          seen.add(key);
          created.push(p.label);
        }
        const scope = `${rule === "daily" ? "每天" : `每周${["日", "一", "二", "三", "四", "五", "六"][weekday!]}`}`;
        const parts: string[] = [];
        if (created.length) parts.push(`${scope}：${created.join("、")}`);
        if (skipped.length) parts.push(`${skipped.join("、")} 已有相同规则，跳过`);
        return ok(`已为「${child.name}」创建重复计划（${parts.join("；")}）${endDate ? `，至 ${endDate}` : ""}。系统每天会自动展开成当天计划；想停用用 parent_recurrence_list 拿 id 后 parent_recurrence_update。`);
      } finally {
        kb.close();
      }
    },
  });

  const recurrenceListTool = defineTool({
    name: "parent_recurrence_list",
    label: "查看重复计划规则",
    description: "查看某孩子的**重复计划规则**（每日/每周固定项）：类型 / 规则 / 内容 / 生效期 / 启用态 / **规则 id**（停用/删除前先 list）。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
    }),
    execute: async (_id: string, params: { childName: string }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const kb = openKb(dataDir, parentId, child.id);
      try {
        const rows = kb
          .prepare("SELECT * FROM plan_recurrences ORDER BY created_at DESC")
          .all() as unknown as Array<Record<string, unknown>>;
        if (!rows.length) return ok(`「${child.name}」当前没有重复计划。`);
        const lines = rows.slice(0, 120).map((r) => {
          let p: Record<string, unknown> = {};
          try {
            p = JSON.parse(String(r.payload_json || "{}")) as Record<string, unknown>;
          } catch {
            /* ignore */
          }
          const label = String(p.title ?? p.course_name ?? "（未命名）");
          const wd = r.weekday == null ? "" : `周${["日", "一", "二", "三", "四", "五", "六"][Number(r.weekday)]}`;
          const ruleTxt = r.rule === "daily" ? "每天" : `每周(${wd})`;
          const period = `${String(r.start_date || "-")}~${String(r.end_date || "长期")}`;
          return `- ${String(r.id).slice(0, 8)}｜${r.plan_type === "study" ? "学习" : "生活"}｜${ruleTxt}｜${label}｜${period}｜${Number(r.enabled) === 1 ? "启用" : "停用"}`;
        });
        return ok(`「${child.name}」的重复计划（共 ${rows.length} 条，id 取前 8 位）：\n${lines.join("\n")}`);
      } finally {
        kb.close();
      }
    },
  });

  const recurrenceUpdateTool = defineTool({
    name: "parent_recurrence_update",
    label: "停用/启用/删除重复计划规则",
    description:
      "修改某孩子的**重复计划规则**（先 parent_recurrence_list 拿 id）。三种动作：\n" +
      "- `disable` + `id`：停用（不再展开新计划行，历史行保留）\n" +
      "- `enable` + `id`：重新启用\n" +
      "- `delete` + `id`：删除该规则",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名" }),
      act: Type.String({ description: "动作：disable | enable | delete" }),
      id: Type.String({ description: "规则 id（parent_recurrence_list 返回；可传前 8 位）" }),
    }),
    execute: async (_id: string, params: { childName: string; act: string; id: string }) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const act = String(params.act ?? "").trim();
      if (!["disable", "enable", "delete"].includes(act)) throw new Error("act 仅支持 disable / enable / delete");
      const wantId = String(params.id ?? "").trim();
      if (!wantId) throw new Error("parent_recurrence_update 需要 id（规则 id）");
      const kb = openKb(dataDir, parentId, child.id);
      try {
        const rows = kb
          .prepare("SELECT id, plan_type, payload_json FROM plan_recurrences")
          .all() as unknown as Array<{ id: string; plan_type: string; payload_json: string }>;
        const row = rows.find((r) => r.id === wantId || r.id.startsWith(wantId));
        if (!row) throw new Error("找不到重复计划规则（先 parent_recurrence_list 核对 id）");
        let label = "（未命名）";
        try {
          const p = JSON.parse(String(row.payload_json || "{}")) as Record<string, unknown>;
          label = String(p.title ?? p.course_name ?? label);
        } catch {
          /* ignore */
        }
        if (act === "delete") {
          kb.prepare("DELETE FROM plan_recurrences WHERE id = ?").run(row.id);
          return ok(`已删除重复计划规则「${label}」。`);
        }
        kb.prepare("UPDATE plan_recurrences SET enabled = ?, updated_at = ? WHERE id = ?").run(act === "enable" ? 1 : 0, new Date().toISOString(), row.id);
        return ok(`已${act === "enable" ? "启用" : "停用"}重复计划规则「${label}」。`);
      } finally {
        kb.close();
      }
    },
  });

  // ISSUE-116：自定义定时任务——家长自然语言指令，到点由服务端无头 agent 执行（owner 恒 parent）
  const customTaskCreateTool = defineTool({
    name: "parent_scheduler_task_create",
    label: "创建自定义定时任务",
    description:
      "创建**自定义定时任务**：家长用自然语言描述要 agent 周期性完成的事，到点由服务端无头执行（例：每天 6 点查天气并给孩子建 7 天天气播报提醒）。\n" +
      "**参数**：`childName` 必填（执行对象/产物归属孩子）；`name` 任务名；`instruction` 必填（自然语言指令，写清楚做什么、产出什么）；\n" +
      "`time` HH:mm（daily/weekly 触发时刻）；`frequency` daily（默认）| weekly | once | interval；weekly 需 `weekday`（0=周日..6=周六）；interval 需 `intervalMinutes`；once 需 `fireAt`（ISO）。\n" +
      "**能力边界（执行会话工具白名单）**：可查天气（weather_query）、给孩子创建定时提醒（create_reminders，到点语音播报）、读写孩子 daily 记录；\n" +
      "**不能**操作积分/考核/学习计划。指令里涉及「未来 N 天提醒」要写明**一次性批量创建**。\n" +
      "同一天执行失败不重试（次日正常）；执行结果可在任务面板查看。",
    parameters: Type.Object({
      childName: Type.String({ description: "孩子姓名（执行对象）" }),
      name: Type.String({ description: "任务名称（如「每日天气播报」）" }),
      instruction: Type.String({ description: "自然语言指令（写清楚做什么、产出什么，如「查今天天气，创建未来7天每天07:00的天气播报提醒」）" }),
      time: Type.String({ description: "触发时刻 HH:mm（daily/weekly 用）" }),
      frequency: Type.Optional(Type.String({ description: "daily（默认）| weekly | once | interval" })),
      weekday: Type.Optional(Type.Number({ description: "weekly：0=周日..6=周六" })),
      intervalMinutes: Type.Optional(Type.Number({ description: "interval：每隔 N 分钟" })),
      fireAt: Type.Optional(Type.String({ description: "once：目标时间 ISO" })),
    }),
    execute: async (
      _id: string,
      params: {
        childName: string;
        name: string;
        instruction: string;
        time: string;
        frequency?: string;
        weekday?: number;
        intervalMinutes?: number;
        fireAt?: string;
      }
    ) => {
      const child = resolvePlanChild(db, parentId, params.childName);
      const name = String(params.name ?? "").trim();
      const instruction = String(params.instruction ?? "").trim();
      const time = String(params.time ?? "").trim();
      if (!name) throw new Error("parent_scheduler_task_create 需要 name（任务名称）");
      if (!instruction) throw new Error("parent_scheduler_task_create 需要 instruction（自然语言指令）");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`time 格式应为 HH:mm：${time}`);
      const frequency = (["daily", "weekly", "once", "interval"] as const).includes(params.frequency as never)
        ? (params.frequency as "daily" | "weekly" | "once" | "interval")
        : "daily";
      if (frequency === "weekly" && !(Number(params.weekday) >= 0 && Number(params.weekday) <= 6)) {
        throw new Error("weekly 需提供 weekday（0=周日..6=周六）");
      }
      if (frequency === "interval" && !(Number(params.intervalMinutes) > 0)) {
        throw new Error("interval 需提供 intervalMinutes（>0）");
      }
      if (frequency === "once" && !params.fireAt) throw new Error("once 需提供 fireAt（ISO 目标时间）");
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db
        .prepare(
          `INSERT INTO scheduler_tasks (id, parent_id, name, type, time, extra_json, enabled, owner, frequency,
             weekday, interval_minutes, fire_at, instruction, created_at, updated_at)
           VALUES (?, ?, ?, 'custom', ?, '{}', 1, 'parent', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          parentId,
          name,
          time,
          frequency,
          frequency === "weekly" ? Number(params.weekday) : null,
          frequency === "interval" ? Number(params.intervalMinutes) : null,
          frequency === "once" ? String(params.fireAt) : null,
          instruction,
          now,
          now
        );
      db
        .prepare(
          "INSERT INTO scheduler_task_assignments (task_id, child_id, enabled, created_at) VALUES (?, ?, 1, ?)"
        )
        .run(id, child.id, now);
      return ok(
        `已创建自定义定时任务「${name}」（${frequency}${frequency === "weekly" ? ` 周${"日一二三四五六"[Number(params.weekday)] ?? ""}` : ""} ${time}，执行对象：${child.name}）。到点由服务端无头执行，执行结果可在任务面板查看。`
      );
    },
  });

  return [
    listChildrenTool,
    childCreateTool,
    childUpdateTool,
    sourcesTool,
    createTool,
    listTool,
    getTool,
    updateTool,
    lifeCreateTool,
    lifeListTool,
    lifeUpdateTool,
    examCreateTool,
    examListTool,
    examCancelTool,
    recurrenceCreateTool,
    recurrenceListTool,
    recurrenceUpdateTool,
    customTaskCreateTool,
  ];
}

export const PLAN_DOMAIN_TOOL_NAMES = [
  "parent_list_children",
  "parent_child_create",
  "parent_child_update",
  "parent_study_plan_sources",
  "parent_study_plan_create",
  "parent_study_plan_list",
  "parent_study_plan_get",
  "parent_study_plan_update",
  "parent_life_plan_create",
  "parent_life_plan_list",
  "parent_life_plan_update",
  "parent_exam_plan_create",
  "parent_exam_plan_list",
  "parent_exam_plan_cancel",
  "parent_recurrence_create",
  "parent_recurrence_list",
  "parent_recurrence_update",
  "parent_scheduler_task_create",
];
