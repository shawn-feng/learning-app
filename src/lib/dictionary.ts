/**
 * ISSUE-017 本地离线字典查询模块（孩子界面查字词用）。
 *
 * 数据源（构建时由 scripts/dict-build/build-chars.mjs 生成）：
 * - chars.json：{ 字: [拼音(多音空格分隔), 释义?] }，14809 字，含 425 核心字儿童化释义覆盖
 * - words.json：{ 词: [拼音, 儿童释义] }，713 条儿童高频词（整词优先匹配用）
 *
 * 查询策略（lookupText）：整词优先 → 贪心最长词拆分 → 逐字兜底。
 * 例：「月亮」→ 词表命中 1 条；「太阳光」→ 拆「太阳」+「光」；「山川湖海」→ 逐字 4 条。
 *
 * 纯函数、无 I/O；数据随渲染层 bundle 内联（约 0.7MB，gzip 后大幅压缩）。
 */
import charsRaw from "./dict/chars.json";
import wordsRaw from "./dict/words.json";

export interface LookupEntry {
  /** 字或词 */
  text: string;
  /** 拼音（多音用空格分隔，常用音在前） */
  pinyin: string;
  /** 释义（可能为空） */
  meaning: string;
}

// JSON import 的推断类型是宽字面量，这里显式归一为使用形态
const chars = charsRaw as unknown as Record<string, [string, string?]>;
const words = wordsRaw as unknown as Record<string, [string, string]>;

// 词表按首字分桶、桶内按词长降序 → 贪心最长匹配 O(文本长度×桶大小)
const wordIndex = new Map<string, string[]>();
for (const w of Object.keys(words)) {
  const first = w.charAt(0);
  const list = wordIndex.get(first);
  if (list) list.push(w);
  else wordIndex.set(first, [w]);
}
for (const list of wordIndex.values()) {
  list.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** 最长可匹配词长度上限（成语/三字词以上走贪心拆分，避免整段误查） */
const MAX_WORD_LEN = 4;
const CN_RE = /[\u4e00-\u9fa5]/;

/**
 * 查询一段选中文本：整词优先 → 贪心最长词拆分 → 逐字兜底。
 * 非中文字符（英文/数字/符号）跳过不查；查不到的冷僻字返回空拼音/释义（浮层可提示）。
 */
export function lookupText(text: string): LookupEntry[] {
  const t = (text || "").trim().replace(/\s+/g, "");
  if (!t) return [];
  const out: LookupEntry[] = [];
  let i = 0;
  while (i < t.length) {
    const ch = t.charAt(i);
    if (!CN_RE.test(ch)) {
      i++; // 非中文，跳过
      continue;
    }
    // 1) 词表贪心最长匹配（整词命中最优先）
    const list = wordIndex.get(ch);
    let matched: string | null = null;
    if (list) {
      for (const w of list) {
        if (w.length <= MAX_WORD_LEN && i + w.length <= t.length && t.startsWith(w, i)) {
          matched = w;
          break;
        }
      }
    }
    if (matched) {
      const [py, meaning] = words[matched] || ["", ""];
      out.push({ text: matched, pinyin: py || "", meaning: meaning || "" });
      i += matched.length;
      continue;
    }
    // 2) 单字兜底
    const entry = chars[ch];
    if (entry) {
      out.push({ text: ch, pinyin: entry[0] || "", meaning: entry[1] || "" });
    } else {
      out.push({ text: ch, pinyin: "", meaning: "" });
    }
    i++;
  }
  return out;
}
