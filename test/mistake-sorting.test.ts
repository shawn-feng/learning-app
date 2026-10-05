/**
 * 错题整理后台任务（ISSUE-114 方案 B/C 定案）的**纯 SQL 部分**回归：
 * 主题/课程/知识点/题目的幂等 ensure、孩子库分配、method_spec.perChild 维护、
 * prompt 构造器（分层筛选的字段契约）。LLM 环节不在单测范围（解析容错已由 extractJson 兜）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import {
  SORTING_TOPIC,
  WORD_COURSE,
  ensureSortingTopic,
  ensureSortingCourse,
  ensureKnowledgePoint,
  attachGeneratedQuestion,
  linkMistakeToKp,
  syncSortingCoursesToChild,
  updateSortingMethodSpec,
  buildStage1Prompt,
  buildStage2Prompt,
  buildQuestionPrompt,
} from "../server/src/worker/mistake-sorting";
import { upsertMistake, listMistakes } from "../server/src/db/mistakes";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mistake-sorting-"));
const parentId = "parent-ms";
const childId = "child-ms";

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL */
  }
});

describe("错题整理：家长库 ensure 幂等", () => {
  it("主题/课程重复 ensure 不新建（同 key 同 uuid）", () => {
    const parent = openParentLib(dataDir, parentId);
    try {
      ensureSortingTopic(parent);
      ensureSortingTopic(parent);
      const topics = parent.prepare("SELECT name, topic_key FROM topics WHERE name = ?").all(SORTING_TOPIC);
      expect(topics).toHaveLength(1);
      expect(topics[0].topic_key).toBe(SORTING_TOPIC);

      const u1 = ensureSortingCourse(parent, WORD_COURSE);
      const u2 = ensureSortingCourse(parent, WORD_COURSE);
      expect(u1).toBe(u2);
      // 同名课程在别的主题下是另一门（主题隔离）
      parent.prepare("INSERT INTO courses (topic, title, uuid) VALUES ('lunyu', ?, ?)").run(WORD_COURSE, "other-uuid");
      expect(ensureSortingCourse(parent, WORD_COURSE)).toBe(u1);
    } finally {
      parent.close();
    }
  });

  it("知识点 (course_uuid,name) 唯一：重复 ensure 返回同一 id；detail 只补空", () => {
    const parent = openParentLib(dataDir, parentId);
    try {
      const cu = ensureSortingCourse(parent, WORD_COURSE);
      const k1 = ensureKnowledgePoint(parent, cu, "研", "yán");
      const k2 = ensureKnowledgePoint(parent, cu, "研", "换个释义不应覆盖");
      expect(k1).toBe(k2);
      const row = parent.prepare("SELECT detail FROM knowledge_points WHERE id = ?").get(k1) as { detail: string };
      expect(row.detail).toBe("yán");
    } finally {
      parent.close();
    }
  });

  it("题目挂载幂等：同 kp 第二次 attachGeneratedQuestion 不再新挂", () => {
    const parent = openParentLib(dataDir, parentId);
    try {
      const cu = ensureSortingCourse(parent, WORD_COURSE);
      const kpId = ensureKnowledgePoint(parent, cu, "曙", "shǔ，拂晓");
      expect(attachGeneratedQuestion(parent, cu, kpId, { stem: "「曙」读什么？", answer: "shǔ" })).toBe(true);
      expect(attachGeneratedQuestion(parent, cu, kpId, { stem: "换个问法？", answer: "还是 shǔ" })).toBe(false);
      const n = parent
        .prepare("SELECT COUNT(*) AS n FROM course_knowledge_questions WHERE knowledge_point_id = ?")
        .get(kpId) as { n: number };
      expect(n.n).toBe(1);
      const q = parent
        .prepare(
          `SELECT qb.behavior, qb.note, qb.options FROM course_knowledge_questions cq
           JOIN question_bank qb ON qb.id = cq.question_id WHERE cq.knowledge_point_id = ?`
        )
        .get(kpId) as any;
      expect(q.behavior).toBe("generic");
      expect(q.note).toContain("自动生成");
    } finally {
      parent.close();
    }
  });
});

describe("错题整理：孩子库分配与错题关联", () => {
  it("分配主题/课程进孩子库（带 uuid 锚点，幂等）；错题回填 kp 引用", () => {
    const parent = openParentLib(dataDir, parentId);
    const kb = openKb(dataDir, parentId, childId);
    try {
      const cu = ensureSortingCourse(parent, WORD_COURSE);
      syncSortingCoursesToChild(parent, kb, childId);
      syncSortingCoursesToChild(parent, kb, childId); // 幂等
      const c = kb.prepare("SELECT topic, topic_key, uuid FROM courses WHERE topic = ? AND title = ?").get(SORTING_TOPIC, WORD_COURSE) as any;
      expect(c.uuid).toBe(cu);
      expect(c.topic_key).toBe(SORTING_TOPIC);
      const t = kb.prepare("SELECT topic_key FROM topics WHERE name = ?").get(SORTING_TOPIC) as any;
      expect(t.topic_key).toBe(SORTING_TOPIC);

      const m = upsertMistake(dataDir, parentId, childId, {
        kind: "unknown_word", content: "研", detail: "yán", source: "lookup",
      });
      const kpId = ensureKnowledgePoint(parent, cu, "研", "yán");
      linkMistakeToKp(kb, m.id, kpId, "研");
      const row = kb.prepare("SELECT knowledge_point_id, knowledge_point_name FROM mistake_book WHERE id = ?").get(m.id) as any;
      expect(row.knowledge_point_id).toBe(kpId);
      expect(row.knowledge_point_name).toBe("研");
      // 已关联的条目不再进待整理清单
      const pending = listMistakes(dataDir, parentId, childId, {}).filter((r: any) => r.knowledge_point_id === "");
      expect(pending).toHaveLength(0);
    } finally {
      kb.close();
      parent.close();
    }
  });

  it("method_spec.perChild：有 open 薄弱考点→require 名单；清空→删除该孩子限制", () => {
    const parent = openParentLib(dataDir, parentId);
    try {
      updateSortingMethodSpec(parent, childId, ["研", "曙"]);
      let spec = JSON.parse((parent.prepare("SELECT method_spec FROM topics WHERE topic_key = ?").get(SORTING_TOPIC) as any).method_spec);
      expect(spec.perChild[childId].require).toEqual(["研", "曙"]);
      updateSortingMethodSpec(parent, "child-other", ["白"]);
      updateSortingMethodSpec(parent, childId, []);
      spec = JSON.parse((parent.prepare("SELECT method_spec FROM topics WHERE topic_key = ?").get(SORTING_TOPIC) as any).method_spec);
      expect(spec.perChild[childId]).toBeUndefined();
      expect(spec.perChild["child-other"].require).toEqual(["白"]); // 其他孩子不受影响
    } finally {
      parent.close();
    }
  });
});

describe("错题整理：prompt 构造器", () => {
  it("stage1 含字词准入规则/主题清单/JSON 契约；stage2 要求逐字匹配；questionPrompt 禁答案泄漏", () => {
    const p1 = buildStage1Prompt(
      [{ id: "m1", kind: "unknown_word", content: "研", detail: "yán", course_ref: "", count: 2 }],
      [{ id: "m2", kind: "weak_point", content: "应用题总错", detail: "", course_ref: "", count: 1 }],
      [SORTING_TOPIC, "论语"]
    );
    expect(p1).toContain("只收单个字、词、成语");
    expect(p1).toContain("论语");
    expect(p1).toContain("accept_words");
    expect(p1).toContain("suggested_kp");

    const p2 = buildStage2Prompt(
      "论语",
      [{ title: "学而第一", kps: ["时习", "孝悌"] }],
      [{ id: "m2", kind: "weak_point", content: "应用题总错", detail: "", course_ref: "", count: 1 }],
      { m2: "应用题" }
    );
    expect(p2).toContain("逐字来自上面名单");
    expect(p2).toContain("时习");

    const p3 = buildQuestionPrompt([{ content: "研", detail: "yán" }]);
    expect(p3).toContain("stem 不要出现答案");
    expect(p3).toContain('"stem"');
  });
});
