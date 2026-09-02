/**
 * 学习考核（EXAM-REQUIREMENTS.md）——服务端：内容真源 + 存储，不跑判分 LLM。
 * - GET  /api/v1/exam/config/:childId   考核配置下发（周期内学/复习过的知识点 + assess_method/assess_rubric + 判分 prompt）
 * - POST /api/v1/exam/attempts          提交一次考核结果（客户端判分后上报；语音经 /files/upload 先行上传，这里引用 fileId）
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
 * 客户端拿到后拼入本场考核的题目与孩子答案；rubric 为家长写的 assess_rubric。
 * ⚠️ `{{TODAY}}` 占位符在下发时被替换为服务器当天日期（YYYY-MM-DD）——不注入日期，
 * LLM 会瞎猜复习日期（实测产出 2025-03-24 之类的错误年份）。
 */
export const SCORING_PROMPT = `你是孩子的学习考核评估老师。今天是 {{TODAY}}。下面给你：1) 每道主观题的考核要点(rubric)；2) 孩子对每道题的口头回答(ASR 转写文本，可能有语音识别误差，请结合题意合理理解)；3) 每题用时。
请逐题评估并输出严格的 JSON（不要输出其它文字），格式：
{
  "perQuestion": [
    {
      "qid": "题号",
      "pointGot": 分数(0~pointMax 的整数),
      "correct": true|false,
      "aiComment": "评语：答到了哪些要点、遗漏或理解错误在哪，30~60字"
    }
  ],
  "courseMastery": { "<课程名>": { "correct": 答对题数, "total": 该课程题数, "rate": 正确率(0~1, 两位小数) } },
  "reinforcePlan": {
    "<课程名>": {
      "planReviewAt": "建议复习日期 YYYY-MM-DD（严格按今天 {{TODAY}} 推算：薄弱1-2天后、良好3-5天后、熟练可7-10天后）",
      "focus": ["考核发现的问题1", "问题2"],
      "aiSuggestion": "一句复习建议"
    }
  },
  "score": 总分(0~100 一位小数),
  "overall": "整体评估一句话"
}
评分标准：按 rubric 逐要点给分；pointMax 由题目给定，答到要点得分、明显错误或答非所问给低分；正确率=得分达到该题 60% 以上视为 correct。请客观、对低龄孩子语气温和、鼓励为主。`;

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

/** 考核掌握度等级（与引导 mastery 双轨；写入孩子 kb courses.exam_mastery）。 */
function masteryLevel(rate: number): string {
  if (rate >= 0.9) return "熟练";
  if (rate >= 0.7) return "良好";
  if (rate >= 0.5) return "学习中";
  return "薄弱";
}

// ==================== 考核 v2：固定频率配置 / 排期生成（EXAM-REQUIREMENTS §14） ====================

interface FixedExamConfig {
  /** 固定考核频率档：daily | weekly（UI 标签管理）；monthly/halfyear/yearly 保留兼容（旧数据/旧排期） */
  frequencies: string[];
  /** 每轮考核的课程数 N（§14.3，默认 3；v3 起数量由选课 prompt 规则决定，此字段仅兼容保留） */
  courseCount: number;
  /** 每日考核时刻 HH:mm（默认 20:00，孩子晚上学习时段） */
  time: string;
  /** 每周考核：周几几点（weekday 1=周一…7=周日；time HH:mm；缺省用 time） */
  weekly: { weekday: number; time: string };
  /** 首次生成锚点（ISO）；仅 monthly+ 档步进用，daily/weekly 按各自时刻实时定位 */
  anchorAt: string;
  /** 各频率档「选课 prompt」（家长可编辑；缺省用 DEFAULT_SELECTION_PROMPTS）——
   *  选课由客户端 LLM 按本 prompt 执行（§14.9，取代代码打分选课）。模板占位符由服务端注入：
   *  {{TODAY}} 今天日期 / {{RANGE}} 本周期范围 / {{STATS}} 周期内课程统计 / {{CLIST}} 候选课程清单 */
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

/** 五档频率的默认选课 prompt（家长可在「学习考核」编辑，缺省回退到这些默认值）。
 *  只描述「考哪些课/知识点、怎么选」——**不出现 JSON/输出格式说明**（那些由客户端引擎自动附加，
 *  家长不需要知道）。每档包含：如何获取本周期学习/复习的课程 + 选择原则 + 如何考核。 */
export const DEFAULT_SELECTION_PROMPTS: Record<string, string> = {
  daily:
    "本次是每日考核。\n" +
    "【如何获取本周期课程】课程清单里每门课标注了「首次学习」和「最近复习」日期，两者任一等于今天（{{TODAY}}）即为本周期学习/复习过的课程（清单中已用「★ 本周期」标出）。\n" +
    "【选择原则】带「★ 本周期」标记的课程**全部选入**，不挑选、不遗漏。\n" +
    "【如何考核】每门选中的课程按它的考核内容完整出题（出题阶段会提供）。",
  weekly:
    "本次是每周考核。\n" +
    "【如何获取本周期课程】课程清单里每门课标注了「首次学习」和「最近复习」日期，两者任一落在本周期 {{RANGE}} 内即为本周期学习/复习过的课程（清单中已用「★ 本周期」标出）。\n" +
    "【选择原则】带「★ 本周期」标记的课程**全部选入**，不挑选、不遗漏。\n" +
    "【如何考核】每门选中的课程按它的考核内容完整出题（出题阶段会提供）。",
  monthly:
    "本次是每月考核，分两部分选课。\n" +
    "【如何获取本周期课程】课程清单里每门课标注了「首次学习」和「最近复习」日期，并已用标记标出归属：\n" +
    "「★ 本月」= 学习或复习落在本月（{{RANGE}}）；「◐ 本月前」= 首次学习早于本月（含已学但日期未知的课程）。\n" +
    "【选择原则】\n" +
    "第一部分（本月课程）：**每个主题**从「★ 本月」标记的课程里挑选 50%（数量向上取整，见下方【各主题选课数量】）；\n" +
    "第二部分（本月前课程）：**每个主题**再从「◐ 本月前」标记的课程里挑选，数量 = 该主题本月课程数的 25%（向上取整，见下方【各主题选课数量】）。\n" +
    "挑选时优先选：考核掌握度薄弱/学习中、复习计划到期的、最久没考核的课程。\n" +
    "【如何考核】每门选中的课程按它的考核内容完整出题（出题阶段会提供）。",
  halfyear:
    "本次是半年考核，课程覆盖面大，按比例抽取。\n" +
    "【如何获取本周期课程】课程清单里每门课标注了「首次学习」和「最近复习」日期，两者任一落在本周期 {{RANGE}} 内即为本周期学习/复习过的课程（清单中已用「★ 本周期」标出）。\n" +
    "【选择原则】**每个主题**从「★ 本周期」标记的课程里挑选 40%（数量向上取整，见下方【各主题选课数量】），优先选：考核掌握度薄弱/学习中、复习计划到期、最久没考核的课程；尽量覆盖不同学习时间的课程（别只选最近学的）。\n" +
    "【如何考核】每门选中的课程按它的考核内容完整出题（出题阶段会提供）。",
  yearly:
    "本次是年度考核，覆盖面最大，按比例抽取且需覆盖全部主题。\n" +
    "【如何获取本周期课程】课程清单里每门课标注了「首次学习」和「最近复习」日期，两者任一落在本周期 {{RANGE}} 内即为本周期学习/复习过的课程（清单中已用「★ 本周期」标出）。\n" +
    "【选择原则】**每个主题**从「★ 本周期」标记的课程里挑选 60%（数量向上取整，见下方【各主题选课数量】），优先选：考核掌握度薄弱/学习中、复习计划到期、最久没考核的课程；要求主题间尽量均衡、时间上分散。\n" +
    "【如何考核】每门选中的课程按它的考核内容完整出题（出题阶段会提供）。",
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

/** 固定考核频率档 → 周期毫秒（半年按 182 天、一年按 365 天近似，月末日不精确可接受）。 */
function freqToMs(freq: string): number {
  switch (freq) {
    case "daily":
      return 86400000;
    case "weekly":
      return 7 * 86400000;
    case "monthly":
      return 30 * 86400000;
    case "halfyear":
      return 182 * 86400000;
    case "yearly":
      return 365 * 86400000;
    default:
      return 7 * 86400000;
  }
}

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
 * 固定排期懒生成（幂等）：确保该孩子未来 HORIZON 天内有固定排期。
 * 各频率档从 anchorAt 按周期步进；同一日期多档重叠 → 只保留周期最长档（rank 最大）。
 * 已存在同 child+同日+kind=fixed 的排期则跳过（重复调用不重复生成）。
 */
export function ensureFixedSchedules(db: DatabaseSync, parentId: string, childId: string): number {
  const cfg = getFixedConfig(db, parentId);
  if (!cfg.frequencies?.length) return 0;
  const HORIZON_MS = 60 * 86400000; // 未来 60 天
  const now = Date.now();
  const byDay = new Map<number, { time: number; freq: string; rank: number }>();
  const add = (t: number, freq: string) => {
    const day = dayStart(t);
    const cur = byDay.get(day);
    if (!cur || FREQ_RANK[freq] > cur.rank) byDay.set(day, { time: t, freq, rank: FREQ_RANK[freq] });
  };
  // 每日：每天 cfg.time 时刻（今天该时刻未过则今天，否则明天起）
  if (cfg.frequencies.includes("daily")) {
    const [h, m] = (cfg.time || "20:00").split(":").map(Number);
    const d = new Date(now);
    d.setHours(Number.isFinite(h) ? h : 20, Number.isFinite(m) ? m : 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    while (d.getTime() <= now + HORIZON_MS) {
      add(d.getTime(), "daily");
      d.setDate(d.getDate() + 1);
    }
  }
  // 每周：cfg.weekly.weekday（1=周一…7=周日）的 weekly.time 时刻；当天该时刻未过则当天，否则下个同星期几
  if (cfg.frequencies.includes("weekly")) {
    const w = cfg.weekly || {};
    const weekday = Number(w.weekday) || 1;
    const wtime = w.time || cfg.time || "20:00";
    const [h, m] = wtime.split(":").map(Number);
    const target = weekday % 7; // 1-7 → JS getDay（0=周日）：1→周一,7→周日
    const d = new Date(now);
    d.setHours(Number.isFinite(h) ? h : 20, Number.isFinite(m) ? m : 0, 0, 0);
    d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7));
    if (d.getTime() <= now) d.setDate(d.getDate() + 7);
    while (d.getTime() <= now + HORIZON_MS) {
      add(d.getTime(), "weekly");
      d.setDate(d.getDate() + 7);
    }
  }
  // monthly/halfyear/yearly：保留旧 anchor 步进（兼容旧数据；UI 已不再生成这三档）
  const legacy = cfg.frequencies.filter((f) => f === "monthly" || f === "halfyear" || f === "yearly");
  if (legacy.length) {
    let anchor: number;
    if (cfg.anchorAt) {
      anchor = new Date(cfg.anchorAt).getTime();
    } else {
      const [h, m] = (cfg.time || "20:00").split(":").map(Number);
      const d = new Date();
      d.setHours(Number.isFinite(h) ? h : 20, Number.isFinite(m) ? m : 0, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      anchor = d.getTime();
    }
    for (const freq of legacy) {
      const step = freqToMs(freq);
      for (let t = anchor; t <= anchor + HORIZON_MS; t += step) add(t, freq);
    }
  }
  // 只保留「还没生成」的排期（同日已存在 fixed 排期 → 跳过）；按时间排序
  const existing = new Set(
    (db
      .prepare("SELECT scheduled_at FROM exam_schedules WHERE child_id = ? AND kind = 'fixed'")
      .all(childId) as Array<{ scheduled_at: string }>).map((r) => dayStart(new Date(r.scheduled_at).getTime()))
  );
  const pending = Array.from(byDay.values())
    .filter((x) => x.time > now && !existing.has(dayStart(x.time)))
    .sort((a, b) => a.time - b.time);
  if (!pending.length) return 0;
  const ins = db.prepare(
    "INSERT OR IGNORE INTO exam_schedules (id, parent_id, child_id, kind, freq, scheduled_at, scope, status, created_at) VALUES (?, ?, ?, 'fixed', ?, ?, '{}', 'pending', ?)"
  );
  let n = 0;
  for (const p of pending) {
    const id = `sch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ins.run(id, parentId, childId, p.freq, new Date(p.time).toISOString(), new Date().toISOString());
    n++;
  }
  return n;
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
function latestReinforcePlan(db: DatabaseSync, childId: string): Record<string, { planReviewAt?: string }> {
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

interface ScheduleCourse {
  title: string;
  firstLearned: string;
  lastReview: string;
  mastery: string;
  examMastery: string;
  assessRubric: string;
  score: number;
}

/** 自定义排期（家长指定主题/课程范围）：直接按 scope 返回带 rubric 的课程，不经过选课 LLM（§14.9）。 */
function selectScopeCourses(
  dataDir: string,
  parentId: string,
  childId: string,
  scope: { topics?: string[]; courses?: string[] }
): Array<{ title: string; topic: string; firstLearned: string; lastReview: string; mastery: string; examMastery: string; assessRubric: string }> {
  const kb = openKb(dataDir, parentId, childId);
  const parent = openParentLib(dataDir, parentId);
  try {
    const topicList = Array.isArray(scope.topics) ? scope.topics : [];
    const courseList = Array.isArray(scope.courses) ? scope.courses : [];
    const out: Array<{ title: string; topic: string; firstLearned: string; lastReview: string; mastery: string; examMastery: string; assessRubric: string }> = [];
    for (const t of topicList) {
      const rows = parent
        .prepare("SELECT title, assess_rubric FROM courses WHERE topic = ? AND assess_rubric != ''")
        .all(t) as Array<{ title: string; assess_rubric: string }>;
      for (const r of rows) {
        if (courseList.length && !courseList.includes(r.title)) continue;
        const kbRow = kb
          .prepare("SELECT mastery, exam_mastery, first_learned, last_review FROM courses WHERE topic = ? AND title = ?")
          .get(t, r.title) as { mastery?: string; exam_mastery?: string; first_learned?: string; last_review?: string } | undefined;
        out.push({
          title: r.title,
          topic: t,
          firstLearned: kbRow?.first_learned ?? "",
          lastReview: kbRow?.last_review ?? "",
          mastery: kbRow?.mastery ?? "",
          examMastery: kbRow?.exam_mastery ?? "",
          assessRubric: r.assess_rubric,
        });
      }
    }
    return out;
  } finally {
    kb.close();
    parent.close();
  }
}

/** 全部「有学习痕迹」课程的元数据（选课 LLM 的候选清单；不含 rubric 全文，控制 prompt 体积）。
 *  口径：学习过（first_learned）或复习过（last_review）或已学标记（status='✅'）的课程；
 *  已学但日期未知的课程 firstLearned 记为 "✅"（归属「更早学习」，可被每月「本月前 25%」等规则选中）。 */
function listLearnedCourseMeta(
  db: DatabaseSync,
  dataDir: string,
  parentId: string,
  childId: string
): Array<{ topic: string; topicName: string; title: string; topicType: string; firstLearned: string; lastReview: string; mastery: string; examMastery: string; lastExamAt: string; planReviewAt: string }> {
  const kb = openKb(dataDir, parentId, childId);
  const parent = openParentLib(dataDir, parentId);
  try {
    const topicNames = new Map(
      (parent.prepare("SELECT topic_key, name FROM topics").all() as Array<{ topic_key: string; name: string }>).map((r) => [r.topic_key, r.name])
    );
    // 必学/选学/复习：孩子库 topics.rules_json.type（家长给孩子设置该主题的「每天学习量类型」）。
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
    const rows = kb
      .prepare(
        "SELECT topic, title, mastery, exam_mastery, first_learned, last_review, status FROM courses WHERE (first_learned != '' OR last_review != '' OR status = '✅') ORDER BY topic, sort_order, title"
      )
      .all() as Array<{ topic: string; title: string; mastery: string; exam_mastery: string; first_learned: string; last_review: string; status: string }>;
    const lastExam = lastExamAtByCourse(db, childId);
    const reinforce = latestReinforcePlan(db, childId);
    return rows.map((r) => {
      const fl = r.first_learned ?? "";
      const learnedNoDate = String(r.status ?? "").trim() === "✅" && !fl;
      return {
        topic: r.topic,
        topicName: topicNames.get(r.topic) ?? r.topic,
        title: r.title,
        topicType: childTopicTypes.get(r.topic) ?? "",
        firstLearned: learnedNoDate ? "✅" : fl,
        lastReview: r.last_review ?? "",
        mastery: r.mastery ?? "",
        examMastery: r.exam_mastery ?? "",
        lastExamAt: lastExam.get(r.title) ?? "",
        planReviewAt: reinforce[r.title]?.planReviewAt ?? "",
      };
    });
  } finally {
    kb.close();
    parent.close();
  }
}

/** 按选中课程 title 拉取 rubric（选课 LLM 输出后第二阶段：客户端出卷/判分用）。 */
function fetchCoursesWithRubric(
  dataDir: string,
  parentId: string,
  childId: string,
  titles: string[]
): Array<{ title: string; topic: string; firstLearned: string; lastReview: string; mastery: string; examMastery: string; assessRubric: string }> {
  const kb = openKb(dataDir, parentId, childId);
  const parent = openParentLib(dataDir, parentId);
  try {
    const rubrics = parent
      .prepare("SELECT topic, title, assess_rubric FROM courses WHERE assess_rubric != ''")
      .all() as Array<{ topic: string; title: string; assess_rubric: string }>;
    const rubricMap = new Map(rubrics.map((r) => [r.topic + "::" + r.title, r.assess_rubric]));
    const out: Array<{ title: string; topic: string; firstLearned: string; lastReview: string; mastery: string; examMastery: string; assessRubric: string }> = [];
    for (const t of titles) {
      const kbRow = kb
        .prepare("SELECT topic, mastery, exam_mastery, first_learned, last_review FROM courses WHERE title = ?")
        .get(t) as { topic?: string; mastery?: string; exam_mastery?: string; first_learned?: string; last_review?: string } | undefined;
      if (!kbRow) continue; // 孩子库无此课 → 跳过
      out.push({
        title: t,
        topic: String(kbRow.topic ?? ""),
        firstLearned: String(kbRow.first_learned ?? ""),
        lastReview: String(kbRow.last_review ?? ""),
        mastery: String(kbRow.mastery ?? ""),
        examMastery: String(kbRow.exam_mastery ?? ""),
        assessRubric: rubricMap.get(String(kbRow.topic) + "::" + t) ?? "",
      });
    }
    return out;
  } finally {
    kb.close();
    parent.close();
  }
}

/** 构建某频率档的完整选课 prompt：模板（家长可编辑）+ 注入今天日期/周期范围/统计/候选清单。 */
export function buildSelectionPrompt(
  template: string,
  candidates: Array<{ topic: string; topicName: string; title: string; topicType: string; firstLearned: string; lastReview: string; mastery: string; examMastery: string; lastExamAt: string; planReviewAt: string }>,
  freq: string,
  scheduledTs: number
): string {
  const TODAY = new Date().toISOString().slice(0, 10);
  const scheduledDay = new Date(scheduledTs).toISOString().slice(0, 10);
  const monthStart = scheduledDay.slice(0, 7) + "-01";
  let RANGE: string;
  if (freq === "daily") RANGE = TODAY;
  else if (freq === "monthly") RANGE = monthStart + " ~ " + scheduledDay;
  else if (freq === "custom") RANGE = "（自定义考核，选课范围由下面的规则指定，不按周期窗口）";
  else RANGE = new Date(scheduledTs - freqToMs(freq)).toISOString().slice(0, 10) + " ~ " + scheduledDay;
  // 每主题统计（monthly：本月/本月前；其余：本周期窗口内；custom：全部候选）
  const byTopic = new Map<string, { name: string; month: number; prev: number; window: number }>();
  const bump = (topic: string, name: string, key: "month" | "prev" | "window") => {
    let e = byTopic.get(topic);
    if (!e) {
      e = { name, month: 0, prev: 0, window: 0 };
      byTopic.set(topic, e);
    }
    e[key]++;
  };
  for (const c of candidates) {
    const fl = c.firstLearned || "";
    const lr = c.lastReview || "";
    if (freq === "monthly") {
      const inMonth = (fl >= monthStart && fl <= scheduledDay) || (lr >= monthStart && lr <= scheduledDay);
      if (inMonth) bump(c.topic, c.topicName, "month");
      else if (fl === "✅" || (fl !== "" && fl < monthStart)) bump(c.topic, c.topicName, "prev"); // ✅=已学无日期（更早学习）
    } else if (freq === "custom") {
      bump(c.topic, c.topicName, "window"); // 自定义：统计全部候选，由规则决定挑多少
    } else {
      const winStart = new Date(scheduledTs - freqToMs(freq)).toISOString().slice(0, 10);
      if ((fl >= winStart && fl <= scheduledDay) || (lr >= winStart && lr <= scheduledDay)) bump(c.topic, c.topicName, "window");
    }
  }
  const statLines: string[] = [];
  for (const [, e] of byTopic) {
    if (freq === "monthly") {
      statLines.push("[" + e.name + "] 本月 " + e.month + " 门 → 选 " + Math.ceil(e.month * 0.5) + " 门；本月前 " + e.prev + " 门 → 选 " + Math.ceil(e.month * 0.25) + " 门");
    } else if (freq === "halfyear") {
      statLines.push("[" + e.name + "] 本周期 " + e.window + " 门 → 选 " + Math.ceil(e.window * 0.4) + " 门");
    } else if (freq === "yearly") {
      statLines.push("[" + e.name + "] 本周期 " + e.window + " 门 → 选 " + Math.ceil(e.window * 0.6) + " 门");
    } else if (freq === "custom") {
      statLines.push("[" + e.name + "] 候选 " + e.window + " 门（数量由你的规则决定）");
    } else {
      statLines.push("[" + e.name + "] 本周期 " + e.window + " 门 → 全部选入");
    }
  }
  // 每门课周期归属标记（服务端代码精确计算，LLM 按标记挑选、不自己算日期）：
  // daily/weekly/halfyear/yearly → ★ 本周期（窗口内）；monthly → ★ 本月 / ◐ 本月前；custom → 不打标记
  const flagByTitle = new Map<string, string>();
  if (freq !== "custom") {
    for (const c of candidates) {
      const fl = c.firstLearned || "";
      const lr = c.lastReview || "";
      if (freq === "monthly") {
        const inMonth = (fl >= monthStart && fl <= scheduledDay) || (lr >= monthStart && lr <= scheduledDay);
        if (inMonth) flagByTitle.set(c.title, "★ 本月");
        else if (fl === "✅" || (fl !== "" && fl < monthStart)) flagByTitle.set(c.title, "◐ 本月前"); // ✅=已学无日期（更早学习）
      } else {
        const winStart = new Date(scheduledTs - freqToMs(freq)).toISOString().slice(0, 10);
        if ((fl >= winStart && fl <= scheduledDay) || (lr >= winStart && lr <= scheduledDay)) flagByTitle.set(c.title, "★ 本周期");
      }
    }
  }
  const STATS = statLines.length ? statLines.join("\n") : "（本周期暂无学习/复习过的课程，请输出空数组）";
  const CLIST = candidates
    .map(
      (c, i) =>
        i + 1 + ". [" + c.topicName + "] " + c.title +
        " | 主题类型:" + (c.topicType || "-") +
        " | 首次学习:" + (c.firstLearned || "-") +
        " | 最近复习:" + (c.lastReview || "-") +
        " | 引导掌握度:" + (c.mastery || "-") +
        " | 考核掌握度:" + (c.examMastery || "-") +
        " | 上次考核:" + (c.lastExamAt || "-") +
        " | 计划复习:" + (c.planReviewAt || "-") +
        (flagByTitle.get(c.title) ? " " + flagByTitle.get(c.title) : "")
    )
    .join("\n");
  // 模板（家长可编辑的规则文本）+ 统一在尾部追加「统计 + 候选清单 + 标注说明」——
  // 模板无需自带 {{CLIST}} 占位符（旧模板若带会被替换为空），保证任何周期的 LLM 都能看到课程清单。
  const head = template
    .replace(/{{TODAY}}/g, TODAY)
    .replace(/{{RANGE}}/g, RANGE)
    .replace(/{{STATS}}/g, STATS)
    .replace(/{{CLIST}}/g, "");
  return (
    head +
    "\n\n【各主题选课数量】\n" +
    STATS +
    "\n\n【课程清单】每行一门：序号. [主题] 课程名 | 主题类型 | 首次学习 | 最近复习 | 引导掌握度 | 考核掌握度 | 上次考核 | 计划复习\n" +
    CLIST +
    "\n\n【标注说明】\n" +
    "- 周期标记：★ 本周期 / ★ 本月 / ◐ 本月前 = 课程在本周期窗口内的归属（系统按学习/复习日期精确计算，你只按标记挑选，不要自己推算日期）。\n" +
    "- 主题类型：必学 / 选学 / 复习 = 家长给孩子安排该主题时的「每天学习量类型」。家长规则里说的「必学课程」指主题类型=必学的主题下的课程；「只考核必学的」即只从这些课程中挑选。未标注（-）表示该主题未设置类型。\n" +
    "- 家长对标注一无所知，只会用日常说法（如「今天学习的课」「本周复习的课」「必学的」），请按此语义映射到上述标注后选择。"
  );
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
    // 考核 v2（§14）+ v3（§14.9）：带 ?schedule=<id>
    //  - 自定义排期（scope 指定范围）：直接返回带 rubric 的课程（家长已定范围，不经过选课 LLM）
    //  - 固定排期第一段（无 courses 参数）：返回选课 prompt + 全部候选课程元数据 → 客户端 LLM 选课
    //  - 固定排期第二段（courses=title1,title2）：返回选中课程（含 rubric）+ 判分 prompt
    const scheduleId = String((req.query as { schedule?: string }).schedule || "");
    const coursesParam = String((req.query as { courses?: string }).courses || "");
    if (scheduleId) {
      const sch = deps.db
        .prepare("SELECT * FROM exam_schedules WHERE id = ? AND child_id = ?")
        .get(scheduleId, childId) as Record<string, unknown> | undefined;
      if (!sch) return reply.code(404).send({ error: "排期不存在" });
      const scope = (() => {
        try {
          return JSON.parse(String(sch.scope || "{}"));
        } catch {
          return {};
        }
      })();
      const schedule = {
        id: String(sch.id),
        kind: String(sch.kind),
        freq: String(sch.freq),
        title: sch.kind === "custom" ? "自定义考核" : `固定考核（${freqLabel(String(sch.freq))}）`,
        scheduledAt: String(sch.scheduled_at),
        status: String(sch.status),
        scope,
      };
      // 自定义排期：scope 指定范围
      if (scope.topics || scope.courses) {
        // 第二段优先：客户端选课完成 → 按选中 title 返回 rubric + 判分 prompt（自定义与固定统一）
        if (coursesParam) {
          const titles = coursesParam
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          return {
            schedule,
            courses: fetchCoursesWithRubric(deps.config.dataDir, parentId, childId, titles),
            scoringPrompt: buildScoringPrompt(),
          };
        }
        const customPrompt = String(scope.prompt || "");
        if (customPrompt) {
          // 自定义考核带「考核 prompt」→ 走选课两段式：LLM 按家长写的规则从候选（scope 限定或全部）里挑
          const all = listLearnedCourseMeta(deps.db, deps.config.dataDir, parentId, childId);
          const topics = Array.isArray(scope.topics) ? scope.topics : [];
          const courses = Array.isArray(scope.courses) ? scope.courses : [];
          const candidates = all.filter(
            (c) => (!topics.length || topics.includes(c.topic)) && (!courses.length || courses.includes(c.title))
          );
          const selectionPrompt = buildSelectionPrompt(
            customPrompt,
            candidates,
            "custom",
            new Date(String(sch.scheduled_at)).getTime()
          );
          return { schedule, selectionPrompt, candidates };
        }
        // 无 prompt（旧行为）：直接返回范围课程（带 rubric），跳过选课 LLM
        return {
          schedule,
          courses: selectScopeCourses(deps.config.dataDir, parentId, childId, scope),
          scoringPrompt: buildScoringPrompt(),
        };
      }
      // 第二段：客户端选课完成 → 按选中 title 返回 rubric + 判分 prompt
      if (coursesParam) {
        const titles = coursesParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          schedule,
          courses: fetchCoursesWithRubric(deps.config.dataDir, parentId, childId, titles),
          scoringPrompt: buildScoringPrompt(),
        };
      }
      // 第一段：选课 prompt（家长可编辑模板 + 注入周期范围/统计/候选清单）+ 候选课程元数据（无 rubric）
      const cfg = getFixedConfig(deps.db, parentId);
      const freq = String(sch.freq || "weekly");
      const candidates = listLearnedCourseMeta(deps.db, deps.config.dataDir, parentId, childId);
      const selectionPrompt = buildSelectionPrompt(
        cfg.selectionPrompts[freq] || DEFAULT_SELECTION_PROMPTS[freq] || DEFAULT_SELECTION_PROMPTS.weekly,
        candidates,
        freq,
        new Date(String(sch.scheduled_at)).getTime()
      );
      return { schedule, selectionPrompt, candidates };
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
            "SELECT title, first_learned, last_review, mastery FROM courses WHERE topic = ? AND (first_learned != '' OR last_review != '' OR status = '✅') ORDER BY sort_order, title"
          )
          .all(t.topic_key) as Array<{ title: string; first_learned: string; last_review: string; mastery: string }>;
        if (learned.length === 0) continue;
        const rubrics = parent
          .prepare("SELECT title, assess_rubric FROM courses WHERE topic = ? AND assess_rubric != ''")
          .all(t.topic_key) as Array<{ title: string; assess_rubric: string }>;
        const rubricMap = new Map(rubrics.map((r) => [r.title, r.assess_rubric]));
        out.push({
          topicKey: t.topic_key,
          name: t.name,
          assessMethod: t.assess_method,
          courses: learned.map((c) => ({
            title: c.title,
            firstLearned: c.first_learned ?? "",
            lastReview: c.last_review ?? "",
            mastery: c.mastery ?? "",
            assessRubric: rubricMap.get(c.title) ?? "",
          })),
        });
      }
      return { topics: out, scoringPrompt: buildScoringPrompt() };
    } finally {
      kb.close();
      parent.close();
    }
  });

  // ===== 考核排期 v2（§14.2）：列表（懒生成固定排期）+ 自定义创建 + 开始 + 完成 =====
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
    const generated = ensureFixedSchedules(deps.db, parentId, childId);
    const rows = deps.db
      .prepare("SELECT * FROM exam_schedules WHERE child_id = ? ORDER BY scheduled_at ASC LIMIT 100")
      .all(childId) as Array<Record<string, unknown>>;
    const now = Date.now();
    const schedules = rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      freq: String(r.freq),
      scheduledAt: String(r.scheduled_at),
      status: String(r.status),
      attemptId: String(r.attempt_id ?? ""),
      title: r.kind === "custom" ? "自定义考核" : `固定考核（${freqLabel(String(r.freq))}）`,
      scope: (() => {
        try {
          return JSON.parse(String(r.scope ?? "{}"));
        } catch {
          return {};
        }
      })(),
      pending: String(r.status) === "pending" && new Date(String(r.scheduled_at)).getTime() <= now,
    }));
    return { generated, schedules };
  });

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
    const id = `sch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    deps.db
      .prepare(
        "INSERT INTO exam_schedules (id, parent_id, child_id, kind, freq, scheduled_at, scope, status, created_at) VALUES (?, ?, ?, 'custom', '', ?, ?, 'pending', ?)"
      )
      .run(id, parentId, childId, parsedAt.toISOString(), JSON.stringify(body.scope ?? {}), new Date().toISOString());
    return { ok: true, id };
  });

  app.post("/api/v1/exam/schedules/:id/start", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { id } = req.params as { id: string };
    const row = deps.db.prepare("SELECT child_id FROM exam_schedules WHERE id = ?").get(id) as { child_id?: string } | undefined;
    if (!row) return reply.code(404).send({ error: "排期不存在" });
    try {
      assertChildOwned(deps.db, parentId, row.child_id!);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    deps.db.prepare("UPDATE exam_schedules SET status = 'started' WHERE id = ? AND status = 'pending'").run(id);
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
    const row = deps.db.prepare("SELECT child_id FROM exam_schedules WHERE id = ?").get(id) as { child_id?: string } | undefined;
    if (!row) return reply.code(404).send({ error: "排期不存在" });
    try {
      assertChildOwned(deps.db, parentId, row.child_id!);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    deps.db
      .prepare("UPDATE exam_schedules SET status = 'done', attempt_id = ? WHERE id = ?")
      .run(attemptId, id);
    return { ok: true };
  });

  // 取消排期（家长端）：只允许取消「待考核」未开始的排期；固定排期取消后懒生成会按配置自动补
  app.delete("/api/v1/exam/schedules/:id", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { id } = req.params as { id: string };
    const row = deps.db.prepare("SELECT child_id, status FROM exam_schedules WHERE id = ?").get(id) as
      | { child_id?: string; status?: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: "排期不存在" });
    try {
      assertChildOwned(deps.db, parentId, row.child_id!);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    if (row.status !== "pending") return reply.code(400).send({ error: "只能取消「待考核」状态的排期" });
    deps.db.prepare("DELETE FROM exam_schedules WHERE id = ?").run(id);
    return { ok: true };
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
    // 频率或时刻变化 → 重置锚点；并清掉未来「待考核」的固定排期，
    // 避免旧锚点（不同时刻）的排期按天去重挡住新时刻排期的生成（2026-09-01 实测旧 11:26 排期挡住 20:00）
    const changed =
      JSON.stringify(frequencies) !== JSON.stringify(cur.frequencies) ||
      time !== cur.time ||
      weekly.weekday !== (cur.weekly?.weekday ?? 1) ||
      weekly.time !== (cur.weekly?.time ?? cur.time);
    if (changed) {
      deps.db
        .prepare("DELETE FROM exam_schedules WHERE kind = 'fixed' AND status = 'pending' AND scheduled_at > ?")
        .run(new Date().toISOString());
    }
    const next: FixedExamConfig = {
      frequencies,
      courseCount,
      time,
      weekly,
      anchorAt: changed ? "" : cur.anchorAt, // 变化时锚点置空 → 懒生成按配置重新铺排期
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
    // 掌握度双轨：把本次课程聚合率回写孩子 kb courses.exam_mastery（引导 mastery 不动）
    const cm = body.courseMastery as Record<string, { rate?: number }> | null;
    if (cm && typeof cm === "object") {
      const kb = openKb(deps.config.dataDir, parentId, childId);
      try {
        const topic = String(body.topic ?? "");
        for (const [course, m] of Object.entries(cm)) {
          const rate = typeof m?.rate === "number" ? m.rate : 0;
          const level = masteryLevel(rate);
          kb.prepare("UPDATE courses SET exam_mastery = ? WHERE topic = ? AND title = ?").run(
            level,
            topic,
            course
          );
        }
      } finally {
        kb.close();
      }
    }
    // 考核 v2：关联排期 → 标记完成（done + attempt_id）
    const scheduleId = String(body.scheduleId ?? "");
    if (scheduleId) {
      deps.db
        .prepare("UPDATE exam_schedules SET status = 'done', attempt_id = ? WHERE id = ? AND child_id = ?")
        .run(id, scheduleId, childId);
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
}
