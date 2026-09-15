import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import PlanCourseList from "../src/components/PlanCourseList";
import { normalizePlanCourses, normalizePlanTopics, formatCourseSpec } from "../src/lib/plan-scope";

// 考核计划 scope 归一化回归（2026-09-15 家长端「考核管理 → 自定义考核」白屏事故）：
// scope.courses 自 2026-09-14 起是新格式 [{title, kps:[{name,count}]}]，渲染端若直接把数组项
// 当 React 子节点渲染 → React 抛 "Objects are not valid as a React child" → 整棵渲染树卸载 → 白屏。
// 本文件守住：① 两种格式都能解析出课程名；② 组件渲染**永不抛错**且带出题约定。

describe("PlanCourseList（渲染安全：白屏回归）", () => {
  it("新格式 [{title,kps}] 正常渲染（不抛 \"Objects are not valid as a React child\"）", () => {
    const html = renderToString(
      createElement(PlanCourseList, {
        courses: [{ title: "论语学而篇第八章", kps: [{ name: "字词", count: 1 }, { name: "道理", count: 2 }] }],
        emptyHint: "无",
      })
    );
    expect(html).toContain("论语学而篇第八章（字词×1、道理×2）");
  });

  it("旧格式 [\"课程名\"] 正常渲染", () => {
    const html = renderToString(
      createElement(PlanCourseList, {
        courses: ["论语学而篇第一章", "论语为政篇第一章"],
        emptyHint: "无",
      })
    );
    // renderToString 会在文本节点间插入 <!-- --> 分隔注释，先去掉再断言序号
    const clean = html.replace(/<!-- -->/g, "");
    expect(clean).toContain("1. 论语学而篇第一章");
    expect(clean).toContain("2. 论语为政篇第一章");
  });

  it("空 / 脏数据 → 走 emptyHint，不抛错", () => {
    for (const raw of [undefined, null, [], "论语", [null, 1, {}], [{ kps: [] }]]) {
      const html = renderToString(createElement(PlanCourseList, { courses: raw, emptyHint: "没有列出具体课程" }));
      expect(html).toContain("没有列出具体课程");
    }
  });

  it("对照：把同一个对象数组直接当子节点渲染确实会抛错（事故机理）", () => {
    expect(() =>
      renderToString(createElement("div", null, [{ title: "论语学而篇第八章", kps: [] }] as never))
    ).toThrow();
  });
});

describe("normalizePlanCourses（scope.courses 两格式）", () => {
  it("新格式 → title + kps；旧格式 → title + 空 kps", () => {
    expect(normalizePlanCourses([{ title: "A", kps: [{ name: "背诵", count: 2 }] }])).toEqual([
      { title: "A", kps: [{ name: "背诵", count: 2 }] },
    ]);
    expect(normalizePlanCourses(["A", "B"])).toEqual([
      { title: "A", kps: [] },
      { title: "B", kps: [] },
    ]);
  });

  it("输出项全是可渲染的基本类型（不会有裸对象漏出）", () => {
    const out = normalizePlanCourses([{ title: "A", kps: [{ name: "背诵", count: 1 }] }, "B", { title: "C" }]);
    for (const c of out) {
      expect(typeof c.title).toBe("string");
      expect(Array.isArray(c.kps)).toBe(true);
      for (const k of c.kps) {
        expect(typeof k.name).toBe("string");
        expect(typeof k.count).toBe("number");
      }
    }
  });

  it("脏数据不崩：非数组 / 缺 title / kps 非数组 / count 非法", () => {
    expect(normalizePlanCourses(null)).toEqual([]);
    expect(normalizePlanCourses("论语")).toEqual([]);
    expect(normalizePlanCourses([null, 42, {}, { title: "  " }])).toEqual([]);
    const out = normalizePlanCourses([
      { title: "A", kps: "不是数组" },
      { title: "B", kps: [null, { name: "字词" }, { name: "", count: 3 }, { name: "道理", count: "0" }] },
    ]);
    expect(out[0]).toEqual({ title: "A", kps: [] });
    expect(out[1].kps).toEqual([
      { name: "字词", count: 1 },
      { name: "道理", count: 1 },
    ]);
  });
});

describe("normalizePlanTopics / formatCourseSpec", () => {
  it("主题混排取出名称", () => {
    expect(normalizePlanTopics(["lunyu", { name: "论语" }, { title: "孝经" }, null])).toEqual(["lunyu", "论语", "孝经"]);
    expect(normalizePlanTopics(undefined)).toEqual([]);
  });

  it("课程展示文本", () => {
    expect(formatCourseSpec({ title: "论语学而篇第八章", kps: [{ name: "字词", count: 1 }] })).toBe("论语学而篇第八章（字词×1）");
    expect(formatCourseSpec({ title: "论语学而篇第一章", kps: [] })).toBe("论语学而篇第一章");
  });
});
