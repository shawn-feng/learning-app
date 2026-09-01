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
  const res = await fetch(`${BASE}${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
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

// 7) 归属校验：他人 token 应 403
const otherToken = jwt.sign({ parent_id: "other-parent", email: "x@y.z", plan: "trial" }, cfg.jwtSecret, { expiresIn: "7d" });
const res = await fetch(`${BASE}/api/v1/exam/config/smoke-child-1`, { headers: { Authorization: `Bearer ${otherToken}` } });
check("跨家长访问被拒(403)", res.status === 403, `status=${res.status}`);

console.log(failures === 0 ? "\n✅ 冒烟全部通过" : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
