/**
 * 考核引擎（服务端，P3）：选课以外的两条 LLM 链路——**出题**与**判分**——从客户端上移。
 *
 * 迁移依据（原 `electron/lib/exam-engine.ts`）：
 * - 出题：只对**非结构化课程**（题库里没有挂题）走 LLM；结构化课程由 `assess-selection.ts`
 *   的 `attachStructuredQuestions` 从题库直出（无需 LLM）。因此服务端只需覆盖前者。
 * - 判分：逐题并发（上限 3）迷你 prompt，判分口径来自 `buildScoringPrompt()`（服务端真源）；
 *   带选项的选择题走**本地规则判分**，不进 LLM（识别不清才兜底）。
 * - 选课：2026-09-09 起固定档已改为「计划周期内必学课全考」的内置规则，LLM 选课不再使用，
 *   故本次不迁选课（如后续需要，机制与出题一致，复用本文件的 createExamSession）。
 *
 * 与客户端实现的差别：会话 cwd 用服务端工作区、模型凭据取服务端家长设置、
 * 审计写服务端 `exam-audit/`（prompt 原文默认不落盘，避免把家长/孩子的长文本无意义落库）。
 */
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import { createCorePaths, getWorkerRuntime, pickWorkerModel } from "@pi/agent-core";
import { readParentSettings } from "../worker/scheduler.js";

// ==================== 类型 ====================

export interface GeneratedQuestion {
  qid: string;
  course: string;
  stem: string;
  pointMax: number;
  assessMethod?: "speech";
  questionType?: string;
  refText?: string;
}

export interface ExamAnswerIn {
  qid: string;
  course: string;
  stem: string;
  pointMax: number;
  rubric: string;
  scoring?: string;
  asrText: string;
  durationMs: number | null;
  choice?: { options: Array<{ key: string; text: string }>; correctKey: string; answerText: string } | null;
}

export interface ScoredQuestion {
  qid: string;
  pointGot: number;
  correct: boolean;
  aiComment: string;
}

export interface ScoredResult {
  perQuestion: ScoredQuestion[];
  overall: string;
}

export interface ExamEngineDeps {
  dataDir: string;
  db: import("node:sqlite").DatabaseSync;
  parentId: string;
  childId: string;
  childName?: string;
}

// ==================== prompt（口径与客户端一致） ====================

export const GENERATION_SYSTEM_PROMPT =
  `你是儿童学习考核的出题老师。你只做一件事：根据家长写的考核方法说明与每课知识点（考核要点），为孩子出「主观题」（口述题，孩子用语音回答）。你只输出 JSON，不输出任何其它文字。`;

export const SCORING_SYSTEM_PROMPT =
  `你是儿童学习考核的评估老师。你根据家长写的考核要点严格、温和地评判孩子的口述回答，只输出 JSON，不输出其它文字。`;

export const RETAKE_SYSTEM_PROMPT =
  `你是儿童学习考核的排课助手。考核评分结束后，你根据家长设定的「当天重考标准」和本次评分结果，设计当天的重考考核计划：只输出 JSON，不输出任何其它文字。`;

export const GENERATION_PER_COURSE_RULES =
  `题目要覆盖该课「考核要点」里的全部知识点（原文背诵/字词/句意/道理应用等都要考到），可一课多题（每课 2~4 题，题量由该课知识点数量决定，不设全局题量上限）。` +
  `贴近 6~12 岁孩子，语气亲切，题目要贴合知识点详情里描述的考核期望。` +
  `⚠️ **不要出“请背诵/背出原文”这类要求背原文的题**：背诵题由系统单独生成并用发音评测自动评分——` +
  `你只出需要孩子**用自己的话回答**的文字题（讲意思、白话翻译、道理应用、字词读音与用法等），否则背诵会重复出现。` +
  `（即使方法说明要求出背诵题也如此：背诵题必须来自题库里的标准原文才能发音评测判分，你没有原文可依据；` +
  `已挂题库的课系统会直出背诵题、不经你手。若方法要求背诵而该课没有背诵题，正常出其它文字题即可，不要硬编。）`;

export interface CourseLikeForExam {
  title: string;
  assessMethod?: string;
  knowledgePoints?: Array<{ name: string; detail: string }>;
}

/** 组装单门课的出题 prompt（纯函数，便于测试与审计）。 */
export function buildCourseGenerationPrompt(
  topicName: string,
  course: CourseLikeForExam,
  childName: string
): string {
  const method = String(course.assessMethod ?? "").trim();
  const methodBlock = method
    ? `\n【考核方法说明（家长设定；优先级从高到低：①「本次考核要求」= 家长本次考核计划的说明 → ②主题考核方法 → ③下面的通用出题规则。冲突时以高优先级为准，方法说明可覆盖通用规则）】\n${method}\n\n` +
      (childName ? `本次考核孩子是「${childName}」。请只按方法说明中**针对 ${childName}** 的要求出题，忽略针对其它孩子的段落；方法明确不考的（如“不考核字词读音/解释”）一律不要出。\n` : "")
    : "";
  const kps = Array.isArray(course.knowledgePoints) ? course.knowledgePoints : [];
  const kpBlock = kps.length
    ? kps.map((k, i) => `${i + 1}. ${k.name}${k.detail ? `：${k.detail}` : ""}`).join("\n")
    : "（该课暂未写知识点详情，按课程标题出基础理解题）";
  return (
    `考核科目：${topicName}\n` +
    methodBlock +
    `课程「${course.title}」的考核要点（知识点 + 详情）：\n${kpBlock}\n\n` +
    `请为这一门课程完整出题：${GENERATION_PER_COURSE_RULES}\n\n` +
    `只输出 JSON（不要 markdown 代码块围栏），格式：\n` +
    `{"questions":[{"qid":"q1","course":"${course.title}","stem":"题干","pointMax":10}]}`
  );
}

/** 组装单题判分 prompt（纯函数，便于测试与审计）。 */
export function buildScorePrompt(
  scoringPrompt: string,
  a: ExamAnswerIn,
  index: number
): string {
  const optsLine =
    a.choice && a.choice.options.length
      ? `本题是选择题，孩子看选项口头作答。选项：\n${a.choice.options
          .map((o) => `${o.key}. ${o.text}`)
          .join("\n")}\n正确选项：${a.choice.correctKey || "（未标注）"}；正确内容参照：${a.choice.answerText || ""}\n`
      : "";
  const questionText =
    `【本场第 ${index + 1} 题】qid=${a.qid}，pointMax=${a.pointMax}\n` +
    (a.rubric ? `课程考核要点(rubric)：${a.rubric}\n` : "") +
    `题干：${a.stem}\n` +
    (optsLine ? optsLine : "") +
    (a.scoring ? `本题评分标准（家长设定，按此给分）：\n${a.scoring}\n` : "") +
    `孩子回答（ASR 转写，可能有识别误差）：${a.asrText || "（未作答/仅语音）"}\n` +
    `本题用时：${a.durationMs != null ? Math.round(a.durationMs / 1000) + "秒" : "未知"}`;
  return (
    `${scoringPrompt}\n\n—— 本题（只评这一题，不要评其它题） ——\n${questionText}\n\n` +
    `请只针对本题输出 JSON：{"perQuestion":[{"qid":"${a.qid}","pointGot":分数,"correct":true|false,"aiComment":"评语"}],"overall":"整场一句总评"}`
  );
}

// ==================== 选择题规则判分（与客户端一致） ====================

/**
 * 选择题规则判分：文本含正确选项 key/正确项内容 → 满分；命中其它选项 → 0 分；
 * 无法判定（识别不清/未作答）返回 null → 调用方兜底走 LLM。
 */
export function judgeChoice(
  asr: string,
  choice: { options: Array<{ key: string; text: string }>; correctKey: string; answerText: string },
  pointMax: number
): { pointGot: number; correct: boolean; aiComment: string } | null {
  const norm = (s: string) =>
    String(s || "")
      .toLowerCase()
      .replace(/[\s\u3000，。！？、,.!?;；:："“”‘’'（）()【】]/g, "");
  const n = norm(asr);
  if (!n) return null;
  const opts = choice.options;
  const keys = ["a", "b", "c", "d", "e", "f"];
  const cjk = ["一", "二", "三", "四", "五", "六"];

  const letterHit =
    n.match(/(?:选|答|答案|选择)?(?:的)?(?:是|为|选)?([a-f一二三四五六])\s*$/) ||
    n.match(/(?:选|答|答案|选择)(?:的)?(?:是|为)?\s*([a-f一二三四五六])/);
  if (letterHit) {
    const c = letterHit[1]!;
    const ki = keys.indexOf(c) >= 0 ? keys.indexOf(c) : cjk.indexOf(c);
    if (ki >= 0 && ki < opts.length) {
      const opt = opts[ki]!;
      const right = opt.key.toLowerCase() === String(choice.correctKey || "").toLowerCase();
      return {
        pointGot: right ? pointMax : 0,
        correct: right,
        aiComment: right
          ? `答对了（选 ${opt.key}）。`
          : `答的是 ${opt.key}，正确答案是 ${String(choice.correctKey || "未知")}。`,
      };
    }
  }

  const ansN = norm(choice.answerText);
  if (ansN && n.includes(ansN)) return { pointGot: pointMax, correct: true, aiComment: "答对了（说出了正确选项的内容）。" };
  let wrongText = "";
  for (const o of opts) {
    const t = norm(o.text);
    if (!t || t.length < 4) continue;
    if (n.includes(t)) {
      const right = o.key.toLowerCase() === String(choice.correctKey || "").toLowerCase();
      if (right) return { pointGot: pointMax, correct: true, aiComment: "答对了（说出了正确选项的内容）。" };
      wrongText = o.text;
    }
  }
  if (wrongText) {
    return {
      pointGot: 0,
      correct: false,
      aiComment: `答的是「${wrongText.slice(0, 18)}…」，正确答案是 ${String(choice.answerText || choice.correctKey || "其它选项")}。`,
    };
  }
  return null;
}

// ==================== JSON 解析 ====================

/** 从 LLM 输出里提取 JSON（剥 markdown 围栏、截第一个 { 到最后一个 }）。 */
export function extractJson(text: string): any {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1]!.trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(t.slice(s, e + 1));
  } catch {
    return null;
  }
}

// ==================== 会话与审计 ====================

/** 取会话最后一轮 assistant 文本（导出供重考计划生成的多轮对话复用，ISSUE-115）。 */
export function lastAssistantText(session: any): string {
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

/** 审计落盘：{dataDir}/exam-audit/{childId}/{YYYYMMDD}.jsonl（prompt 原文仅在 EXAM_AUDIT_PROMPTS=1 时写入）。 */
export function auditExamEvent(
  deps: Pick<ExamEngineDeps, "dataDir" | "childId">,
  phase: "generate" | "score",
  payload: Record<string, unknown>
): void {
  try {
    const withPrompts = process.env["EXAM_AUDIT_PROMPTS"] === "1";
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dir = path.join(deps.dataDir, "exam-audit", deps.childId || "unknown");
    fs.mkdirSync(dir, { recursive: true });
    const safe = withPrompts ? payload : Object.fromEntries(Object.entries(payload).filter(([k]) => k !== "prompt" && k !== "scoringPrompt"));
    fs.appendFileSync(path.join(dir, `${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), phase, ...safe }) + "\n");
  } catch (e) {
    console.error("[exam-audit] 写入失败（不影响考核）:", (e as Error).message);
  }
}

/** 建一个一次性内存会话（考核的 LLM 环节都用它：不落盘、不注入项目 prompt）。
 *  导出供重考计划生成复用（ISSUE-115）——同会话多轮追问实现错误反馈重试环。 */
export async function createExamSession(deps: ExamEngineDeps, systemPrompt: string) {
  const settings = readParentSettings(deps.db, deps.dataDir, deps.parentId);
  const runtime = await getWorkerRuntime(deps.dataDir, deps.parentId, settings.auth);
  const model = pickWorkerModel(runtime, settings.appSettings);
  const paths = createCorePaths(deps.dataDir);
  const cwd = paths.childWorkspaceDir(deps.parentId, deps.childId);
  const agentDir = path.join(cwd, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noContextFiles: true,
    noSkills: true,
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    tools: [],
    customTools: [],
  });
  return session;
}

// ==================== 出题 ====================

/** 为单门课程出题（非结构化课程；结构化课程走题库直出，不进本函数）。 */
export async function generateCourseQuestions(
  deps: ExamEngineDeps,
  topicName: string,
  course: CourseLikeForExam
): Promise<GeneratedQuestion[]> {
  const prompt = buildCourseGenerationPrompt(topicName, course, deps.childName ?? "");
  const session = await createExamSession(deps, GENERATION_SYSTEM_PROMPT);
  const t0 = Date.now();
  try {
    await session.prompt(prompt);
    const text = lastAssistantText(session);
    const parsed = extractJson(text);
    const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
    if (!list.length) throw new Error(`该课未返回题目：${text.slice(0, 200)}`);
    const questions: GeneratedQuestion[] = list
      .map((q: any, i: number) => ({
        qid: String(q?.qid || `q${i + 1}`),
        course: course.title, // 固定为该课标题（模型可能改 course 名，统一回写）
        stem: String(q?.stem || ""),
        pointMax: Number(q?.pointMax) || 10,
      }))
      .filter((q: GeneratedQuestion) => q.stem);
    auditExamEvent(deps, "generate", {
      kind: "ok",
      course: course.title,
      topic: topicName,
      knowledgePoints: (course.knowledgePoints ?? []).map((k) => k.name),
      prompt,
      reply: text,
      llmCount: questions.length,
      costMs: Date.now() - t0,
    });
    return questions;
  } catch (e) {
    auditExamEvent(deps, "generate", {
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

/**
 * 逐题并发判分（上限 3）。任一题失败即整体失败并给出可重试的报错——
 * 部分判分落库会让「本次成绩」语义模糊，宁可让家长重试。
 */
export async function scoreExamAttempt(
  deps: ExamEngineDeps,
  scoringPrompt: string,
  answers: ExamAnswerIn[]
): Promise<ScoredResult> {
  if (!answers.length) return { perQuestion: [], overall: "" };
  const t0 = Date.now();
  const CONCURRENCY = 3;
  const results: Array<{ per: ScoredQuestion; overall: string; reply: string } | null> = new Array(answers.length).fill(null);
  let idx = 0;
  let lastError = "";

  const scoreOne = async () => {
    while (idx < answers.length) {
      const i = idx++;
      const a = answers[i]!;
      // 选择题：规则判分优先；判定不出才走 LLM 兜底
      if (a.choice && a.choice.options.length) {
        const judged = judgeChoice(a.asrText, a.choice, a.pointMax);
        if (judged) {
          results[i] = {
            per: { qid: a.qid, pointGot: judged.pointGot, correct: judged.correct, aiComment: judged.aiComment },
            overall: "",
            reply: "[选择题规则判分] " + judged.aiComment,
          };
          continue;
        }
      }
      const prompt = buildScorePrompt(scoringPrompt, a, i);
      try {
        const session = await createExamSession(deps, SCORING_SYSTEM_PROMPT);
        try {
          await session.prompt(prompt);
          const text = lastAssistantText(session);
          const parsed = extractJson(text);
          const list = Array.isArray(parsed?.perQuestion) ? parsed.perQuestion : [];
          const mine = list.find((x: any) => x && String(x.qid) === a.qid) ?? list[0];
          if (!mine) throw new Error("该题判分未返回有效结果：" + text.slice(0, 200));
          results[i] = {
            per: {
              qid: a.qid,
              pointGot: Math.max(0, Number(mine.pointGot) || 0),
              correct: Boolean(mine.correct),
              aiComment: String(mine.aiComment ?? ""),
            },
            overall: String(parsed?.overall ?? ""),
            reply: text,
          };
        } finally {
          session.dispose();
        }
      } catch (e) {
        lastError = (e as Error).message || String(e);
        console.error(`[exam] 判分失败 qid=${a.qid}`, lastError);
        results[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, answers.length) }, scoreOne));

  const failedIdx = results.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
  if (failedIdx.length) {
    const msg = `判分失败：${failedIdx.length}/${answers.length} 题判分出错（qid=${failedIdx.map((i) => answers[i]!.qid).join(",")}），请重试提交${lastError ? `（首个错误：${lastError}）` : ""}`;
    auditExamEvent(deps, "score", {
      kind: "error",
      error: msg,
      answers: answers.map((a) => ({ qid: a.qid, course: a.course, stem: a.stem, asrText: a.asrText })),
      costMs: Date.now() - t0,
    });
    throw new Error(msg);
  }
  const perQuestion = results.map((r) => r!.per);
  const overall = results.map((r) => r!.overall).find(Boolean) ?? "";
  auditExamEvent(deps, "score", {
    kind: "ok",
    concurrency: true,
    answers: answers.map((a) => ({ qid: a.qid, course: a.course, stem: a.stem, asrText: a.asrText })),
    reply: results.map((r) => r!.reply).join("\n---\n"),
    parsed: { perQuestion },
    scoringPrompt,
    costMs: Date.now() - t0,
  });
  return { perQuestion, overall };
}
