/**
 * 考核内容结构化 v2：按「孩子方法(method_spec)」从结构化课程里抽题组题（服务端读取侧）。
 * 设计依据：DESIGN-course-assess-structured-2026-09-09.md §8.2 取题。
 *
 * 规则：
 * - 该课无关系行 → 非结构化（不产出 questions，调用方走旧整文 rubric 路径）；
 * - exclude 过滤；require 非空时只考 require 命中的类别，为空(default)时考该课实际挂的全部类别；
 * - 每类别池内随机抽 ≤require 道（缺题→跳过该类别，不 LLM 临时命题）；
 * - speech 行为类别置该课最前；speech 题 answer=refText、questionType=cn_recitation（答题端不显示原文）。
 * - qid 跨课连续（rqN=背诵/朗读，qN=文字题），避免与答题/判分按 qid 配对冲突。
 */
import type { DatabaseSync } from "node:sqlite";
import { listCourseContent, getCourseUuid, getMethodSpec } from "./db/assess-content.js";

export interface CourseLike {
  topic: string;
  title: string;
  [k: string]: unknown;
}

/** 把结构化课程列表里每门课的选中题目挂到 course.questions（非结构化课程不加该字段）。 */
export function attachStructuredQuestions(db: DatabaseSync, childId: string, courses: CourseLike[]): void {
  let textNo = 0;
  let recNo = 0;
  for (const course of courses) {
    const uuid = getCourseUuid(db, course.topic, course.title);
    if (!uuid) continue;
    const content = listCourseContent(db, uuid);
    if (!content.items.length) continue; // 非结构化：走旧整文路径

    const spec = (getMethodSpec(db, course.topic) as any) ?? {};
    const childSpec = spec?.perChild?.[childId] ?? spec?.default ?? {};
    const requireMap: Record<string, number> = childSpec?.require ?? {};
    const requireKeys = Object.keys(requireMap);
    const exclude = new Set<string>(childSpec?.exclude ?? []);

    const picked: Array<{
      behavior: string;
      categoryId: string;
      categoryName: string;
      overview: string;
      item: { id: string; stem: string; answer: string; scoring: string | null; pointMax: number };
    }> = [];
    for (const item of content.items) {
      if (exclude.has(item.categoryId)) continue;
      // 命中判定：require 非空 → 只取 require 里的；require 空(default) → 该课全部类别
      if (requireKeys.length && !(item.categoryId in requireMap)) continue;
      const want = requireKeys.length ? Math.max(1, requireMap[item.categoryId] ?? 1) : 1;
      if (!item.questions.length) continue; // 缺题跳过该类别
      const pool = [...item.questions].sort((a, b) => a.seq - b.seq);
      for (let k = 0; k < Math.min(want, pool.length); k++) {
        // 随机抽 1（多题池）：洗牌取前 want
        const j = k + Math.floor(Math.random() * (pool.length - k));
        const qi = pool[k];
        pool[k] = pool[j]!;
        pool[j] = qi!;
        picked.push({
          behavior: pool[k]!.behavior || item.behavior || "generic", // 题级行为为准（同类别可混口述/背诵）
          categoryId: item.categoryId,
          categoryName: item.categoryName,
          overview: item.overview,
          item: pool[k]!,
        });
      }
    }
    if (!picked.length) {
      course.questions = [];
      continue;
    }
    // 题序：speech 行为置最前，其余保持类别挂载顺序
    picked.sort(
      (a, b) => Number(b.behavior.startsWith("speech")) - Number(a.behavior.startsWith("speech"))
    );
    course.questions = picked.map((p) => {
      const base = {
        course: course.title,
        stem: p.item.stem,
        pointMax: p.item.pointMax || 10,
        questionId: p.item.id, // 题库题目 uuid（落库溯源/轮换排除）
        categoryId: p.categoryId, // 类别 uuid
      };
      if (p.behavior.startsWith("speech")) {
        return {
          ...base,
          qid: `rq${++recNo}`,
          assessMethod: "speech" as const,
          questionType: "cn_recitation",
          refText: p.item.answer, // 标准原文 = 题库 answer
        };
      }
      return { ...base, qid: `q${++textNo}`, scoringText: serializeScoring(p.item) };
    });
  }
}

/** 把题库的答案/评分维度/特殊情况压成判分可读文本（不下发渲染 UI 作展示，判分锚定用）。 */
function serializeScoring(q: { answer: string; scoring: string | null }): string {
  const parts: string[] = [];
  if (q.answer) parts.push(`参考答案：${q.answer}`);
  if (q.scoring) {
    try {
      const s = JSON.parse(q.scoring) as { dims?: Array<{ dim?: string; points?: string; score?: number; note?: string }>; special?: string[] };
      if (Array.isArray(s.dims) && s.dims.length) {
        parts.push("评分维度：");
        for (const d of s.dims) {
          parts.push(`- ${d.dim ?? ""}（${d.score ?? "?"}分）：${d.points ?? ""}${d.note ? `（${d.note}）` : ""}`);
        }
      }
      if (Array.isArray(s.special) && s.special.length) parts.push(`特殊情况处理：${s.special.join("；")}`);
    } catch {
      parts.push(`评分标准原文：${q.scoring}`);
    }
  }
  return parts.join("\n");
}
