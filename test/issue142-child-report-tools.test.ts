/**
 * ISSUE-142 回归（2026-09-23）：孩子 agent 撤掉通用读写（child_db_describe / read / write），
 * 改由三个**场景专用只读工具**承接原来只有它能读的四类数据。
 *
 * 覆盖：
 * - `child_points_report`：余额 / 逐日结算（完成率·档位·门槛）/ 流水 / 规则；未过门槛时要能说出"为什么没加分"；
 * - `child_mastery_report`：掌握四列 + 学习结果概要 + 最近考核得分率；概览 / 主题 / 单课三种展开；
 * - `child_exam_result`：已完成场次列表、某一场的逐题结果与每课概要；**未考完的场次不给题**（防泄题）；
 *   不吐内部字段（operator / meta_json 等）；
 * - `child_mistake_log(action=list)`：返回补上关联课程 / 知识点 / "有原题可重做"（ISSUE-137 的缺口）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openKb } from "../server/src/db/kb";
import { createChildReportTools, CHILD_REPORT_TOOL_NAMES } from "../server/src/agent/child-report-tools";
import { createChildDbTools, CHILD_DB_TOOL_NAMES } from "../server/src/agent/child-db-tools";
import { computeChildToolNames } from "../server/src/agent/session-registry";
import { upsertMistake } from "../server/src/db/mistakes";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue142-"));
const parentId = "parent-142";
const childId = "child-142";

const p2 = (n: number) => String(n).padStart(2, "0");
const localDate = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
};
const TODAY = localDate();
const YDAY = daysAgo(1);
const NOW = new Date().toISOString();

function toolText(r: unknown): string {
  return (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("");
}

const kb = openKb(dataDir, parentId, childId);

// —— 学习内容：1 个主题 / 2 门课（一门已掌握、一门需复习）——
kb.prepare("INSERT INTO topics (name, topic_key, learn_type, rules_json) VALUES (?,?,?,?)").run("论语", "lunyu", "required", "{}");
const courseCols = `(topic, topic_key, title, uuid, sort_order, status, last_review, review_count, tags,
  mastery_level, mastery_desc, teaching_advice, mastery_updated_at)`;
kb.prepare(
  `INSERT INTO courses ${courseCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  "lunyu", "lunyu", "学而第一", "uuid-xy1", 1, "✅", `${YDAY} 19:00:00`, 2, "",
  "mastered", "最初只能背前两句，现在能整段背下来。", "可以试着讲讲「学而时习之」的意思。", `${YDAY} 21:30:00`
);
kb.prepare(
  `INSERT INTO courses ${courseCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run("lunyu", "lunyu", "为政第二", "uuid-wz2", 2, "⬜", "", 0, "", "needs_review", "背到一半会卡住。", "多读两遍再背。", `${YDAY} 21:30:00`);

// —— 计划：一条带学习结果概要的学习计划 ——
kb.prepare(
  `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,
    recurrence_id,start_at,due_at,status,result,result_summary,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  "sp-1", parentId, childId, "lunyu", "uuid-xy1", "学而第一", "new", "parent", "conversation", "",
  "", `${YDAY} 18:00:00`, `${YDAY} 20:00:00`, "done", "", "今天把前三句背下来了，第四句还需要提示。", `${YDAY} 19:00:00`,
  "required", 1, 0, 1, NOW, NOW
);

// —— 考核：一场已完成（2 题，1 对 1 错）+ 一场未开始 ——
const examCols = `(id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,start_at,due_at,status,
  attempt_id,score,result,done_at,retake,task_type,count_in_rate,points,active,created_at,updated_at)`;
kb.prepare(`INSERT INTO exam_plans ${examCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "ep-done", parentId, childId, "论语·学而篇考核", "parent", "fixed", "",
  JSON.stringify({ courses: [{ title: "学而第一", kps: [{ name: "背诵", count: 1 }, { name: "句意白话", count: 1 }] }] }),
  "conversation", "", `${YDAY} 20:00:00`, `${YDAY} 20:30:00`, "done", "", 50, "已完成", `${YDAY} 20:30:00`, "",
  "required", 1, 0, 1, NOW, NOW
);
kb.prepare(`INSERT INTO exam_plans ${examCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "ep-todo", parentId, childId, "论语·为政篇考核", "parent", "fixed", "",
  JSON.stringify({ courses: [{ title: "为政第二", kps: [{ name: "背诵", count: 1 }] }] }),
  "conversation", "", `${TODAY} 20:00:00`, `${TODAY} 20:30:00`, "pending", "", null, "", "", "", "required", 1, 0, 1, NOW, NOW
);

const epcCols = `(id,plan_id,course_uuid,course_name,knowledge_point_id,knowledge_point_name,question_id,question_text,
  ref_text,point_got,point_max,correct,ai_comment,asr_text,audio_file_id,duration_ms,behavior,seq,created_at)`;
kb.prepare(`INSERT INTO exam_plan_courses ${epcCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "epc-1", "ep-done", "uuid-xy1", "学而第一", "kp-bei", "背诵", "q-1", "背诵「学而时习之」一段", "学而时习之，不亦说乎？",
  20, 20, 1, "背得很流利，字音准。", "学而时习之不亦说乎", "audio-1", 8200, "speech_recite", 0, NOW
);
kb.prepare(`INSERT INTO exam_plan_courses ${epcCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "epc-2", "ep-done", "uuid-xy1", "学而第一", "kp-ju", "句意白话", "q-2", "「不亦说乎」是什么意思？", "",
  0, 30, 0, "把「说」理解成了说话，这里是通假字，读 yuè，高兴的意思。", "说话的意思", "", 0, "generic", 1, NOW
);
kb.prepare(
  `INSERT INTO exam_course_results (id,parent_id,child_id,plan_id,attempt_ref,topic_key,course_uuid,course_name,exam_at,
    point_got,point_max,rate,question_count,course_summary,plan_review_at,focus_json,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  "ecr-1", parentId, childId, "ep-done", "", "lunyu", "uuid-xy1", "学而第一", `${YDAY} 20:30:00`,
  20, 50, 0.4, 2, "背诵很稳，句意理解还需复习。", "", JSON.stringify(["通假字", "句意白话"]), NOW, NOW
);
kb.prepare(
  `INSERT INTO knowledge_point_records (id,parent_id,child_id,source,plan_id,knowledge_point_id,knowledge_point_name,
    topic_key,course_uuid,course_name,record_at,outcome,point_got,point_max,rate,summary,detail_json,source_ref,created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  "kpr-1", parentId, childId, "exam", "ep-done", "kp-bei", "背诵", "lunyu", "uuid-xy1", "学而第一", `${YDAY} 20:30:00`,
  "solid", 20, 20, 1, "整段流利", "{}", "", NOW
);

// —— 积分：规则 + 余额 + 昨天结算（家长组 100%，孩子组未过门槛）+ 流水 ——
kb.prepare(
  `INSERT INTO reward_configs (child_id,todo_tiers_json,exam_tiers_json,todo_gate_parent_min_rate,exam_gate_parent_min_score,
    child_no_deduct,optional_points,updated) VALUES (?,?,?,?,?,?,?,?)`
).run(childId, "", "", 1.0, 0.9, 1, 5, NOW);
kb.prepare("INSERT INTO points_balance (child_id,balance,updated) VALUES (?,?,?)").run(childId, 128, NOW);
kb.prepare(
  `INSERT INTO reward_daily_stats (child_id,date,source,owner,required_total,required_done,optional_done,missed_count,
    cancelled_count,rate,tier,gate_ok,points_awarded,settled_at,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(childId, YDAY, "todo", "parent", 4, 4, 0, 0, 0, 1.0, "优秀", null, 20, NOW, NOW);
kb.prepare(
  `INSERT INTO reward_daily_stats (child_id,date,source,owner,required_total,required_done,optional_done,missed_count,
    cancelled_count,rate,tier,gate_ok,points_awarded,settled_at,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(childId, YDAY, "todo", "child", 2, 1, 0, 1, 0, 0.5, "合格", 0, 0, NOW, NOW);
kb.prepare(
  `INSERT INTO points_ledger (id,child_id,ts,biz_date,type,amount,balance_after,reason_code,reason,rate,meta_json,
    source_table,source_id,operator,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  "pl-1", childId, `${YDAY}T23:00:00.000Z`, YDAY, "earn", 20, 128, "todo_award",
  "必须完成项·计划完成率 100%，命中「优秀」档 +20", 1.0, "{}", "reward_daily_stats", `${YDAY}|todo|parent`, "system", NOW
);

// —— 错题本：一条带完整关联的错题 ——
upsertMistake(dataDir, parentId, childId, {
  kind: "wrong_question",
  content: "「不亦说乎」的意思",
  detail: "通假字，读 yuè，高兴的意思",
  source: "conversation",
  course_ref: "学而第一",
  knowledge_point_name: "句意白话",
  question_id: "q-2",
});

afterAll(() => {
  try {
    kb.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

const reportTools = createChildReportTools({ dataDir, parentId, childId });
const pointsTool = reportTools.find((t) => t.name === "child_points_report")!;
const masteryTool = reportTools.find((t) => t.name === "child_mastery_report")!;
const examTool = reportTools.find((t) => t.name === "child_exam_result")!;
const mistakeTool = createChildDbTools({ dataDir, parentId, childId }).find((t) => t.name === "child_mistake_log")!;

describe("ISSUE-142 child_points_report（B6 / G1）", () => {
  it("给出余额、规则、逐日结算与流水，并能解释「为什么没加分」", async () => {
    const text = toolText(await pointsTool.execute("x", {}));
    expect(text).toContain("余额：128 分");
    expect(text).toContain("才解锁加分"); // 门槛口径
    expect(text).toContain("100% 优秀 +20"); // 档位规则文字（默认档位）
    expect(text).toContain(YDAY);
    expect(text).toContain("优秀"); // 家长组命中档位
    expect(text).toContain("门槛 **未过**");
    expect(text).toContain("所以没加分"); // 未过门槛的解释
    expect(text).toContain("必须完成项·计划完成率 100%"); // 流水原文
    // 不吐内部字段
    expect(text).not.toContain("operator");
    expect(text).not.toContain("meta_json");
    expect(text).not.toContain("reward_daily_stats");
  });

  it("days 参数越界也会被夹到合理范围（不报错）", async () => {
    const text = toolText(await pointsTool.execute("x", { days: 999 }));
    expect(text).toContain("最近 30 天");
  });
});

describe("ISSUE-142 child_mastery_report（F4 / C1）", () => {
  it("概览：主题进度 + 已掌握/需复习课数", async () => {
    const text = toolText(await masteryTool.execute("x", {}));
    expect(text).toContain("论语");
    expect(text).toContain("已掌握 1 课");
    expect(text).toContain("需要复习 1 课");
  });

  it("按主题展开：逐课带掌握档位与最近考核得分率（掌握四列只有它能读）", async () => {
    const text = toolText(await masteryTool.execute("x", { topic: "论语" }));
    expect(text).toContain("学而第一");
    expect(text).toContain("✅ 已经掌握");
    expect(text).toContain("🔁 需要复习");
    expect(text).toContain("最近考核 40%"); // 来自 exam_course_results / course_progress 视图
  });

  it("按课程展开：给掌握叙述、教学建议与学习结果概要（result_summary）", async () => {
    const text = toolText(await masteryTool.execute("x", { course: "学而第一" }));
    expect(text).toContain("掌握情况：");
    expect(text).toContain("现在能整段背下来");
    expect(text).toContain("下次教学建议：");
    expect(text).toContain("今天把前三句背下来了");
  });

  it("课程名对不上时明确告知，不瞎编", async () => {
    const text = toolText(await masteryTool.execute("x", { course: "不存在的课" }));
    expect(text).toContain("没有找到课程");
  });
});

describe("ISSUE-142 child_exam_result（E7）", () => {
  it("不传 plan_id → 列最近完成的考核（含得分率与范围）", async () => {
    const text = toolText(await examTool.execute("x", {}));
    expect(text).toContain("论语·学而篇考核");
    expect(text).toContain("得分 20/50 = 40%");
    expect(text).toContain("背诵×1"); // 范围展开（parsePlanCourses）
    expect(text).not.toContain("论语·为政篇考核"); // 未完成的场次不出现在"已完成"列表
  });

  it("传 plan_id → 逐题明细 + 每课概要 + 知识点", async () => {
    const text = toolText(await examTool.execute("x", { plan_id: "ep-done" }));
    expect(text).toContain("逐题");
    expect(text).toContain("背诵「学而时习之」一段");
    expect(text).toContain("把「说」理解成了说话"); // AI 评语
    expect(text).toContain("每门课");
    expect(text).toContain("复习重点：通假字、句意白话");
    expect(text).toContain("知识点");
    expect(text).toContain("扎实");
    expect(text).toContain("有录音");
    expect(text).not.toContain("audio-1"); // 只提示"有录音"，不吐内部文件 id
  });

  it("未考完的场次：只给范围，不给题目（防泄题）", async () => {
    const text = toolText(await examTool.execute("x", { plan_id: "ep-todo" }));
    expect(text).toContain("还没考完");
    expect(text).toContain("为政第二"); // 范围可见
    expect(text).not.toContain("逐题"); // 题目不给
  });

  it("course 过滤只回该课的题", async () => {
    const text = toolText(await examTool.execute("x", { plan_id: "ep-done", course: "学而第一" }));
    expect(text).toContain("只看「学而第一」");
    expect(text).not.toContain("为政第二");
  });
});

describe("ISSUE-142 child_mistake_log(list) 返回补关联字段", () => {
  it("list 带上课程 / 知识点 / 有无原题（ISSUE-137 的缺口）", async () => {
    const text = toolText(await mistakeTool.execute("x", { action: "list" }));
    expect(text).toContain("课程：学而第一");
    expect(text).toContain("知识点：句意白话");
    expect(text).toContain("有原题可重做");
  });
});

describe("ISSUE-142 装配层：通用读写撤掉、场景专用工具就位", () => {
  it("孩子主会话工具面不含 child_db_describe / read / write，含三个新报告工具", () => {
    const names = computeChildToolNames({ materialPanel: true }, "main");
    expect(names).not.toContain("child_db_describe");
    expect(names).not.toContain("child_db_read");
    expect(names).not.toContain("child_db_write");
    for (const n of CHILD_REPORT_TOOL_NAMES) expect(names).toContain(n);
    expect(names).toContain("child_mistake_log");
  });

  it("两个常量表与实际工具名一致（防漏装配）", () => {
    expect(CHILD_DB_TOOL_NAMES).toEqual(["child_mistake_log"]);
    expect(CHILD_REPORT_TOOL_NAMES).toEqual(["child_points_report", "child_mastery_report", "child_exam_result"]);
    const created = createChildReportTools({ dataDir, parentId, childId }).map((t) => t.name);
    expect(created.sort()).toEqual([...CHILD_REPORT_TOOL_NAMES].sort());
  });

  it("英语场景会话仍是极窄工具面（不因本次改动被放宽）", () => {
    const scene = computeChildToolNames({ materialPanel: true }, "scene");
    expect(scene).toEqual(["display_content", "scene_command", "get_date"]);
  });
});
