import { describe, it, expect } from "vitest";
import { parsePeriodDays } from "../electron/lib/exam";
import { extractJson } from "../electron/lib/exam-engine";

// 学习考核（EXAM-REQUIREMENTS.md）纯函数回归：
// - parsePeriodDays：从家长写的「考核方法说明」解析周期天数（每天/周/月/每N天/每N周/兜底7）
// - extractJson：从 LLM 输出里稳健提取 JSON（剥 markdown 围栏、截首尾大括号）

describe("parsePeriodDays（考核周期解析）", () => {
  it("每天/每日 → 1 天", () => {
    expect(parsePeriodDays("周期：每天。考核对象：当天学过的")).toBe(1);
    expect(parsePeriodDays("每日一考")).toBe(1);
    expect(parsePeriodDays("daily")).toBe(1);
  });

  it("每周/每月 → 7 / 30 天", () => {
    expect(parsePeriodDays("周期：每周")).toBe(7);
    expect(parsePeriodDays("每月考核一次")).toBe(30);
    expect(parsePeriodDays("weekly")).toBe(7);
    expect(parsePeriodDays("monthly")).toBe(30);
  });

  it("每N天 / 每N周 → 按数字折算", () => {
    expect(parsePeriodDays("每 3 天考一次")).toBe(3);
    expect(parsePeriodDays("每2天")).toBe(2);
    expect(parsePeriodDays("每 2 周")).toBe(14);
    expect(parsePeriodDays("每1周")).toBe(7);
  });

  it("写不出周期 → 兜底 7 天（不崩溃）", () => {
    expect(parsePeriodDays("")).toBe(7);
    expect(parsePeriodDays("随便写写没有周期")).toBe(7);
  });
});

describe("extractJson（LLM 输出提取）", () => {
  it("纯 JSON 直接解析", () => {
    const r = extractJson('{"questions":[{"qid":"q1"}]}');
    expect(r?.questions?.[0]?.qid).toBe("q1");
  });

  it("剥 markdown 围栏（json / 无语言标记）", () => {
    const a = extractJson('```json\n{"a":1}\n```');
    expect(a?.a).toBe(1);
    const b = extractJson("```\n{\"b\":2}\n```");
    expect(b?.b).toBe(2);
  });

  it("前后有说明文字时截取首尾大括号", () => {
    const r = extractJson('好的，这是结果：\n{"score":85}\n——完毕');
    expect(r?.score).toBe(85);
  });

  it("无 JSON → null（不抛错）", () => {
    expect(extractJson("")).toBeNull();
    expect(extractJson("抱歉，我无法生成")).toBeNull();
    expect(extractJson(null as unknown as string)).toBeNull();
  });
});
