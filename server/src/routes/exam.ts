/**
 * 学习考核（EXAM-REQUIREMENTS.md）——服务端：内容真源 + 存储，不跑判分 LLM。
 * 2026-09-14 考核域重构：exam_schedules 排期表已取消——
 * - 每日/每周固定考核改为**配置项**（settings `exam_fixed:<parentId>`），worker 每天检查配置生成当天的
 *   孩子库 exam_plans 考核计划行（GET 列表时幂等补跑兜底）；
 * - 自定义考核（家长对话 / 管理面板）**直接写入孩子库 exam_plans**；
 * - `/exam/schedules*` 路由路径保留（渲染层零改动），但语义全部改为操作 exam_plans 考核计划。
 * - GET  /api/v1/exam/config/:childId   考核配置下发（?schedule=<exam_plans 行 id>；结构化直出题或课程知识点 + assess_method + 判分 prompt）
 * - POST /api/v1/exam/attempts          提交一次考核结果（客户端判分后上报；语音经 /files/upload 先行上传，这里引用 fileId；scheduleId=考核计划行 id）
 * - GET  /api/v1/exam/attempts/:childId 家长查询考核记录列表（按时间倒序）
 * - GET  /api/v1/exam/course-records/:childId 每课程考核记录表（最近考核/掌握/难点/亮点/计划复习）
 * 鉴权：家长 JWT；childId 必须归属该家长。语音大文件复用 files 通道（child_id 关联）。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { openKb } from "../db/kb.js";
import { openParentLib } from "../db/parent-lib.js";
import { attachStructuredQuestions, attachPlanQuestions, buildPlanSpecEntries, parsePlanCourses, type PlanCourseSpec } from "../assess-selection.js";
import {
  getOrCreateKnowledgePoint,
  saveQuestion,
  getQuestion,
  getCourseUuid,
  replaceCourseContent,
  listCourseContent,
  listKnowledgePoints,
  listTopicKnowledgePoints,
  getMethodSpec,
  saveMethodSpec,
  listAllBankQuestions,
} from "../db/assess-content.js";

interface ExamDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

function authParent(req: { headers: Record<string, string | string[] | undefined> }, secret: string): string {
  const header = req.headers.authorization;
  const token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) throw new ApiError(401, "缺少 session token");
  try {
    return verifySession(token, secret).parent_id;
  } catch {
    throw new ApiError(401, "session 无效或已过期，请重新登录");
  }
}

function assertChildOwned(db: DatabaseSync, parentId: string, childId: string): void {
  const row = db.prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?").get(childId, parentId);
  if (!row) throw new ApiError(403, "无权访问该孩子的数据");
}

function handleAuthError(err: unknown, reply: any): boolean {
  if (err instanceof ApiError) {
    reply.code(err.status).send({ error: err.message });
    return true;
  }
  return false;
}

/**
 * 判分 prompt（服务端单一真源，客户端判分 session 用此 prompt 执行）。
 * 客户端拿到后拼入本场考核的题目与孩子答案；scoring 为本题评分标准/参考答案文本。
 * ⚠️ `{{TODAY}}` 占位符在下发时被替换为服务器当天日期（YYYY-MM-DD）——不注入日期，
 * LLM 会瞎猜复习日期（实测产出 2025-03-24 之类的错误年份）。
 */
export const SCORING_PROMPT = `你是孩子的学习考核评估老师。今天是 {{TODAY}}。下面按课程给出：1) 该课考核要点(rubric，含知识点与评分标准)；2) 该课每道主观题 + 孩子的口头回答(ASR 转写文本，可能有语音识别误差，请结合题意合理理解)；3) 每题用时。
请逐题评估并只输出严格的 JSON（不要输出其它文字、不要生成复习计划/课程掌握度），格式：
{
  "perQuestion": [
    {
      "qid": "题号",
      "pointGot": 分数(0~pointMax 的整数),
      "correct": true|false,
      "aiComment": "评语：答到了哪些要点、遗漏或理解错误在哪，30~60字"
    }
  ],
  "overall": "整体评估一句话"
}
评分标准：严格按 rubric 的评分标准逐要点给分；pointMax 由题目给定，答到要点得分、明显错误或答非所问给低分；正确率=得分达到该题 60% 以上视为 correct。请客观、对低龄孩子语气温和、鼓励为主。`;

/** 下发判分 prompt：把 {{TODAY}} 占位符替换为服务器当天日期（判分口径仍服务端单一真源）。 */
export function buildScoringPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return SCORING_PROMPT.replaceAll("{{TODAY}}", today);
}

function rowToAttempt(r: Record<string, unknown>): Record<string, unknown> {
  const parse = (s: unknown, fb: unknown): unknown => {
    if (typeof s !== "string" || !s) return fb;
    try {
      return JSON.parse(s);
    } catch {
      return fb;
    }
  };
  return {
    id: String(r.id),
    childId: String(r.child_id),
    topic: String(r.topic ?? ""),
    title: String(r.title ?? ""),
    startedAt: String(r.started_at ?? ""),
    submittedAt: String(r.submitted_at ?? ""),
    status: String(r.status ?? "grading"),
    score: Number(r.score) || 0,
    perQuestion: parse(r.per_question, []),
    courseMastery: parse(r.course_mastery, {}),
    reinforcePlan: parse(r.reinforce_plan, {}),
    wrongQuestions: parse(r.wrong_questions, []),
    scheduleId: String(r.schedule_id ?? ""),
  };
}

// ==================== 考核 v2：固定频率配置 / 排期生成（EXAM-REQUIREMENTS §14） ====================

interface FixedExamConfig {
  /** 固定考核频率档：daily | weekly（UI 标签管理；monthly/halfyear/yearly 2026-09-09 起下线，历史排期不可再考） */
  frequencies: string[];
  /** 每轮考核的课程数 N（§14.3，默认 3；v3 起数量由选课 prompt 规则决定，此字段仅兼容保留） */
  courseCount: number;
  /** 每日考核时刻 HH:mm（默认 20:00，孩子晚上学习时段） */
  time: string;
  /** 每周考核：周几几点（weekday 1=周一…7=周日；time HH:mm；缺省用 time） */
  weekly: { weekday: number; time: string };
  /** 首次生成锚点（ISO）；仅 legacy 步进用，daily/weekly 按各自时刻实时定位 */
  anchorAt: string;
  /** ⚠️ 遗留：2026-09-09 起 daily/weekly 不再用选课 prompt / 选课 LLM——固定档=计划周期内必学课全部考核（内置规则）；
   * 该字段仅为旧版本保存的数据兼容保留，新逻辑不读取。 */
  selectionPrompts: Record<string, string>;
}

const DEFAULT_FIXED_CONFIG: FixedExamConfig = {
  frequencies: ["weekly"],
  courseCount: 3,
  time: "20:00",
  weekly: { weekday: 1, time: "20:00" },
  anchorAt: "",
  selectionPrompts: {},
};

/** ⚠️ 遗留常量：2026-09-09 起固定档不再用选课 prompt（内置=计划必学课全考），该表只保留供旧配置数据兼容展示。
 *  monthly/halfyear/yearly 档已下线（对应模板删除）。 */
export const DEFAULT_SELECTION_PROMPTS: Record<string, string> = {
  daily:
    "【内置规则 · 每日考核】本周期学习计划里的**必学主题**课程全部考核（选学主题课程不纳入，除非自定义考核点名）。",
  weekly:
    "【内置规则 · 每周考核】本周期学习计划里的**必学主题**课程全部考核（选学主题课程不纳入，除非自定义考核点名）。",
};

function getFixedConfig(db: DatabaseSync, parentId: string): FixedExamConfig {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .get(`exam_fixed:${parentId}`) as { value_json?: string } | undefined;
  let cfg: FixedExamConfig;
  if (!row?.value_json) {
    cfg = { ...DEFAULT_FIXED_CONFIG };
  } else {
    try {
      cfg = { ...DEFAULT_FIXED_CONFIG, ...(JSON.parse(row.value_json) as Partial<FixedExamConfig>) };
    } catch {
      cfg = { ...DEFAULT_FIXED_CONFIG };
    }
  }
  // 选课 prompt：默认 + 家长覆盖合并（缺省档位回退默认模板）
  cfg.selectionPrompts = { ...DEFAULT_SELECTION_PROMPTS, ...(cfg.selectionPrompts ?? {}) };
  // weekly 缺省回退（旧数据无 weekly 字段）：周一 20:00
  if (!cfg.weekly || typeof cfg.weekly !== "object") cfg.weekly = { weekday: 1, time: cfg.time || "20:00" };
  if (!cfg.weekly.time) cfg.weekly.time = cfg.time || "20:00";
  if (!cfg.weekly.weekday || cfg.weekly.weekday < 1 || cfg.weekly.weekday > 7) cfg.weekly.weekday = 1;
  return cfg;
}

/** 固定考核频率档校验表（配置保存时过滤非法档；monthly+ 已下线不再生成）。 */
const FREQ_RANK: Record<string, number> = { daily: 1, weekly: 2, monthly: 3, halfyear: 4, yearly: 5 };

/** 频率档中文标签（排期标题展示）。 */
export function freqLabel(freq: string): string {
  switch (freq) {
    case "daily":
      return "每天";
    case "weekly":
      return "每周";
    case "monthly":
      return "每月";
    case "halfyear":
      return "每半年";
    case "yearly":
      return "每年";
    default:
      return freq || "每周";
  }
}

/** 当日（本地时区）0 点时间戳，用于同日去重。 */
function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 固定考核：配置项 → 当天考核计划生成（幂等）。
 * 2026-09-14 重构：exam_schedules 排期表已取消——每日/每周固定考核改为**配置项**
 * （settings `exam_fixed:<parentId>`，家长设置页维护），worker 每天（plan tick）检查配置、
 * 为当天生成孩子库 exam_plans 考核计划行；本函数幂等（同 child+日+freq 已有 active 计划则跳过），
 * 因此 GET 考核计划列表时也会补跑一次，兜底 worker 停机/重启场景。
 * - daily：每天生成一条「当天可考」计划；
 * - weekly：仅当今天是配置的周几（cfg.weekly.weekday，1=周一…7=周日）时生成；
 * - 同日 daily+weekly 都命中 → 只保留 weekly（沿用旧「同日只留周期最长档」口径）；
 * - monthly/halfyear/yearly 已下线（2026-09-09），不再生成。
 */
export function ensureTodayExamPlans(db: DatabaseSync, dataDir: string, parentId: string): number {
  const cfg = getFixedConfig(db, parentId);
  const freqs = (cfg.frequencies ?? []).filter((f) => f === "daily" || f === "weekly");
  if (!freqs.length) return 0;
  const now = new Date();
  const want: string[] = [];
  if (freqs.includes("weekly")) {
    const weekday = Number(cfg.weekly?.weekday) || 1;
    if (weekday % 7 === now.getDay()) want.push("weekly");
  }
  if (freqs.includes("daily") && !want.includes("weekly")) want.push("daily");
  if (!want.length) return 0;

  const day = localDateStr(now.getTime()); // YYYY-MM-DD（本地时区）
  const children = db.prepare("SELECT id FROM children WHERE parent_id = ?").all(parentId) as Array<{ id: string }>;
  let n = 0;
  for (const c of children) {
    const kb = openKb(dataDir, parentId, c.id);
    try {
      for (const freq of want) {
        const dup = kb
          .prepare(
            "SELECT id FROM exam_plans WHERE child_id = ? AND kind = 'fixed' AND freq = ? AND active = 1 AND substr(start_at,1,10) = ?"
          )
          .get(c.id, freq, day);
        if (dup) continue;
        // 生成计划时即**完整约定出题参数**（2026-09-14 定案）：展开本窗口「必学」课程 →
        // 每课 {title, kps:[{name,count}]} 写入 scope；没有挂知识点/题库题的课程跳过（记日志）。
        const win = planWindowFor(freq, now.getTime());
        let entries: PlanCourseSpec[] = [];
        let skipped: string[] = [];
        try {
          const pl = openParentLib(dataDir, parentId);
          try {
            const { courses: planCourses } = listPlanCourseMeta(db, dataDir, parentId, c.id, win.start, win.end);
            const must = planCourses.filter((x) => x.topicType !== "选学");
            const cs0 = fetchCoursesWithKnowledgePoints(dataDir, parentId, c.id, must.map((x) => x.title));
            const r = buildPlanSpecEntries(pl, c.id, cs0, null);
            entries = r.entries;
            skipped = r.missing.map((m) => `${m.title}（${m.reason}）`);
          } finally {
            pl.close();
          }
        } catch (e) {
          console.warn(`[exam] 固定计划出题约定展开失败（child=${c.id}）：${(e as Error).message}`);
          continue;
        }
        if (skipped.length) {
          console.warn(`[exam] 固定考核跳过无考核内容的课程（child=${c.id}，freq=${freq}）：${skipped.join("；")}`);
        }
        if (!entries.length) {
          continue; // 该孩子本周期没有任何可考课程 → 不生成空计划
        }
        kb.prepare(
          `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
             start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
           VALUES (?,?,?,?,'parent','fixed',?,?,'config','','?',?,'pending','',NULL,'','required',1,0,1,?,?)`
        ).run(
          `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          parentId,
          c.id,
          `固定考核（${freqLabel(freq)}）`,
          freq,
          JSON.stringify({ courses: entries } as { courses: PlanCourseSpec[] }),
          `${day} 00:00:00`,
          `${day} 23:59:59`,
          now.toISOString(),
          now.toISOString()
        );
        n++;
      }
    } finally {
      kb.close();
    }
  }
  return n;
}

/** 在该家长所有孩子的孩子库里定位一条考核计划（exam_plans 按 child 分库，路由只有 id 时用它）。 */
function findExamPlanRow(
  db: DatabaseSync,
  dataDir: string,
  parentId: string,
  planId: string
): { childId: string; row: Record<string, unknown> } | null {
  const children = db.prepare("SELECT id FROM children WHERE parent_id = ?").all(parentId) as Array<{ id: string }>;
  for (const c of children) {
    const kb = openKb(dataDir, parentId, c.id);
    try {
      const row = kb.prepare("SELECT * FROM exam_plans WHERE id = ? AND active = 1").get(planId) as
        | Record<string, unknown>
        | undefined;
      if (row) return { childId: c.id, row };
    } catch {
      /* 单个孩子库异常继续找下一个 */
    } finally {
      kb.close();
    }
  }
  return null;
}

/** 某课程最近一次考核时间（从 exam_attempts.perQuestion 按 course 聚合，取最新 submitted_at）。 */
function lastExamAtByCourse(db: DatabaseSync, childId: string): Map<string, string> {
  const rows = db
    .prepare(
      "SELECT submitted_at, per_question FROM exam_attempts WHERE child_id = ? AND per_question != '[]' ORDER BY submitted_at"
    )
    .all(childId) as Array<{ submitted_at: string; per_question: string }>;
  const map = new Map<string, string>();
  for (const r of rows) {
    try {
      const pq = JSON.parse(r.per_question) as Array<{ course?: string }>;
      for (const q of pq) {
        const c = String(q?.course ?? "");
        if (c && !map.has(c)) map.set(c, r.submitted_at);
      }
    } catch {
      /* 忽略坏行 */
    }
  }
  return map;
}

/** 最近一次考核的 reinforce_plan（按 course 的 planReviewAt，供选课「复习计划到期」打分）。 */
function latestReinforcePlan(db: DatabaseSync, childId: string): Record<string, { planReviewAt?: string; focus?: string[] }> {
  const row = db
    .prepare("SELECT reinforce_plan FROM exam_attempts WHERE child_id = ? AND reinforce_plan != '{}' ORDER BY submitted_at DESC LIMIT 1")
    .get() as { reinforce_plan?: string } | undefined;
  if (!row?.reinforce_plan) return {};
  try {
    return JSON.parse(row.reinforce_plan);
  } catch {
    return {};
  }
}

/** 全部「有学习痕迹」课程的元数据（选课 LLM 的候选清单；不含知识点全文，控制 prompt 体积）。
 *  口径：学习过（first_learned）或复习过（last_review）或已学标记（status='✅'）的课程；
 *  已学但日期未知的课程 firstLearned 记为 "✅"（归属「更早学习」，可被每月「本月前 25%」等规则选中）。 */
function listLearnedCourseMeta(
  db: DatabaseSync,
  dataDir: string,
  parentId: string,
  childId: string
): CourseMeta[] {
  const kb = openKb(dataDir, parentId, childId);
  const parent = openParentLib(dataDir, parentId);
  try {
    const topicNames = new Map(
      (parent.prepare("SELECT topic_key, name FROM topics").all() as Array<{ topic_key: string; name: string }>).map((r) => [r.topic_key, r.name])
    );
    // 必学/选学/复习：孩子库 topics.rules_json.type（家长给孩子设置的「主题类型」，考核选题标注；
    // 旧「每天学习量」daily 已停用 ISSUE-033）。
    // 家长考核 prompt 里的「必学课程」即主题类型=必学 的主题下的课程——注入到候选清单让选课 LLM 可筛选。
    const childTopicTypes = new Map(
      (kb.prepare("SELECT topic_key, rules_json FROM topics").all() as Array<{ topic_key: string; rules_json: string }>).map((r) => {
        let type = "";
        try {
          type = String((JSON.parse(r.rules_json || "{}") as { type?: string }).type || "");
        } catch {
          /* 损坏的 rules_json 视为未标注 */
        }
        return [r.topic_key, type] as const;
      })
    );
    // 2026-09-10：掌握度列已删；候选口径 = 有学习/复习时间（last_review）或已学标记（status='✅'）
    const rows = kb
      .prepare(
        "SELECT topic, title, last_review, status FROM courses WHERE (last_review != '' OR status = '✅') ORDER BY topic, sort_order, title"
      )
      .all() as Array<{ topic: string; title: string; last_review: string; status: string }>;
    const lastExam = lastExamAtByCourse(db, childId);
    const reinforce = latestReinforcePlan(db, childId);
    return rows.map((r) => {
      const lr = r.last_review ?? "";
      const learnedNoDate = String(r.status ?? "").trim() === "✅" && !lr;
      return {
        topic: r.topic,
        topicName: topicNames.get(r.topic) ?? r.topic,
        title: r.title,
        topicType: childTopicTypes.get(r.topic) ?? "",
        firstLearned: learnedNoDate ? "✅" : "", // 仅作「已学无日期」标记，不再表示首次学习时间
        lastReview: lr,
        mastery: "",
        examMastery: "",
        lastExamAt: lastExam.get(r.title) ?? "",
        planReviewAt: reinforce[r.title]?.planReviewAt ?? "",
      };
    });
  } finally {
    kb.close();
    parent.close();
  }
}

/**
 * 课程综合学习情况（家长计划/复习决策用「一站式」查询）：一次性聚合每门课
 *   学习时间(first_learned) / 复习时间(last_review) / 复习次数(review_count) /
 *   考核时间(最近一次) / 考核次数(含该课的不同 attempt 数) /
 *   学习情况(status + mastery) / 复习情况 / 考核情况(exam_mastery + 累计正确率)。
 * 考试数据来自主库 exam_attempts（按 per_question.course 聚合），学习/复习数据来自孩子库 courses。
 * 仅纳入「有学习/复习/考核信号」的课程（复习计划制定聚焦于已学课程）。
 */
function listCourseStatus(
  db: DatabaseSync,
  dataDir: string,
  parentId: string,
  childId: string
): Array<Record<string, unknown>> {
  const kb = openKb(dataDir, parentId, childId);
  const parent = openParentLib(dataDir, parentId);
  try {
    const topicNames = new Map(
      (parent.prepare("SELECT topic_key, name FROM topics").all() as Array<{ topic_key: string; name: string }>).map((r) => [r.topic_key, r.name])
    );
    const childTopicTypes = new Map(
      (kb.prepare("SELECT topic_key, rules_json FROM topics").all() as Array<{ topic_key: string; rules_json: string }>).map((r) => {
        let type = "";
        try {
          type = String((JSON.parse(r.rules_json || "{}") as { type?: string }).type || "");
        } catch {
          /* 损坏的 rules_json 视为未标注 */
        }
        return [r.topic_key, type] as const;
      })
    );
    // 考核聚合：按 course 统计 考核次数(不同 attempt) / 最近考核时间 / 累计正确率
    const examRows = db
      .prepare("SELECT id, submitted_at, per_question FROM exam_attempts WHERE child_id = ? AND per_question != '[]'")
      .all(childId) as Array<{ id: string; submitted_at: string; per_question: string }>;
    const examStat = new Map<string, { ids: Set<string>; lastAt: string; correct: number; total: number }>();
    for (const er of examRows) {
      let pq: Array<Record<string, unknown>> = [];
      try {
        pq = JSON.parse(er.per_question) as Array<Record<string, unknown>>;
      } catch {
        pq = [];
      }
      for (const q of pq) {
        const course = String(q.course ?? "");
        if (!course) continue;
        const got = Number(q.pointGot) || 0;
        const max = Number(q.pointMax) || 0;
        const isCorrect = max > 0 && got >= max * 0.6;
        let s = examStat.get(course);
        if (!s) {
          s = { ids: new Set<string>(), lastAt: "", correct: 0, total: 0 };
          examStat.set(course, s);
        }
        s.ids.add(er.id);
        s.total += 1;
        if (isCorrect) s.correct += 1;
        if (er.submitted_at > s.lastAt) s.lastAt = er.submitted_at;
      }
    }
    const reinforce = latestReinforcePlan(db, childId);
    // 计划域重构（2026-09-10）：掌握度口径改为「最近一次考核」（course_progress 视图；学习侧只报最近学习时间）。
    // 旧的 courses.mastery/exam_mastery 列保留但不再作为掌握度口径（物理删列留下一版，避免运行时断裂）。
    const progress = new Map<string, { lastExamAt: string; lastExamRate: number | null; lastLearnedAt: string }>();
    try {
      const rows = kb
        .prepare("SELECT title, lastExamAt, lastExamRate, lastLearnedAt FROM course_progress")
        .all() as Array<{ title: string; lastExamAt: string | null; lastExamRate: number | null; lastLearnedAt: string | null }>;
      for (const r of rows) {
        progress.set(String(r.title), {
          lastExamAt: String(r.lastExamAt ?? ""),
          lastExamRate: r.lastExamRate == null ? null : Number(r.lastExamRate),
          lastLearnedAt: String(r.lastLearnedAt ?? ""),
        });
      }
    } catch {
      /* 视图不存在（未迁移库）则跳过 */
    }
    const rows = kb
      .prepare(
        "SELECT topic, title, status, last_review, review_count FROM courses ORDER BY topic, sort_order, title"
      )
      .all() as Array<{
        topic: string;
        title: string;
        status: string;
        last_review: string;
        review_count: number;
      }>;
    const out: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      const lr = r.last_review ?? "";
      const learnedNoDate = String(r.status ?? "").trim() === "✅" && !lr;
      const es = examStat.get(r.title);
      const rp = reinforce[r.title];
      // 仅纳入有学习/复习/考核信号的课程（复习计划制定聚焦于已学课程）
      if (!lr && String(r.status ?? "").trim() !== "✅" && !es) continue;
      // 掌握度口径（2026-09-10 重构）：**只取最近一次考核**（progress.lastExamRate）；
      // 学习状态只报最近学习时间（progress.lastLearnedAt）。旧列 mastery/exam_mastery 不再作为口径。
      const pg = progress.get(r.title);
      const lastExamRate = pg?.lastExamRate ?? null;
      out.push({
        topic: r.topic,
        topicName: topicNames.get(r.topic) ?? r.topic,
        title: r.title,
        topicType: childTopicTypes.get(r.topic) ?? "",
        status: r.status ?? "⬜",
        // ↓ 新口径
        lastLearnedAt: pg?.lastLearnedAt || lr,
        lastExamRate, // 最近一次考核得分率（0~1），null=未考过
        lastExamAtNew: pg?.lastExamAt ?? "",
        // ↓ 兼容保留（家长端旧字段）：mastery 恒空（已无该列）；firstLearned 仅作「已学无日期」标记
        mastery: "",
        firstLearned: learnedNoDate ? "✅" : "",
        lastReview: lr,
        reviewCount: Number(r.review_count) || 0,
        lastExamAt: pg?.lastExamAt || es?.lastAt || "",
        examCount: es?.ids.size ?? 0,
        examMastery: lastExamRate == null ? "" : String(lastExamRate),
        examRate: es && es.total ? Math.round((es.correct / es.total) * 1000) / 1000 : 0,
        planReviewAt: rp?.planReviewAt ?? "",
        focus: Array.isArray(rp?.focus) ? rp!.focus!.map(String) : [],
      });
    }
    return out;
  } finally {
    kb.close();
    parent.close();
  }
}

/** 选课候选课程元数据（服务端第一段下发；两种来源：学习痕迹 / 学习计划）。 */
interface CourseMeta {
  topic: string;
  topicName: string;
  title: string;
  topicType: string;
  firstLearned: string;
  lastReview: string;
  mastery: string;
  examMastery: string;
  lastExamAt: string;
  planReviewAt: string;
  /** 学习计划来源：该课在家长计划中排的（最早）日期 YYYY-MM-DD */
  planDate?: string;
}

/** 毫秒时间戳 → 本地日期 YYYY-MM-DD（学习计划 date 为家长本地日期语义，必须用本地而非 UTC）。 */
function localDateStr(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 固定档计划窗口：daily=今天；weekly=近 7 天（含今天，用户拍板 2026-09-03）。 */
function planWindowFor(freq: string, scheduledTs: number): { start: string; end: string; label: string } {
  const end = localDateStr(scheduledTs);
  if (freq === "daily") return { start: end, end, label: "今天" };
  const start = localDateStr(scheduledTs - 6 * 86400000);
  return { start, end, label: "近 7 天（含今天）" };
}

/** 从家长学习计划（study_plan_items，一课一行）构建考核候选（每日/每周固定档）：
 *  候选 = 窗口内（date∈[start,end]）计划行 course_name 的课程（真实课程名，精确匹配孩子库 title），
 *  **无论是否完成**（status pending 或已完成都进候选）——考核倒逼计划执行。
 *  返回 courses（含该课最早计划日期 planDate）+ unmatched（计划课程匹配不到课程的清单，供提示）。 */
function listPlanCourseMeta(
  db: DatabaseSync,
  dataDir: string,
  parentId: string,
  childId: string,
  start: string,
  end: string
): { courses: CourseMeta[]; unmatched: string[] } {
  const kb = openKb(dataDir, parentId, childId);
  const parent = openParentLib(dataDir, parentId);
  try {
    const topicNames = new Map(
      (parent.prepare("SELECT topic_key, name FROM topics").all() as Array<{ topic_key: string; name: string }>).map((r) => [r.topic_key, r.name])
    );
    const childTopicTypes = new Map(
      (kb.prepare("SELECT topic_key, rules_json FROM topics").all() as Array<{ topic_key: string; rules_json: string }>).map((r) => {
        let type = "";
        try {
          type = String((JSON.parse(r.rules_json || "{}") as { type?: string }).type || "");
        } catch {
          /* 损坏的 rules_json 视为未标注 */
        }
        return [r.topic_key, type] as const;
      })
    );
    const rows = db
      .prepare(
        "SELECT date, topic_key, course_name FROM study_plan_items WHERE parent_id = ? AND child_id = ? AND active = 1 AND date >= ? AND date <= ? ORDER BY date ASC"
      )
      .all(parentId, childId, start, end) as Array<{ date: string; topic_key: string; course_name: string }>;
    const want = new Map<string, string>(); // course_name → 最早计划日期
    for (const r of rows) {
      const title = (r.course_name || "").trim();
      if (!title) continue; // 一课一行，course_name 即真实课程名（无前缀），精确匹配
      if (!want.has(title) || r.date < want.get(title)!) want.set(title, r.date);
    }
    const lastExam = lastExamAtByCourse(db, childId);
    const courses: CourseMeta[] = [];
    const unmatched: string[] = [];
    for (const [title, planDate] of want) {
      const hit = kb
        .prepare("SELECT topic, status, last_review FROM courses WHERE title = ?")
        .all(title) as Array<{
        topic: string;
        status: string;
        last_review: string;
      }>;
      if (!hit.length) {
        unmatched.push(title);
        continue;
      }
      const r = hit[0]; // 同名跨主题歧义罕见：取首行（与 fetchCoursesWithRubric 的 title 口径一致）
      const lr = r.last_review ?? "";
      courses.push({
        topic: r.topic,
        topicName: topicNames.get(r.topic) ?? r.topic,
        title,
        topicType: childTopicTypes.get(r.topic) ?? "",
        firstLearned: String(r.status ?? "").trim() === "✅" && !lr ? "✅" : "",
        lastReview: lr,
        mastery: "",
        examMastery: "",
        lastExamAt: lastExam.get(title) ?? "",
        planReviewAt: "",
        planDate,
      });
    }
    courses.sort((a, b) => (a.planDate ?? "").localeCompare(b.planDate ?? "") || a.title.localeCompare(b.title));
    return { courses, unmatched };
  } finally {
    kb.close();
    parent.close();
  }
}


/** 取「课程 + 知识点详情 + 主题考核方法」（P3 起亦被 exam-agent 路由复用于服务端出题）。 */
export function fetchCoursesWithKnowledgePoints(
  dataDir: string,
  parentId: string,
  childId: string,
  titles: string[]
): Array<{ title: string; topic: string; firstLearned: string; lastReview: string; mastery: string; examMastery: string; knowledgePoints: Array<{ name: string; detail: string }>; assessMethod: string }> {
  const kb = openKb(dataDir, parentId, childId);
  const parent = openParentLib(dataDir, parentId);
  try {
    // 主题考核方法说明（家长可编辑，按孩子区分题目构成与不考范围）——出题 prompt 必须读到它，
    // 否则模型只会按知识点「全部出题」，家长在方法里写的"考什么/不考什么"全部落空。
    const methodMap = new Map(
      (parent.prepare("SELECT topic_key, assess_method FROM topics").all() as Array<{ topic_key: string; assess_method: string }>)
        .map((r) => [r.topic_key, String(r.assess_method || "")] as [string, string])
        .filter(([, v]) => !!v)
    );
    const out: Array<{ title: string; topic: string; firstLearned: string; lastReview: string; mastery: string; examMastery: string; knowledgePoints: Array<{ name: string; detail: string }>; assessMethod: string }> = [];
    for (const t of titles) {
      const kbRow = kb
        .prepare("SELECT topic, status, last_review FROM courses WHERE title = ?")
        .get(t) as { topic?: string; status?: string; last_review?: string } | undefined;
      if (!kbRow) continue; // 孩子库无此课 → 跳过
      const topic = String(kbRow.topic ?? "");
      const lr2 = String(kbRow.last_review ?? "");
      // 该课知识点（= 考核要点）：name + detail。结构化课程由服务端直出题；
      // 未挂题课程由客户端按知识点详情走 LLM 出题（旧 assess_rubric 已废弃）。
      let kps: Array<{ name: string; detail: string }> = [];
      const uuidRow = parent
        .prepare("SELECT uuid FROM courses WHERE topic = ? AND title = ?")
        .get(topic, t) as { uuid?: string } | undefined;
      if (uuidRow?.uuid) {
        kps = listKnowledgePoints(parent, uuidRow.uuid).map((k) => ({ name: k.name, detail: k.detail }));
      }
      out.push({
        title: t,
        topic,
        firstLearned: String(kbRow.status ?? "").trim() === "✅" && !lr2 ? "✅" : "",
        lastReview: lr2,
        mastery: "",
        examMastery: "",
        knowledgePoints: kps,
        assessMethod: methodMap.get(topic) ?? "",
      });
    }
    return out;
  } finally {
    kb.close();
    parent.close();
  }
}

export function registerExamRoutes(app: FastifyInstance, deps: ExamDeps): void {
  // ===== 考核配置下发（客户端出卷/判分所需：知识点 + rubric + 判分 prompt） =====
  app.get("/api/v1/exam/config/:childId", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    // 考核 v2（§14）+ 2026-09-14 重构：?schedule=<exam_plans 考核计划行 id>
    //  - 自定义考核计划（scope.courses 指定范围）：直接返回带 rubric 的课程（家长已定范围，不经过选课 LLM）
    //  - 固定考核计划：内置规则 = 计划周期内「必学」课程全部考核（范围在开考时按学习计划窗口实时计算）
    //  - 带 courses=title1,title2 参数：返回选中课程（含 rubric）+ 判分 prompt（第二段兼容路径）
    const planId = String((req.query as { schedule?: string }).schedule || "");
    const coursesParam = String((req.query as { courses?: string }).courses || "");
    if (planId) {
      const kb = openKb(deps.config.dataDir, parentId, childId);
      const plan = kb
        .prepare("SELECT * FROM exam_plans WHERE id = ? AND child_id = ? AND active = 1")
        .get(planId, childId) as Record<string, unknown> | undefined;
      kb.close();
      if (!plan) return reply.code(404).send({ error: "考核计划不存在或已取消" });
      const scope = (() => {
        try {
          return JSON.parse(String(plan.scope_json ?? "{}"));
        } catch {
          return {};
        }
      })();
      const schedule = {
        id: String(plan.id),
        kind: String(plan.kind || "custom"),
        freq: String(plan.freq ?? ""),
        title:
          String(plan.title || "") ||
          (String(plan.kind) === "custom" ? "自定义考核" : `固定考核（${freqLabel(String(plan.freq))}）`),
        scheduledAt: String(plan.start_at ?? ""),
        status: String(plan.status ?? "pending"),
        scope,
      };
      // 孩子显示名（考核方法 assess_method 常按孩子名分段，出题 prompt 需要点名当前孩子）
      const childRow = deps.db.prepare("SELECT name FROM children WHERE id = ?").get(childId) as { name?: string } | undefined;
      const childName = String(childRow?.name ?? "");
      // 结构化考核：课程有挂载内容时由服务端按孩子方法直接抽题（course.questions），不再客户端 LLM 出题；
      // 无挂载内容(非结构化)返回该课知识点详情，客户端按知识点走 LLM 出题。
      const structuredCourses = (titles: string[], methodOverride?: unknown) => {
        const cs = fetchCoursesWithKnowledgePoints(deps.config.dataDir, parentId, childId, titles);
        try {
          const pl = openParentLib(deps.config.dataDir, parentId);
          attachStructuredQuestions(pl, childId, cs, (methodOverride as never) ?? undefined);
          pl.close();
        } catch (e) {
          console.warn(`[exam] 结构化挂题失败（回退知识点出题路径）：${(e as Error).message}`);
        }
        return cs;
      };
      // 第二段（兼容旧客户端/二次请求）：带 courses= 参数 → 直接按课程名返回 rubric + 判分 prompt
      if (coursesParam) {
        const titles = coursesParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          schedule,
          childName,
          courses: structuredCourses(titles),
          scoringPrompt: buildScoringPrompt(),
        };
      }
      // 自定义考核（2026-09-14 定案）：**出题参数在计划生成时已完整约定**——scope.courses 为
      // [{title, kps:[{name,count}]}]（考哪些课程、每课考哪些知识点、各几题）。
      // 出题环节只按约定从题库抽题，不再有结构化/非结构化之分、不走主题方法、不走 LLM。
      if (String(plan.kind) === "custom") {
        const rawCourses = Array.isArray(scope.courses) ? scope.courses : [];
        let entries: PlanCourseSpec[];
        const isNewFormat = rawCourses.length > 0 && typeof rawCourses[0] === "object" && Array.isArray(rawCourses[0]?.kps);
        if (isNewFormat) {
          entries = rawCourses as PlanCourseSpec[];
        } else {
          // 旧格式（字符串课程名数组 + 可选 methodSpec）→ 现场展开成完整约定（懒迁移）
          const titles = rawCourses.map((x: unknown) => String(x ?? "").trim()).filter(Boolean);
          if (!titles.length) {
            return reply.code(400).send({
              error: "该自定义考核没有确定要考的课程。请让家长（或孩子）重新安排这次考核。",
            });
          }
          const pl0 = openParentLib(deps.config.dataDir, parentId);
          let expanded: PlanCourseSpec[] = [];
          let missing: Array<{ title: string; reason: string }> = [];
          try {
            const cs0 = fetchCoursesWithKnowledgePoints(deps.config.dataDir, parentId, childId, titles);
            const r = buildPlanSpecEntries(pl0, childId, cs0, (scope as { methodSpec?: never }).methodSpec ?? null);
            expanded = r.entries;
            missing = r.missing;
          } finally {
            pl0.close();
          }
          if (missing.length) {
            return reply.code(400).send({ error: `该考核计划的内容已不可用，请重新安排：${missing.map((m) => `${m.title}（${m.reason}）`).join("；")}` });
          }
          entries = expanded;
        }
        const titles = entries.map((e) => e.title);
        const cs = fetchCoursesWithKnowledgePoints(deps.config.dataDir, parentId, childId, titles);
        const pl = openParentLib(deps.config.dataDir, parentId);
        let problems: Array<{ title: string; reason: string }> = [];
        try {
          problems = attachPlanQuestions(pl, cs, entries, Math.max(0, Number((scope as { recitePass?: unknown }).recitePass) || 90));
        } finally {
          pl.close();
        }
        if (problems.length) {
          return reply.code(400).send({
            error: `出题失败，考核内容与计划不一致：${problems.map((p) => `${p.title}（${p.reason}）`).join("；")}。请让家长重新安排这次考核。`,
          });
        }
        return {
          schedule,
          childName,
          courses: cs,
          scoringPrompt: buildScoringPrompt(),
        };
      }
      // 固定档：仅保留 daily | weekly（monthly/halfyear/yearly 已下线，历史计划不可再考）
      const freq = String(plan.freq || "weekly");
      if (freq === "monthly" || freq === "halfyear" || freq === "yearly") {
        return reply.code(400).send({
          error: "每月/每半年/每年考核已下线（2026-09-09）。这类考核请改为「自定义考核」：通过和家长助手对话说明要考的内容即可。",
        });
      }
      // daily/weekly：固定考核计划由 worker 生成时**已把出题约定写进 scope**（每课知识点+题数，
      // 只含已挂题库题的课程）；出题按约定直出。旧格式（scope 无约定）走窗口规则现场展开。
      {
        const rawCourses = Array.isArray(scope.courses) ? scope.courses : [];
        const isNewFormat = rawCourses.length > 0 && typeof rawCourses[0] === "object" && Array.isArray(rawCourses[0]?.kps);
        let entries: PlanCourseSpec[];
        let skipped: string[] = [];
        if (isNewFormat) {
          entries = rawCourses as PlanCourseSpec[];
        } else {
          const ts = new Date(String(plan.start_at ?? "")).getTime();
          const win = planWindowFor(freq, Number.isNaN(ts) ? Date.now() : ts);
          const { courses: planCourses, unmatched } = listPlanCourseMeta(
            deps.db,
            deps.config.dataDir,
            parentId,
            childId,
            win.start,
            win.end
          );
          const must = planCourses.filter((c) => c.topicType !== "选学");
          if (!must.length) {
            const hasOnlyOptional = planCourses.length > 0;
            return reply.code(400).send({
              error: hasOnlyOptional
                ? `本次固定考核窗口（${win.start} ~ ${win.end}）的学习计划里只有「选学」课程，没有默认纳入考核的「必学」课程。如需考选学内容，请用自定义考核安排。`
                : `本次固定考核窗口（${win.start} ~ ${win.end}）的学习计划里还没有安排「必学」课程。可以让家长先在学习计划里排课，或改用自定义考核安排本次内容。`,
            });
          }
          const pl0 = openParentLib(deps.config.dataDir, parentId);
          try {
            const cs0 = fetchCoursesWithKnowledgePoints(deps.config.dataDir, parentId, childId, must.map((c) => c.title));
            const r = buildPlanSpecEntries(pl0, childId, cs0, null);
            entries = r.entries;
            skipped = r.missing.map((m) => `${m.title}（${m.reason}）`);
          } finally {
            pl0.close();
          }
          if (!entries.length) {
            return reply.code(400).send({
              error: `本次固定考核的课程都还没有考核内容（知识点/题库题），无法出题：${skipped.join("；")}。请先在考核内容建设中为这些课程补充知识点和题目。`,
            });
          }
        }
        const cs = fetchCoursesWithKnowledgePoints(deps.config.dataDir, parentId, childId, entries.map((e) => e.title));
        const pl = openParentLib(deps.config.dataDir, parentId);
        let problems: Array<{ title: string; reason: string }> = [];
        try {
          problems = attachPlanQuestions(pl, cs, entries, 90);
        } finally {
          pl.close();
        }
        if (problems.length) {
          return reply.code(400).send({
            error: `出题失败，考核内容与计划不一致：${problems.map((p) => `${p.title}（${p.reason}）`).join("；")}。`,
          });
        }
        return {
          schedule,
          childName,
          courses: cs,
          scoringPrompt: buildScoringPrompt(),
          // 生成计划时被跳过（无考核内容）的课程（供调试/提示）
          unmatched: skipped,
        };
      }
    }
    const kb = openKb(deps.config.dataDir, parentId, childId);
    const parent = openParentLib(deps.config.dataDir, parentId);
    try {
      // 只下发「写了考核方法说明」的主题；每主题下只带「学/复习过」的课程（考核对象=周期内学过的知识点）
      const topics = parent
        .prepare("SELECT name, topic_key, assess_method FROM topics WHERE assess_method != '' ORDER BY topic_key")
        .all() as Array<{ name: string; topic_key: string; assess_method: string }>;
      const out = [];
      for (const t of topics) {
        const learned = kb
          .prepare(
            "SELECT title, last_review FROM courses WHERE topic = ? AND (last_review != '' OR status = '✅') ORDER BY sort_order, title"
          )
          .all(t.topic_key) as Array<{ title: string; last_review: string }>;
        if (learned.length === 0) continue;
        // 每课考核要点 = 该课知识点（name + detail）
        const kpRows = listTopicKnowledgePoints(parent, t.topic_key);
        const kpMap = new Map<string, Array<{ name: string; detail: string }>>();
        for (const k of kpRows) {
          const arr = kpMap.get(k.courseTitle) || [];
          arr.push({ name: k.name, detail: k.detail });
          kpMap.set(k.courseTitle, arr);
        }
        out.push({
          topicKey: t.topic_key,
          name: t.name,
          assessMethod: t.assess_method,
          courses: learned.map((c) => ({
            title: c.title,
            firstLearned: "",
            lastReview: c.last_review ?? "",
            mastery: "", // 掌握度改由 course_progress 视图（最近一次考核）输出
            knowledgePoints: kpMap.get(c.title) ?? [],
          })),
        });
      }
      return { topics: out, scoringPrompt: buildScoringPrompt() };
    } finally {
      kb.close();
      parent.close();
    }
  });

  // ===== 考核计划列表（2026-09-14 重构：exam_schedules 排期表已取消；本路由返回孩子库 exam_plans，
  // 固定档由配置项经 worker 每天 / 本路由幂等补跑生成。响应形状与旧排期列表保持一致，渲染层零改动）=====
  app.get("/api/v1/exam/schedules/:childId", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    // 幂等补跑：确保「今天」的固定考核计划已按配置生成（正常由 worker plan tick 每天生成）
    const generated = ensureTodayExamPlans(deps.db, deps.config.dataDir, parentId);
    const kb = openKb(deps.config.dataDir, parentId, childId);
    let schedules: Array<Record<string, unknown>>;
    try {
      const rows = kb
        .prepare("SELECT * FROM exam_plans WHERE child_id = ? AND active = 1 ORDER BY start_at ASC LIMIT 1000")
        .all(childId) as Array<Record<string, unknown>>;
      const now = Date.now();
      schedules = rows.map((r) => ({
        id: String(r.id),
        kind: String(r.kind || "custom"),
        freq: String(r.freq ?? ""),
        scheduledAt: String(r.start_at ?? ""),
        status: String(r.status ?? "pending"),
        attemptId: String(r.attempt_id ?? ""),
        title:
          String(r.title || "") ||
          (String(r.kind) === "custom" ? "自定义考核" : `固定考核（${freqLabel(String(r.freq))}）`),
        // scope 直出给家长端 UI：**courses 必须是课程名（字符串）数组**——2026-09-14 起库里存的是
        // [{title, kps:[{name,count}]}]（出题约定），旧客户端把数组项当字符串渲染 → 渲染对象
        // 会抛 "Objects are not valid as a React child" → 整树卸载白屏（2026-09-15 现场）。
        // 故此处把 courses 归一成课程名数组（UI 兼容），出题约定另放 courseSpecs 供新客户端展示细节。
        scope: (() => {
          try {
            const parsed = JSON.parse(String(r.scope_json ?? "{}")) as Record<string, unknown>;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
            const specs = parsePlanCourses(parsed.courses);
            if (!specs.length) return parsed;
            return { ...parsed, courses: specs.map((s) => s.title), courseSpecs: specs };
          } catch {
            return {};
          }
        })(),
        pending: String(r.status) === "pending" && new Date(String(r.start_at ?? "")).getTime() <= now,
      }));
    } finally {
      kb.close();
    }
    return { generated, schedules };
  });

  // 自定义考核创建（家长端管理面板；家长对话走 parent_exam_plan_create 工具，同一落库口径）：
  // 2026-09-14 重构：直接写入孩子库 exam_plans（考核计划），不再经 exam_schedules 排期表
  app.post("/api/v1/exam/schedules", { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as { childId?: string; scheduledAt?: string; scope?: unknown };
    const childId = String(body.childId ?? "").trim();
    const scheduledAt = String(body.scheduledAt ?? "").trim();
    if (!childId || !scheduledAt) return reply.code(400).send({ error: "缺少 childId 或 scheduledAt" });
    const parsedAt = new Date(scheduledAt);
    if (Number.isNaN(parsedAt.getTime())) return reply.code(400).send({ error: `考核时间无法解析：${scheduledAt}` });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const id = `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // 考核只按「日期」粒度：入库取该日期本地 0 点（到当天即可考）
    const day = localDateStr(dayStart(parsedAt.getTime()));
    // 2026-09-14 定案：计划生成时即完整约定出题参数。body.scope.courses 若是字符串课程名 →
    // 现场展开成 [{title, kps:[{name,count}]}]（没挂知识点/题库题的课 → 400 拒绝创建）。
    const scopeIn = (body.scope ?? {}) as {
      courses?: unknown;
      note?: string;
      methodSpec?: { require?: Record<string, number>; exclude?: string[]; recitePass?: number } | null;
      recitePass?: number;
    };
    const rawCourses = Array.isArray(scopeIn.courses) ? scopeIn.courses : [];
    let entries: PlanCourseSpec[];
    if (rawCourses.length > 0 && typeof rawCourses[0] === "object" && Array.isArray((rawCourses[0] as PlanCourseSpec)?.kps)) {
      entries = rawCourses as PlanCourseSpec[];
    } else {
      const titles = rawCourses.map((x: unknown) => String(x ?? "").trim()).filter(Boolean);
      if (!titles.length) return reply.code(400).send({ error: "缺少考核课程（scope.courses）" });
      const pl0 = openParentLib(deps.config.dataDir, parentId);
      let expanded: PlanCourseSpec[] = [];
      let missing: Array<{ title: string; reason: string }> = [];
      try {
        const kb0 = openKb(deps.config.dataDir, parentId, childId);
        try {
          const qmarks = titles.map(() => "?").join(",");
          const rows = kb0
            .prepare(`SELECT title, topic FROM courses WHERE title IN (${qmarks})`)
            .all(...titles) as Array<{ title: string; topic: string }>;
          const found = new Set(rows.map((r) => r.title));
          const notFound = titles.filter((t) => !found.has(t));
          missing = notFound.map((t) => ({ title: t, reason: "孩子库里没有这门课" }));
          if (rows.length) {
            const r = buildPlanSpecEntries(pl0, childId, rows, scopeIn.methodSpec ?? null);
            expanded = r.entries;
            missing = [...missing, ...r.missing];
          }
        } finally {
          kb0.close();
        }
      } finally {
        pl0.close();
      }
      if (missing.length) {
        return reply.code(400).send({
          error: `无法创建考核计划（课程必须有知识点和题库题）：${missing.map((m) => `${m.title}（${m.reason}）`).join("；")}`,
        });
      }
      entries = expanded;
    }
    const kb = openKb(deps.config.dataDir, parentId, childId);
    try {
      const dup = kb
        .prepare(
          "SELECT id FROM exam_plans WHERE child_id = ? AND kind = 'custom' AND creator = 'parent' AND active = 1 AND status = 'pending' AND substr(start_at,1,10) = ?"
        )
        .get(childId, day) as { id: string } | undefined;
      if (dup) return { ok: true, id: dup.id, duplicated: true };
      const now = new Date().toISOString();
      const scopeJson = JSON.stringify({
        courses: entries,
        ...(scopeIn.note ? { note: String(scopeIn.note) } : {}),
        ...(scopeIn.recitePass != null ? { recitePass: Number(scopeIn.recitePass) } : {}),
      });
      kb.prepare(
        `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
           start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
         VALUES (?,?,?,'自定义考核','parent','custom','',?,'conversation','','?',?,'pending','',NULL,'','required',1,0,1,?,?)`
      ).run(id, parentId, childId, scopeJson, `${day} 00:00:00`, `${day} 23:59:59`, now, now);
      return { ok: true, id };
    } finally {
      kb.close();
    }
  });

  // 标记考核计划开始（孩子点「开始这次考核」）。id = exam_plans 行 id（按家长名下孩子库定位）
  app.post("/api/v1/exam/schedules/:id/start", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { id } = req.params as { id: string };
    const hit = findExamPlanRow(deps.db, deps.config.dataDir, parentId, id);
    if (!hit) return reply.code(404).send({ error: "考核计划不存在或已取消" });
    const kb = openKb(deps.config.dataDir, parentId, hit.childId);
    try {
      kb.prepare("UPDATE exam_plans SET status = 'started', updated_at = ? WHERE id = ? AND status = 'pending'").run(
        new Date().toISOString(),
        id
      );
    } finally {
      kb.close();
    }
    return { ok: true };
  });

  app.post("/api/v1/exam/schedules/:id/complete", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { id } = req.params as { id: string };
    const attemptId = String((req.body as { attemptId?: string })?.attemptId ?? "");
    const hit = findExamPlanRow(deps.db, deps.config.dataDir, parentId, id);
    if (!hit) return reply.code(404).send({ error: "考核计划不存在或已取消" });
    const kb = openKb(deps.config.dataDir, parentId, hit.childId);
    try {
      kb.prepare("UPDATE exam_plans SET status = 'done', attempt_id = ?, done_at = ?, updated_at = ? WHERE id = ?").run(
        attemptId,
        new Date().toISOString(),
        new Date().toISOString(),
        id
      );
    } finally {
      kb.close();
    }
    return { ok: true };
  });

  // 取消考核计划（家长端）：软删 exam_plans（active=0 / status='cancelled'）；已考完（done）不允许取消
  app.delete("/api/v1/exam/schedules/:id", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { id } = req.params as { id: string };
    const hit = findExamPlanRow(deps.db, deps.config.dataDir, parentId, id);
    if (!hit) return reply.code(404).send({ error: "考核计划不存在或已取消" });
    if (String(hit.row.status) === "done") {
      return reply.code(400).send({ error: "已考完的考核计划不能取消（避免破坏考核成绩关联）" });
    }
    const kb = openKb(deps.config.dataDir, parentId, hit.childId);
    try {
      kb.prepare("UPDATE exam_plans SET active = 0, status = 'cancelled', updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        id
      );
    } finally {
      kb.close();
    }
    return { ok: true };
  });

  // 取消考核计划（家长端）：软删除孩子库 exam_plans（active=0 / status='cancelled'），历史保留供审计，不计入完成率/掌握度。
  // 注意术语：exam_plans 是「考核计划」；实际考核场次 = 主库 exam_attempts（孩子提交后生成，含逐题记录），不受影响。
  // 已开考完成（status='done'）的场次不允许取消。
  app.post("/api/v1/exam/plans/:id/cancel", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { id } = req.params as { id: string };
    const childId = String((req.body as { childId?: string })?.childId ?? "");
    if (!childId) return reply.code(400).send({ error: "缺少 childId" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const kb = openKb(deps.config.dataDir, parentId, childId);
    try {
      const row = kb
        .prepare("SELECT id, title, status FROM exam_plans WHERE id = ? AND child_id = ? AND active = 1")
        .get(id, childId) as { id: string; title: string; status: string } | undefined;
      if (!row) return reply.code(404).send({ error: "考核计划不存在或已取消" });
      if (row.status === "done") {
        return reply.code(400).send({ error: `场次「${row.title}」已开考完成，不能取消（成绩需保留）` });
      }
      kb.prepare("UPDATE exam_plans SET active = 0, status = 'cancelled', updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        row.id
      );
      return { ok: true };
    } finally {
      kb.close();
    }
  });

  // ===== 固定考核配置（家长设置：频率档多选 + 每轮课程数 N + 考核时刻） =====
  app.get("/api/v1/exam/fixed-config", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    return { config: getFixedConfig(deps.db, parentId) };
  });

  app.post("/api/v1/exam/fixed-config", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as {
      frequencies?: string[];
      courseCount?: number;
      time?: string;
      weekly?: { weekday?: number; time?: string };
      selectionPrompts?: Record<string, string>;
    };
    const cur = getFixedConfig(deps.db, parentId);
    const frequencies = Array.isArray(body.frequencies)
      ? body.frequencies.filter((f) => FREQ_RANK[f] != null)
      : cur.frequencies;
    const courseCount = Number.isFinite(body.courseCount) ? Math.min(20, Math.max(1, Math.round(body.courseCount!))) : cur.courseCount;
    const time = /^\d{2}:\d{2}$/.test(String(body.time ?? "")) ? String(body.time) : cur.time;
    // 每周：周几（1=周一…7=周日）+ 时刻
    const weekly: FixedExamConfig["weekly"] = { ...(cur.weekly ?? { weekday: 1, time }) };
    if (body.weekly && typeof body.weekly === "object") {
      const wd = Number(body.weekly.weekday);
      if (Number.isInteger(wd) && wd >= 1 && wd <= 7) weekly.weekday = wd;
      if (/^\d{2}:\d{2}$/.test(String(body.weekly.time ?? ""))) weekly.time = String(body.weekly.time);
    }
    // 各频率档选课 prompt：合并保存（只更新传入的档；空字符串 = 恢复默认，删除该档覆盖）
    const selectionPrompts: Record<string, string> = { ...(cur.selectionPrompts ?? {}) };
    if (body.selectionPrompts && typeof body.selectionPrompts === "object") {
      for (const [f, v] of Object.entries(body.selectionPrompts)) {
        if (!FREQ_RANK[f]) continue;
        const s = String(v ?? "");
        if (!s.trim()) delete selectionPrompts[f]; // 清空 → 回退默认模板
        else selectionPrompts[f] = s;
      }
    }
    // 2026-09-14 重构：固定考核是纯配置项（无排期表），改配置无需清理任何排期；
    // 当天已生成的考核计划保留，次日起按新配置生成。
    const next: FixedExamConfig = {
      frequencies,
      courseCount,
      time,
      weekly,
      anchorAt: "", // 已无排期表，字段仅为数据兼容保留
      selectionPrompts,
    };
    deps.db
      .prepare("INSERT OR REPLACE INTO settings (key, value_json, updated) VALUES (?, ?, ?)")
      .run(`exam_fixed:${parentId}`, JSON.stringify(next), new Date().toISOString());
    return { ok: true, config: next };
  });

  // ===== 提交一次考核结果（客户端判分后上报；语音 fileId 由 /files/upload 先行拿到） =====
  app.post("/api/v1/exam/attempts", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as {
      childId?: string;
      topic?: string;
      title?: string;
      startedAt?: string;
      submittedAt?: string;
      status?: string;
      score?: number;
      perQuestion?: unknown;
      courseMastery?: unknown;
      reinforcePlan?: unknown;
      wrongQuestions?: unknown;
      scheduleId?: string;
    };
    const childId = typeof body.childId === "string" ? body.childId.trim() : "";
    if (!childId) return reply.code(400).send({ error: "缺少 childId" });
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const now = new Date().toISOString();
    const id = `exam_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    deps.db
      .prepare(
        `INSERT INTO exam_attempts (
           id, parent_id, child_id, topic, title, started_at, submitted_at, status, score,
           per_question, course_mastery, reinforce_plan, wrong_questions, schedule_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        parentId,
        childId,
        String(body.topic ?? ""),
        String(body.title ?? ""),
        String(body.startedAt ?? ""),
        String(body.submittedAt ?? now),
        body.status === "done" ? "done" : "grading",
        Number(body.score) || 0,
        JSON.stringify(body.perQuestion ?? []),
        JSON.stringify(body.courseMastery ?? {}),
        JSON.stringify(body.reinforcePlan ?? {}),
        JSON.stringify(body.wrongQuestions ?? []),
        String(body.scheduleId ?? ""),
        now
      );
    // ===== Plan A（2026-09-13）：口语/听说题的发音测评结果落 speech_assessments（server.sqlite），
    // 作为 exam_attempts 的明细子表，供家长端回放/审计。仅对 perQuestion 中带 speech 结果的口语题写入。 =====
    try {
      const perQuestion = Array.isArray(body.perQuestion) ? (body.perQuestion as Array<Record<string, unknown>>) : [];
      const insertSpeech = deps.db.prepare(
        `INSERT INTO speech_assessments (
           id, parent_id, child_id, topic_key, course_name, question_type, ref_text, audio_file_id,
           overall, pron, dimensions_json, detail_json, is_exam, exam_attempt_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const q of perQuestion) {
        const speech = q.speech as Record<string, unknown> | undefined;
        if (!speech || typeof speech !== "object") continue;
        const overall = Number(speech.overall ?? speech.pron ?? 0) || 0;
        const pron = Number(speech.pron ?? 0) || 0;
        const dimensions = {
          accuracy: speech.accuracy,
          integrity: speech.integrity,
          fluency: speech.fluency,
          prosody: speech.prosody,
          audioQuality: speech.audioQuality,
        };
        insertSpeech.run(
          `sa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          parentId,
          childId,
          String(body.topic ?? ""),
          String(q.course ?? ""),
          String(q.questionType || q.assessMethod || ""),
          String(q.refText ?? ""),
          String(q.audioFileId ?? ""),
          overall,
          pron,
          JSON.stringify(dimensions),
          JSON.stringify(speech),
          1,
          id,
          now
        );
      }
    } catch (err) {
      // 明细落库失败不应拖垮主流程：记日志后继续（主 attempt 已写入）。
      req.log.warn({ err }, "写入 speech_assessments 失败（attempt 已保留）");
    }
    // 2026-09-10 计划域：掌握度不再回写 courses（该表已无 mastery/exam_mastery 列）。
    // 掌握度 = course_progress 视图（按 exam_plan_courses / 最近一次考核聚合），此处只保留 attempt 记录。
    // 考核 v2（2026-09-14 重构）：body.scheduleId 现在携带的是孩子库 exam_plans 考核计划行 id →
    // 提交后直接把该计划置 done 并回填 attempt_id/score；逐题明细由 worker applyExamAttempts 幂等回填 exam_plan_courses。
    const planId = String(body.scheduleId ?? "");
    if (planId) {
      const kb = openKb(deps.config.dataDir, parentId, childId);
      try {
        kb
          .prepare(
            "UPDATE exam_plans SET status = 'done', attempt_id = ?, score = ?, done_at = ?, updated_at = ? WHERE id = ? AND child_id = ?"
          )
          .run(id, Number(body.score) || 0, String(body.submittedAt ?? now), now, planId, childId);
      } finally {
        kb.close();
      }
    }
    return { ok: true, id };
  });

  // ===== 家长查询考核记录列表（倒序；limit 默认 50） =====
  app.get("/api/v1/exam/attempts/:childId", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    const limit = Math.min(200, Math.max(1, Number((req.query as { limit?: string }).limit) || 50));
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const rows = deps.db
      .prepare("SELECT * FROM exam_attempts WHERE child_id = ? ORDER BY submitted_at DESC LIMIT ?")
      .all(childId, limit) as Array<Record<string, unknown>>;
    return { attempts: rows.map(rowToAttempt) };
  });

  // ===== 每课程考核记录表（家长端：最近考核/掌握/难点/亮点/计划复习时间+重点） =====
  app.get("/api/v1/exam/course-records/:childId", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const rows = deps.db
      .prepare("SELECT id, submitted_at, per_question, course_mastery, reinforce_plan FROM exam_attempts WHERE child_id = ? ORDER BY submitted_at ASC")
      .all(childId) as Array<Record<string, unknown>>;
    const records = new Map<
      string,
      {
        course: string;
        attempts: number;
        lastAssessAt: string;
        correct: number;
        total: number;
        rate: number;
        difficulties: string[];
        highlights: string[];
        planReviewAt: string;
        focus: string[];
      }
    >();
    for (const row of rows) {
      let pq: Array<Record<string, unknown>> = [];
      try {
        pq = JSON.parse(String(row.per_question ?? "[]"));
      } catch {
        pq = [];
      }
      let rp: Record<string, { planReviewAt?: string; focus?: string[] }> = {};
      try {
        rp = JSON.parse(String(row.reinforce_plan ?? "{}"));
      } catch {
        rp = {};
      }
      const submittedAt = String(row.submitted_at ?? "");
      for (const q of pq) {
        const course = String(q.course ?? "");
        if (!course) continue;
        let rec = records.get(course);
        if (!rec) {
          rec = {
            course,
            attempts: 0,
            lastAssessAt: "",
            correct: 0,
            total: 0,
            rate: 0,
            difficulties: [],
            highlights: [],
            planReviewAt: "",
            focus: [],
          };
          records.set(course, rec);
        }
        rec.attempts = 1; // 记录参与场次数（有题即算）
        if (submittedAt > rec.lastAssessAt) rec.lastAssessAt = submittedAt;
        const got = Number(q.pointGot) || 0;
        const max = Number(q.pointMax) || 0;
        const isCorrect = got >= max * 0.6;
        rec.total += 1;
        if (isCorrect) rec.correct += 1;
        const comment = String(q.aiComment ?? "");
        if (!isCorrect && comment) rec.difficulties.push(comment);
        if (isCorrect && got === max && comment) rec.highlights.push(comment);
        const plan = rp[course];
        if (plan) {
          rec.planReviewAt = String(plan.planReviewAt ?? rec.planReviewAt);
          if (Array.isArray(plan.focus) && plan.focus.length) rec.focus = plan.focus.map(String);
        }
      }
    }
    const out = Array.from(records.values()).map((r) => ({
      course: r.course,
      attempts: r.attempts,
      lastAssessAt: r.lastAssessAt,
      correct: r.correct,
      total: r.total,
      rate: r.total ? Math.round((r.correct / r.total) * 1000) / 1000 : 0,
      difficulties: r.difficulties.slice(-3),
      highlights: r.highlights.slice(-3),
      planReviewAt: r.planReviewAt,
      focus: r.focus,
    }));
    // 掌握度等级（来自最近聚合率）
    return { records: out };
  });

  // ===== 课程综合学习情况「一站式」查询（家长计划/复习决策：学习/复习/考核全景） =====
  app.get("/api/v1/courses/status/:childId", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const records = listCourseStatus(deps.db, deps.config.dataDir, parentId, childId);
    return { records };
  });

  // ===== 考核内容结构化（家长 agent 读写；权威库 = 服务端 parent.sqlite；知识点制） =====
  const openParentFor = (parentId: string) => openParentLib(deps.config.dataDir, parentId);

  /** 某主题下全部课程的知识点（名称/详情/所属课程）——写考核内容与设考核方法前先看。 */
  app.get("/api/v1/assess/topics/:topic/knowledge-points", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const topic = String((req.params as { topic?: string }).topic || "");
    if (!topic) return reply.code(400).send({ error: "缺少 topic" });
    const db = openParentFor(parentId);
    try {
      return { topic, knowledgePoints: listTopicKnowledgePoints(db, topic) };
    } finally {
      db.close();
    }
  });

  app.get("/api/v1/assess/topics/:topic/method-spec", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const topic = String((req.params as { topic?: string }).topic || "");
    if (!topic) return reply.code(400).send({ error: "缺少 topic" });
    const db = openParentFor(parentId);
    try {
      return { topic, spec: getMethodSpec(db, topic) };
    } finally {
      db.close();
    }
  });

  app.post("/api/v1/assess/questions", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const b = (req.body || {}) as {
      questionId?: string;
      stem?: string;
      answer?: string;
      scoring?: string | null;
      pointMax?: number;
      behavior?: string;
      note?: string;
      knowledgeSummary?: string;
      options?: Array<{ key: string; text: string }>;
    };
    if (!b.stem || !b.answer) return reply.code(400).send({ error: "题目需要 stem + answer" });
    const db = openParentFor(parentId);
    try {
      const id = saveQuestion(db, {
        id: b.questionId,
        stem: String(b.stem).trim(),
        answer: String(b.answer).trim(),
        scoring: b.scoring ?? null,
        pointMax: Number(b.pointMax) || 10,
        behavior: String(b.behavior || "generic"),
        note: String(b.note ?? ""),
        knowledgeSummary: String(b.knowledgeSummary ?? ""),
        options: Array.isArray(b.options) ? b.options : undefined,
      });
      return { id };
    } finally {
      db.close();
    }
  });

  /** 整课保存考核内容：topic+title 定位课程；每项 = 一个知识点（可带详情）+ 挂在该知识点下的若干题
   *  （可引用题库题或内联新建）。事务替换旧挂载。 */
  app.post("/api/v1/assess/courses/save", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const b = (req.body || {}) as { topic?: string; title?: string; items?: Array<Record<string, unknown>> };
    if (!b.topic || !b.title || !Array.isArray(b.items)) {
      return reply.code(400).send({ error: "需要 topic + title + items[]" });
    }
    const db = openParentFor(parentId);
    try {
      const uuid = getCourseUuid(db, String(b.topic), String(b.title));
      if (!uuid) return reply.code(400).send({ error: `课程不存在：${b.topic}/${b.title}（请先在课程库创建该课）` });
      const replaceItems: Array<{ knowledgePointId: string; overview: string; questionIds: string[] }> = [];
      let created = 0;
      let linked = 0;
      for (const it of b.items) {
        // 知识点解析：knowledgePointId（须属于本课）> knowledgePoint 名称（getOrCreate，可带 detail 详情）
        const kpIdRaw = typeof it.knowledgePointId === "string" ? it.knowledgePointId.trim() : "";
        const kpName = String(it.knowledgePoint ?? it.knowledgePointName ?? "").trim();
        const kpDetail = String(it.detail ?? it.knowledgePointDetail ?? "").trim();
        let kpId: string;
        if (kpIdRaw) {
          const row = db.prepare("SELECT id FROM knowledge_points WHERE id = ? AND course_uuid = ?").get(kpIdRaw, uuid);
          if (!row) return reply.code(400).send({ error: `知识点不存在或不属于该课：${kpIdRaw}` });
          kpId = kpIdRaw;
          if (kpDetail) getOrCreateKnowledgePoint(db, uuid, kpName || "", kpDetail); // 名称为空时不新建，仅当能定位到名称才更新详情
        } else if (kpName) {
          kpId = getOrCreateKnowledgePoint(db, uuid, kpName, kpDetail).id;
        } else {
          return reply.code(400).send({ error: "每项需要 knowledgePointId 或 knowledgePoint（知识点名称）" });
        }
        const qs = (Array.isArray(it.questions) ? it.questions : []) as Array<Record<string, unknown>>;
        const qids: string[] = [];
        for (const qo of qs) {
          if (typeof qo.questionId === "string" && qo.questionId) {
            const exists = getQuestion(db, qo.questionId);
            if (!exists) return reply.code(400).send({ error: `题库题不存在：${qo.questionId}` });
            qids.push(qo.questionId);
            linked++;
          } else {
            const stem = String(qo.stem ?? "").trim();
            const answer = String(qo.answer ?? "").trim();
            if (!stem || !answer) return reply.code(400).send({ error: `知识点「${kpName || kpIdRaw}」下内联题目需要 stem + answer` });
            const id = saveQuestion(db, {
              stem,
              answer,
              scoring: qo.scoring != null ? String(qo.scoring) : null,
              pointMax: Number(qo.pointMax) || 10,
              behavior: String(qo.behavior || "generic"),
              note: qo.note != null ? String(qo.note) : "",
              knowledgeSummary: qo.knowledgeSummary != null ? String(qo.knowledgeSummary) : (kpName || ""),
              options: Array.isArray(qo.options) ? (qo.options as Array<{ key: string; text: string }>) : undefined,
            });
            qids.push(id);
            created++;
          }
        }
        replaceItems.push({ knowledgePointId: kpId, overview: String(it.overview ?? ""), questionIds: qids });
      }
      replaceCourseContent(db, uuid, replaceItems);
      return { ok: true, courseUuid: uuid, knowledgePoints: replaceItems.length, questionsCreated: created, questionsLinked: linked };
    } catch (e) {
      if (reply.sent) return;
      return reply.code(400).send({ error: String((e as Error).message || e) });
    } finally {
      db.close();
    }
  });

  /** 查看某课结构化内容（类别→题，含题库原文/评分；供 agent 校验与阅读）。 */
  app.get("/api/v1/assess/courses/:topic/:title", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { topic, title } = req.params as { topic: string; title: string };
    const db = openParentFor(parentId);
    try {
      const uuid = getCourseUuid(db, topic, title);
      if (!uuid) return reply.code(404).send({ error: "课程不存在" });
      const content = listCourseContent(db, uuid);
      return { course: { topic, title, courseId: uuid, structured: content.items.length > 0, items: content.items } };
    } finally {
      db.close();
    }
  });

  /** 更新某孩子的方法（主题级 method_spec 内合并该孩子条目）。require/exclude 可用类别名或 uuid。 */
  app.post("/api/v1/assess/method-spec", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const b = (req.body || {}) as {
      topicId?: string;
      childId?: string;
      require?: Record<string, number>;
      exclude?: string[];
      recitePass?: number;
    };
    if (!b.topicId || !b.childId) return reply.code(400).send({ error: "需要 topicId + childId" });
    const db = openParentFor(parentId);
    try {
      const spec = (getMethodSpec(db, String(b.topicId)) as { perChild?: Record<string, unknown>; default?: unknown }) ?? {};
      const per: Record<string, any> = (spec.perChild as Record<string, any>) ?? {};
      const cur: any = per[String(b.childId)] ?? { require: {}, exclude: [], rules: { recitePass: 90 } };
      // require/exclude 键 = 知识点 uuid 或知识点名（按主题下全部课程的知识点解析；只校验可解析，键按原样存储——
      // 同名知识点可存在于多门课，按名引用可一次覆盖多课）
      if (b.require) {
        const kps = listTopicKnowledgePoints(db, String(b.topicId));
        const byName = new Set(kps.map((k) => k.name));
        const byId = new Set(kps.map((k) => k.id));
        const reqIds: Record<string, number> = {};
        for (const [k, v] of Object.entries(b.require)) {
          if (!byId.has(k) && !byName.has(k)) return reply.code(400).send({ error: `知识点「${k}」不属于主题 ${b.topicId}` });
          reqIds[k] = Math.max(1, Number(v) || 1);
        }
        cur.require = reqIds;
      }
      if (Array.isArray(b.exclude)) {
        const kps = listTopicKnowledgePoints(db, String(b.topicId));
        const byName = new Set(kps.map((k) => k.name));
        const byId = new Set(kps.map((k) => k.id));
        cur.exclude = b.exclude
          .map((k) => String(k).trim())
          .filter((k) => byId.has(k) || byName.has(k));
      }
      if (b.recitePass != null) cur.rules = { ...(cur.rules || {}), recitePass: Math.max(0, Number(b.recitePass) || 90) };
      per[String(b.childId)] = cur;
      spec.perChild = per;
      if (spec.default == null) spec.default = { require: {}, exclude: [], rules: { recitePass: 90 } };
      saveMethodSpec(db, String(b.topicId), spec);
      return { ok: true, spec };
    } finally {
      db.close();
    }
  });

  /** 全量题库列表（家长「题库」菜单）：每题带所属主题/课程/类别上下文。 */
  app.get("/api/v1/assess/questions/list", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const db = openParentFor(parentId);
    try {
      return { questions: listAllBankQuestions(db) };
    } finally {
      db.close();
    }
  });

  /** 某道题库题的考核结果记录（该家长全部孩子，各自返回最近一次）。 */
  app.get("/api/v1/assess/questions/:questionId/records", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { questionId } = req.params as { questionId: string };
    const children = deps.db.prepare("SELECT id, name FROM children WHERE parent_id = ?").all(parentId) as Array<{
      id: string;
      name: string;
    }>;
    const childName = new Map(children.map((c) => [c.id, c.name]));
    const records: Array<Record<string, unknown>> = [];
    for (const child of children) {
      const attempts = deps.db
        .prepare("SELECT id, child_id, created_at, per_question FROM exam_attempts WHERE child_id = ? ORDER BY created_at DESC LIMIT 60")
        .all(child.id) as Array<{ id: string; child_id: string; created_at: string; per_question: string }>;
      for (const at of attempts) {
        let arr: any[] = [];
        try {
          arr = JSON.parse(at.per_question || "[]");
        } catch {
          continue;
        }
        for (const q of arr) {
          if (q && String(q.questionId || "") === questionId) {
            records.push({
              childId: child.id,
              childName: childName.get(child.id) || child.name,
              attemptId: at.id,
              submittedAt: at.created_at,
              pointGot: Number(q.pointGot) ?? null,
              pointMax: Number(q.pointMax) || null,
              correct: Boolean(q.correct),
              aiComment: String(q.aiComment || ""),
            });
          }
        }
      }
    }
    records.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    // 区分孩子：各自返回最近一次（未考过的孩子给空占位）
    const latestByChild = new Map<string, (typeof records)[number]>();
    for (const r of records) {
      const cid = String(r.childId);
      if (!latestByChild.has(cid)) latestByChild.set(cid, r);
    }
    const grouped = children.map((c) => {
      const latest = latestByChild.get(c.id);
      return (
        latest ?? {
          childId: c.id,
          childName: c.name,
          attemptId: null,
          submittedAt: null,
          pointGot: null,
          pointMax: null,
          correct: false,
          aiComment: "",
          neverAssessed: true,
        }
      );
    });
    return { records: grouped };
  });
}
