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
import { listCourseContent, getCourseUuid, getMethodSpec, listCategories } from "./db/assess-content.js";

export interface CourseLike {
  topic: string;
  title: string;
  [k: string]: unknown;
}

/**
 * 排期级考核方法覆盖（2026-09-10）：自定义考核可单独指定"这次考哪些类别"，
 * 覆盖主题级 method_spec。类别可用**类别名**（如 "背诵"）或类别 uuid；解析不到的名称忽略。
 * 例：{ require: { 背诵: 1 }, exclude: ["字词"], recitePass: 90 } → 本次只考背诵。
 */
export interface MethodOverride {
  require?: Record<string, number>;
  exclude?: string[];
  recitePass?: number;
}

/** 把排期级覆盖解析成 uuid（按该课程所属主题的类别表）；require 全解析失败 → 视为未覆盖（回退主题方法）。 */
function resolveOverride(
  db: DatabaseSync,
  topicId: string,
  ov?: MethodOverride | null
): { used: boolean; requireMap: Record<string, number>; exclude: Set<string>; recitePass?: number } {
  const out = { used: false, requireMap: {} as Record<string, number>, exclude: new Set<string>(), recitePass: undefined as number | undefined };
  if (!ov || (!ov.require && !ov.exclude && ov.recitePass == null)) return out;
  let cats: Array<{ id: string; name: string }> = [];
  try {
    cats = listCategories(db, topicId);
  } catch {
    cats = [];
  }
  const byId = new Map(cats.map((c) => [c.id, c]));
  const byName = new Map(cats.map((c) => [String(c.name).trim(), c]));
  const find = (k: string) => byId.get(k) ?? byName.get(String(k).trim());

  let anyReq = false;
  for (const [k, v] of Object.entries(ov.require ?? {})) {
    const c = find(k);
    if (!c) continue;
    out.requireMap[c.id] = Math.max(1, Number(v) || 1);
    anyReq = true;
  }
  let anyExc = false;
  for (const k of ov.exclude ?? []) {
    const c = find(k);
    if (!c) continue;
    out.exclude.add(c.id);
    anyExc = true;
  }
  if (ov.recitePass != null) out.recitePass = Math.max(0, Number(ov.recitePass) || 90);
  out.used = anyReq || anyExc; // require/exclude 全解析失败 → 不覆盖
  return out;
}

/** 把结构化课程列表里每门课的选中题目挂到 course.questions（非结构化课程不加该字段）。
 *  override：排期级考核方法（自定义考核"本次只考 X"），优先于主题 method_spec。 */
export function attachStructuredQuestions(
  db: DatabaseSync,
  childId: string,
  courses: CourseLike[],
  override?: MethodOverride | null
): void {
  let textNo = 0;
  let recNo = 0;
  for (const course of courses) {
    const uuid = getCourseUuid(db, course.topic, course.title);
    if (!uuid) continue;
    const content = listCourseContent(db, uuid);
    if (!content.items.length) continue; // 非结构化：走旧整文路径

    const spec = (getMethodSpec(db, course.topic) as any) ?? {};
    const childSpec = spec?.perChild?.[childId] ?? spec?.default ?? {};
    let requireMap: Record<string, number> = childSpec?.require ?? {};
    let requireKeys = Object.keys(requireMap);
    let exclude = new Set<string>(childSpec?.exclude ?? []);
    let recitePass = Math.max(0, Number(childSpec?.rules?.recitePass) || 90);
    // 排期级覆盖（自定义考核"本次只考背诵"等）：优先于主题方法
    const ovr = resolveOverride(db, course.topic, override);
    if (ovr.used) {
      requireMap = ovr.requireMap;
      requireKeys = Object.keys(requireMap);
      exclude = ovr.exclude;
    }
    if (ovr.recitePass != null) recitePass = ovr.recitePass;

    const picked: Array<{
      behavior: string;
      categoryId: string;
      categoryName: string;
      overview: string;
      item: {
        id: string;
        stem: string;
        answer: string;
        scoring: string | null;
        pointMax: number;
        options: Array<{ key: string; text: string }>;
      };
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
          recitePass, // 背诵通过线（主题方法/排期覆盖，默认 90）
        };
      }
      const q = { ...base, qid: `q${++textNo}`, scoringText: serializeScoring(p.item) } as Record<string, unknown>;
      // 选择题（题库带 options）：下发选项给答题端展示 + 正确项 key/答案文本供规则判分
      const opts = p.item.options ?? [];
      if (opts.length) {
        q.options = opts;
        q.correctKey = correctKeyOf({ answer: p.item.answer, options: opts });
        q.answerText = p.item.answer;
      }
      return q;
    });
  }
}

/** 选项里找与答案文本匹配的 key（判分规则用）；找不到返回 ""（判分可回退内容匹配/LLM）。 */
function correctKeyOf(item: { answer: string; options: Array<{ key: string; text: string }> }): string {
  const norm = (s: string) => String(s).replace(/\s+/g, "").replace(/[，。！？、,.!?;；:："“”‘’'（）()]/g, "");
  const ans = norm(item.answer);
  if (!ans) return "";
  for (const o of item.options) {
    const t = norm(o.text);
    if (t && (t === ans || (ans.length >= 3 && (t.includes(ans) || ans.includes(t))))) return o.key;
  }
  return "";
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
