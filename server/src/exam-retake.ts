/**
 * ISSUE-115（2026-09-19）：考核当天重考。
 *
 * 链路：考核提交（POST /exam/attempts）把原计划置 done 后，读该计划 `retake` 字段（家长自然语言
 * 重考标准，''=不重考）→ 组装「重考标准 + 评分摘要」给 LLM → 模型返回重考计划 JSON
 * （scope 复用 PlanCourseSpec schema）→ schema + 课程/知识点存在性校验 → 不过就把错误信息
 * 追加进同一会话再生成（错误反馈重试环，上限 3 轮）→ 按现有 custom 计划口径直接创建 exam_plans。
 *
 * 硬约束（都在服务端强制，不经 LLM）：
 * - 防连环重考：生成的重考计划 `retake` 恒为 ''；
 * - count_in_rate 按家长设置项 `exam_retake:<parentId>`（默认不计入评分档 → 0）；
 * - 计划 id 确定性 `retake_<原计划id>` → 重复提交天然幂等，一天最多一层重考；
 * - 重考生成失败绝不影响评分落库（本模块所有错误都折叠成结果对象，不抛出）。
 */
import type { DatabaseSync } from "node:sqlite";
import { openKb } from "./db/kb.js";
import { openParentLib } from "./db/parent-lib.js";
import { buildPlanSpecEntries, type PlanCourseSpec } from "./assess-selection.js";
import {
  RETAKE_SYSTEM_PROMPT,
  createExamSession,
  extractJson,
  lastAssistantText,
  type ExamEngineDeps,
} from "./agent/exam-engine.js";

const MAX_LLM_TURNS = 3; // 首轮 + 最多 2 轮错误反馈
const WALL_BUDGET_MS = 100_000; // 客户端提交超时 120s（对齐判分调用），留响应余量
const MAX_COURSES = 10;
const MAX_KP_COUNT = 20;

// ==================== prompt（纯函数，便于测试） ====================

export interface RetakePromptInput {
  retake: string;
  examTitle: string;
  childName: string;
  score: number;
  scoreMax: number;
  dateStr: string;
  perQuestion: Array<Record<string, unknown>>;
}

/** 组装重考生成首轮 prompt：重考标准原文 + 逐题评分摘要。 */
export function buildRetakePrompt(input: RetakePromptInput): string {
  const lines: string[] = [];
  for (let i = 0; i < input.perQuestion.length; i++) {
    const q = input.perQuestion[i]!;
    const got = Number(q.pointGot ?? 0);
    const max = Number(q.pointMax ?? 0);
    const mark = q.correct === true ? "✓" : "✗";
    const kp = String(q.knowledgePointName ?? "").trim();
    const comment = String(q.aiComment ?? "").replace(/\s+/g, " ").slice(0, 80);
    lines.push(
      `${i + 1}. [${String(q.qid ?? `q${i + 1}`)}] 课程「${String(q.course ?? "")}」` +
        (kp ? `知识点「${kp}」` : "") +
        ` 得 ${got}/${max} ${mark}${comment ? `：${comment}` : ""}`
    );
  }
  return (
    `孩子的考核「${input.examTitle}」刚完成评分（孩子：${input.childName}，日期：${input.dateStr}）。\n\n` +
    `【家长设定的当天重考标准（原文）】\n${input.retake}\n\n` +
    `【本次评分结果】总分 ${input.score}/${input.scoreMax}\n${lines.length ? lines.join("\n") : "（无逐题明细）"}\n\n` +
    `请按重考标准判断是否需要安排今天重考，并给出重考计划。只输出 JSON（不要 markdown 围栏），格式：\n` +
    `{"retake_needed":true,"title":"重考：<考核名>","courses":[{"title":"精确课程名","kps":[{"name":"知识点名","count":1}]}],"note":"给孩子的一句话说明"}\n` +
    `要求：\n` +
    `- 重考标准未触发（如「错两题以上才重考」但只错了一题）→ 输出 {"retake_needed":false,"reason":"…"}，不要编课程。\n` +
    `- courses 里的课程名必须是孩子课程库里的**精确课程名**（从上面逐题涉及的课程里选最合适者，不要新造课名）；\n` +
    `  kps 是该课的**真实知识点名**，count=抽题数（≥1，按重考标准定题量）；省略某课的 kps = 该课全部知识点各 1 题。\n` +
    `- title 以「重考：」开头；note 可选。`
  );
}

// ==================== 输出解析与校验 ====================

export interface RetakeDraft {
  retakeNeeded: boolean;
  reason: string;
  title: string;
  note: string;
  courses: Array<{ title: string; kps: Array<{ name: string; count: number }> }>;
}

/** schema 级校验 + 归一化；不合法返回错误描述（作为反馈让模型重出）。 */
export function parseRetakeDraft(text: string): { draft?: RetakeDraft; error?: string } {
  const raw = extractJson(text);
  if (!raw || typeof raw !== "object") return { error: "输出不是合法 JSON 对象" };
  if (raw["retake_needed"] === false) {
    return {
      draft: {
        retakeNeeded: false,
        reason: String(raw["reason"] ?? "模型判断无需重考"),
        title: "",
        note: "",
        courses: [],
      },
    };
  }
  const coursesRaw = Array.isArray(raw["courses"]) ? raw["courses"] : [];
  if (!coursesRaw.length) return { error: "缺少 courses（重考课程数组）——除非 retake_needed=false，否则必须给出重考课程" };
  if (coursesRaw.length > MAX_COURSES) return { error: `courses 超过 ${MAX_COURSES} 门，太多了` };
  const courses: RetakeDraft["courses"] = [];
  for (const c of coursesRaw) {
    const title = String((c as Record<string, unknown>)?.["title"] ?? "").trim();
    if (!title) return { error: "courses 里有课程缺 title（必须是精确课程名）" };
    const kpsRaw = Array.isArray((c as Record<string, unknown>)?.["kps"]) ? (c as Record<string, unknown>)["kps"] as unknown[] : [];
    const kps: Array<{ name: string; count: number }> = [];
    for (const k of kpsRaw) {
      const name = String((k as Record<string, unknown>)?.["name"] ?? "").trim();
      if (!name) return { error: `课程「${title}」的 kps 里有项缺 name` };
      const count = Math.max(1, Math.min(MAX_KP_COUNT, Math.round(Number((k as Record<string, unknown>)?.["count"]) || 1)));
      kps.push({ name, count });
    }
    courses.push({ title, kps });
  }
  let title = String(raw["title"] ?? "").trim();
  if (!title) title = "重考";
  if (!title.startsWith("重考")) title = `重考：${title}`;
  return {
    draft: {
      retakeNeeded: true,
      reason: "",
      title,
      note: String(raw["note"] ?? "").trim(),
      courses,
    },
  };
}

/** 校验结果：合法 → 待写入的 scope 课程展开；非法 → 反馈给模型的错误。 */
export interface RetakeValidation {
  error?: string;
  entries?: PlanCourseSpec[];
}

/** 课程/知识点存在性校验 + scope 展开（复用 custom 计划同一条 buildPlanSpecEntries 链路）。 */
export function validateRetakeCourses(
  args: { dataDir: string; parentId: string; childId: string },
  draft: RetakeDraft
): RetakeValidation {
  if (!draft.retakeNeeded) return { entries: [] };
  const titles = draft.courses.map((c) => c.title);
  const pl = openParentLib(args.dataDir, args.parentId);
  try {
    const kb = openKb(args.dataDir, args.parentId, args.childId);
    let rows: Array<{ title: string; topic: string }>;
    try {
      const qmarks = titles.map(() => "?").join(",");
      rows = kb.prepare(`SELECT title, topic FROM courses WHERE title IN (${qmarks})`).all(...titles) as Array<{
        title: string;
        topic: string;
      }>;
    } finally {
      kb.close();
    }
    const found = new Set(rows.map((r) => r.title));
    const notFound = titles.filter((t) => !found.has(t));
    if (notFound.length) {
      return { error: `这些课程名在孩子课程库里不存在（必须用精确课程名）：${notFound.join("、")}` };
    }
    // kps 显式与否分两组（require 是计划级参数，不能让「未指定 kps 的课」被别课的知识点误过滤）
    const withKps = draft.courses.filter((c) => c.kps.length > 0);
    const withoutKps = draft.courses.filter((c) => c.kps.length === 0);
    const pick = (list: typeof draft.courses) => rows.filter((r) => list.some((c) => c.title === r.title));
    const entries: PlanCourseSpec[] = [];
    if (withKps.length) {
      const require: Record<string, number> = {};
      for (const c of withKps) for (const k of c.kps) require[k.name] = k.count;
      const r = buildPlanSpecEntries(pl, args.childId, pick(withKps), { require });
      if (r.missing.length) return { error: missingToError(r.missing) };
      entries.push(...r.entries);
    }
    if (withoutKps.length) {
      const r = buildPlanSpecEntries(pl, args.childId, pick(withoutKps));
      if (r.missing.length) return { error: missingToError(r.missing) };
      entries.push(...r.entries);
    }
    if (!entries.length) return { error: "按给定课程/知识点没有展开出任何可考内容（课程需已挂知识点和题库题）" };
    return { entries };
  } finally {
    pl.close();
  }
}

function missingToError(missing: Array<{ title: string; reason: string }>): string {
  return `重考范围无法成立：${missing.map((m) => `${m.title}（${m.reason}）`).join("；")}。请改用该课真实存在的知识点名，或换课程。`;
}

// ==================== 设置项：重考是否计入评分档 ====================

/** 家长维度设置（settings 键 `exam_retake:<parentId>`，对齐 exam_fixed 先例）。默认不计入评分档。 */
export function getRetakeCountInRate(db: DatabaseSync, parentId: string): boolean {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`exam_retake:${parentId}`) as
    | { value_json?: string }
    | undefined;
  if (!row?.value_json) return false;
  try {
    const cfg = JSON.parse(row.value_json) as { count_in_rate?: unknown };
    return Number(cfg.count_in_rate) === 1;
  } catch {
    return false;
  }
}

export function setRetakeCountInRate(db: DatabaseSync, parentId: string, value: boolean): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value_json, updated) VALUES (?, ?, ?)").run(
    `exam_retake:${parentId}`,
    JSON.stringify({ count_in_rate: value ? 1 : 0 }),
    new Date().toISOString()
  );
}

// ==================== 钩子主体 ====================

export interface RetakeHookResult {
  /** retake 字段有值且进入了生成流程（字段为空时为 false，其余字段无意义）。 */
  triggered: boolean;
  /** 重考是否需要/已创建：needed=false（标准未触发）或创建失败时为 false。 */
  planId?: string;
  created?: boolean;
  /** 无需重考的原因 / 失败原因（家长 agent 与日志可见）。 */
  note?: string;
}

export interface RetakeHookArgs {
  dataDir: string;
  db: DatabaseSync; // 主库（settings/children/attempt 真源）
  parentId: string;
  childId: string;
  planId: string;
  attemptId: string;
  examTitle: string;
  score: number;
  perQuestion: unknown;
  now?: Date;
  /** 测试注入：默认用考核 LLM 会话（同会话多轮 = 错误反馈重试环）。 */
  ask?: (prompt: string) => Promise<string>;
}

/** 提交路由的评分后钩子：原计划 retake 有值 → 生成并创建当天重考计划。绝不抛错、绝不影响评分落库。 */
export async function maybeCreateRetakePlan(args: RetakeHookArgs): Promise<RetakeHookResult> {
  const now = args.now ?? new Date();
  const kb = openKb(args.dataDir, args.parentId, args.childId);
  let retake = "";
  try {
    const plan = kb.prepare("SELECT retake, title FROM exam_plans WHERE id = ? AND child_id = ?").get(args.planId, args.childId) as
      | { retake?: string; title?: string }
      | undefined;
    retake = String(plan?.retake ?? "").trim();
  } finally {
    kb.close();
  }
  if (!retake) return { triggered: false };

  const planId = `retake_${args.planId}`;
  // 幂等：同一原计划的重考计划只建一次（重复提交/补偿重跑直接命中）
  const kb2 = openKb(args.dataDir, args.parentId, args.childId);
  try {
    const exists = kb2.prepare("SELECT id FROM exam_plans WHERE id = ?").get(planId);
    if (exists) return { triggered: true, planId, created: false, note: "重考计划已存在" };
  } finally {
    kb2.close();
  }

  const childRow = args.db.prepare("SELECT name FROM children WHERE id = ?").get(args.childId) as { name?: string } | undefined;
  const pd = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${pd(now.getMonth() + 1)}-${pd(now.getDate())}`;
  const perQuestion = Array.isArray(args.perQuestion) ? (args.perQuestion as Array<Record<string, unknown>>) : [];
  const scoreMax = perQuestion.reduce((s, q) => s + (Number(q.pointMax) || 0), 0);

  const prompt = buildRetakePrompt({
    retake,
    examTitle: args.examTitle || "考核",
    childName: childRow?.name ?? "",
    score: args.score,
    scoreMax,
    dateStr,
    perQuestion,
  });

  // LLM 会话：统一收敛成 ask(prompt) => assistant 文本。默认真实链路（同会话多轮 = 错误反馈重试环）；
  // 测试注入 ask 直接脚本化各轮输出。
  let ask: (p: string) => Promise<string>;
  let session: { dispose(): void } | null = null;
  try {
    if (args.ask) {
      ask = args.ask;
    } else {
      const deps: ExamEngineDeps = { dataDir: args.dataDir, db: args.db, parentId: args.parentId, childId: args.childId };
      const s = await createExamSession(deps, RETAKE_SYSTEM_PROMPT);
      session = s;
      ask = async (p: string) => {
        await s.prompt(p);
        return lastAssistantText(s);
      };
    }
  } catch (e) {
    const msg = `重考计划生成失败（LLM 会话不可用）：${String((e as Error).message || e)}`;
    console.error(`[exam-retake] ${msg}`);
    return { triggered: true, planId: undefined, created: false, note: msg };
  }

  const t0 = Date.now();
  try {
    let feedback = "";
    for (let turn = 0; turn < MAX_LLM_TURNS; turn++) {
      if (Date.now() - t0 > WALL_BUDGET_MS) break; // 客户端提交超时保护
      const text = String(await ask(turn === 0 ? prompt : feedback));
      const { draft, error: schemaError } = parseRetakeDraft(text);
      if (!draft) {
        feedback = `你上一轮的输出有问题：${schemaError}。请修正后重新只输出 JSON。`;
        continue;
      }
      if (!draft.retakeNeeded) {
        return { triggered: true, created: false, note: `无需重考：${draft.reason}` };
      }
      const v = validateRetakeCourses({ dataDir: args.dataDir, parentId: args.parentId, childId: args.childId }, draft);
      if (v.error) {
        feedback = `你上一轮的重考计划无法创建：${v.error}\n请修正后重新只输出 JSON（格式同前）。`;
        continue;
      }
      // —— 创建（服务端强制：retake=''、count_in_rate 按设置、当天窗口、确定性 id）——
      const countInRate = getRetakeCountInRate(args.db, args.parentId) ? 1 : 0;
      const scope = JSON.stringify({
        courses: v.entries,
        ...(draft.note ? { note: draft.note } : {}),
        retake_of: args.planId,
      });
      const nowIso = new Date().toISOString();
      const kbw = openKb(args.dataDir, args.parentId, args.childId);
      try {
        kbw
          .prepare(
            `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
               start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at,retake)
             VALUES (?,?,?,?,'parent','custom','',?, 'retake','', ?, ?, 'pending','',NULL,'','','required',?,0,1,?,?,'')`
          )
          .run(planId, args.parentId, args.childId, draft.title, scope, `${dateStr} 00:00:00`, `${dateStr} 23:59:59`, countInRate, nowIso, nowIso);
      } finally {
        kbw.close();
      }
      return { triggered: true, planId, created: true };
    }
    const msg = `重考计划生成失败（重试 ${MAX_LLM_TURNS} 轮仍未通过校验），评分结果已正常保存，请人工创建重考计划`;
    console.error(`[exam-retake] ${msg} plan=${args.planId}`);
    return { triggered: true, created: false, note: msg };
  } catch (e) {
    const msg = `重考计划生成失败：${String((e as Error).message || e)}（评分结果已正常保存）`;
    console.error(`[exam-retake] plan=${args.planId}`, e);
    return { triggered: true, created: false, note: msg };
  } finally {
    try {
      session?.dispose();
    } catch {
      /* 忽略 */
    }
  }
}
