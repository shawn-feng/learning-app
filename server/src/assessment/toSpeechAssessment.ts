// 将 AssessmentResult（腾讯智聆 / 阿里声希）映射为 EXAM 展示用的 SpeechAssessment（字段兼容原 SSECP 契约）。
import type { AssessmentResult, SpeechAssessment } from "./types.js";

export function toSpeechAssessment(r: AssessmentResult): SpeechAssessment {
  return {
    provider: r.provider,
    pron: r.score,
    accuracy: r.accuracy,
    integrity: r.completeness,
    fluency: r.fluency != null ? { overall: r.fluency } : undefined,
    prosody: undefined,
    words: (r.words || []).map((w) => ({
      word: w.word,
      score: w.score,
      dpType: w.dpType,
      phones: (w.phones || []).map((p) => ({ phone: p.phone, score: p.score })),
    })),
    cnSyllables: undefined,
    audioQuality: undefined,
    raw: r.raw,
  };
}
