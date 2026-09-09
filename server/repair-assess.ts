/**
 * 迁移后修复脚本（步骤4 抽查完善）：
 *  A. 确定性补空答案：重解析每课 rubric（修正后的答案标签解析）→ 把空 answer 的选择题按题干匹配回填。
 *  B. 归类纠正：按改进后的 classifyStem 重算每题类别，与现状不一致的移动关系行到正确类别。
 *  C.（可选 --llm）LLM 辅助补 2 篇跳过课程（颜渊篇第十章 / 宪问篇第十二章）。
 * 用法：npx tsx repair-assess.ts [--llm] [--course 课程名]
 */
import fs from "node:fs";
import path from "node:path";
import { openParentLib } from "./src/db/parent-lib.js";
import { parseCourseRubric, classifyStem } from "./src/assess-migrate.js";
import { listCategories, getOrCreateCategory, getCourseUuid, replaceCourseContent, saveQuestion } from "./src/db/assess-content.js";

const PARENT = "86a84278-c8ae-415e-8fbc-6140b1b7c88e";
const TOPIC = "lunyu";
const withLLM = process.argv.includes("--llm");
const courseOnly = (() => {
  const i = process.argv.indexOf("--course");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

const db = openParentLib(path.resolve("data"), PARENT);
const uuidOf = (title: string) => getCourseUuid(db, TOPIC, title);

/** 宽松解析 LLM 输出 JSON（容忍 ```json 围栏 / 前后说明文字）。 */
function looseJson(text: string): any | null {
  const t = String(text || "")
    .replace(/```[a-z]*/gi, "")
    .trim();
  const candidates = [t.match(/\{[\s\S]*\}/)?.[0], t.match(/\[[\s\S]*\]/)?.[0]].filter(Boolean) as string[];
  for (const cand of candidates) {
    try {
      return JSON.parse(cand);
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

// ===== A. 按 rubric 重解析回填空答案 =====
let filled = 0;
const courseRows = db
  .prepare(`SELECT c.title AS title, c.assess_rubric AS md FROM courses c
            WHERE c.topic=? AND c.assess_rubric!=''
            AND EXISTS (SELECT 1 FROM course_category_questions ccq JOIN courses c2 ON c2.uuid=ccq.course_id WHERE c2.topic=c.topic AND c2.title=c.title)`)
  .all(TOPIC) as Array<{ title: string; md: string }>;
const updAnswer = db.prepare("UPDATE question_bank SET answer=? WHERE id=? AND answer=''");
const selStem = db.prepare(
  `SELECT qb.id AS id, qb.stem AS stem FROM course_category_questions ccq
   JOIN question_bank qb ON qb.id=ccq.question_id WHERE ccq.course_id=?`
);
for (const row of courseRows) {
  if (courseOnly && row.title !== courseOnly) continue;
  const parsed = parseCourseRubric(row.md);
  if (!parsed.ok) continue;
  const ansByStem = new Map<string, string>();
  for (const it of parsed.items) for (const q of it.questions) if (q.answer) ansByStem.set(q.stem.replace(/\s+/g, " "), q.answer);
  const uuid = uuidOf(row.title);
  if (!uuid) continue;
  for (const r of selStem.all(uuid) as Array<{ id: string; stem: string }>) {
    const want = ansByStem.get(r.stem.replace(/\s+/g, " "));
    if (want) {
      const res = updAnswer.run(want, r.id);
      filled += Number(res.changes) || 0;
    }
  }
}
console.log("A 回填空答案:", filled);

// ===== B. 归类纠正 =====
const cats = listCategories(db, TOPIC);
const catByName = new Map(cats.map((c) => [c.name, c.id]));
const rels = db
  .prepare(`SELECT ccq.course_id AS cid, ccq.question_id AS qid, tc.name AS cname, qb.stem AS stem
            FROM course_category_questions ccq JOIN topic_categories tc ON tc.id=ccq.category_id
            JOIN question_bank qb ON qb.id=ccq.question_id WHERE tc.topic_id=?`)
  .all(TOPIC) as Array<{ cid: string; qid: string; cname: string; stem: string }>;
const updCat = db.prepare("UPDATE course_category_questions SET category_id=? WHERE course_id=? AND question_id=?");
let moved = 0;
for (const r of rels) {
  if (courseOnly) {
    const t = db.prepare("SELECT title FROM courses WHERE uuid=?").get(r.cid) as { title?: string } | undefined;
    if (t?.title !== courseOnly) continue;
  }
  const expect = classifyStem(r.stem);
  if (expect === r.cname) continue;
  const cid = catByName.get(expect);
  if (!cid) continue;
  updCat.run(cid, r.cid, r.qid);
  moved++;
}
console.log("B 移动归类到", moved);

// ===== C. LLM 辅助跳过课程（若 --llm）=====
if (withLLM) {
  await (async () => {
    const noRel = db
      .prepare(
        `SELECT c.title AS title, c.assess_rubric AS md FROM courses c
         WHERE c.topic=? AND c.assess_rubric!='' AND NOT EXISTS (
           SELECT 1 FROM course_category_questions ccq JOIN courses c2 ON c2.uuid=ccq.course_id
           WHERE c2.topic=c.topic AND c2.title=c.title)`
      )
      .all(TOPIC) as Array<{ title: string; md: string }>;
    const skips = noRel.filter((r) => parseCourseRubric(r.md).items.length === 0).map((r) => r.title);
    const target = courseOnly ? [courseOnly] : skips;
    const auth = JSON.parse(
      fs.readFileSync(path.resolve("..", "data", "parents", PARENT, "auth.json"), "utf-8")
    ) as { mimo?: { key?: string } };
    const key = auth?.mimo?.key;
    if (!key) {
      console.log("C 无 mimo key，跳过");
      return;
    }
    for (const title of target) {
      const row = db.prepare("SELECT assess_rubric AS md FROM courses WHERE topic=? AND title=?").get(TOPIC, title) as
        | { md: string }
        | undefined;
      if (!row) continue;
      const sys = "你是儿童学习考核内容整理助手。把一份课程的考核内容整理为 JSON，输出：{\"items\":[{\"categoryName\":\"背诵|句意白话|道理|字词|典故\",\"questions\":[{\"stem\":\"口述题干(不要选择题选项)\",\"answer\":\"参考答案/背诵题给原文\",\"scoring\":\"评分标准文字说明\"}]}]}。背诵类 stem='背诵本章原文'，answer=原文。文字题每题给参考答案与评分维度。只输出 JSON。";
      const resp = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "mimo-v2.5",
          messages: [
            { role: "system", content: sys },
            { role: "user", content: row.md.slice(0, 9000) },
          ],
          max_tokens: 8000,
        }),
      });
      const js: any = await resp.json();
      const text = String(js?.choices?.[0]?.message?.content ?? "");
      const m = text.match(/\{[\s\S]*\}/);
      const payload = m ? looseJson(m[0]) : null;
      if (!payload || !Array.isArray(payload.items)) {
        console.log(`C ✗ ${title}：LLM 返回不可解析（${text.slice(0, 80)}）`);
        continue;
      }
      const uuid = uuidOf(title) ?? (() => { throw new Error("无课程 uuid"); })();
      const items = (payload.items as Array<any>).map((it: any) => {
        const cat = getOrCreateCategory(db, TOPIC, String(it.categoryName), it.categoryName === "背诵" ? "speech_recite" : "generic");
        const qids = (it.questions || []).map((q: any) =>
          saveQuestion(db, {
            stem: String(q.stem),
            answer: String(q.answer || ""),
            scoring: String(q.scoring || "") || null,
            pointMax: 10,
            behavior: cat.behavior,
          })
        );
        return { categoryId: cat.id, overview: "（LLM 辅助补录，建议人工核对）", questionIds: qids };
      });
      replaceCourseContent(db, uuid, items);
      console.log(`C ✓ ${title}：${items.reduce((s, x) => s + x.questionIds.length, 0)} 题`);
    }
    // 剩余空答案选择题 → LLM 按题干作答（小批量）
    const empties = db
      .prepare(`SELECT id, stem FROM question_bank WHERE answer='' AND scoring LIKE '%口述改自选择题%' LIMIT 60`)
      .all() as Array<{ id: string; stem: string }>;
    if (empties.length) {
      const upd = db.prepare("UPDATE question_bank SET answer=? WHERE id=?");
      for (let i = 0; i < empties.length; i += 12) {
        const chunk = empties.slice(i, i + 12);
        const resp = await fetch("https://api.xiaomimimo.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: "mimo-v2.5",
            messages: [
              {
                role: "system",
                content:
                  "你是儿童题库助手。为下面每道口述题（源自原选择题）给出简明正确答案要点。只输出 JSON 数组：[{\"id\":\"<id>\",\"answer\":\"<答案>\"}]",
              },
              { role: "user", content: chunk.map((x) => `id=${x.id} 题目：${x.stem}`).join("\n") },
            ],
            max_tokens: 3000,
          }),
        });
        const js: any = await resp.json();
        const text = String(js?.choices?.[0]?.message?.content ?? "");
        const m = text.match(/\[[\s\S]*\]/);
        if (m) {
          const arr = (looseJson(m ? m[0] : '') ?? []) as Array<{ id: string; answer: string }>;
          for (const it of arr) if (it?.id && it?.answer) upd.run(it.answer.trim(), it.id);
        }
      }
      console.log(`C 空答案选择题 LLM 补写尝试：${empties.length} 条`);
    }
  })();
}

db.close();
console.log("修复完成。残留空答案MC可在家长端/agent 抽查。");
