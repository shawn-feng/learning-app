/**
 * 导入 lunyu_exam 合并数据到服务端（本机开发服务端 127.0.0.1:8788，生产家长库 86a84278）。
 * - 家长库：topics.assess_method（论语考核方法说明）+ courses.assess_rubric（每章合并 markdown 全文，幂等 upsert）
 * - 孩子库：可选把指定章节标记「已学」（考核对象 = 学/复习过的课程），title 与家长库一致
 *
 * 用法：
 *   node scripts/import-lunyu-exam.mjs                 # 全量导入 489 章 rubric
 *   node scripts/import-lunyu-exam.mjs 为政篇第一章      # 只导入标题含该子串的章节（测试用）
 *   node scripts/import-lunyu-exam.mjs --learn 为政篇第一章  # 导入 + 把孩子库标记该章已学
 *   node scripts/import-lunyu-exam.mjs --learn-only 为政篇第一章  # 只标记已学不导 rubric
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jwt = require(path.join(root, "server", "node_modules", "jsonwebtoken"));
const BASE = process.env.SERVER_URL || "http://127.0.0.1:8788";
const PARENT_ID = "86a84278-c8ae-415e-8fbc-6140b1b7c88e";
const CHILD_ID = "09406c05-d373-448a-95ac-c5ebbba9a0e5"; // 闻闻
const TOPIC = "lunyu";
const TOPIC_NAME = "论语";
const MERGED = path.join(root, "lunyu_exam", "merged");

const ASSESS_METHOD = `周期：每天。考核对象：该周期内学/复习过的知识点（课程）。题量：最近学的 3 课各出 1 道口述题（不超过 8 题）。评分口径：按该课「考核内容」（知识点+题目+评分标准）逐点给分，10 分满分，达 60% 记正确。`;

const cfg = JSON.parse(fs.readFileSync(path.join(root, "server", "data", "server-config.json"), "utf-8"));
const token = jwt.sign({ parent_id: PARENT_ID, email: "test@local", plan: "trial" }, cfg.jwtSecret, { expiresIn: "7d" });
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

let failures = 0;
async function exec(op, args) {
  const res = await fetch(`${BASE}/api/v1/db/exec`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ op, args }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 200 || json?.result?.ok !== true) {
    failures++;
    console.error(`✗ ${op} ${JSON.stringify(args)?.slice(0, 80)} → ${res.status} ${JSON.stringify(json).slice(0, 120)}`);
    return false;
  }
  return true;
}

/** 读接口走 /db/query（返回 op 结果；exec 只允许写操作）。 */
async function query(op, args) {
  const res = await fetch(`${BASE}/api/v1/db/query`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ op, args }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 200) {
    failures++;
    console.error(`✗ query ${op} → ${res.status} ${JSON.stringify(json).slice(0, 120)}`);
    return null;
  }
  return json.result;
}

// ⚠️ parent_lib.courses.upsert 是**全字段覆盖**：未传的 teaching_copy/html_path/status 等会被覆盖成空！
// 导入前先 list 现有课程，upsert 时回填原字段（只更新 assess_rubric 与 sort_order），
// 避免再次清空教学文案/资料路径（2026-09-01 曾因未回填导致 489 章教学文案丢失，从 201 恢复）。
// 孩子库 kb.courses.upsert 同理（先 list 回填 status/mastery/html_path 等，只改学习标记）。
async function upsertPreserving(op, args, preserveKeys) {
  const listOp = op === "parent_lib.courses.upsert" ? "parent_lib.courses.list" : "kb.courses.list";
  const listArgs = op === "parent_lib.courses.upsert" ? { topic: args.topic } : { child_id: args.child_id, topic: args.topic };
  const existing = (await query(listOp, listArgs)) || [];
  const byTitle = new Map(existing.map((r) => [r.title, r]));
  const old = byTitle.get(args.title);
  const merged = { ...args };
  for (const k of preserveKeys) {
    if (merged[k] === undefined && old && old[k] !== undefined) merged[k] = old[k];
  }
  return exec(op, merged);
}

// ---- 参数解析 ----
const argv = process.argv.slice(2);
const onlyLearn = argv.includes("--learn-only");
const learn = argv.includes("--learn") || onlyLearn;
const filter = argv.filter((a) => !a.startsWith("--"))[0] ?? "";
const files = fs.readdirSync(MERGED).filter((f) => f.endsWith(".md")).sort();
const targets = filter ? files.filter((f) => f.includes(filter)) : files;
if (filter && !targets.length) {
  console.error(`没有匹配「${filter}」的章节文件`);
  process.exit(1);
}

// ---- 1) 考核方法说明 ----
if (!onlyLearn) {
  // ⚠️ topics.upsert 是全字段覆盖：传 method:"" 会把主题教学方法清空（2026-09-01 曾把论语
  // method 2123 字清空，从 201 恢复）。先 list 回填 method/progress/rules_json，只更新 assess_method。
  const topicsList = (await query("parent_lib.topics.list", {})) || [];
  const old = topicsList.find((x) => x.topic_key === TOPIC);
  const ok = await exec("parent_lib.topics.upsert", {
    name: TOPIC_NAME,
    topic_key: TOPIC,
    method: old?.method ?? "",
    progress: old?.progress ?? "",
    rules_json: old?.rules_json ?? "{}",
    assess_method: ASSESS_METHOD,
  });
  console.log(`${ok ? "✓" : "✗"} topics.assess_method（${TOPIC_NAME}/${TOPIC}，method 保留 ${(old?.method || "").length} 字）`);
}

// ---- 2) 逐章导入 rubric（合并 markdown 全文）----
if (!onlyLearn) {
  const PRESERVE = ["status", "mastery", "first_learned", "last_review", "review_count", "material", "send_material", "tags", "lesson_method", "html_path", "teaching_copy"];
  let n = 0;
  for (const f of targets) {
    const title = f.replace(/\.md$/, "");
    const content = fs.readFileSync(path.join(MERGED, f), "utf-8");
    const ok = await upsertPreserving("parent_lib.courses.upsert", { topic: TOPIC, title, sort_order: n + 1, assess_rubric: content }, PRESERVE);
    if (ok) n++;
  }
  console.log(`✓ 家长库 rubric 导入 ${n}/${targets.length} 章（topic=${TOPIC}，保留原 teaching_copy/html_path/status 等）`);
}

// ---- 3) 孩子库标记已学（考核对象 = 学/复习过的课程；保留 html_path/material 等原字段）----
if (learn) {
  const learnTargets = targets.slice(0, 3); // 每次最多标 3 章，避免刷屏
  let m = 0;
  for (const f of learnTargets) {
    const title = f.replace(/\.md$/, "");
    const ok = await upsertPreserving(
      "kb.courses.upsert",
      {
        child_id: CHILD_ID, topic: TOPIC, title, sort_order: m + 1,
        status: "✅", mastery: "良好", first_learned: "2026-09-01", last_review: "2026-09-01", review_count: 1,
      },
      ["material", "send_material", "tags", "lesson_method", "html_path", "teaching_copy"]
    );
    if (ok) m++;
  }
  console.log(`✓ 孩子库标记已学 ${m} 章（child=${CHILD_ID.slice(0, 8)}…）`);
}

console.log(failures === 0 ? "✅ 全部成功" : `❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
