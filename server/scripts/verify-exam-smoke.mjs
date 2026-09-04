/**
 * 学习考核 API 冒烟验证（临时数据目录 + 端口 8899 启动的 dist/server.cjs）。
 * 用法：node scripts/verify-exam-smoke.mjs
 * 覆盖：parent_lib 写 assess_method/assess_rubric → kb 标记已学 → exam/config 下发
 *      → exam/attempts 提交（含 courseMastery/reinforcePlan）→ 家长查询列表 + course-records 聚合。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");

const BASE = "http://127.0.0.1:8899";
const DATA_DIR = "/tmp/exam-smoke-data";
const PARENT_ID = "smoke-parent";
const CHILD_ID = "smoke-child-1";

const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "server-config.json"), "utf-8"));
const token = jwt.sign({ parent_id: PARENT_ID, email: "smoke@test.local", plan: "trial" }, cfg.jwtSecret, { expiresIn: "7d" });
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  if (!cond) failures++;
}

async function api(method, p, body) {
  // DELETE 无 body：去掉 content-type，避免 Fastify 报 FST_ERR_CTP_EMPTY_JSON_BODY
  const headers = method === "DELETE" && !body ? { Authorization: H.Authorization } : H;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// 1) 直接落库：家长 + 孩子（鉴权/归属校验需要）
const dbPath = path.join(DATA_DIR, "server.sqlite");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(dbPath);
const now = new Date().toISOString();
db.prepare("INSERT OR IGNORE INTO parents (id, email, plan, cloud_token, license_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
  .run(PARENT_ID, "smoke@test.local", "trial", "", "{}", now, now);
db.prepare("INSERT OR IGNORE INTO children (id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
  .run(CHILD_ID, PARENT_ID, "冒烟娃", now, now);
db.close();
console.log("→ 已落库测试家长/孩子");

// 2) 家长库写考核配置
let r = await api("POST", "/api/v1/db/exec", { op: "parent_lib.topics.upsert", args: { name: "论语", topic_key: "lunyu", method: "教学法", assess_method: "周期：每天。考核对象：当天学/复习过的知识点。题量：最近3课各1题。" } });
check("parent_lib.topics.upsert 写 assess_method", r.status === 200 && r.json?.result?.ok === true, JSON.stringify(r.json));
r = await api("POST", "/api/v1/db/exec", { op: "parent_lib.courses.upsert", args: { topic: "lunyu", title: "学而篇第一章", sort_order: 1, assess_rubric: "- 能说出「学而时习之」的意思\n- 能举生活例子" } });
check("parent_lib.courses.upsert 写 assess_rubric", r.status === 200 && r.json?.result?.ok === true, JSON.stringify(r.json));
r = await api("POST", "/api/v1/db/exec", { op: "parent_lib.courses.upsert", args: { topic: "lunyu", title: "学而篇第二章", sort_order: 2, assess_rubric: "- 能说出「有朋自远方来」的感受" } });
check("第二课 assess_rubric", r.status === 200, "");

// 3) 孩子库标记已学（考核对象 = 学/复习过的知识点）
r = await api("POST", "/api/v1/db/exec", { op: "kb.courses.upsert", args: { child_id: CHILD_ID, topic: "lunyu", title: "学而篇第一章", sort_order: 1, status: "✅", mastery: "良好", first_learned: "2026-08-30", last_review: "2026-08-31", review_count: 1, exam_mastery: "" } });
check("kb.courses.upsert（已学）", r.status === 200 && r.json?.result?.ok === true, JSON.stringify(r.json));
r = await api("POST", "/api/v1/db/exec", { op: "kb.courses.upsert", args: { child_id: CHILD_ID, topic: "lunyu", title: "学而篇第二章", sort_order: 2, first_learned: "2026-08-31", last_review: "", review_count: 0 } });
check("kb.courses.upsert（已学）②", r.status === 200, "");

// 4) 考核配置下发
r = await api("GET", "/api/v1/exam/config/smoke-child-1");
const cfgOk = r.status === 200 && r.json?.topics?.length === 1 && r.json.topics[0].courses?.length === 2
  && r.json.topics[0].courses[0].assessRubric.includes("学而时习之") && !!r.json.scoringPrompt;
check("exam/config 下发（知识点+rubric+判分prompt）", cfgOk, JSON.stringify(r.json).slice(0, 300));

// 5) 提交考核结果
r = await api("POST", "/api/v1/exam/attempts", {
  childId: CHILD_ID, topic: "lunyu", title: "论语 · 2026-08-31 考核",
  startedAt: "2026-08-31T09:00:00.000Z", submittedAt: "2026-08-31T09:10:00.000Z",
  score: 85,
  perQuestion: [
    { qid: "q1", course: "学而篇第一章", question: "学而时习之什么意思？", audioFileId: "f-voice-1", asrText: "学了之后按时复习，不是很开心吗", startedAt: 1000, answeredAt: 25000, durationMs: 24000, pointGot: 9, pointMax: 10, correct: true, aiComment: "答到要点，举例略少" },
    { qid: "q2", course: "学而篇第二章", question: "有朋自远方来什么感受？", asrText: "朋友来了可以一起玩", durationMs: 20000, pointGot: 4, pointMax: 10, correct: false, aiComment: "只说到玩，没提到快乐与尊重" },
  ],
  courseMastery: { "学而篇第一章": { correct: 1, total: 1, rate: 1 }, "学而篇第二章": { correct: 0, total: 1, rate: 0 } },
  reinforcePlan: { "学而篇第二章": { planReviewAt: "2026-09-02", focus: ["未说出快乐/尊重的感受"], aiSuggestion: "重读本节并举例" } },
  wrongQuestions: ["q2"],
});
check("exam/attempts 提交", r.status === 200 && r.json?.ok === true && !!r.json?.id, JSON.stringify(r.json));

// 6) 家长查询列表 + 每课程记录聚合
r = await api("GET", "/api/v1/exam/attempts/smoke-child-1");
const listOk = r.status === 200 && r.json?.attempts?.length === 1 && r.json.attempts[0].perQuestion?.length === 2;
check("exam/attempts 列表", listOk, JSON.stringify(r.json).slice(0, 200));
r = await api("GET", "/api/v1/exam/course-records/smoke-child-1");
const rec = r.json?.records || [];
const recOk = r.status === 200 && rec.length === 2 && rec.find((x) => x.course === "学而篇第二章")?.rate === 0
  && rec.find((x) => x.course === "学而篇第二章")?.focus?.includes("未说出快乐/尊重的感受");
check("exam/course-records 每课聚合（难点/重点/计划复习）", recOk, JSON.stringify(r.json).slice(0, 300));

// 7) 考核 v2 排期（§14）：固定配置 → 懒生成 → 多档去重 → 自定义 → config 按排期 → 提交关联
r = await api("POST", "/api/v1/exam/fixed-config", { frequencies: ["weekly"], courseCount: 3, time: "20:00", weekly: { weekday: 5, time: "19:30" } });
check("fixed-config 保存（含 weekly 周几配置）", r.status === 200 && r.json?.ok === true && r.json?.config?.frequencies?.includes("weekly") && r.json?.config?.weekly?.weekday === 5, JSON.stringify(r.json));
r = await api("GET", "/api/v1/exam/schedules/smoke-child-1");
const schedOk = r.status === 200 && (r.json?.generated ?? 0) >= 1
  && (r.json?.schedules || []).some((s) => s.kind === "fixed" && s.freq === "weekly");
check("排期懒生成（固定每周）", schedOk, JSON.stringify(r.json)?.slice(0, 200));
const wkSch = (r.json?.schedules || []).find((s) => s.freq === "weekly");
// 2026-09-04：考核只按日期——排期时间即该日本地 0 点（不再带具体时刻）；校验落在配置周几且为当天 0 点
const wkDayOk = wkSch && (() => {
  const d = new Date(wkSch.scheduledAt);
  return d.getDay() === 5 && d.getHours() === 0 && d.getMinutes() === 0;
})();
check("每周排期落在配置的周几、时间取该日 0 点（周五）", !!wkDayOk, wkSch ? wkSch.scheduledAt : "无 weekly 排期");

// v3 §14.9 + 2026-09-03：固定排期候选 = 家长学习计划（study_plan_items，计划内无论是否完成都考核）
// 先给孩子造「近 7 天窗口内」的学习计划（date=weekly 排期所在本地日，含未学课程），再取 config 第一段
const wkLocal = (() => {
  const d = new Date(wkSch.scheduledAt);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();
r = await api("POST", "/api/v1/study-plans", {
  childId: "smoke-child-1", date: wkLocal,
  content: [
    { text: "学而篇第一章", topicKey: "lunyu" },
    { text: "学而篇第二章", topicKey: "lunyu" },
    { text: "学而篇第三章", topicKey: "lunyu" }, // 未学（kb 无学习痕迹）也须进候选
  ],
});
check("study-plan 创建（考核计划源）", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json)?.slice(0, 200));

// 补一条「未学」课程行（status 默认 ⬜、无 first_learned/last_review）——计划内未完成课程也须进候选
r = await api("POST", "/api/v1/db/exec", { op: "kb.courses.upsert", args: { child_id: "smoke-child-1", topic: "lunyu", title: "学而篇第三章", sort_order: 3 } });
check("kb 补未学课程（学而篇第三章）", r.status === 200 && r.json?.result?.ok === true, JSON.stringify(r.json)?.slice(0, 200));

// 固定排期候选清单以计划所在的 weekly 排期为准（wkSch 即计划 date 围绕的排期）
const fixedSch = wkSch;
r = await api("GET", `/api/v1/exam/config/smoke-child-1?schedule=${fixedSch?.id}`);
const cfgSelOk = r.status === 200 && r.json?.schedule?.kind === "fixed"
  && !!r.json?.selectionPrompt && r.json.selectionPrompt.includes("学习计划")
  && r.json.selectionPrompt.includes("计划日期") && r.json.selectionPrompt.includes("无论是否完成")
  && Array.isArray(r.json?.candidates) && r.json.candidates.length >= 2
  && r.json.candidates.some((c) => c.title === "学而篇第一章")
  && r.json.candidates.some((c) => c.title === "学而篇第三章" && !!c.planDate); // 未学课也进候选且带计划日期
check("config 第一段（固定档=学习计划候选，含未完成课）", cfgSelOk, JSON.stringify(r.json)?.slice(0, 300));
r = await api("GET", `/api/v1/exam/config/smoke-child-1?schedule=${fixedSch?.id}&courses=${encodeURIComponent("学而篇第一章,学而篇第二章")}`);
const cfgSel2Ok = r.status === 200 && Array.isArray(r.json?.courses) && r.json.courses.length === 2
  && r.json.courses[0].assessRubric.includes("学而时习之") && !!r.json.scoringPrompt;
check("config 第二段（选中课程 rubric + 判分 prompt）", cfgSel2Ok, JSON.stringify(r.json)?.slice(0, 250));

r = await api("POST", "/api/v1/exam/fixed-config", { frequencies: ["daily", "weekly"], courseCount: 3, selectionPrompts: { monthly: "自定义每月选课规则：每主题选 3 门" } });
check("fixed-config 多档保存 + selectionPrompts", r.status === 200 && r.json?.ok === true && r.json?.config?.selectionPrompts?.monthly?.includes("自定义每月"), JSON.stringify(r.json)?.slice(0, 300));
r = await api("GET", "/api/v1/exam/schedules/smoke-child-1");
const days = (r.json?.schedules || []).map((s) => s.scheduledAt.slice(0, 10));
const dupDays = days.filter((d, i) => days.indexOf(d) !== i);
const hasWeekly = (r.json?.schedules || []).some((s) => s.freq === "weekly");
check("多档去重（同日只保留一档，无重复日期）", dupDays.length === 0 && hasWeekly, `重复=${dupDays.length} weekly=${hasWeekly}`);

r = await api("POST", "/api/v1/exam/schedules", {
  childId: "smoke-child-1", scheduledAt: "2026-09-05T20:00:00",
  scope: { topics: ["lunyu"], courses: ["学而篇第一章"], note: "考学而篇第一章" },
});
const customId = r.json?.id;
check("自定义排期创建", r.status === 200 && r.json?.ok === true && !!customId, JSON.stringify(r.json));
r = await api("GET", `/api/v1/exam/config/smoke-child-1?schedule=${customId}`);
const cfgSchOk = r.status === 200 && r.json?.schedule?.kind === "custom"
  && Array.isArray(r.json?.courses) && r.json.courses.length >= 1
  && r.json.courses[0].title === "学而篇第一章" && !!r.json.courses[0].assessRubric && !!r.json.scoringPrompt;
check("config 按自定义排期选课（scope 指定课程 + rubric）", cfgSchOk, JSON.stringify(r.json)?.slice(0, 250));

// v3.1：自定义排期带考核 prompt → 选课两段式（第一段 selectionPrompt + 候选；第二段 rubric）
r = await api("POST", "/api/v1/exam/schedules", {
  childId: "smoke-child-1", scheduledAt: "2026-09-25T10:00:00",
  scope: { topics: ["lunyu"], note: "带 prompt 的自定义", prompt: "本次考论语的学而篇最近学的 2 门课，每课考完整。" },
});
const cusPid = r.json?.id;
check("自定义排期创建（带 prompt）", r.status === 200 && r.json?.ok === true && !!cusPid, JSON.stringify(r.json));
r = await api("GET", `/api/v1/exam/config/smoke-child-1?schedule=${cusPid}`);
const cusP1Ok = r.status === 200 && r.json?.schedule?.kind === "custom"
  && !!r.json?.selectionPrompt && r.json.selectionPrompt.includes("学而篇")
  && Array.isArray(r.json?.candidates) && r.json.candidates.length >= 1 && !r.json.courses;
check("自定义 config 第一段（家长 prompt + 候选）", cusP1Ok, JSON.stringify(r.json)?.slice(0, 250));
r = await api("GET", `/api/v1/exam/config/smoke-child-1?schedule=${cusPid}&courses=${encodeURIComponent("学而篇第一章,学而篇第二章")}`);
const cusP2Ok = r.status === 200 && Array.isArray(r.json?.courses) && r.json.courses.length >= 1
  && !!r.json.courses[0].assessRubric && !!r.json.scoringPrompt;
check("自定义 config 第二段（选中课程 rubric + 判分 prompt）", cusP2Ok, JSON.stringify(r.json)?.slice(0, 250));
r = await api("DELETE", `/api/v1/exam/schedules/${cusPid}`);
check("清理自定义测试排期", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));

r = await api("POST", "/api/v1/exam/attempts", {
  childId: "smoke-child-1", topic: "lunyu", title: "排期考核提交", score: 90,
  perQuestion: [{ qid: "q1", course: "学而篇第一章", question: "q", asrText: "a", pointGot: 9, pointMax: 10, correct: true, aiComment: "ok" }],
  courseMastery: {}, reinforcePlan: {}, wrongQuestions: [], scheduleId: customId,
});
check("提交关联排期", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));
r = await api("GET", "/api/v1/exam/schedules/smoke-child-1");
const doneSch = (r.json?.schedules || []).find((s) => s.id === customId);
check("排期标记完成（done + attempt_id）", doneSch?.status === "done" && !!doneSch?.attemptId, JSON.stringify(doneSch));

// 8) 归属校验：他人 token 应 403
const otherToken = jwt.sign({ parent_id: "other-parent", email: "x@y.z", plan: "trial" }, cfg.jwtSecret, { expiresIn: "7d" });
const res = await fetch(`${BASE}/api/v1/exam/config/smoke-child-1`, { headers: { Authorization: `Bearer ${otherToken}` } });
check("跨家长访问被拒(403)", res.status === 403, `status=${res.status}`);

console.log(failures === 0 ? "\n✅ 冒烟全部通过" : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
