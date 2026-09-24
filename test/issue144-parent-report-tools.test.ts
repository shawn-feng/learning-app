/**
 * ISSUE-144 **P4** 回归（2026-09-25）：家长侧的**场景专用只读工具**。
 *
 * 为什么要有这三个（台账 §3.2「退场前置」）：家长问"考得怎么样 / 哪里薄弱 / 这分怎么算的"时，
 * 此前唯一的读数路径是通用通道 `parent_db_read`（对孩子库逐表拉行）——**有数据、没口径**。
 * 本文件覆盖：
 * - `parent_child_exam_report`：最近几场（含整体得分率与趋势）、某一场的逐题 + 每课概要 + 知识点档位；
 *   **未考完的场次只给范围、不给题**（防家长转述给孩子）；
 * - `parent_child_mastery_report`：概览（主题进度 + 薄弱项/错题本）/ 主题（逐课 + 要盯的知识点）/ 单课
 *   （掌握叙述 + 教学建议 + 知识点档位 + 学习结果 + 本课错题）；"还没分析过"不许读成"学得差"；
 * - `parent_child_points_report`：余额 + 规则（家长组直接评档、加分项看门槛、次日日终结算）+ 逐日结算
 *   （完成率/漏项/档位/门槛）+ 流水 + 已提交未发放的兑换（**提交时就扣分**）；
 * - 对象定位：`child` 姓名（名下唯一可省略）、越权/不存在要报可选名字、多孩子时必须问清；
 * - **不吐内部字段**（operator / meta_json / source_table / question_id / audio_file_id / course_uuid / 行 id）；
 * - 场景归属：两把归 `parent-scene-progress`、一把归 `parent-scene-points`（守卫据此生效）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { upsertMistake } from "../server/src/db/mistakes";
import {
  PARENT_CHILD_REPORT_TOOL_NAMES,
  createParentChildReportTools,
} from "../server/src/agent/parent-child-report-tools";
// 场景归属的真源＝各技能声明的 tools 清单（守卫据此生效）
import { scenesOfTool } from "../server/src/agent/parent-tool-compact";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue144-p4-"));
const db = openDb(dataDir);

const parentId = "parent-p4";
const childId = "kid-p4"; // 独生子：child 参数可省略
const multiParentId = "parent-p4-multi"; // 两个孩子：必须问清是哪个
const NOW = new Date().toISOString();

const p2 = (n: number) => String(n).padStart(2, "0");
const localDate = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
};
const TODAY = localDate();
const YDAY = daysAgo(1);
const TOMORROW = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localDate(d);
})();

for (const pid of [parentId, multiParentId]) {
  db.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(
    pid,
    `${pid}@test`,
    NOW,
    NOW
  );
}
db.prepare("INSERT INTO children (id,parent_id,name,profile_json,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(
  childId,
  parentId,
  "珊珊",
  JSON.stringify({ aiName: "饺子" }),
  NOW,
  NOW
);
for (const [id, name] of [
  ["kid-a", "珊珊"],
  ["kid-b", "乐乐"],
] as const) {
  db.prepare("INSERT INTO children (id,parent_id,name,profile_json,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(
    id,
    multiParentId,
    name,
    "{}",
    NOW,
    NOW
  );
}

function toolText(r: unknown): string {
  return (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("");
}

// ==================== 孩子库（珊珊） ====================
const kb = openKb(dataDir, parentId, childId);
kb.prepare("INSERT INTO topics (name, topic_key, learn_type, rules_json) VALUES (?,?,?,?)").run(
  "论语",
  "lunyu",
  "required",
  "{}"
);
const courseCols = `(topic, topic_key, title, uuid, sort_order, status, last_review, review_count, tags,
  mastery_level, mastery_desc, teaching_advice, mastery_updated_at)`;
kb.prepare(`INSERT INTO courses ${courseCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "lunyu",
  "lunyu",
  "学而第一",
  "uuid-xy1",
  1,
  "✅",
  `${YDAY} 19:00:00`,
  2,
  "",
  "mastered",
  "最初只能背前两句，现在能整段背下来。",
  "可以试着讲讲「学而时习之」的意思。",
  `${YDAY} 21:30:00`
);
kb.prepare(`INSERT INTO courses ${courseCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "lunyu",
  "lunyu",
  "为政第二",
  "uuid-wz2",
  2,
  "⬜",
  "",
  0,
  "",
  "needs_review",
  "背到一半会卡住。",
  "多读两遍再背。",
  `${YDAY} 21:30:00`
);
// 第三课刻意**没有掌握档位**（"还没分析过" ≠ "学得差"）
kb.prepare(`INSERT INTO courses ${courseCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "lunyu",
  "lunyu",
  "述而第七",
  "uuid-se7",
  3,
  "⬜",
  "",
  0,
  "",
  "",
  "",
  "",
  ""
);

// 学习结果
kb.prepare(
  `INSERT INTO study_plans (id,parent_id,child_id,topic_key,course_uuid,course_name,mode,creator,origin,carry_from,
    recurrence_id,start_at,due_at,status,result,result_summary,done_at,task_type,count_in_rate,points,active,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  "sp-1",
  parentId,
  childId,
  "lunyu",
  "uuid-xy1",
  "学而第一",
  "new",
  "parent",
  "conversation",
  "",
  "",
  `${YDAY} 18:00:00`,
  `${YDAY} 20:00:00`,
  "done",
  "",
  "今天把前三句背下来了，第四句还需要提示。",
  `${YDAY} 19:00:00`,
  "required",
  1,
  0,
  1,
  NOW,
  NOW
);

// 考核：一场较早（40%）+ 一场较新（100%）+ 一场未考
const examCols = `(id,parent_id,child_id,title,creator,kind,freq,scope_json,origin,recurrence_id,start_at,due_at,status,
  attempt_id,score,result,done_at,retake,task_type,count_in_rate,points,active,created_at,updated_at)`;
kb.prepare(`INSERT INTO exam_plans ${examCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "ep-old",
  parentId,
  childId,
  "论语·学而篇考核",
  "parent",
  "fixed",
  "",
  JSON.stringify({ courses: [{ title: "学而第一", kps: [{ name: "背诵", count: 1 }, { name: "句意白话", count: 1 }] }] }),
  "conversation",
  "",
  `${YDAY} 20:00:00`,
  `${YDAY} 20:30:00`,
  "done",
  "",
  40,
  "已完成",
  `${YDAY} 20:30:00`,
  "",
  "required",
  1,
  0,
  1,
  NOW,
  NOW
);
kb.prepare(`INSERT INTO exam_plans ${examCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "ep-new",
  parentId,
  childId,
  "论语·为政篇背诵考核",
  "parent",
  "fixed",
  "",
  JSON.stringify({ courses: [{ title: "为政第二", kps: [{ name: "背诵", count: 1 }] }] }),
  "conversation",
  "",
  `${TODAY} 19:00:00`,
  `${TODAY} 19:30:00`,
  "done",
  "",
  100,
  "已完成",
  `${TODAY} 19:30:00`,
  "",
  "required",
  1,
  0,
  1,
  NOW,
  NOW
);
kb.prepare(`INSERT INTO exam_plans ${examCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "ep-todo",
  parentId,
  childId,
  "论语·述而篇考核",
  "parent",
  "fixed",
  "",
  JSON.stringify({ courses: [{ title: "述而第七", kps: [{ name: "背诵", count: 1 }] }] }),
  "conversation",
  "",
  `${TOMORROW} 20:00:00`,
  `${TOMORROW} 20:30:00`,
  "pending",
  "",
  null,
  "",
  "",
  "",
  "required",
  1,
  0,
  1,
  NOW,
  NOW
);

const epcCols = `(id,plan_id,course_uuid,course_name,knowledge_point_id,knowledge_point_name,question_id,question_text,
  ref_text,point_got,point_max,correct,ai_comment,asr_text,audio_file_id,duration_ms,behavior,seq,created_at)`;
kb.prepare(`INSERT INTO exam_plan_courses ${epcCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "epc-1",
  "ep-old",
  "uuid-xy1",
  "学而第一",
  "kp-bei",
  "背诵",
  "q-1",
  "背诵「学而时习之」一段",
  "学而时习之，不亦说乎？",
  20,
  20,
  1,
  "背得很流利，字音准。",
  "学而时习之不亦说乎",
  "audio-1",
  8200,
  "speech_recite",
  0,
  NOW
);
kb.prepare(`INSERT INTO exam_plan_courses ${epcCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "epc-2",
  "ep-old",
  "uuid-xy1",
  "学而第一",
  "kp-ju",
  "句意白话",
  "q-2",
  "「不亦说乎」是什么意思？",
  "",
  0,
  30,
  0,
  "把「说」理解成了说话，这里是通假字，读 yuè，高兴的意思。",
  "说话的意思",
  "",
  0,
  "generic",
  1,
  NOW
);
kb.prepare(`INSERT INTO exam_plan_courses ${epcCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "epc-3",
  "ep-new",
  "uuid-wz2",
  "为政第二",
  "kp-bei",
  "背诵",
  "q-3",
  "背诵「为政以德」一段",
  "为政以德，譬如北辰。",
  20,
  20,
  1,
  "很熟。",
  "为政以德譬如北辰",
  "",
  0,
  "speech_recite",
  0,
  NOW
);
// 未考完的那场**故意也有题**（抽题后回填）——工具必须仍然不给题
kb.prepare(`INSERT INTO exam_plan_courses ${epcCols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "epc-4",
  "ep-todo",
  "uuid-se7",
  "述而第七",
  "kp-bei",
  "背诵",
  "q-4",
  "背诵「述而不作」一段",
  "述而不作，信而好古。",
  null,
  20,
  null,
  "",
  "",
  "",
  0,
  "speech_recite",
  0,
  NOW
);
kb.prepare(
  `INSERT INTO exam_course_results (id,parent_id,child_id,plan_id,attempt_ref,topic_key,course_uuid,course_name,exam_at,
    point_got,point_max,rate,question_count,course_summary,plan_review_at,focus_json,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  "ecr-1",
  parentId,
  childId,
  "ep-old",
  "",
  "lunyu",
  "uuid-xy1",
  "学而第一",
  `${YDAY} 20:30:00`,
  20,
  50,
  0.4,
  2,
  "背诵很稳，句意理解还需复习。",
  "",
  JSON.stringify(["通假字", "句意白话"]),
  NOW,
  NOW
);
kb.prepare(
  `INSERT INTO knowledge_point_records (id,parent_id,child_id,source,plan_id,knowledge_point_id,knowledge_point_name,
    topic_key,course_uuid,course_name,record_at,outcome,point_got,point_max,rate,summary,detail_json,source_ref,created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  "kpr-1",
  parentId,
  childId,
  "exam",
  "ep-old",
  "kp-bei",
  "背诵",
  "lunyu",
  "uuid-xy1",
  "学而第一",
  `${YDAY} 20:30:00`,
  "solid",
  20,
  20,
  1,
  "整段流利",
  "{}",
  "",
  NOW
);
// 知识点累计档位（D5："《静夜思》的背诵到底会不会" 就是看这一层）
kb.prepare(
  `INSERT INTO knowledge_point_progress (parent_id,child_id,knowledge_point_id,knowledge_point_name,course_uuid,
    course_name,level,mastery_desc,study_count,exam_count,last_outcome,last_rate,first_at,last_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  parentId,
  childId,
  "kp-bei",
  "背诵",
  "uuid-xy1",
  "学而第一",
  "mastered",
  "一开始要提示，现在整段能背。",
  3,
  1,
  "solid",
  1,
  `${daysAgo(20)} 10:00:00`,
  `${YDAY} 19:00:00`,
  NOW
);
kb.prepare(
  `INSERT INTO knowledge_point_progress (parent_id,child_id,knowledge_point_id,knowledge_point_name,course_uuid,
    course_name,level,mastery_desc,study_count,exam_count,last_outcome,last_rate,first_at,last_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  parentId,
  childId,
  "kp-ju",
  "句意白话",
  "uuid-xy1",
  "学而第一",
  "needs_review",
  "通假字理解反了。",
  2,
  1,
  "weak",
  0,
  `${daysAgo(20)} 10:00:00`,
  `${YDAY} 19:00:00`,
  NOW
);

// 错题本：同一条错题出现 3 次（count=3）；另一条生字挂在为政第二
for (let i = 0; i < 3; i++) {
  upsertMistake(dataDir, parentId, childId, {
    kind: "wrong_question",
    content: "「不亦说乎」的意思",
    detail: "通假字，读 yuè，高兴的意思",
    source: "conversation",
    course_ref: "学而第一",
    knowledge_point_name: "句意白话",
    question_id: "q-2",
  });
}
upsertMistake(dataDir, parentId, childId, {
  kind: "unknown_word",
  content: "北辰",
  detail: "北极星",
  source: "conversation",
  course_ref: "为政第二",
  knowledge_point_name: "字词",
});

// 积分：规则 + 余额 + 昨天结算（家长组 100% 优秀 +20；孩子组 50% 且门槛未过）+ 流水
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
  "pl-1",
  childId,
  `${YDAY}T23:00:00.000Z`,
  YDAY,
  "earn",
  20,
  128,
  "todo_award",
  "必须完成项·计划完成率 100%，命中「优秀」档 +20",
  1.0,
  JSON.stringify({ operator: "system" }),
  "reward_daily_stats",
  `${YDAY}|todo|parent`,
  "system",
  NOW
);
// 兑换：目录 + 一条已提交未发放（提交时即扣分，写 type='redeem' 流水）
kb.prepare(
  `INSERT INTO redemption_items (id,child_id,name,cost,kind,payload_json,enabled,updated) VALUES (?,?,?,?,?,?,?,?)`
).run("ri-1", childId, "周末去游乐园", 80, "inapp", "{}", 1, NOW);
kb.prepare(
  `INSERT INTO redemption_requests (id,child_id,item_id,custom_desc,cost,status,parent_id,fulfilled_at,created_at)
   VALUES (?,?,?,?,?,?,?,?,?)`
).run("rr-1", childId, "ri-1", "想去欢乐谷", 80, "pending", parentId, "", `${YDAY}T10:00:00.000Z`);
kb.prepare(
  `INSERT INTO points_ledger (id,child_id,ts,biz_date,type,amount,balance_after,reason_code,reason,rate,meta_json,
    source_table,source_id,operator,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  "pl-2",
  childId,
  `${YDAY}T10:00:00.000Z`,
  YDAY,
  "redeem",
  80,
  48,
  "redeem",
  "想去欢乐谷",
  null,
  "{}",
  "redemption_requests",
  "rr-1",
  "parent",
  NOW
);

afterAll(() => {
  try {
    kb.close();
  } catch {
    /* 忽略 */
  }
  try {
    db.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

const tools = createParentChildReportTools({ db, dataDir, parentId });
const examTool: any = tools.find((t) => t.name === "parent_child_exam_report")!;
const masteryTool: any = tools.find((t) => t.name === "parent_child_mastery_report")!;
const pointsTool: any = tools.find((t) => t.name === "parent_child_points_report")!;

describe("ISSUE-144 P4 · parent_child_exam_report（D1）", () => {
  it("不传 plan_id → 最近几场已完成的考核 + 整体得分率与趋势 + 待考场次", async () => {
    const text = toolText(await examTool.execute("x", { child: "珊珊" }));
    expect(text).toContain("「珊珊」最近已完成的考核");
    expect(text).toContain("【整体】");
    expect(text).toContain("40% → 100%"); // 按时间从早到晚
    expect(text).toContain("最近一次 100%（比上一次高）");
    expect(text).toContain("得分 20/50 = 40%");
    expect(text).toContain("错 1 题");
    expect(text).toContain("背诵×1"); // 范围展开（parsePlanCourses）
    expect(text).toContain("id=ep-old"); // 追问某一场要用它
    expect(text).toContain("还没考完的：");
    expect(text).toContain("论语·述而篇考核");
  });

  it("传 plan_id → 逐题明细（题干/原文/孩子答的/评语/有无录音）+ 每课概要 + 知识点档位", async () => {
    const text = toolText(await examTool.execute("x", { child: "珊珊", plan_id: "ep-old" }));
    expect(text).toContain("得分 20/50（40%）");
    expect(text).toContain("【每门课】");
    expect(text).toContain("复习重点：通假字、句意白话");
    expect(text).toContain("【知识点】");
    expect(text).toContain("背诵：扎实");
    expect(text).toContain("【逐题】");
    expect(text).toContain("背诵「学而时习之」一段");
    expect(text).toContain("孩子答的：说话的意思");
    expect(text).toContain("老师评语：把「说」理解成了说话");
    expect(text).toContain("（有录音）");
    // 内部字段一律不吐
    for (const leak of ["audio-1", "q-1", "q-2", "kp-bei", "kp-ju", "uuid-xy1", "epc-1"]) {
      expect(text, `泄漏内部字段 ${leak}`).not.toContain(leak);
    }
  });

  it("未考完的场次：只给范围，不给题目（家长可能转述给孩子）", async () => {
    const text = toolText(await examTool.execute("x", { child: "珊珊", plan_id: "ep-todo" }));
    expect(text).toContain("还没考完");
    expect(text).toContain("述而第七"); // 范围可见
    expect(text).not.toContain("【逐题】"); // 明细段不给
    expect(text).not.toContain("述而不作"); // 题目一个字都不给
  });

  it("course 过滤只回该课的题；不存在的 plan_id 给出可读提示", async () => {
    const one = toolText(await examTool.execute("x", { child: "珊珊", plan_id: "ep-old", course: "学而第一" }));
    expect(one).toContain("只看「学而第一」");
    expect(one).not.toContain("为政以德");
    const miss = toolText(await examTool.execute("x", { child: "珊珊", plan_id: "ep-nope" }));
    expect(miss).toContain("没有找到这场考核");
  });
});

describe("ISSUE-144 P4 · parent_child_mastery_report（D5 + D3）", () => {
  it("概览：主题进度 + 已掌握/需要复习/还没分析过 + 薄弱项（错题本按 kind 聚合）", async () => {
    const text = toolText(await masteryTool.execute("x", { child: "珊珊" }));
    expect(text).toContain("「珊珊」的学习情况");
    expect(text).toContain("论语（必学）：已学 1/3");
    expect(text).toContain("已掌握 1 课");
    expect(text).toContain("需要复习 1 课");
    expect(text).toContain("1 课还没分析过"); // 述而第七：没分析过 ≠ 学得差
    expect(text).toContain("薄弱项（错题本，未关闭）");
    expect(text).toContain("错题 1 条（本周新增 1 条）");
    expect(text).toContain("「不亦说乎」的意思」（×3"); // count 越大＝越没掌握
    expect(text).toContain("句意白话");
    expect(text).toContain("生字 1 条");
  });

  it("按主题展开：逐课（掌握档位 / 最近学习 / 复习次数 / 最近考核）+ 要盯的知识点 + 该主题错题", async () => {
    const text = toolText(await masteryTool.execute("x", { child: "珊珊", topic: "论语" }));
    expect(text).toContain("主题「论语」（必学）");
    expect(text).toContain("已学 1/3 课，下一课「为政第二」");
    expect(text).toContain("✅ 已经掌握");
    expect(text).toContain("🔁 需要复习");
    expect(text).toContain("最近考核 40%");
    expect(text).toContain("复习 2 次");
    expect(text).toContain("需要盯的知识点：");
    expect(text).toContain("句意白话：🔁 需要复习");
    expect(text).toContain("通假字理解反了");
    expect(text).toContain("「不亦说乎」的意思"); // 本主题错题
    expect(text).toContain("北辰"); // 为政第二也在这个主题下 → 应当带出来
  });

  it("按课程展开：掌握叙述 + 教学建议 + 知识点档位 + 学习结果 + 本课错题", async () => {
    const text = toolText(await masteryTool.execute("x", { child: "珊珊", course: "学而第一" }));
    expect(text).toContain("课程「学而第一」（主题 论语）");
    expect(text).toContain("掌握：✅ 已经掌握");
    expect(text).toContain("掌握情况：最初只能背前两句");
    expect(text).toContain("下次教学建议：可以试着讲讲");
    expect(text).toContain("知识点掌握：");
    expect(text).toContain("背诵：✅ 已经掌握 · 学 3 次 / 考 1 次");
    expect(text).toContain("句意白话：🔁 需要复习");
    expect(text).toContain("最近几次学习结果：");
    expect(text).toContain("今天把前三句背下来了");
    expect(text).toContain("本课错题本（未关闭）：");
    expect(text).not.toContain("北辰"); // 单课视角只带本课错题（为政第二的不混进来）
  });

  it("没分析过的课如实说「还没分析过」，课名对不上时不瞎编", async () => {
    const blank = toolText(await masteryTool.execute("x", { child: "珊珊", course: "述而第七" }));
    expect(blank).toContain("（还没分析过）");
    expect(blank).toContain("还没生成掌握分析");
    const miss = toolText(await masteryTool.execute("x", { child: "珊珊", course: "不存在的课" }));
    expect(miss).toContain("没有找到课程");
    const badTopic = toolText(await masteryTool.execute("x", { child: "珊珊", topic: "不存在的主题" }));
    expect(badTopic).toContain("没有找到主题");
  });
});

describe("ISSUE-144 P4 · parent_child_points_report（F3 + F2）", () => {
  it("余额 + 规则（家长组直接评档 / 加分项看门槛 / 次日结算）+ 结算行 + 流水", async () => {
    const text = toolText(await pointsTool.execute("x", { child: "珊珊" }));
    expect(text).toContain("「珊珊」的积分");
    expect(text).toContain("**余额：128 分**");
    expect(text).toContain("按完成率直接评档");
    expect(text).toContain("100% 优秀 +20"); // 档位规则文字（默认档位）
    expect(text).toContain("要当天家长组的必做项达标才解锁");
    expect(text).toContain("结算在次日日终做");
    expect(text).toContain("计划 · 家长排的（必做项） · 完成 4/4 = 100%");
    expect(text).toContain("门槛 **未过**");
    expect(text).toContain("所以没加分"); // 未过门槛的解释
    expect(text).toContain("漏 1 项");
    expect(text).toContain("必须完成项·计划完成率 100%");
  });

  it("兑换：提交时就已扣分，只列未发放（不要说成「还没扣分」）", async () => {
    const text = toolText(await pointsTool.execute("x", { child: "珊珊" }));
    expect(text).toContain("【兑换（已提交、还没标记发放）】");
    expect(text).toContain("「周末去游乐园」");
    expect(text).toContain("想去欢乐谷");
    expect(text).toContain("扣 80 分");
    expect(text).toContain("提交时就扣分");
    expect(text).toContain("发放在对话里没有入口");
  });

  it("days 越界被夹到合理范围；不吐内部字段", async () => {
    const text = toolText(await pointsTool.execute("x", { child: "珊珊", days: 999 }));
    expect(text).toContain("最近 30 天");
    for (const leak of ["operator", "meta_json", "reward_daily_stats", "points_ledger", "redemption_requests", "ri-1", "rr-1"]) {
      expect(text, `泄漏内部字段 ${leak}`).not.toContain(leak);
    }
  });
});

describe("ISSUE-144 P4 · 对象定位（child 姓名）", () => {
  it("名下只有一个孩子时 child 可省略；给了名字就按名字定位", async () => {
    const text = toolText(await pointsTool.execute("x", {}));
    expect(text).toContain("「珊珊」的积分");
  });

  it("名字不存在 → 报错并列出可选名字（不猜）", async () => {
    await expect(pointsTool.execute("x", { child: "查无此人" })).rejects.toThrow(/找不到孩子「查无此人」/);
    await expect(pointsTool.execute("x", { child: "查无此人" })).rejects.toThrow(/现有孩子：珊珊/);
  });

  it("名下有多个孩子又没有指定 → 必须问清（不当场挑一个）", async () => {
    const multi: any = createParentChildReportTools({ db, dataDir, parentId: multiParentId }).find(
      (t) => t.name === "parent_child_points_report"
    )!;
    await expect(multi.execute("x", {})).rejects.toThrow(/要看哪个孩子/);
    await expect(multi.execute("x", {})).rejects.toThrow(/珊珊/);
    await expect(multi.execute("x", {})).rejects.toThrow(/乐乐/);
  });

  it("越权：别家的孩子读不到（归属校验）", async () => {
    await expect(pointsTool.execute("x", { child: "乐乐" })).rejects.toThrow(/找不到孩子/);
  });
});

describe("ISSUE-144 P4 · 装配与场景归属", () => {
  it("三把工具名与常量一致（防漏装配）", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...PARENT_CHILD_REPORT_TOOL_NAMES].sort());
  });

  it("场景归属：exam / mastery → parent-scene-progress，points → parent-scene-points", () => {
    expect(scenesOfTool("parent_child_exam_report")).toEqual(["parent-scene-progress"]);
    expect(scenesOfTool("parent_child_mastery_report")).toEqual(["parent-scene-progress"]);
    expect(scenesOfTool("parent_child_points_report")).toEqual(["parent-scene-points"]);
  });

  it("工具描述只有一句自述（口径在技能里，进上下文前还会被压一遍）", () => {
    for (const t of tools) {
      const desc = String(t.description ?? "");
      expect(desc.length, `${t.name} 描述过长`).toBeLessThanOrEqual(160);
      expect(desc, `${t.name} 描述里不该出现口径正文`).not.toContain("**");
    }
  });
});
