/**
 * P3 补漏冒烟：孩子 agent 计划域 + 家长教学方法工具（get_today_plan / parent_content）。
 * 用法：npx tsx scripts/plan-tools-check.mts
 *
 * 覆盖：
 *  A. getTodayPlans + formatTodayPlans：三域聚合 / 空计划 / 状态映射
 *  B. createTodayPlanTool：date 缺省今天、date 非法回退今天
 *  C. createParentContentTool：method / teachingCopy / assessRubric / htmlPath + 错误分支
 *    （未找到主题 / 未填方法 / 未找到课程 / 未填文案 / 未登记 html 路径）
 *  D. 工具白名单：computeChildToolNames 含 get_today_plan / parent_content（场景会话不含）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openKb } from "../src/db/kb.js";
import { openParentLib } from "../src/db/parent-lib.js";
import { getTodayPlans, formatTodayPlans, createTodayPlanTool, createParentContentTool } from "../src/agent/plan-tools.js";
import { computeChildToolNames } from "../src/agent/session-registry.js";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  const tag = cond ? "✓" : "✗";
  if (!cond) failed++;
  console.log(`  ${tag} ${name}${detail ? ` — ${detail}` : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-tools-"));
const PID = "p1";
const CID = "c1";
const deps = { dataDir: tmp, parentId: PID, childId: CID };
function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const TODAY = localToday();

async function exec(tool: any, params: any): Promise<{ text: string; error?: string }> {
  try {
    const r = await tool.execute("tc", params);
    return { text: r.content?.[0]?.text ?? "" };
  } catch (e) {
    return { text: "", error: (e as Error).message };
  }
}

async function main() {
  // 建孩子 kb + 家长库，插计划与家长库数据
  const kb = openKb(tmp, PID, CID);
  const now = new Date().toISOString();
  kb.prepare(
    `INSERT INTO study_plans (id, parent_id, child_id, topic_key, course_name, mode, creator, due_at, status, active, created_at, updated_at)
     VALUES ('sp1', ?, ?, 'lunyu', '论语颜渊篇第十三章', 'new', 'parent', ?, 'pending', 1, ?, ?)`
  ).run(PID, CID, TODAY, now, now);
  kb.prepare(
    `INSERT INTO life_plans (id, parent_id, child_id, title, creator, due_at, status, active, created_at, updated_at)
     VALUES ('lp1', ?, ?, '跳绳 100 个', 'child', ?, 'done', 1, ?, ?)`
  ).run(PID, CID, TODAY, now, now);
  kb.prepare(
    `INSERT INTO exam_plans (id, parent_id, child_id, title, creator, due_at, status, active, created_at, updated_at)
     VALUES ('ep1', ?, ?, '论语学而篇考核', 'parent', ?, 'pending', 1, ?, ?)`
  ).run(PID, CID, TODAY, now, now);
  kb.close();

  const lib = openParentLib(tmp, PID);
  lib.prepare(
    `INSERT INTO topics (name, topic_key, method) VALUES ('论语', 'lunyu', '先读原文，再逐句讲白话，最后联系生活举例。')`
  ).run();
  lib.prepare(
    `INSERT INTO courses (topic, title, teaching_copy, assess_rubric, html_path)
     VALUES ('lunyu', '论语学而篇第一章', '教学文案：先领读，再解释「学而时习之」。', '考核要点：能背诵并说出大意。', 'lunyu/论语学而篇第一章.html')`
  ).run();
  lib.close();

  console.log("A. getTodayPlans + formatTodayPlans");
  {
    const plans = getTodayPlans(tmp, PID, CID, TODAY);
    check("学习计划 1 条", plans.study.length === 1, `study=${plans.study.length}`);
    check("生活计划 1 条", plans.life.length === 1);
    check("考核计划 1 条", plans.exam.length === 1);
    const text = formatTodayPlans(plans);
    check("含三域标题", text.includes("【学习】") && text.includes("【生活】") && text.includes("【考核】"), text.split("\n")[0]);
    check("状态映射 done→已完成", text.includes("✅ 已完成") && text.includes("跳绳 100 个"));
    check("状态映射 pending→待完成", text.includes("⬜ 待完成") && text.includes("论语颜渊篇第十三章"));
    check("creator=child 标注自己安排", text.includes("（自己安排）"));
    // 空计划
    const empty = getTodayPlans(tmp, PID, "c2", TODAY);
    check("空计划提示", formatTodayPlans(empty).includes("还没有安排计划"));
  }

  console.log("B. createTodayPlanTool");
  {
    const tool = createTodayPlanTool(deps);
    const r1 = await exec(tool, {});
    check("缺省今天返回计划", r1.text.includes("【学习】") && r1.text.includes(TODAY), r1.text.split("\n")[0]);
    const r2 = await exec(tool, { date: "2099-01-01" });
    check("指定未来某天无计划", r2.text.includes("还没有安排计划"));
    const r3 = await exec(tool, { date: "非法日期" });
    check("非法 date 回退今天", r3.text.includes(TODAY));
  }

  console.log("C. createParentContentTool");
  {
    const tool = createParentContentTool(deps);
    const m = await exec(tool, { type: "method", topic: "lunyu" });
    check("method 命中（目录名）", m.text.includes("先读原文"), m.text);
    const m2 = await exec(tool, { type: "method", topic: "论语" });
    check("method 命中（中文名）", m2.text.includes("先读原文"));
    const tc = await exec(tool, { type: "teachingCopy", topic: "lunyu", course: "论语学而篇第一章" });
    check("teachingCopy 命中", tc.text.includes("教学文案"));
    const ar = await exec(tool, { type: "assessRubric", topic: "lunyu", course: "论语学而篇第一章" });
    check("assessRubric 命中", ar.text.includes("考核要点"));
    const hp = await exec(tool, { type: "htmlPath", topic: "lunyu", course: "论语学而篇第一章" });
    check("htmlPath 命中", hp.text.includes(".html") && !hp.text.startsWith("materials/"));
    // 错误分支
    const e1 = await exec(tool, { type: "method", topic: "不存在的主题" });
    check("未找到主题报错", !!e1.error && e1.error.includes("未找到主题"), e1.error);
    const e2 = await exec(tool, { type: "teachingCopy", topic: "lunyu", course: "不存在的课" });
    check("未找到课程报错", !!e2.error && e2.error.includes("未找到课程"));
    const e3 = await exec(tool, { type: "badtype", topic: "lunyu" });
    check("非法 type 报错", !!e3.error && e3.error.includes("type 仅支持"));
    // 未填方法 / 未填文案 / 未登记 html 路径
    const lib2 = openParentLib(tmp, PID);
    lib2.prepare(`INSERT INTO topics (name, topic_key, method) VALUES ('数学', 'math', '')`).run();
    lib2.prepare(`INSERT INTO courses (topic, title, teaching_copy, assess_rubric, html_path) VALUES ('lunyu', '论语为政篇第一章', '', '', '')`).run();
    lib2.close();
    const e4 = await exec(tool, { type: "method", topic: "math" });
    check("未填方法报错", !!e4.error && e4.error.includes("尚未填写教学方法"));
    const e5 = await exec(tool, { type: "htmlPath", topic: "lunyu", course: "论语为政篇第一章" });
    check("未登记 html 路径报错", !!e5.error && e5.error.includes("尚未登记 html 学习资料"));
  }

  console.log("D. 工具白名单");
  {
    const main = computeChildToolNames({ materialPanel: false });
    check("主会话含 get_today_plan", main.includes("get_today_plan"));
    check("主会话含 parent_content", main.includes("parent_content"));
    const scene = computeChildToolNames({ materialPanel: false }, "scene");
    check("场景会话不含计划工具", !scene.includes("get_today_plan") && !scene.includes("parent_content"));
  }

  console.log(failed ? `\n✗ ${failed} 项失败` : "\n✓ 全部通过");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("运行失败：", e);
  process.exit(1);
});
