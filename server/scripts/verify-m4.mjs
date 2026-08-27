// M4 Materials 同步验证脚本（node fetch + FormData 上传）
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
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json, text };
}

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + JSON.stringify(detail) : ""}`);
  if (!cond) failed++;
}

async function upload(topic, filename, content) {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "text/html" }), filename);
  if (topic) form.append("topic", topic);
  const r = await fetch(`${BASE}/materials/upload`, { method: "POST", headers: HA, body: form, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json };
}

// 1. 上传两个文件（不同 topic）
const u1 = await upload("lunyu", "lesson-01.html", "<html><body>论语第一课</body></html>");
check("上传 lunyu/lesson-01.html", u1.status === 200 && u1.json?.material?.path === "lunyu/lesson-01.html", u1.json);
const u2 = await upload("yingyu", "lesson-01.html", "<html><body>英语第一课</body></html>");
check("上传 yingyu/lesson-01.html", u2.status === 200 && u2.json?.material?.path === "yingyu/lesson-01.html", u2.json);

// 2. index 首次（空 client_index）→ 2 个 updates
{
  const r = await call("POST", "/materials/index", { client_index: {} });
  const updates = r.json?.updates ?? [];
  check("index 首拉 2 条更新", r.status === 200 && updates.length === 2, updates.map(u => u.path));
}

// 3. 下载内容一致
{
  const list = await call("POST", "/materials/index", { client_index: {} });
  const first = list.json.updates.find((u) => u.path === "lunyu/lesson-01.html");
  const dl = await fetch(`${BASE}/materials/content/${first.id}`, { headers: HA, signal: AbortSignal.timeout(15000) });
  const text = await dl.text();
  check("content 下载内容一致", dl.status === 200 && text.includes("论语第一课"), text);
  check("下载 Content-Length", dl.headers.get("content-length") === String(new Blob(["<html><body>论语第一课</body></html>"]).size), dl.headers.get("content-length"));
}

// 4. 已同步后 index 无更新（带 client_index）
{
  const list = await call("POST", "/materials/index", { client_index: {} });
  const ci = {};
  for (const u of list.json.updates) ci[u.id] = u.updated_at;
  const r2 = await call("POST", "/materials/index", { client_index: ci });
  check("已同步后无更新", r2.status === 200 && r2.json.updates.length === 0 && r2.json.removed.length === 0, r2.json);
}

// 5. 覆盖上传 → updated_at 变化 → 出现在 updates
{
  const before = await call("POST", "/materials/index", { client_index: {} });
  const old = before.json.updates.find((u) => u.path === "lunyu/lesson-01.html");
  await new Promise((r) => setTimeout(r, 10)); // mtime 分辨率
  const up = await upload("lunyu", "lesson-01.html", "<html><body>论语第一课（修订版）</body></html>");
  check("覆盖上传成功", up.status === 200, up.json);
  const r2 = await call("POST", "/materials/index", { client_index: { [old.id]: old.updated_at } });
  const upd = r2.json?.updates ?? [];
  check("修订出现在 updates", upd.some((u) => u.path === "lunyu/lesson-01.html" && u.updated_at !== old.updated_at), upd.map(u => ({ p: u.path, ts: u.updated_at })));
}

// 6. 越权：other-parent 看不到 test-parent 的材料
{
  const other = jwt.sign({ parent_id: "other-parent", email: "o@o", plan: "pro" }, SECRET, { expiresIn: "1h" });
  const r = await call("POST", "/materials/index", { client_index: {} }, { "Content-Type": "application/json", Authorization: `Bearer ${other}` });
  check("跨家长材料隔离", r.status === 200 && r.json.updates.length === 0, r.json);
}

// 7. 鉴权与非法路径
{
  const r = await call("POST", "/materials/index", { client_index: {} }, { "Content-Type": "application/json" });
  check("无 token 401", r.status === 401, r.json);
  const list = await call("POST", "/materials/index", { client_index: {} });
  const first = list.json.updates.find((u) => u.path === "lunyu/lesson-01.html");
  const bad = await fetch(`${BASE}/materials/content/${Buffer.from("../../etc/passwd").toString("base64url")}`, { headers: HA, signal: AbortSignal.timeout(15000) });
  check("非法 id 404/403", bad.status === 403 || bad.status === 404, bad.status);
  void first;
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
