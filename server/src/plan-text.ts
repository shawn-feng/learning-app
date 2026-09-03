/**
 * 学习计划文本 ↔ 真实课程名 的归一化匹配工具（ISSUE-033 复习项修复，2026-09-03）。
 *
 * 背景：家长对话起草学习计划时，对「已学过的课（status=✅）」会用动作前缀标记复习，
 * 如「复习：论语学而篇第一章」（也存在「学习：」「背诵：」等自由前缀的潜在写法）。
 * 但 courses 表里的真实课程名不含该前缀（=「论语学而篇第一章」）。所有「计划项 → 课程」
 * 的完成态判定（worker stat 打勾 / 家长面板 done / 每日每周考核选题）此前都按
 * plan.text === course.title 精确匹配，导致带前缀的复习项永远匹配不上 → 不打勾、不显示已学、
 * 考核进 unmatched。本模块把计划文本剥成真实课程名候选，供各方匹配。
 *
 * 约定：动作词集合与日常自然用语一致；匹配时「精确优先」，剥前缀后仍查不到再试
 * 剥尾部括号标注（如「论语学而篇第一章（复习）」的写法），两者都不改原展示文本。
 */

/** 计划文本里可出现在课程名前的动作标记词（家长 agent 起草复习/背诵等安排时使用）。 */
export const PLAN_ACTION_MARKERS = [
  "复习",
  "温习",
  "学习",
  "预习",
  "背诵",
  "朗读",
  "跟读",
  "听读",
  "挑战",
  "巩固",
  "掌握",
] as const;

const PREFIX_RE = new RegExp(
  `^(?:${PLAN_ACTION_MARKERS.join("|")})\\s*[:：]\\s*(.+)$`
);
/** 尾部括号标注（复习/温习/回看 等），如「论语学而篇第一章（复习）」。 */
const SUFFIX_RE = /^(.*?)[（(](?:复习|温习|回看)[）)]\s*$/;

/**
 * 计划文本 → 真实课程名候选。
 * 传入「论语子路篇第七章」（无标记）原样返回；「复习：论语学而篇第一章」→「论语学而篇第一章」。
 * 返回字符串为空表示无可匹配候选（计划文本本身为空）。
 */
export function planTextToCourseText(text: string): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  const m = PREFIX_RE.exec(t);
  if (m) return m[1].trim();
  const s = SUFFIX_RE.exec(t);
  if (s && s[1].trim()) return s[1].trim();
  return t;
}

/**
 * 在课程列表里按「计划项文本」找对应课程行。
 * 匹配优先级：精确标题 → 剥动作前缀/尾标注后的标题（未剥前缀也算精确匹配过的候选不重复）。
 * 返回第一个命中的课程；查不到返回 undefined。findTitle 用于兼容不同字段（title）。
 */
export function findCourseByPlanText<T extends { title: string }>(
  courses: T[],
  planText: string
): T | undefined {
  const exact = (courses as T[]).find((c) => c.title.trim() === (planText || "").trim());
  if (exact) return exact;
  const stripped = planTextToCourseText(planText);
  if (stripped && stripped !== (planText || "").trim()) {
    return (courses as T[]).find((c) => c.title.trim() === stripped);
  }
  return undefined;
}
