// M5 大文件通道验证脚本（node fetch + FormData）
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";

const BASE = "http://127.0.0.1:8788/api/v1";
const cfg = JSON.parse(fs.readFileSync(path.resolve("data/server-config.json"), "utf-8"));
const SECRET = cfg.jwtSecret;
const token = jwt.sign({ parent_id: "test-parent", email: "t@t", plan: "pro" }, SECRET, { expiresIn: "1h" });
const otherToken = jwt.sign({ parent_id: "other-parent", email: "o@o", plan: "pro" }, SECRET, { expiresIn: "1h" });
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
const HA = { Authorization: `Bearer ${token}` };

async function call(method, p, body, headers = H) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json, text };
}

async function upload(fields, filename, content, mime = "audio/wav", headers = HA) {
  const form = new FormData();
  form.append("file", new Blob([content], { type: mime }), filename);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const r = await fetch(`${BASE}/files/upload`, {
    method: "POST",
    headers,
    body: form,
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

// 0. 准备孩子（归属校验需要）
const child = await call("POST", "/children", { name: "珊珊" });
const childId = child.json.child.id;
check("创建孩子", child.status === 200 && !!childId, child.json);

// 1. 上传：无 child_id
const u1 = await upload({}, "rec-01.wav", Buffer.from("RIFF-wave-data-1", "utf-8"), "audio/wav");
check("上传无 child_id", u1.status === 200 && u1.json.file?.id, u1.json);
const f1 = u1.json.file;

// 2. 上传：带 child_id（关联孩子）
const u2 = await upload({ child_id: childId }, "photo-01.png", Buffer.from("PNG-FAKE-DATA-2", "utf-8"), "image/png");
check("上传带 child_id", u2.status === 200 && u2.json.file?.child_id === childId, u2.json.file && { child_id: u2.json.file.child_id, mime: u2.json.file.mime });

// 3. 上传：不存在的 child_id → 403
const u3 = await upload({ child_id: "no-such-child" }, "x.mp4", "123", "video/mp4");
check("非法 child_id 403", u3.status === 403, u3.json);

// 4. 下载内容一致 + Content-Length + MIME
{
  const WAV = "RIFF-wave-data-1"; // 16 字节
  const dl = await fetch(`${BASE}/files/${f1.id}`, { headers: HA, signal: AbortSignal.timeout(15000) });
  const buf = Buffer.from(await dl.arrayBuffer());
  check("下载内容一致", dl.status === 200 && buf.toString("utf-8") === WAV, buf.toString());
  check("下载 MIME 正确", dl.headers.get("content-type") === "audio/wav", dl.headers.get("content-type"));
  check("下载 Content-Length", dl.headers.get("content-length") === String(Buffer.byteLength(WAV, "utf-8")), dl.headers.get("content-length"));
}

// 5. 跨家长下载 → 404（文件对其它家长不可见）
{
  const dl = await fetch(`${BASE}/files/${f1.id}`, { headers: { Authorization: `Bearer ${otherToken}` }, signal: AbortSignal.timeout(15000) });
  check("跨家长下载 404", dl.status === 404, dl.status);
}

// 6. list 含上传的文件（幂等：检查包含而非精确数量）
{
  const r = await call("GET", "/files/list");
  const names = r.json.files?.map(f => f.original_name) ?? [];
  check("files/list 含 rec/photo", r.status === 200 && names.includes("rec-01.wav") && names.includes("photo-01.png"), names);
}

// 7. 删除 → 再下载 404（DELETE 用无 Content-Type 的 header）
{
  const r = await call("DELETE", `/files/${f1.id}`, undefined, HA);
  check("删除成功", r.status === 200 && r.json.ok === true, r.json);
  const dl = await fetch(`${BASE}/files/${f1.id}`, { headers: HA, signal: AbortSignal.timeout(15000) });
  check("删除后下载 404", dl.status === 404, dl.status);
}

// 8. 鉴权
{
  const r = await fetch(`${BASE}/files/upload`, { method: "POST", body: new FormData(), signal: AbortSignal.timeout(15000) });
  check("无 token 上传 401", r.status === 401, r.status);
  const r2 = await fetch(`${BASE}/files/no-such-id`, { signal: AbortSignal.timeout(15000) });
  check("无 token 下载 401", r2.status === 401, r2.status);
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
