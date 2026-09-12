/**
 * P3-b 冒烟：考核 LLM 链路服务端化（出题 / 判分 / 判分口径 / 审计 / 路由）。
 * 用法：npx tsx scripts/exam-agent-check.mts
 *
 * 刻意不烧 token：LLM 只验证到「进入模型边界」（无 key 时干净报错），纯函数部分（prompt 组装、
 * JSON 提取、选择题规则判分、审计落盘）做完整断言。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import {
  buildCourseGenerationPrompt,
  buildScorePrompt,
  extractJson,
  judgeChoice,
  auditExamEvent,
  type ExamAnswerIn,
} from "../src/agent/exam-engine.js";
import { registerExamAgentRoutes } from "../src/routes/exam-agent.js";
import { signSession } from "../src/auth/jwt.js";
import { SERVER_FEATURES } from "../src/routes/version.js";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-exam-agent-check-"));
const SECRET = "check-secret";

async function main() {
  console.log("A. JSON 提取（模型输出容错）");
  check("标准 JSON", extractJson('{"questions":[{"qid":"q1"}]}')?.questions?.length === 1);
  check("markdown 围栏", extractJson('```json\n{"perQuestion":[{"qid":"q1"}]}\n```')?.perQuestion?.length === 1);
  check("前后有说明文字", extractJson('好的，结果是：{"overall":"不错"} 以上。')?.overall === "不错");
  check("非 JSON 返回 null", extractJson("模型没按要求输出") === null);
  check("空串返回 null", extractJson("") === null);

  console.log("B. 选择题规则判分（不进 LLM）");
  const choice = {
    options: [
      { key: "A", text: "温习学过的知识" },
      { key: "B", text: "结交新朋友" },
    ],
    correctKey: "A",
    answerText: "温习学过的知识",
  };
  check("说「选A」→ 满分", judgeChoice("我选A", choice, 10)?.pointGot === 10);
  check("说「选B」→ 0 分并说明正确答案", (() => {
    const r = judgeChoice("选B", choice, 10);
    return r?.pointGot === 0 && r.correct === false && r.aiComment.includes("正确答案");
  })());
  check("说出正确项内容 → 满分", judgeChoice("应该是温习学过的知识吧", choice, 10)?.correct === true);
  check("说出错误项内容 → 0 分", judgeChoice("我觉得是结交新朋友", choice, 10)?.correct === false);
  check("识别不清 → null（交 LLM 兜底）", judgeChoice("嗯……那个", choice, 10) === null);
  check("空回答 → null", judgeChoice("", choice, 10) === null);

  console.log("C. prompt 组装（口径真源在服务端）");
  {
    const gp = buildCourseGenerationPrompt(
      "论语",
      {
        title: "论语学而篇第一章",
        assessMethod: "孩子甲：重点考字词与道理应用；不考核读音。",
        knowledgePoints: [{ name: "学而时习之", detail: "理解「习」是实践" }, { name: "不亦说乎", detail: "说=悦" }],
      },
      "孩子甲"
    );
    check("出题 prompt 带主题考核方法", gp.includes("重点考字词与道理应用"));
    check("出题 prompt 带孩子名（按孩子区分段落）", gp.includes("孩子甲"));
    check("出题 prompt 带全部知识点", gp.includes("学而时习之") && gp.includes("不亦说乎"));
    check("出题 prompt 带「不要出背原文题」规则", gp.includes("不要出“请背诵/背出原文”"));
    check("出题 prompt 要求只输出 JSON", gp.includes("只输出 JSON"));

    const a: ExamAnswerIn = {
      qid: "q1",
      course: "论语学而篇第一章",
      stem: "说说「学而时习之」的意思",
      pointMax: 10,
      rubric: "能结合生活举例",
      scoring: "参考答案：学了要实践\n评分维度：\n- 完整性（10分）：说清含义",
      asrText: "学了知识要经常实践",
      durationMs: 8000,
    };
    const sp = buildScorePrompt("【判分总则】严格温和", a, 0);
    check("判分 prompt 带服务端判分口径", sp.includes("【判分总则】"));
    check("判分 prompt 带本题评分标准与 rubric", sp.includes("评分维度") && sp.includes("能结合生活举例"));
    check("判分 prompt 带 qid 与 pointMax", sp.includes("qid=q1") && sp.includes("pointMax=10"));
    check("判分 prompt 要求只评本题", sp.includes("只评这一题"));
    check("非选择题不带选项块", !sp.includes("本题是选择题"));

    const ac: ExamAnswerIn = { ...a, choice: { options: choice.options, correctKey: "A", answerText: "温习学过的知识" } };
    check("选择题判分 prompt 带选项与正确项", buildScorePrompt("总则", ac, 0).includes("正确选项：A"));
  }

  console.log("D. 审计落盘（默认不落 prompt 原文）");
  {
    const deps = { dataDir: tmp, childId: "c1" };
    auditExamEvent(deps, "generate", { kind: "ok", course: "论语", prompt: "很长的 prompt", reply: "回复", costMs: 12 });
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const file = path.join(tmp, "exam-audit", "c1", `${day}.jsonl`);
    check("审计文件已生成", fs.existsSync(file));
    const line = fs.readFileSync(file, "utf-8").trim();
    check("默认不落 prompt 原文", !line.includes("很长的 prompt"));
    check("保留结构字段（phase/course/reply）", line.includes('"phase":"generate"') && line.includes('"course":"论语"'));
  }

  console.log("E. 考核 agent 路由");
  {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT);");
    db.prepare("INSERT INTO children (id,parent_id,name) VALUES (?,?,?)").run("c1", "p1", "珊珊");
    const app = Fastify();
    registerExamAgentRoutes(app, { config: { dataDir: tmp, jwtSecret: SECRET } as any, db });
    const auth = { authorization: `Bearer ${signSession({ parent_id: "p1", email: "a@b.c", plan: "free" }, SECRET, 1)}` };

    const noToken = await app.inject({ method: "POST", url: "/api/v1/exam/agent/grade", payload: { childId: "c1", answers: [{ qid: "q1" }] } });
    check("无 token → 401", noToken.statusCode === 401, `status=${noToken.statusCode}`);

    const foreign = await app.inject({
      method: "POST",
      url: "/api/v1/exam/agent/grade",
      headers: auth,
      payload: { childId: "other", answers: [{ qid: "q1" }] },
    });
    check("非本人孩子 → 403", foreign.statusCode === 403, `status=${foreign.statusCode}`);

    const noAnswers = await app.inject({ method: "POST", url: "/api/v1/exam/agent/grade", headers: auth, payload: { childId: "c1", answers: [] } });
    check("answers 为空 → 400", noAnswers.statusCode === 400, `status=${noAnswers.statusCode}`);

    const noCourse = await app.inject({
      method: "POST",
      url: "/api/v1/exam/agent/generate",
      headers: auth,
      payload: { childId: "c1", courseTitle: "不存在的课" },
    });
    check("课程不存在 → 404 且给出核对提示", noCourse.statusCode === 404 && /核对课程名/.test(noCourse.body), `status=${noCourse.statusCode}`);

    // 真调用：无模型 key 时干净报错（不烧 token）
    const graded = await app.inject({
      method: "POST",
      url: "/api/v1/exam/agent/grade",
      headers: auth,
      payload: {
        childId: "c1",
        answers: [
          {
            qid: "q1",
            course: "论语学而篇第一章",
            stem: "说说意思",
            pointMax: 10,
            rubric: "能举例",
            asrText: "学了要实践",
            durationMs: 5000,
          },
        ],
      },
    });
    if (graded.statusCode === 200) {
      check("判分走通（已配置模型 key）", true, graded.body.slice(0, 120));
    } else {
      check("判分无 key 时干净报错（非崩溃）", graded.statusCode === 500 && /error/.test(graded.body), `status=${graded.statusCode}`);
    }

    // 纯规则判分不依赖模型：选择题应能真的判出来
    const choiceGraded = await app.inject({
      method: "POST",
      url: "/api/v1/exam/agent/grade",
      headers: auth,
      payload: {
        childId: "c1",
        answers: [
          {
            qid: "q1",
            course: "论语学而篇第一章",
            stem: "选一选",
            pointMax: 10,
            rubric: "",
            asrText: "选A",
            durationMs: 3000,
            choice: { options: choice.options, correctKey: "A", answerText: "温习学过的知识" },
          },
        ],
      },
    });
    check("选择题判分不经模型即可返回结果", choiceGraded.statusCode === 200 && /pointGot/.test(choiceGraded.body), `status=${choiceGraded.statusCode}`);

    const sp = await app.inject({ method: "GET", url: "/api/v1/exam/agent/scoring-prompt", headers: auth });
    check("可只读获取服务端判分口径", sp.statusCode === 200 && sp.body.includes("scoringPrompt"));
    await app.close();
  }

  console.log("F. 版本协商");
  check("features 含 exam_agent", (SERVER_FEATURES as readonly string[]).includes("exam_agent"));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? "\n全部通过 ✅" : `\n失败 ${failed} 项 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
