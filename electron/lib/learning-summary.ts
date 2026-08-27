import fs from "fs";
import path from "path";
import { getChildDir, getDataDir } from "./config";
import { dbQuery } from "./client-data";
import { chapterKey, type CourseDailySummary } from "./kb-sqlite";

/**
 * 学习进度汇总（SPLIT 收尾：数据唯一真源在服务端 kb 库）。
 *
 * 数据来源（服务端 RPC）：
 *   - kb.topics.list：主题清单（name/topic_key/method/progress/rules_json）
 *   - kb.progress.list：topic_progress 视图（各主题 learned/total/next/updated）
 *
 * 会话构建是**同步链**（systemPromptOverride 不支持 Promise），故进度概览采用
 * 「会话创建前远程预取（fetchProgressRemote）→ 本地缓存 → getLearningSummary 同步读缓存」，
 * 与 AGENTS 预取（fetchAgentPromptRemote）同一模式；缓存缺失返回空（降级为无进度上下文）。
 */

export interface TopicSummary {
  name: string; // 主题名
  topicKey: string; // 拼音主题键（= courses.topic = 目录名）
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

interface TopicsRow {
  name: string;
  topic_key: string;
  method: string;
  progress: string;
  rules_json: string;
}
interface ProgressRow {
  topic: string;
  total: number;
  learned: number;
  next: string;
  updated: string;
}

function progressCachePath(childId: string): string {
  return path.join(getDataDir(), "cache", `progress-${childId}.json`);
}

/** 会话创建前远程预取学习进度到本地缓存（同步读链路的真源）。 */
export async function fetchProgressRemote(childId: string): Promise<void> {
  try {
    const [topics, progress] = await Promise.all([
      dbQuery<TopicsRow[]>("kb.topics.list", { child_id: childId }),
      dbQuery<ProgressRow[]>("kb.progress.list", { child_id: childId }),
    ]);
    fs.mkdirSync(path.dirname(progressCachePath(childId)), { recursive: true });
    fs.writeFileSync(
      progressCachePath(childId),
      JSON.stringify({ topics: topics ?? [], progress: progress ?? [], ts: Date.now() }),
      "utf-8"
    );
  } catch {
    /* 离线/未登录：保留旧缓存或留空，getLearningSummary 降级 */
  }
}

export function getLearningSummary(childId: string): LearningSummary {
  let topics: TopicsRow[] = [];
  let progress: ProgressRow[] = [];
  try {
    const cached = JSON.parse(fs.readFileSync(progressCachePath(childId), "utf-8")) as {
      topics: TopicsRow[];
      progress: ProgressRow[];
    };
    topics = cached.topics ?? [];
    progress = cached.progress ?? [];
  } catch {
    /* 无缓存：返回空 */
  }

  const list: TopicSummary[] = topics.map((t) => {
    // 关联键：topics.topic_key 即拼音目录名（如 "lunyu"），直接等于 courses.topic
    const dirName = t.topic_key;
    const p = progress.find((x) => x.topic === dirName);
    const learned = Number(p?.learned) || 0;
    const total = Number(p?.total) || 0;
    const next = p?.next ?? "";
    const updated = p?.updated ?? "";
    let rules: Record<string, string> = {};
    try {
      rules = JSON.parse(t.rules_json || "{}");
    } catch {
      rules = {};
    }
    const dailyRaw = rules.daily;
    const daily = dailyRaw ? parseInt(String(dailyRaw), 10) : null;
    return {
      name: t.name,
      topicKey: t.topic_key,
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
 * 单课「学习情况的总结」：来自服务端 daily_entries（block='学习'，数据库唯一真源）。
 * 按标题章节课时键（chapterKey）关联到对应课程，返回该课全部学习记录，按日期升序。
 */
export async function getCourseDailySummary(
  childId: string,
  topicName: string,
  courseTitle: string
): Promise<CourseDailySummary[]> {
  const rows = await dbQuery<Array<{ date: string; title: string; raw: string; tags: string }>>(
    "kb.daily_entries.query",
    { child_id: childId, block: "学习" }
  );
  const courseKey = chapterKey(courseTitle, topicName);
  return (rows ?? [])
    .filter((r) => chapterKey(r.title, topicName) === courseKey)
    .map((r) => ({ date: r.date, title: r.title, raw: r.raw, tags: r.tags }));
}

/**
 * 单个主题的进度明细（供进度看板「主题 → 每课 → 当课汇总」钻取使用）。
 * 数据来自服务端 topic_progress 视图（与 getLearningSummary 同一真源）。
 */
export async function getTopicProgress(childId: string, topic: string): Promise<ProgressRow | null> {
  const list = await dbQuery<ProgressRow[]>("kb.progress.list", { child_id: childId });
  return (list ?? []).find((x) => x.topic === topic) || null;
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
    const key = t.topicKey;
    const daily = t.daily != null ? ` 每日目标 ${t.daily} 课` : "";
    lines.push(
      `- ${t.name}${type}（${key}）：已学 ${t.learned}/${t.total}（${t.percent}%），${next}${daily}`
    );
  }
  return lines.join("\n");
}
