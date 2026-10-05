/**
 * ISSUE-114 C3：考核错题同步进错题本（plan-domain applyExamAttempts 路径的幂等/去重语义）。
 * 直接测 db/mistakes 的 exam 幂等哨兵 + plan-domain 的落库 SQL 语义在真实孩子库上的行为。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import {
  upsertMistake,
  listMistakes,
  examMistakeSynced,
  setMistakeStatus,
  upsertExamMistake,
  masterByQuestion,
  attachQuestionStems,
} from "../server/src/db/mistakes";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mistakes-"));
const parentId = "parent-mk";
const childId = "child-mk";

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL */
  }
});

let seq = 0;
describe("ISSUE-114：错题本", () => {
  const childOf = () => `${childId}-${++seq}`;
  it("upsert：同 (content,kind,course_ref) 合并 count+1；mastered 复发重开为 open", () => {
    const cid = childOf();
    const r1 = upsertMistake(dataDir, parentId, cid, {
      kind: "unknown_word", content: "曙", detail: "shǔ，拂晓", source: "lookup",
    });
    expect(r1.count).toBe(1);
    setMistakeStatus(dataDir, parentId, cid, r1.id, "mastered");
    const r2 = upsertMistake(dataDir, parentId, cid, {
      kind: "unknown_word", content: "曙", detail: "shǔ，拂晓",
    });
    expect(r2.count).toBe(2);
    expect(r2.status).toBe("open"); // 重复出现 = 未掌握的证据
    const rows = listMistakes(dataDir, parentId, cid, { status: "open" });
    expect(rows).toHaveLength(1); // 同条合并，不堆积
  });

  it("kind/course_ref 参与去重：同字词不同课程上下文是不同条目", () => {
    const cid2 = childOf();
    upsertMistake(dataDir, parentId, cid2, { kind: "weak_point", content: "应用题", course_ref: "数学" });
    upsertMistake(dataDir, parentId, cid2, { kind: "weak_point", content: "应用题", course_ref: "语文" });
    const rows = listMistakes(dataDir, parentId, cid2, { kind: "weak_point" });
    expect(rows).toHaveLength(2);
  });

  it("C3：examMistakeSynced 哨兵防重复挂接刷次数", () => {
    const cid3 = childOf();
    const m1 = upsertMistake(dataDir, parentId, cid3, {
      kind: "wrong_question", content: "三家者以雍彻（3/10）",
      source: "exam", source_ref: "attempt-1", question_id: "q-1",
      detail: "读音混淆",
    });
    expect(m1.count).toBe(1);
    // 模拟 worker 重复跑 applyExamAttempts：哨兵命中 → 调用方跳过，count 不变
    expect(examMistakeSynced(dataDir, parentId, cid3, "attempt-1", "q-1")).toBe(true);
    const again = listMistakes(dataDir, parentId, cid3, { status: "open" });
    expect(again.find((r) => r.source_ref === "attempt-1")?.count).toBe(1);
  });

  it("status 流转：dismiss 后可 reopen", () => {
    const cid4 = childOf();
    const m = upsertMistake(dataDir, parentId, cid4, {
      kind: "wrong_question", content: "为政篇错题", source: "exam", source_ref: "attempt-2", question_id: "q-2",
    });
    expect(setMistakeStatus(dataDir, parentId, cid4, m.id, "dismissed")).toBe(true);
    expect(listMistakes(dataDir, parentId, cid4, { status: "open" }).length).toBe(0);
    expect(setMistakeStatus(dataDir, parentId, cid4, m.id, "open")).toBe(true);
    expect(listMistakes(dataDir, parentId, cid4, { status: "open" }).length).toBe(1);
  });

  // ===== 2026-09-29：考核错题按原题 question_id 闭环 =====

  it("upsertExamMistake：同 question_id 合并 count+1；mastered 复发重开；content 每场不同也命中同一条", () => {
    const cid5 = childOf();
    const a = upsertExamMistake(dataDir, parentId, cid5, {
      kind: "wrong_question", content: "考核A·论语·知之为知之（6/10）", detail: "第一次卡住",
      source: "exam", source_ref: "attempt-a", question_id: "q-x", course_ref: "论语",
    });
    expect(a.created).toBe(true);
    // 另一场考核同题再错：content 不同（标题/得分变了），按 question_id 命中同一条
    const b = upsertExamMistake(dataDir, parentId, cid5, {
      kind: "wrong_question", content: "考核B·论语·知之为知之（8/10）", detail: "又错了",
      source: "exam", source_ref: "attempt-b", question_id: "q-x", course_ref: "论语",
      knowledge_point_name: "知之为知之",
    });
    expect(b.created).toBe(false);
    expect(b.row.id).toBe(a.row.id);
    expect(b.row.count).toBe(2);
    expect(b.row.status).toBe("open");
    expect(b.row.knowledge_point_name).toBe("知之为知之"); // 空快照被补齐
    expect(b.row.detail).toBe("又错了"); // 非空 detail 覆盖
    // 标掌握后再错 → 复发重开 open（未掌握的证据）
    setMistakeStatus(dataDir, parentId, cid5, a.row.id, "mastered");
    const c = upsertExamMistake(dataDir, parentId, cid5, {
      kind: "wrong_question", content: "考核C·论语·知之为知之（5/10）",
      source: "exam", source_ref: "attempt-c", question_id: "q-x", course_ref: "论语",
    });
    expect(c.created).toBe(false);
    expect(c.row.status).toBe("open");
    expect(c.row.count).toBe(3);
  });

  it("masterByQuestion：做对→open 条目自动 mastered；dismissed 不动；无命中返回 0", () => {
    const cid6 = childOf();
    const m1 = upsertMistake(dataDir, parentId, cid6, {
      kind: "wrong_question", content: "温故而知新（4/10）", source: "exam", question_id: "q-y",
    });
    const m2 = upsertMistake(dataDir, parentId, cid6, {
      kind: "wrong_question", content: "温故而知新（7/10）", source: "exam", question_id: "q-y",
    });
    expect(m2.count).toBe(1); // 直接 upsertMistake：content 含得分不同 → 另立一条（exam 路由走 upsertExamMistake 才按原题合并）
    setMistakeStatus(dataDir, parentId, cid6, m2.id, "dismissed");
    const closed = masterByQuestion(dataDir, parentId, cid6, "q-y");
    expect(closed).toBe(1); // m1 open → mastered；m2 dismissed 不动
    const rows = listMistakes(dataDir, parentId, cid6, {});
    expect(rows.find((r) => r.id === m1.id)?.status).toBe("mastered");
    expect(rows.find((r) => r.id === m2.id)?.status).toBe("dismissed");
    expect(masterByQuestion(dataDir, parentId, cid6, "q-zz")).toBe(0);
  });

  it("attachQuestionStems：按 question_id 从家长库题库补题干；无原题/题已删原样返回", () => {
    const cid7 = childOf();
    const pid = `parent-mk-${cid7}`;
    const parent = openParentLib(dataDir, pid);
    try {
      parent.prepare(
        "INSERT INTO question_bank (id, stem, answer, scoring, options, note, knowledge_summary, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', '', '', datetime('now'), datetime('now'))"
      ).run("q-live", "「学而时习之」的「习」是什么意思？", "温习、实践", "答对即可");
    } finally {
      parent.close();
    }
    const withLive = upsertMistake(dataDir, pid, cid7, {
      kind: "wrong_question", content: "考核·习（6/10）", source: "exam", question_id: "q-live",
    });
    const withGone = upsertMistake(dataDir, pid, cid7, {
      kind: "wrong_question", content: "考核·已删题（6/10）", source: "exam", question_id: "q-deleted",
    });
    const rows = attachQuestionStems(dataDir, pid, listMistakes(dataDir, pid, cid7, {}));
    const live = rows.find((r) => r.id === withLive.id) as typeof withLive & { question_stem?: string };
    const gone = rows.find((r) => r.id === withGone.id) as typeof withGone & { question_stem?: string };
    expect(live.question_stem).toContain("学而时习之");
    expect(gone.question_stem).toBeUndefined();
    // 无原题条目（question_id 空）不影响
    const plain = attachQuestionStems(dataDir, pid, [
      { id: "m-plain", question_id: "", content: "曙" },
    ]);
    expect(plain[0]).toEqual({ id: "m-plain", question_id: "", content: "曙" });
  });
});
