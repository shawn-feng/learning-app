import { getChildDir } from "./config";
import {
  queryCourseDailySummaries,
  queryTopicProgress,
  queryTopicsMeta,
  type CourseDailySummary,
  type TopicProgress,
} from "./kb-sqlite";

/**
 * 学习进度汇总（ISSUE-023 P2：数据源改为 SQLite 唯一真源）。
 *
 * 数据来源（childDir 下 kb.sqlite，v3）：
 *   - topics 表（来自 learning/topics.md frontmatter）：主题清单
 *   - topic_progress **视图**（由 courses 表实时计算）：各主题 learned/total/next/updated
 *   - rules 表（来自 learning/rules.md frontmatter）：每日目标/必学选学
 *
 * 汇总原则：
 *   - 以 topics 表为「主题清单」；
 *   - 每个主题的 learned/total 以 topic_progress 视图为准（courses 状态自动统计，无需手工维护）；
 *   - daily/type 来自 rules 表。
 */

export interface TopicSummary {
  name: string; // 主题名
  file: string; // 进度文件相对 childDir 路径
  learned: number;
  total: number;
  percent: number; // 0-100，保留一位小数
  next: string; // 下一步
  updated: string; // 最近更新日期
  daily: number | null; // 每日目标
  type: string; // 必学 / 选学
}

export interface LearningSummary {
  topics: TopicSummary[];
  totals: {
    learned: number;
    total: number;
    percent: number;
    topicCount: number;
    completedCount: number; // 已全部完成的主题数
  };
}

function percent(learned: number, total: number): number {
  if (!total) return 0;
  return Math.round((learned / total) * 1000) / 10;
}

export function getLearningSummary(childId: string): LearningSummary {
  const childDir = getChildDir(childId);
  const topics = queryTopicsMeta(childDir);
  const progress = queryTopicProgress(childDir);

  const list: TopicSummary[] = topics.map((t) => {
    // 关联键：topics.file 相对 learning/（如 "lunyu/lunyu.md"）→ 目录名 = file 第一段
    const dirName = t.file.split("/")[0];
    const p = progress.find((x) => x.topic === dirName);
    const learned = p?.learned ?? 0;
    const total = p?.total ?? 0;
    const next = p?.next ?? "";
    const updated = p?.updated ?? "";
    const rules = t.rules || {};
    const dailyRaw = rules.daily;
    const daily = dailyRaw ? parseInt(dailyRaw, 10) : null;
    return {
      name: t.name,
      file: t.file,
      learned,
      total,
      percent: percent(learned, total),
      next,
      updated,
      daily: daily !== null && Number.isFinite(daily) ? daily : null,
      type: rules.type || "",
    };
  });

  const totalLearned = list.reduce((s, t) => s + t.learned, 0);
  const totalAll = list.reduce((s, t) => s + t.total, 0);
  const completedCount = list.filter((t) => t.total > 0 && t.learned >= t.total).length;

  return {
    topics: list,
    totals: {
      learned: totalLearned,
      total: totalAll,
      percent: percent(totalLearned, totalAll),
      topicCount: list.length,
      completedCount,
    },
  };
}

/**
 * 单个课程的教学资料（即「课程学习的总结内容」）。
 *
 * 资料文件命名与课程名**完全同名**（见各主题 method.md）：
 *   `learning/<topic>/materials/<课程名>.md`（源文件，含 frontmatter 知识要点/生活引导 + 教学正文）
 *   `learning/<topic>/materials/<课程名>.html`（给孩子看的预生成友好版，可能内嵌相对路径音频，iframe 中音频不保证可播放）
 * 优先返回 `.md`（自包含、可全文渲染），缺省回退 `.html`。
 *
 * @param topic 主题目录名（如 "lunyu"，即 topics.file 的第一段）
 * @param title 课程名（与 materials 下文件名完全同名）
 */
/**
 * 单课「学习情况的总结」：来自 daily_entries（block='学习'，数据库唯一真源），
 * 不是从 materials 文件读取。按标题章节课时键关联到对应 courses 行，
 * 返回该课的全部学习记录（含知识点 / 掌握度 / 错题 / 亮点等），按日期升序。
 */
export function getCourseDailySummary(
  childId: string,
  topicName: string,
  courseTitle: string
): CourseDailySummary[] {
  const childDir = getChildDir(childId);
  return queryCourseDailySummaries(childDir, topicName, courseTitle);
}

/**
 * 单个主题的进度明细（含每课 CourseItem 列表），供进度看板「主题 → 每课 → 当课汇总」钻取使用。
 * 数据来自 SQLite topic_progress 视图 + courses 表（与 getLearningSummary 同一真源）。
 *
 * @param topic 主题目录名（如 "lunyu"，即 topics.file 的第一段）
 */
export function getTopicProgress(childId: string, topic: string): TopicProgress | null {
  const childDir = getChildDir(childId);
  const list = queryTopicProgress(childDir, topic);
  return list[0] || null;
}

/**
 * 把学习进度摘要渲染为注入 LLM 上下文的紧凑文本。
 * **只含 frontmatter 级信息**（各主题 learned/total/next/updated + 总体进度），
 * **不含逐课正文**（论语等主题的正文可达几百行，纯属浪费上下文）。
 *
 * 用途：开孩子会话时把这串文本塞进系统提示，agent 无需为了确认「下一课」而去
 * read 整个进度文件（ISSUE-006）。配套还有一个 get_progress 工具，供 agent 在
 * 会话中途刷新进度时使用。
 */
export function progressSummaryToMarkdown(summary: LearningSummary): string {
  const lines: string[] = [];
  lines.push(
    `总体进度 ${summary.totals.learned}/${summary.totals.total}（${summary.totals.percent}%），` +
      `共 ${summary.totals.topicCount} 个主题，已完成 ${summary.totals.completedCount} 个。`
  );
  for (const t of summary.topics) {
    const next = t.next.trim()
      ? `下一课：「${t.next.trim()}」`
      : "（已全部学完或暂无下一课）";
    const type = t.type ? `（${t.type}）` : "";
    const key = t.file.split("/")[0];
    const daily = t.daily != null ? ` 每日目标 ${t.daily} 课` : "";
    lines.push(
      `- ${t.name}${type}（${key}）：已学 ${t.learned}/${t.total}（${t.percent}%），${next}${daily}`
    );
  }
  return lines.join("\n");
}
