// M3 配置下发验证脚本（node fetch）
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
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
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

// 1. 初始 revision = 0
{
  const r = await call("GET", "/config/revision");
  check("初始 revision=0", r.status === 200 && r.json.revision === 0, r.json);
}

// 2. set 模型配置 → revision +1
{
  const r = await call("POST", "/config/set", { key: "models", value: { default: "deepseek-v4", providers: ["deepseek", "qwen"] } });
  check("set models revision=1", r.status === 200 && r.json.revision === 1, r.json);
  const r2 = await call("POST", "/config/set", { key: "scheduler", value: { recording: { enabled: false, intervalHours: 1 } } });
  check("set scheduler revision=2", r2.status === 200 && r2.json.revision === 2, r2.json);
}

// 3. 全量读取
{
  const r = await call("GET", "/config");
  check("GET /config revision=2", r.status === 200 && r.json.revision === 2, { rev: r.json?.revision });
  const m = r.json?.config?.models;
  const s = r.json?.config?.scheduler;
  check("config.models 结构", m?.default === "deepseek-v4" && m?.providers?.length === 2, m);
  check("config.scheduler 结构", s?.recording?.enabled === false && s?.recording?.intervalHours === 1, s);
}

// 4. 多键独立更新：改 scheduler 不动 models，revision 仍 +1
{
  const r = await call("POST", "/config/set", { key: "scheduler", value: { recording: { enabled: true, intervalHours: 2 } } });
  check("重写 scheduler revision=3", r.status === 200 && r.json.revision === 3, r.json);
  const r2 = await call("GET", "/config");
  const m = r2.json?.config?.models;
  check("models 未被覆盖", m?.default === "deepseek-v4", m);
  check("scheduler 已更新", r2.json?.config?.scheduler?.recording?.enabled === true, r2.json?.config?.scheduler);
}

// 5. 鉴权
{
  const r = await call("GET", "/config/revision", null, { "Content-Type": "application/json" });
  check("无 token 401", r.status === 401, r.json);
  const r2 = await call("POST", "/config/set", { key: "x", value: 1 }, { "Content-Type": "application/json" });
  check("无 token 写配置 401", r2.status === 401, r2.json);
}

// 6. 参数校验
{
  const r = await call("POST", "/config/set", { value: 1 });
  check("缺 key 400", r.status === 400, r.json);
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
