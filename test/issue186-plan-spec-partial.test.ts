/**
 * ISSUE-186 F4 回归（2026-10-16）：`methodSpec.require` 点名的知识点**存在但没挂题** → 必须记缺失，
 * 不许"创建成功但没考"。
 *
 * 旧行为（bug）：`withQ = 有题的知识点` 之后再按 require 过滤 → 没题的被静默跳过；只要同课还有
 * 别的必需知识点有题，函数就正常返回，家长要考的那个字**根本没考**（现场「验」「迫」正是如此）。
 *
 * 非假绿：把 `!withQIds.has(kp.id)` 那段去掉，本文件第 2/4 条即红。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openParentLib } from "../server/src/db/parent-lib";
import {
  getCourseUuid,
  getOrCreateKnowledgePoint,
  linkQuestionToKnowledgePoint,
  saveQuestion,
} from "../server/src/db/assess-content";
import { buildPlanSpecEntries } from "../server/src/assess-selection";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue186-f4-"));
const parentId = "parent-186f4";
const T = "lunyu";
const C = "学而第一";
const CHILD = "child-186f4";

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
  db.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, 1)").run(T, C);
});
const kp = withDb((db) => {
  const uuid = getCourseUuid(db, T, C)!;
  const withQ = getOrCreateKnowledgePoint(db, uuid, "背诵", "背诵原文");
  const noQ = getOrCreateKnowledgePoint(db, uuid, "验", "「验」的释义"); // 在现场：没题、考不了
  const qid = saveQuestion(db, { stem: "背诵本章原文", answer: "学而时习之", behavior: "speech_recite" });
  linkQuestionToKnowledgePoint(db, { questionId: qid, courseId: uuid, knowledgePointId: withQ.id });
  return { withQ, noQ };
});

const COURSE_LIKE = [{ title: C, topic: T }];

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL */
  }
});

describe("ISSUE-186 F4 · require 没题的知识点必须拒绝", () => {
  it("只点名「有题」的知识点 → 正常展开（行为不变）", () => {
    const r = withDb((db) => buildPlanSpecEntries(db, CHILD, COURSE_LIKE, { require: { 背诵: 1 } }));
    expect(r.missing).toEqual([]);
    expect(r.entries).toEqual([{ title: C, kps: [{ name: "背诵", count: 1 }] }]);
  });

  it("点名一个「存在但没挂题」的知识点 → 记缺失、不给 entries（不再静默少考）", () => {
    const r = withDb((db) => buildPlanSpecEntries(db, CHILD, COURSE_LIKE, { require: { 验: 1 } }));
    expect(r.entries).toEqual([]);
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]!.reason).toContain("还没有挂题");
    expect(r.missing[0]!.reason).toContain("验");
  });

  it("有题 + 没题混合点名 → 整体拒绝（不能把没题的那个悄悄漏掉）", () => {
    const r = withDb((db) => buildPlanSpecEntries(db, CHILD, COURSE_LIKE, { require: { 背诵: 1, 验: 2 } }));
    expect(r.entries).toEqual([]);
    expect(r.missing.map((m) => m.reason).join(" ")).toContain("验");
  });

  it("按 uuid 点名没题的知识点同样拒绝", () => {
    const r = withDb((db) => buildPlanSpecEntries(db, CHILD, COURSE_LIKE, { require: { [kp.noQ.id]: 1 } }));
    expect(r.entries).toEqual([]);
    expect(r.missing[0]!.reason).toContain("还没有挂题");
  });

  it("不传 methodSpec（整课默认展开）不受影响：有题的点照常考", () => {
    const r = withDb((db) => buildPlanSpecEntries(db, CHILD, COURSE_LIKE, null));
    expect(r.missing).toEqual([]);
    expect(r.entries).toEqual([{ title: C, kps: [{ name: "背诵", count: 1 }] }]);
  });
});
