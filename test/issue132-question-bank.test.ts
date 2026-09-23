/**
 * ISSUE-132 回归（2026-09-22）：题库管理——维度 facets + 单题挂载/摘除/删除 + 列表上限回归。
 *
 * 覆盖：
 * ① listBankFacets：主题/课程/知识点三维全量（含还没挂题的课与知识点）；
 * ② linkQuestionToKnowledgePoint：courseId 或 topic+title 定位课、kpId 或按名新建知识点、重复挂载幂等；
 * ③ unlinkQuestionFromKnowledgePoint：只摘挂载、题目保留；
 * ④ deleteBankQuestion：事务删挂载行 + 题目行；
 * ⑤ BANK_LIST_LIMIT ≥ 10000 且全量列表不被 2000 截断（ISSUE-074 修复被 F10-b 重构回归过一次）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openParentLib } from "../server/src/db/parent-lib";
import {
  BANK_LIST_LIMIT,
  listAllBankQuestions,
  listBankFacets,
  linkQuestionToKnowledgePoint,
  unlinkQuestionFromKnowledgePoint,
  deleteBankQuestion,
  saveQuestion,
  getCourseUuid,
  getOrCreateKnowledgePoint,
  listCourseContent,
} from "../server/src/db/assess-content";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue132-"));
const parentId = "parent-132";
const T = "lunyu";
const C1 = "学而第一";
const C2 = "为政第二";

const mainDb = openDb(dataDir);
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p132@test", new Date().toISOString(), new Date().toISOString());

function withDb<T>(fn: (db: ReturnType<typeof openParentLib>) => T): T {
  const db = openParentLib(dataDir, parentId);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ---- seed：主题/两门课/一个知识点/一道已挂载题 + 一道未挂载题 ----
withDb((db) => {
  db.prepare("INSERT INTO topics (name, topic_key) VALUES (?, ?)").run(T, T);
  db.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 1)").run(T, C1);
  db.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 2)").run(T, C2);
});
const uuid1 = withDb((db) => {
  const u = getCourseUuid(db, T, C1);
  if (!u) throw new Error("seed 失败：course uuid 未回填");
  getOrCreateKnowledgePoint(db, u, "孝悌", "仁之本");
  return u;
});
const uuid2 = withDb((db) => getCourseUuid(db, T, C2));
if (!uuid2) throw new Error("seed 失败：course2 uuid 缺失");

const qMounted = withDb((db) => saveQuestion(db, { stem: "背诵学而首章", answer: "学而时习之，不亦说乎", behavior: "speech_recite", pointMax: 10 }));
const qFree = withDb((db) => saveQuestion(db, { stem: "「习」是什么意思", answer: "实践、温习", knowledgeSummary: "学而" }));
withDb((db) => {
  const kp = getOrCreateKnowledgePoint(db, uuid1, "孝悌");
  linkQuestionToKnowledgePoint(db, { questionId: qMounted, courseId: uuid1, knowledgePointId: kp.id });
});

afterAll(() => {
  try {
    mainDb.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL 句柄滞后，忽略 */
  }
});

describe("ISSUE-132 题库管理", () => {
  it("facets 返回主题/课程/知识点三维全量（含未挂题的课程）", () => {
    const f = withDb(listBankFacets);
    expect(f.topics.map((t) => t.name)).toContain(T);
    expect(f.courses.map((c) => c.title).sort()).toEqual([C1, C2].sort());
    expect(f.courses.every((c) => c.uuid)).toBe(true);
    expect(f.knowledgePoints.map((k) => k.name)).toContain("孝悌");
    // C2 还没有任何知识点/题目，也必须出现在 facets 里（供「在课程下新建」选择）
    expect(f.knowledgePoints.every((k) => k.courseUuid !== uuid2)).toBe(true);
  });

  it("link：按 courseId+kpId 挂载，contexts 带 courseUuid/knowledgePointId", () => {
    const kpId = withDb(listBankFacets).knowledgePoints.find((k) => k.name === "孝悌")!.id;
    const r = withDb((db) => linkQuestionToKnowledgePoint(db, { questionId: qFree, courseId: uuid1, knowledgePointId: kpId }));
    expect(r.linked).toBe(true);
    expect(r.courseId).toBe(uuid1);
    expect(r.knowledgePointName).toBe("孝悌");
    const listed = withDb(listAllBankQuestions).find((q) => q.id === qFree)!;
    const ctx = listed.contexts.find((c) => c.course === C1)!;
    expect(ctx.courseUuid).toBe(uuid1);
    expect(ctx.knowledgePointId).toBe(kpId);
    expect(ctx.knowledgePoint).toBe("孝悌");
  });

  it("link：kpId 不属于该课要拒绝", () => {
    expect(() =>
      withDb((db) => {
        const fake = "00000000-0000-4000-8000-000000000000";
        return linkQuestionToKnowledgePoint(db, { questionId: qFree, courseId: uuid1, knowledgePointId: fake });
      })
    ).toThrow(/知识点不存在或不属于该课/);
  });

  it("link：按 topic+title 定位课 + 按名新建知识点；重复挂载幂等", () => {
    const r1 = withDb((db) => linkQuestionToKnowledgePoint(db, { questionId: qFree, topic: T, title: C2, knowledgePointName: "温故知新", knowledgePointDetail: "复习旧课" }));
    expect(r1.linked).toBe(true);
    expect(r1.knowledgePointName).toBe("温故知新");
    // 新知识点应出现在 facets 且属于 C2
    const f = withDb(listBankFacets);
    const kp = f.knowledgePoints.find((k) => k.name === "温故知新");
    expect(kp?.courseUuid).toBe(uuid2);
    expect(kp?.detail).toBe("复习旧课");
    // 同题同知识点再挂 → linked=false（INSERT OR IGNORE 幂等）
    const r2 = withDb((db) => linkQuestionToKnowledgePoint(db, { questionId: qFree, courseId: uuid2, knowledgePointId: kp!.id }));
    expect(r2.linked).toBe(false);
    // 题库列表的 contexts 带 uuid/kpId（供 UI 摘挂载）
    const listed = withDb(listAllBankQuestions).find((q) => q.id === qFree)!;
    const ctx = listed.contexts.find((c) => c.course === C2)!;
    expect(ctx.courseUuid).toBe(uuid2);
    expect(ctx.knowledgePointId).toBe(kp!.id);
  });

  it("unlink：只摘一处挂载，题目与其它挂载保留", () => {
    const kpId = withDb(listBankFacets).knowledgePoints.find((k) => k.name === "温故知新")!.id;
    const r = withDb((db) => unlinkQuestionFromKnowledgePoint(db, { questionId: qFree, courseId: uuid2, knowledgePointId: kpId }));
    expect(r.removed).toBe(true);
    const listed = withDb(listAllBankQuestions).find((q) => q.id === qFree)!;
    expect(listed, "摘挂载后题目仍在题库").toBeTruthy();
    expect(listed!.contexts.some((c) => c.course === C2)).toBe(false);
    // 再摘一次 → removed=false
    const r2 = withDb((db) => unlinkQuestionFromKnowledgePoint(db, { questionId: qFree, courseId: uuid2, knowledgePointId: kpId }));
    expect(r2.removed).toBe(false);
  });

  it("delete：删题同时清挂载行；course 内容同步消失", () => {
    const r = withDb((db) => deleteBankQuestion(db, qMounted));
    expect(r.deleted).toBe(true);
    expect(r.mountsRemoved).toBeGreaterThanOrEqual(1);
    expect(withDb((db) => deleteBankQuestion(db, qMounted)).deleted).toBe(false);
    const listed = withDb(listAllBankQuestions);
    expect(listed.some((q) => q.id === qMounted)).toBe(false);
    const content = withDb((db) => listCourseContent(db, uuid1));
    expect(content.items.some((it) => it.questions.some((q) => q.id === qMounted))).toBe(false);
  });

  it("列表不被 2000 静默截断（ISSUE-074 回归守卫）", () => {
    expect(BANK_LIST_LIMIT).toBeGreaterThanOrEqual(10000);
    withDb((db) => {
      const ins = db.prepare("INSERT INTO question_bank (id, stem, answer) VALUES (?, ?, ?)");
      db.exec("BEGIN");
      for (let i = 0; i < 2100; i++) ins.run(`bulk-${parentId}-${i}`, `.bulk ${i}`, "-");
      db.exec("COMMIT");
    });
    const all = withDb(listAllBankQuestions);
    expect(all.length).toBeGreaterThanOrEqual(2100);
  });
});
