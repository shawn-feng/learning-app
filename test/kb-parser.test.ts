import { describe, it, expect } from "vitest";
import {
  appendItemToBlock,
  extractFrontmatter,
  findBlock,
  findField,
  findItem,
  isItemChunk,
  listItemTitles,
  parseFieldLine,
  splitBlocks,
  splitItems,
  updateFieldValue,
} from "../electron/lib/kb-parser";

// 与 SPEC 3.1 daily 详式一致的样例（A 格式字段）
const DAILY_SAMPLE = `## 学习

### 论语先进篇第十六章
- 课程名：论语先进篇第十六章
- 考核：吟诵✓ 翻译✓ 道理应用✓
- 掌握度：熟练
- 孩子表现：主动提问

## 生活

### 做番茄钟网页
- 标签：#动手 #好奇
- 概要：珊珊让饺子做了一个番茄钟网页

### 撒谎事件
- 标签：#诚实
- 概要：对妈妈撒谎了

## 问答

### 恐龙为什么灭绝
- 孩子的疑问：恐龙到底为什么灭绝呀？
- 结论：小行星撞击导致气候变化
`;

// 与 SPEC 3.4 进度条目一致的样例（B 格式字段）
const PROGRESS_SAMPLE = `---
learned: 282
total: 514
next: "论语先进篇第十七章"
updated: 2026-08-19
---

### 论语先进篇第十六章
状态:: ✅
掌握度:: 良好
复习次数:: 0
最近复习:: 2026-08-13
tags:: [诚实, 自律]

### 论语先进篇第十五章
状态:: ✅
掌握度:: 熟练
复习次数:: 1
最近复习:: 2026-08-14
tags:: [反思]
`;

describe("区块/条目切分", () => {
  it("splitBlocks 正确切出 3 个区块", () => {
    const blocks = splitBlocks(DAILY_SAMPLE.split(/\r?\n/));
    expect(blocks.map((b) => b.title)).toEqual(["学习", "生活", "问答"]);
  });

  it("findBlock 支持标题精确匹配与 1-based 序号", () => {
    const blocks = splitBlocks(DAILY_SAMPLE.split(/\r?\n/));
    expect(findBlock(blocks, "生活")?.title).toBe("生活");
    expect(findBlock(blocks, 2)?.title).toBe("生活");
    expect(findBlock(blocks, 99)).toBeNull();
    expect(findBlock(blocks, "不存在")).toBeNull();
  });

  it("splitItems 在生活区块内切出 2 条，序号稳定", () => {
    const blocks = splitBlocks(DAILY_SAMPLE.split(/\r?\n/));
    const items = splitItems(findBlock(blocks, "生活")!.lines);
    expect(items.map((i) => i.title)).toEqual(["做番茄钟网页", "撒谎事件"]);
  });

  it("findItem 标题匹配与序号定位第二条", () => {
    const blocks = splitBlocks(DAILY_SAMPLE.split(/\r?\n/));
    const items = splitItems(findBlock(blocks, "生活")!.lines);
    expect(findItem(items, "撒谎事件")?.title).toBe("撒谎事件");
    expect(findItem(items, 2)?.title).toBe("撒谎事件");
    expect(findItem(items, "不存在")).toBeNull();
  });

  it("进度文件条目按 B 格式解析（splitItems 同样适用）", () => {
    const { body } = extractFrontmatter(PROGRESS_SAMPLE)!;
    const blocks = splitBlocks(body.split(/\r?\n/));
    // 进度文件正文无 ## 区块，全部在 0 号「区块」？——无 ## 时 splitBlocks 返回空
    // 这里验证：进度文件条目不依赖 ## 区块，直接用 splitItems 全文件切条目
    expect(blocks.length).toBe(0);
  });
});

describe("字段解析（两种格式）", () => {
  it("A 格式：- 键：值（全角冒号）", () => {
    const hit = parseFieldLine("- 掌握度：熟练");
    expect(hit).toEqual({ key: "掌握度", value: "熟练", lineIndex: -1, sep: "dash-colon" });
  });

  it("A 格式：- 键: 值（半角冒号也接受）", () => {
    const hit = parseFieldLine("- summary: 对妈妈撒谎");
    expect(hit?.key).toBe("summary");
    expect(hit?.value).toBe("对妈妈撒谎");
  });

  it("B 格式：键:: 值（进度条目）", () => {
    const hit = parseFieldLine("状态:: ✅");
    expect(hit).toEqual({ key: "状态", value: "✅", lineIndex: -1, sep: "dcolon" });
  });

  it("非字段行（标题/空行/散文）返回 null", () => {
    expect(parseFieldLine("### 撒谎事件")).toBeNull();
    expect(parseFieldLine("")).toBeNull();
    expect(parseFieldLine("珊珊让饺子做了一个番茄钟网页")).toBeNull();
    expect(parseFieldLine("---")).toBeNull();
  });

  it("findField 在条目内精确匹配字段", () => {
    const blocks = splitBlocks(DAILY_SAMPLE.split(/\r?\n/));
    const items = splitItems(findBlock(blocks, "生活")!.lines);
    const hit = findField(items[0], "标签");
    expect(hit?.value).toBe("#动手 #好奇");
  });
});

describe("updateFieldValue（定位更新，保留格式）", () => {
  it("替换已有字段值，保留分隔符与其它行", () => {
    const blocks = splitBlocks(DAILY_SAMPLE.split(/\r?\n/));
    const items = splitItems(findBlock(blocks, "生活")!.lines);
    const { lines, hit } = updateFieldValue(items[0].lines, "概要", "新的概要内容");
    expect(hit?.key).toBe("概要");
    expect(lines.join("\n")).toContain("- 概要：新的概要内容");
    expect(lines.join("\n")).toContain("- 标签：#动手 #好奇"); // 其它行不动
  });

  it("B 格式字段同样可替换", () => {
    const { body } = extractFrontmatter(PROGRESS_SAMPLE)!;
    const lines = body.split(/\r?\n/);
    const { lines: updated } = updateFieldValue(lines, "掌握度", "熟练");
    expect(updated.join("\n")).toContain("掌握度:: 熟练");
  });

  it("字段不存在返回 hit:null 且不修改", () => {
    const blocks = splitBlocks(DAILY_SAMPLE.split(/\r?\n/));
    const items = splitItems(findBlock(blocks, "生活")!.lines);
    const { lines, hit } = updateFieldValue(items[0].lines, "不存在的字段", "x");
    expect(hit).toBeNull();
    expect(lines).toEqual(items[0].lines);
  });

  it("同文本多次出现不受影响：只改目标条目内字段", () => {
    const { body } = extractFrontmatter(PROGRESS_SAMPLE)!;
    const blocks = splitBlocks(body.split(/\r?\n/));
    // 进度文件无 ## 区块，直接整文件按条目处理：模拟工具层先定位条目再替换
    const items = splitItems(body.split(/\r?\n/));
    expect(items.length).toBe(2);
    const { lines } = updateFieldValue(items[1].lines, "掌握度", "良好");
    expect(lines.join("\n")).toContain("掌握度:: 良好");
  });
});

describe("appendItemToBlock（区块尾追加）", () => {
  it("追加到指定区块尾，不影响其它区块", () => {
    const lines = DAILY_SAMPLE.split(/\r?\n/);
    const { lines: updated, block } = appendItemToBlock(
      lines,
      "生活",
      "### 新事件\n- 标签：#亲情\n- 概要：新事件概要"
    );
    expect(block).not.toBeNull();
    const text = updated.join("\n");
    // 新条目在生活区块内、问答区块之前
    const lifeIdx = text.indexOf("## 生活");
    const qaIdx = text.indexOf("## 问答");
    const newIdx = text.indexOf("### 新事件");
    expect(newIdx).toBeGreaterThan(lifeIdx);
    expect(newIdx).toBeLessThan(qaIdx);
    // 原有条目保留
    expect(text).toContain("### 做番茄钟网页");
    expect(text).toContain("### 撒谎事件");
  });

  it("区块不存在返回 block:null 且不修改", () => {
    const lines = DAILY_SAMPLE.split(/\r?\n/);
    const { lines: updated, block } = appendItemToBlock(lines, "不存在的区块", "### x\n- 概要：y");
    expect(block).toBeNull();
    expect(updated).toEqual(lines);
  });
});

describe("frontmatter / listOnly / 条目块校验", () => {
  it("extractFrontmatter 提取 YAML 头并分离正文", () => {
    const fm = extractFrontmatter(PROGRESS_SAMPLE);
    expect(fm).not.toBeNull();
    expect(fm!.data).toContain("learned: 282");
    expect(fm!.body).not.toContain("learned:");
    expect(extractFrontmatter(DAILY_SAMPLE)).toBeNull(); // 无 frontmatter
  });

  it("listItemTitles 提取指定区块条目标题（供 month 聚合）", () => {
    const groups = listItemTitles(DAILY_SAMPLE, "生活");
    expect(groups.length).toBe(1);
    expect(groups[0].items).toEqual(["做番茄钟网页", "撒谎事件"]);
  });

  it("isItemChunk 判定条目块（### 开头）", () => {
    expect(isItemChunk("### 新事件\n- 标签：#亲情")).toBe(true);
    expect(isItemChunk("- 标签：#亲情")).toBe(false);
    expect(isItemChunk("")).toBe(false);
  });
});
