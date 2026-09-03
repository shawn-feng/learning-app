import { planTextToCourseText, findCourseByPlanText } from "../src/plan-text.js";

let fails = 0;
function eq(a: unknown, b: unknown, label: string) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(a)}`);
}
// 归一化
eq(planTextToCourseText("复习：论语学而篇第一章"), "论语学而篇第一章", "剥 复习： 前缀");
eq(planTextToCourseText("论语子路篇第七章"), "论语子路篇第七章", "无前缀原样");
eq(planTextToCourseText("论语子罕篇第十二章（上）"), "论语子罕篇第十二章（上）", "（上）不改");
eq(planTextToCourseText("论语学而篇第一章（复习）"), "论语学而篇第一章", "剥尾部（复习）");
eq(planTextToCourseText("  复习: 汉字宫第190课·储粮之仓 "), "汉字宫第190课·储粮之仓", "半角冒号+空白");

// 闻闻真实样例：计划文本「复习：…」应命中真实课程行并判今天已复习
const wenCourses = [
  { topic: "lunyu", title: "论语学而篇第一章", status: "✅", first_learned: "2026-06-05", last_review: "2026-09-03" },
  { topic: "lunyu", title: "论语学而篇第二章", status: "✅", first_learned: "2026-06-14", last_review: "2026-09-03" },
  { topic: "lunyu", title: "论语学而篇第三章", status: "✅", first_learned: "2026-06-15", last_review: "" },
];
const c1 = findCourseByPlanText(wenCourses as any, "复习：论语学而篇第一章");
eq(c1?.title, "论语学而篇第一章", "复习项→真实课程（第一章）");
eq(!!c1 && c1.last_review === "2026-09-03", true, "第一章今天复习过→done");
const c3 = findCourseByPlanText(wenCourses as any, "复习：论语学而篇第三章");
eq(!!c3 && c3.last_review === "2026-09-03", false, "第三章没复习→not done");
const c4 = findCourseByPlanText(wenCourses as any, "不存在的课");
eq(c4, undefined, "查不到→undefined");

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
