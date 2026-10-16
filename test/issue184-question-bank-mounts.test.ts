/**
 * ISSUE-184 回归（2026-10-16）：题库挂载反查被**单页上限**截断 → UI 里题目「全都未挂载」。
 *
 * 根因：`listAllBankQuestions` 走注册表路径 `bank_question_contexts`（路径 rowLimit=5000）只查了**一页**，
 * 而大库挂载行数远超它（现场库 13280 行）——`ORDER BY course_knowledge_questions.rowid ASC` 下，
 * 后插入的挂载（= 题库列表按 rowid DESC 排在最前的那些题）整批落在窗口外 → `contexts` 全空。
 *
 * 覆盖：
 * ① 挂载行数 > 单页（BANK_CTX_PAGE）时，**每道题**都能拿到自己的 contexts（翻页拉全量）；
 * ② 最新插入的题（列表首屏）也有挂载——正是用户看到「所有题都未挂载」的位置；
 * ③ 单页内的常规库行为不变（courseUuid / knowledgePointId / 名称齐全）。
 *
 * 非假绿：把 `listAllBankQuestions` 的翻页改回单次查询（limit=5000、无 offset），① 会红（只 5000 道有挂载）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openParentLib } from "../server/src/db/parent-lib";
import {
  BANK_CTX_PAGE,
  getCourseUuid,
  getOrCreateKnowledgePoint,
  listAllBankQuestions,
} from "../server/src/db/assess-content";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue184-"));
const parentId = "parent-184";
const T = "lunyu";
const C1 = "字词（大库回归）";
/** 比单页多 200 行：只要还能翻页就必须全覆盖 */
const MOUNTS = BANK_CTX_PAGE + 200;

function withDb<R>(fn: (db: ReturnType<typeof openParentLib>) => R): R {
  const db = openParentLib(dataDir, parentId);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

withDb((db) => {
  db.prepare("INSERT INTO topics (name, topic_key) VALUES (?, ?)").run(T, T);
  db.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 1)").run(T, C1);
});

const uuids = withDb((db) => {
  // 课程 uuid 由 openParentLib 的幂等迁移回填 → 必须**新开一次**库才能读到（同 ISSUE-132 测试口径）
  const uuid = getCourseUuid(db, T, C1);
  if (!uuid) throw new Error("seed 失败：course uuid 未回填");
  const kp = getOrCreateKnowledgePoint(db, uuid, "字词");
  const insQ = db.prepare("INSERT INTO question_bank (id, stem, answer) VALUES (?, ?, ?)");
  const insM = db.prepare(
    "INSERT INTO course_knowledge_questions (course_id, knowledge_point_id, question_id, seq) VALUES (?, ?, ?, 0)"
  );
  db.exec("BEGIN");
  for (let i = 0; i < MOUNTS; i++) {
    const qid = `q184-${String(i).padStart(5, "0")}`;
    insQ.run(qid, `.回归题 ${i}`, "-");
    insM.run(uuid, kp.id, qid);
  }
  db.exec("COMMIT");
  return { courseUuid: uuid, kpId: kp.id };
});

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL 句柄滞后，忽略 */
  }
});

describe("ISSUE-184 题库挂载反查翻页", () => {
  it("挂载行数超过单页上限时，每道题都能拿到 contexts（不再只读首页）", () => {
    const all = withDb(listAllBankQuestions);
    expect(all.length).toBe(MOUNTS);
    const withCtx = all.filter((q) => q.contexts.length > 0);
    expect(withCtx.length, `只有 ${withCtx.length}/${all.length} 道题带挂载——挂载反查被单页截断了`).toBe(MOUNTS);
    expect(all.every((q) => q.contexts.length === 1)).toBe(true);
  });

  it("列表首屏（最新插入的题）也带挂载", () => {
    const all = withDb(listAllBankQuestions);
    // 与 SQL 一致：ORDER BY rowid DESC → 首条 = 最后插入的那道题
    const newest = all[0];
    expect(newest.id).toBe(`q184-${String(MOUNTS - 1).padStart(5, "0")}`);
    expect(newest.contexts.length).toBe(1);
    expect(newest.contexts[0].course).toBe(C1);
    expect(newest.contexts[0].topic).toBe(T);
    expect(newest.contexts[0].knowledgePoint).toBe("字词");
    expect(newest.contexts[0].courseUuid).toBe(uuids.courseUuid);
    expect(newest.contexts[0].knowledgePointId).toBe(uuids.kpId);
  });
});
