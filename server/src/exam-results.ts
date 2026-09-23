/**
 * 考核结果落库（ISSUE-135 P0-a，2026-09-23）—— 一次提交 → 孩子库三层 + 评测存档。
 *
 * 背景：主库 `exam_attempts` 已废弃（孩子数据不该落主库；且逐题明细已由孩子库 exam_plan_courses 承担）。
 * 现在提交结果由本模块**直写孩子库**（同一文件、同一事务语义，单库幂等）：
 *   ① exam_plan_courses      逐题明细（题目/得分/评语/ASR/录音引用/用时/行为）
 *   ② exam_course_results    课程概要（一行 = 计划 × 课程：Σgot/Σmax + 显式 rate + course_summary）
 *   ③ knowledge_point_records 知识点情况（一行 = 计划 × 课程 × 知识点；学习与考核同表，source 区分）
 *   ④ speech_assessments     题级口语评测存档（按 (plan_id,course_uuid,question_id) 关联明细）
 *   ⑤ exam_plans 置 done + 回填 attempt_id/score/done_at
 *
 * 设计要点：
 * - **规则可算**（不依赖 LLM）：上线即有数据；LLM 只负责后续润色（P2 概要点评、P4 累计叙述）。
 * - 拆出来单独成模块是为了可测：写入口径（幂等、知识点回退、档位阈值）都能在单测里直接验证。
 * - 知识点 id 是家长库 `knowledge_points.id` 的跨文件逻辑引用（无 FK），带 name 快照防悬挂。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openKb } from "./db/kb.js";
import { openParentLib } from "./db/parent-lib.js";

/** 课程名 → { uuid, topicKey }。uuid 是孩子库 courses.uuid（真引用）；老行未回填时用家长库补并回写孩子库，
 * 避免明细/概要/知识点流水与课程失联（本地实测 2992 行课程里 296 行 uuid 为空，必须走回填）。 */
export function resolveCourseMeta(
  kb: DatabaseSync,
  parent: DatabaseSync,
  courseName: string
): { uuid: string; topicKey: string } {
  const t = String(courseName || "").trim();
  if (!t) return { uuid: "", topicKey: "" };
  const row = kb.prepare("SELECT uuid, topic_key FROM courses WHERE title = ?").get(t) as
    | { uuid?: string; topic_key?: string }
    | undefined;
  let uuid = String(row?.uuid ?? "");
  let topicKey = String(row?.topic_key ?? "");
  if (!uuid) {
    const hit = parent.prepare("SELECT uuid, topic FROM courses WHERE title = ?").get(t) as
      | { uuid?: string; topic?: string }
      | undefined;
    uuid = String(hit?.uuid ?? "");
    if (uuid && row) {
      try {
        kb.prepare("UPDATE courses SET uuid = ? WHERE title = ?").run(uuid, t);
      } catch {
        /* 回写失败不影响本次结果落库 */
      }
    }
    if (!topicKey && hit?.topic) {
      const tRow = parent.prepare("SELECT topic_key FROM topics WHERE name = ? OR topic_key = ? LIMIT 1").get(hit.topic, hit.topic) as
        | { topic_key?: string }
        | undefined;
      topicKey = String(tRow?.topic_key ?? hit.topic ?? "");
    }
  }
  if (!topicKey) topicKey = t;
  return { uuid, topicKey };
}

/**
 * 课程 uuid + 题目 id → 知识点 id（回退路径）。
 * 提交项缺 `knowledgePointId` 时（老数据 83 题里仅 31 题有值）靠家长库挂载关系定位；
 * 定位不到就不写 knowledge_point_records（只在课程概要里带说明）—— 见 ISSUE-135 §4.2 ③。
 */
export function lookupKpIdByQuestion(parent: DatabaseSync, courseUuid: string, questionId: string): string {
  if (!courseUuid || !questionId) return "";
  try {
    const row = parent
      .prepare("SELECT knowledge_point_id FROM course_knowledge_questions WHERE course_id = ? AND question_id = ? LIMIT 1")
      .get(courseUuid, questionId) as { knowledge_point_id?: string } | undefined;
    return String(row?.knowledge_point_id ?? "");
  } catch {
    return "";
  }
}

/** 知识点 id → 知识点名（name 快照，家长库改结构后历史记录仍可读）。 */
export function lookupKpName(parent: DatabaseSync, kpId: string): string {
  if (!kpId) return "";
  try {
    const row = parent.prepare("SELECT name FROM knowledge_points WHERE id = ?").get(kpId) as { name?: string } | undefined;
    return String(row?.name ?? "");
  } catch {
    return "";
  }
}

/** 知识点本次掌握档位：得分率 ≥0.8 solid / ≥0.6 partial / 其余（含无分）weak。 */
export function outcomeOf(rate: number | null): "solid" | "partial" | "weak" {
  if (rate == null) return "weak";
  if (rate >= 0.8) return "solid";
  if (rate >= 0.6) return "partial";
  return "weak";
}

/** 课程结果概要不依赖 LLM 的规则文案（P2 起由分析任务润色重算，可覆盖）。 */
export function buildCourseSummary(courseName: string, got: number, max: number, count: number, weakKps: string[]): string {
  const rate = max > 0 ? got / max : null;
  const head = `本次「${courseName || "未分课程"}」考了 ${count} 题，得 ${Math.round(got * 10) / 10}/${Math.round(max * 10) / 10} 分${
    rate == null ? "" : `（得分率 ${Math.round(rate * 100)}%）`
  }`;
  if (weakKps.length) return `${head}；需巩固的知识点：${weakKps.slice(0, 3).join("、")}。`;
  return max > 0 && got >= max ? `${head}，全部答对。` : `${head}。`;
}

export interface ExamResultInput {
  dataDir: string;
  parentId: string;
  childId: string;
  /** 本次提交的溯源 id（写 exam_plans.attempt_id + 结果表 attempt_ref）。 */
  attemptId: string;
  /** 目标考核计划 id（exam_plans.id）；空或查不到时按历史口径补建一条 custom 计划。 */
  planId?: string;
  title?: string;
  submittedAt: string;
  score?: number;
  perQuestion?: unknown;
  reinforcePlan?: unknown;
  now?: string;
}

export interface ExamResultMistakeSeed {
  course: string;
  kpId: string;
  questionId: string;
  got: number;
  max: number;
  comment: string;
}

export interface ExamResultOutput {
  /** 实际归属的计划 id（可能由本函数补建）。 */
  planId: string;
  detailCount: number;
  courseResults: number;
  kpRecords: number;
  speechArchived: number;
  /** 错题素材（供调用方同步错题本；本模块不碰 mistake_book，避免双写口径分散）。 */
  wrongSeeds: ExamResultMistakeSeed[];
}

/**
 * 落一次考核结果（幂等：同一 plan 的明细/评测先清后插，概要/知识点按唯一键 UPSERT）。
 * 全过程单库单连接；返回统计供路由日志与错题本同步使用。
 */
export function persistExamResult(input: ExamResultInput): ExamResultOutput {
  const now = input.now ?? new Date().toISOString();
  const submittedAt = input.submittedAt || now;
  const perQuestion = Array.isArray(input.perQuestion) ? (input.perQuestion as Array<Record<string, unknown>>) : [];
  const reinforcePlan =
    input.reinforcePlan && typeof input.reinforcePlan === "object"
      ? (input.reinforcePlan as Record<string, { planReviewAt?: string; focus?: string[] }>)
      : {};
  const kb = openKb(input.dataDir, input.parentId, input.childId);
  const parent = openParentLib(input.dataDir, input.parentId);
  try {
    // 0) 计划行（结果归属的锚点）。
    let planId = String(input.planId ?? "").trim();
    const planExists = planId
      ? !!kb.prepare("SELECT 1 FROM exam_plans WHERE id = ? AND child_id = ?").get(planId, input.childId)
      : false;
    if (!planExists) {
      planId = planId || `exam_${input.attemptId}`;
      kb.prepare(
        `INSERT INTO exam_plans (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
           start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
         VALUES (?,?,?,?,'parent','custom','','{}','conversation','','','','pending','',NULL,'','','required',1,0,1,?,?)`
      ).run(planId, input.parentId, input.childId, String(input.title ?? "考核"), now, now);
    }

    // ① 逐题明细（先清后插：重复提交天然幂等，不会累加）
    kb.prepare("DELETE FROM exam_plan_courses WHERE plan_id = ?").run(planId);
    const insCourse = kb.prepare(
      `INSERT INTO exam_plan_courses (id,plan_id,course_uuid,course_name,knowledge_point_id,knowledge_point_name,
         question_id,question_text,ref_text,point_got,point_max,correct,ai_comment,asr_text,audio_file_id,
         duration_ms,behavior,seq,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const metaCache = new Map<string, { uuid: string; topicKey: string }>();
    interface DetailRow {
      courseUuid: string;
      courseName: string;
      topicKey: string;
      kpId: string;
      kpName: string;
      questionId: string;
      got: number | null;
      max: number | null;
      comment: string;
    }
    const detailRows: DetailRow[] = [];
    const wrongSeeds: ExamResultMistakeSeed[] = [];
    let seq = 0;
    for (const q of perQuestion) {
      const courseName = String(q.course ?? "").trim();
      let meta = { uuid: "", topicKey: "" };
      if (courseName) {
        const cached = metaCache.get(courseName);
        meta = cached ?? resolveCourseMeta(kb, parent, courseName);
        metaCache.set(courseName, meta);
      }
      const courseUuid = meta.uuid;
      const questionId = String(q.questionId ?? "");
      let kpId = String(q.knowledgePointId ?? "");
      if (!kpId) kpId = lookupKpIdByQuestion(parent, courseUuid, questionId);
      let kpName = String(q.knowledgePointName ?? "");
      if (kpId && !kpName) kpName = lookupKpName(parent, kpId);
      const got = q.pointGot != null ? Number(q.pointGot) : null;
      const max = q.pointMax != null ? Number(q.pointMax) : null;
      const correct = q.correct === true ? 1 : q.correct === false ? 0 : null;
      const behavior = String(q.behavior ?? q.questionType ?? q.assessMethod ?? "");
      insCourse.run(
        randomUUID(),
        planId,
        courseUuid,
        courseName,
        kpId,
        kpName,
        questionId,
        String(q.question ?? ""),
        String(q.refText ?? ""),
        got,
        max,
        correct,
        String(q.aiComment ?? ""),
        String(q.asrText ?? ""),
        String(q.audioFileId ?? ""),
        Number(q.durationMs) || 0,
        behavior,
        seq++,
        now
      );
      detailRows.push({
        courseUuid,
        courseName,
        topicKey: meta.topicKey,
        kpId,
        kpName,
        questionId,
        got,
        max,
        comment: String(q.aiComment ?? ""),
      });
      if (got != null && max != null && max > 0 && got < max) {
        wrongSeeds.push({ course: courseName, kpId, questionId, got, max, comment: String(q.aiComment ?? "") });
      }
    }
    // 课程 uuid 解析不到（课程已从家长库删除）时用 `name:<课程名>` 占位：既保住数据，又保证 (plan_id,course_uuid) 唯一。
    const courseKeyOf = (r: { courseUuid: string; courseName: string }) => r.courseUuid || `name:${r.courseName}`;

    // ② 知识点情况（knowledge_point_records）：按 (课程, 知识点) 聚合本次得分
    const byKp = new Map<
      string,
      {
        courseKey: string;
        courseName: string;
        topicKey: string;
        kpId: string;
        kpName: string;
        got: number;
        max: number;
        comments: string[];
        fullMarks: string[];
        qids: string[];
      }
    >();
    for (const r of detailRows) {
      if (!r.kpId) continue; // 知识点定位不到 → 不写 records（只在课程概要里说明）
      const key = `${courseKeyOf(r)}|${r.kpId}`;
      let e = byKp.get(key);
      if (!e) {
        e = {
          courseKey: courseKeyOf(r),
          courseName: r.courseName,
          topicKey: r.topicKey,
          kpId: r.kpId,
          kpName: r.kpName,
          got: 0,
          max: 0,
          comments: [],
          fullMarks: [],
          qids: [],
        };
        byKp.set(key, e);
      }
      if (!e.kpName && r.kpName) e.kpName = r.kpName;
      e.got += r.got ?? 0;
      e.max += r.max ?? 0;
      if (r.questionId) e.qids.push(r.questionId);
      if (r.comment && r.max != null && r.got != null) {
        if (r.got >= r.max) e.fullMarks.push(r.comment);
        else e.comments.push(r.comment);
      }
    }
    const weakKpByCourse = new Map<string, string[]>();
    const insKp = kb.prepare(
      `INSERT INTO knowledge_point_records (id,parent_id,child_id,source,plan_id,knowledge_point_id,knowledge_point_name,
         topic_key,course_uuid,course_name,record_at,outcome,point_got,point_max,rate,summary,detail_json,source_ref,created_at)
       VALUES (?,?,?,'exam',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(source, plan_id, course_uuid, knowledge_point_id) DO UPDATE SET
         outcome=excluded.outcome, point_got=excluded.point_got, point_max=excluded.point_max, rate=excluded.rate,
         summary=excluded.summary, detail_json=excluded.detail_json, record_at=excluded.record_at,
         knowledge_point_name=CASE WHEN excluded.knowledge_point_name != '' THEN excluded.knowledge_point_name ELSE knowledge_point_records.knowledge_point_name END`
    );
    let kpRecords = 0;
    for (const e of byKp.values()) {
      const rate = e.max > 0 ? e.got / e.max : null;
      const outcome = outcomeOf(rate);
      if (outcome !== "solid") {
        const list = weakKpByCourse.get(e.courseName) ?? [];
        list.push(e.kpName || e.kpId);
        weakKpByCourse.set(e.courseName, list);
      }
      const summary = e.comments.length
        ? e.comments.join(" / ").slice(0, 300)
        : e.max > 0
          ? `本次得分 ${Math.round(e.got * 10) / 10}/${Math.round(e.max * 10) / 10}`
          : "本次未采集到该知识点的作答记录";
      insKp.run(
        randomUUID(),
        input.parentId,
        input.childId,
        planId,
        e.kpId,
        e.kpName,
        e.topicKey,
        e.courseKey,
        e.courseName,
        submittedAt,
        outcome,
        e.got,
        e.max,
        rate,
        summary,
        JSON.stringify({ question_ids: e.qids, difficulties: e.comments, highlights: e.fullMarks.slice(0, 3) }),
        input.attemptId,
        now
      );
      kpRecords++;
    }

    // ③ 课程每次考核结果概要（exam_course_results）：一行 = 计划 × 课程
    const byCourse = new Map<
      string,
      { courseUuid: string; courseName: string; topicKey: string; got: number; max: number; count: number }
    >();
    for (const r of detailRows) {
      if (!r.courseUuid && !r.courseName) continue;
      const key = courseKeyOf(r);
      let e = byCourse.get(key);
      if (!e) {
        e = { courseUuid: key, courseName: r.courseName, topicKey: r.topicKey, got: 0, max: 0, count: 0 };
        byCourse.set(key, e);
      }
      e.got += r.got ?? 0;
      e.max += r.max ?? 0;
      e.count += 1;
    }
    const insResult = kb.prepare(
      `INSERT INTO exam_course_results (id,parent_id,child_id,plan_id,attempt_ref,topic_key,course_uuid,course_name,
         exam_at,point_got,point_max,rate,question_count,course_summary,plan_review_at,focus_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(plan_id, course_uuid) DO UPDATE SET
         point_got=excluded.point_got, point_max=excluded.point_max, rate=excluded.rate,
         question_count=excluded.question_count, course_summary=excluded.course_summary,
         plan_review_at=excluded.plan_review_at, focus_json=excluded.focus_json,
         exam_at=excluded.exam_at, updated_at=excluded.updated_at`
    );
    for (const e of byCourse.values()) {
      const rate = e.max > 0 ? e.got / e.max : null;
      const rp = reinforcePlan[e.courseName];
      insResult.run(
        randomUUID(),
        input.parentId,
        input.childId,
        planId,
        input.attemptId,
        e.topicKey,
        e.courseUuid,
        e.courseName,
        submittedAt,
        e.got,
        e.max,
        rate,
        e.count,
        buildCourseSummary(e.courseName, e.got, e.max, e.count, weakKpByCourse.get(e.courseName) ?? []),
        String(rp?.planReviewAt ?? ""),
        JSON.stringify(Array.isArray(rp?.focus) ? rp!.focus!.map(String) : []),
        now,
        now
      );
    }

    // ④ 题级口语评测存档（speech_assessments）：与明细按 (plan_id,course_uuid,question_id) 关联
    let speechArchived = 0;
    kb.prepare("DELETE FROM speech_assessments WHERE plan_id = ?").run(planId);
    const insSpeech = kb.prepare(
      `INSERT INTO speech_assessments (id,parent_id,child_id,plan_id,course_uuid,question_id,attempt_ref,
         topic_key,course_name,question_type,ref_text,audio_file_id,overall,pron,dimensions_json,detail_json,is_exam,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`
    );
    for (const q of perQuestion) {
      const speech = q.speech as Record<string, unknown> | undefined;
      if (!speech || typeof speech !== "object") continue;
        const courseName = String(q.course ?? "").trim();
      const cm = courseName ? metaCache.get(courseName) : undefined;
      insSpeech.run(
        `sa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        input.parentId,
        input.childId,
        planId,
        cm?.uuid ?? "",
        String(q.questionId ?? ""),
        input.attemptId,
        cm?.topicKey ?? "",
        courseName,
        String(q.questionType || q.assessMethod || ""),
        String(q.refText ?? ""),
        String(q.audioFileId ?? ""),
        Number(speech.overall ?? speech.pron ?? 0) || 0,
        Number(speech.pron ?? 0) || 0,
        JSON.stringify({
          accuracy: speech.accuracy,
          integrity: speech.integrity,
          fluency: speech.fluency,
          prosody: speech.prosody,
          audioQuality: speech.audioQuality,
        }),
        JSON.stringify(speech),
        now
      );
      speechArchived++;
    }

    // ⑤ 计划置 done + 回填 attempt_id / score / done_at
    kb.prepare(
      "UPDATE exam_plans SET status = 'done', attempt_id = ?, score = ?, done_at = ?, updated_at = ? WHERE id = ? AND child_id = ?"
    ).run(input.attemptId, Number(input.score) || 0, submittedAt, now, planId, input.childId);

    return {
      planId,
      detailCount: detailRows.length,
      courseResults: byCourse.size,
      kpRecords,
      speechArchived,
      wrongSeeds,
    };
  } finally {
    kb.close();
    parent.close();
  }
}
