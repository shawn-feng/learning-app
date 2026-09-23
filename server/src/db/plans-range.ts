/**
 * 计划域多日聚合（ISSUE-130）：家长端孩子详情「计划」tab 的数据源。
 *
 * 与 /plans/today 的关系：item 形状完全一致（三域 study/life/exam，owner=creator，
 * carry 标记等），区别只有两点——
 *  1. 一次返回 [from, from+days) 逐日桶（/plans/today 是单日）；
 *  2. 对 `plan_recurrences` 的未来命中日做**只读虚拟展开**（virtual:true）：worker 的
 *     expandRecurrences 只在当天命中时物化，直接按窗口查未来日期会漏掉循环任务，
 *     家长看到的未来排期会假性空白。虚拟行不落库、不参与状态推进，当天 worker 物化后
 *     （同 recurrence_id 的行出现）虚拟行自动让位。
 *
 * 纯函数 + 显式开库，路由层只做鉴权/参数夹取（可测性同 ISSUE-121 的工具级直调模式）。
 */
import type { DatabaseSync } from "node:sqlite";
import { openKb } from "./kb.js";

export interface PlanRangeItem {
  planId: string;
  kind: "study" | "life" | "exam";
  title: string;
  topicKey: string;
  mode: string;
  /** parent=必须完成项 / child=加分项（同 /plans/today：取 creator） */
  owner: string;
  origin: string;
  startAt: string;
  dueAt: string;
  status: string;
  doneAt: string;
  carry: boolean;
  /** 重复规则的只读虚拟展开（未来预览；当天物化后由真实行取代） */
  virtual?: boolean;
  taskType?: string;
  points?: number;
  score?: number;
}

export interface PlanRangeDay {
  date: string;
  items: PlanRangeItem[];
}

export interface PlanRangeResult {
  from: string;
  days: PlanRangeDay[];
}

/** 本地时区 YYYY-MM-DD（逐字对齐 worker/kb-tools formatLocalDate）。 */
function formatLocalDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 日期串 +n 天 → YYYY-MM-DD（本地；经 Date 归一，天然处理跨月/跨年）。 */
function shiftDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return formatLocalDate(dt);
}

const dateOf = (ts: string) => (ts || "").slice(0, 10);
const dayStart = (d: string) => `${d} 00:00:00`;
const dayEnd = (d: string) => `${d} 23:59:59`;

interface KbRow {
  id: string;
  course_name?: string | null;
  topic_key?: string | null;
  mode?: string | null;
  title?: string | null;
  creator?: string | null;
  origin?: string | null;
  recurrence_id?: string | null;
  start_at?: string | null;
  due_at?: string | null;
  status?: string | null;
  done_at?: string | null;
  carry_from?: string | null;
  task_type?: string | null;
  points?: number | null;
  score?: number | null;
}

/**
 * 多日三域聚合。days 夹取 1~31；from 需为合法 YYYY-MM-DD（路由层校验）。
 */
export function collectPlanRange(
  dataDir: string,
  parentId: string,
  childId: string,
  from: string,
  days: number
): PlanRangeResult {
  const n = Math.min(31, Math.max(1, Math.round(days) || 14));
  const dates: string[] = [];
  for (let i = 0; i < n; i++) dates.push(shiftDate(from, i));
  const to = dates[dates.length - 1]!;

  const kb = openKb(dataDir, parentId, childId);
  try {
    // 窗口与 [from, to] 有交集的物化行（'' 视作无界，同 /plans/today 口径）
    const overlap = "(start_at = '' OR substr(start_at,1,10) <= ?) AND (due_at = '' OR substr(due_at,1,10) >= ?)";
    const study = kb
      .prepare(
        `SELECT id, course_name, topic_key, mode, creator, origin, recurrence_id, start_at, due_at, status, done_at, carry_from
           FROM study_plans WHERE active = 1 AND ${overlap} ORDER BY due_at, created_at`
      )
      .all(to, from) as unknown as KbRow[];
    const life = kb
      .prepare(
        `SELECT id, title, creator, origin, recurrence_id, start_at, due_at, status, done_at, carry_from, task_type, points
           FROM life_plans WHERE active = 1 AND ${overlap} ORDER BY due_at, created_at`
      )
      .all(to, from) as unknown as KbRow[];
    const exam = kb
      .prepare(
        `SELECT id, title, creator, start_at, due_at, status, done_at, score
           FROM exam_plans WHERE active = 1 AND ${overlap} ORDER BY due_at, created_at`
      )
      .all(to, from) as unknown as KbRow[];

    const toStudyItem = (r: KbRow): PlanRangeItem => ({
      planId: String(r.id),
      kind: "study",
      title: String(r.course_name ?? ""),
      topicKey: String(r.topic_key ?? ""),
      mode: String(r.mode ?? "new"),
      owner: String(r.creator ?? "parent"),
      origin: String(r.origin ?? ""),
      startAt: String(r.start_at ?? ""),
      dueAt: String(r.due_at ?? ""),
      status: String(r.status ?? "pending"),
      doneAt: String(r.done_at ?? ""),
      carry: !!r.carry_from,
    });
    const toLifeItem = (r: KbRow): PlanRangeItem => ({
      planId: String(r.id),
      kind: "life",
      title: String(r.title ?? ""),
      topicKey: "",
      mode: "life",
      owner: String(r.creator ?? "parent"),
      origin: String(r.origin ?? ""),
      startAt: String(r.start_at ?? ""),
      dueAt: String(r.due_at ?? ""),
      status: String(r.status ?? "pending"),
      doneAt: String(r.done_at ?? ""),
      carry: !!r.carry_from,
      taskType: String(r.task_type ?? "required"),
      points: Number(r.points) || 0,
    });
    const toExamItem = (r: KbRow): PlanRangeItem => ({
      planId: String(r.id),
      kind: "exam",
      title: String(r.title ?? "考核"),
      topicKey: "",
      mode: "exam",
      owner: String(r.creator ?? "parent"),
      origin: "exam",
      startAt: String(r.start_at ?? ""),
      dueAt: String(r.due_at ?? ""),
      status: String(r.status ?? "pending"),
      doneAt: String(r.done_at ?? ""),
      carry: false,
      score: Number(r.score) || 0,
    });

    // 逐日桶：行窗口覆盖该天即入桶（与 /plans/today 的单日查询同语义）
    const covers = (r: { start_at?: string | null; due_at?: string | null }, d: string) =>
      (!r.start_at || dateOf(String(r.start_at)) <= d) && (!r.due_at || dateOf(String(r.due_at)) >= d);
    const buckets = new Map<string, PlanRangeItem[]>();
    const push = (d: string, it: PlanRangeItem) => {
      const arr = buckets.get(d) ?? [];
      arr.push(it);
      buckets.set(d, arr);
    };
    for (const d of dates) {
      for (const r of study) if (covers(r, d)) push(d, toStudyItem(r));
      for (const r of life) if (covers(r, d)) push(d, toLifeItem(r));
      for (const r of exam) if (covers(r, d)) push(d, toExamItem(r));
    }

    // 重复规则虚拟展开：仅 life/study（exam 规则 expandRecurrences 也不物化）；
    // 当天已有同 recurrence_id 的物化行 → 该天跳过虚拟行（worker 已接管）。
    const materializedRec = new Set<string>();
    for (const r of [...study, ...life]) {
      if (r.recurrence_id) materializedRec.add(`${String(r.recurrence_id)}@${dateOf(String(r.start_at || r.due_at || ""))}`);
    }
    const rules = kb
      .prepare("SELECT id, plan_type, payload_json, rule, weekday, start_date, end_date FROM plan_recurrences WHERE enabled = 1")
      .all() as Array<{
      id: string;
      plan_type: string;
      payload_json: string;
      rule: string;
      weekday: number | null;
      start_date: string;
      end_date: string;
    }>;
    for (const r of rules) {
      if (r.plan_type === "exam") continue;
      const payload = (() => {
        try {
          return JSON.parse(String(r.payload_json || "{}")) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      for (const d of dates) {
        if (r.start_date && d < r.start_date) continue;
        if (r.end_date && d > r.end_date) continue;
        // weekday 为 NULL 的 weekly 规则不命中任何天（对齐 expandRecurrences：Number(null)=0 会误命中周日）
        const weekday = r.weekday == null ? null : Number(r.weekday);
        const hit = r.rule === "daily" ? true : r.rule === "weekly" ? weekday === new Date(`${d}T12:00:00`).getDay() : false;
        if (!hit) continue;
        if (materializedRec.has(`${String(r.id)}@${d}`)) continue;
        const creator = String(payload.creator || "parent");
        const taskType = String(payload.task_type || (creator === "parent" ? "required" : "optional"));
        if (r.plan_type === "life") {
          push(d, {
            planId: `virtual:${r.id}`,
            kind: "life",
            title: String(payload.title ?? "（未命名）"),
            topicKey: "",
            mode: "life",
            owner: creator,
            origin: "recurrence",
            startAt: dayStart(d),
            dueAt: dayEnd(d),
            status: "pending",
            doneAt: "",
            carry: false,
            virtual: true,
            taskType,
            points: Number(payload.points) || 0,
          });
        } else {
          const courseName = String(payload.course_name || payload.title || "（未命名）");
          push(d, {
            planId: `virtual:${r.id}`,
            kind: "study",
            title: courseName,
            topicKey: String(payload.topic_key || ""),
            mode: String(payload.mode || "new"),
            owner: creator,
            origin: "recurrence",
            startAt: dayStart(d),
            dueAt: dayEnd(d),
            status: "pending",
            doneAt: "",
            carry: false,
            virtual: true,
            taskType,
            points: Number(payload.points) || 0,
          });
        }
      }
    }

    return {
      from,
      days: dates.map((date) => ({
        date,
        items: (buckets.get(date) ?? []).sort(
          (a, b) => (a.dueAt || "").localeCompare(b.dueAt || "") || a.title.localeCompare(b.title)
        ),
      })),
    };
  } finally {
    kb.close();
  }
}
