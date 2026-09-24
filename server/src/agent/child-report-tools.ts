/**
 * 孩子 agent 的**场景专用只读工具**（ISSUE-142，2026-09-23 落地）。
 *
 * 背景：孩子侧原先有一套通用数据通道（`child_db_read` 对 22 张表任意等值查询、
 * `child_db_write` 两表白名单、`child_db_describe` 列表结构）。按"场景 → 工具"逐条对齐后
 * 确认：**没有任何场景需要通用通道**，它只是"缺专用工具时的兜底"。本文件把兜底换成三个
 * **业务语言**的只读工具（对应场景文档 §4 的 B6/G1、F4/C1、E7）：
 *
 * - `child_points_report`  积分余额 / 逐日结算（完成率·命中档位·门槛）/ 近期流水 + 规则文字
 *                          → B6「为什么没加分」、G1「积分怎么少了」
 * - `child_mastery_report` 课程掌握（四列）+ 学习结果概要 + 最近考核得分率 + 主题进度
 *                          → F4「我学得怎么样」、C1「学到哪了」
 * - `child_exam_result`    某场考核的逐题结果 + 每课概要 + 知识点档位
 *                          → E7「这次错在哪」（考后复盘）
 *
 * 安全边界（沿用 ISSUE-105 权限矩阵与 ISSUE-139 泄题红线）：
 * 1. **只读**；连接不经过参数——`openKb(dataDir, parentId, childId)` 的 id 来自会话绑定，物理上只能开自己的库；
 * 2. **不接受表名 / 列名 / SQL 片段**——每个工具的取数范围在代码里写死，无"任意查询"入口；
 * 3. **不返回内部标识**（行 id、operator、source_table、meta_json 等）与**标准答案**
 *    （答案与评分细则只存在于家长库，孩子库天然没有，本文件也不去读家长库）；
 * 4. **考核逐题只对"已结束"的场次可读**（`status='done'`）——未开考的场次只给"考什么范围"，
 *    不给题目，防泄题；同场次不给"重考"动作（重考按 E4/E6 口径另行安排）。
 */
import { defineTool } from "./tool-kit.js";
import { Type } from "typebox";
import { openKb } from "../db/kb.js";
import { parsePlanCourses, formatPlanCourses } from "../assess-selection.js";
// ISSUE-144 P4：格式化/档位解析抽到 report-utils（家长侧报告工具共用同一份口径）
import {
  BEHAVIOR_ZH,
  DEFAULT_EXAM_TIERS,
  DEFAULT_TODO_TIERS,
  LEARN_TYPE_ZH as TYPE_ZH,
  MASTERY_ZH,
  OUTCOME_ZH,
  cut,
  daysAgo,
  localDate,
  okText as ok,
  parseTiers,
  pct,
  tiersText,
} from "./report-utils.js";

export interface ChildReportToolDeps {
  dataDir: string;
  parentId: string;
  childId: string;
}

export function createChildReportTools(deps: ChildReportToolDeps) {
  /** 积分报告（B6 / G1） */
  const pointsTool = defineTool({
    name: "child_points_report",
    label: "我的积分报告",
    description:
      "一次拿到「我的积分」的完整解释：余额、最近每天的结算（完成率 / 命中档位 / 门槛是否解锁 / 结算分数）、" +
      "最近的积分变动明细（每笔为什么加或扣）、以及家长的加分规则。\n" +
      "**孩子问「我有多少积分」「怎么少了」「我明明做完了为什么没加分」时用它**，不要凭印象答。\n" +
      "口径要点：① 家长排的计划，**必须全部完成（或考核达标）达到门槛**才会解锁加分；" +
      "② 没解锁或者命中 0 分档位 → 结算 0，**这不等于扣分**；③ 今天的那一行是实时进度、**日终才结算**；" +
      "④ 孩子自己安排的事属于加分项，只加不扣。",
    parameters: Type.Object({
      days: Type.Optional(Type.Number({ description: "看最近几天的结算（缺省 7，最多 30）" })),
    }),
    execute: async (_id: string, params: { days?: number }) => {
      const days = Math.max(1, Math.min(Math.round(Number(params.days) || 7), 30));
      const today = localDate();
      const since = daysAgo(days - 1);
      const db = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        const bal = db
          .prepare("SELECT balance FROM points_balance WHERE child_id = ?")
          .get(deps.childId) as { balance?: number } | undefined;
        const cfg = db
          .prepare(
            "SELECT todo_tiers_json, exam_tiers_json, todo_gate_parent_min_rate, exam_gate_parent_min_score, optional_points, child_no_deduct FROM reward_configs WHERE child_id = ?"
          )
          .get(deps.childId) as
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
            `SELECT date, source, owner, required_total, required_done, optional_done, missed_count, rate, tier, gate_ok, points_awarded, settled_at
             FROM reward_daily_stats WHERE child_id = ? AND date >= ?
             ORDER BY date DESC, source ASC, owner ASC`
          )
          .all(deps.childId, since) as Array<Record<string, unknown>>;
        const ledger = db
          .prepare(
            "SELECT biz_date, ts, type, amount, reason FROM points_ledger WHERE child_id = ? ORDER BY ts DESC LIMIT 12"
          )
          .all(deps.childId) as Array<{ biz_date: string; ts: string; type: string; amount: number; reason: string }>;

        const todoTiers = parseTiers(cfg?.todo_tiers_json, DEFAULT_TODO_TIERS);
        const examTiers = parseTiers(cfg?.exam_tiers_json, DEFAULT_EXAM_TIERS);
        const gateRate = Number(cfg?.todo_gate_parent_min_rate ?? 1);
        const gateScore = Number(cfg?.exam_gate_parent_min_score ?? 0.9);
        const optionalPoints = Number(cfg?.optional_points ?? 5);

        const lines: string[] = [];
        lines.push(`我的积分（截至 ${today}）`);
        lines.push(`**余额：${Number(bal?.balance ?? 0)} 分**`);
        lines.push("");
        lines.push("【怎么加分（家长设定）】");
        lines.push(`- 家长排的计划（必做项）：**完成率要 ≥ ${Math.round(gateRate * 100)}% 才解锁加分**；档位 ${tiersText(todoTiers)}`);
        lines.push(`- 考核：**得分率要 ≥ ${Math.round(gateScore * 100)}% 才解锁加分**；档位 ${tiersText(examTiers)}`);
        lines.push(`- 我自己安排的事（加分项）：每完成一条 +${optionalPoints} 分，**只加不扣**`);
        lines.push("");

        lines.push(`【最近 ${days} 天的结算】（今天那行是实时进度，晚上才结算）`);
        if (!stats.length) {
          lines.push("- 这段时间还没有结算记录。");
        } else {
          for (const s of stats) {
            const date = String(s.date);
            const kind = s.source === "exam" ? "考核" : "计划";
            const who = s.owner === "parent" ? "家长排的（必做项）" : "我自己排的（加分项）";
            const isToday = date === today;
            const total = Number(s.required_total ?? 0);
            const done = Number(s.required_done ?? 0);
            const optional = Number(s.optional_done ?? 0);
            const rateTxt = `完成 ${done}/${total}${optional ? `，另加分项 ${optional} 条` : ""} = ${pct(s.rate)}`;
            if (isToday) {
              lines.push(`- ${date} · ${kind} · ${who} · ${rateTxt} · 进行中（今晚结算）`);
              continue;
            }
            const gate = s.gate_ok === 1 ? "已过 ✅" : s.gate_ok === 0 ? "**未过**" : "—";
            const tier = String(s.tier ?? "").trim();
            const awarded = Number(s.points_awarded ?? 0);
            const why0 = awarded === 0 && s.gate_ok === 0 ? "（门槛未过，所以没加分）" : awarded === 0 && tier ? "（命中该档本身是 0 分）" : "";
            lines.push(
              `- ${date} · ${kind} · ${who} · ${rateTxt} · 档位「${tier || "—"}」· 门槛 ${gate} · 结算 ${awarded > 0 ? "+" : ""}${awarded} 分${why0}`
            );
          }
        }
        lines.push("");

        lines.push("【最近的积分变动】");
        if (!ledger.length) lines.push("- 还没有积分变动记录。");
        else {
          for (const r of ledger) {
            const sign = r.type === "earn" ? "+" : "-";
            lines.push(`- ${String(r.biz_date || r.ts).slice(0, 10)} · ${sign}${Math.abs(Number(r.amount))} · ${cut(r.reason, 120)}`);
          }
        }
        return ok(lines.join("\n"));
      } finally {
        db.close();
      }
    },
  });

  /** 掌握与学习情况报告（F4 / C1） */
  const masteryTool = defineTool({
    name: "child_mastery_report",
    label: "我的学习情况",
    description:
      "一次拿到「我学得怎么样」：每个主题学到哪了（已学几课 / 共几课 / 下一课）、每门课的掌握程度与最近学习时间、" +
      "最近几次考核的得分率、以及课程层面的学习结果与下次教学建议。\n" +
      "**孩子问「我学得怎么样」「这门课我掌握了吗」「上次学到哪了」时用它**，不要凭印象答。\n" +
      "展开方式：不传参 = 全部主题的概览；传 `topic` = 该主题逐课展开；传 `course` = 单门课详情 + 这门课最近几次的学习结果。\n" +
      "口径要点：① 掌握档位来自服务端分析（还没开始 / 学习中 / 需要复习 / 已经掌握），**空着=还没分析过**，别当成「学得差」；" +
      "② 讲的时候**先说进步与已掌握的部分，再说需要复习的**，不要一把列出所有薄弱点。",
    parameters: Type.Object({
      topic: Type.Optional(Type.String({ description: "主题名（中文名或拼音目录名，如 论语 / lunyu）" })),
      course: Type.Optional(Type.String({ description: "课程名（如 学而第一）" })),
    }),
    execute: async (_id: string, params: { topic?: string; course?: string }) => {
      const db = openKb(deps.dataDir, deps.parentId, deps.childId);
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
            `SELECT c.topic, c.topic_key, c.title, c.status, c.last_review, c.review_count,
                    c.mastery_level, c.mastery_desc, c.teaching_advice, c.mastery_updated_at,
                    p.lastExamRate, p.lastExamAt, p.lastLearnedAt
             FROM courses c
             LEFT JOIN course_progress p ON p.topic = c.topic AND p.title = c.title
             ORDER BY c.topic_key, c.sort_order, c.title`
          )
          .all() as Array<Record<string, unknown>>;

        if (!topics.length && !courseRows.length) return ok("还没有分配学习主题/课程，暂时没有学习情况可看。");

        const lines: string[] = [];

        const courseLine = (c: Record<string, unknown>): string => {
          const level = String(c.mastery_level ?? "").trim();
          const badge = level ? (MASTERY_ZH[level] ?? level) : "（还没分析过）";
          const bits: string[] = [String(c.title)];
          bits.push(`掌握：${badge}`);
          if (String(c.last_review ?? "").trim()) bits.push(`最近学习 ${String(c.last_review).slice(0, 10)}`);
          if (Number(c.review_count) > 0) bits.push(`复习 ${Number(c.review_count)} 次`);
          const rate = c.lastExamRate;
          if (rate !== null && rate !== undefined && String(rate) !== "")
            bits.push(`最近考核 ${pct(rate)}${String(c.lastExamAt ?? "").trim() ? `（${String(c.lastExamAt).slice(0, 10)}）` : ""}`);
          return `- ${bits.join(" · ")}`;
        };

        const wantCourse = String(params.course ?? "").trim();
        const wantTopic = String(params.topic ?? "").trim();

        // —— 单门课详情 ——
        if (wantCourse) {
          const hit =
            courseRows.find((c) => String(c.title) === wantCourse) ??
            courseRows.find((c) => String(c.title).includes(wantCourse));
          if (!hit) {
            return ok(
              `没有找到课程「${wantCourse}」。当前课程：${courseRows.slice(0, 30).map((c) => String(c.title)).join("、")}。`
            );
          }
          lines.push(`课程「${String(hit.title)}」（主题 ${String(hit.topic)}）`);
          lines.push(courseLine(hit));
          const desc = String(hit.mastery_desc ?? "").trim();
          if (desc) lines.push(`\n掌握情况：${cut(desc, 1200)}`);
          const advice = String(hit.teaching_advice ?? "").trim();
          if (advice) lines.push(`下次教学建议：${cut(advice, 600)}`);
          if (!desc && !advice) lines.push("（服务端还没有生成这门课的掌握分析，可以正常继续学。）");
          const results = db
            .prepare(
              `SELECT due_at, done_at, result_summary FROM study_plans
               WHERE child_id = ? AND course_name = ? AND result_summary != ''
               ORDER BY COALESCE(done_at, due_at) DESC LIMIT 6`
            )
            .all(deps.childId, String(hit.title)) as Array<{ due_at: string; done_at: string; result_summary: string }>;
          lines.push("\n最近几次学习结果：");
          if (!results.length) lines.push("- 还没有学习结果记录。");
          else
            for (const r of results)
              lines.push(`- ${String(r.done_at || r.due_at).slice(0, 10)}：${cut(r.result_summary, 400)}`);
          return ok(lines.join("\n"));
        }

        // —— 概览 / 单主题 ——
        const topicKeys = new Set<string>([...topics.map((t) => t.topic_key), ...courseRows.map((c) => String(c.topic_key))]);
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

        if (wantTopic) {
          const key = resolveTopic(wantTopic);
          if (!key) return ok(`没有找到主题「${wantTopic}」。当前主题：${topics.map((t) => t.name).join("、")}。`);
          const t = topics.find((x) => x.topic_key === key);
          const p = progressRows.find((x) => x.topic === key);
          lines.push(`主题「${t?.name ?? key}」${t?.learn_type ? `（${TYPE_ZH[t.learn_type] ?? t.learn_type}）` : ""}`);
          lines.push(`已学 ${Number(p?.learned ?? 0)}/${Number(p?.total ?? 0)} 课${String(p?.next ?? "").trim() ? `，下一课「${String(p?.next ?? "")}」` : ""}`);
          lines.push("");
          const rows = rowsOfTopic(key);
          if (!rows.length) lines.push("（这个主题下还没有课程。）");
          else for (const c of rows) lines.push(courseLine(c));
          return ok(lines.join("\n"));
        }

        lines.push("【我的学习情况】");
        if (topics.length) {
          for (const t of topics) {
            const p = progressRows.find((x) => x.topic === t.topic_key);
            const rows = rowsOfTopic(t.topic_key);
            const mastered = rows.filter((c) => String(c.mastery_level) === "mastered").length;
            const needs = rows.filter((c) => String(c.mastery_level) === "needs_review").length;
            lines.push(
              `- ${t.name}（${TYPE_ZH[t.learn_type] ?? t.learn_type}）：已学 ${Number(p?.learned ?? 0)}/${Number(p?.total ?? 0)}` +
                `${String(p?.next ?? "").trim() ? `，下一课「${String(p?.next ?? "")}」` : ""}` +
                `${mastered ? `，已掌握 ${mastered} 课` : ""}${needs ? `，需要复习 ${needs} 课` : ""}`
            );
          }
        } else {
          lines.push("- （还没有分配主题）");
        }
        // 未挂到任何主题的课程（兜底，避免"看不见的课"）
        const orphanTopKeys = [...new Set(courseRows.map((c) => String(c.topic_key)))].filter(
          (k) => !topics.some((t) => t.topic_key === k)
        );
        for (const k of orphanTopKeys) {
          const rows = rowsOfTopic(k);
          lines.push(`- ${String(rows[0]?.topic ?? k)}：共 ${rows.length} 课`);
        }
        lines.push("");
        lines.push("想看某个主题或某门课的细节，说主题名或课程名即可。");
        return ok(lines.join("\n"));
      } finally {
        db.close();
      }
    },
  });

  /** 考核结果与错题复盘（E7） */
  const examResultTool = defineTool({
    name: "child_exam_result",
    label: "我的考核结果",
    description:
      "看考核考得怎么样：不传 `plan_id` → 列出**最近几场已完成的考核**（日期、得分、范围）；" +
      "传 `plan_id` → 展开那一场的**逐题明细**（题干/背诵原文、每题得分、对错、老师评语、是否有录音）、" +
      "**每门课的得分与概要**（含复习重点）、以及**每个知识点的掌握情况**。\n" +
      "**孩子问「我上次考了多少分」「这次错在哪」「帮我分析错题」时用它**，不要凭印象答。\n" +
      "复盘讲法（重要）：先给整体（得分率 + 哪门课最好），再**一次只讲一两道题**、**先问孩子当时怎么想的再讲**，" +
      "最后给一类同类练习；不要一口气把错题全倒出来，也不要评价「考得差」。\n" +
      "边界：只能看**已经考完**的场次（没考的看不到题目）；**没有标准答案可读**——讲题请依据题干原文 + 老师评语 + " +
      "课程资料（`parent_content`）来引导孩子自己想；也不能靠这个工具「重考」或改分数。",
    parameters: Type.Object({
      plan_id: Type.Optional(Type.String({ description: "考核场次 id（缺省=列出最近几场已完成的考核）" })),
      course: Type.Optional(Type.String({ description: "只看某一门课的题（可选，如 学而第一）" })),
      limit: Type.Optional(Type.Number({ description: "列出最近几场（缺省 5，最多 10）" })),
    }),
    execute: async (_id: string, params: { plan_id?: string; course?: string; limit?: number }) => {
      const db = openKb(deps.dataDir, deps.parentId, deps.childId);
      try {
        const planId = String(params.plan_id ?? "").trim();
        const courseFilter = String(params.course ?? "").trim();

        if (!planId) {
          const limit = Math.max(1, Math.min(Math.round(Number(params.limit) || 5), 10));
          const plans = db
            .prepare(
              `SELECT id, title, creator, scope_json, score, due_at, done_at
               FROM exam_plans WHERE child_id = ? AND status = 'done'
               ORDER BY COALESCE(NULLIF(done_at,''), due_at) DESC LIMIT ${limit}`
            )
            .all(deps.childId) as Array<Record<string, unknown>>;
          if (!plans.length) return ok("还没有已完成的考核记录。");
          const lines: string[] = ["最近已完成的考核："];
          for (const p of plans) {
            const agg = db
              .prepare(
                "SELECT COALESCE(SUM(point_got),0) AS got, COALESCE(SUM(point_max),0) AS max FROM exam_course_results WHERE plan_id = ?"
              )
              .get(String(p.id)) as { got: number; max: number };
            const rate = Number(agg?.max) > 0 ? Number(agg.got) / Number(agg.max) : null;
            const courses = parsePlanCourses((JSON.parse(String(p.scope_json || "{}")) as { courses?: unknown }).courses);
            lines.push(
              `- ${String(p.done_at || p.due_at).slice(0, 10)} · 「${String(p.title)}」` +
                `（${p.creator === "child" ? "我自己安排的" : "家长安排的"}）· 得分 ${Number(agg?.got ?? 0)}/${Number(agg?.max ?? 0)}` +
                `${rate === null ? "" : ` = ${pct(rate)}`}` +
                `${courses.length ? ` · 范围：${cut(formatPlanCourses(courses), 160)}` : ""}` +
                ` · id=${String(p.id)}`
            );
          }
          lines.push("");
          lines.push("想看哪一场的逐题明细，把它的 id 传给我就行。");
          return ok(lines.join("\n"));
        }

        const plan = db
          .prepare("SELECT id, title, creator, scope_json, status, score, due_at, done_at FROM exam_plans WHERE id = ? AND child_id = ?")
          .get(planId, deps.childId) as Record<string, unknown> | undefined;
        if (!plan) return ok(`没有找到这场考核（id=${planId}）。先不传 plan_id 看最近几场。`);
        if (String(plan.status) !== "done") {
          const courses = parsePlanCourses((JSON.parse(String(plan.scope_json || "{}")) as { courses?: unknown }).courses);
          return ok(
            `这场考核还没考完（${String(plan.status)}），题目要考完才能看。` +
              (courses.length ? `\n范围：${formatPlanCourses(courses)}\n` : "\n") +
              `现在可以去考核页参加；如果想改期或调整，告诉我就行。`
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
             FROM knowledge_point_records WHERE source = 'exam' AND plan_id = ? ORDER BY course_name, knowledge_point_name`
          )
          .all(planId) as Array<Record<string, unknown>>;

        const got = items.reduce((s, r) => s + (Number(r.point_got) || 0), 0);
        const max = items.reduce((s, r) => s + (Number(r.point_max) || 0), 0);
        const rate = max > 0 ? got / max : Number(plan.score ?? NaN) / 100;

        const lines: string[] = [];
        lines.push(`考核「${String(plan.title)}」· ${String(plan.done_at || plan.due_at).slice(0, 10)}`);
        lines.push(`得分 ${got}/${max}（${max > 0 ? pct(rate) : "—"}）${courseFilter ? ` · 只看「${courseFilter}」` : ""}`);
        const scope = parsePlanCourses((JSON.parse(String(plan.scope_json || "{}")) as { courses?: unknown }).courses);
        if (scope.length) lines.push(`范围：${formatPlanCourses(scope)}`);

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
              `- ${String(c.course_name)}：${Number(c.point_got ?? 0)}/${Number(c.point_max ?? 0)} = ${pct(c.rate)}（${Number(
                c.question_count ?? 0
              )} 题）${String(c.course_summary ?? "").trim() ? `\n  概要：${cut(c.course_summary, 500)}` : ""}${
                focus ? `\n  复习重点：${cut(focus, 300)}` : ""
              }`
            );
          }
        }

        if (kpRecords.length) {
          lines.push("");
          lines.push("【知识点】");
          for (const k of kpRecords) {
            lines.push(
              `- ${String(k.knowledge_point_name)}：${OUTCOME_ZH[String(k.outcome)] ?? String(k.outcome)}` +
                `${k.rate === null || k.rate === undefined ? "" : `（${pct(k.rate)}）`}${String(k.summary ?? "").trim() ? ` — ${cut(k.summary, 300)}` : ""}`
            );
          }
        }

        lines.push("");
        lines.push("【逐题】");
        if (!items.length) lines.push("- 这场考核没有可展示的题目明细。");
        else {
          for (const r of items) {
            const mark = r.correct === 1 ? "✅" : r.correct === 0 ? "❌" : "—";
            const head = `${Number(r.seq ?? 0) + 1}. [${String(r.course_name)}${String(r.knowledge_point_name ?? "").trim() ? ` · ${String(r.knowledge_point_name)}` : ""}${
              String(r.behavior ?? "").trim() ? ` · ${BEHAVIOR_ZH[String(r.behavior)] ?? String(r.behavior)}` : ""
            }] ${mark} ${Number(r.point_got ?? 0)}/${Number(r.point_max ?? 0)}`;
            lines.push(head);
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

  return [pointsTool, masteryTool, examResultTool];
}

export const CHILD_REPORT_TOOL_NAMES = ["child_points_report", "child_mastery_report", "child_exam_result"];
