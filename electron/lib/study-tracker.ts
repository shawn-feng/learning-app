// study-tracker 定时任务：纯代码实现（不再作为技能、不调用 AI）。
// 数据全部从孩子 kb.sqlite 读取（唯一真源）：
//   - topics 表：主题清单 + rules_json（每日目标 daily / 必学选学 type，rules.md 只是归档）
//   - topic_progress 视图：learned/total/next/updated 实时计算
//   - courses 表：每课 first_learned（今日新增 = first_learned == 今天的课数）
// 评估结果写入 learning/tracker-latest.md（快照），并返回结构化结果供调度层广播。

import fs from "fs";
import path from "path";
import { queryTopicsMeta, queryTopicProgress } from "./kb-sqlite";

/** 单个主题的当日评估结果。 */
export interface TopicDailyResult {
  /** 主题中文名（topics.name，如「论语」） */
  name: string;
  /** 主题目录名（topics.file 第一段，如 lunyu；与 courses.topic 一致） */
  dir: string;
  /** 是否必学（rules_json.type === "必学"） */
  required: boolean;
  /** 每日目标课数（rules_json.daily，非必学或缺失为 0） */
  daily: number;
  /** 今日新增（first_learned == 今天的课数） */
  todayLearned: number;
  /** 已学课程数（累计，视图计算） */
  learned: number;
  /** 总课程数 */
  total: number;
  /** 下一课（第一个未学课程） */
  next: string;
  /** 最近活动日期（last_review / first_learned 的最大值） */
  updated: string;
  /** 必学主题：todayLearned >= daily；选学主题恒 false（不判定） */
  done: boolean;
}

/** 当日学习评估完整结果。 */
export interface StudyTrackerResult {
  /** 本地时区 YYYY-MM-DD */
  date: string;
  /** 各主题评估（含无课程记录的主题） */
  topics: TopicDailyResult[];
  /** 达标的必学主题数 */
  passCount: number;
  /** 必学主题总数（有 daily 目标的） */
  requiredCount: number;
  /** 完成度 0~1：sum(min(todayLearned, daily)) / sum(daily)，仅统计必学主题；无必学主题时为 0 */
  doneRatio: number;
  /** 生成的 markdown 评估报告（已写入 tracker-latest.md） */
  markdown: string;
}

/** 本地时区 YYYY-MM-DD（不用 toISOString：那是 UTC 日期，东八区晚上会跨到错误的「今天」）。 */
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 运行当日学习达标评估（纯代码，从 kb.sqlite 取数判断）。
 *
 * @param childDir 孩子数据目录（data/children/<id>）
 * @param today 可选，指定评估日期（默认本地今天）；测试可注入
 */
export function runStudyTracker(childDir: string, today?: string): StudyTrackerResult {
  const date = today ?? formatLocalDate(new Date());

  const topics = queryTopicsMeta(childDir);
  const progress = queryTopicProgress(childDir);
  const progressByDir = new Map(progress.map((p) => [p.topic, p]));

  const results: TopicDailyResult[] = [];
  let requiredCount = 0;
  let passCount = 0;
  let doneSum = 0;
  let dailySum = 0;

  for (const t of topics) {
    // topics.file 形如 "lunyu/lunyu.md"；courses.topic 是纯目录名
    const dir = t.file.split("/")[0] || t.file;
    const rules = t.rules || {};
    const daily = Number(rules.daily) > 0 ? Number(rules.daily) : 0;
    const required = String(rules.type ?? "") === "必学";

    const prog = progressByDir.get(dir);
    const items = prog?.items ?? [];
    const todayLearned = items.filter(
      (c) => c.firstLearned === date && c.status === "✅"
    ).length;
    const learned = prog?.learned ?? 0;
    const total = prog?.total ?? 0;
    const next = prog?.next ?? "";
    const updated = prog?.updated ?? "";

    const done = required && daily > 0 && todayLearned >= daily;
    if (required && daily > 0) {
      requiredCount++;
      if (done) passCount++;
      doneSum += Math.min(todayLearned, daily);
      dailySum += daily;
    }

    results.push({
      name: t.name,
      dir,
      required,
      daily,
      todayLearned,
      learned,
      total,
      next,
      updated,
      done,
    });
  }

  const doneRatio = dailySum > 0 ? doneSum / dailySum : 0;
  const markdown = buildMarkdown(date, results, passCount, requiredCount, doneRatio);
  writeTrackerFile(childDir, markdown);

  return { date, topics: results, passCount, requiredCount, doneRatio, markdown };
}

function buildMarkdown(
  date: string,
  results: TopicDailyResult[],
  passCount: number,
  requiredCount: number,
  doneRatio: number
): string {
  const lines: string[] = [];
  lines.push(`## ${date} 学习评估`);
  lines.push("");

  const required = results.filter((r) => r.required && r.daily > 0);
  if (required.length > 0) {
    lines.push("### 必学内容");
    for (const r of required) {
      if (r.done) {
        lines.push(`- ✅ ${r.name}：今日 ${r.todayLearned}/${r.daily} 课`);
      } else {
        const miss = r.daily - r.todayLearned;
        lines.push(`- ⬜ ${r.name}：今日 ${r.todayLearned}/${r.daily} 课，还差 ${miss} 课`);
      }
    }
  }

  const learnedToday = results.filter((r) => r.todayLearned > 0);
  const optionalToday = learnedToday.filter((r) => !r.required || r.daily <= 0);
  if (optionalToday.length > 0) {
    lines.push("");
    lines.push("### 选学内容");
    for (const r of optionalToday) {
      lines.push(`- 📚 ${r.name}：今日学了 ${r.todayLearned} 课`);
    }
  }

  lines.push("");
  lines.push("### 总结");
  if (requiredCount === 0) {
    lines.push("今日无必学主题，无达标要求。");
  } else {
    const pct = Math.round(doneRatio * 100);
    lines.push(`今日完成度：${passCount}/${requiredCount} 个必学主题达标（${pct}%）`);
    const miss = required.filter((r) => !r.done);
    if (miss.length > 0) {
      lines.push(`建议：明日优先补上 ${miss.map((r) => r.name).join("、")} 的剩余课程`);
    } else {
      lines.push("全部达标，保持节奏！");
    }
  }
  return lines.join("\n");
}

/** 写入 learning/tracker-latest.md（latest 快照，覆盖式）。 */
function writeTrackerFile(childDir: string, markdown: string): void {
  const learningDir = path.join(childDir, "learning");
  if (!fs.existsSync(learningDir)) fs.mkdirSync(learningDir, { recursive: true });
  fs.writeFileSync(path.join(learningDir, "tracker-latest.md"), markdown + "\n", "utf-8");
}
