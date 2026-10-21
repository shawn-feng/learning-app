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
      tone: w.tone,
      toneScore: w.toneScore,
      isPause: w.isPause,
      sentenceIndex: w.sentenceIndex,
      startMs: w.startMs,
      endMs: w.endMs,
      phones: (w.phones || []).map((p) => ({
        phone: p.phone,
        score: p.score,
        startMs: p.startMs,
        endMs: p.endMs,
      })),
    })),
    sentences: r.sentences,
    cnSyllables: undefined,
    audioQuality: r.audioQuality,
    raw: r.raw,
  };
}
