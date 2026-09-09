/**
 * 学习考核引擎（客户端，本地 LLM）——出卷与判分都跑在**独立内存 session**：
 * - 出卷：读服务端下发的考核数据（assess_method + 课程/知识点 + assess_rubric），生成全主观题 JSON；
 * - 判分：用**服务端下发的判分 prompt**（rubric 单一真源）逐题打分 + 评语 + 课程级加强计划 JSON。
 * 两者都只在内存进行、不写任何中间文件；判分后仅把最终结果上报服务端（ipc exam:submit）。
 * 参考：daily-summary.ts 的 createEphemeralSession（SessionManager.inMemory + noContextFiles/noSkills）。
 */
import path from "path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getSharedRuntime, getDefaultModel } from "./pi-runtime";
import { getChildDir } from "./config";
import type { ExamTopicConfig, ExamCourseConfig } from "./exam";
import { auditExamEvent } from "./exam-audit";

// ==================== 出卷 ====================

export interface GeneratedQuestion {
  qid: string;
  course: string;
  stem: string;
  pointMax: number;
  /** 口语/听说题判分标记：speech = 走腾讯智聆发音评测（而非 LLM 读 ASR 文本判分） */
  assessMethod?: "speech";
  /** 题型（cn_recitation / cn_poem / en_word / en_sentence ...）：cn_* 用 16k_zh 引擎，其余 16k_en */
  questionType?: string;
  /** 标准原文（背诵/跟读参照），结构化来自语料，不靠 LLM 生成 */
  refText?: string;
}

const GENERATION_SYSTEM_PROMPT = `你是儿童学习考核的出题老师。你只做一件事：根据家长写的考核方法说明与每课考核要点，为孩子出「主观题」（口述题，孩子用语音回答）。你只输出 JSON，不输出任何其它文字。`;

/**
 * 背诵题 refText 来源（问题 1 修复，2026-09-08）：从**本课 rubric 的「原文背诵」行**提取
 * 该章原文（如「- 原文背诵：能正确流利背诵“子曰：'学而时习之…'”」），结构化直给、不靠 LLM 生成，
 * 避免错字漏字让逐字评失真。⚠️ 只取本课原文——**不再注入跨章 POC 种子**（旧实现凡「论语」课
 * 都塞 5 句固定名句，含为政/述而篇，导致"只考第一章却考了别的章"）。取不到本课背诵内容则不注入。
 */
const RECITATION_MARK_RE = /原文背诵[^“”"\n]*?[：:][^\n]*?[“"]([^”"\n]+)[”"]/g;

/** 取一门课的背诵题（结构化 refText）。优先课程自带 recitation；否则从本课 rubric「原文背诵」行提取。 */
function recitationFor(course: ExamCourseConfig): Array<{ stem: string; refText: string }> {
  const own = (course as any).recitation;
  if (Array.isArray(own) && own.length) return own;
  const rubric = String((course as any).assessRubric || "");
  const out: Array<{ stem: string; refText: string }> = [];
  const re = new RegExp(RECITATION_MARK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(rubric)) && out.length < 3) {
    const ref = (m[1] || "").replace(/[“”"'']/g, "").trim();
    if (!ref) continue;
    // 同一段重复出现的「背诵」提示可能指同一原文，按内容去重
    if (out.some((x) => x.refText === ref)) continue;
    out.push({ stem: "请完整背诵本章原文（不看书，背完整、背流利）", refText: ref });
  }
  return out;
}

// ==================== 选课（v3 §14.9：服务端下发选课 prompt，家长可编辑） ====================

const SELECTION_SYSTEM_PROMPT = `你是儿童学习考核的选课老师。你只做一件事：严格按照家长写的选课规则，从课程清单中选出本次考核要考的课程。你只输出 JSON，不输出任何其它文字。`;

/**
 * 选课（独立内存 session）——按服务端下发的完整选课 prompt（家长可编辑模板 + 注入周期范围/统计/候选清单）
 * 从候选课程中挑选本次考核要考的课程。选课是纯规则任务：LLM 只做「挑选」，不做任何其它判断。
 * @param selectionPrompt 服务端构建的完整选课 prompt（§14.9）
 * @param childId 孩子 id（session 工作目录按孩子隔离）
 * @returns 选中的课程名列表（LLM 输出，过滤空值；课程名与服务端候选清单一致）
 */
export async function selectCoursesForSchedule(selectionPrompt: string, childId: string): Promise<string[]> {
  const runtime = await getSharedRuntime();
  const model = await getDefaultModel();
  const childDir = getChildDir(childId || "default");

  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    noContextFiles: true,
    noSkills: true,
    systemPromptOverride: () => SELECTION_SYSTEM_PROMPT,
  });
  await loader.reload();

  const prompt =
    selectionPrompt +
    `\n\n请按上面的选课规则，从【课程清单】中选出本次考核要考的课程。只输出 JSON（不要 markdown 代码块围栏），课程名必须与清单完全一致：\n` +
    `{"courses":["课程名1","课程名2",...]}`;

  const { session } = await createAgentSession({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    tools: [],
    customTools: [],
  });
  try {
    const t0 = Date.now();
    await session.prompt(prompt);
    const text = lastAssistantText(session);
    const parsed = extractJson(text);
    const list = Array.isArray(parsed?.courses) ? parsed.courses : [];
    // LLM 可能把清单行的「序号. [主题] 」前缀也复制进课程名（实测 mimo 会带 "[论语] "），统一清理
    const clean = (t: any) => String(t ?? "").replace(/^(?:\d+\.\s*)?\[[^\]]*\]\s*/, "").trim();
    const titles = list.map(clean).filter(Boolean);
    auditExamEvent(childId, "select", { kind: "ok", prompt, reply: text, parsed, titles, costMs: Date.now() - t0 });
    if (!titles.length) throw new Error("选课未返回课程：\n" + text.slice(0, 800));
    return titles;
  } catch (e) {
    auditExamEvent(childId, "select", { kind: "error", prompt, error: String((e as Error).message || e) });
    throw e;
  } finally {
    session.dispose();
  }
}

/**
 * 为一门科目生成本场考核的主观题（独立内存 session，**逐课并发出题**）。
 * 课程由服务端下发的「选课结果」给定（v3 §14.9：LLM 按家长可编辑的选课 prompt 挑选，非代码裁剪）；
 * 本地不再按最近复习时间硬裁，而是对**每门选中课程单独一次 LLM 调用**完整出题——
 * 一课一次完整考核（覆盖该课全部知识点、题量由课决定），避免多课 rubric 全量拼一个 prompt 撑爆上下文。
 * @param topicConfig 服务端下发的科目考核配置（课程 = 选课结果，每课带 assess_rubric）
 * @param childId 孩子 id（session 工作目录按孩子隔离）
 */
/**
 * 为一门科目生成本场考核的全部主观题（逐课并发出题，汇总返回）。
 * 流式出题（2026-09-05 ISSUE-049）下 ExamView 不再调用本函数；保留供一次性出题/测试等场景。
 */
export async function generateExamQuestions(topicConfig: ExamTopicConfig, childId: string): Promise<GeneratedQuestion[]> {
  const runtime = await getSharedRuntime();
  const model = await getDefaultModel();
  const childDir = getChildDir(childId || "default");
  const courses = topicConfig.courses || [];
  if (!courses.length) return [];

  const CONCURRENCY = 3; // 并发出题上限（避免同时太多 LLM 调用）
  const results: (GeneratedQuestion[] | null)[] = new Array(courses.length).fill(null);
  let failed = 0;
  let idx = 0;
  const worker = async () => {
    while (idx < courses.length) {
      const i = idx++;
      try {
        results[i] = await generateForCourse(courses[i], topicConfig.name, "", childId, childDir, runtime, model);
      } catch (e) {
        failed++;
        console.error(`[exam] 出题失败：${courses[i].title}`, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, courses.length) }, worker));
  const questions = results.flat().filter((q): q is GeneratedQuestion => !!q);
  if (!questions.length) {
    throw new Error(failed ? `出题失败：${failed} 门课程均未生成题目` : "出卷未返回题目");
  }
  if (failed) console.warn(`[exam] ${failed}/${courses.length} 门课程出题失败已跳过`);
  return questions;
}

/**
 * 为单门课程出题（流式出题用：ExamView 首门就绪即开考，其余课程后台逐门调用本函数，
 * 每门完成后把题目增量追加到答题流）。每次独立内存 session，一次 LLM 调用覆盖该课全部知识点。
 */
export async function generateCourseQuestions(
  topicName: string,
  course: ExamCourseConfig,
  childName: string,
  childId: string
): Promise<GeneratedQuestion[]> {
  const runtime = await getSharedRuntime();
  const model = await getDefaultModel();
  const childDir = getChildDir(childId || "default");
  return generateForCourse(course, topicName, childName, childId, childDir, runtime, model);
}

const GENERATION_PER_COURSE_RULES =
  `题目要覆盖该课「考核内容」里的全部知识点（原文背诵/字词/句意/道理应用/典故等都要考到），可一课多题（每课 2~4 题，题量由该课考核内容决定，不设全局题量上限）。` +
  `题目**优先直接采用该课「考核内容」里已有的现成题目**（含选择题和问答题），不要另出新题；` +
  `选择题改造成口述题：保留题干、**去掉 A/B/C/D 选项**（孩子口述作答，例如「北辰的正确读音是什么？请说出口头答案」）；` +
  `问答题直接采用题干。每题满分 pointMax 给 10（选择题原本 2 分的也按 10 分制口述题处理）。贴近 6~12 岁孩子，语气亲切。` +
  `⚠️ **不要出“请背诵/背出原文”这类要求背原文的题**：若考核含「原文背诵」，背诵题由系统单独生成并用发音评测自动评分——` +
  `你只出需要孩子**用自己的话回答**的文字题（讲意思、白话翻译、道理应用、字词读音与用法等），否则背诵会重复出现。`;

/** 为单门课程完整出题（一次独立内存 session；course 字段固定为该课标题，保证与候选清单一致）。 */
async function generateForCourse(
  course: ExamCourseConfig,
  topicName: string,
  childName: string,
  childId: string,
  childDir: string,
  runtime: unknown,
  model: unknown
): Promise<GeneratedQuestion[]> {
  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    noContextFiles: true,
    noSkills: true,
    systemPromptOverride: () => GENERATION_SYSTEM_PROMPT,
  });
  await loader.reload();

  // 主题考核方法（家长设定，按孩子区分题目构成与不考范围，2026-09-09）：
  // 方法优先于通用出题规则；方法含多孩子段落时只按「当前孩子」的段落出题。
  const method = String((course as any).assessMethod || "").trim();
  const methodBlock = method
    ? `\n【本主题考核方法（家长设定，按孩子区分题目构成与考核范围；方法优先于下面的通用规则）】\n${method}\n\n` +
      (childName ? `本次考核孩子是「${childName}」。请只按方法说明中**针对 ${childName}** 的要求出题，忽略针对其它孩子的段落；方法明确不考的（如“不考核字词读音/解释”）一律不要出。\n` : "")
    : "";

  const prompt =
    `考核科目：${topicName}\n` +
    methodBlock +
    `课程「${course.title}」的考核内容（知识点 + 现成题目 + 评分标准）：\n${course.assessRubric || "（未写考核内容，按题意出基础理解题）"}\n\n` +
    `请为这一门课程完整出题：${GENERATION_PER_COURSE_RULES}\n\n` +
    `只输出 JSON（不要 markdown 代码块围栏），格式：\n` +
    `{"questions":[{"qid":"q1","course":"${course.title}","stem":"题干","pointMax":10}]}`;

  const { session } = await createAgentSession({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    tools: [],
    customTools: [],
  });
  try {
    const t0 = Date.now();
    await session.prompt(prompt);
    const text = lastAssistantText(session);
    const parsed = extractJson(text);
    const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
    if (!list.length) throw new Error("该课未返回题目：" + text.slice(0, 200));
    const llm = list
      .map((q: any, i: number) => ({
        qid: String(q?.qid || `q${i + 1}`),
        course: course.title, // 固定为该课标题（LLM 可能改 course 名，统一回写）
        stem: String(q?.stem || ""),
        pointMax: Number(q?.pointMax) || 10,
      }))
      .filter((q: GeneratedQuestion) => q.stem);
    // 背诵题（口语/听说题）：由语料结构化注入，不走 LLM（避免错字漏字让逐字评失真）；
    // 判分在提交时走 SSECP 发音评测（见 exam-template / ExamView.handleSubmit）。
    const rec = recitationFor(course).map((r, ri) => ({
      qid: `rq${ri + 1}`,
      course: course.title,
      stem: r.stem,
      pointMax: 10,
      assessMethod: "speech" as const,
      questionType: "cn_recitation",
      refText: r.refText,
    }));
    auditExamEvent(childId, "generate", {
      kind: "ok",
      course: course.title,
      topic: topicName,
      rubric: String((course as any).assessRubric || ""),
      prompt,
      reply: text,
      parsed,
      llmCount: llm.length,
      recCount: rec.length,
      refTexts: rec.map((r) => r.refText),
      costMs: Date.now() - t0,
    });
    // 题序约定（2026-09-09）：背诵题必须放在该课**第一题**——后面的文字题题干里可能带原文
    // （如「讲一讲"学而时习之…"的意思」），若文字题在前孩子会先读到原文，背诵检测就失真了。
    return [...rec, ...llm];
  } catch (e) {
    auditExamEvent(childId, "generate", {
      kind: "error",
      course: course.title,
      topic: topicName,
      prompt,
      error: String((e as Error).message || e),
    });
    throw e;
  } finally {
    session.dispose();
  }
}

// ==================== 判分 ====================

export interface ExamAnswerIn {
  qid: string;
  course: string;
  stem: string;
  pointMax: number;
  /** 家长写的该课考核要点（服务端下发，判分锚定用——SCORING_PROMPT 声明要按 rubric 给分） */
  rubric: string;
  /** 结构化题（v2）：本题评分标准+参考答案文本（有则按本题给分，不再依赖课程 rubric 整文） */
  scoring?: string;
  asrText: string;
  durationMs: number | null;
}

export interface ScoredQuestion {
  qid: string;
  pointGot: number;
  correct: boolean;
  aiComment: string;
}

export interface ScoredResult {
  perQuestion: ScoredQuestion[];
  courseMastery: Record<string, { correct: number; total: number; rate: number }>;
  reinforcePlan: Record<string, { planReviewAt: string; focus: string[]; aiSuggestion?: string }>;
  score: number;
  overall: string;
}

const SCORING_SYSTEM_PROMPT = `你是儿童学习考核的评估老师。你根据家长写的考核要点严格、温和地评判孩子的口述回答，只输出 JSON，不输出其它文字。`;

/**
 * 判分（独立内存 session，prompt 取自服务端——判分口径单一真源）。
 * @param scoringPrompt 服务端下发的判分 prompt（EXAM-REQUIREMENTS.md §7）
 * @param childId 孩子 id（session 工作目录按孩子隔离）
 */
export async function scoreExamAttempt(
  scoringPrompt: string,
  answers: ExamAnswerIn[],
  childId: string
): Promise<ScoredResult> {
  const runtime = await getSharedRuntime();
  const model = await getDefaultModel();
  const childDir = getChildDir(childId || "default");

  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    noContextFiles: true,
    noSkills: true,
    systemPromptOverride: () => SCORING_SYSTEM_PROMPT,
  });
  await loader.reload();

  // 判分 prompt：rubric 按「课程」只放一次（同课多题共享同一份考核要点），
  // 避免逐题重复粘贴把 prompt 撑大（2026-09-09：4 题曾把同一份 rubric 贴 4 次 → 20KB+）。
  // 判分只按 rubric 的知识点/评分标准给分，不需要主题考核方法(assess_method)。
  const byCourse = new Map<string, ExamAnswerIn[]>();
  for (const a of answers) {
    const k = a.course || "（未分课程）";
    const list = byCourse.get(k);
    if (list) list.push(a);
    else byCourse.set(k, [a]);
  }
  const answersLines: string[] = [];
  let n = 0;
  for (const [course, qs] of byCourse) {
    // 结构化题带逐题评分标准时，不再重复贴整课 rubric（判分锚定 = 本题标准）
    const anyRubric = qs.some((q) => q.rubric);
    if (anyRubric) {
      const rubric = qs.find((q) => q.rubric)?.rubric || "（未提供考核要点）";
      answersLines.push(`【课程：${course}】\n考核要点(rubric，家长写，判分锚定，本课各题共用)：${rubric}`);
    }
    for (const a of qs) {
      n++;
      answersLines.push(
        `【第${n}题】qid=${a.qid}，pointMax=${a.pointMax}\n` +
          `题干：${a.stem}\n` +
          `孩子回答（ASR 转写，可能有识别误差）：${a.asrText || "（未作答/仅语音）"}\n` +
          (a.scoring ? `本题评分标准（家长设定，按此给分）：\n${a.scoring}\n` : "") +
          `本题用时：${a.durationMs != null ? Math.round(a.durationMs / 1000) + "秒" : "未知"}`
      );
    }
  }

  const prompt = `${scoringPrompt}\n\n—— 本场考核题目与孩子回答 ——\n${answersLines.join("\n\n")}\n\n请按评分标准输出 JSON。`;

  const { session } = await createAgentSession({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    tools: [],
    customTools: [],
  });
  try {
    const t0 = Date.now();
    await session.prompt(prompt);
    const text = lastAssistantText(session);
    const parsed = extractJson(text);
    if (!parsed || !Array.isArray(parsed.perQuestion)) {
      throw new Error("判分未返回有效结果：" + text.slice(0, 300));
    }
    const perQuestion = parsed.perQuestion.map((q: any) => ({
      qid: String(q?.qid ?? ""),
      pointGot: Math.max(0, Number(q?.pointGot) || 0),
      correct: Boolean(q?.correct),
      aiComment: String(q?.aiComment ?? ""),
    }));
    auditExamEvent(childId, "score", {
      kind: "ok",
      scoringPrompt,
      answers: answers.map((a) => ({ qid: a.qid, course: a.course, stem: a.stem, asrText: a.asrText })),
      reply: text,
      parsed,
      costMs: Date.now() - t0,
    });
    // 2026-09-09：判分只输出每题评分 + 一句总评；courseMastery 由客户端按每题 course 本地聚合，
    // reinforcePlan 已从判分移除（复习建议改由家长 agent 按需提供），这里返回空以兼容调用方。
    return {
      perQuestion,
      courseMastery: {},
      reinforcePlan: {},
      score: 0,
      overall: String(parsed.overall ?? ""),
    };
  } catch (e) {
    auditExamEvent(childId, "score", {
      kind: "error",
      scoringPrompt,
      answers: answers.map((a) => ({ qid: a.qid, course: a.course, stem: a.stem, asrText: a.asrText })),
      error: String((e as Error).message || e),
    });
    throw e;
  } finally {
    session.dispose();
  }
}

// ==================== 辅助 ====================

/** 取 session 里最后一条 assistant 的 text 内容（内存会话结构同 jsonl：role+content[type=text]）。 */
function lastAssistantText(session: any): string {
  const msgs: Array<any> = session?.messages ?? [];
  let text = "";
  for (const m of msgs) {
    if (m?.role !== "assistant") continue;
    const content = Array.isArray(m.content) ? m.content : [];
    const t = content
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");
    if (t) text = t;
  }
  return text;
}

/** 从 LLM 输出里提取 JSON（剥 markdown 围栏、截第一个 { 到最后一个 }）。 */
export function extractJson(text: string): any {
  if (!text) return null;
  let t = text.trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}
