/**
 * 错题整理后台任务（ISSUE-114 方案 B/C 合并定案，2026-09-29）：
 * 把无法归类到既有知识点的错题/查词字词，经 LLM 分层分析后沉淀到**专属「错题整理」主题**
 * （隔离在家长库自己的主题下，不污染既有课程的知识点表）：
 *   - 查词字词 → 「字词」课程的知识点（name=字词本身），并自动出一道考核题；
 *   - 其余错题 → LLM 三层筛选（主题→课程→知识点）尝试挂到既有知识点；
 *     挂不上 → 错题整理主题下的归类课程（LLM 建议类别，如「应用题」）建知识点承接。
 * 同时：把主题课程分配进孩子库（家长才能对这些课排考核）、维护 method_spec.perChild
 * （require=该孩子 open 错题的知识点——兄弟孩子共用「字词」课程但各考各的词）。
 *
 * **调度由家长控制**：家长中心「定时任务」页创建 mistake_sorting 任务并分配孩子后才触发
 * （times=家长设的时间点，多行任务时间去重）；未创建该任务 = 不跑（opt-in，与 autoNewSession 同口径）。
 *
 * 幂等/状态：mistake_book.knowledge_point_id 非空 = 已处理（含关联到既有 kp 的）；
 * 家长库侧全部按唯一键 ensure（topics.name / courses(topic,title) / kp UNIQUE(course_uuid,name) /
 * ckq 复合主键 / 题目按 bridge 是否已挂判断），任务重跑安全。
 * LLM 失败 → 抛错 → 调度器不记 worker_state，下一桶自愈重试。
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { openKb } from "../db/kb.js";
import { openParentLib } from "../db/parent-lib.js";
import { registerTask } from "./tasks.js";
import type { WorkerTask, WorkerTaskCtx, WorkerRunResult } from "./tasks.js";
import { createExamSession, extractJson, lastAssistantText, type ExamEngineDeps } from "../agent/exam-engine.js";

export const SORTING_TOPIC = "错题整理"; // name = topic_key（同值：getMethodSpec/getCourseUuid 两条匹配路径都对齐）
export const WORD_COURSE = "字词";
export const FALLBACK_COURSE = "未归类错题";
const BATCH_LIMIT = 40; // 单轮最多处理的错题条数
const QUESTION_CAP = 8; // 单轮最多新生成的字词题目数

interface MistakeRowLite {
  id: string;
  kind: "wrong_question" | "unknown_word" | "weak_point";
  content: string;
  detail: string;
  course_ref: string;
  count: number;
}

// ==================== 家长库侧 ensure（纯 SQL，幂等） ====================

/** 确保「错题整理」主题与其下的课程存在，返回 topic_key。 */
export function ensureSortingTopic(parent: DatabaseSync): string {
  parent
    .prepare("INSERT OR IGNORE INTO topics (name, topic_key, method, assess_method) VALUES (?, ?, '', '')")
    .run(SORTING_TOPIC, SORTING_TOPIC);
  return SORTING_TOPIC;
}

export function ensureSortingCourse(parent: DatabaseSync, title: string): string {
  const row = parent.prepare("SELECT uuid FROM courses WHERE topic = ? AND title = ?").get(SORTING_TOPIC, title) as
    | { uuid?: string }
    | undefined;
  if (row?.uuid) return row.uuid;
  const uuid = randomUUID().replace(/-/g, "");
  parent
    .prepare(
      `INSERT INTO courses (topic, title, uuid, sort_order, lesson_method, assess_rubric, tags)
       VALUES (?, ?, ?, 0, '', '', '错题整理自动维护')
       ON CONFLICT(topic, title) DO UPDATE SET uuid = excluded.uuid`
    )
    .run(SORTING_TOPIC, title, uuid);
  return uuid;
}

/** 确保 (课程, name) 知识点存在（detail 非空时补缺省），返回 kp id。 */
export function ensureKnowledgePoint(parent: DatabaseSync, courseUuid: string, name: string, detail: string): string {
  const clean = String(name ?? "").trim().slice(0, 100);
  if (!clean) throw new Error("知识点名不能为空");
  const existing = parent
    .prepare("SELECT id FROM knowledge_points WHERE course_uuid = ? AND name = ?")
    .get(courseUuid, clean) as { id?: string } | undefined;
  if (existing?.id) return existing.id;
  const id = randomUUID().replace(/-/g, "");
  parent
    .prepare("INSERT INTO knowledge_points (id, course_uuid, name, detail, seq) VALUES (?, ?, ?, ?, 999)")
    .run(id, courseUuid, clean, String(detail ?? "").slice(0, 2000));
  return id;
}

/** 把一道生成的题目入库并挂到知识点下（幂等：该 kp 已有挂题则跳过）。返回是否新挂。 */
export function attachGeneratedQuestion(
  parent: DatabaseSync,
  courseUuid: string,
  kpId: string,
  q: { stem: string; answer: string; options?: string; overview?: string }
): boolean {
  const has = parent
    .prepare("SELECT 1 FROM course_knowledge_questions WHERE course_id = ? AND knowledge_point_id = ? LIMIT 1")
    .get(courseUuid, kpId);
  if (has) return false;
  const qid = randomUUID().replace(/-/g, "");
  parent
    .prepare(
      `INSERT INTO question_bank (id, stem, answer, scoring, point_max, behavior, note, knowledge_summary, options)
       VALUES (?, ?, ?, '答案含关键字即可', 10, 'generic', '错题整理任务自动生成', ?, ?)`
    )
    .run(qid, q.stem.slice(0, 2000), q.answer.slice(0, 2000), q.stem.slice(0, 200), q.options ?? "[]");
  parent
    .prepare("INSERT INTO course_knowledge_questions (course_id, knowledge_point_id, question_id, overview) VALUES (?, ?, ?, ?)")
    .run(courseUuid, kpId, qid, String(q.overview ?? "").slice(0, 500));
  return true;
}

/** 把错题条目关联到知识点（孩子库 mistake_book 回填 knowledge_point_id/name 快照）。 */
export function linkMistakeToKp(
  kb: DatabaseSync,
  mistakeId: string,
  kpId: string,
  kpName: string
): void {
  kb.prepare("UPDATE mistake_book SET knowledge_point_id = ?, knowledge_point_name = ?, updated_at = ? WHERE id = ?")
    .run(kpId, kpName.slice(0, 200), new Date().toISOString(), mistakeId);
}

/** 主题分配进孩子库：topics + 该主题全部课程（带 uuid 锚点），INSERT OR IGNORE 幂等。 */
export function syncSortingCoursesToChild(parent: DatabaseSync, kb: DatabaseSync, childId: string): void {
  kb.prepare("INSERT OR IGNORE INTO topics (name, topic_key, learn_type) VALUES (?, ?, 'required')")
    .run(SORTING_TOPIC, SORTING_TOPIC);
  const courses = parent
    .prepare("SELECT title, uuid, sort_order FROM courses WHERE topic = ? ORDER BY sort_order, title")
    .all(SORTING_TOPIC) as Array<{ title: string; uuid: string; sort_order: number }>;
  for (const c of courses) {
    if (!c.uuid) continue;
    kb.prepare(
      `INSERT INTO courses (topic, topic_key, title, uuid, sort_order, status) VALUES (?, ?, ?, ?, ?, '⬜')
       ON CONFLICT(topic, title) DO UPDATE SET uuid = excluded.uuid, topic_key = excluded.topic_key`
    ).run(SORTING_TOPIC, SORTING_TOPIC, c.title, c.uuid, c.sort_order);
  }
}

/** 维护 method_spec.perChild[孩子] = {require: 该孩子 open 错题关联的知识点名}（考核只考自己的薄弱点）。 */
export function updateSortingMethodSpec(parent: DatabaseSync, childId: string, requireKpNames: string[]): void {
  const row = parent.prepare("SELECT method_spec FROM topics WHERE topic_key = ?").get(SORTING_TOPIC) as
    | { method_spec?: string }
    | undefined;
  let spec: Record<string, any> = {};
  try {
    spec = JSON.parse(row?.method_spec || "{}");
  } catch {
    spec = {};
  }
  const perChild = (spec.perChild ?? {}) as Record<string, unknown>;
  if (requireKpNames.length) {
    perChild[childId] = { ...(perChild[childId] as object ?? {}), require: requireKpNames.slice(0, 40) };
  } else {
    delete perChild[childId]; // 没有薄弱点了 → 不再限制（回退该课程全考/无题可考）
  }
  spec.perChild = perChild;
  parent.prepare("UPDATE topics SET method_spec = ? WHERE topic_key = ?").run(JSON.stringify(spec), SORTING_TOPIC);
}

// ==================== LLM prompt（纯函数，供测试） ====================

/** 轮1：字词准入门 + 每条错题的主题定位 + 兜底知识点名建议。 */
export function buildStage1Prompt(words: MistakeRowLite[], others: MistakeRowLite[], topicNames: string[]): string {
  return `你是学习内容整理助手。下面是孩子学习过程中记录的原始材料，请完成两件事。

## 一、字词准入（unknown_word）
这些是孩子查过词典的字词记录。**只收单个字、词、成语（≤6 字）**；界面文案、按钮文字、整句课文、会话片段一律跳过。
${
  words.length
    ? words.map((w, i) => `${i + 1}. [id=${w.id}] ${w.content}（查 ${w.count} 次｜释义：${(w.detail || "无").slice(0, 60)}）`).join("\n")
    : "（本轮无字词）"
}

## 二、错题主题定位
以下是错题/薄弱点记录。请为每一条从下面的学习主题清单里挑一个**最可能相关的主题**；确实沾不上任何主题就用 "${SORTING_TOPIC}"。同时给一个「知识点名」建议（≤16 字，概括这条错题的考点，如「比喻句辨析」「鸡兔同笼」）。
主题清单：${topicNames.filter((t) => t !== SORTING_TOPIC).join("、") || "（家长库暂无其他主题）"}
${
  others.length
    ? others.map((m, i) => `${i + 1}. [id=${m.id}] kind=${m.kind}：${m.content.slice(0, 80)}${m.detail ? `｜${m.detail.slice(0, 80)}` : ""}`).join("\n")
    : "（本轮无错题）"
}

只输出 JSON，不要其它文字：
{"accept_words":["id1","id2"],"skip_words":[{"id":"id3","reason":"界面文案"}],
 "topics":[{"id":"...","topic":"主题名或${SORTING_TOPIC}","suggested_kp":"知识点名"}]}`;
}

/** 轮2：在选定主题下，给错题挑课程与知识点（精确名单内选）。 */
export function buildStage2Prompt(
  topic: string,
  courses: Array<{ title: string; kps: string[] }>,
  items: MistakeRowLite[],
  suggested: Record<string, string>
): string {
  const catalog = courses
    .map((c) => `- 课程「${c.title}」知识点：${c.kps.length ? c.kps.slice(0, 25).join("、") : "（无）"}`)
    .join("\n");
  return `学习主题「${topic}」下有这些课程与知识点：
${catalog}

请为下面每条错题在该主题下挑**精确存在的课程与知识点名**（必须逐字来自上面名单）；没有合适的确切匹配就选 "无"。
${items.map((m, i) => `${i + 1}. [id=${m.id}] ${m.content.slice(0, 80)}（建议知识点：${suggested[m.id] ?? "无"}）`).join("\n")}

只输出 JSON：
{"matches":[{"id":"...","course":"课程名或无","kp":"知识点名或无"}]}`;
}

/** 轮3：为字词批量出题。 */
export function buildQuestionPrompt(words: Array<{ content: string; detail: string }>): string {
  return `为下面每个字词出**一道**小学水平的巩固题（读音或释义，简答题）。stem 不要出现答案。
${words.map((w, i) => `${i + 1}. ${w.content}（释义：${(w.detail || "无").slice(0, 80)}）`).join("\n")}

只输出 JSON 对象（不要数组、不要其它文字）：
{"questions":[{"word":"研","stem":"「研」在「研磨」中读什么？它是什么意思？","answer":"yán；把东西磨成粉或磨细"}]}`;
}

// ==================== 任务本体 ====================

async function chat(deps: ExamEngineDeps, session: any, prompt: string): Promise<any> {
  await session.prompt(prompt);
  return extractJson(lastAssistantText(session));
}

export const mistakeSortingTask: WorkerTask = {
  type: "mistake_sorting",
  // 家长可控（2026-09-29）：「定时任务」页创建 mistake_sorting 任务并分配孩子后才跑；
  // times=家长设置的全部触发点（多行任务时间去重，buildEffectiveChildConfig 汇总）；未创建 = 不跑
  points: (cfg) => {
    const c = cfg.mistakeSorting;
    if (!c?.enabled) return [];
    return (c.times ?? []).filter((t) => /^\d{2}:\d{2}$/.test(t)).sort();
  },
  catchUp: "latest",
  async run(ctx: WorkerTaskCtx): Promise<WorkerRunResult | void> {
    if (!ctx.auth || Object.keys(ctx.auth).length === 0) return { status: "skip", message: "未配置模型 key" };

    const kb = openKb(ctx.dataDir, ctx.parentId, ctx.childId);
    let rows: MistakeRowLite[];
    try {
      rows = kb
        .prepare(
          `SELECT id, kind, content, detail, course_ref, count FROM mistake_book
           WHERE status = 'open' AND knowledge_point_id = '' ORDER BY last_seen DESC LIMIT ${BATCH_LIMIT}`
        )
        .all() as unknown as MistakeRowLite[];
    } finally {
      kb.close();
    }

    const parent = openParentLib(ctx.dataDir, ctx.parentId);
    const deps: ExamEngineDeps = { dataDir: ctx.dataDir, db: ctx.mainDb, parentId: ctx.parentId, childId: ctx.childId };
    try {
      ensureSortingTopic(parent);
      const wordCourseUuid0 = ensureSortingCourse(parent, WORD_COURSE);
      // 待出题的知识点（上一轮出题失败/超上限遗留的，本轮补齐）——skip 判定要算上它
      const pendingQ0 = parent
        .prepare(
          `SELECT k.id, k.name, k.detail FROM knowledge_points k
           WHERE k.course_uuid = ? AND NOT EXISTS
             (SELECT 1 FROM course_knowledge_questions q WHERE q.knowledge_point_id = k.id)
           ORDER BY k.rowid DESC LIMIT ${QUESTION_CAP}`
        )
        .all(wordCourseUuid0) as Array<{ id: string; name: string; detail: string }>;
      if (!rows.length && !pendingQ0.length) return { status: "skip", message: "无待整理错题" };

      const words = rows.filter((r) => r.kind === "unknown_word");
      const others = rows.filter((r) => r.kind !== "unknown_word");

      // —— LLM 分析（无字词/无错题时跳过对应环节）——
      const session = await createExamSession(deps, "你是学习内容整理助手，只输出 JSON。");
      let acceptIds = new Set<string>();
      let topicPick = new Map<string, { topic: string; suggested: string }>();
      if (words.length || others.length || pendingQ0.length) {
        const topicRows = parent.prepare("SELECT name FROM topics ORDER BY topic_key").all() as Array<{ name: string }>;
        const r1 = await chat(deps, session, buildStage1Prompt(words, others, topicRows.map((t) => t.name)));
        for (const id of (r1?.accept_words ?? []) as string[]) acceptIds.add(String(id));
        for (const t of (r1?.topics ?? []) as Array<{ id: string; topic?: string; suggested_kp?: string }>) {
          if (t?.id) topicPick.set(String(t.id), { topic: String(t.topic || SORTING_TOPIC), suggested: String(t.suggested_kp || "") });
        }
      }

      // 分层第二层：选定主题下挑课程/知识点（每个被选中的真实主题一次调用，上限 2 个主题）
      const classified = new Map<string, { kpId: string; kpName: string }>();
      const realTopics = [...new Set([...topicPick.values()].map((v) => v.topic).filter((t) => t && t !== SORTING_TOPIC))].slice(0, 2);
      for (const topic of realTopics) {
        const items = others.filter((m) => topicPick.get(m.id)?.topic === topic);
        if (!items.length) continue;
        const courses = parent
          .prepare(
            `SELECT c.title, c.uuid FROM courses c JOIN topics t ON c.topic = t.topic_key WHERE t.name = ? ORDER BY c.sort_order LIMIT 25`
          )
          .all(topic) as Array<{ title: string; uuid: string }>;
        const catalog: Array<{ title: string; kps: string[] }> = [];
        const kpIdBy = new Map<string, string>(); // `${title}||${kpName}` -> id
        for (const c of courses) {
          const kps = parent
            .prepare("SELECT name FROM knowledge_points WHERE course_uuid = ? ORDER BY seq LIMIT 25")
            .all(c.uuid) as Array<{ name: string }>;
          catalog.push({ title: c.title, kps: kps.map((k) => k.name) });
          for (const k of kps) kpIdBy.set(`${c.title}||${k.name}`, c.uuid);
        }
        const r2 = await chat(deps, session, buildStage2Prompt(topic, catalog, items, Object.fromEntries(items.map((m) => [m.id, topicPick.get(m.id)?.suggested ?? ""]))));
        for (const match of (r2?.matches ?? []) as Array<{ id: string; course?: string; kp?: string }>) {
          if (!match?.id || !match.kp || match.kp === "无" || !match.course || match.course === "无") continue;
          const uuid = kpIdBy.get(`${match.course}||${match.kp}`);
          if (!uuid) continue;
          const kpRow = parent.prepare("SELECT id FROM knowledge_points WHERE course_uuid = ? AND name = ?").get(uuid, match.kp) as { id?: string };
          if (kpRow?.id) classified.set(String(match.id), { kpId: kpRow.id, kpName: match.kp });
        }
      }

      // —— 落库 ——
      const kbChild = openKb(ctx.dataDir, ctx.parentId, ctx.childId);
      try {
        const wordCourseUuid = ensureSortingCourse(parent, WORD_COURSE);
        // 字词准入 → 建 kp + 关联；未准入 → 丢弃（标记为已处理但不挂 kp：detail 留痕即可，不再重复分析）
        for (const w of words) {
          if (!acceptIds.has(w.id)) {
            kbChild.prepare("UPDATE mistake_book SET knowledge_point_id = 'skipped', updated_at = ? WHERE id = ?")
              .run(new Date().toISOString(), w.id);
            continue;
          }
          const kpId = ensureKnowledgePoint(parent, wordCourseUuid, w.content, w.detail);
          linkMistakeToKp(kbChild, w.id, kpId, w.content);
        }
        // 错题：先挂既有 kp；挂不上的进「错题整理」主题下的归类课程
        for (const m of others) {
          const hit = classified.get(m.id);
          if (hit) {
            linkMistakeToKp(kbChild, m.id, hit.kpId, hit.kpName);
            continue;
          }
          const category = topicPick.get(m.id)?.topic === SORTING_TOPIC ? FALLBACK_COURSE : topicPick.get(m.id)?.suggested || FALLBACK_COURSE;
          const courseTitle = /^[一-龥A-Za-z0-9]{1,8}$/.test(category) ? category : FALLBACK_COURSE;
          const courseUuid = ensureSortingCourse(parent, courseTitle);
          const kpName = (topicPick.get(m.id)?.suggested || m.content).slice(0, 16);
          const kpId = ensureKnowledgePoint(parent, courseUuid, kpName, `${m.content}\n${m.detail}`.slice(0, 500));
          linkMistakeToKp(kbChild, m.id, kpId, kpName);
        }

        // —— 字词出题（每 kp 一题；本轮上限 QUESTION_CAP）——
        const pendingQ = parent
          .prepare(
            `SELECT k.id, k.name, k.detail FROM knowledge_points k
             WHERE k.course_uuid = ? AND NOT EXISTS
               (SELECT 1 FROM course_knowledge_questions q WHERE q.knowledge_point_id = k.id)
             ORDER BY k.rowid DESC LIMIT ${QUESTION_CAP}`
          )
          .all(wordCourseUuid) as Array<{ id: string; name: string; detail: string }>;
        if (pendingQ.length) {
          const rq = await chat(deps, session, buildQuestionPrompt(pendingQ.map((k) => ({ content: k.name, detail: k.detail }))));
          const list = Array.isArray(rq) ? rq : (rq?.questions ?? []);
          for (const q of list as Array<{ word?: string; stem?: string; answer?: string }>) {
            if (!q?.word || !q?.stem || !q?.answer) continue;
            const kp = pendingQ.find((k) => k.name === q.word);
            if (!kp) continue;
            attachGeneratedQuestion(parent, wordCourseUuid, kp.id, { stem: q.stem, answer: q.answer, overview: q.stem });
          }
        }

        // —— 主题/课程分配进孩子库 + perChild 考核范围 ——
        syncSortingCoursesToChild(parent, kbChild, ctx.childId);
        // require 名单给的是知识点名（resolveOverride 按名字解析，解析不到的忽略——
        // 所以把该孩子全部 open 错题的 kp 名都放进来也安全，只对本主题课程生效）
        const openKpNames = (kbChild
          .prepare(
            `SELECT DISTINCT knowledge_point_name FROM mistake_book
             WHERE status = 'open' AND knowledge_point_name != '' LIMIT 40`
          )
          .all() as Array<{ knowledge_point_name: string }>).map((r) => r.knowledge_point_name);
        updateSortingMethodSpec(parent, ctx.childId, openKpNames);
      } finally {
        kbChild.close();
      }
      return { status: "ok", message: `整理 ${rows.length} 条（字词 ${words.length}、错题 ${others.length}）` };
    } finally {
      parent.close();
    }
  },
};

export function registerMistakeSortingTask(): void {
  registerTask(mistakeSortingTask);
}