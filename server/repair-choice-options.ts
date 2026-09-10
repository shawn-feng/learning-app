/**
 * 存量修复（2026-09-10）：迁移自 rubric 的「指向性选择题」（题干含 下列/哪个/哪种/哪项 等，
 * 脱离选项无法标准作答）把源 rubric 里的 A-D 选项找回来写入 question_bank.options。
 * 顺带清理题干尾部的「（N 分）」分值残渣。
 * 幂等：题目已带选项（options 非空）则跳过。运行范围：lunyu 课程（家长库）。
 *
 * 用法：npx tsx repair-choice-options.ts
 */
import path from "node:path";
import { openParentLib } from "./src/db/parent-lib.js";
import { parseOptions } from "./src/db/assess-content.js";

const PARENT = "86a84278-c8ae-415e-8fbc-6140b1b7c88e";
const TOPIC = "lunyu";

/** 指向性选择题：脱离选项基本不可独立标准作答 */
const DEP_RE =
  /下列|以下|哪个|哪种|哪项|哪一|哪一种|哪句话|哪个字|哪一句|是否正确|正确(的)?是|错误的?(是)?|不属于|不是.{0,6}的(是)?|说法(正确|错误)|对应(的)?是|应该选择/;
const MC_HEADER_RE = /^\s*(\d+)\s*[.、]\s*【选择题】\s*(.+?)\s*$/;
const OPTION_RE = /^\s*[-–—]?\s*([A-Ha-h])\s*[.、．]\s*(.+?)\s*$/;

const norm = (s: string) => String(s).replace(/\s+/g, "");
const normCmp = (s: string) => norm(s).replace(/[，。！？、,.!?;；:："“”‘’'（）()]/g, "");

const db = openParentLib(path.resolve("data"), PARENT);

const courses = db
  .prepare("SELECT uuid, title, assess_rubric FROM courses WHERE topic = ? AND assess_rubric != ''")
  .all(TOPIC) as Array<{ uuid: string; title: string; assess_rubric: string }>;

let restored = 0;
let depTotal = 0;
let matched = 0;
let skippedNoOpt = 0;
const examples: string[] = [];

for (const c of courses) {
  // 本课已挂题目 stem → id
  const attached = db
    .prepare(
      `SELECT qb.id, qb.stem, qb.answer, qb.options FROM course_category_questions ccq
       JOIN question_bank qb ON qb.id = ccq.question_id
       WHERE ccq.course_id = ?`
    )
    .all(c.uuid) as Array<{ id: string; stem: string; answer: string; options: string }>;

  const lines = String(c.assess_rubric).split("\n");
  let header: { num: string; stem: string } | null = null;
  let pending: Array<{ key: string; text: string }> = [];

  const flushQuestion = () => {
    if (!header) return;
    if (DEP_RE.test(header.stem)) {
      depTotal++;
      if (pending.length >= 2) {
        const wantStem = normCmp(header.stem);
        const hit = attached.find((q) => normCmp(q.stem) === wantStem || normCmp(q.stem).replace(/（\d+\s*分）$/, "") === wantStem.replace(/（\d+\s*分）$/, ""));
        if (hit && parseOptions(hit.options).length === 0) {
          const opts = pending.map((o, i) => ({ key: o.key.toUpperCase(), text: o.text }));
          // 正确项 key：答案=某选项文本（迁移时已填选项文本）；找不到则留空（判分回退内容匹配）
          const ans = hit.answer || "";
          let correctKey = "";
          const normAns = normCmp(ans);
          for (const o of opts) {
            if (normAns && (normCmp(o.text) === normAns || (normAns.length >= 4 && normCmp(o.text).includes(normAns)))) {
              correctKey = o.key;
              break;
            }
          }
          // 题干分值残渣清理 + 存选项
          const cleanStem = String(hit.stem).replace(/（\d+\s*分）\s*$/, "");
          db.prepare("UPDATE question_bank SET stem = ?, options = ?, updated_at = datetime('now') WHERE id = ?").run(
            cleanStem,
            JSON.stringify(opts),
            hit.id
          );
          restored++;
          matched++;
          if (examples.length < 6) examples.push(`${cleanStem.slice(0, 36)}… → [${opts.map((o) => o.key).join("")}]${correctKey ? ` 正确=${correctKey}` : " 正确=?"}`);
        } else if (!hit) {
          skippedNoOpt++;
        }
      } else {
        skippedNoOpt++;
      }
    }
    header = null;
    pending = [];
  };

  for (const raw of lines) {
    const m = raw.match(MC_HEADER_RE);
    if (m) {
      flushQuestion();
      header = { num: m[1]!, stem: m[2]! };
      pending = [];
      continue;
    }
    if (header) {
      const om = raw.match(OPTION_RE);
      if (om) {
        pending.push({ key: om[1]!.toUpperCase(), text: om[2]! });
        continue;
      }
      // 下一类题目标题（非选项行）出现 → 结束当前题（选项必须紧跟在题干后）
      if (/^\s*\d+\s*[.、]\s*【(选择题|问答题|背诵)/.test(raw)) flushQuestion();
      else if (/^\s*[-*]\s*[A-Ha-h]\s*[.、．]/.test(raw)) {
        // 可能是选项前多一层的项目符号，尝试剥一层
        const m2 = raw.match(/^\s*[-*]\s*([A-Ha-h])\s*[.、．]\s*(.+?)\s*$/);
        if (m2) pending.push({ key: m2[1]!.toUpperCase(), text: m2[2]! });
      }
    }
  }
  flushQuestion();
}

console.log("指向性选择题:", depTotal, " 恢复选项:", restored, " 未匹配到题库题:", skippedNoOpt);
for (const e of examples) console.log(" ·", e);
db.close();
