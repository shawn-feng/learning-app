/**
 * 只读报告工具的**共用零件**（ISSUE-144 P4 抽出；原先私有在 `child-report-tools.ts` 里）。
 *
 * 抽出来的唯一理由：**同一份口径只写一处**。
 * - **积分档位**的解析与默认档位必须与 `worker/plan-domain.ts` 的 `matchTier` 同口径
 *   （区间左闭右开、末档上界含 1）——孩子端与家长端给同一份数据只能有一种说法；
 * - **掌握档位**的中文说法（`not_started`/`learning`/`needs_review`/`mastered`）两端共用；
 * - 日期/百分比/单行截断这类格式化一旦分叉，同一份数据在两处就会长得不一样。
 *
 * 纯函数、无副作用、不碰库——把"取数"留在各自的报告工具里。
 */

/** 工具返回体（与 `tool-kit` 的约定一致：content 文本 + 空 details） */
export const okText = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** 单行截断（去掉换行，避免注入口径被换行割裂） */
export function cut(s: unknown, n: number): string {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 0.4 → 40%；非数字 → — */
export function pct(r: unknown): string {
  const n = Number(r);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "—";
}

/** 本地时区日期 YYYY-MM-DD（与 db/sessions 的 localDateOf 同口径） */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** n 天前的本地日期（n=1 → 昨天） */
export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
}

/** 掌握档位 → 人话（ISSUE-135 的四档；空值＝分析任务还没写过，**不等于学得差**） */
export const MASTERY_ZH: Record<string, string> = {
  not_started: "⬜ 还没开始",
  learning: "📖 学习中",
  needs_review: "🔁 需要复习",
  mastered: "✅ 已经掌握",
};

/** 考核知识点的三档结果（`knowledge_point_records.outcome`） */
export const OUTCOME_ZH: Record<string, string> = { solid: "扎实", partial: "部分掌握", weak: "薄弱" };

/** 题级行为（`exam_plan_courses.behavior`） */
export const BEHAVIOR_ZH: Record<string, string> = { speech_recite: "背诵", speech_read: "朗读", generic: "答题" };

/** 主题类型（孩子库 `topics.learn_type`） */
export const LEARN_TYPE_ZH: Record<string, string> = { required: "必学", optional: "选学", review: "复习" };

/** 错题本三类（`mistake_book.kind`） */
export const MISTAKE_KIND_ZH: Record<string, string> = {
  wrong_question: "错题",
  unknown_word: "生字",
  weak_point: "薄弱点",
};

/** 积分档位：区间左闭右开，末档上界含 1（与 worker/plan-domain.ts 的 matchTier 口径一致） */
export interface Tier {
  min: number;
  max: number;
  label: string;
  points: number;
}

export const DEFAULT_TODO_TIERS: Tier[] = [
  { min: 0, max: 0.6, label: "不合格", points: -10 },
  { min: 0.6, max: 0.8, label: "合格", points: 0 },
  { min: 0.8, max: 1.0, label: "良好", points: 10 },
  { min: 1.0, max: 1.0, label: "优秀", points: 20 },
];
export const DEFAULT_EXAM_TIERS: Tier[] = [
  { min: 0, max: 0.8, label: "不合格", points: -15 },
  { min: 0.8, max: 0.9, label: "合格", points: 0 },
  { min: 0.9, max: 1.0, label: "良好", points: 10 },
  { min: 1.0, max: 1.0, label: "优秀", points: 20 },
];

/** 解析 reward_configs 的档位 JSON（坏数据/空值 → 落回默认档位） */
export function parseTiers(raw: unknown, fallback: Tier[]): Tier[] {
  try {
    const a = JSON.parse(String(raw ?? "[]")) as Tier[];
    if (!Array.isArray(a) || !a.length) return fallback;
    const out = a
      .filter((t) => t && typeof t.min === "number" && typeof t.max === "number")
      .map((t) => ({
        min: Number(t.min),
        max: Number(t.max),
        label: String(t.label ?? ""),
        points: Number(t.points) || 0,
      }));
    return out.length ? out : fallback;
  } catch {
    return fallback;
  }
}

/** 档位规则一行文字：`<60% 不合格 -10 ｜ 60%~80% 合格 0 ｜ …` */
export function tiersText(tiers: Tier[]): string {
  return tiers
    .map((t) => {
      const range =
        t.min === t.max
          ? `${Math.round(t.min * 100)}%`
          : `${Math.round(t.min * 100)}%~${Math.round(t.max * 100)}%`;
      return `${range} ${t.label || "（未命名档）"} ${t.points > 0 ? "+" : ""}${t.points}`;
    })
    .join(" ｜ ");
}

/** 结算行的 owner/source 说法（家长端与孩子端共用同一套词） */
export function ownerZh(owner: unknown): string {
  return String(owner) === "parent" ? "家长排的（必做项）" : "孩子自己排的（加分项）";
}

export function sourceZh(source: unknown): string {
  return String(source) === "exam" ? "考核" : "计划";
}
