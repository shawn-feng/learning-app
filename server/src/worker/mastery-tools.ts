/**
 * ISSUE-135 P4（2026-09-23）：掌握闭环的「归纳」工具集 —— 供**自定义定时任务**的无头 agent 调用。
 *
 * 设计（用户 2026-09-23 拍板）：不新增 worker 任务类型、不做类型下拉与配置链路；
 * 「学习情况分析」= 一条 type='custom' 的定时任务（自然语言指令，见 DEFAULT_MASTERY_TASK_INSTRUCTION），
 * 到点由无头 agent 按指令调工具完成。**agent 负责判断与措辞，工具负责确定性的取数与写回**：
 *   - mastery_todo_list          读：待归纳的学习计划 + 需要刷新掌握的课程
 *   - mastery_plan_context       读：一次给全某计划的素材（学习记录/知识点清单/历史掌握/错题）
 *   - mastery_save_records       写：知识点掌握流水（幂等 UPSERT）+ 学习计划 result_summary
 *   - mastery_save_course_mastery 写：courses 掌握四列 + knowledge_point_progress 累计（计数由工具算）
 *
 * 分工理由：素材聚合与写入口径固化在代码里（token 可控、幂等、可单测），
 * LLM 只产出「自然语言判断与叙述」——这正是原来 §4.3 里"规则可算、LLM 只润色"的落地方式。
 * 通用读写由 createDataAgentTools 的 parent_db_read/write 提供（agent 需要额外信息时自查，出错可自愈）。
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool } from "../agent/tool-kit.js"; // ISSUE-134：统一还原字符串化参数
import { openKb } from "../db/kb.js";
import { openParentLib } from "../db/parent-lib.js";

export interface MasteryToolDeps {
  dataDir: string;
  parentId: string;
  childId: string;
}

export const MASTERY_TOOL_NAMES = [
  "mastery_todo_list",
  "mastery_plan_context",
  "mastery_save_records",
  "mastery_save_course_mastery",
];

/** 掌握档位取值（与 courses.mastery_level / knowledge_point_progress.level 同枚举）。 */
const LEVELS = ["not_started", "learning", "needs_review", "mastered"] as const;
const OUTCOMES = ["solid", "partial", "weak"] as const;

/**
 * 默认「学习情况分析」自定义任务的**自然语言指令**（父级可改）。
 * 到点由无头 agent 执行：先看待归纳范围 → 逐计划抽结果 → 逐课刷新掌握与教学建议 → 汇报。
 */
export const DEFAULT_MASTERY_TASK_INSTRUCTION =
  `汇总孩子今天的学习与考核结果，更新知识点掌握情况与下一次的教学建议。\n` +
  `\n步骤：\n` +
  `1. 先调用 mastery_todo_list 看待归纳的学习计划与需要刷新掌握的课程。如果两边都是空的，` +
  `只回一句「今天没有新的学习/考核结果，无需更新」就结束，不要做别的事。\n` +
  `2. 对清单里的每个学习计划调用 mastery_plan_context 取素材（该计划窗口内的学习记录、这门课的知识点清单、` +
  `历史掌握情况、错题本里还没掌握的点），判断这次哪些知识点学会了、哪些没学会：\n` +
  `   - 每个知识点给一个 outcome：solid（清楚掌握）/ partial（大体会但有瑕疵）/ weak（明显没掌握或没讲到）；\n` +
  `   - 每个知识点配一句具体描述（写清会什么、卡在哪），不要写空话；\n` +
  `   - 用 mastery_save_records 写回这次结果，同时给这次学习写一句课程级概要（result_summary）。\n` +
  `3. 对清单里需要刷新掌握的每门课，结合它的知识点历史（含刚写入的这次）与错题本，调用 mastery_save_course_mastery 写回：\n` +
  `   - mastery_level：not_started / learning / needs_review / mastered —— 看最近几次的趋势，不要只看单次成绩；\n` +
  `   - mastery_desc：累计掌握叙述，按「最开始（日期）… → 中间（日期）… → 最新（日期）…」讲清演进，具体到孩子原来错在哪、现在会了什么；\n` +
  `   - teaching_advice：下次教这门课可操作的建议（先做什么、再做什么、哪里要给提示），只做增补，不要改家长写的教学方法；\n` +
  `   - 同一门课的知识点，用 knowledge_points 参数逐个写它自己的 level 与累计叙述。\n` +
  `4. 全部做完用两三句话汇报：处理了几个计划、几门课，哪门课有进步、哪门课要重点复习。` +
  `某一步失败就如实说失败原因，不要编造结果。\n` +
  `\n注意：\n` +
  `- 只处理 mastery_todo_list 返回的范围，不要自己翻全库；确实需要补充信息时用 parent_db_read 查（带等值条件、只取需要的列）。\n` +
  `- 所有描述面向家长、具体可执行；不要输出「掌握度 0.8」这类内部数字。\n` +
  `- 同一天重复运行是安全的：写回按计划/课程覆盖，不会重复累计。`;

// ==================== 内部辅助 ====================

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} as Record<string, never> };
}

/** 本地时区 YYYY-MM-DD。 */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 日期字符串减 N 天（YYYY-MM-DD）。 */
function minusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() - days);
  return localDate(d);
}

const cut = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 取日期部分（YYYY-MM-DD）。⚠️ 不能复用 cut()——它会补省略号，拼进 SQL 比较就永远匹配不上。 */
const dayOf = (s: unknown): string => String(s ?? "").slice(0, 10);

interface KpRow {
  id: string;
  course_uuid: string;
  name: string;
  detail: string;
}

/** 该课的知识点清单（家长库；course_uuid 为空时按课程名找 uuid）。 */
function listKps(parent: DatabaseSync, courseUuid: string, courseName: string): KpRow[] {
  let uuid = courseUuid;
  if (!uuid && courseName) {
    const c = parent.prepare("SELECT uuid FROM courses WHERE title = ?").get(courseName) as { uuid?: string } | undefined;
    uuid = String(c?.uuid ?? "");
  }
  if (!uuid) return [];
  return parent
    .prepare("SELECT id, course_uuid, name, detail FROM knowledge_points WHERE course_uuid = ? ORDER BY seq, rowid")
    .all(uuid) as unknown as KpRow[];
}

function kpNameById(parent: DatabaseSync, kpId: string): string {
  const r = parent.prepare("SELECT name FROM knowledge_points WHERE id = ?").get(kpId) as { name?: string } | undefined;
  return String(r?.name ?? "");
}

/** 课程 uuid 解析：孩子库先查（老行可能为空）→ 家长库兜底 → 回写孩子库。 */
function resolveCourse(kb: DatabaseSync, parent: DatabaseSync, uuidOrName: string): { uuid: string; title: string; topicKey: string } {
  const key = String(uuidOrName ?? "").trim();
  if (!key) return { uuid: "", title: "", topicKey: "" };
  let row = kb.prepare("SELECT uuid, title, topic_key FROM courses WHERE uuid = ? OR title = ? LIMIT 1").get(key, key) as
    | { uuid?: string; title?: string; topic_key?: string }
    | undefined;
  if (!row) {
    const p = parent.prepare("SELECT uuid, title FROM courses WHERE title = ? LIMIT 1").get(key) as
      | { uuid?: string; title?: string }
      | undefined;
    if (!p?.uuid) return { uuid: "", title: key, topicKey: "" };
    try {
      kb.prepare("UPDATE courses SET uuid = ? WHERE title = ?").run(p.uuid, p.title ?? key);
    } catch {
      /* 回写失败不影响本次写入 */
    }
    row = { uuid: p.uuid, title: p.title ?? key, topic_key: "" };
  }
  return { uuid: String(row?.uuid ?? ""), title: String(row?.title ?? key), topicKey: String(row?.topic_key ?? "") };
}

// ==================== 默认任务（D9：默认自动建一条、家长可改/停用） ====================

/** 默认任务 id（确定性，便于幂等播种）。 */
export const DEFAULT_MASTERY_TASK_ID_PREFIX = "task_mastery_";
/** 默认时刻（家长可在「定时任务」页改；这是产品默认值，不是硬编码业务规则）。 */
export const DEFAULT_MASTERY_TASK_TIME = "21:30";

/**
 * 幂等保证「学习情况分析」这条自定义任务存在（type=custom / 每天 21:30 / 启用），并把现有孩子都分配上。
 * - **只播种一次**（settings 标记 `mastery_task_seeded:<parentId>`）：家长删掉后不再自动重建（尊重家长选择）；
 * - 已存在的分配行不动（家长停用某个孩子时只是 enabled=0，行还在 → 不会被重新拉起）；
 * - 新增孩子会被补上分配（家长若已删除该孩子的那行分配，则会重新补一次——属边界，可接受）。
 */
export function ensureDefaultMasteryTask(db: DatabaseSync, parentId: string): void {
  const taskId = `${DEFAULT_MASTERY_TASK_ID_PREFIX}${parentId}`;
  const now = new Date().toISOString();
  const seeded = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`mastery_task_seeded:${parentId}`) as
    | { value_json?: string }
    | undefined;
  if (!seeded?.value_json) {
    db.prepare(
      `INSERT OR IGNORE INTO scheduler_tasks
         (id, parent_id, name, type, time, extra_json, enabled, owner, frequency, instruction, created_at, updated_at)
       VALUES (?, ?, ?, 'custom', ?, '{}', 1, 'parent', 'daily', ?, ?, ?)`
    ).run(taskId, parentId, "学习情况分析", DEFAULT_MASTERY_TASK_TIME, DEFAULT_MASTERY_TASK_INSTRUCTION, now, now);
    db.prepare("INSERT OR REPLACE INTO settings (key, value_json, updated) VALUES (?, ?, ?)").run(
      `mastery_task_seeded:${parentId}`,
      JSON.stringify({ at: now, taskId }),
      now
    );
  }
  if (!db.prepare("SELECT 1 FROM scheduler_tasks WHERE id = ?").get(taskId)) return; // 家长删过 → 不再补分配
  const kids = db.prepare("SELECT id FROM children WHERE parent_id = ?").all(parentId) as Array<{ id: string }>;
  const ins = db.prepare(
    "INSERT OR IGNORE INTO scheduler_task_assignments (task_id, child_id, enabled, created_at) VALUES (?, ?, 1, ?)"
  );
  for (const k of kids) ins.run(taskId, k.id, now);
}

// ==================== 工具 ====================

export function createMasteryTools(deps: MasteryToolDeps) {
  const nowIso = () => new Date().toISOString();

  /** ① 待归纳范围：缺结果的学习计划 + 最近有动静、需要刷新掌握的课程。 */
  const todoList = defineTool({
    name: "mastery_todo_list",
    label: "看待归纳的学习计划与待刷新课程",
    description:
      "列出**需要归纳**的范围（做掌握分析的第一步）：\n" +
      "- `pending_plans`：已完成、但还没有知识点掌握记录的学习计划（每个计划一行）；\n" +
      "- `courses_to_refresh`：最近有学习或考核动静、需要刷新掌握情况与教学建议的课程（含上面那些计划的课程）。\n" +
      "`days` 限定回看天数（缺省 3；传 0 = 不限，用于补跑历史）。返回为空 = 今天无需更新。",
    parameters: Type.Object({
      days: Type.Optional(Type.Number({ description: "回看天数，缺省 3；0 = 不限（历史补跑）" })),
      limit: Type.Optional(Type.Number({ description: "每类最多几条，缺省 20" })),
    }),
    execute: async (_id: string, params: { days?: number; limit?: number }) => {
      const days = params.days == null ? 3 : Math.max(0, Math.floor(Number(params.days) || 0));
      const limit = Math.max(1, Math.min(100, Math.floor(Number(params.limit) || 20)));
      const kb = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        const today = localDate(new Date());
        const from = days > 0 ? minusDays(today, days - 1) : "";
        const windowSql = from ? "AND substr(COALESCE(NULLIF(sp.done_at,''), sp.due_at, sp.start_at),1,10) >= ?" : "";

        const pending = kb
          .prepare(
            `SELECT sp.id, sp.course_uuid, sp.course_name, sp.topic_key, sp.mode,
                    COALESCE(NULLIF(sp.done_at,''), sp.due_at, sp.start_at) AS at
               FROM study_plans sp
              WHERE sp.status = 'done' AND sp.active = 1
                AND NOT EXISTS (SELECT 1 FROM knowledge_point_records r WHERE r.source = 'study' AND r.plan_id = sp.id)
                ${windowSql}
              ORDER BY at DESC LIMIT ?`
          )
          .all(...(from ? [from, limit] : [limit])) as Array<Record<string, unknown>>;

        // 需要刷新掌握的课程 = 待归纳计划的课程 ∪ 最近 N 天有学习/考核动静的课程
        const recent = new Map<string, { name: string; uuid: string; topicKey: string; lastStudy: string; lastExam: string; rate: number | null; from: string }>();
        const bump = (name: string, uuid: string, topicKey: string, kind: "study" | "exam", at: string, rate?: number | null, from?: string) => {
          const key = uuid || `name:${name}`;
          let e = recent.get(key);
          if (!e) {
            e = { name, uuid, topicKey, lastStudy: "", lastExam: "", rate: null, from: "" };
            recent.set(key, e);
          }
          if (!e.name && name) e.name = name;
          if (kind === "study" && at > e.lastStudy) e.lastStudy = at;
          if (kind === "exam") {
            if (at > e.lastExam) {
              e.lastExam = at;
              e.rate = rate ?? null;
            }
          }
          if (from && !e.from) e.from = from;
        };
        for (const p of pending) bump(String(p.course_name ?? ""), String(p.course_uuid ?? ""), String(p.topic_key ?? ""), "study", String(p.at ?? ""), null, "待归纳计划");

        const studyWindow = from ? "AND substr(COALESCE(NULLIF(done_at,''), due_at, start_at),1,10) >= ?" : "";
        const studyRows = kb
          .prepare(
            `SELECT course_uuid, course_name, topic_key, MAX(COALESCE(NULLIF(done_at,''), due_at, start_at)) AS at
               FROM study_plans
              WHERE status = 'done' AND active = 1 ${studyWindow}
              GROUP BY COALESCE(NULLIF(course_uuid,''), course_name) ORDER BY at DESC LIMIT ?`
          )
          .all(...(from ? [from, limit * 2] : [limit * 2])) as Array<Record<string, unknown>>;
        for (const r of studyRows) bump(String(r.course_name ?? ""), String(r.course_uuid ?? ""), String(r.topic_key ?? ""), "study", String(r.at ?? ""));

        const examWindow = from ? "AND substr(exam_at,1,10) >= ?" : "";
        const examRows = kb
          .prepare(
            `SELECT course_uuid, course_name, MAX(exam_at) AS at, rate
               FROM exam_course_results WHERE child_id = ? ${examWindow}
              GROUP BY COALESCE(NULLIF(course_uuid,''), course_name) ORDER BY at DESC LIMIT ?`
          )
          .all(...(from ? [deps.childId, from, limit * 2] : [deps.childId, limit * 2])) as Array<Record<string, unknown>>;
        for (const r of examRows) bump(String(r.course_name ?? ""), String(r.course_uuid ?? ""), "", "exam", String(r.at ?? ""), r.rate == null ? null : Number(r.rate));

        const lines: string[] = [];
        lines.push(`范围：最近 ${days > 0 ? `${days} 天` : "全部历史"}（今天 ${today}）。`);
        lines.push("");
        lines.push(`## 待归纳的学习计划（${pending.length} 个）`);
        if (!pending.length) lines.push("（无）");
        for (const p of pending) {
          const kpN = (() => {
            try {
              return listKps(openParentLib(deps.dataDir, deps.parentId), String(p.course_uuid ?? ""), String(p.course_name ?? "")).length;
            } catch {
              return 0;
            }
          })();
          lines.push(
            `- plan_id=${p.id}｜${cut(p.at, 10)}｜${p.course_name}｜${p.mode === "review" ? "复习" : "新学"}｜该课知识点 ${kpN} 个`
          );
        }
        lines.push("");
        const refresh = Array.from(recent.values());
        lines.push(`## 需要刷新掌握的课程（${refresh.length} 门）`);
        if (!refresh.length) lines.push("（无）");
        const kbCourses = kb.prepare("SELECT uuid, title, mastery_level, mastery_updated_at FROM courses").all() as Array<
          Record<string, unknown>
        >;
        const byTitle = new Map(kbCourses.map((c) => [String(c.title), c]));
        const byUuid = new Map(kbCourses.map((c) => [String(c.uuid), c]));
        for (const e of refresh) {
          const c = (e.uuid ? byUuid.get(e.uuid) : undefined) ?? byTitle.get(e.name);
          const level = String(c?.mastery_level ?? "") || "（未评估）";
          const upd = String(c?.mastery_updated_at ?? "");
          lines.push(
            `- ${e.name}（course_uuid=${e.uuid || "空"}）｜最近学习 ${cut(e.lastStudy, 10) || "—"}｜最近考核 ${cut(e.lastExam, 10) || "—"}${
              e.rate == null ? "" : `（得分率 ${Math.round(e.rate * 100)}%）`
            }｜当前掌握 ${level}${upd ? `（更新于 ${cut(upd, 10)}）` : ""}${e.from ? `｜${e.from}` : ""}`
          );
        }
        if (!pending.length && !refresh.length) {
          return ok(`最近 ${days > 0 ? `${days} 天` : "全部历史"}没有需要归纳的学习/考核结果（今天 ${today}）。`);
        }
        lines.push("");
        lines.push("下一步：对每个待归纳计划调 mastery_plan_context 取素材；对每门待刷新课程调 mastery_save_course_mastery 写回掌握与建议。");
        return ok(lines.join("\n"));
      } finally {
        kb.close();
      }
    },
  });

  /** ② 某计划的素材：一次给全，省轮次。 */
  const planContext = defineTool({
    name: "mastery_plan_context",
    label: "取某计划的分析素材",
    description:
      "一次给出某次学习/考核计划的全部素材：计划信息、涉及课程的知识点清单（含知识点 id，写回时要用）、" +
      "该计划窗口内的学习记录原文（学习计划）、考核逐题明细与课程概要（考核计划）、这些知识点已有的掌握历史、错题本未掌握项。",
    parameters: Type.Object({
      plan_id: Type.String({ description: "计划 id（study_plans.id 或 exam_plans.id，来自 mastery_todo_list）" }),
      source: Type.Optional(Type.String({ description: "study | exam（缺省自动识别）" })),
      max_records: Type.Optional(Type.Number({ description: "每个知识点最多回带几条历史掌握记录，缺省 5" })),
    }),
    execute: async (_id: string, params: { plan_id: string; source?: string; max_records?: number }) => {
      const planId = String(params.plan_id ?? "").trim();
      if (!planId) throw new Error("mastery_plan_context 需要 plan_id");
      const maxRec = Math.max(1, Math.min(20, Math.floor(Number(params.max_records) || 5)));
      const kb = openKb(deps.dataDir, deps.parentId, deps.childId);
      const parent = openParentLib(deps.dataDir, deps.parentId);
      try {
        const sp = kb
          .prepare(
            "SELECT id, course_uuid, course_name, topic_key, mode, status, start_at, due_at, done_at, result_summary FROM study_plans WHERE id = ?"
          )
          .get(planId) as Record<string, unknown> | undefined;
        const ep = sp
          ? undefined
          : (kb.prepare("SELECT id, title, status, start_at, due_at, done_at FROM exam_plans WHERE id = ?").get(planId) as
              | Record<string, unknown>
              | undefined);
        const source = String(params.source ?? "") === "exam" || (!sp && ep) ? "exam" : "study";
        if (source === "study" && !sp) throw new Error(`找不到学习计划 ${planId}（也不存在同名考核计划）`);
        if (source === "exam" && !ep) throw new Error(`找不到考核计划 ${planId}`);

        const lines: string[] = [];
        if (source === "study") {
          const courseName = String(sp!.course_name ?? "");
          const courseUuid = String(sp!.course_uuid ?? "");
          const at = String(sp!.done_at ?? sp!.due_at ?? sp!.start_at ?? "");
          lines.push(`# 学习计划 ${planId}`);
          lines.push(
            `课程：${courseName}（course_uuid=${courseUuid || "空"}）｜${sp!.mode === "review" ? "复习" : "新学"}｜状态 ${sp!.status}｜完成于 ${cut(at, 19)}`
          );
          const kps = listKps(parent, courseUuid, courseName);
          lines.push(`\n## 该课知识点（${kps.length} 个，写回时用 knowledge_point_id）`);
          for (const k of kps) lines.push(`- id=${k.id}｜${k.name}${k.detail ? `：${cut(k.detail, 160)}` : ""}`);
          // 窗口：计划 start~due（含边界）；start 缺失则退化为完成当天
          const startDay = dayOf(sp!.start_at);
          const dueDay = dayOf(sp!.due_at);
          const day = dayOf(at);
          const winFrom = startDay || dueDay || day;
          const winTo = dueDay || startDay || day;
          const entries = kb
            .prepare(
              `SELECT date, title, raw FROM daily_entries
                WHERE block = '学习' AND date >= ? AND date <= ?
                ORDER BY date ASC LIMIT 20`
            )
            .all(winFrom, winTo) as Array<Record<string, unknown>>;
          lines.push(`\n## 这次学习的过程记录（${entries.length} 条）`);
          if (!entries.length) lines.push("（没有采集到学习记录原文——请按「未记到过程细节」处理，不要编造细节）");
          for (const e of entries) lines.push(`- ${e.date}｜${e.title}：${cut(e.raw, 420)}`);
          if (String(sp!.result_summary ?? "")) lines.push(`\n已写过的课程概要：${cut(sp!.result_summary, 300)}`);
          const recs = kb
            .prepare(
              `SELECT knowledge_point_id, outcome, summary, record_at FROM knowledge_point_records
                WHERE source = 'study' AND plan_id = ? ORDER BY record_at DESC LIMIT 30`
            )
            .all(planId) as Array<Record<string, unknown>>;
          lines.push(`\n## 本计划已有的知识点记录（${recs.length} 条，重复执行会覆盖）`);
          for (const r of recs) lines.push(`- ${kpNameById(parent, String(r.knowledge_point_id))}｜${r.outcome}｜${cut(r.summary, 120)}`);
          appendHistory(lines, kb, parent, kps, maxRec);
          appendMistakes(lines, kb, courseName);
        } else {
          const title = String(ep!.title ?? "考核");
          lines.push(`# 考核计划 ${planId}`);
          lines.push(`标题：${title}｜状态 ${ep!.status}｜完成于 ${cut(ep!.done_at, 19)}`);
          const results = kb
            .prepare("SELECT course_name, course_uuid, point_got, point_max, rate, question_count, course_summary FROM exam_course_results WHERE plan_id = ?")
            .all(planId) as Array<Record<string, unknown>>;
          lines.push(`\n## 本次考核的课程概要（${results.length} 门）`);
          for (const r of results) {
            lines.push(
              `- ${r.course_name}：${Math.round(Number(r.point_got) || 0)}/${Math.round(Number(r.point_max) || 0)} 分` +
                `${r.rate == null ? "" : `（得分率 ${Math.round(Number(r.rate) * 100)}%）`}｜${r.question_count} 题｜${cut(r.course_summary, 200)}`
            );
          }
          const details = kb
            .prepare(
              `SELECT course_name, course_uuid, knowledge_point_id, question_text, point_got, point_max, correct, ai_comment, asr_text
                 FROM exam_plan_courses WHERE plan_id = ? ORDER BY course_name, seq LIMIT 60`
            )
            .all(planId) as Array<Record<string, unknown>>;
          lines.push(`\n## 逐题明细（最多 60 条）`);
          for (const d of details) {
            const kp = kpNameById(parent, String(d.knowledge_point_id)) || "（未挂知识点）";
            lines.push(
              `- ${d.course_name}｜${kp}｜${cut(d.question_text, 80)}｜${Number(d.point_got) || 0}/${Number(d.point_max) || 0}` +
                `｜${Number(d.correct) === 1 ? "对" : "错"}${d.ai_comment ? `｜评语：${cut(d.ai_comment, 100)}` : ""}` +
                `${d.asr_text ? `｜回答：${cut(d.asr_text, 80)}` : ""}`
            );
          }
          const kpByCourse = new Map<string, KpRow[]>();
          for (const r of results) {
            const name = String(r.course_name ?? "");
            kpByCourse.set(name, listKps(parent, String(r.course_uuid ?? ""), name));
          }
          for (const [course, kps] of kpByCourse) {
            lines.push(`\n## 课程「${course}」的知识点（${kps.length} 个）`);
            for (const k of kps) lines.push(`- id=${k.id}｜${k.name}${k.detail ? `：${cut(k.detail, 160)}` : ""}`);
            appendHistory(lines, kb, parent, kps, maxRec);
            appendMistakes(lines, kb, course);
          }
        }
        return ok(lines.join("\n"));
      } finally {
        kb.close();
        parent.close();
      }
    },
  });

  /** ③ 写回知识点掌握流水（幂等）+ 学习计划课程概要。 */
  const saveRecords = defineTool({
    name: "mastery_save_records",
    label: "写回知识点掌握情况",
    description:
      "把一次学习/考核的知识点情况写回（按 `(source, plan_id, course_uuid, knowledge_point_id)` 幂等覆盖，重复执行不会重复累计）。\n" +
      "`items` 每项：`knowledge_point_id`（必填，取自 mastery_plan_context 的知识点清单）+ `outcome`（solid/partial/weak）+ " +
      "`summary`（一句具体描述）+ 可选 `detail`。学习计划可另给 `result_summary`（这次学习的课程级概要）。",
    parameters: Type.Object({
      plan_id: Type.String({ description: "计划 id" }),
      source: Type.String({ description: "study | exam" }),
      course_uuid: Type.Optional(Type.String({ description: "课程 uuid（考核多课时按知识点所属课程传）" })),
      course_name: Type.Optional(Type.String({ description: "课程名（缺 course_uuid 时用）" })),
      items: Type.Array(
        Type.Object({
          knowledge_point_id: Type.String({ description: "知识点 id" }),
          outcome: Type.String({ description: "solid | partial | weak" }),
          summary: Type.Optional(Type.String({ description: "该知识点这次的情况描述（具体）" })),
          detail: Type.Optional(Type.String({ description: "补充细节（困难点/亮点，可选）" })),
        }),
        { description: "本次涉及的知识点列表" }
      ),
      result_summary: Type.Optional(Type.String({ description: "学习计划：这次学习的课程级概要" })),
    }),
    execute: async (
      _id: string,
      params: {
        plan_id: string;
        source: string;
        course_uuid?: string;
        course_name?: string;
        items: Array<{ knowledge_point_id: string; outcome: string; summary?: string; detail?: string }>;
        result_summary?: string;
      }
    ) => {
      const planId = String(params.plan_id ?? "").trim();
      const source = String(params.source ?? "").trim();
      if (!planId) throw new Error("mastery_save_records 需要 plan_id");
      if (source !== "study" && source !== "exam") throw new Error("source 只能是 study / exam");
      const items = Array.isArray(params.items) ? params.items : [];
      if (!items.length) throw new Error("items 不能为空（没有知识点就不用调用本工具）");
      const kb = openKb(deps.dataDir, deps.parentId, deps.childId);
      const parent = openParentLib(deps.dataDir, deps.parentId);
      try {
        const plan = source === "study"
          ? (kb.prepare("SELECT id, course_uuid, course_name, topic_key, status, done_at FROM study_plans WHERE id = ?").get(planId) as Record<string, unknown> | undefined)
          : (kb.prepare("SELECT id, title, status, done_at FROM exam_plans WHERE id = ?").get(planId) as Record<string, unknown> | undefined);
        if (!plan) throw new Error(`找不到${source === "study" ? "学习" : "考核"}计划 ${planId}`);

        const planCourse = resolveCourse(kb, parent, String(params.course_uuid || params.course_name || (source === "study" ? plan.course_uuid || plan.course_name : "")));
        const recordAt = String(plan.done_at ?? "") || nowIso();
        const now = nowIso();
        const depTopicKey = String(plan.topic_key ?? planCourse.topicKey ?? "");
        const ins = kb.prepare(
          `INSERT INTO knowledge_point_records
             (id,parent_id,child_id,source,plan_id,knowledge_point_id,knowledge_point_name,topic_key,course_uuid,course_name,
              record_at,outcome,point_got,point_max,rate,summary,detail_json,source_ref,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?)
           ON CONFLICT(source, plan_id, course_uuid, knowledge_point_id) DO UPDATE SET
             outcome=excluded.outcome, summary=excluded.summary, detail_json=excluded.detail_json,
             record_at=excluded.record_at, knowledge_point_name=CASE WHEN excluded.knowledge_point_name != ''
               THEN excluded.knowledge_point_name ELSE knowledge_point_records.knowledge_point_name END`
        );
        let written = 0;
        const errors: string[] = [];
        for (const it of items) {
          const kpId = String(it.knowledge_point_id ?? "").trim();
          const outcome = String(it.outcome ?? "").trim();
          if (!kpId) {
            errors.push("有知识点缺 knowledge_point_id，已跳过");
            continue;
          }
          if (!(OUTCOMES as readonly string[]).includes(outcome)) {
            errors.push(`知识点 ${kpId} 的 outcome「${outcome}」非法（只能 solid/partial/weak），已跳过`);
            continue;
          }
          const kpRow = parent.prepare("SELECT id, course_uuid, name FROM knowledge_points WHERE id = ?").get(kpId) as
            | { id: string; course_uuid: string; name: string }
            | undefined;
          if (!kpRow) {
            errors.push(`知识点 ${kpId} 在家长库不存在（不要自己编 id），已跳过`);
            continue;
          }
          // 课程归属：考核多课时按知识点实际所属课程落，保证 (plan, course, kp) 唯一键正确
          const ownCourse = resolveCourse(kb, parent, String(kpRow.course_uuid || planCourse.uuid));
          ins.run(
            randomUUID(),
            deps.parentId,
            deps.childId,
            source,
            planId,
            kpId,
            kpRow.name,
            depTopicKey || ownCourse.topicKey,
            ownCourse.uuid,
            ownCourse.title,
            recordAt,
            outcome,
            cut(it.summary, 300),
            JSON.stringify({ difficulty: cut(it.detail, 200) || undefined }),
            planId,
            now
          );
          written++;
        }
        let summaryWritten = false;
        const rs = cut(params.result_summary, 400);
        if (source === "study" && rs) {
          kb.prepare("UPDATE study_plans SET result_summary = ?, updated_at = ? WHERE id = ?").run(rs, now, planId);
          summaryWritten = true;
        }
        const tail = errors.length ? `\n未写入：${errors.join("；")}` : "";
        return ok(
          `已写回 ${written} 个知识点的掌握情况（计划 ${planId}）${summaryWritten ? "，并更新了这次学习的课程概要" : ""}。${tail}`
        );
      } finally {
        kb.close();
        parent.close();
      }
    },
  });

  /** ④ 写回课程掌握与教学建议 + 知识点累计掌握（计数由工具实时统计，避免模型编造）。 */
  const saveCourseMastery = defineTool({
    name: "mastery_save_course_mastery",
    label: "写回课程掌握与教学建议",
    description:
      "写回一门课的掌握情况：`mastery_level`（not_started/learning/needs_review/mastered）、`mastery_desc`（累计掌握叙述，" +
      "按「最开始→中间→最新」写清演进）、`teaching_advice`（下次教学建议，只增补不改家长写的方法）。\n" +
      "可选 `knowledge_points`：逐个知识点写它自己的 level 与累计叙述（学/考次数、最近档位由系统按记录实时统计，不用你算）。",
    parameters: Type.Object({
      course: Type.String({ description: "课程名或课程 uuid（mastery_todo_list 里的 course_uuid/课程名）" }),
      mastery_level: Type.String({ description: "not_started | learning | needs_review | mastered" }),
      mastery_desc: Type.String({ description: "累计掌握叙述（最开始→中间→最新，具体）" }),
      teaching_advice: Type.Optional(Type.String({ description: "下次教学建议（可操作）" })),
      knowledge_points: Type.Optional(
        Type.Array(
          Type.Object({
            knowledge_point_id: Type.String({ description: "知识点 id" }),
            level: Type.String({ description: "该知识点的档位（同上枚举）" }),
            mastery_desc: Type.Optional(Type.String({ description: "该知识点的累计掌握叙述" })),
          }),
          { description: "各知识点的累计掌握（可选）" }
        )
      ),
    }),
    execute: async (
      _id: string,
      params: {
        course: string;
        mastery_level: string;
        mastery_desc: string;
        teaching_advice?: string;
        knowledge_points?: Array<{ knowledge_point_id: string; level: string; mastery_desc?: string }>;
      }
    ) => {
      const key = String(params.course ?? "").trim();
      if (!key) throw new Error("mastery_save_course_mastery 需要 course（课程名或 uuid）");
      const level = String(params.mastery_level ?? "").trim();
      if (!(LEVELS as readonly string[]).includes(level)) {
        throw new Error(`mastery_level「${level}」非法（只能 ${LEVELS.join(" / ")}）`);
      }
      const kb = openKb(deps.dataDir, deps.parentId, deps.childId);
      const parent = openParentLib(deps.dataDir, deps.parentId);
      try {
        const course = resolveCourse(kb, parent, key);
        if (!course.uuid && !course.title) throw new Error(`孩子课程库里找不到「${key}」`);
        const now = nowIso();
        const upd = course.uuid
          ? kb
              .prepare(
                `UPDATE courses SET mastery_level = ?, mastery_desc = ?, teaching_advice = ?, mastery_updated_at = ?
                  WHERE uuid = ? OR title = ?`
              )
              .run(level, cut(params.mastery_desc, 600), cut(params.teaching_advice, 400), now, course.uuid, course.title)
          : kb
              .prepare(
                `UPDATE courses SET mastery_level = ?, mastery_desc = ?, teaching_advice = ?, mastery_updated_at = ?
                  WHERE title = ?`
              )
              .run(level, cut(params.mastery_desc, 600), cut(params.teaching_advice, 400), now, course.title);
        if (!upd.changes) throw new Error(`更新课程「${course.title || key}」失败（未命中行）`);

        const kpItems = Array.isArray(params.knowledge_points) ? params.knowledge_points : [];
        let kpWritten = 0;
        const errors: string[] = [];
        const insKp = kb.prepare(
          `INSERT INTO knowledge_point_progress
             (parent_id,child_id,knowledge_point_id,knowledge_point_name,course_uuid,course_name,level,mastery_desc,
              study_count,exam_count,last_outcome,last_rate,first_at,last_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(child_id, knowledge_point_id) DO UPDATE SET
             level=excluded.level, mastery_desc=excluded.mastery_desc, course_uuid=excluded.course_uuid,
             course_name=excluded.course_name, study_count=excluded.study_count, exam_count=excluded.exam_count,
             last_outcome=excluded.last_outcome, last_rate=excluded.last_rate, first_at=excluded.first_at,
             last_at=excluded.last_at, updated_at=excluded.updated_at`
        );
        for (const kp of kpItems) {
          const kpId = String(kp.knowledge_point_id ?? "").trim();
          const kpLevel = String(kp.level ?? "").trim();
          if (!kpId) {
            errors.push("有知识点缺 knowledge_point_id，已跳过");
            continue;
          }
          if (!(LEVELS as readonly string[]).includes(kpLevel)) {
            errors.push(`知识点 ${kpId} 的 level「${kpLevel}」非法，已跳过`);
            continue;
          }
          const row = parent.prepare("SELECT name FROM knowledge_points WHERE id = ?").get(kpId) as { name?: string } | undefined;
          if (!row) {
            errors.push(`知识点 ${kpId} 在家长库不存在，已跳过`);
            continue;
          }
          // 计数与最近档位一律由记录表实时统计（模型只给 level / 叙述）
          const agg = kb
            .prepare(
              `SELECT SUM(CASE WHEN source='study' THEN 1 ELSE 0 END) AS s,
                      SUM(CASE WHEN source='exam' THEN 1 ELSE 0 END) AS e,
                      MIN(record_at) AS first_at, MAX(record_at) AS last_at
                 FROM knowledge_point_records WHERE knowledge_point_id = ?`
            )
            .get(kpId) as { s: number | null; e: number | null; first_at: string | null; last_at: string | null };
          const last = kb
            .prepare(
              `SELECT outcome, rate FROM knowledge_point_records WHERE knowledge_point_id = ?
                ORDER BY record_at DESC, created_at DESC LIMIT 1`
            )
            .get(kpId) as { outcome?: string; rate?: number | null } | undefined;
          insKp.run(
            deps.parentId,
            deps.childId,
            kpId,
            String(row.name ?? ""),
            course.uuid,
            course.title,
            kpLevel,
            cut(kp.mastery_desc, 400),
            Number(agg?.s) || 0,
            Number(agg?.e) || 0,
            String(last?.outcome ?? ""),
            last?.rate == null ? null : Number(last.rate),
            String(agg?.first_at ?? now),
            String(agg?.last_at ?? now),
            now
          );
          kpWritten++;
        }
        const tail = errors.length ? `\n未写入：${errors.join("；")}` : "";
        return ok(
          `已更新课程「${course.title || key}」的掌握情况（${level}）${kpWritten ? `，并累计了 ${kpWritten} 个知识点` : ""}。${tail}`
        );
      } finally {
        kb.close();
        parent.close();
      }
    },
  });

  return [todoList, planContext, saveRecords, saveCourseMastery];
}

// ==================== 内部：素材片段 ====================

/** 各知识点已有的掌握历史（学习+考核，按时间倒序取最近 N 条）。 */
function appendHistory(
  lines: string[],
  kb: DatabaseSync,
  parent: DatabaseSync,
  kps: KpRow[],
  maxRec: number
): void {
  if (!kps.length) return;
  const stmt = kb.prepare(
    `SELECT source, outcome, summary, record_at, rate FROM knowledge_point_records
      WHERE knowledge_point_id = ? ORDER BY record_at DESC, created_at DESC LIMIT ?`
  );
  lines.push(`\n## 知识点已有掌握历史（每个点最近 ${maxRec} 条）`);
  let any = false;
  for (const k of kps) {
    const recs = stmt.all(k.id, maxRec) as Array<Record<string, unknown>>;
    if (!recs.length) continue;
    any = true;
    lines.push(`- ${k.name}：`);
    for (const r of recs) {
      lines.push(
        `    · ${cut(r.record_at, 10)}｜${r.source === "exam" ? "考核" : "学习"}｜${r.outcome}` +
          `${r.rate == null ? "" : `（${Math.round(Number(r.rate) * 100)}%）`}｜${cut(r.summary, 100)}`
      );
    }
  }
  if (!any) lines.push("（这些知识点还没有历史掌握记录——本次即第一次）");
}

/** 该课错题本里还没掌握的点（薄弱证据）。 */
function appendMistakes(lines: string[], kb: DatabaseSync, courseName: string): void {
  if (!courseName) return;
  const rows = kb
    .prepare(
      `SELECT kind, content, detail, count, last_seen FROM mistake_book
        WHERE status = 'open' AND (course_ref = ? OR course_ref = '')
        ORDER BY count DESC, last_seen DESC LIMIT 5`
    )
    .all(courseName) as Array<Record<string, unknown>>;
  lines.push(`\n## 错题本未掌握项（${rows.length} 条，薄弱证据）`);
  if (!rows.length) lines.push("（无）");
  for (const r of rows) {
    lines.push(`- ${cut(r.content, 100)}｜出现 ${r.count} 次｜最近 ${cut(r.last_seen, 10)}｜${cut(r.detail, 100)}`);
  }
}
