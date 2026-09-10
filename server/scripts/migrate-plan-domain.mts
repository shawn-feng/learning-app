/**
 * 计划域重构 S2（2026-09-10）：历史数据迁移 主库 → 孩子库。
 * 设计：DESIGN-plan-domain-rewrite-2026-09-10.md §5。
 *
 * 迁移内容（按 (parent_id, child_id) 分组）：
 *   study_plan_items            → 孩子 kb study_plans
 *   exam_schedules              → 孩子 kb exam_plans
 *   exam_attempts(+per_question)→ 孩子 kb exam_plans(场次) + exam_plan_courses(逐题明细)
 *   todo_items(source=child)    → 孩子 kb life_plans（source=parent 不迁，由 study_plans 承载）
 *   child_todo_stats            → 孩子 kb reward_daily_stats（按 parent/self 拆 owner；不回溯发分）
 * 同时回填：孩子 kb courses.uuid（按 topic+title 从家长库取）。
 *
 * 安全规则（避免历史行被重新结算/carry 泛滥）：
 *   - 迁移时**已过期且未完成**的行 → status='missed' + active=0（保留历史痕迹，不再参与结算、不生成 carry）
 *   - 旧 status='carried' → 'missed' + active=0
 *   - 仅「今天及以后」的 pending 行保持 active=1
 *   - 积分不回溯：reward_daily_stats.settled_at 留空，且结算只跑当天（见 worker）
 *
 * 用法：tsx migrate-plan-domain.mts <dataDir> [parentId] [--dry-run] [--force]
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../src/db.js";
import { openKb } from "../src/db/kb.js";
import { openParentLib } from "../src/db/parent-lib.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const [dataDir = "", onlyParent = ""] = argv.filter((a) => !a.startsWith("--"));
if (!dataDir || !fs.existsSync(dataDir)) {
  console.error("用法：tsx migrate-plan-domain.mts <dataDir> [parentId] [--dry-run] [--force]");
  process.exit(1);
}

const nowIso = new Date().toISOString();
const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD（本地）

function dayStart(d: string): string {
  const day = (d || "").slice(0, 10);
  return day ? `${day} 00:00:00` : "";
}
function dayEnd(d: string): string {
  const day = (d || "").slice(0, 10);
  return day ? `${day} 23:59:59` : "";
}
function isPast(d: string): boolean {
  const day = (d || "").slice(0, 10);
  return !!day && day < today;
}

const main = openDb(dataDir);
const stats = {
  parents: 0,
  children: 0,
  planStudy: 0,
  planExam: 0,
  examCourses: 0,
  planLife: 0,
  stats2: 0,
  courseUuid: 0,
  skipped: 0,
};

try {
  const parents = onlyParent
    ? [{ id: onlyParent }]
    : (main.prepare("SELECT id FROM parents").all() as Array<{ id: string }>);

  for (const p of parents) {
    const parentId = p.id;
    const children = main
      .prepare("SELECT id, name FROM children WHERE parent_id = ?")
      .all(parentId) as Array<{ id: string; name: string }>;
    if (!children.length) continue;
    stats.parents++;

    // 家长库课程名 → uuid
    let uuidByName = new Map<string, string>();
    let uuidByTopicName = new Map<string, string>();
    try {
      const pdb = openParentLib(dataDir, parentId);
      try {
        const rows = pdb.prepare("SELECT topic, title, uuid FROM courses").all() as Array<{
          topic: string;
          title: string;
          uuid: string | null;
        }>;
        for (const r of rows) {
          if (!r.uuid) continue;
          if (!uuidByName.has(r.title)) uuidByName.set(r.title, String(r.uuid));
          uuidByTopicName.set(`${r.topic}\u0000${r.title}`, String(r.uuid));
        }
      } finally {
        pdb.close();
      }
    } catch (e) {
      console.warn(`[skip] 家长 ${parentId} 家长库打开失败：${String((e as Error).message || e)}`);
    }

    for (const c of children) {
      const childId = c.id;
      const kb = openKb(dataDir, parentId, childId); // 打开即建新表
      try {
        // 幂等：已迁过则跳过（--force 重跑）
        const done = kb.prepare("SELECT value FROM meta WHERE key = 'plan_domain_migrated'").get() as
          | { value?: string }
          | undefined;
        if (done?.value && !force) {
          stats.skipped++;
          continue;
        }
        kb.exec("BEGIN");
        try {
          let n = 0;

          // ---------- ① 孩子库 courses.uuid 回填 ----------
          const kbCourses = kb.prepare("SELECT topic, title FROM courses WHERE uuid IS NULL OR uuid = ''").all() as Array<{
            topic: string;
            title: string;
          }>;
          const updCourse = kb.prepare("UPDATE courses SET uuid = ? WHERE topic = ? AND title = ?");
          for (const row of kbCourses) {
            const uuid = uuidByTopicName.get(`${row.topic}\u0000${row.title}`) || uuidByName.get(row.title) || "";
            if (!uuid) continue;
            if (!dryRun) updCourse.run(uuid, row.topic, row.title);
            stats.courseUuid++;
          }

          // ---------- ② study_plan_items → study_plans ----------
          const planRows = main
            .prepare(
              `SELECT id, date, topic_key, course_name, course_uuid, mode, origin, status, done_at, active
               FROM study_plan_items WHERE parent_id = ? AND child_id = ?`
            )
            .all(parentId, childId) as Array<{
            id: string;
            date: string;
            topic_key: string;
            course_name: string;
            course_uuid: string;
            mode: string;
            origin: string;
            status: string;
            done_at: string;
            active: number;
          }>;
          const insStudy = kb.prepare(
            `INSERT OR REPLACE INTO study_plans
             (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,recurrence_id,
              start_at,due_at,status,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,'parent',?,'','',?,?,?,'',?,'required',1,0,?,?,?)`
          );
          for (const r of planRows) {
            let status = r.status === "done" ? "done" : "pending";
            let active = 1;
            if (r.status === "carried") {
              status = "missed";
              active = 0;
            } else if (status === "pending" && isPast(r.date)) {
              status = "missed"; // 历史未完成 → 保留痕迹，不再结算
              active = 0;
            }
            if (!dryRun) {
              insStudy.run(
                r.id,
                parentId,
                childId,
                r.topic_key,
                r.course_uuid || uuidByTopicName.get(`${r.topic_key}\u0000${r.course_name}`) || uuidByName.get(r.course_name) || "",
                r.course_name,
                r.mode,
                r.origin || "conversation",
                dayStart(r.date),
                dayEnd(r.date),
                status,
                r.done_at || "",
                active ? r.active : 0,
                nowIso,
                nowIso
              );
            }
            n++;
            stats.planStudy++;
          }

          // ---------- ③ exam_schedules → exam_plans ----------
          const schedRows = main
            .prepare(
              `SELECT id, kind, freq, scheduled_at, scope, status, attempt_id FROM exam_schedules
               WHERE parent_id = ? AND child_id = ?`
            )
            .all(parentId, childId) as Array<{
            id: string;
            kind: string;
            freq: string;
            scheduled_at: string;
            scope: string;
            status: string;
            attempt_id: string;
          }>;
          const insExam = kb.prepare(
            `INSERT OR REPLACE INTO exam_plans
             (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
              start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
             VALUES (?,?,?,'','parent',?,?,?,'conversation','',?,?,?,?,?,?,?,'required',1,0,?,?,?)`
          );
          const scopeTitle = (sc: string) => {
            try {
              const j = JSON.parse(sc || "{}") as { note?: string; topics?: string[] };
              return j.note || (j.topics || []).join("、") || "";
            } catch {
              return "";
            }
          };
          for (const s of schedRows) {
            let status = s.status === "done" ? "done" : "pending";
            let active = 1;
            if (status === "pending" && isPast(s.scheduled_at)) {
              status = "missed";
              active = 0;
            }
            const attempt = s.attempt_id
              ? (main.prepare("SELECT score, submitted_at FROM exam_attempts WHERE id = ?").get(s.attempt_id) as
                  | { score?: number; submitted_at?: string }
                  | undefined)
              : undefined;
            if (!dryRun) {
              insExam.run(
                s.id,
                parentId,
                childId,
                s.kind,
                s.freq,
                s.scope || "{}",
                dayStart(s.scheduled_at),
                dayEnd(s.scheduled_at),
                status,
                s.attempt_id || "",
                attempt?.score ?? null,
                scopeTitle(s.scope),
                attempt?.submitted_at || "",
                active,
                nowIso,
                nowIso
              );
            }
            n++;
            stats.planExam++;
          }

          // ---------- ④ exam_attempts(+per_question) → exam_plan_courses ----------
          const attempts = main
            .prepare(
              `SELECT id, title, submitted_at, score, per_question, schedule_id FROM exam_attempts
               WHERE parent_id = ? AND child_id = ? AND per_question != '[]'`
            )
            .all(parentId, childId) as Array<{
            id: string;
            title: string;
            submitted_at: string;
            score: number;
            per_question: string;
            schedule_id: string;
          }>;
          const insEpc = kb.prepare(
            `INSERT OR REPLACE INTO exam_plan_courses
             (id,plan_id,course_uuid,course_name,category_id,knowledge_point_id,question_id,point_got,point_max,score,seq,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
          );
          for (const a of attempts) {
            const planId = a.schedule_id || `exam_${a.id}`;
            // 若该场次没有对应排期行（游离场次），补一条 done 计划（creator=parent）
            const hasPlan = kb.prepare("SELECT 1 FROM exam_plans WHERE id = ?").get(planId);
            if (!hasPlan && !dryRun) {
              kb.prepare(
                `INSERT OR REPLACE INTO exam_plans
                 (id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,
                  start_at,due_at,status,attempt_id,score,result,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
                 VALUES (?,?,?,?,'parent','custom','','{}','conversation','',?,?,'done',?,?,'',?,'required',1,0,1,?,?)`
              ).run(
                planId,
                parentId,
                childId,
                a.title || "历史考核",
                dayStart(a.submitted_at),
                dayEnd(a.submitted_at),
                a.id,
                a.score ?? null,
                a.submitted_at || nowIso,
                nowIso,
                nowIso
              );
            }
            let pq: Array<Record<string, unknown>> = [];
            try {
              pq = JSON.parse(a.per_question) as Array<Record<string, unknown>>;
            } catch {
              pq = [];
            }
            let seq = 0;
            for (const q of pq) {
              const courseName = String(q.course ?? "");
              const courseUuid =
                String(q.courseId ?? "") || uuidByName.get(courseName) || "";
              if (!dryRun) {
                insEpc.run(
                  randomUUID(),
                  planId,
                  courseUuid,
                  courseName,
                  String(q.categoryId ?? ""),
                  String(q.knowledgePointId ?? ""),
                  String(q.questionId ?? ""),
                  q.pointGot != null ? Number(q.pointGot) : null,
                  q.pointMax != null ? Number(q.pointMax) : null,
                  q.pointGot != null ? Number(q.pointGot) : null,
                  seq++,
                  nowIso
                );
              }
              stats.examCourses++;
            }
            n++;
          }

          // ---------- ⑤ todo_items(source=child) → life_plans ----------
          const todoRows = kb
            .prepare(
              `SELECT id, todo_date, title, status, done_at, due_time, note FROM todo_items
               WHERE source = 'child'`
            )
            .all() as Array<{
            id: string;
            todo_date: string;
            title: string;
            status: string;
            done_at: string;
            due_time: string;
            note: string;
          }>;
          const insLife = kb.prepare(
            `INSERT OR REPLACE INTO life_plans
             (id,parent_id,child_id,title,creator,origin,recurrence_id,start_at,due_at,status,result,done_at,
              task_type,count_in_rate,points,active,created_at,updated_at)
             VALUES (?,?,?,?,'child','migration','',?,?,?,?,?,'required',1,0,?,?,?)`
          );
          for (const t of todoRows) {
            let status = t.status === "done" ? "done" : "pending";
            let active = 1;
            if (status === "pending" && isPast(t.todo_date)) {
              status = "missed";
              active = 0;
            }
            const hhmm = (t.due_time || "").trim();
            const dueAt = /^\d{1,2}:\d{2}$/.test(hhmm)
              ? `${t.todo_date} ${hhmm.length === 4 ? "0" + hhmm : hhmm}:00`
              : dayEnd(t.todo_date);
            if (!dryRun) {
              insLife.run(
                t.id,
                parentId,
                childId,
                t.title,
                dayStart(t.todo_date),
                dueAt,
                status,
                t.note || "",
                t.done_at ? `${t.done_at} ${t.done_at.length === 10 ? "23:59:59" : ""}`.trim().slice(0, 19) : "",
                active,
                nowIso,
                nowIso
              );
            }
            stats.planLife++;
          }

          // ---------- ⑥ child_todo_stats → reward_daily_stats（不回溯发分） ----------
          const stRows = kb
            .prepare("SELECT date, parent_total, parent_done, self_total, self_done, rate, streak FROM child_todo_stats")
            .all() as Array<{
            date: string;
            parent_total: number;
            parent_done: number;
            self_total: number;
            self_done: number;
            rate: number;
            streak: number;
          }>;
          const insStats = kb.prepare(
            `INSERT OR REPLACE INTO reward_daily_stats
             (child_id,date,source,owner,required_total,required_done,optional_done,missed_count,cancelled_count,rate,tier,gate_ok,points_awarded,settled_at,updated)
             VALUES (?,?,'todo',?,?,?,0,?,0,?,'',NULL,0,'',?)`
          );
          for (const st of stRows) {
            if (!dryRun) {
              insStats.run(childId, st.date, "parent", st.parent_total, st.parent_done, Math.max(0, st.parent_total - st.parent_done),
                st.parent_total ? st.parent_done / st.parent_total : 0, nowIso);
              insStats.run(childId, st.date, "child", st.self_total, st.self_done, Math.max(0, st.self_total - st.self_done),
                st.self_total ? st.self_done / st.self_total : 0, nowIso);
            }
            stats.stats2 += 2;
          }

          if (!dryRun) {
            kb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('plan_domain_migrated', ?)").run(nowIso);
          }
          kb.exec("COMMIT");
          stats.children++;
          console.log(
            `[${dryRun ? "DRY" : "OK"}] parent=${parentId} child=${childId}: study=${planRows.length} exam=${schedRows.length} examQ=${stats.examCourses} life=${todoRows.length} stats=${stRows.length}`
          );
        } catch (e) {
          kb.exec("ROLLBACK");
          throw e;
        }
      } finally {
        kb.close();
      }
    }
  }

  console.log(
    `\n${dryRun ? "[DRY-RUN] " : ""}迁移完成：家长 ${stats.parents}，孩子 ${stats.children}，跳过(已迁) ${stats.skipped}\n` +
      `  学习计划 ${stats.planStudy}，考核计划 ${stats.planExam}，考核明细 ${stats.examCourses}，生活计划 ${stats.planLife}，日统计 ${stats.stats2}，课程uuid回填 ${stats.courseUuid}`
  );
} finally {
  main.close();
}
