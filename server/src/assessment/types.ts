// 发音评测统一类型：腾讯云智聆（WebSocket） / 阿里 SSECP 声希（HTTP POST API）
export type AssessmentProviderId = "tencent-soe" | "aliyun-ssecp";

export interface PhoneScore {
  phone: string;
  score: number; // 0-100
  startMs?: number;
  endMs?: number;
}

export interface WordScore {
  word: string;
  score: number; // 0-100
  /** 增漏读标记：0 正常 / 1 漏读 / 2 重复读 / 3 注释字（不参与评分） */
  dpType?: number;
  /** 声调 0-4（0 轻声、1-4 一二三四声） */
  tone?: number;
  /** 声调得分 0-100（中文；英文的 tonescore 是升降调 0/1，不映射到此字段） */
  toneScore?: number;
  /** 该字/词处是否停顿 */
  isPause?: boolean;
  /** 所属句子下标（中文篇章 / 英文段落；平铺题型为 0） */
  sentenceIndex?: number;
  /** 在音频中的起止时间（ms），用于按字回放 */
  startMs?: number;
  endMs?: number;
  phones?: PhoneScore[];
}

/** 句子级摘要（中文篇章 / 英文段落才有） */
export interface SpeechSentence {
  text: string;
  score: number;
  /** 停顿次数 */
  pause?: number;
  /** 语速 0 慢 / 1 正常 / 2 快 */
  speed?: number;
}

/** 音频质量（tipId 见阿里云 tipId 说明：10000 无音频 / 10004 音量低 / 10005 截幅 / 10006 信噪比低） */
export interface AudioQuality {
  tipId?: number;
  snr?: number;
  clip?: number;
  volume?: number;
}

/** 评测统一返回（两服务均映射到此结构，便于前端展示与后续落库） */
export interface AssessmentResult {
  provider: AssessmentProviderId;
  /** 总分 0-100 */
  score: number;
  /** 准确度 0-100（阿里儿童单词评测无此维度，返回 undefined） */
  accuracy?: number;
  /** 流利度 0-100 */
  fluency?: number;
  /** 完整度 0-100 */
  completeness?: number;
  words: WordScore[];
  /** 句子级明细 */
  sentences?: SpeechSentence[];
  /** 录音质量 */
  audioQuality?: AudioQuality;
  /** 各服务原始返回（调试用） */
  raw?: unknown;
}

/** 口语评测结果（展示所需子集，契约兼容原 SSECP 结构，考核 result 字段即此类型） */
export interface SpeechAssessment {
  provider: "tencent-soe" | "aliyun-ssecp";
  overall?: number;
  /** 发音总分（腾讯=SuggestedScore 建议分，用于踩分） */
  pron: number;
  accuracy?: number;
  integrity?: number;
  fluency?: { overall: number; pause?: number; speed?: number };
  prosody?: { overall: number; sense?: number; stress?: number; tone?: number };
  words?: {
    word: string;
    score: number;
    dpType?: number;
    tone?: number;
    toneScore?: number;
    isPause?: boolean;
    sentenceIndex?: number;
    startMs?: number;
    endMs?: number;
    phones?: { phone: string; score: number; startMs?: number; endMs?: number }[];
  }[];
  sentences?: SpeechSentence[];
  cnSyllables?: { char: string; score: number; stress?: number }[];
  audioQuality?: AudioQuality;
  raw?: unknown;
}
