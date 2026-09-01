/**
 * 合并 lunyu_exam 数据：每章「考核知识点.md + 考核内容.json」→ 一份 markdown。
 * - md = 考核知识点（该章要考核的要点）
 * - json = 可选题（3 套）+ 必考题（1 套），每题含 类别(选择/问答)/题干/选项/分数，每套带「标准答案及LLM评分标准」
 * - 选择题素材保留（语音考核时当口述题用：孩子听到题干+选项后口述作答）
 * 输出：lunyu_exam/merged/<章节名>.md，整篇作为该课 assess_rubric 导入家长库。
 *
 * 用法：node scripts/merge-lunyu-exam.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "lunyu_exam");
const OUT = path.join(SRC, "merged");
fs.mkdirSync(OUT, { recursive: true });

/** 章节名：从「论语XX篇第X章考核知识点.md」提取「论语XX篇第X章」 */
function chapterName(mdFile) {
  return mdFile.replace(/考核知识点\.md$/, "");
}

// ==================== 容错 JSON 解析（这批数据是 LLM 原始输出，质量参差） ====================

/** 剥 markdown 围栏 / LLM 前缀，截取第一个 { 到最后一个 } */
function extractJsonText(s) {
  let t = String(s ?? "").trim();
  if (!t) return null;
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("{");
  if (start < 0) return null;
  const end = t.lastIndexOf("}");
  if (end <= start) return null;
  return t.slice(start, end + 1);
}

/**
 * 修复非法 JSON 字符串字面量：字符串内未转义英文引号 → 中文引号（“ ”交替），
 * 裸换行/制表符（控制字符）→ 空格。逐字符状态机，只改字符串内容、不动结构分隔符。
 */
function sanitizeJsonText(t) {
  let out = "";
  let inStr = false;
  let quoteToggle = 0; // 内容引号配对：0→“ 1→”
  let i = 0;
  const n = t.length;
  const nextNonWs = (k) => {
    let j = i + k;
    while (j < n && /\s/.test(t[j])) j++;
    return t[j];
  };
  while (i < n) {
    const ch = t[i];
    if (inStr && ch === "\\") {
      out += ch + (t[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === '"') {
      if (!inStr) {
        inStr = true;
        out += ch;
        i++;
        continue;
      }
      const nx = nextNonWs(1);
      if (nx === "," || nx === "}" || nx === "]" || nx === ":") {
        inStr = false; // 字符串结束分隔符
        out += ch;
      } else {
        out += quoteToggle === 0 ? "“" : "”"; // 内容引号 → 中文引号
        quoteToggle = 1 - quoteToggle;
      }
      i++;
      continue;
    }
    if (inStr && (ch === "\n" || ch === "\r" || ch === "\t")) {
      out += " "; // 裸控制字符 → 空格
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 尝试解析 json；失败依次尝试：raw.txt → 返回 null */
function loadJson(name) {
  const jsonPath = path.join(SRC, `${name}考核内容.json`);
  const rawPath = path.join(SRC, `${name}考核内容_raw.txt`);
  const candidates = [];
  if (fs.existsSync(jsonPath)) candidates.push(fs.readFileSync(jsonPath, "utf-8"));
  if (fs.existsSync(rawPath)) candidates.push(fs.readFileSync(rawPath, "utf-8"));
  for (const text of candidates) {
    const body = extractJsonText(text);
    if (body == null) continue;
    try {
      return JSON.parse(body);
    } catch {
      try {
        return JSON.parse(sanitizeJsonText(body));
      } catch {
        /* 继续下一个候选 */
      }
    }
  }
  return null;
}

/** 格式化一道题（含选项）为 markdown 行 */
function fmtQuestion(q, i) {
  const cat = String(q["题目类别"] ?? "");
  const stem = String(q["题目"] ?? "").trim();
  const score = q["题目分数"] != null ? `（${q["题目分数"]} 分）` : "";
  const opts = Array.isArray(q["选项"]) && q["选项"].length
    ? "\n" + q["选项"].map((o) => `   - ${String(o).trim()}`).join("\n")
    : "";
  return `${i + 1}. 【${cat || "题"}】${stem}${score}${opts}`;
}

/** 合并 json 的「可选题」数组（3 套） */
function fmtChoose(choose) {
  if (!Array.isArray(choose) || !choose.length) return "（无）";
  return choose
    .map((set, si) => {
      const questions = (set?.["考题"] ?? []).map((q, qi) => fmtQuestion(q, qi)).join("\n");
      const std = String(set?.["标准答案及LLM评分标准"] ?? "").trim();
      return `### 可选题 ${si + 1}\n${questions}\n\n**评分标准：**\n${std}`;
    })
    .join("\n\n");
}

/** 合并 json 的「必考题」对象 */
function fmtRequired(required) {
  if (!required || typeof required !== "object") return "（无）";
  const questions = (required["考题"] ?? []).map((q, qi) => fmtQuestion(q, qi)).join("\n");
  const std = String(required["标准答案及LLM评分标准"] ?? "").trim();
  return `${questions}\n\n**评分标准：**\n${std}`;
}

let ok = 0;
let skipped = 0;
const mdFiles = fs.readdirSync(SRC).filter((f) => f.endsWith("考核知识点.md")).sort();
for (const mdFile of mdFiles) {
  const name = chapterName(mdFile);
  const jsonFile = `${name}考核内容.json`;
  const mdPath = path.join(SRC, mdFile);
  const jsonPath = path.join(SRC, jsonFile);
  if (!fs.existsSync(jsonPath)) {
    console.warn(`⚠️ 跳过（缺 json）：${mdFile}`);
    skipped++;
    continue;
  }
  let json;
  try {
    json = loadJson(name);
    if (!json) throw new Error("容错解析失败");
  } catch {
    console.warn(`⚠️ 降级（json 无法解析）：${mdFile}`);
    // 只用 md 生成文档，题目部分标注缺失
    const md = fs.readFileSync(mdPath, "utf-8").trim();
    const doc =
      `# ${name} · 考核内容（知识点 + 题目 + 评分标准）\n\n` +
      `## 一、考核知识点\n${md}\n\n` +
      `## 二、题目\n\n（考核内容 json 无法解析，仅导入知识点作为考核要点）\n`;
    fs.writeFileSync(path.join(OUT, `${name}.md`), doc, "utf-8");
    skipped++;
    continue;
  }
  const md = fs.readFileSync(mdPath, "utf-8").trim();
  const mdBody = md.replace(/^-+|\n/g, (m) => (m === "\n" ? "\n" : "")); // 保留列表原文（不去首行 -）
  const doc =
    `# ${name} · 考核内容（知识点 + 题目 + 评分标准）\n\n` +
    `## 一、考核知识点\n${md}\n\n` +
    `## 二、题目\n\n` +
    `### 可选题（共 ${json["可选题"]?.length ?? 0} 套，考试时从中抽题）\n${fmtChoose(json["可选题"])}\n\n` +
    `### 必考题\n${fmtRequired(json["必考题"])}\n`;
  fs.writeFileSync(path.join(OUT, `${name}.md`), doc, "utf-8");
  ok++;
}
console.log(`✅ 合并完成：${ok} 章写入 ${OUT}，跳过 ${skipped} 章`);
