// M8-E 客户端契约联调：模拟客户端（server-client/client-data/material-cache/agent-prompts/config-sync）
// 对服务端的全部依赖契约，确保两端一致（M7 GUI 联调前的自动验证层）。
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";

const BASE = "http://127.0.0.1:8788/api/v1";
const cfg = JSON.parse(fs.readFileSync(path.resolve("data/server-config.json"), "utf-8"));
const SECRET = cfg.jwtSecret;
const token = jwt.sign({ parent_id: "test-parent", email: "t@t", plan: "pro" }, SECRET, { expiresIn: "1h" });
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
const HA = { Authorization: `Bearer ${token}` };

async function call(method, p, body, headers = H) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
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

const child = await call("POST", "/children", { name: "契约娃" });
const cid = child.json.child.id;

// 1. 客户端 encodeMaterialId 规则一致性：base64url(utf8) 与服务端一致
{
  // 上传文件 → 服务端返回 id（服务端 encodeMaterialId 结果）
  const form = new FormData();
  form.append("file", new Blob(['<html>契约测试</html>'], { type: "text/html" }), "lesson.html");
  form.append("topic", "lunyu");
  const up = await fetch(`${BASE}/materials/upload`, { method: "POST", headers: HA, body: form, signal: AbortSignal.timeout(15000) });
  const upJson = await up.json();
  // 客户端本地算 id（与服务端同规则）
  const clientId = Buffer.from("lunyu/lesson.html", "utf-8").toString("base64url");
  check("material id 规则一致", up.status === 200 && upJson.material.id === clientId, { server: upJson.material?.id, client: clientId });
  // 客户端直接用本地算的 id 下载（material-cache serverDownload 路径）
  const dl = await fetch(`${BASE}/materials/content/${clientId}`, { headers: HA, signal: AbortSignal.timeout(15000) });
  check("本地算 id 可下载", dl.status === 200 && (await dl.text()).includes("契约测试"), dl.status);
}

// 2. config key 映射契约（客户端 config-sync 依赖 app_settings / scheduler_config 两个 key）
{
  const r1 = await call("POST", "/config/set", { key: "app_settings", value: { materialsLimit: 20, defaultModel: "qwen/qwen-flash" } });
  const r2 = await call("POST", "/config/set", { key: "scheduler_config", value: { children: {} } });
  check("config set app_settings/scheduler_config", r1.status === 200 && r2.status === 200, { r1: r1.json?.revision, r2: r2.json?.revision });
  const full = await call("GET", "/config");
  const c = full.json?.config ?? {};
  check("config 全量含两 key", c.app_settings?.defaultModel === "qwen/qwen-flash" && c.scheduler_config !== undefined, Object.keys(c));
}

// 3. agents 契约（客户端 agent-prompts：get/save/history/restore）
{
  const save = await call("POST", "/db/exec", { op: "agents.save", args: { scope: "child", ref: cid, content: "行为规范契约版" } });
  check("agents.save", save.status === 200 && save.json.result.ok === true, save.json);
  const get = await call("POST", "/db/query", { op: "agents.get", args: { scope: "child", ref: cid } });
  check("agents.get 返回 content", get.status === 200 && get.json.result?.content === "行为规范契约版", get.json.result);
  const save2 = await call("POST", "/db/exec", { op: "agents.save", args: { scope: "child", ref: cid, content: "第二版" } });
  check("agents 二次保存", save2.status === 200, save2.json);
  const hist = await call("POST", "/db/query", { op: "agents.history", args: { scope: "child", ref: cid } });
  check("agents.history 1 条", hist.status === 200 && hist.json.result?.length === 1, hist.json.result?.length);
  const restore = await call("POST", "/db/exec", { op: "agents.restore", args: { scope: "child", ref: cid, updated: hist.json.result[0].updated } });
  check("agents.restore", restore.status === 200 && restore.json.result.ok === true, restore.json);
}

// 4. db RPC 契约（客户端 client-data：kb 主链路）
{
  const ins = await call("POST", "/db/exec", { op: "kb.daily_entries.insertMany", args: { child_id: cid, date: "2026-08-27", entries: [{ block: "学习", content: "### 契约测试课\n- 状态：✅" }] } });
  check("kb insertMany", ins.status === 200 && ins.json.result.inserted === 1, ins.json.result);
  const q = await call("POST", "/db/query", { op: "kb.daily_entries.query", args: { child_id: cid, date: "2026-08-27" } });
  check("kb query", q.status === 200 && q.json.result?.length === 1, q.json.result?.length);
  const upd = await call("POST", "/db/exec", { op: "kb.courses.updateField", args: { child_id: cid, topic: "lunyu", title: "先进篇", field: "状态", value: "✅" } });
  check("kb courses.updateField 目标不存在 ok:false", upd.status === 200 && upd.json.result.ok === false, upd.json.result);
}

// 5. 错误形状契约（客户端 serverFetch 期望非 2xx body 为 { error: string }）
{
  // 无效凭证登录 → 401 { error }（客户端 ServerError 提取）
  const badLogin = await fetch(`${BASE}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "no-such@x.test", password: "bad" }),
    signal: AbortSignal.timeout(15000),
  });
  const bl = await badLogin.json();
  check("登录失败 401 + {error}", badLogin.status === 401 && typeof bl.error === "string" && bl.error.length > 0, bl);
  // 无 token → 401 { error }
  const noToken = await call("POST", "/db/query", { op: "kb.topics.list", args: { child_id: cid } }, { "Content-Type": "application/json" });
  check("无 token 401 + {error}", noToken.status === 401 && typeof noToken.json?.error === "string", noToken.json);
  // 越权 child → 403 { error }
  const other = jwt.sign({ parent_id: "other-parent", email: "o@o", plan: "pro" }, SECRET, { expiresIn: "1h" });
  const cross = await call("POST", "/db/query", { op: "kb.topics.list", args: { child_id: cid } }, { "Content-Type": "application/json", Authorization: `Bearer ${other}` });
  check("跨家长 403 + {error}", cross.status === 403 && typeof cross.json?.error === "string", cross.json);
  // 未知 op → 400 { error }
  const badOp = await call("POST", "/db/query", { op: "no.such.op", args: {} });
  check("未知 op 400 + {error}", badOp.status === 400 && typeof badOp.json?.error === "string", badOp.json);
}

// 6. version 契约（客户端启动比对 min_client_version）
{
  const v = await call("GET", "/version");
  check("version 契约", v.status === 200 && typeof v.json?.version === "string" && typeof v.json?.min_client_version === "string", v.json);
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
