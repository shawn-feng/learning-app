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

// ==================== 出卷 ====================

export interface GeneratedQuestion {
  qid: string;
  course: string;
  stem: string;
  pointMax: number;
}

const GENERATION_SYSTEM_PROMPT = `你是儿童学习考核的出题老师。你只做一件事：根据家长写的考核方法说明与每课考核要点，为孩子出「主观题」（口述题，孩子用语音回答）。你只输出 JSON，不输出任何其它文字。`;

/**
 * 为一门科目生成本场考核的主观题（独立内存 session）。
 * @param topicConfig 服务端下发的科目考核配置（assess_method + 学过的课程 + 各课考核要点）
 * @param childId 孩子 id（session 工作目录按孩子隔离）
 */
export async function generateExamQuestions(topicConfig: ExamTopicConfig, childId: string): Promise<GeneratedQuestion[]> {
  const runtime = await getSharedRuntime();
  const model = await getDefaultModel();
  const childDir = getChildDir(childId || "default");

  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    noContextFiles: true,
    noSkills: true,
    systemPromptOverride: () => GENERATION_SYSTEM_PROMPT,
  });
  await loader.reload();

  const courseLines = topicConfig.courses
    .map(
      (c, i) =>
        `${i + 1}. 课程「${c.title}」（最近复习 ${c.lastReview || "无"}，引导掌握度 ${c.mastery || "未知"}）\n` +
        `   考核要点：${c.assessRubric || "（未写考核要点，按题意出基础理解题）"}`
    )
    .join("\n\n");

  const prompt =
    `科目：${topicConfig.name}（${topicConfig.topicKey}）\n` +
    `考核方法说明（家长写，含周期/考核对象/题量/评分口径）：\n${topicConfig.assessMethod || "（未写，默认每次考最近学习的 3 门课程，每课 1 题）"}\n\n` +
    `本周期可考核的课程（都是孩子学/复习过的）：\n${courseLines}\n\n` +
    `请按考核方法说明确定本场要考的课程与题量（题量不宜超过 8 题；没有说明时取最近学的 3 课各 1 题），` +
    `为每道题出 1 个主观口述题：题目要能考到该课考核要点里的理解/应用（不是背诵），贴近 6~12 岁孩子，语气亲切。` +
    `每题满分 pointMax 给 10。\n\n` +
    `只输出 JSON（不要 markdown 代码块围栏），格式：\n` +
    `{"questions":[{"qid":"q1","course":"课程名(必须与上面列表完全一致)","stem":"题干","pointMax":10}]}`;

  const session = await createAgentSession({
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
    await session.prompt(prompt);
    const text = lastAssistantText(session);
    const parsed = extractJson(text);
    const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
    if (!list.length) throw new Error("出卷未返回题目：" + text.slice(0, 200));
    return list
      .map((q: any, i: number) => ({
        qid: String(q?.qid || `q${i + 1}`),
        course: String(q?.course || ""),
        stem: String(q?.stem || ""),
        pointMax: Number(q?.pointMax) || 10,
      }))
      .filter((q: GeneratedQuestion) => q.course && q.stem);
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

  const answersLines = answers
    .map(
      (a, i) =>
        `【第${i + 1}题】qid=${a.qid}，课程=${a.course}，pointMax=${a.pointMax}\n` +
        `考核要点(rubric，家长写，判分锚定)：${a.rubric || "（未提供）"}\n` +
        `题干：${a.stem}\n` +
        `孩子回答（ASR 转写，可能有识别误差）：${a.asrText || "（未作答/仅语音）"}\n` +
        `本题用时：${a.durationMs != null ? Math.round(a.durationMs / 1000) + "秒" : "未知"}`
    )
    .join("\n\n");

  const prompt = `${scoringPrompt}\n\n—— 本场考核题目与孩子回答 ——\n${answersLines}\n\n请按评分标准输出 JSON。`;

  const session = await createAgentSession({
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
    return {
      perQuestion,
      courseMastery: parsed.courseMastery ?? {},
      reinforcePlan: parsed.reinforcePlan ?? {},
      score: Number(parsed.score) || 0,
      overall: String(parsed.overall ?? ""),
    };
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
