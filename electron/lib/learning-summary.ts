import fs from "fs";
import path from "path";
import { getChildDir, getDataDir } from "./config";
import { dbQuery } from "./client-data";
import { chapterKey, getCourseLessonSync, type CourseDailySummary, type CourseLessonSync } from "./kb-sqlite";

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

/** 进度缓存带同步元信息（ISSUE-063）：meta.lastFetchOk=false 表示上次预取失败（离线降级），
 * 读取方应提示「数据可能非最新」，不得当作「真无进度」。 */
export interface ProgressCacheMeta {
  lastFetchOk: boolean;
  lastFetchAt: number;
}

interface ProgressCacheFile {
  topics?: TopicsRow[];
  progress?: ProgressRow[];
  ts?: number;
  meta?: ProgressCacheMeta;
}

/** 远程预取学习进度：成功返回 "ok"；失败（离线/未登录）保留旧缓存并返回 "network"（可区分真无 vs 拉取失败）。 */
export async function fetchProgressRemote(childId: string): Promise<"ok" | "network"> {
  try {
    const [topics, progress] = await Promise.all([
      dbQuery<TopicsRow[]>("kb.topics.list", { child_id: childId }),
      dbQuery<ProgressRow[]>("kb.progress.list", { child_id: childId }),
    ]);
    const data: ProgressCacheFile = {
      topics: topics ?? [],
      progress: progress ?? [],
      ts: Date.now(),
      meta: { lastFetchOk: true, lastFetchAt: Date.now() },
    };
    fs.mkdirSync(path.dirname(progressCachePath(childId)), { recursive: true });
    fs.writeFileSync(progressCachePath(childId), JSON.stringify(data), "utf-8");
    return "ok";
  } catch {
    /* 离线/未登录：保留旧缓存，但写入 lastFetchOk=false 供读取方识别陈旧 */
    try {
      const prev = readProgressCache(childId);
      prev.meta = { lastFetchOk: false, lastFetchAt: Date.now() };
      fs.mkdirSync(path.dirname(progressCachePath(childId)), { recursive: true });
      fs.writeFileSync(progressCachePath(childId), JSON.stringify(prev), "utf-8");
    } catch {
      /* 写失败不影响降级语义 */
    }
    return "network";
  }
}

function readProgressCache(childId: string): ProgressCacheFile {
  try {
    return JSON.parse(fs.readFileSync(progressCachePath(childId), "utf-8")) as ProgressCacheFile;
  } catch {
    return {};
  }
}

/** 读取进度缓存的同步元信息（供调用方判断数据是否离线降级/陈旧）；无缓存返回 null。 */
export function getProgressSyncMeta(childId: string): ProgressCacheMeta | null {
  const meta = readProgressCache(childId).meta;
  return meta ? { lastFetchOk: !!meta.lastFetchOk, lastFetchAt: Number(meta.lastFetchAt) || 0 } : null;
}

export function getLearningSummary(childId: string): LearningSummary {
  const cached = readProgressCache(childId);
  const topics = cached.topics ?? [];
  const progress = cached.progress ?? [];

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
// 把当天 Todolist 预取到本地缓存，buildChildPrompt 经 getTodayPlan(childId, today) 同步读缓存注入系统提示。
// 缓存缺失 / 当天无 Todolist 时 text 为空串，buildChildPrompt 据此「不注入任何段落」，保持 prompt 精简。
// ISSUE-063：getTodayPlan 带 date 校验 + 返回 fresh——离线时旧缓存可能是昨天内容，禁止把「昨天的计划/
// 拉取失败」当作「今天没安排」注入；由调用方据 fresh=false 显式提示 agent。
//
// 数据来源：kb.todo.list（服务端孩子 kb todo_items 表，一事一行，多设备共享），与 todo_list 工具 read
// 分支同一真源、同一「今天」口径（本地时区 YYYY-MM-DD）。序列化为纯文本注入（不再是 md checkbox）。

function todayPlanCachePath(childId: string): string {
  return path.join(getDataDir(), "cache", `today-plan-${childId}.json`);
}

interface TodayPlanCacheFile {
  itemsMd: string;
  date: string; // 缓存的「哪一天」的计划；读取方须校验是否仍是目标日期
  ts?: number;
  /** ISSUE-063：false = 上次预取失败（离线），itemsMd 可能为旧日期/空，读取方须提示非最新 */
  lastFetchOk?: boolean;
}

/** 会话创建前远程预取孩子当天 Todolist 到本地缓存（同步读链路的真源）。
 * 返回 "ok"（已拿到当天计划，可能为空）| "network"（离线/失败，缓存保留旧值或为空）。 */
export async function fetchTodayPlanRemote(childId: string, date: string): Promise<"ok" | "network"> {
  try {
    const rows = (await dbQuery<Array<Record<string, unknown>>>("kb.todo.list", {
      child_id: childId,
      date,
    })) ?? [];
    // 与 todo_list 工具 read 分支口径一致：无行即「今天还没有 todolist」。
    const text = rows.length ? todoRowsToText(rows) : "";
    const data: TodayPlanCacheFile = { itemsMd: text, date, ts: Date.now(), lastFetchOk: true };
    fs.mkdirSync(path.dirname(todayPlanCachePath(childId)), { recursive: true });
    fs.writeFileSync(todayPlanCachePath(childId), JSON.stringify(data), "utf-8");
    return "ok";
  } catch {
    /* 离线/未登录：保留旧缓存，仅标记本次拉取失败（读取方据此提示可能非最新） */
    try {
      const prev = readTodayPlanCache(childId);
      prev.lastFetchOk = false;
      prev.ts = Date.now();
      fs.mkdirSync(path.dirname(todayPlanCachePath(childId)), { recursive: true });
      fs.writeFileSync(todayPlanCachePath(childId), JSON.stringify(prev), "utf-8");
    } catch {
      /* 写失败不影响降级语义 */
    }
    return "network";
  }
}

function readTodayPlanCache(childId: string): TodayPlanCacheFile {
  try {
    return JSON.parse(fs.readFileSync(todayPlanCachePath(childId), "utf-8")) as TodayPlanCacheFile;
  } catch {
    return { itemsMd: "", date: "" };
  }
}

/** 同步读取某天学习计划（Todolist 文本）。
 * ISSUE-063：必须校验缓存 date 是否等于目标 date——离线时旧缓存可能是「昨天」的计划，
 * 直接返回会把昨天内容当成今天注入；date 不匹配一律视为无（并可通过 lastFetchOk=false 提示陈旧）。
 * @returns { text, fresh } fresh=false 表示读取到的是旧/降级数据（离线、非目标日期或从未同步过）。
 */
export function getTodayPlan(
  childId: string,
  date: string
): { text: string; fresh: boolean } {
  const cached = readTodayPlanCache(childId);
  const dateMatch = cached.date === date;
  const ok = cached.lastFetchOk !== false;
  return { text: dateMatch ? cached.itemsMd ?? "" : "", fresh: dateMatch && ok };
}

/** 仅取当天计划文本（旧调用形态；日期不匹配返回空串）。 */
export function getTodayPlanText(childId: string, date: string): string {
  return getTodayPlan(childId, date).text;
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

// ==================== 课程教学内容远程预取（ISSUE-029 任务2：英语课子会话注入用） ====================
// 与 fetchTodayPlanRemote 同一「会话前远程预取 → 本地缓存 → 同步读」模式：
// SPLIT 架构下孩子 kb 真源在服务端（本地 kb.sqlite 的 topics/courses 可能为空壳），
// 课程教学方法/文案必须经服务端 RPC 取。离线/失败保留旧缓存，降级不阻断会话创建。
//
// ISSUE-063：fetchCourseLessonRemote 不再静默吞错——返回状态供 createChildSession 区分
// 「真无此课（not-found，可能课程名错，应列课程核对）」vs「拉取失败（network，可能离线/服务端不可达，
// 教法缺失或为旧缓存，须显式告知 agent，禁止当作『真无教法』静默开讲）」；缓存带 cachedAt 供判断新旧。

export interface CourseLessonCache {
  topic: string;
  title: string;
  lessonMethod: string; // 教学方法（服务端已做课程级→主题级 fallback）
  teachingCopy: string; // 教学文案全文
  htmlPath: string; // 学习资料 html 地址
  material: string;
  sendMaterial: string;
  /** 本地缓存写入时间（ms）；「是否最新」的判断依据之一（ISSUE-063）。 */
  cachedAt?: number;
}

/** 课程教法远程预取结果（ISSUE-063）：
 * "ok" = 服务端可达且课程存在，缓存已刷新；"not-found" = 服务端可达但该课程不存在（可能课名错）；
 * "network" = 服务端不可达/超时/未登录（教法可能缺失或旧缓存，须告知 agent 降级）。 */
export type CourseLessonFetchStatus = "ok" | "not-found" | "network";

interface CourseLessonCacheFile {
  lessons: Record<string, CourseLessonCache>;
  /** 最近一次拉取状态（ISSUE-063：区分「正常同步」vs「离线降级」，供读取方判断陈旧） */
  meta?: { lastFetchOk: boolean; lastFetchAt: number };
}

function courseLessonCachePath(childId: string): string {
  return path.join(getDataDir(), "cache", `course-lesson-${childId}.json`);
}

function loadCourseLessonCacheFile(childId: string): CourseLessonCacheFile {
  try {
    return JSON.parse(fs.readFileSync(courseLessonCachePath(childId), "utf-8")) as CourseLessonCacheFile;
  } catch {
    return { lessons: {} };
  }
}

function loadCourseLessonCache(childId: string): Record<string, CourseLessonCache> {
  return loadCourseLessonCacheFile(childId).lessons ?? {};
}

/** 会话创建前远程预取某课教学内容（kb.courses.get）→ 写本地缓存（按 topic:title 多课共存）。
 * 服务端已把课程级 lesson_method 为空时回退主题级 topics.method。
 * @returns 拉取状态（见 CourseLessonFetchStatus）；课程行存在但内容全空也算 "ok"（课在，只是没写教法）。 */
export async function fetchCourseLessonRemote(
  childId: string,
  topic: string,
  title: string
): Promise<CourseLessonFetchStatus> {
  try {
    const row = await dbQuery<Record<string, unknown> | null>("kb.courses.get", {
      child_id: childId,
      topic,
      title,
    });
    if (!row) return "not-found"; // 服务端明确无此课 → 真「无」（可能是课程名错）
    const cache = loadCourseLessonCache(childId);
    cache[`${topic}:${title}`] = {
      topic: String(row.topic ?? topic),
      title: String(row.title ?? title),
      lessonMethod: String(row.lesson_method ?? ""),
      teachingCopy: String(row.teaching_copy ?? ""),
      htmlPath: String(row.html_path ?? ""),
      material: String(row.material ?? ""),
      sendMaterial: String(row.send_material ?? ""),
      cachedAt: Date.now(),
    };
    const file = loadCourseLessonCacheFile(childId);
    file.lessons = cache;
    file.meta = { lastFetchOk: true, lastFetchAt: Date.now() };
    const p = courseLessonCachePath(childId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(file, null, 2), "utf-8");
    return "ok";
  } catch {
    /* 离线/未登录：保留旧缓存，但标记 lastFetchOk=false（读取方据此识别陈旧/降级） */
    try {
      const file = loadCourseLessonCacheFile(childId);
      file.meta = { lastFetchOk: false, lastFetchAt: Date.now() };
      const p = courseLessonCachePath(childId);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(file, null, 2), "utf-8");
    } catch {
      /* 写失败不影响降级语义 */
    }
    return "network";
  }
}

/** 同步读取某课教学内容（远程预取缓存；miss 时回退本地孩子库直读——离线快照兜底）。 */
export function getCourseLessonCached(childId: string, topic: string, title: string): CourseLessonCache | null {
  const hit = loadCourseLessonCache(childId)[`${topic}:${title}`];
  if (hit) return hit;
  return getCourseLessonSync(getChildDir(childId), topic, title);
}

/** 该孩子课程缓存最近一次拉取是否成功（ISSUE-063）：false = 上次离线降级，缓存内容可能非最新。 */
export function isCourseLessonCacheStale(childId: string): boolean {
  const meta = loadCourseLessonCacheFile(childId).meta;
  return meta ? meta.lastFetchOk === false : false;
}

