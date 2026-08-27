// M2 端到端验证脚本（node fetch，绕开沙箱 curl 限制）
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";

const BASE = "http://127.0.0.1:8788/api/v1";
const cfg = JSON.parse(
  fs.readFileSync(path.resolve("data/server-config.json"), "utf-8")
);
const SECRET = cfg.jwtSecret;

const token = jwt.sign({ parent_id: "test-parent", email: "t@t", plan: "pro" }, SECRET, { expiresIn: "1h" });
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

async function call(method, p, body, headers = H) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json };
}

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + JSON.stringify(detail) : ""}`);
  if (!cond) failed++;
}

// 1. children CRUD
let c1, c2;
{
  const r = await call("POST", "/children", { name: "珊珊" });
  check("创建孩子1", r.status === 200 && r.json.child?.id, r.json);
  c1 = r.json.child;
  const r2 = await call("POST", "/children", { name: "闻闻" });
  check("创建孩子2", r2.status === 200, r2.json);
  c2 = r2.json.child;
  const r3 = await call("GET", "/children");
  const names = r3.json.children?.map(c => c.name) ?? [];
  check("孩子列表含珊珊/闻闻", r3.status === 200 && names.includes("珊珊") && names.includes("闻闻"), names);
  const r4 = await call("PATCH", `/children/${c1.id}`, { name: "珊珊·改" });
  check("孩子改名", r4.status === 200 && r4.json.ok === true, r4.json);
}

// 2. kb 读写（child1）
{
  const r = await call("POST", "/db/exec", { op: "kb.topics.upsert", args: { child_id: c1.id, name: "论语", topic_key: "lunyu", method: "# 方法", progress: "", rules_json: "{\"daily\":\"3\"}" } });
  check("kb.topics.upsert", r.status === 200 && r.json.result?.ok === true, r.json);
  const r2 = await call("POST", "/db/query", { op: "kb.topics.list", args: { child_id: c1.id } });
  check("kb.topics.list", r2.status === 200 && r2.json.result?.length === 1 && r2.json.result[0].name === "论语", r2.json.result);
  const r3 = await call("POST", "/db/exec", { op: "kb.daily_entries.insert", args: { child_id: c1.id, date: "2026-08-27", block: "学习", title: "论语先进篇", raw: "### 论语先进篇\n- 状态：✅", tags: "认真" } });
  check("kb.daily_entries.insert", r3.status === 200, r3.json);
  const r4 = await call("POST", "/db/query", { op: "kb.daily_entries.queryByDate", args: { child_id: c1.id, date: "2026-08-27" } });
  check("kb.daily_entries.queryByDate", r4.status === 200 && r4.json.result?.length === 1 && r4.json.result[0].title === "论语先进篇", r4.json.result);
  const r5 = await call("POST", "/db/exec", { op: "kb.courses.upsert", args: { child_id: c1.id, topic: "lunyu", title: "先进篇第十九章", sort_order: 1, status: "✅" } });
  check("kb.courses.upsert", r5.status === 200, r5.json);
  const r6 = await call("POST", "/db/query", { op: "kb.progress.list", args: { child_id: c1.id } });
  check("kb.progress.list 视图", r6.status === 200 && r6.json.result?.length === 1 && r6.json.result[0].learned === 1, r6.json.result);
}

// 3. agents 读写
{
  const r = await call("POST", "/db/exec", { op: "agents.save", args: { scope: "child", ref: c1.id, content: "你是学习伙伴……" } });
  check("agents.save child", r.status === 200, r.json);
  const r2 = await call("POST", "/db/query", { op: "agents.get", args: { scope: "child", ref: c1.id } });
  check("agents.get child", r2.status === 200 && r2.json.result?.content?.includes("学习伙伴"), r2.json.result);
  const r3 = await call("POST", "/db/exec", { op: "agents.save", args: { scope: "parent", ref: "main", content: "家长工作台……" } });
  check("agents.save parent", r3.status === 200, r3.json);
  const r4 = await call("POST", "/db/exec", { op: "agents.save", args: { scope: "child", ref: c1.id, content: "第二版" } });
  check("agents 二次保存", r4.status === 200, r4.json);
  const r5 = await call("POST", "/db/query", { op: "agents.history", args: { scope: "child", ref: c1.id } });
  check("agents.history 有1条历史", r5.status === 200 && r5.json.result?.length === 1, r5.json.result?.length);
}

// 4. parent_lib 读写
{
  const r = await call("POST", "/db/exec", { op: "parent_lib.topics.upsert", args: { name: "英语", topic_key: "yingyu", method: "# 方法", progress: "" } });
  check("parent_lib.topics.upsert", r.status === 200, r.json);
  const r2 = await call("POST", "/db/query", { op: "parent_lib.topics.list" });
  check("parent_lib.topics.list", r2.status === 200 && r2.json.result?.length === 1 && r2.json.result[0].name === "英语", r2.json.result);
}

// 5. 越权与鉴权
{
  // 跨家长越权：另一个家长的 token 访问 test-parent 的孩子 → 403
  const otherToken = jwt.sign(
    { parent_id: "other-parent", email: "o@o", plan: "pro" },
    SECRET,
    { expiresIn: "1h" }
  );
  const r = await call(
    "POST", "/db/query", { op: "kb.topics.list", args: { child_id: c2.id } },
    { "Content-Type": "application/json", Authorization: `Bearer ${otherToken}` }
  );
  check("跨家长越权被拒(403)", r.status === 403, r.json);
  const r2 = await call("POST", "/db/query", { op: "kb.topics.list", args: { child_id: c1.id } }, { "Content-Type": "application/json" });
  check("无 token 被拒(401)", r2.status === 401, r2.json);
  const r3 = await call("POST", "/db/query", { op: "不存在的op", args: {} });
  check("未知 op 被拒(400)", r3.status === 400, r3.json);
  const r4 = await call("POST", "/db/query", { op: "kb.topics.list", args: {} });
  check("缺 child_id 被拒(400)", r4.status === 400, r4.json);
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
