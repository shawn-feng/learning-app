import { describe, it, expect } from "vitest";
import { parsePeriodDays } from "../electron/lib/exam";

// 学习考核（EXAM-REQUIREMENTS.md）纯函数回归：
// - parsePeriodDays：从家长写的「考核方法说明」解析周期天数（每天/周/月/每N天/每N周/兜底7）

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
