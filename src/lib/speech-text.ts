// 发音评测「逐字着色」的纯逻辑（无 React），供 SpeechText 组件与单元测试共用。
//
// 输入是原文 refText + 评测返回的 words（服务端已把 SSECP 的 details/snt_details 摊平成字/词序列），
// 输出是逐个 token（汉字/单词/标点/空白）的着色结论：
//   漏读 dp_type=1 → 灰+删除线；重读 dp_type=2 → 橙色波浪；注释字 dp_type=3 → 灰；
//   其余按 score 分档（<60 红 / 60-79 橙 / ≥80 绿）；score 高但 tonescore 低 → 标"声调待加强"。

export interface SpeechWordLike {
  word: string;
  score: number;
  dpType?: number;
  tone?: number;
  toneScore?: number;
  isPause?: boolean;
  startMs?: number;
  endMs?: number;
}

export type SpeechTone = "ok" | "mid" | "bad" | "tone" | "missing" | "repeat" | "note" | "plain";

/** dp_type/MatchTag 的语义按 provider 略有差异（详见 classifySpeechWord） */
export type SpeechProvider = "tencent-soe" | "aliyun-ssecp";

export interface SpeechToken {
  /** 原文里的这一段（一个字 / 一个单词 / 一个标点 / 一段空白） */
  text: string;
  /** 对齐到的评测项（标点/空白没有） */
  word?: SpeechWordLike;
  tone: SpeechTone;
  /** 有音频起止时间，可点读回放 */
  playable: boolean;
  /** hover 提示文案 */
  title: string;
}

export const SPEECH_TONE_LABEL: Record<SpeechTone, string> = {
  ok: "读对",
  mid: "待加强",
  bad: "读错",
  tone: "声调待加强",
  missing: "漏读",
  repeat: "重读",
  note: "不评分",
  plain: "",
};

/** 报告页图例（只列需要解释的状态） */
export const SPEECH_LEGEND: { tone: SpeechTone; label: string }[] = [
  { tone: "ok", label: "读对" },
  { tone: "mid", label: "待加强" },
  { tone: "bad", label: "读错" },
  { tone: "tone", label: "声调" },
  { tone: "missing", label: "漏读" },
  { tone: "repeat", label: "重读" },
];

export const SPEECH_TONE_STYLE: Record<SpeechTone, import("react").CSSProperties> = {
  ok: { color: "#58a700" },
  mid: { color: "#c57a12" },
  bad: { color: "#d64545", textDecoration: "underline", textDecorationStyle: "wavy", textDecorationColor: "#e8a0a0" },
  tone: { color: "#b8860b", textDecoration: "underline", textDecorationStyle: "dotted" },
  missing: { color: "#9aa3ad", textDecoration: "line-through", background: "#f3f4f6", borderRadius: 3 },
  repeat: { color: "#c05621", textDecoration: "underline", textDecorationStyle: "wavy" },
  note: { color: "#a0a6ae" },
  plain: {},
};

// 汉字（基本区 + 兼容区）、拉丁字母（含常见扩展）、数字；标点/空白单独成 token。
const WORD_CHAR_RE = /[0-9A-Za-z\u00C0-\u024F\u3400-\u9FFF\uF900-\uFAFF]/;
const TOKEN_RE =
  /[\u3400-\u9FFF\uF900-\uFAFF]|[0-9A-Za-z\u00C0-\u024F][0-9A-Za-z\u00C0-\u024F'’_-]*|\s+|[^\s]/g;
const NON_WORD_RE = /[^0-9A-Za-z\u00C0-\u024F\u3400-\u9FFF\uF900-\uFAFF]/g;

/** 去掉标点/空白，只留字词本体（用于判断"这个词是不是空的"）。 */
export function stripToWordChars(s: string): string {
  return String(s ?? "").replace(NON_WORD_RE, "");
}

/** 把原文切成 token：中文逐字、英文逐词、标点与空白各自成段。 */
export function tokenizeRefText(refText: string): string[] {
  return String(refText ?? "").match(TOKEN_RE) ?? [];
}

/** 该 token 是否算一个"要评分的字/词"（标点和空白不算）。 */
export function isWordToken(token: string): boolean {
  return WORD_CHAR_RE.test(token);
}

/** 单个字/词 → 颜色档位。 */
export function classifySpeechWord(w?: SpeechWordLike, provider?: SpeechProvider): SpeechTone {
  if (!w) return "plain";
  if (w.dpType === 1) return "missing";
  if (w.dpType === 2) return "repeat";
  // 声希 3 = 注释字（不参与评分）；智聆 3 = 错读（正常评分里的"读错"）
  if (w.dpType === 3) return provider === "tencent-soe" ? "bad" : "note";
  const score = Number(w.score);
  if (!Number.isFinite(score)) return "plain";
  if (score < 60) return "bad";
  if (score < 80) return "mid";
  if (typeof w.toneScore === "number" && w.toneScore < 60) return "tone";
  return "ok";
}

/** hover 文案：`读对 · 92 分 · 声调 90 · 此处停顿`。 */
export function describeSpeechWord(w?: SpeechWordLike, provider?: SpeechProvider): string {
  if (!w) return "";
  const label = SPEECH_TONE_LABEL[classifySpeechWord(w, provider)];
  const parts: string[] = [];
  if (label) parts.push(label);
  const score = Number(w.score);
  if (Number.isFinite(score)) parts.push(`${Math.round(score)} 分`);
  if (typeof w.toneScore === "number") parts.push(`声调 ${Math.round(w.toneScore)}`);
  if (w.isPause) parts.push("此处停顿");
  return parts.join(" · ");
}

/**
 * 原文 + words → 逐 token 着色结果。
 * 对齐按顺序一一对应（SSECP 每个字/词都会返回一项，包括漏读项），标点/空白不消耗 words。
 */
export function buildSpeechTokens(
  refText: string,
  words?: SpeechWordLike[],
  provider?: SpeechProvider
): SpeechToken[] {
  const queue = (words || []).filter((w) => w && stripToWordChars(w.word));
  let qi = 0;
  return tokenizeRefText(refText).map((text) => {
    if (!isWordToken(text)) {
      return { text, tone: "plain" as const, playable: false, title: "" };
    }
    const word = queue[qi];
    if (word) qi += 1;
    return {
      text,
      word,
      tone: classifySpeechWord(word, provider),
      playable: !!(word && word.startMs != null),
      title: describeSpeechWord(word, provider),
    };
  });
}

/** 统计各档位字数（报告页摘要用）。 */
export function summarizeSpeechWords(
  words?: SpeechWordLike[],
  provider?: SpeechProvider
): Record<SpeechTone, number> {
  const zero: Record<SpeechTone, number> = { ok: 0, mid: 0, bad: 0, tone: 0, missing: 0, repeat: 0, note: 0, plain: 0 };
  for (const w of words || []) {
    const t = classifySpeechWord(w, provider);
    if (t !== "plain") zero[t] += 1;
  }
  return zero;
}
