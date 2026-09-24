/**
 * 家长 agent 的**场景专用只读工具**（ISSUE-144 **P4**，2026-09-25 落地）。
 *
 * 背景：家长侧读数一直靠**通用通道** `parent_db_read`（对孩子库任意登记表等值查询）。台账
 * （`docs/家长agent使用场景梳理-2026-09-24.md` §3.2）把它列为**必须退场**，且写明"退场前置＝先补
 * 三个场景专用工具"。本文件就是那三个（对照孩子端 `child-report-tools.ts`，同一套思路、家长视角）：
 *
 * - `parent_child_exam_report`   某孩子最近几场的得分与范围 / 某一场的**逐题明细 + 每课概要 + 知识点档位**
 *                                → **D1**「这次考了多少、哪几题错了」
 * - `parent_child_mastery_report` 主题进度 / 每课掌握（含叙述·教学建议）/ **知识点档位** / 学习结果 /
 *                                **薄弱项（错题本）概览** → **D5**「哪里薄弱、到底会不会」+ **D3**（错题本）
 * - `parent_child_points_report` 余额 / 加分规则 / 逐日结算（完成率·档位·门槛·漏项）/ 流水 /
 *                                **待家长处理的兑换申请** → **F3**「她这分怎么算的」+ **F2**（兑换）
 *
 * ## 与孩子端三个工具的三处**刻意不同**
 * 1. **对象是孩子**：每个工具第一个参数是 `child`（孩子姓名；名下只有一个孩子时可省略），
 *    走 `resolveConvoChild` 的同一套归属校验——**只在自己名下的孩子里找，找不到就报可选名字**。
 * 2. **口径是家长口径**：`parent-scene-points` 里的结算是"必做项直接评档 + 加分项看家长组门槛"，
 *    与孩子端那句简写不同——**同一份数据、两套话术**，这也是要分两个工具的原因之一。
 * 3. **仍不给标准答案**（但家长可以要）：答案在**家长库**（`parent_library_course_content` 本来就返回
 *    `answer`），本文件不去读家长库、也不把答案混进"孩子的答题结果"里——家长问解法时由模型另调那把工具，
 *    并按 `parent-scene-progress` 的红线说明"这是给家长看的解释，要不要告诉孩子由你决定"。
 *
 * ## 安全边界（沿用 ISSUE-105 权限矩阵）
 * 1. **只读**：没有任何写入口；
 * 2. **不接受表名 / 列名 / SQL**：每把工具的取数范围在代码里写死；
 * 3. **不返回内部标识**（行 id 除考核 `id=`——它要用于下次追问；`operator` / `meta_json` /
 *    `source_table` / `question_id` / `audio_file_id` / `course_uuid` 一律不吐）；
 * 4. **未考完的场次不给题目**（只给范围）——与孩子端同一条防泄题红线：家长可能转述给孩子。
 *
 * ## 说明下沉（ISSUE-144 A 路线）
 * 各工具的 `description` 只有**第一句**会进模型上下文（注册点 `compactParentTools` 会压成
 * "一句 + 指路"，参数 Schema 只留结构）。**参数语义、汇报口径、红线都在场景技能里**：
 * exam / mastery → `skills/parent/progress.ts`；points → `skills/parent/points.ts`。
 * 因此本文件里的注释写得比 description 细——**注释给维护者看，不进上下文**。
 */
import type { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { defineTool } from "./tool-kit.js";
import { openKb } from "../db/kb.js";
import { parsePlanCourses, formatPlanCourses } from "../assess-selection.js";
// 姓名 → 孩子 id（含归属校验与"可选名字"报错）——与其它家长工具同一份真源
import { resolveConvoChild } from "./parent-tools.js";
import {
  BEHAVIOR_ZH,
  DEFAULT_EXAM_TIERS,
  DEFAULT_TODO_TIERS,
  LEARN_TYPE_ZH,
  MASTERY_ZH,
  MISTAKE_KIND_ZH,
  OUTCOME_ZH,
  cut,
  daysAgo,
  localDate,
  okText as ok,
  ownerZh,
  parseTiers,
  pct,
  sourceZh,
  tiersText,
} from "./report-utils.js";

export interface ParentChildReportDeps {
  /** 家长主库（`children` 表：姓名 → id + 归属校验；与其它家长工具同源） */
  db: DatabaseSync;
  dataDir: string;
  parentId: string;
}

export const PARENT_CHILD_REPORT_TOOL_NAMES = [
  "parent_child_exam_report",
  "parent_child_mastery_report",
  "parent_child_points_report",
] as const;

/**
 * 目标孩子：不传 `child` 时——名下**只有一个**孩子就直接用它（家长口语里"她"就是那个），
 * 多个孩子则报可选名字让模型问一句，绝不默认挑一个（挑错＝给家长看错孩子的数据）。
 */
function resolveChild(deps: ParentChildReportDeps, raw: unknown): { id: string; name: string } {
  const want = String(raw ?? "").trim();
  if (want) return resolveConvoChild(deps.db, deps.parentId, want); // 名字对不上时它会报可选名字
  const kids = deps.db
    .prepare("SELECT id, name FROM children WHERE parent_id = ? ORDER BY created_at, name")
    .all(deps.parentId) as unknown as Array<{ id: string; name: string }>;
  if (!kids.length) throw new Error("名下还没有孩子，先添加一个孩子（parent_child_create）再看数据。");
  if (kids.length === 1) return kids[0]!;
  throw new Error(
    `要看哪个孩子？名下孩子：${kids.map((k) => k.name).join("、")}——请把姓名传给 child 参数（或先问家长一句）。`
  );
}

/** 取孩子库里"某场考核"的聚合得分（逐题明细优先，缺明细时用每课结果） */
function examAggregate(
  db: DatabaseSync,
  planId: string
): { got: number; max: number; wrong: number } {
  const a = db
    .prepare(
      `SELECT COALESCE(SUM(point_got),0) AS got, COALESCE(SUM(point_max),0) AS max,
              COALESCE(SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END),0) AS wrong
       FROM exam_plan_courses WHERE plan_id = ?`
    )
    .get(planId) as { got: number; max: number; wrong: number } | undefined;
  if (a && Number(a.max) > 0) return { got: Number(a.got), max: Number(a.max), wrong: Number(a.wrong) };
  const c = db
    .prepare(
      `SELECT COALESCE(SUM(point_got),0) AS got, COALESCE(SUM(point_max),0) AS max
       FROM exam_course_results WHERE plan_id = ?`
    )
    .get(planId) as { got: number; max: number } | undefined;
  return { got: Number(c?.got ?? 0), max: Number(c?.max ?? 0), wrong: Number(a?.wrong ?? 0) };
}

/** 考核范围（`scope_json` 有两种历史格式，统一走 assess-selection 的解析器） */
function scopeOf(raw: unknown): string {
  try {
    const courses = parsePlanCourses((JSON.parse(String(raw || "{}")) as { courses?: unknown }).courses);
    return courses.length ? formatPlanCourses(courses) : "";
  } catch {
    return "";
  }
}

/** 未来/待考的场次（列表为空手时兜一句，避免家长只拿到"没有记录"） */
function pendingExamLines(db: DatabaseSync, childId: string, limit = 3): string[] {
  const rows = db
    .prepare(
      `SELECT title, due_at, status, scope_json FROM exam_plans
       WHERE child_id = ? AND status IN ('pending','missed') AND active = 1
       ORDER BY due_at ASC LIMIT ${limit}`
    )
    .all(childId) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const scope = scopeOf(r.scope_json);
    return (
      `- ${String(r.due_at).slice(0, 10)} · 「${String(r.title)}」${String(r.status) === "missed" ? "（已错过）" : ""}` +
      `${scope ? ` · 范围：${cut(scope, 160)}` : ""}`
    );
  });
}

/** 掌握/熟练度的中性说法：数据缺失不能读成"学得差" */
const unknownLevel = "（还没分析过）";

export function createParentChildReportTools(deps: ParentChildReportDeps) {
  // ==================== D1：考核结果与逐题 ====================
  const examTool = defineTool({
    name: "parent_child_exam_report",
    label: "孩子的考核结果",
    // 只有第一句进上下文（其余口径在 parent-scene-progress 技能里）
    description:
      "一次拿到某个孩子的考核结果：最近几场的得分与范围、某一场的逐题明细（题干/原文/孩子答的/得分/对错/老师评语/有无录音）、每门课的得分与概要、以及每个知识点的掌握档位。",
    parameters: Type.Object({
      child: Type.Optional(Type.String({ description: "孩子姓名（缺省＝名下唯一的孩子）" })),
      plan_id: Type.Optional(Type.String({ description: "考核场次 id（缺省=列最近几场已完成的考核）" })),
      course: Type.Optional(Type.String({ description: "只看某一门课的题（可选，如 学而第一）" })),
      limit: Type.Optional(Type.Number({ description: "列出最近几场（缺省 5，最多 10）" })),
    }),
    execute: async (_id: string, params: { child?: string; plan_id?: string; course?: string; limit?: number }) => {
      const kid = resolveChild(deps, params.child);
      const db = openKb(deps.dataDir, deps.parentId, kid.id);
      try {
        const planId = String(params.plan_id ?? "").trim();
        const courseFilter = String(params.course ?? "").trim();

        // —— 列表：最近几场已完成的考核（含趋势） ——
        if (!planId) {
          const limit = Math.max(1, Math.min(Math.round(Number(params.limit) || 5), 10));
          const plans = db
            .prepare(
              `SELECT id, title, creator, scope_json, score, due_at, done_at
               FROM exam_plans WHERE child_id = ? AND status = 'done'
               ORDER BY COALESCE(NULLIF(done_at,''), due_at) DESC LIMIT ${limit}`
            )
            .all(kid.id) as Array<Record<string, unknown>>;
          if (!plans.length) {
            const pend = pendingExamLines(db, kid.id);
            return ok(
              `「${kid.name}」还没有已完成的考核记录。` + (pend.length ? `\n接下来的考核：\n${pend.join("\n")}` : "")
            );
          }
          const rows = plans.map((p) => ({ p, agg: examAggregate(db, String(p.id)) }));
          const rates = rows
            .slice()
            .reverse()
            .map((r) => (r.agg.max > 0 ? r.agg.got / r.agg.max : null))
            .filter((x): x is number => x !== null);

          const lines: string[] = [`「${kid.name}」最近已完成的考核（最多 ${limit} 场）`];
          if (rates.length) {
            const last = rates[rates.length - 1]!;
            const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
            const trend =
              rates.length >= 2
                ? rates[rates.length - 1]! > rates[rates.length - 2]!
                  ? "（比上一次高）"
                  : rates[rates.length - 1]! < rates[rates.length - 2]!
                    ? "（比上一次低）"
                    : "（与上一次持平）"
                : "";
            lines.push(
              `【整体】近 ${rates.length} 场得分率 ${rates.map((r) => pct(r)).join(" → ")}（按时间从早到晚），` +
                `平均 ${pct(avg)}；最近一次 ${pct(last)}${trend}。`
            );
          }
          lines.push("");
          for (const { p, agg } of rows) {
            const scope = scopeOf(p.scope_json);
            const rate = agg.max > 0 ? pct(agg.got / agg.max) : "—";
            lines.push(
              `- ${String(p.done_at || p.due_at).slice(0, 10)} · 「${String(p.title)}」` +
                `（${String(p.creator) === "child" ? "孩子自己安排的" : "家长安排的"}）` +
                `· 得分 ${agg.got}/${agg.max} = ${rate}` +
                `${agg.wrong ? ` · 错 ${agg.wrong} 题` : ""}` +
                `${scope ? ` · 范围：${cut(scope, 160)}` : ""}` +
                ` · id=${String(p.id)}`
            );
          }
          const pend = pendingExamLines(db, kid.id);
          if (pend.length) {
            lines.push("");
            lines.push("还没考完的：");
            lines.push(...pend);
          }
          lines.push("");
          lines.push("想看哪一场的逐题明细，把它的 id 传给我就行（`plan_id`）。");
          return ok(lines.join("\n"));
        }

        // —— 单场：逐题 + 每课概要 + 知识点 ——
        const plan = db
          .prepare(
            "SELECT id, title, creator, scope_json, status, score, due_at, done_at FROM exam_plans WHERE id = ? AND child_id = ?"
          )
          .get(planId, kid.id) as Record<string, unknown> | undefined;
        if (!plan) return ok(`没有找到这场考核（id=${planId}）。先不传 plan_id 看最近几场。`);
        if (String(plan.status) !== "done") {
          const scope = scopeOf(plan.scope_json);
          return ok(
            `这场考核还没考完（${String(plan.status)}），题目要考完才能看。` +
              (scope ? `\n范围：${scope}\n` : "\n") +
              `到考核日孩子做完之后，这里的逐题明细与评语就会出来。`
          );
        }

        const conds = ["plan_id = ?"];
        const vals: unknown[] = [planId];
        if (courseFilter) {
          conds.push("(course_name = ? OR course_name LIKE ?)");
          vals.push(courseFilter, `%${courseFilter}%`);
        }
        const items = db
          .prepare(
            `SELECT seq, course_name, knowledge_point_name, question_text, ref_text, point_got, point_max, correct,
                    ai_comment, asr_text, audio_file_id, behavior
             FROM exam_plan_courses WHERE ${conds.join(" AND ")} ORDER BY seq ASC LIMIT 200`
          )
          .all(...(vals as Array<null | number | bigint | string>)) as Array<Record<string, unknown>>;
        const courseResults = db
          .prepare(
            `SELECT course_name, point_got, point_max, rate, question_count, course_summary, focus_json
             FROM exam_course_results WHERE plan_id = ? ORDER BY course_name`
          )
          .all(planId) as Array<Record<string, unknown>>;
        const kpRecords = db
          .prepare(
            `SELECT knowledge_point_name, outcome, point_got, point_max, rate, summary
             FROM knowledge_point_records WHERE source = 'exam' AND plan_id = ?
             ORDER BY course_name, knowledge_point_name`
          )
          .all(planId) as Array<Record<string, unknown>>;

        const got = items.reduce((s, r) => s + (Number(r.point_got) || 0), 0);
        const max = items.reduce((s, r) => s + (Number(r.point_max) || 0), 0);
        const rate = max > 0 ? got / max : Number(plan.score ?? NaN) / 100;

        const lines: string[] = [];
        lines.push(
          `「${kid.name}」的考核「${String(plan.title)}」· ${String(plan.done_at || plan.due_at).slice(0, 10)}` +
            ` · ${String(plan.creator) === "child" ? "孩子自己安排的" : "家长安排的"}`
        );
        lines.push(`得分 ${got}/${max}（${max > 0 ? pct(rate) : "—"}）${courseFilter ? ` · 只看「${courseFilter}」` : ""}`);
        const scope = scopeOf(plan.scope_json);
        if (scope) lines.push(`范围：${scope}`);

        if (courseResults.length) {
          lines.push("");
          lines.push("【每门课】");
          for (const c of courseResults) {
            const focus = (() => {
              try {
                const a = JSON.parse(String(c.focus_json ?? "[]")) as unknown;
                return Array.isArray(a) ? a.map((x) => String(x)).filter(Boolean).join("、") : "";
              } catch {
                return "";
              }
            })();
            lines.push(
              `- ${String(c.course_name)}：${Number(c.point_got ?? 0)}/${Number(c.point_max ?? 0)} = ${pct(c.rate)}` +
                `（${Number(c.question_count ?? 0)} 题）` +
                `${String(c.course_summary ?? "").trim() ? `\n  概要：${cut(c.course_summary, 500)}` : ""}` +
                `${focus ? `\n  复习重点：${cut(focus, 300)}` : ""}`
            );
          }
        }

        if (kpRecords.length) {
          lines.push("");
          lines.push("【知识点】");
          for (const k of kpRecords) {
            lines.push(
              `- ${String(k.knowledge_point_name)}：${OUTCOME_ZH[String(k.outcome)] ?? String(k.outcome)}` +
                `${k.rate === null || k.rate === undefined ? "" : `（${pct(k.rate)}）`}` +
                `${String(k.summary ?? "").trim() ? ` — ${cut(k.summary, 300)}` : ""}`
            );
          }
        }

        lines.push("");
        lines.push("【逐题】");
        if (!items.length) lines.push("- 这场考核没有可展示的题目明细。");
        else {
          for (const r of items) {
            const mark = r.correct === 1 ? "✅" : r.correct === 0 ? "❌" : "—";
            const kp = String(r.knowledge_point_name ?? "").trim();
            const beh = String(r.behavior ?? "").trim();
            lines.push(
              `${Number(r.seq ?? 0) + 1}. [${String(r.course_name)}${kp ? ` · ${kp}` : ""}${
                beh ? ` · ${BEHAVIOR_ZH[beh] ?? beh}` : ""
              }] ${mark} ${Number(r.point_got ?? 0)}/${Number(r.point_max ?? 0)}`
            );
            if (String(r.question_text ?? "").trim()) lines.push(`   题目：${cut(r.question_text, 300)}`);
            if (String(r.ref_text ?? "").trim()) lines.push(`   原文：${cut(r.ref_text, 300)}`);
            if (String(r.asr_text ?? "").trim()) lines.push(`   孩子答的：${cut(r.asr_text, 300)}`);
            if (String(r.ai_comment ?? "").trim()) lines.push(`   老师评语：${cut(r.ai_comment, 400)}`);
            if (String(r.audio_file_id ?? "").trim()) lines.push("   （有录音）");
          }
        }
        return ok(lines.join("\n"));
      } finally {
        db.close();
      }
    },
  });

  // ==================== D5 + D3：掌握 / 知识点 / 薄弱项 ====================
  const masteryTool = defineTool({
    name: "parent_child_mastery_report",
    label: "孩子的学习情况与掌握",
    description:
      "一次拿到某个孩子「学得怎么样、哪里薄弱」：每个主题的进度与最近学习时间、每门课的掌握档位与掌握叙述、知识点的掌握档位、最近几次学习结果，以及错题本里还没掌握的薄弱项概览。",
    parameters: Type.Object({
      child: Type.Optional(Type.String({ description: "孩子姓名（缺省＝名下唯一的孩子）" })),
      topic: Type.Optional(Type.String({ description: "主题名（中文名或拼音目录名，如 论语 / lunyu）" })),
      course: Type.Optional(Type.String({ description: "课程名（如 学而第一）" })),
    }),
    execute: async (_id: string, params: { child?: string; topic?: string; course?: string }) => {
      const kid = resolveChild(deps, params.child);
      const db = openKb(deps.dataDir, deps.parentId, kid.id);
      try {
        const topics = db.prepare("SELECT name, topic_key, learn_type FROM topics ORDER BY name").all() as Array<{
          name: string;
          topic_key: string;
          learn_type: string;
        }>;
        const progressRows = db.prepare("SELECT topic, learned, total, next, updated FROM topic_progress").all() as Array<{
          topic: string;
          learned: number;
          total: number;
          next: string;
          updated: string;
        }>;
        const courseRows = db
          .prepare(
            `SELECT c.topic, c.topic_key, c.title, c.uuid, c.status, c.last_review, c.review_count,
                    c.mastery_level, c.mastery_desc, c.teaching_advice, c.mastery_updated_at,
                    p.lastExamRate, p.lastExamAt, p.lastLearnedAt
             FROM courses c
             LEFT JOIN course_progress p ON p.topic = c.topic AND p.title = c.title
             ORDER BY c.topic_key, c.sort_order, c.title`
          )
          .all() as Array<Record<string, unknown>>;
        const kpRows = db
          .prepare(
            `SELECT knowledge_point_name, course_uuid, course_name, level, mastery_desc,
                    study_count, exam_count, last_outcome, last_rate, last_at
             FROM knowledge_point_progress ORDER BY course_name, knowledge_point_name`
          )
          .all() as Array<Record<string, unknown>>;
        const mistakes = db
          .prepare(
            `SELECT kind, content, detail, course_ref, knowledge_point_name, count, first_seen, last_seen
             FROM mistake_book WHERE status = 'open'
             ORDER BY count DESC, last_seen DESC LIMIT 200`
          )
          .all() as Array<Record<string, unknown>>;

        if (!topics.length && !courseRows.length) {
          return ok(`「${kid.name}」还没有分配学习主题与课程，暂时没有学习情况可看。`);
        }

        /** 掌握档位徽标：空值＝服务端还没分析过，**不是"学得差"** */
        const badgeOf = (level: unknown): string => {
          const l = String(level ?? "").trim();
          return l ? (MASTERY_ZH[l] ?? l) : unknownLevel;
        };
        const courseLine = (c: Record<string, unknown>): string => {
          const bits: string[] = [String(c.title), `掌握：${badgeOf(c.mastery_level)}`];
          const learned = String(c.last_review ?? "").trim();
          if (learned) bits.push(`最近学习 ${learned.slice(0, 10)}`);
          if (Number(c.review_count) > 0) bits.push(`复习 ${Number(c.review_count)} 次`);
          const rate = c.lastExamRate;
          if (rate !== null && rate !== undefined && String(rate) !== "") {
            bits.push(
              `最近考核 ${pct(rate)}${String(c.lastExamAt ?? "").trim() ? `（${String(c.lastExamAt).slice(0, 10)}）` : ""}`
            );
          }
          return `- ${bits.join(" · ")}`;
        };
        const kpLine = (k: Record<string, unknown>): string => {
          const bits: string[] = [`${String(k.knowledge_point_name)}：${badgeOf(k.level)}`];
          const counts: string[] = [];
          if (Number(k.study_count) > 0) counts.push(`学 ${Number(k.study_count)} 次`);
          if (Number(k.exam_count) > 0) counts.push(`考 ${Number(k.exam_count)} 次`);
          if (counts.length) bits.push(counts.join(" / "));
          if (String(k.last_at ?? "").trim()) bits.push(`最近 ${String(k.last_at).slice(0, 10)}`);
          const desc = String(k.mastery_desc ?? "").trim();
          return `- ${bits.join(" · ")}${desc ? ` — ${cut(desc, 300)}` : ""}`;
        };
        /** 错题本：按 kind 聚合概览（口径同 parent-scene-progress；count 越大＝越没掌握） */
        const mistakeSection = (scoped: Array<Record<string, unknown>>): string[] => {
          if (!scoped.length) return ["（错题本里没有未关闭的记录）"];
          const out: string[] = [];
          const week = daysAgo(6);
          for (const kind of ["wrong_question", "unknown_word", "weak_point"]) {
            const rows = scoped.filter((m) => String(m.kind) === kind);
            if (!rows.length) continue;
            const fresh = rows.filter((m) => String(m.first_seen).slice(0, 10) >= week).length;
            out.push(
              `- ${MISTAKE_KIND_ZH[kind]} ${rows.length} 条${fresh ? `（本周新增 ${fresh} 条）` : ""}，` +
                `最常出现的：` +
                rows
                  .slice(0, 3)
                  .map(
                    (m) =>
                      `「${cut(m.content, 60)}」（×${Number(m.count ?? 1)}${
                        String(m.knowledge_point_name ?? "").trim() ? `，${cut(m.knowledge_point_name, 40)}` : ""
                      }${String(m.last_seen ?? "").trim() ? `，最近 ${String(m.last_seen).slice(0, 10)}` : ""}）`
                  )
                  .join("、")
            );
          }
          return out.length ? out : ["（错题本里没有未关闭的记录）"];
        };

        const wantCourse = String(params.course ?? "").trim();
        const wantTopic = String(params.topic ?? "").trim();
        const lines: string[] = [];

        // —— 单门课：掌握叙述 + 教学建议 + 知识点档位 + 学习结果 + 本课错题 ——
        if (wantCourse) {
          const hit =
            courseRows.find((c) => String(c.title) === wantCourse) ??
            courseRows.find((c) => String(c.title).includes(wantCourse));
          if (!hit) {
            return ok(
              `没有找到课程「${wantCourse}」。当前课程：${courseRows
                .slice(0, 30)
                .map((c) => String(c.title))
                .join("、")}。`
            );
          }
          const title = String(hit.title);
          const uuid = String(hit.uuid ?? "");
          const topicName =
            topics.find((t) => t.topic_key === String(hit.topic_key))?.name ?? String(hit.topic);
          lines.push(`「${kid.name}」的课程「${title}」（主题 ${topicName}）`);
          lines.push(courseLine(hit));
          const desc = String(hit.mastery_desc ?? "").trim();
          const advice = String(hit.teaching_advice ?? "").trim();
          if (desc) lines.push(`\n掌握情况：${cut(desc, 1200)}`);
          if (advice) lines.push(`下次教学建议：${cut(advice, 600)}`);
          if (!desc && !advice) lines.push("\n（这门课还没生成掌握分析——还没轮到分析，不代表学得差。）");

          const kps = kpRows.filter(
            (k) => String(k.course_uuid) === uuid || (!!uuid && String(k.course_name) === title)
          );
          lines.push("\n知识点掌握：");
          if (!kps.length) lines.push("- （这门课还没有知识点记录）");
          else for (const k of kps) lines.push(kpLine(k));

          const results = db
            .prepare(
              `SELECT due_at, done_at, result_summary FROM study_plans
               WHERE child_id = ? AND course_name = ? AND result_summary != ''
               ORDER BY COALESCE(done_at, due_at) DESC LIMIT 6`
            )
            .all(kid.id, title) as Array<{ due_at: string; done_at: string; result_summary: string }>;
          lines.push("\n最近几次学习结果：");
          if (!results.length) lines.push("- 还没有学习结果记录。");
          else
            for (const r of results) {
              lines.push(`- ${String(r.done_at || r.due_at).slice(0, 10)}：${cut(r.result_summary, 400)}`);
            }

          lines.push("\n本课错题本（未关闭）：");
          lines.push(...mistakeSection(mistakes.filter((m) => String(m.course_ref) === title)));
          return ok(lines.join("\n"));
        }

        // —— 主题 / 概览 ——
        const topicKeys = new Set<string>([
          ...topics.map((t) => t.topic_key),
          ...courseRows.map((c) => String(c.topic_key)),
        ]);
        const rowsOfTopic = (key: string) => courseRows.filter((c) => String(c.topic_key) === key);
        const resolveTopic = (input: string): string | null => {
          const t = topics.find((x) => x.topic_key === input) ?? topics.find((x) => x.name === input);
          if (t) return t.topic_key;
          const loose = topics.find(
            (x) => x.topic_key.includes(input) || input.includes(x.topic_key) || x.name.includes(input)
          );
          if (loose) return loose.topic_key;
          if (topicKeys.has(input)) return input;
          return null;
        };
        const pctUnknown = (rows: Array<Record<string, unknown>>) =>
          rows.filter((c) => !String(c.mastery_level ?? "").trim()).length;

        if (wantTopic) {
          const key = resolveTopic(wantTopic);
          if (!key) {
            return ok(`没有找到主题「${wantTopic}」。当前主题：${topics.map((t) => t.name).join("、")}。`);
          }
          const t = topics.find((x) => x.topic_key === key);
          const p = progressRows.find((x) => x.topic === key);
          const rows = rowsOfTopic(key);
          lines.push(
            `「${kid.name}」的主题「${t?.name ?? key}」` +
              `${t?.learn_type ? `（${LEARN_TYPE_ZH[t.learn_type] ?? t.learn_type}）` : ""}`
          );
          lines.push(
            `已学 ${Number(p?.learned ?? 0)}/${Number(p?.total ?? 0)} 课` +
              `${String(p?.next ?? "").trim() ? `，下一课「${String(p?.next ?? "")}」` : ""}` +
              `${String(p?.updated ?? "").trim() ? `；最近学习 ${String(p?.updated).slice(0, 10)}` : ""}`
          );
          lines.push("");
          if (!rows.length) lines.push("（这个主题下还没有课程。）");
          else for (const c of rows) lines.push(courseLine(c));
          const unknown = pctUnknown(rows);
          if (unknown) lines.push(`（其中 ${unknown} 课还没生成掌握分析。）`);

          const titles = new Set(rows.map((c) => String(c.title)));
          const needKps = kpRows.filter(
            (k) => titles.has(String(k.course_name)) && ["needs_review", "learning"].includes(String(k.level))
          );
          if (needKps.length) {
            lines.push("");
            lines.push("需要盯的知识点：");
            for (const k of needKps.slice(0, 12)) lines.push(kpLine(k));
          }
          lines.push("");
          lines.push("薄弱项（错题本，未关闭）：");
          lines.push(...mistakeSection(mistakes.filter((m) => titles.has(String(m.course_ref)))));
          return ok(lines.join("\n"));
        }

        // —— 概览 ——
        lines.push(`【「${kid.name}」的学习情况】`);
        if (topics.length) {
          for (const t of topics) {
            const p = progressRows.find((x) => x.topic === t.topic_key);
            const rows = rowsOfTopic(t.topic_key);
            const mastered = rows.filter((c) => String(c.mastery_level) === "mastered").length;
            const needs = rows.filter((c) => String(c.mastery_level) === "needs_review").length;
            const unknown = pctUnknown(rows);
            lines.push(
              `- ${t.name}（${LEARN_TYPE_ZH[t.learn_type] ?? t.learn_type}）：已学 ${Number(p?.learned ?? 0)}/${Number(
                p?.total ?? 0
              )}` +
                `${String(p?.next ?? "").trim() ? `，下一课「${String(p?.next ?? "")}」` : ""}` +
                `${String(p?.updated ?? "").trim() ? `，最近学习 ${String(p?.updated ?? "").slice(0, 10)}` : ""}` +
                `${mastered ? `，已掌握 ${mastered} 课` : ""}${needs ? `，需要复习 ${needs} 课` : ""}` +
                `${unknown ? `，${unknown} 课还没分析过` : ""}`
            );
          }
        } else {
          lines.push("- （还没有分配主题）");
        }
        // 未挂到任何主题的课程（兜底，避免"看不见的课"）
        const orphanKeys = [...new Set(courseRows.map((c) => String(c.topic_key)))].filter(
          (k) => !topics.some((t) => t.topic_key === k)
        );
        for (const k of orphanKeys) {
          const rows = rowsOfTopic(k);
          lines.push(`- ${String(rows[0]?.topic ?? k)}：共 ${rows.length} 课`);
        }
        lines.push("");
        lines.push("【薄弱项（错题本，未关闭）】");
        lines.push(...mistakeSection(mistakes));
        lines.push("");
        lines.push("想看某个主题或某门课的细节（含知识点档位与最近学习结果），说主题名或课程名即可。");
        return ok(lines.join("\n"));
      } finally {
        db.close();
      }
    },
  });

  // ==================== F3 + F2：积分与兑换 ====================
  const pointsTool = defineTool({
    name: "parent_child_points_report",
    label: "孩子的积分报告",
    description:
      "一次拿到某个孩子的积分全貌：当前余额、家里的加分规则（必做项档位、孩子自排项的解锁门槛）、最近每天的结算（完成率/漏了几项/命中档位/是否解锁/加了多少分）、最近的积分变动明细，以及等家长处理的兑换申请。",
    parameters: Type.Object({
      child: Type.Optional(Type.String({ description: "孩子姓名（缺省＝名下唯一的孩子）" })),
      days: Type.Optional(Type.Number({ description: "看最近几天的结算（缺省 7，最多 30）" })),
    }),
    execute: async (_id: string, params: { child?: string; days?: number }) => {
      const kid = resolveChild(deps, params.child);
      const days = Math.max(1, Math.min(Math.round(Number(params.days) || 7), 30));
      const today = localDate();
      const since = daysAgo(days - 1);
      const db = openKb(deps.dataDir, deps.parentId, kid.id);
      try {
        const bal = db.prepare("SELECT balance FROM points_balance WHERE child_id = ?").get(kid.id) as
          | { balance?: number }
          | undefined;
        const cfg = db
          .prepare(
            `SELECT todo_tiers_json, exam_tiers_json, todo_gate_parent_min_rate, exam_gate_parent_min_score,
                    optional_points, child_no_deduct
             FROM reward_configs WHERE child_id = ?`
          )
          .get(kid.id) as
          | {
              todo_tiers_json?: string;
              exam_tiers_json?: string;
              todo_gate_parent_min_rate?: number;
              exam_gate_parent_min_score?: number;
              optional_points?: number;
              child_no_deduct?: number;
            }
          | undefined;
        const stats = db
          .prepare(
            `SELECT date, source, owner, required_total, required_done, optional_done, missed_count, rate,
                    tier, gate_ok, points_awarded, settled_at
             FROM reward_daily_stats WHERE child_id = ? AND date >= ?
             ORDER BY date DESC, source ASC, owner ASC`
          )
          .all(kid.id, since) as Array<Record<string, unknown>>;
        const ledger = db
          .prepare(
            "SELECT biz_date, ts, type, amount, reason FROM points_ledger WHERE child_id = ? ORDER BY ts DESC LIMIT 12"
          )
          .all(kid.id) as Array<{ biz_date: string; ts: string; type: string; amount: number; reason: string }>;
        // 待家长履约的兑换申请（F2：扣分发生在"家长履约"时，不在孩子申请时）
        const pending = db
          .prepare(
            `SELECT r.custom_desc, r.cost, r.created_at, i.name AS item_name
             FROM redemption_requests r LEFT JOIN redemption_items i ON i.id = r.item_id
             WHERE r.child_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC LIMIT 10`
          )
          .all(kid.id) as Array<{ custom_desc: string; cost: number; created_at: string; item_name: string | null }>;

        const todoTiers = parseTiers(cfg?.todo_tiers_json, DEFAULT_TODO_TIERS);
        const examTiers = parseTiers(cfg?.exam_tiers_json, DEFAULT_EXAM_TIERS);
        const gateRate = Number(cfg?.todo_gate_parent_min_rate ?? 1);
        const gateScore = Number(cfg?.exam_gate_parent_min_score ?? 0.9);
        const optionalPoints = Number(cfg?.optional_points ?? 5);
        const noDeduct = (cfg?.child_no_deduct ?? 1) === 1;
        const balance = Number(bal?.balance ?? 0);

        const lines: string[] = [];
        lines.push(`「${kid.name}」的积分（截至 ${today}）`);
        lines.push(`**余额：${balance} 分**`);
        lines.push("");
        lines.push("【加分规则（家长设定）】");
        lines.push(`- 家长排的计划（必做项）：**按完成率直接评档**（没有额外门槛）：${tiersText(todoTiers)}`);
        lines.push(
          `- 家长排的考核：**按得分率直接评档**：${tiersText(examTiers)}`
        );
        lines.push(
          `- 孩子自己排的（加分项）：**要当天家长组的必做项达标才解锁**（计划完成率 ≥ ${Math.round(
            gateRate * 100
          )}%、考核得分率 ≥ ${Math.round(gateScore * 100)}%）；解锁后按同一套档位算，每完成一条另有 +${optionalPoints} 分` +
            `${noDeduct ? "；**当前设置：只加不扣**（负分归零）" : "；当前设置：**允许扣分**（负分照扣）"}`
        );
        lines.push("- **结算在次日日终做**：今天那一行只是实时进度，晚上结算完才出现在流水里。");
        lines.push("");

        lines.push(`【最近 ${days} 天的结算】（今天那行是实时进度，还没结算）`);
        if (!stats.length) {
          lines.push("- 这段时间还没有结算记录。");
        } else {
          for (const s of stats) {
            const date = String(s.date);
            const total = Number(s.required_total ?? 0);
            const done = Number(s.required_done ?? 0);
            const optional = Number(s.optional_done ?? 0);
            const missed = Number(s.missed_count ?? 0);
            const rateTxt =
              `完成 ${done}/${total}` +
              `${missed ? `，漏 ${missed} 项` : ""}` +
              `${optional ? `，另加分项 ${optional} 条` : ""} = ${pct(s.rate)}`;
            const head = `- ${date} · ${sourceZh(s.source)} · ${ownerZh(s.owner)} · ${rateTxt}`;
            if (date === today) {
              lines.push(`${head} · 进行中（今晚结算）`);
              continue;
            }
            const gate = s.gate_ok === 1 ? "已过 ✅" : s.gate_ok === 0 ? "**未过**" : "—";
            const tier = String(s.tier ?? "").trim();
            const awarded = Number(s.points_awarded ?? 0);
            const why =
              awarded === 0 && s.gate_ok === 0
                ? "（门槛未过，所以没加分）"
                : awarded === 0 && tier
                  ? "（命中该档本身是 0 分）"
                  : "";
            lines.push(
              `${head} · 档位「${tier || "—"}」· 门槛 ${gate} · 结算 ${awarded > 0 ? "+" : ""}${awarded} 分${why}`
            );
          }
        }
        lines.push("");

        lines.push("【兑换（已提交、还没标记发放）】");
        if (!pending.length) lines.push("- 没有待发放的兑换记录。");
        else {
          for (const r of pending) {
            const name = String(r.item_name ?? "").trim();
            const custom = String(r.custom_desc ?? "").trim();
            const cost = Number(r.cost ?? 0);
            lines.push(
              `- ${name ? `「${name}」` : "（自定义兑换）"}${custom ? `（备注：${cut(custom, 120)}）` : ""}` +
                ` · 扣 ${cost} 分 · ${String(r.created_at).slice(0, 10)} 提交`
            );
          }
          // ⚠️ 与实现对齐（2026-09-25 核实）：兑换在**提交那一刻**就扣分并写流水（type='redeem'），
          // 这里列的是 status='pending'＝**还没标记发放**的那些——不要对孩子/家长说"还没扣分"。
          lines.push(
            "（兑换是**提交时就扣分**并写进流水（类型「兑换」）的；上面这些只是还没标记「已发放」。发放在对话里没有入口。）"
          );
        }
        lines.push("");

        lines.push("【最近的积分变动】");
        if (!ledger.length) lines.push("- 还没有积分变动记录。");
        else {
          for (const r of ledger) {
            const sign = r.type === "earn" ? "+" : "-";
            lines.push(`- ${String(r.biz_date || r.ts).slice(0, 10)} · ${sign}${Math.abs(Number(r.amount))} · ${cut(r.reason, 140)}`);
          }
        }
        return ok(lines.join("\n"));
      } finally {
        db.close();
      }
    },
  });

  return [examTool, masteryTool, pointsTool];
}
