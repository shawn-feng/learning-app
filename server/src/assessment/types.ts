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
  /** 增漏读标记：0 正常 / 1 漏读 / 2 重复读 */
  dpType?: number;
  phones?: PhoneScore[];
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
  words?: { word: string; score: number; dpType?: number; phones?: { phone: string; score: number }[] }[];
  cnSyllables?: { char: string; score: number; stress?: number }[];
  audioQuality?: { tipId?: number; snr?: number; clip?: number; volume?: number };
  raw?: unknown;
}
