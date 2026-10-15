// ISSUE-183：发音评测最终分统一口径——各维度平均，不再单独采信引擎综合分。
// 综合分（声希 overall / 智聆 SuggestedScore）的内部权重不可控，低音量等场景下
// 与各维度分的走向不一致；维度平均让"差在哪一维"直接反映进最终分，家长可核对
// （验收口径：最终分 ≈ (准确度+流利度+完整度)/3，用 raw 原始响应对账）。
// 客户端考核判分（pointGot/correct）消费的即此 score（经 toSpeechAssessment 映射为 pron）。

/**
 * 取存在维度的平均分（四舍五入）；全部缺失时回退 fallback（引擎综合分），再缺失回退 0。
 * values 里的非有限数值（undefined/null/NaN）一律视为"该维度缺失"，不参与平均。
 */
export function dimensionMeanScore(values: unknown[], fallback: unknown): number {
  const dims = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (dims.length) {
    return Math.round(dims.reduce((a, b) => a + b, 0) / dims.length);
  }
  const fb = Number(fallback);
  return Number.isFinite(fb) ? Math.round(fb) : 0;
}
