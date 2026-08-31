/**
 * 从 chinese-xinhua 的 word.json + pinyin-pro 生成孩子查字典数据：
 * - chars.json：{ 字: [合并拼音, 清洗释义] }（charOverrides 优先覆盖核心常用字）
 * - words.json：{ 词: [拼音, 儿童释义] }（儿童高频词表，整词优先查询用）
 * - 读音：pinyin-pro multiple 全读音（比 word.json 全），与 word.json 并集
 * - 释义：charOverrides 儿童化释义 > word.json 清洗（优先「本义X」核心词；否则去训诂取首句；截短）
 * 输出：src/lib/dict/chars.json + words.json（UTF-8，无 BOM）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { charOverrides, words as wordOverrides } from "./overrides.mjs";

const require = createRequire(import.meta.url);
const { pinyin } = require("pinyin-pro");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const raw = JSON.parse(readFileSync(join(root, "scripts", "dict-build", "word.json"), "utf8"));

/** 提取核心释义（儿童友好优先） */
function cleanExplanation(exp) {
  if (!exp) return "";
  let s = String(exp)
    .replace(/--[^\n。；;]*/g, "")
    .replace(/《[^》]*》/g, "")
    .replace(/[“”"「」『』〈〉]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  const m = s.match(/本义([^，。；;、）)\s]{2,14})/);
  if (m) {
    const c = m[1].split(/[，,、]/)[0].trim();
    if (c.length >= 2) return c.slice(0, 14);
  }
  let noParen = s.replace(/\([^)]*\)/g, " ").replace(/[（][^）]*[）]/g, " ").replace(/\s+/g, " ").trim();
  noParen = noParen.replace(/^(同本义|又如|引申为|由本义引申为)\s*/, "");
  const sentences = noParen.split(/(?<=[。；;])/).map((t) => t.trim()).filter(Boolean);
  for (const t of sentences) {
    const clean = t.replace(/[〈〉]/g, "");
    if (clean && clean.length >= 2) return clean.slice(0, 60);
  }
  const fallback = noParen.replace(/[〈〉]/g, "");
  return fallback.slice(0, 30);
}

// 释义：同字多条记录取第一条有意义的
const explByChar = {};
for (const item of raw) {
  const ch = String(item.word || "").trim();
  if (!ch || ch.length !== 1) continue;
  if (explByChar[ch]) continue;
  const e = cleanExplanation(item.explanation);
  if (e) explByChar[ch] = e;
}

// 读音：pinyin-pro 全读音 + word.json 读音 并集
const pyByChar = {};
for (const item of raw) {
  const ch = String(item.word || "").trim();
  if (!ch || ch.length !== 1) continue;
  const py = String(item.pinyin || "").replace(/\s+/g, "").trim();
  if (!py) continue;
  (pyByChar[ch] ||= new Set()).add(py);
}
for (const ch of Object.keys(pyByChar)) {
  try {
    const all = pinyin(ch, { multiple: true, type: "array", toneType: "symbol" }) || [];
    for (const p of all) pyByChar[ch].add(p);
  } catch {
    /* ignore */
  }
}

const out = {};
for (const ch of Object.keys(pyByChar)) {
  // charOverrides 优先（读音+释义整体覆盖）
  if (charOverrides[ch]) {
    out[ch] = charOverrides[ch];
    continue;
  }
  const py = [...pyByChar[ch]].join(" ");
  const expl = explByChar[ch] || "";
  out[ch] = expl ? [py, expl] : [py];
}
// 补充 charOverrides 里有但 word.json 没有的字（极少，如语气词）
for (const ch of Object.keys(charOverrides)) {
  if (!out[ch]) out[ch] = charOverrides[ch];
}

const json = JSON.stringify(out);
writeFileSync(join(root, "src", "lib", "dict", "chars.json"), json, "utf8");

// words.json：儿童高频词表（整词优先查询）
const wordsJson = JSON.stringify(wordOverrides);
writeFileSync(join(root, "src", "lib", "dict", "words.json"), wordsJson, "utf8");

console.log("导出字数:", Object.keys(out).length, "（覆盖", Object.keys(charOverrides).length, "）");
console.log("导出词数:", Object.keys(wordOverrides).length);
console.log("体积: chars", (json.length / 1024 / 1024).toFixed(2), "MB / words", (wordsJson.length / 1024).toFixed(0), "KB");
for (const ch of ["月", "亮", "学", "海", "行", "长", "好", "都", "还", "一", "不", "乐", "重", "大", "和", "子", "日"]) {
  console.log(ch, JSON.stringify(out[ch]));
}
for (const w of ["月亮", "太阳", "学校", "开心", "飞机"]) {
  console.log("词", w, JSON.stringify(wordOverrides[w]));
}
