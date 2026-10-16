/**
 * ISSUE-186 F0 回归（2026-10-16）：错题整理任务的**字词出题链路**。
 *
 * 现场：`错题整理/字词` 课 89 个知识点只有 29 个有题。核对结论＝出题这一步**存在**，但有 4 处缺陷：
 *   ① 题干口径是"读音或释义简答"，不是用户要的"说清意思 + 造句（口述题）"；
 *   ② `ORDER BY rowid DESC LIMIT 8` 永远取最新 8 个没题知识点 → 这批里只要对不上名，更老的词**永远轮不到**；
 *   ③ 只认 `k.name === q.word` 精确相等 → 模型回带拼音/括号即静默丢弃，且下轮仍占名额；
 *   ④ 出题结果零留痕。
 * 本文件锁死修复后的口径：口述题 prompt（带 id）、名字归一、待出题选择（老的优先 + 失败跳过）、
 * 失败计数读写、释义只在空值时补。
 *
 * 非假绿：把 prompt 改回"读音或释义"、或把选择改回 `rowid DESC`、或去掉失败跳过，对应用例即红。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openParentLib } from "../server/src/db/parent-lib";
import {
  QFAIL_LIMIT,
  QUESTION_CAP,
  buildQuestionPrompt,
  bumpQuestionFail,
  clearQuestionFail,
  ensureKnowledgePoint,
  ensureSortingCourse,
  normalizeWordName,
  readQuestionFails,
  selectPendingQuestions,
  WORD_COURSE,
} from "../server/src/worker/mistake-sorting";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue186-ms-"));
const parentId = "parent-186ms";

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL */
  }
});

withParent((parent) => {
  const cu = ensureSortingCourse(parent, WORD_COURSE);
  // 老 → 新：w1 最老（也是本轮应最先出题的）
  for (const w of ["验", "迫", "毛糙", "糙", "调"]) ensureKnowledgePoint(parent, cu, w, `释义-${w}`);
  // 已有题的知识点不参与
  const kpDone = ensureKnowledgePoint(parent, cu, "橘", "释义-橘");
  const qid = "q186-ms-1";
  parent.prepare("INSERT INTO question_bank (id, stem, answer) VALUES (?, ?, ?)").run(qid, "「橘」是什么意思？", "橘子");
  parent
    .prepare("INSERT INTO course_knowledge_questions (course_id, knowledge_point_id, question_id) VALUES (?, ?, ?)")
    .run(cu, kpDone, qid);
});

function withParent<R>(fn: (db: ReturnType<typeof openParentLib>) => R): R {
  const db = openParentLib(dataDir, parentId);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe("ISSUE-186 F0 · 字词出题 prompt", () => {
  it("是口述题：说清意思 + 造句；带 kp id 要求原样回填；题干不含答案", () => {
    const p = buildQuestionPrompt([{ id: "kp-1", content: "研", detail: "yán，磨细" }]);
    expect(p).toContain("口述题");
    expect(p).toContain("说清");
    expect(p).toContain("造句");
    expect(p).toContain("不要出现答案");
    expect(p).toContain("[id=kp-1]");
    expect(p).toContain("原样回填");
    expect(p).toContain('"stem"');
  });
});

describe("ISSUE-186 F0 · 名字归一（模型返回名兜底匹配）", () => {
  it("去括号及内容（拼音/注音）、去空白与引号书名号", () => {
    expect(normalizeWordName("论语（Lún Yǔ）")).toBe("论语");
    expect(normalizeWordName("「研」")).toBe("研");
    expect(normalizeWordName(" 毛 糙 ")).toBe("毛糙");
    expect(normalizeWordName("迫（pò）")).toBe("迫");
    // 口径：只剥"括号及其内容"；没括号的拼音不会被剥（此时仍按原名匹配）
    expect(normalizeWordName("迫 pò")).toBe("迫pò");
    expect(normalizeWordName("橘")).toBe("橘");
  });
});

describe("ISSUE-186 F0 · 待出题选择（老的优先 + 失败跳过）", () => {
  it("只在本课里找没挂题的知识点，老的优先，且不超过 cap", () => {
    const { pending } = withParent((p) => selectPendingQuestions(p, courseUuid(p), 3));
    expect(pending.map((k) => k.name)).toEqual(["验", "迫", "毛糙"]);
    expect(pending.every((k) => k.detail.startsWith("释义-"))).toBe(true);
  });

  it("cap 提上去了（能一次补更多字词）", () => {
    expect(QUESTION_CAP).toBeGreaterThanOrEqual(20);
  });

  it(`连续失败 ${QFAIL_LIMIT} 轮的知识点本轮起跳过（进 stuck），不再占名额`, () => {
    const cu = withParent(courseUuid);
    const first = withParent((p) => selectPendingQuestions(p, cu, 2));
    const stuckId = first.pending[0]!.id;
    for (let i = 0; i < QFAIL_LIMIT; i++) withParent((p) => bumpQuestionFail(p, cu, stuckId));
    const after = withParent((p) => selectPendingQuestions(p, cu, 2));
    expect(after.stuck.map((s) => s.id)).toContain(stuckId);
    expect(after.pending.map((k) => k.id)).not.toContain(stuckId);
    // 后面的词因此能被轮到（不再是同一批永远占位）
    expect(after.pending.map((k) => k.name)).toEqual(["迫", "毛糙"]);
    // 成功后清零 → 重新回到候选
    withParent((p) => clearQuestionFail(p, cu, stuckId));
    expect(withParent((p) => readQuestionFails(p, cu)).has(stuckId)).toBe(false);
    expect(withParent((p) => selectPendingQuestions(p, cu, 2)).pending.map((k) => k.id)).toContain(stuckId);
  });
});

describe("ISSUE-186 F0 · 知识点释义只在空值时补", () => {
  it("已有释义不被覆盖；空释义补上（出题素材）", () => {
    const cu = withParent(courseUuid);
    const filled = withParent((p) => ensureKnowledgePoint(p, cu, "糙", "不该覆盖"));
    const row1 = withParent((p) => p.prepare("SELECT detail FROM knowledge_points WHERE id = ?").get(filled)) as { detail: string };
    expect(row1.detail).toBe("释义-糙");
    const empty = withParent((p) => ensureKnowledgePoint(p, cu, "生词甲", ""));
    withParent((p) => ensureKnowledgePoint(p, cu, "生词甲", "补上的释义"));
    const row2 = withParent((p) => p.prepare("SELECT detail FROM knowledge_points WHERE id = ?").get(empty)) as { detail: string };
    expect(row2.detail).toBe("补上的释义");
  });
});

function courseUuid(parent: ReturnType<typeof openParentLib>): string {
  const row = parent.prepare("SELECT uuid FROM courses WHERE topic = '错题整理' AND title = ?").get(WORD_COURSE) as
    | { uuid?: string }
    | undefined;
  if (!row?.uuid) throw new Error("seed 失败：字词课程不存在");
  return row.uuid;
}
