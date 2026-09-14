/**
 * 考核内容结构化：按「孩子方法(method_spec)」从结构化课程里抽题组题（服务端读取侧）。
 * 模型（2026-09-11 知识点制）：
 * 规则：
 * - 该课无挂载行 → 非结构化（不产出 questions，调用方按该课知识点详情走 LLM 出题）；
 * - exclude 过滤知识点；require 非空时只考 require 命中的知识点，为空(default)时考该课实际挂的全部知识点；
 * - 每知识点池内随机抽 ≤require 道（缺题→跳过该知识点，不 LLM 临时命题）；
 * - speech 行为题置该课最前；speech 题 answer=refText、questionType=cn_recitation（答题端不显示原文）。
 * - qid 跨课连续（rqN=背诵/朗读，qN=文字题），避免与答题/判分按 qid 配对冲突。
 */
import type { DatabaseSync } from "node:sqlite";
import { listCourseContent, getCourseUuid, getMethodSpec, listKnowledgePoints } from "./db/assess-content.js";

export interface CourseLike {
  topic: string;
  title: string;
  [k: string]: unknown;
}

/**
 * 排期级考核方法覆盖（自定义考核"这次只考某些知识点"），覆盖主题级 method_spec。
 * 键可用**知识点 uuid 或知识点名**（按该课知识点表解析）；解析不到的名称忽略。
 * 例：{ require: { "温故而知新的含义": 1 }, exclude: ["通假字"], recitePass: 90 }
 */
export interface MethodOverride {
  require?: Record<string, number>;
  exclude?: string[];
  recitePass?: number;
}

/** 把排期级覆盖解析成本课知识点 id（按 uuid 或名称）；require/exclude 全解析失败 → 视为未覆盖（回退主题方法）。 */
function resolveOverride(
  db: DatabaseSync,
  courseUuid: string,
  ov?: MethodOverride | null
): { used: boolean; requireMap: Record<string, number>; exclude: Set<string>; recitePass?: number } {
  const out = { used: false, requireMap: {} as Record<string, number>, exclude: new Set<string>(), recitePass: undefined as number | undefined };
  if (!ov || (!ov.require && !ov.exclude && ov.recitePass == null)) return out;
  let kps: Array<{ id: string; name: string }> = [];
  try {
    kps = listKnowledgePoints(db, courseUuid);
  } catch {
    kps = [];
  }
  const byId = new Map(kps.map((k) => [k.id, k]));
  const byName = new Map(kps.map((k) => [String(k.name).trim(), k]));
  const find = (key: string) => byId.get(key) ?? byName.get(String(key).trim());

  let anyReq = false;
  for (const [key, v] of Object.entries(ov.require ?? {})) {
    const kp = find(key);
    if (!kp) continue;
    out.requireMap[kp.id] = Math.max(1, Number(v) || 1);
    anyReq = true;
  }
  let anyExc = false;
  for (const key of ov.exclude ?? []) {
    const kp = find(key);
    if (!kp) continue;
    out.exclude.add(kp.id);
    anyExc = true;
  }
  if (ov.recitePass != null) out.recitePass = Math.max(0, Number(ov.recitePass) || 90);
  out.used = anyReq || anyExc; // require/exclude 全解析失败 → 不覆盖
  return out;
}

/** 把结构化课程列表里每门课的选中题目挂到 course.questions（非结构化课程不加该字段）。
 *  override：排期级考核方法（自定义考核"本次只考某知识点"），优先于主题 method_spec。 */
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
    if (!content.items.length) continue; // 非结构化：走知识点详情 LLM 出题路径

    const spec = (getMethodSpec(db, course.topic) as any) ?? {};
    const childSpec = spec?.perChild?.[childId] ?? spec?.default ?? {};
    // 主题级方法也走 resolveOverride 统一解析（键支持知识点 uuid 或名称；解析不到的忽略，
    // require/exclude 全解析失败 → 视为未覆盖回退全考）——修复：旧数据里键是已废弃的
    // 分类 uuid（2026-09-14 题库恢复后 KP id 全部为新值），只认 uuid 会全不命中 → 空卷"出题失败"。
    const topicOvr = resolveOverride(db, uuid, {
      require: childSpec?.require,
      exclude: childSpec?.exclude,
    });
    let requireMap: Record<string, number> = topicOvr.used ? topicOvr.requireMap : {};
    let requireKeys = Object.keys(requireMap);
    let exclude = topicOvr.used ? topicOvr.exclude : new Set<string>();
    let recitePass = Math.max(0, Number(childSpec?.rules?.recitePass) || 90);
    // 计划级覆盖（自定义考核"本次只考某知识点"等）：优先于主题方法
    const ovr = resolveOverride(db, uuid, override);
    if (ovr.used) {
      requireMap = ovr.requireMap;
      requireKeys = Object.keys(requireMap);
      exclude = ovr.exclude;
    }
    if (ovr.recitePass != null) recitePass = ovr.recitePass;

    const picked: Array<{
      behavior: string;
      knowledgePointId: string;
      knowledgePointName: string;
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
      if (exclude.has(item.knowledgePointId)) continue;
      // 命中判定：require 非空 → 只取 require 里的；require 空(default) → 该课全部知识点
      if (requireKeys.length && !(item.knowledgePointId in requireMap)) continue;
      const want = requireKeys.length ? Math.max(1, requireMap[item.knowledgePointId] ?? 1) : 1;
      if (!item.questions.length) continue; // 缺题跳过该知识点
      const pool = [...item.questions].sort((a, b) => a.seq - b.seq);
      for (let k = 0; k < Math.min(want, pool.length); k++) {
        // 洗牌取前 want（多题池随机抽）
        const j = k + Math.floor(Math.random() * (pool.length - k));
        const qi = pool[k];
        pool[k] = pool[j]!;
        pool[j] = qi!;
        picked.push({
          behavior: pool[k]!.behavior || "generic", // 题级行为为准（同知识点可混口述/背诵）
          knowledgePointId: item.knowledgePointId,
          knowledgePointName: item.knowledgePointName,
          overview: item.overview,
          item: pool[k]!,
        });
      }
    }
    if (!picked.length) {
      course.questions = [];
      continue;
    }
    // 题序：speech 行为置最前，其余保持知识点挂载顺序
    picked.sort(
      (a, b) => Number(b.behavior.startsWith("speech")) - Number(a.behavior.startsWith("speech"))
    );
    course.questions = picked.map((p) => {
      const base = {
        course: course.title,
        stem: p.item.stem,
        pointMax: p.item.pointMax || 10,
        questionId: p.item.id, // 题库题目 uuid（落库溯源/轮换排除）
        knowledgePointId: p.knowledgePointId, // 知识点 uuid（落库溯源）
        knowledgePointName: p.knowledgePointName,
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

/** 把一道抽中的题映射成下发题对象（speech 行为=背诵/朗读：refText+cn_recitation；generic：口述判分）。 */
function mapPickedToQuestion(
  p: {
    behavior: string;
    knowledgePointId: string;
    knowledgePointName: string;
    overview: string;
    item: { id: string; stem: string; answer: string; scoring: string | null; pointMax: number; options?: Array<{ key: string; text: string }> };
  },
  courseTitle: string,
  recitePass: number,
  counters: { textNo: number; recNo: number }
): Record<string, unknown> {
  const base = {
    course: courseTitle,
    stem: p.item.stem,
    pointMax: p.item.pointMax || 10,
    questionId: p.item.id, // 题库题目 uuid（落库溯源/轮换排除）
    knowledgePointId: p.knowledgePointId, // 知识点 uuid（落库溯源）
    knowledgePointName: p.knowledgePointName,
  };
  if (p.behavior.startsWith("speech")) {
    return {
      ...base,
      qid: `rq${++counters.recNo}`,
      assessMethod: "speech" as const,
      questionType: "cn_recitation",
      refText: p.item.answer, // 标准原文 = 题库 answer
      recitePass, // 背诵通过线
    };
  }
  const q = { ...base, qid: `q${++counters.textNo}`, scoringText: serializeScoring(p.item) } as Record<string, unknown>;
  const opts = p.item.options ?? [];
  if (opts.length) {
    q.options = opts;
    q.correctKey = correctKeyOf({ answer: p.item.answer, options: opts });
    q.answerText = p.item.answer;
  }
  return q;
}

/** 排序：speech 行为（背诵/朗读）置该课最前。 */
function speechFirst<T extends { behavior: string }>(picked: T[]): T[] {
  return picked.sort((a, b) => Number(b.behavior.startsWith("speech")) - Number(a.behavior.startsWith("speech")));
}

// ==================== 计划级出题约定（2026-09-14 定案：计划生成时即约定全部出题参数） ====================

/** 计划里单课的出题约定：考哪些知识点、每个知识点抽几题。 */
export interface PlanKpSpec {
  name: string;
  count: number;
}
export interface PlanCourseSpec {
  title: string;
  kps: PlanKpSpec[];
}

/**
 * 生成考核计划时调用：把「课程列表 + 计划级 methodSpec（可选）」展开成**完整出题约定**。
 * - 默认 = 主题级 method_spec（按孩子过滤，如排除字词/典故）过一遍，每个知识点 1 题；
 * - 传了 methodSpec 则覆盖主题方法（require 的键支持知识点名或 uuid，解析不到 → 记缺失，创建即失败）；
 * - **课程必须有知识点且挂了题库题**，否则进 missing（调用方必须拒绝创建考核计划）。
 */
export function buildPlanSpecEntries(
  db: DatabaseSync,
  childId: string,
  courses: CourseLike[],
  methodSpec?: MethodOverride | null
): { entries: PlanCourseSpec[]; missing: Array<{ title: string; reason: string }> } {
  const entries: PlanCourseSpec[] = [];
  const missing: Array<{ title: string; reason: string }> = [];
  for (const course of courses) {
    const title = course.title;
    const uuid = getCourseUuid(db, course.topic, title);
    if (!uuid) {
      missing.push({ title, reason: "家长库中找不到该课程" });
      continue;
    }
    const content = listCourseContent(db, uuid);
    const withQ = content.items.filter((it) => it.questions.length > 0);
    if (!withQ.length) {
      missing.push({ title, reason: "还没有考核内容（未挂知识点或知识点未挂题库题），请先在考核内容建设中补充" });
      continue;
    }
    // 计划级 methodSpec：require/exclude（键=知识点名或 uuid，严格解析）
    let planRequire: Record<string, number> | null = null;
    const planExclude = new Set<string>();
    if (methodSpec && ((methodSpec.require && Object.keys(methodSpec.require).length) || (methodSpec.exclude?.length ?? 0) > 0)) {
      const kps = listKnowledgePoints(db, uuid);
      const byId = new Map(kps.map((k) => [k.id, k]));
      const byName = new Map(kps.map((k) => [String(k.name).trim(), k]));
      let bad = false;
      if (methodSpec.require && Object.keys(methodSpec.require).length) {
        planRequire = {};
        for (const [k, v] of Object.entries(methodSpec.require)) {
          const kp = byId.get(k) ?? byName.get(String(k).trim());
          if (!kp) {
            missing.push({ title, reason: `要求的知识点「${k}」在该课不存在（现有：${kps.map((x) => x.name).join("、")}）` });
            bad = true;
            break;
          }
          planRequire[kp.name] = Math.max(1, Number(v) || 1);
        }
        if (bad) continue;
      }
      for (const k of methodSpec.exclude ?? []) {
        const kp = byId.get(k) ?? byName.get(String(k).trim());
        if (!kp) {
          missing.push({ title, reason: `要排除的知识点「${k}」在该课不存在（现有：${kps.map((x) => x.name).join("、")}）` });
          bad = true;
          break;
        }
        planExclude.add(kp.name);
      }
      if (bad) continue;
    }
    // 主题级方法（默认过滤，按孩子）
    const spec = (getMethodSpec(db, course.topic) as any) ?? {};
    const childSpec = spec?.perChild?.[childId] ?? spec?.default ?? {};
    const topicOvr = resolveOverride(db, uuid, { require: childSpec?.require, exclude: childSpec?.exclude });
    const kps: PlanKpSpec[] = [];
    for (const it of withQ) {
      const name = it.knowledgePointName;
      if (planRequire) {
        if (!(name in planRequire)) continue;
        kps.push({ name, count: planRequire[name]! });
        continue;
      }
      if (planExclude.has(name)) continue;
      if (topicOvr.used) {
        if (!(it.knowledgePointId in topicOvr.requireMap)) continue;
        if (topicOvr.exclude.has(it.knowledgePointId)) continue;
        kps.push({ name, count: Math.max(1, topicOvr.requireMap[it.knowledgePointId] ?? 1) });
        continue;
      }
      kps.push({ name, count: 1 });
    }
    if (!kps.length) {
      missing.push({ title, reason: "按考核方法过滤后没有可考知识点" });
      continue;
    }
    entries.push({ title, kps });
  }
  return { entries, missing };
}

/**
 * 出题环节调用：**严格按考核计划里的约定抽题**（不再有结构化/非结构化之分，
 * 也不再看主题方法/LLM——计划里没约定或题库缺题都算错误）。
 * 返回问题列表（空 = 全部课程成功）；失败课程 course.questions 置 []。
 */
export function attachPlanQuestions(
  db: DatabaseSync,
  courses: CourseLike[],
  entries: PlanCourseSpec[],
  recitePass = 90
): Array<{ title: string; reason: string }> {
  const byTitle = new Map(entries.map((e) => [e.title, e]));
  const counters = { textNo: 0, recNo: 0 };
  const problems: Array<{ title: string; reason: string }> = [];
  for (const course of courses) {
    const entry = byTitle.get(course.title);
    if (!entry) {
      problems.push({ title: course.title, reason: "考核计划里没有这门课的出题约定" });
      course.questions = [];
      continue;
    }
    const uuid = getCourseUuid(db, course.topic, course.title);
    if (!uuid) {
      problems.push({ title: course.title, reason: "家长库中找不到该课程" });
      course.questions = [];
      continue;
    }
    const content = listCourseContent(db, uuid);
    const picked: Array<{
      behavior: string;
      knowledgePointId: string;
      knowledgePointName: string;
      overview: string;
      item: { id: string; stem: string; answer: string; scoring: string | null; pointMax: number; options?: Array<{ key: string; text: string }> };
    }> = [];
    for (const kpSpec of entry.kps) {
      const it = content.items.find(
        (x) => x.knowledgePointName === kpSpec.name || x.knowledgePointId === kpSpec.name
      );
      if (!it || !it.questions.length) {
        problems.push({ title: course.title, reason: `知识点「${kpSpec.name}」已无可用题目（考核内容可能被改动，请重新安排这次考核）` });
        continue;
      }
      const pool = [...it.questions].sort((a, b) => a.seq - b.seq);
      const want = Math.max(1, Number(kpSpec.count) || 1);
      for (let k = 0; k < Math.min(want, pool.length); k++) {
        const j = k + Math.floor(Math.random() * (pool.length - k));
        const qi = pool[k];
        pool[k] = pool[j]!;
        pool[j] = qi!;
        picked.push({
          behavior: pool[k]!.behavior || "generic",
          knowledgePointId: it.knowledgePointId,
          knowledgePointName: it.knowledgePointName,
          overview: it.overview,
          item: pool[k]!,
        });
      }
    }
    if (!picked.length) {
      if (!problems.some((p) => p.title === course.title)) {
        problems.push({ title: course.title, reason: "没有可出的题目" });
      }
      course.questions = [];
      continue;
    }
    course.questions = speechFirst(picked).map((p) => mapPickedToQuestion(p, course.title, recitePass, counters));
  }
  return problems;
}
/**
 * note 文本 → methodSpec 兜底推断（确定性规则，非 LLM）：
 * 家长/孩子把「只考背诵」写进了 note 而没传 methodSpec 时，据此自动收紧范围。
 * 命中条件：note 含「背诵/只背」且**不含**其它考核类别词（句意/道理/翻译/字词/典故）→ 只考背诵。
 * 返回 null = 无法推断（调用方按原样处理）。
 */
export function inferReciteOnlyFromNote(note: string): MethodOverride | null {
  const t = String(note ?? "");
  if (!t) return null;
  const recite = /背诵|只背|背原文|背出原文/.test(t);
  const others = /句意|道理|翻译|白话|字词|读音|典故|默写|应用/.test(t);
  if (recite && !others) return { require: { "背诵": 1 } };
  return null;
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
