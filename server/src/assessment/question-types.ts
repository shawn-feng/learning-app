// 考核口语题题型 ↔ SSECP 声希引擎 coreType 映射。
// 参考：help.aliyun.com/document_detail/2996315(段落请求 coreType) / 云市场 model_id 映射
//   (cn.word.score / cn.sent.score / cn.pred.score / en.word.score / en.sent.score / en.pred.score)。
// 现有 electron/lib/assessment/providers/aliyun-kid.ts 仅用 en.word_kid.score；本映射把它扩展到全部 21 题型。

export type SsecpQuestionType =
  | "cn_pinyin"
  | "cn_word"
  | "cn_sentence"
  | "cn_paragraph"
  | "cn_poem"
  | "cn_recitation"
  | "en_word"
  | "en_word_kid"
  | "en_sentence"
  | "en_sentence_kid"
  | "en_paragraph"
  | "en_phonics"
  | "en_correction"
  | "en_qa"
  | "en_oral";

/** 题型 → 声希引擎 coreType（⚠️ 带注释的需首次实测确认） */
export const SSECP_CORETYPE: Record<SsecpQuestionType, string> = {
  cn_pinyin: "cn.word.score", // 拼音 ~ 中文字词（声韵母/声调来自结果）
  cn_word: "cn.word.score",
  cn_sentence: "cn.sent.score",
  cn_paragraph: "cn.pred.score",
  cn_poem: "cn.pred.score",
  cn_recitation: "cn.pred.score", // 背诵 = 段落引擎 + feedback=1 实时逐字
  en_word: "en.word.score",
  en_word_kid: "en.word_kid.score", // 现有 aliyun-kid 已验证
  en_sentence: "en.sent.score",
  en_sentence_kid: "en.sent_kid.score", // ⚠️ 儿童句子 coreType 待实测确认
  en_paragraph: "en.pred.score",
  en_phonics: "en.word.score", // 自然拼读 ~ 单词
  en_correction: "en.word.score", // 纠错 ~ 单词
  en_qa: "en.pred.score", // 听后问答 ~ 段落/开放 ⚠️ 待实测
  en_oral: "en.pred.score", // 口语作文(看图/复述) ~ 段落/开放 ⚠️ 待实测
};

export function coreTypeOf(q: string): string | null {
  return (SSECP_CORETYPE as Record<string, string>)[q] ?? null;
}

export function isCn(q: string): boolean {
  return q.startsWith("cn");
}

export interface PhoneScore {
  phone: string;
  score: number;
  startMs?: number;
  endMs?: number;
}

export interface WordScore {
  word: string;
  score: number;
  /** 0 正常 / 1 漏读 / 2 重复读 */
  dpType?: number;
  startMs?: number;
  endMs?: number;
  phones?: PhoneScore[];
}

/** 服务端统一口语评测结果（维度分 + 音素级/声韵母级 + 音频质量） */
export interface SpeechAssessment {
  provider: "aliyun-ssecp";
  /** 推荐展示用 pron（overall 因含完整度会虚高） */
  overall: number;
  pron: number;
  accuracy?: number;
  integrity?: number;
  fluency?: { overall: number; pause?: number; speed?: number };
  prosody?: { overall: number; sense?: number; stress?: number; tone?: number };
  words?: WordScore[];
  /** 中文：声韵母/声调级（来自结果的 syllable/stress 数组） */
  cnSyllables?: { char: string; score: number; stress?: number }[];
  audioQuality?: { tipId?: number; snr?: number; clip?: number; volume?: number };
  raw: unknown;
}
