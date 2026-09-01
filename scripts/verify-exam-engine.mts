/**
 * 学习考核客户端引擎验证（本机 127 开发服务端 + 本地 LLM）。
 * ⚠️ v3 流程（EXAM-REQUIREMENTS §14.9）已取代 v2 的服务端代码选课：
 * 真实链路 = GET /exam/schedules → POST /schedules/:id/start →
 *   GET /exam/config?schedule=<id>（第一段：selectionPrompt + candidates，无 rubric）→
 *   selectCoursesForSchedule(selectionPrompt, childId)（客户端 LLM 按 ★ 标记选课）→
 *   GET /exam/config?schedule=<id>&courses=t1,t2（第二段：courses[] 含 rubric + scoringPrompt）→
 *   generateExamQuestions（逐课并发出题，并发 3）→ 判分（scoreExamAttempt）。
 * 自定义排期（scope 指定范围）跳过选课 LLM，第一段即返回 courses[]。
 * 本文保留为引擎函数调用的最小参考（选课/出卷/判分内存 session 语义）。
 *
 * ⚠️ 运行方式：pi-coding-agent 包无 "exports" main，tsx / vite-node 均无法直接 import（ERR_PACKAGE_PATH_NOT_EXPORTED）。
 * 需把本文件复制为 test/verify-exam-engine.test.ts 用 `npx vitest run test/verify-exam-engine.test.ts` 跑
 * （约 80~150s，调真实 LLM + 依赖 8788 服务端），跑完删除该 test 文件；并需先按日志把真实 auth.json +
 * app-settings.json 拷到 $TEMP/pi-test-data/parents/<pid>/（vitest 隔离）再 setCurrentParentId。
 * 2026-09-01 实测通过：选课 LLM 按 ★ 标记精确选窗口内课程、逐课出题覆盖、判分质量合理。
 * 期间发现并修复：判分 prompt 未注入今天日期 → planReviewAt 输出错误年份（2025-03-24）；
 * 修复 = server/src/routes/exam.ts buildScoringPrompt() 下发时替换 {{TODAY}}。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import { setCurrentParentId } from "../electron/lib/config";
import { generateExamQuestions, scoreExamAttempt } from "../electron/lib/exam-engine";

const PARENT_ID = "86a84278-c8ae-415e-8fbc-6140b1b7c88e";
const CHILD_ID = "09406c05-d373-448a-95ac-c5ebbba9a0e5";
const MERGED = path.join(root, "lunyu_exam", "merged");
const TITLES = ["论语为政篇第一章", "论语为政篇第二章", "论语为政篇第三章"];

const ASSESS_METHOD =
  "周期：每天。考核对象：该周期内学/复习过的知识点（课程）。题量：最近学的 3 课各出 1 道口述题（不超过 8 题）。评分口径：按该课「考核内容」（知识点+题目+评分标准）逐点给分，10 分满分，达 60% 记正确。";

async function main() {
  setCurrentParentId(PARENT_ID); // 让 getAuthPath 落到真实家长的 auth.json（含 LLM key）

  // 1) 构造 topicConfig（rubric = merged 合并 markdown 全文）
  const courses = TITLES.map((title, i) => {
    const f = path.join(MERGED, `${title}.md`);
    if (!fs.existsSync(f)) throw new Error(`缺少合并文件: ${f}`);
    return {
      title,
      firstLearned: "2026-09-01",
      lastReview: "2026-09-01",
      mastery: "良好",
      assessRubric: fs.readFileSync(f, "utf-8"),
    };
  });
  const topicConfig = { topicKey: "lunyu", name: "论语", assessMethod: ASSESS_METHOD, courses };
  console.log(`→ topicConfig 就绪（${courses.length} 课，rubric 总长 ${courses.reduce((s, c) => s + c.assessRubric.length, 0)} 字符）`);

  // 2) 出卷
  console.log("\n===== 出卷（客户端内存 session）=====");
  const questions = await generateExamQuestions(topicConfig, CHILD_ID);
  console.log(`出卷 ${questions.length} 题：`);
  for (const q of questions) console.log(`  [${q.qid}] ${q.course}（${q.pointMax}分）: ${q.stem.slice(0, 70)}${q.stem.length > 70 ? "…" : ""}`);

  // 3) 判分（prompt 从服务端拉）
  console.log("\n===== 判分（prompt 取自服务端）=====");
  const jwt = require(path.join(root, "server", "node_modules", "jsonwebtoken"));
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "server", "data", "server-config.json"), "utf-8"));
  const token = jwt.sign({ parent_id: PARENT_ID, email: "test@local", plan: "trial" }, cfg.jwtSecret, { expiresIn: "7d" });
  const res = await fetch(`http://127.0.0.1:8788/api/v1/exam/config/${CHILD_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const configData = await res.json();
  const scoringPrompt = configData.scoringPrompt || "";
  console.log(`scoringPrompt 已获取（${scoringPrompt.length} 字符，来自服务端）`);

  // mock 答案：q1 答得好、q2 答错、q3 半对（基于出卷题干构造）
  const answers = questions.map((q, i) => {
    const good = "为政以德就是说用好的品德来带领大家，就像北极星稳稳地待在位置上，其他星星都围着它转。因为品德好，大家从心里佩服，自愿跟着他，而不是靠命令。比如我们班小组长总是帮助同学、公平做事，大家都喜欢她，愿意听她的话。";
    const bad = "不知道，没学过。";
    const half = "就是要有品德，北极星很亮。别的我不太会说了。";
    return { qid: q.qid, course: q.course, stem: q.stem, pointMax: q.pointMax, rubric: courses.find((c) => c.title === q.course)?.assessRubric || "", asrText: [good, bad, half][i % 3], durationMs: 15000 + i * 3000 };
  });
  const scored = await scoreExamAttempt(scoringPrompt, answers, CHILD_ID);
  console.log(`总分: ${scored.score}/100 | 总评: ${scored.overall}`);
  for (const q of scored.perQuestion) console.log(`  [${q.qid}] ${q.correct ? "✓" : "✗"} ${q.pointGot} 分 | ${q.aiComment}`);
  console.log("courseMastery:", JSON.stringify(scored.courseMastery));
  console.log("reinforcePlan:", JSON.stringify(scored.reinforcePlan, null, 1).slice(0, 400));
  console.log("\n✅ 引擎链路验证完成");
}

main().catch((e) => {
  console.error("❌ 验证失败:", e);
  process.exit(1);
});
