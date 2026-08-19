import fs from "fs";
import path from "path";
import { getChildDir } from "./config";

/**
 * 学习进度汇总
 *
 * 数据来源（childDir 下）：
 *   - learning/topics.md         —— 主题清单（frontmatter.topics 数组，含 name/file/method/progress）
 *   - learning/{topic}/{topic}.md —— 各主题进度文件（frontmatter: learned/total/next/updated）
 *   - learning/rules.md          —— 学习规则（frontmatter.rules 映射，含 daily/type）
 *
 * 汇总原则：
 *   - 以 topics.md 的 topics 数组为「主题清单」；
 *   - 每个主题的 learned/total 以进度文件 frontmatter 为准（agent 直接更新它，最新）；
 *     topics.md 里的 progress 字符串（"277/514"）仅作为文件缺失/解析失败时的兜底。
 *   - daily/type 来自 rules.md。
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

/** 提取文件开头的 YAML frontmatter（两段 --- 之间），无则返回 null */
function extractFrontmatter(text: string): string | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

/** 解析 flow map 字符串，如 `name: 论语, file: lunyu/lunyu.md, progress: 277/514` */
function parseFlowMap(inner: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*:\s*("([^"]*)"|([^,}]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const val = m[3] !== undefined ? m[3] : m[4];
    out[m[1]] = val.trim();
  }
  return out;
}

/** 解析 topics.md 的 topics 数组，返回 [{name, file, progress}] */
function parseTopics(frontmatter: string): Array<{ name: string; file: string; progress: string }> {
  const result: Array<{ name: string; file: string; progress: string }> = [];
  const re = /-\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(frontmatter)) !== null) {
    const kv = parseFlowMap(m[1]);
    if (kv.name && kv.file) {
      result.push({ name: kv.name, file: kv.file, progress: kv.progress || "" });
    }
  }
  return result;
}

/** 解析 rules.md 的 rules 映射，返回 { 主题名: {daily, type, ...} } */
function parseRules(frontmatter: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const block = frontmatter.match(/rules:\s*\n([\s\S]*?)(?=\n\S|$)/);
  if (!block) return out;
  const re = /^\s*([^\s:{]+)\s*:\s*\{([^}]*)\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1])) !== null) {
    out[m[1]] = parseFlowMap(m[2]);
  }
  return out;
}

/** 解析单个进度文件的 frontmatter，返回 {learned, total, next, updated} */
function parseProgress(frontmatter: string): { learned: number; total: number; next: string; updated: string } {
  const kv: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (m) kv[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
  const learned = parseInt(kv.learned, 10);
  const total = parseInt(kv.total, 10);
  return {
    learned: Number.isFinite(learned) ? learned : 0,
    total: Number.isFinite(total) ? total : 0,
    next: kv.next || "",
    updated: kv.updated || "",
  };
}

function percent(learned: number, total: number): number {
  if (!total) return 0;
  return Math.round((learned / total) * 1000) / 10;
}

export function getLearningSummary(childId: string): LearningSummary {
  const childDir = getChildDir(childId);
  const topicsPath = path.join(childDir, "learning", "topics.md");
  const rulesPath = path.join(childDir, "learning", "rules.md");

  let rules: Record<string, Record<string, string>> = {};
  if (fs.existsSync(rulesPath)) {
    const fm = extractFrontmatter(fs.readFileSync(rulesPath, "utf-8"));
    if (fm) rules = parseRules(fm);
  }

  const topics: TopicSummary[] = [];

  if (fs.existsSync(topicsPath)) {
    const fm = extractFrontmatter(fs.readFileSync(topicsPath, "utf-8"));
    if (fm) {
      for (const t of parseTopics(fm)) {
        // 权威进度：进度文件 frontmatter；兜底：topics.md 的 progress 字符串
        // 注意：topics.md 里 file 相对 learning/ 目录（如 "lunyu/lunyu.md"）
        let learned = 0;
        let total = 0;
        let next = "";
        let updated = "";
        const fileAbs = path.join(childDir, "learning", t.file);
        if (fs.existsSync(fileAbs)) {
          const pfm = extractFrontmatter(fs.readFileSync(fileAbs, "utf-8"));
          if (pfm) {
            const p = parseProgress(pfm);
            learned = p.learned;
            total = p.total;
            next = p.next;
            updated = p.updated;
          }
        }
        if (!total) {
          const m = t.progress.match(/(\d+)\s*\/\s*(\d+)/);
          if (m) {
            learned = learned || parseInt(m[1], 10);
            total = parseInt(m[2], 10);
          }
        }

        const r = rules[t.name] || {};
        const daily = r.daily ? parseInt(r.daily, 10) : null;

        topics.push({
          name: t.name,
          file: t.file,
          learned,
          total,
          percent: percent(learned, total),
          next,
          updated,
          daily: daily !== null && Number.isFinite(daily) ? daily : null,
          type: r.type || "",
        });
      }
    }
  }

  const totalLearned = topics.reduce((s, t) => s + t.learned, 0);
  const totalAll = topics.reduce((s, t) => s + t.total, 0);
  const completedCount = topics.filter((t) => t.total > 0 && t.learned >= t.total).length;

  return {
    topics,
    totals: {
      learned: totalLearned,
      total: totalAll,
      percent: percent(totalLearned, totalAll),
      topicCount: topics.length,
      completedCount,
    },
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
    const daily = t.daily != null ? ` 每日目标 ${t.daily} 课` : "";
    lines.push(
      `- ${t.name}${type}：已学 ${t.learned}/${t.total}（${t.percent}%），${next}${daily}`
    );
  }
  return lines.join("\n");
}
