/**
 * 错题/生字本读写（ISSUE-114）：孩子 kb mistake_book 单表，kind 区分
 * wrong_question（口述/考核错题）/ unknown_word（查词生字）/ weak_point（稳定薄弱点）。
 *
 * 闭环语义：散落信号 → upsert 沉淀（重复出现 count+1 = 未掌握的证据，mastered 复发自动重开）
 * → 复习触达（agent 读工具 + 教学 prompt 注入）→ 掌握关闭（mastered）/ 手动 dismissed。
 * 去重 UNIQUE(content, kind, course_ref)；exam 来源按 (source_ref, question_id) 幂等，不刷次数。
 */
import { randomUUID } from "node:crypto";
import { openKb } from "./kb.js";
import { openParentLib } from "./parent-lib.js";

export type MistakeKind = "wrong_question" | "unknown_word" | "weak_point";
export type MistakeStatus = "open" | "mastered" | "dismissed";

export interface MistakeUpsert {
  kind: MistakeKind;
  content: string;
  detail?: string;
  source?: string;
  source_ref?: string;
  question_id?: string;
  course_ref?: string;
  knowledge_point_id?: string;
  knowledge_point_name?: string;
}

export interface MistakeRow {
  id: string;
  kind: MistakeKind;
  content: string;
  detail: string;
  source: string;
  source_ref: string;
  question_id: string;
  course_ref: string;
  knowledge_point_id: string;
  knowledge_point_name: string;
  count: number;
  status: MistakeStatus;
  first_seen: string;
  last_seen: string;
  mastered_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 新增/合并一条错题。content/kind/course_ref 相同即同一条：count+1、last_seen 刷新、
 *  detail 非空覆盖、mastered 复发重开为 open。返回当前行。 */
export function upsertMistake(
  dataDir: string,
  parentId: string,
  childId: string,
  m: MistakeUpsert
): MistakeRow {
  const content = String(m.content ?? "").trim();
  if (!content) throw new Error("mistake content 不能为空");
  const kind = m.kind;
  if (!["wrong_question", "unknown_word", "weak_point"].includes(kind)) throw new Error(`kind 非法：${kind}`);
  const now = nowIso();
  const db = openKb(dataDir, parentId, childId);
  try {
    db.prepare(
      `INSERT INTO mistake_book (id, kind, content, detail, source, source_ref, question_id,
         course_ref, knowledge_point_id, knowledge_point_name, count, status, first_seen, last_seen, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', ?, ?, ?, ?)
       ON CONFLICT(content, kind, course_ref) DO UPDATE SET
         count = mistake_book.count + 1,
         last_seen = excluded.last_seen,
         updated_at = excluded.updated_at,
         detail = CASE WHEN excluded.detail != '' THEN excluded.detail ELSE mistake_book.detail END,
         status = 'open'`
    ).run(
      randomUUID(), kind, content,
      String(m.detail ?? ""), String(m.source ?? "conversation"), String(m.source_ref ?? ""),
      String(m.question_id ?? ""), String(m.course_ref ?? ""),
      String(m.knowledge_point_id ?? ""), String(m.knowledge_point_name ?? ""),
      now, now, now, now
    );
    const row = db
      .prepare("SELECT * FROM mistake_book WHERE content = ? AND kind = ? AND course_ref = ?")
      .get(content, kind, String(m.course_ref ?? "")) as unknown as MistakeRow;
    return row;
  } finally {
    db.close();
  }
}

/** 列表（status/kind 可选过滤；last_seen 倒序，limit 缺省 50）。 */
export function listMistakes(
  dataDir: string,
  parentId: string,
  childId: string,
  opts?: { status?: MistakeStatus; kind?: MistakeKind; limit?: number }
): MistakeRow[] {
  const db = openKb(dataDir, parentId, childId);
  try {
    const conds: string[] = [];
    const vals: unknown[] = [];
    if (opts?.status) {
      conds.push("status = ?");
      vals.push(opts.status);
    }
    if (opts?.kind) {
      conds.push("kind = ?");
      vals.push(opts.kind);
    }
    const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(Number(opts?.limit) || 50, 200));
    return db
      .prepare(`SELECT * FROM mistake_book${where} ORDER BY last_seen DESC, count DESC LIMIT ${limit}`)
      .all(...(vals as Array<null | number | bigint | string>)) as unknown as MistakeRow[];
  } finally {
    db.close();
  }
}

/** 状态流转：mastered / dismissed / reopen。返回是否命中行。 */
export function setMistakeStatus(
  dataDir: string,
  parentId: string,
  childId: string,
  id: string,
  status: MistakeStatus
): boolean {
  const db = openKb(dataDir, parentId, childId);
  try {
    const masteredAt = status === "mastered" ? `, mastered_at = '${nowIso()}'` : "";
    const r = db
      .prepare(`UPDATE mistake_book SET status = ?, updated_at = '${nowIso()}'${masteredAt} WHERE id = ?`)
      .run(status, id);
    return r.changes > 0;
  } finally {
    db.close();
  }
}

/** C3 考核同步幂等哨兵：同一 attempt 的同一题只同步一次（重复挂接不刷 count）。 */
export function examMistakeSynced(
  dataDir: string,
  parentId: string,
  childId: string,
  sourceRef: string,
  questionId: string
): boolean {
  const db = openKb(dataDir, parentId, childId);
  try {
    return !!db
      .prepare("SELECT 1 FROM mistake_book WHERE source_ref = ? AND question_id = ? LIMIT 1")
      .get(sourceRef, questionId);
  } finally {
    db.close();
  }
}

/**
 * 考核错题按**原题**闭环（2026-09-29）：考核的 content 拼了考试标题/得分、每场必变，
 * content 去重键对 exam 来源天然失效——改按 question_id 匹配存量条目：
 * 命中未 dismiss 的行 → count+1 / last_seen 刷新 / 复发重开 open（补齐 kp 名称快照与课程）；
 * 未命中 → 走 content upsert 新建。返回 (行, 是否新建)。
 */
export function upsertExamMistake(
  dataDir: string,
  parentId: string,
  childId: string,
  m: MistakeUpsert & { content: string }
): { row: MistakeRow; created: boolean } {
  const questionId = String(m.question_id ?? "").trim();
  const db = openKb(dataDir, parentId, childId);
  try {
    if (questionId) {
      const existing = db
        .prepare(
          `SELECT * FROM mistake_book
            WHERE question_id = ? AND kind = 'wrong_question' AND status != 'dismissed'
            ORDER BY last_seen DESC LIMIT 1`
        )
        .get(questionId) as unknown as MistakeRow | undefined;
      if (existing) {
        const now = nowIso();
        db.prepare(
          `UPDATE mistake_book SET
             count = count + 1, last_seen = ?, updated_at = ?, status = 'open',
             detail = CASE WHEN ? != '' THEN ? ELSE detail END,
             knowledge_point_id = CASE WHEN knowledge_point_id = '' THEN ? ELSE knowledge_point_id END,
             knowledge_point_name = CASE WHEN knowledge_point_name = '' THEN ? ELSE knowledge_point_name END,
             course_ref = CASE WHEN course_ref = '' THEN ? ELSE course_ref END
           WHERE id = ?`
        ).run(
          now, now,
          String(m.detail ?? ""), String(m.detail ?? ""),
          String(m.knowledge_point_id ?? ""), String(m.knowledge_point_name ?? ""), String(m.course_ref ?? ""),
          existing.id
        );
        const row = db.prepare("SELECT * FROM mistake_book WHERE id = ?").get(existing.id) as unknown as MistakeRow;
        return { row, created: false };
      }
    }
    return { row: upsertMistake(dataDir, parentId, childId, m), created: true };
  } finally {
    db.close();
  }
}

/** 考核做对 → 该原题的 open 错题条目自动标掌握（返回关闭行数；dismissed 不动）。 */
export function masterByQuestion(
  dataDir: string,
  parentId: string,
  childId: string,
  questionId: string
): number {
  const qid = String(questionId ?? "").trim();
  if (!qid) return 0;
  const db = openKb(dataDir, parentId, childId);
  try {
    const now = nowIso();
    const r = db
      .prepare(
        `UPDATE mistake_book
           SET status = 'mastered', mastered_at = ?, updated_at = ?
         WHERE question_id = ? AND kind = 'wrong_question' AND status = 'open'`
      )
      .run(now, now, qid);
    return Number(r.changes);
  } finally {
    db.close();
  }
}

/** 清单附题干：按 question_id 从家长库 question_bank 取 stem（跨文件联不了表，读侧批量补）。
 *  家长库不可达/题已删 → 原样返回，不阻断清单。 */
export function attachQuestionStems<T extends { question_id?: string }>(
  dataDir: string,
  parentId: string,
  rows: T[]
): Array<T & { question_stem?: string }> {
  const ids = [...new Set(rows.map((r) => String(r.question_id ?? "").trim()).filter(Boolean))];
  if (!ids.length) return rows;
  try {
    const parent = openParentLib(dataDir, parentId);
    try {
      const map = new Map<string, string>();
      for (const chunk of Array.from({ length: Math.ceil(ids.length / 200) }, (_, i) => ids.slice(i * 200, (i + 1) * 200))) {
        const placeholders = chunk.map(() => "?").join(",");
        const found = parent
          .prepare(`SELECT id, stem FROM question_bank WHERE id IN (${placeholders})`)
          .all(...chunk) as Array<{ id: string; stem: string }>;
        for (const q of found) map.set(q.id, q.stem);
      }
      if (!map.size) return rows;
      return rows.map((r) => {
        const stem = map.get(String(r.question_id ?? "").trim());
        return stem ? { ...r, question_stem: stem } : r;
      });
    } finally {
      parent.close();
    }
  } catch {
    return rows;
  }
}
