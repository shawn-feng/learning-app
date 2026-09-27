import { describe, it, expect } from "vitest";
import { lookupText, canLookupSelection, LOOKUP_MAX_LEN } from "../src/lib/dictionary";

describe("lookupText：整词优先 → 贪心拆分 → 逐字兜底（ISSUE-017）", () => {
  it("整词命中：月亮 → 单条词条（拼音含 yuè）", () => {
    const r = lookupText("月亮");
    expect(r.length).toBe(1);
    expect(r[0].text).toBe("月亮");
    expect(r[0].pinyin).toContain("yuè");
    expect(r[0].meaning.length).toBeGreaterThan(0);
  });

  it("贪心最长拆分：太阳光 → 太阳 + 光（非词拆单字）", () => {
    const r = lookupText("太阳光");
    expect(r.map((e) => e.text)).toEqual(["太阳", "光"]);
  });

  it("逐字兜底：山川湖海 → 4 个单字（词表无「山川」）", () => {
    const r = lookupText("山川湖海");
    expect(r.length).toBe(4);
    expect(r.map((e) => e.text)).toEqual(["山", "川", "湖", "海"]);
  });

  it("非中文跳过：hello世界 → 只查「世界」", () => {
    const r = lookupText("hello世界");
    expect(r.length).toBe(1);
    expect(r[0].text).toBe("世界");
  });

  it("空/纯空白输入 → 空数组", () => {
    expect(lookupText("")).toEqual([]);
    expect(lookupText("   ")).toEqual([]);
    expect(lookupText("\t\n")).toEqual([]);
  });

  it("多音字保留全读音：行 → 含 xíng 与 háng", () => {
    const r = lookupText("行");
    expect(r[0].text).toBe("行");
    expect(r[0].pinyin).toContain("xíng");
    expect(r[0].pinyin).toContain("háng");
  });

  it("儿童化覆盖生效：一 → 「数字 1」类释义（非训诂）", () => {
    const r = lookupText("一");
    expect(r[0].meaning).toContain("数字");
  });

  it("中文标点跳过：月亮，真美 → 月亮 + 真 + 美", () => {
    const r = lookupText("月亮，真美");
    expect(r.map((e) => e.text)).toEqual(["月亮", "真", "美"]);
  });
});

describe("canLookupSelection：iframe 桥与聊天区共用选区口径（ISSUE-017 优化）", () => {
  it("短句中文 → 可查", () => {
    expect(canLookupSelection("月亮真美")).toBe(true);
    expect(canLookupSelection("  小 鸿 子 今天 读 课文 ")).toBe(true); // 含空格但去空白后未超限
  });

  it("空/纯英文数字/无中文 → 不查", () => {
    expect(canLookupSelection("")).toBe(false);
    expect(canLookupSelection("   ")).toBe(false);
    expect(canLookupSelection("hello world 123")).toBe(false);
  });

  it("去空白后超过 LOOKUP_MAX_LEN → 不查（整段复制）", () => {
    expect(LOOKUP_MAX_LEN).toBe(30);
    const sentence = "一二三四五六七八九十"; // 10 字
    expect(canLookupSelection(sentence.repeat(3))).toBe(true); // 恰好 30 字：上限内
    expect(canLookupSelection(sentence.repeat(2))).toBe(true);
    expect(canLookupSelection(sentence.repeat(3) + "一")).toBe(false); // 31 字：超限
  });
});
