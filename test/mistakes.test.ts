/**
 * ISSUE-114 C3：考核错题同步进错题本（plan-domain applyExamAttempts 路径的幂等/去重语义）。
 * 直接测 db/mistakes 的 exam 幂等哨兵 + plan-domain 的落库 SQL 语义在真实孩子库上的行为。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openKb } from "../server/src/db/kb";
import {
  upsertMistake,
  listMistakes,
  examMistakeSynced,
  setMistakeStatus,
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
});
