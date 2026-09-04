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
  type: string; // 主题类型：必学 / 选学 / 复习（考核选题标注；rules_json.daily 每日目标已停用 ISSUE-033）
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

/** 单课明细行（kb.courses.list 返回，snake_case 对齐 server courses 表）。 */
interface CourseRow {
  topic: string;
  title: string;
  sort_order: number;
  status: string;
  mastery: string;
  first_learned: string;
  last_review: string;
  review_count: number;
  material: string;
  send_material: string;
  tags: string;
  lesson_method: string;
  html_path: string;
  teaching_copy: string;
}

/** 每课进度条目（进度看板「主题 → 每课」列表项，与 LearningDashboard CourseItem 一致）。 */
export interface CourseItem {
  topic: string;
  title: string;
  sortOrder: number;
  status: string;
  mastery: string;
  firstLearned: string;
  lastReview: string;
  reviewCount: number;
  material: string;
  sendMaterial: string;
  tags: string;
}

/** 单主题进度明细（learning:topic 返回，含每课 items；进度看板三级下钻数据源）。 */
export interface TopicDetail {
  topic: string;
  learned: number;
  total: number;
  next: string;
  updated: string;
  items: CourseItem[];
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
    return {
      name: t.name,
      topicKey: t.topic_key,
      learned,
      total,
      percent: percent(learned, total),
      next,
      updated,
      // rules_json.daily（每日目标）已停用（ISSUE-033：学习计划 study_plans 是唯一每日安排源）
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
 * - 聚合行来自服务端 topic_progress 视图（kb.progress.list，与 getLearningSummary 同一真源）；
 * - 每课 items 来自服务端 courses 表（kb.courses.list，按 topic 过滤）——ISSUE-006：
 *   原实现只返回视图行（无 items），LearningDashboard 期望 TopicDetail.items，导致
 *   孩子模式点主题后 `d.items` undefined、课程明细不显示。
 */
export async function getTopicProgress(childId: string, topic: string): Promise<TopicDetail | null> {
  const [progress, courses] = await Promise.all([
    dbQuery<ProgressRow[]>("kb.progress.list", { child_id: childId }),
    dbQuery<CourseRow[]>("kb.courses.list", { child_id: childId, topic }),
  ]);
  const p = (progress ?? []).find((x) => x.topic === topic);
  if (!p) return null;
  return {
    topic: p.topic,
    learned: Number(p.learned) || 0,
    total: Number(p.total) || 0,
    next: p.next ?? "",
    updated: p.updated ?? "",
    items: (courses ?? []).map((c) => ({
      topic: c.topic,
      title: c.title,
      sortOrder: c.sort_order,
      status: c.status,
      mastery: c.mastery,
      firstLearned: c.first_learned,
      lastReview: c.last_review,
      reviewCount: c.review_count,
      material: c.material,
      sendMaterial: c.send_material,
      tags: c.tags,
    })),
  };
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
    lines.push(
      `- ${t.name}${type}（${key}）：已学 ${t.learned}/${t.total}（${t.percent}%），${next}`
    );
  }
  return lines.join("\n");
}

// ==================== ISSUE-045：当天学习计划（Todolist）注入 ====================
//
// 与进度概览同一「会话前远程预取 → 本地缓存 → 同步读」模式（systemPromptOverride 是同步链，
// 没法在回调里 await）：createChildSession 在创建会话前调用 fetchTodayPlanRemote(childId, date)
// 把当天 Todolist 预取到本地缓存，buildChildPrompt 经 getTodayPlan(childId) 同步读缓存注入系统提示。
// 缓存缺失 / 当天无 Todolist 时返回空串，buildChildPrompt 据此「不注入任何段落」，保持 prompt 精简。
//
// 数据来源：kb.todo.list（服务端孩子 kb todo_items 表，一事一行，多设备共享），与 todo_list 工具 read
// 分支同一真源、同一「今天」口径（本地时区 YYYY-MM-DD）。序列化为纯文本注入（不再是 md checkbox）。

function todayPlanCachePath(childId: string): string {
  return path.join(getDataDir(), "cache", `today-plan-${childId}.json`);
}

/** 把 todo_items 行渲染成可读文本（家长项带来源前缀，孩子项标注）。 */
function todoRowsToText(rows: Array<Record<string, unknown>>): string {
  const lines = rows.map((r) => {
    const src = r.source === "parent" ? "[家长安排] " : "[自规划] ";
    const st = r.status === "done" ? "✅ " : "⬜ ";
    const note = r.note ? `（${r.note}）` : "";
    return `- ${st}${src}${r.title}${note}`;
  });
  return lines.join("\n");
}

/** 会话创建前远程预取孩子当天 Todolist 到本地缓存（同步读链路的真源）。 */
export async function fetchTodayPlanRemote(childId: string, date: string): Promise<void> {
  try {
    const rows = (await dbQuery<Array<Record<string, unknown>>>("kb.todo.list", {
      child_id: childId,
      date,
    })) ?? [];
    // 与 todo_list 工具 read 分支口径一致：无行即「今天还没有 todolist」。
    const text = rows.length ? todoRowsToText(rows) : "";
    fs.mkdirSync(path.dirname(todayPlanCachePath(childId)), { recursive: true });
    fs.writeFileSync(todayPlanCachePath(childId), JSON.stringify({ itemsMd: text, date, ts: Date.now() }), "utf-8");
  } catch {
    /* 离线/未登录：保留旧缓存或留空，getTodayPlan 降级为不注入 */
  }
}

/** 同步读取当天学习计划（Todolist 文本）；无缓存 / 当天无 Todolist 返回空串（不注入）。 */
export function getTodayPlan(childId: string): string {
  try {
    const cached = JSON.parse(fs.readFileSync(todayPlanCachePath(childId), "utf-8")) as {
      itemsMd: string;
    };
    return cached.itemsMd ?? "";
  } catch {
    /* 无缓存：返回空 */
    return "";
  }
}
