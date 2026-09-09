/**
 * 存量 rubric(markdown) → 考核内容结构化 v2 迁移解析（ISSUE-067 步骤4）。
 *
 * 语料规整版式（489 章）：
 *   ## 一、考核知识点   （- 原文背诵：…“原文”… / - **原文背诵**：…）
 *   ## 二、题目
 *     ### 必考题 | ### 可选题 1 | …
 *       1. 【选择题】…（- A. …）/ 2. 【问答题】…（可多行）
 *     **评分标准：** 一、选择题答案：1.B … 第N题评分标准…维度表… 特殊情况… / 大模型输出…
 *
 * 策略（v1，留人工抽检空间）：
 * - 背诵：知识点「原文背诵」行引号内原文 → 背诵题（answer=原文，behavior 由类别决定）。
 * - 题目：迁移「必考题」+「可选题 1」；选择题 → 口述主观（去选项，答案=正确项文字，按要点判）；
 *   问答题保留题干；评分尽力解析「第N题评分标准」维度表+特殊情况，解析不到给兜底评分文本。
 * - 归类按题干关键词：背诵/字词(读音含义)/典故/道理(情境做法)/句意白话(意思翻译)。
 * - 每题 pointMax=10（与现行口述题口径一致）。
 */
import type { DatabaseSync } from "node:sqlite";
import { getOrCreateCategory, saveQuestion, getCourseUuid, replaceCourseContent } from "./db/assess-content.js";

const BEHAVIOR: Record<string, string> = { 背诵: "speech_recite", 朗读: "speech_read" };

export interface MigrateQuestion {
  stem: string;
  answer: string;
  scoring: string | null;
}
export interface MigrateItem {
  categoryName: string;
  questions: MigrateQuestion[];
}
export interface MigrateResult {
  ok: boolean;
  reason?: string;
  items: MigrateItem[];
  refTexts: number;
}

const REC_RE = /原文背诵[^“”"'\n]*?[：:][^\n]*?[“"]([^”"\n]+)[”"]/g;

export function classifyStem(stem: string): string {
  const s = stem;
  if (/背诵|背出|背一背|背原文/.test(s)) return "背诵";
  if (
    /读音|读作|拼音|字义|含义|释义|词义|正确的意思/.test(s) ||
    /“[^”]{1,8}”(?:[^，。]{0,10}?)(读音|读作|意思|含义|字义|拼音)/.test(s) ||
    // 引号内短词 + (中/里 + 字词句式) + 意思类，且不是整句翻译讲解
    (/“[^”]{1,8}”(?:[^。]{0,20}?)(?:意思|含义)/.test(s) && !/用自己的话|讲一讲|这句话|这段话|翻译|句子意思|用今天学到的/.test(s))
  )
    return "字词";
  if (/典故|苏轼|佛印|故事/.test(s)) return "典故";
  if (/道理|怎么做|做法|假如|如果你|被同学|误会|结合自己的生活|遇到|用.{0,8}的道理/.test(s)) return "道理";
  if (/意思|翻译|白话|讲一讲|说一说|用自己的话|分别是什么|怎么理解|哪一句/.test(s)) return "句意白话";
  return "句意白话";
}

interface Q {
  idx: number;
  kind: string;
  stem: string;
  options: Map<string, string>;
}
interface Group {
  qs: Q[];
  tail: string;
}

/** 题干续行/选项并入当前题。 */
function questionStart(line: string): { idx: number; kind: string; text: string } | null {
  const m = line.match(/^\s*(\d+)[.、]\s*【(选择题|问答题)】\s*(.*)$/);
  if (!m) return null;
  return { idx: Number(m[1]), kind: m[2], text: String(m[3] ?? "").trim() };
}

function dimsOf(d: string): { dim: string; points: string; score: number } | null {
  const m = d.match(/^- ([^（]+)（(\d+)分）[：:]\s*(.*)$/);
  if (!m) return null;
  return { dim: m[1]!.trim(), points: String(m[3] ?? "").trim(), score: Number(m[2]) };
}

function parseScoringBlock(block: string): { dims: Array<{ dim: string; points: string; score: number }>; special: string[] } {
  const dims: Array<{ dim: string; points: string; score: number }> = [];
  const special: string[] = [];
  let inTable = false;
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\|.*\|\s*$/.test(line)) {
      const cells = line.replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim());
      if (cells[0] === "评分维度") {
        inTable = true;
        continue;
      }
      if (inTable && cells.length >= 3 && cells[0]) {
        const score = (cells[2] || "").match(/\d+/)?.[0] ?? "";
        dims.push({
          dim: cells[0]!,
          points: `${cells[1] ?? ""}${cells[3] ? `（${cells[3]}）` : ""}`,
          score: Number(score) || 0,
        });
      }
      continue;
    }
    if (/^[-*]\s+/.test(line)) special.push(line.replace(/^[-*]\s+/, ""));
  }
  return { dims, special };
}

export function parseCourseRubric(md: string): MigrateResult {
  const items: MigrateItem[] = [];
  const push = (cat: string, q: MigrateQuestion) => {
    let it = items.find((x) => x.categoryName === cat);
    if (!it) {
      it = { categoryName: cat, questions: [] };
      items.push(it);
    }
    it.questions.push(q);
  };

  // 0) 背诵原文
  const refTexts: string[] = [];
  const re = new RegExp(REC_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const t = String(m[1]).replace(/[“”"']/g, "").trim();
    if (t && !refTexts.includes(t)) refTexts.push(t);
  }
  for (const ref of refTexts) push("背诵", { stem: "背诵本章原文", answer: ref, scoring: null });

  if (!/^##\s*二、题目/m.test(md)) {
    return { ok: refTexts.length > 0, reason: refTexts.length ? undefined : "无背诵也无「二、题目」段落", items, refTexts: refTexts.length };
  }

  // 1) 分组：必考题 与 可选题 1（其余套略过，避免池内混入异构选择题）
  const lines = md.split(/\r?\n/);
  const groups: Group[] = [];
  let cur: Group | null = null;
  let tailing = false;
  for (const line of lines) {
    const h = line.trim();
    const gh = h.match(/^###\s*(必考题|可选题(?:\s*1)?)\s*$/);
    if (gh) {
      cur = { qs: [], tail: "" };
      groups.push(cur);
      tailing = false;
      continue;
    }
    if (!cur) continue;
    if (/评分标准|特殊情况|大模型输出|第\d+题评分标准/.test(h)) tailing = true;
    if (tailing) {
      cur.tail += line + "\n";
      continue;
    }
    const qs = questionStart(line);
    if (qs) {
      cur.qs.push({ idx: qs.idx, kind: qs.kind, stem: qs.text, options: new Map() });
      continue;
    }
    const lastQ = cur.qs[cur.qs.length - 1];
    if (!lastQ) continue;
    const opt = line.match(/^\s*-\s*([A-H])\.\s*(.+)$/);
    if (opt && lastQ.kind === "选择题") {
      lastQ.options.set(opt[1]!, String(opt[2] ?? "").trim());
    } else if (line.trim() && lastQ.stem) {
      lastQ.stem += " " + line.trim();
    }
  }

  // 2) 组装
  for (const g of groups) {
    const tail = g.tail;
    const ansMap = new Map<number, string>();
    // 答案标签有多种写法：`一、选择题答案：1.B 2.B…` / `**一、选择题答案**`(编号分行) / `选择题标准答案`
    const tailLines = tail.split(/\r?\n/);
    const ansStart = tailLines.findIndex((l) => /选择题(标准)?答案/.test(l));
    if (ansStart >= 0) {
      const seg: string[] = [];
      for (let li = ansStart; li < tailLines.length; li++) {
        if (li > ansStart && /问答题评分标准/.test(tailLines[li]!)) break;
        seg.push(tailLines[li]!);
      }
      const segText = seg.join("\n");
      const tokenRe = /(\d+)\s*[.、]\s*(?:答案\s*[:：]?\s*)?([A-H])\b/g;
      let tm: RegExpExecArray | null;
      while ((tm = tokenRe.exec(segText)) !== null) ansMap.set(Number(tm[1]), tm[2]!);
      // 兜底：`1. 答案 B` / `（1）B`
      if (!ansMap.size) {
        const re2 = /\(?(\d+)\)?\s*[.、:]?\s*答案[:：]?\s*([A-H])\b/g;
        let mm: RegExpExecArray | null;
        while ((mm = re2.exec(segText)) !== null) ansMap.set(Number(mm[1]), mm[2]!);
      }
    }
    // 问答题 → 该组内第 N 道问答题；评分块「第N题评分标准」按此索引
    const openPositions: number[] = [];
    g.qs.forEach((q, i) => {
      if (q.kind === "问答题") openPositions.push(i);
    });
    const openIndex = new Map<number, number>();
    openPositions.forEach((qpos, k) => openIndex.set(qpos, k + 1));
    const blockRe = /第(\d+)题评分标准[^\n]*\n([\s\S]*?)(?=\n(?:第\d+题评分标准|特殊情况|大模型|###|\s*$))/g;
    const blocks = new Map<number, string>();
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(tail)) !== null) blocks.set(Number(bm[1]), bm[2] ?? "");

    for (const q of g.qs) {
      const stem = q.stem.replace(/\s+/g, " ").trim();
      if (!stem) continue;
      const cat = classifyStem(stem);
      if (q.kind === "选择题") {
        const letter = ansMap.get(q.idx) ?? "";
        const answer = letter ? q.options.get(letter) ?? "" : "";
        push(cat, {
          stem,
          answer,
          scoring: JSON.stringify({
            dims: [{ dim: "要点完整", points: `说出正确答案要点（${letter ? "答案：" + answer : "题干要点"}）`, score: 10, note: "口述改自选择题" }],
            special: ["（存量迁移，按要点判）"],
          }),
        });
      } else {
        const n = openIndex.get(g.qs.indexOf(q));
        const block = n != null ? blocks.get(n) : undefined;
        const { dims, special } = block ? parseScoringBlock(block) : { dims: [], special: [] };
        const dimsOut = dims.length
          ? dims
          : [{ dim: "内容完整", points: "答到题干要求要点（存量迁移未解析出维度表）", score: 10 }];
        push(cat, { stem, answer: "", scoring: JSON.stringify({ dims: dimsOut, special }) });
      }
    }
  }
  return { ok: items.length > 0, reason: items.length ? undefined : "未解析出题目", items, refTexts: refTexts.length };
}

export function migrateTopicRubrics(
  db: DatabaseSync,
  topic: string,
  courseFilter?: string
): { done: number; skipped: number; questionTotal: number; skipReasons: Array<{ title: string; reason: string }> } {
  const rows = db
    .prepare(
      `SELECT c.title AS title, c.assess_rubric AS md FROM courses c
       WHERE c.topic = ? AND c.assess_rubric != ''
       AND NOT EXISTS (SELECT 1 FROM course_category_questions ccq JOIN courses c2 ON c2.uuid = ccq.course_id
                       WHERE c2.topic = c.topic AND c2.title = c.title)`
    )
    .all(topic) as Array<{ title: string; md: string }>;
  const skipReasons: Array<{ title: string; reason: string }> = [];
  let done = 0;
  let skipped = 0;
  let questionTotal = 0;
  for (const row of rows) {
    if (courseFilter && row.title !== courseFilter) continue;
    const res = parseCourseRubric(row.md);
    if (!res.ok || !res.items.length) {
      skipped++;
      skipReasons.push({ title: row.title, reason: res.reason || "无题目" });
      continue;
    }
    const uuid = getCourseUuid(db, topic, row.title);
    if (!uuid) {
      skipped++;
      continue;
    }
    const items = res.items.map((it) => {
      const cat = getOrCreateCategory(db, topic, it.categoryName, BEHAVIOR[it.categoryName] ?? "generic");
      const qids = it.questions.map((q) => saveQuestion(db, { stem: q.stem, answer: q.answer, scoring: q.scoring, pointMax: 10 }));
      return { categoryId: cat.id, overview: "（存量 rubric 迁移生成，建议家长抽查完善）", questionIds: qids };
    });
    replaceCourseContent(db, uuid, items);
    questionTotal += items.reduce((s, x) => s + x.questionIds.length, 0);
    done++;
  }
  return { done, skipped, questionTotal, skipReasons };
}
