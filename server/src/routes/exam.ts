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
import { attachStructuredQuestions } from "../assess-selection.js";
import {
  getOrCreateCategory,
  saveQuestion,
  getQuestion,
  getCourseUuid,
  replaceCourseContent,
  listCourseContent,
  listCategories,
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
 * 客户端拿到后拼入本场考核的题目与孩子答案；rubric 为家长写的 assess_rubric。
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

/** 考核掌握度等级（与引导 mastery 双轨；写入孩子 kb courses.exam_mastery）。 */
function masteryLevel(rate: number): string {
  if (rate >= 0.9) return "熟练";
  if (rate >= 0.7) return "良好";
  if (rate >= 0.5) return "学习中";
  return "薄弱";
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
 * 一次性迁移：把存量考核排期的时间粒度从「具体时刻」归一到「该日期本地 0 点」。
 * 2026-09-04 起考核只按日期（用户拍板：只设考核日期、不约定时间，到当天 0 点即可考）。
 * 只改仍为 pending/started 的行（done 历史保留原样），幂等（已为 0 点则跳过）。
 */
export function normalizeExamScheduleDays(db: DatabaseSync): number {
  const rows = db
    .prepare("SELECT id, scheduled_at, status FROM exam_schedules WHERE status IN ('pending','started')")
    .all() as Array<{ id: string; scheduled_at: string; status: string }>;
  let n = 0;
  const upd = db.prepare("UPDATE exam_schedules SET scheduled_at = ? WHERE id = ?");
  for (const r of rows) {
    const ts = new Date(r.scheduled_at).getTime();
    if (Number.isNaN(ts)) continue;
    const ds = dayStart(ts);
    if (ds !== ts) {
      upd.run(new Date(ds).toISOString(), r.id);
      n++;
    }
  }
  return n;
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
  const todayDay = dayStart(now); // 今天本地 0 点
  const byDay = new Map<number, { day: number; freq: string; rank: number }>();
  const add = (day: number, freq: string) => {
    const cur = byDay.get(day);
    if (!cur || FREQ_RANK[freq] > cur.rank) byDay.set(day, { day, freq, rank: FREQ_RANK[freq] });
  };
  // ⚠️ 2026-09-04：考核只按「日期」粒度（用户拍板），不再约定具体时刻——排期时间都取该日本地 0 点，
  // 只要到了这一天（0 点起）整个白天都可考核。daily/weekly 不再读取 cfg.time。
  // 每日：今天起每天生成一个「当天可考」排期（含今天——今天 0 点已过即今天 pending，全天可考）
  if (cfg.frequencies.includes("daily")) {
    let d = new Date(todayDay);
    while (d.getTime() <= now + HORIZON_MS) {
      add(dayStart(d.getTime()), "daily");
      d.setDate(d.getDate() + 1);
    }
  }
  // 每周：cfg.weekly.weekday（1=周一…7=周日），该日的 0 点；今天若是该周几则含今天
  if (cfg.frequencies.includes("weekly")) {
    const w = cfg.weekly || {};
    const weekday = Number(w.weekday) || 1;
    const target = weekday % 7; // 1-7 → JS getDay（0=周日）：1→周一,7→周日
    let d = new Date(todayDay);
    d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7));
    while (d.getTime() <= now + HORIZON_MS) {
      add(dayStart(d.getTime()), "weekly");
      d.setDate(d.getDate() + 7);
    }
  }
  // monthly/halfyear/yearly：保留旧 anchor 步进（兼容旧数据；UI 已不再生成这三档），时间也取日 0 点
  const legacy = cfg.frequencies.filter((f) => f === "monthly" || f === "halfyear" || f === "yearly");
  if (legacy.length) {
    let anchor: number;
    if (cfg.anchorAt) {
      anchor = dayStart(new Date(cfg.anchorAt).getTime());
    } else {
      anchor = todayDay;
    }
    for (const freq of legacy) {
      const step = freqToMs(freq);
      for (let t = anchor; t <= anchor + HORIZON_MS; t += step) add(dayStart(t), freq);
    }
  }
  // 只保留「还没生成」的排期（同日已存在 fixed 排期 → 跳过）；按日期排序
  const existing = new Set(
    (db
      .prepare("SELECT scheduled_at FROM exam_schedules WHERE child_id = ? AND kind = 'fixed'")
      .all(childId) as Array<{ scheduled_at: string }>).map((r) => dayStart(new Date(r.scheduled_at).getTime()))
  );
  const pending = Array.from(byDay.values())
    .filter((x) => !existing.has(x.day))
    .sort((a, b) => a.day - b.day);
  if (!pending.length) return 0;
  const ins = db.prepare(
    "INSERT OR IGNORE INTO exam_schedules (id, parent_id, child_id, kind, freq, scheduled_at, scope, status, created_at) VALUES (?, ?, ?, 'fixed', ?, ?, '{}', 'pending', ?)"
  );
  let n = 0;
  for (const p of pending) {
    const id = `sch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ins.run(id, parentId, childId, p.freq, new Date(p.day).toISOString(), new Date().toISOString());
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
    const rows = kb
      .prepare(
        "SELECT topic, title, status, mastery, exam_mastery, first_learned, last_review, review_count FROM courses ORDER BY topic, sort_order, title"
      )
      .all() as Array<{
        topic: string;
        title: string;
        status: string;
        mastery: string;
        exam_mastery: string;
        first_learned: string;
        last_review: string;
        review_count: number;
      }>;
    const out: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      const fl = r.first_learned ?? "";
      const lr = r.last_review ?? "";
      const learnedNoDate = String(r.status ?? "").trim() === "✅" && !fl;
      const es = examStat.get(r.title);
      const rp = reinforce[r.title];
      // 仅纳入有学习/复习/考核信号的课程（复习计划制定聚焦于已学课程）
      if (!fl && !lr && String(r.status ?? "").trim() !== "✅" && !es) continue;
      out.push({
        topic: r.topic,
        topicName: topicNames.get(r.topic) ?? r.topic,
        title: r.title,
        topicType: childTopicTypes.get(r.topic) ?? "",
        status: r.status ?? "⬜",
        mastery: r.mastery ?? "",
        firstLearned: learnedNoDate ? "✅" : fl,
        lastReview: lr,
        reviewCount: Number(r.review_count) || 0,
        lastExamAt: es?.lastAt ?? "",
        examCount: es?.ids.size ?? 0,
        examMastery: r.exam_mastery ?? "",
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
        .prepare("SELECT topic, status, mastery, exam_mastery, first_learned, last_review FROM courses WHERE title = ?")
        .all(title) as Array<{
        topic: string;
        status: string;
        mastery: string;
        exam_mastery: string;
        first_learned: string;
        last_review: string;
      }>;
      if (!hit.length) {
        unmatched.push(title);
        continue;
      }
      const r = hit[0]; // 同名跨主题歧义罕见：取首行（与 fetchCoursesWithRubric 的 title 口径一致）
      const fl = r.first_learned ?? "";
      courses.push({
        topic: r.topic,
        topicName: topicNames.get(r.topic) ?? r.topic,
        title,
        topicType: childTopicTypes.get(r.topic) ?? "",
        firstLearned: String(r.status ?? "").trim() === "✅" && !fl ? "✅" : fl,
        lastReview: r.last_review ?? "",
        mastery: r.mastery ?? "",
        examMastery: r.exam_mastery ?? "",
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


function fetchCoursesWithRubric(
  dataDir: string,
  parentId: string,
  childId: string,
  titles: string[]
): Array<{ title: string; topic: string; firstLearned: string; lastReview: string; mastery: string; examMastery: string; assessRubric: string; assessMethod: string }> {
  const kb = openKb(dataDir, parentId, childId);
  const parent = openParentLib(dataDir, parentId);
  try {
    const rubrics = parent
      .prepare("SELECT topic, title, assess_rubric FROM courses WHERE assess_rubric != ''")
      .all() as Array<{ topic: string; title: string; assess_rubric: string }>;
    const rubricMap = new Map(rubrics.map((r) => [r.topic + "::" + r.title, r.assess_rubric]));
    // 主题考核方法说明（家长可编辑，按孩子区分题目构成与不考范围）——出题 prompt 必须读到它，
    // 否则模型只会按 rubric「全部知识点」出题，家长在方法里写的“考什么/不考什么”全部落空（2026-09-09）。
    const methodMap = new Map(
      (parent.prepare("SELECT topic_key, assess_method FROM topics").all() as Array<{ topic_key: string; assess_method: string }>)
        .map((r) => [r.topic_key, String(r.assess_method || "")] as [string, string])
        .filter(([, v]) => !!v)
    );
    const out: Array<{ title: string; topic: string; firstLearned: string; lastReview: string; mastery: string; examMastery: string; assessRubric: string; assessMethod: string }> = [];
    for (const t of titles) {
      const kbRow = kb
        .prepare("SELECT topic, mastery, exam_mastery, first_learned, last_review FROM courses WHERE title = ?")
        .get(t) as { topic?: string; mastery?: string; exam_mastery?: string; first_learned?: string; last_review?: string } | undefined;
      if (!kbRow) continue; // 孩子库无此课 → 跳过
      const topic = String(kbRow.topic ?? "");
      out.push({
        title: t,
        topic,
        firstLearned: String(kbRow.first_learned ?? ""),
        lastReview: String(kbRow.last_review ?? ""),
        mastery: String(kbRow.mastery ?? ""),
        examMastery: String(kbRow.exam_mastery ?? ""),
        assessRubric: rubricMap.get(topic + "::" + t) ?? "",
        assessMethod: methodMap.get(topic) ?? "",
      });
    }
    return out;
  } finally {
    kb.close();
    parent.close();
  }
}

/** 构建某频率档的完整选课 prompt：模板（家长可编辑）+ 注入今天日期/周期范围/统计/候选清单。
 *  source="learned"（默认）：候选来自「学习/复习痕迹」，按首次学习/最近复习打周期标记；
 *  source="plan"：候选来自「家长学习计划」（study_plan_items），**计划内无论是否完成都考核**，
 *  按计划日期标注（daily=今天计划；weekly=近 7 天计划），供每日/每周固定考核使用。 */
export function buildSelectionPrompt(
  template: string,
  candidates: CourseMeta[],
  freq: string,
  scheduledTs: number,
  source: "learned" | "plan" = "learned"
): string {
  const TODAY = new Date().toISOString().slice(0, 10);
  const scheduledDay = new Date(scheduledTs).toISOString().slice(0, 10);
  const monthStart = scheduledDay.slice(0, 7) + "-01";
  const planWin = source === "plan" ? planWindowFor(freq, scheduledTs) : null;
  let RANGE: string;
  if (planWin) RANGE = planWin.start === planWin.end ? planWin.start : planWin.start + " ~ " + planWin.end;
  else if (freq === "daily") RANGE = TODAY;
  else if (freq === "monthly") RANGE = monthStart + " ~ " + scheduledDay;
  else if (freq === "custom") RANGE = "（自定义考核，选课范围由下面的规则指定，不按周期窗口）";
  else RANGE = new Date(scheduledTs - freqToMs(freq)).toISOString().slice(0, 10) + " ~ " + scheduledDay;
  // 每主题统计（monthly：本月/本月前；其余：本周期窗口内；custom：全部候选；plan：窗口内计划课）
  const byTopic = new Map<string, { name: string; month: number; prev: number; window: number }>();
  const bump = (topic: string, name: string, key: "month" | "prev" | "window") => {
    let e = byTopic.get(topic);
    if (!e) {
      e = { name, month: 0, prev: 0, window: 0 };
      byTopic.set(topic, e);
    }
    e[key]++;
  };
  if (planWin) {
    // 计划模式：候选即窗口内计划课，逐主题计数全部选入
    for (const c of candidates) bump(c.topic, c.topicName, "window");
  } else {
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
  }
  const statLines: string[] = [];
  for (const [, e] of byTopic) {
    if (planWin) {
      statLines.push("[" + e.name + "] " + planWin.label + "计划 " + e.window + " 门 → 全部选入");
    } else if (freq === "monthly") {
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
  // daily/weekly/halfyear/yearly → ★ 本周期（窗口内）；monthly → ★ 本月 / ◐ 本月前；custom/plan → 不打标记（plan 用「计划日期」列标注）
  const flagByTitle = new Map<string, string>();
  if (freq !== "custom" && !planWin) {
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
  const STATS = statLines.length
    ? statLines.join("\n")
    : planWin
      ? "（" + planWin.label + "没有安排学习计划课程，请输出空数组）"
      : "（本周期暂无学习/复习过的课程，请输出空数组）";
  const CLIST = candidates
    .map((c, i) => {
      const parts = [
        i + 1 + ". [" + c.topicName + "] " + c.title,
        planWin ? "计划日期:" + (c.planDate || "-") : null,
        "主题类型:" + (c.topicType || "-"),
        "首次学习:" + (c.firstLearned || "-"),
        "最近复习:" + (c.lastReview || "-"),
        "引导掌握度:" + (c.mastery || "-"),
        "考核掌握度:" + (c.examMastery || "-"),
        "上次考核:" + (c.lastExamAt || "-"),
        planWin ? null : "计划复习:" + (c.planReviewAt || "-"),
      ].filter((x): x is string => x !== null);
      const flag = flagByTitle.get(c.title);
      if (flag) parts.push(flag);
      return parts.join(" | ");
    })
    .join("\n");
  // 模板（家长可编辑的规则文本）+ 统一在尾部追加「统计 + 候选清单 + 标注说明」——
  // 模板无需自带 {{CLIST}} 占位符（旧模板若带会被替换为空），保证任何周期的 LLM 都能看到课程清单。
  const head = template
    .replace(/{{TODAY}}/g, TODAY)
    .replace(/{{RANGE}}/g, RANGE)
    .replace(/{{STATS}}/g, STATS)
    .replace(/{{CLIST}}/g, "");
  const legendHead = "【课程清单】每行一门：序号. [主题] 课程名" + (planWin ? " | 计划日期" : "") + " | 主题类型 | 首次学习 | 最近复习 | 引导掌握度 | 考核掌握度 | 上次考核" + (planWin ? "" : " | 计划复习") + "\n";
  const notes = planWin
    ? "\n\n【标注说明】\n" +
      "- 候选课程来自家长设置的**学习计划**（按日期排期，窗口 " + RANGE + "）：**计划内的课程无论是否完成都要考核**——不要用「是否学过/复习过」过滤课程，也不要额外补录计划外的课。\n" +
      "- 「计划日期」= 家长计划里安排的日期（窗口内排过多次的取最早一次）。家长口中的「今天学的课」= 计划日期为今天的课；「本周/近几天学的课」= 计划日期落在本窗口内的课。\n" +
      "- 若你的规则模板里出现「★ 本周期」「学习/复习过的课程」等字眼，那是旧版规则的残留描述，请忽略，以本段说明为准。\n" +
      "- 主题类型：必学 / 选学 / 复习 = 家长给孩子主题标注的考核选题类型。家长说的「必学课程」指主题类型=必学的主题下的课程；「只考核必学的」即只从这些课程中挑选。未标注（-）表示未设置类型。\n" +
      "- 家长对标注一无所知，只会用日常说法（如「今天学习的课」「必学的」），请按此语义映射到「计划日期」与「主题类型」后选择。"
    : "\n\n【标注说明】\n" +
      "- 周期标记：★ 本周期 / ★ 本月 / ◐ 本月前 = 课程在本周期窗口内的归属（系统按学习/复习日期精确计算，你只按标记挑选，不要自己推算日期）。\n" +
      "- 主题类型：必学 / 选学 / 复习 = 家长给孩子安排该主题时标注的考核选题类型（ISSUE-033 起与每日学习量无关——每天学什么由学习计划决定）。家长规则里说的「必学课程」指主题类型=必学的主题下的课程；「只考核必学的」即只从这些课程中挑选。未标注（-）表示该主题未设置类型。\n" +
      "- 家长对标注一无所知，只会用日常说法（如「今天学习的课」「本周复习的课」「必学的」），请按此语义映射到上述标注后选择。";
  return head + "\n\n【各主题选课数量】\n" + STATS + "\n\n" + legendHead + CLIST + notes;
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
      // 孩子显示名（考核方法 assess_method 常按孩子名分段，出题 prompt 需要点名当前孩子）
      const childRow = deps.db.prepare("SELECT name FROM children WHERE id = ?").get(childId) as { name?: string } | undefined;
      const childName = String(childRow?.name ?? "");
      // 结构化考核（v2）：课程有挂载内容时由服务端按孩子方法直接抽题（course.questions），不再客户端 LLM 出题；
      // 无挂载内容(非结构化)照旧返回 rubric，客户端走旧路径。
      const structuredCourses = (titles: string[]) => {
        const cs = fetchCoursesWithRubric(deps.config.dataDir, parentId, childId, titles);
        try {
          const pl = openParentLib(deps.config.dataDir, parentId);
          attachStructuredQuestions(pl, childId, cs);
          pl.close();
        } catch (e) {
          console.warn(`[exam] 结构化挂题失败（回退 rubric 旧路径）：${(e as Error).message}`);
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
      // 自定义考核（2026-09-09 起）：范围由排期 scope.courses **精确决定**（家长 agent 解析确定课程名），
      // 不再走「规则文本 → 选课 LLM」（旧的选课 prompt 两段式已废弃，见 ISSUE-054）。
      if (sch.kind === "custom") {
        const scopeCourses = (Array.isArray(scope.courses) ? scope.courses : [])
          .map((x: unknown) => String(x ?? "").trim())
          .filter(Boolean);
        if (!scopeCourses.length) {
          return reply.code(400).send({
            error: "该自定义考核没有确定要考的课程。2026-09-09 起自定义考核需由家长通过对话（家长助手）安排并明确课程；请让家长重新安排这次考核。",
          });
        }
        return {
          schedule,
          childName,
          courses: structuredCourses(scopeCourses),
          scoringPrompt: buildScoringPrompt(),
        };
      }
      // 固定档：仅保留 daily | weekly（monthly/halfyear/yearly 已下线，历史排期不可再考）
      const freq = String(sch.freq || "weekly");
      if (freq === "monthly" || freq === "halfyear" || freq === "yearly") {
        return reply.code(400).send({
          error: "每月/每半年/每年考核已下线（2026-09-09）。这类考核请改为「自定义考核」：通过和家长助手对话说明要考的内容即可。",
        });
      }
      // daily/weekly：内置规则 = 本周期学习计划里的「必学主题」课程全部考核（不再走选课 LLM）。
      // 「必学」判定 = 该课主题考核类型为必学；**未标注类型**的历史主题按默认必学纳入考核
      // （否则旧数据无类型标注会导致固定考核永远无课）；明确标了「选学」的主题课程排除。
      // 想自定义范围（含选学/指定章节）→ 一律用自定义考核（家长 agent 定课程）。
      {
        const ts = new Date(String(sch.scheduled_at)).getTime();
        const win = planWindowFor(freq, ts);
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
        return {
          schedule,
          childName,
          courses: structuredCourses(must.map((c) => c.title)),
          scoringPrompt: buildScoringPrompt(),
          // 计划里匹配不到孩子库课程的文本（供调试/提示）
          unmatched,
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
    const migrated = normalizeExamScheduleDays(deps.db);
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
    // 2026-09-04：自定义考核也只按日期——入库时间取该日期本地 0 点（到当天即可考）
    const dayTs = dayStart(parsedAt.getTime());
    deps.db
      .prepare(
        "INSERT INTO exam_schedules (id, parent_id, child_id, kind, freq, scheduled_at, scope, status, created_at) VALUES (?, ?, ?, 'custom', '', ?, ?, 'pending', ?)"
      )
      .run(id, parentId, childId, new Date(dayTs).toISOString(), JSON.stringify(body.scope ?? {}), new Date().toISOString());
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

  // ===== 考核内容结构化 v2（ISSUE-067 步骤2：家长 agent 读写新表；权威库 = 服务端 parent.sqlite） =====
  const openParentFor = (parentId: string) => openParentLib(deps.config.dataDir, parentId);
  /** item 里给 categoryId 或 categoryName(+behavior)：返回该主题下类别 uuid 与行为；两者都给优先 id。 */
  const resolveCategory = (
    db: DatabaseSync,
    topic: string,
    p: Record<string, unknown>
  ): { id: string; behavior: string } => {
    if (typeof p.categoryId === "string" && p.categoryId) {
      const row = db
        .prepare("SELECT id, behavior FROM topic_categories WHERE id = ? AND topic_id = ?")
        .get(p.categoryId, topic) as { id: string; behavior?: string } | undefined;
      if (!row) throw new Error(`类别 ${p.categoryId} 不属于主题 ${topic}（或不存在）`);
      return { id: row.id, behavior: String(row.behavior || "generic") };
    }
    if (typeof p.categoryName === "string" && p.categoryName.trim()) {
      const c = getOrCreateCategory(db, topic, p.categoryName.trim(), String(p.behavior || "generic"));
      return { id: c.id, behavior: c.behavior };
    }
    throw new Error("每项需要 categoryId 或 categoryName");
  };

  app.get("/api/v1/assess/topics/:topic/categories", async (req, reply) => {
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
      return { topic, categories: listCategories(db, topic) };
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

  app.post("/api/v1/assess/categories", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const b = (req.body || {}) as { topicId?: string; name?: string; behavior?: string };
    if (!b.topicId || !b.name) return reply.code(400).send({ error: "需要 topicId + name" });
    const db = openParentFor(parentId);
    try {
      const category = getOrCreateCategory(db, String(b.topicId), String(b.name).trim(), String(b.behavior || "generic"));
      return { category };
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

  /** 整课保存考试内容：topic+title 定位课程；每项挂类别+若干题（可引用题库题或内联新建）。事务替换旧挂载。 */
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
      const replaceItems: Array<{ categoryId: string; overview: string; questionIds: string[] }> = [];
      let created = 0;
      let linked = 0;
      for (const it of b.items) {
        const cat = resolveCategory(db, String(b.topic), it);
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
            if (!stem || !answer) return reply.code(400).send({ error: `类别「${String(it.categoryName || it.categoryId || "")}」下内联题目需要 stem + answer` });
            const id = saveQuestion(db, {
              stem,
              answer,
              scoring: qo.scoring != null ? String(qo.scoring) : null,
              pointMax: Number(qo.pointMax) || 10,
              // 行为以题级为准；题目没写时继承该类别行为（兼容存量写法）
              behavior: String(qo.behavior || cat.behavior || "generic"),
              note: qo.note != null ? String(qo.note) : "",
              knowledgeSummary: qo.knowledgeSummary != null ? String(qo.knowledgeSummary) : "",
              options: Array.isArray(qo.options) ? (qo.options as Array<{ key: string; text: string }>) : undefined,
            });
            qids.push(id);
            created++;
          }
        }
        replaceItems.push({ categoryId: cat.id, overview: String(it.overview ?? ""), questionIds: qids });
      }
      replaceCourseContent(db, uuid, replaceItems);
      return { ok: true, courseUuid: uuid, categories: replaceItems.length, questionsCreated: created, questionsLinked: linked };
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
      if (b.require) {
        const reqIds: Record<string, number> = {};
        const cats = listCategories(db, String(b.topicId));
        const byName = new Map(cats.map((c) => [c.name, c.id]));
        const byId = new Set(cats.map((c) => c.id));
        for (const [k, v] of Object.entries(b.require)) {
          const id = byName.get(k) ?? (byId.has(k) ? k : undefined);
          if (!id) return reply.code(400).send({ error: `类别「${k}」不属于主题 ${b.topicId}` });
          reqIds[id] = Math.max(1, Number(v) || 1);
        }
        cur.require = reqIds;
      }
      if (Array.isArray(b.exclude)) {
        const cats = listCategories(db, String(b.topicId));
        const byName = new Map(cats.map((c) => [c.name, c.id]));
        cur.exclude = b.exclude
          .map((k) => byName.get(k) ?? (cats.some((c) => c.id === k) ? k : null))
          .filter((x): x is string => !!x);
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
