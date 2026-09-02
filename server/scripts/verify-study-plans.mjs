/**
 * ISSUE-033 学习计划冒烟（P0 数据层）：create / list / today 聚合 / patch / delete / 归属 403。
 * 用法：node scripts/verify-study-plans.mjs（需先 node scripts/build.mjs 产出 dist/server.cjs）
 * 起临时实例（SERVER_DATA_DIR=临时目录, SERVER_PORT=8890），直连 DB 造家长/孩子，JWT 调接口，最后自动清理。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import jwt from "jsonwebtoken";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-smoke-"));
const port = 8890;
const base = `http://127.0.0.1:${port}`;

function fail(msg) {
  console.error("✗ FAIL:", msg);
  process.exit(1);
}
function log(...a) {
  console.log("[study-plan]", ...a);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
  log("✓", msg);
}

// 1) 造数据：家长 + 孩子（直连 sqlite，绕过公网认证；study_plan_items 由服务端 openDb 自动建）
const dbPath = path.join(dataDir, "server.sqlite");
fs.mkdirSync(dataDir, { recursive: true });
{
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS parents (id TEXT PRIMARY KEY, email TEXT NOT NULL, plan TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO parents (id, email, plan, created_at, updated_at) VALUES (?,?,?,?,?)").run("parent-sp", "sp@test.local", "pro", now, now);
  db.prepare("INSERT INTO children (id, parent_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("child-sp", "parent-sp", "冒烟娃", now, now);
  db.close();
}

// 2) 启动服务端
const child = spawn(process.execPath, [path.join(root, "dist", "server.cjs")], {
  env: { ...process.env, SERVER_DATA_DIR: dataDir, SERVER_PORT: String(port), JWT_SECRET: "sp-secret" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/api/v1/health`);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  fail("服务端未在预期时间内就绪");
}

const token = jwt.sign({ parent_id: "parent-sp", email: "sp@test.local", plan: "pro" }, "sp-secret", { expiresIn: "1d" });
const badToken = jwt.sign({ parent_id: "parent-other", email: "other@test.local", plan: "pro" }, "sp-secret", { expiresIn: "1d" });

async function api(method, p, body, tok = token) {
  const h = { Authorization: `Bearer ${tok}` };
  if (body !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(`${base}/api/v1${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) fail(`${method} ${p} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// 3) 测试序列
await waitHealth();

const D = "2026-09-05";

// create：首建 → 返回 row；同日二次 create → 幂等合并进同一行（单行 canonical，杜绝重复行）
const c1 = await api("POST", "/study-plans", { childId: "child-sp", date: D, content: [{ text: "论语·先进篇 1-2 章", topicKey: "lunyu" }, { text: "数学练习" }] });
assert(c1.ok && c1.row?.id, "create 返回 row.id");
const c2 = await api("POST", "/study-plans", { childId: "child-sp", date: D, content: [{ text: "英语 2 课" }] });
assert(c2.ok && c2.merged === true && c2.row?.id === c1.row?.id, `同日二次 create 合并进同一行（merged=${c2.merged}）`);

// create：全部重复 → 幂等不新增
const c3 = await api("POST", "/study-plans", { childId: "child-sp", date: D, content: [{ text: "论语·先进篇 1-2 章" }, { text: "英语 2 课" }] });
assert(c3.ok && c3.duplicated === true && c3.row?.id === c1.row?.id, "重复内容 create 幂等返回现有行（duplicated）");

// today 聚合：单行 3 项平铺
const t0 = await api("GET", `/study-plans/today?childId=child-sp&date=${D}`);
assert(t0.ok && t0.date === D && t0.items.length === 3, `today 聚合 3 项（实际 ${t0.items.length}）`);
assert(t0.items.every((i) => i.carry === false), "conversation 行 carry=false");

// list：同日只有 1 行
const l0 = await api("GET", "/study-plans?childId=child-sp");
assert(l0.ok && l0.rows.length === 1, `list 1 行（同日单行，实际 ${l0.rows.length}）`);

// list + date 过滤（跨日期同文本允许——各天独立）
await api("POST", "/study-plans", { childId: "child-sp", date: "2026-09-06", content: [{ text: "论语·先进篇 1-2 章" }] });
const l1 = await api("GET", `/study-plans?childId=child-sp&date=${D}`);
assert(l1.ok && l1.rows.length === 1 && l1.rows.every((r) => r.date === D), `list?date= 过滤只回当天行（实际 ${l1.rows.length} 行）`);

// patch：整体替换内容（replace 语义，只留 1 项）
const p1 = await api("PATCH", `/study-plans/${c1.row.id}`, { content: [{ text: "论语·先进篇 1-2 章" }] });
assert(p1.ok && p1.row, "patch 内容成功");
const t1 = await api("GET", `/study-plans/today?childId=child-sp&date=${D}`);
assert(t1.items.length === 1, `patch 替换后 today 1 项（实际 ${t1.items.length}）`);

// patch 后再追加 → 仍合并回同一行（不产生第二行）
await api("POST", "/study-plans", { childId: "child-sp", date: D, content: [{ text: "数学练习" }] });
const l2 = await api("GET", `/study-plans?childId=child-sp&date=${D}`);
assert(l2.rows.length === 1, `追加后同日仍 1 行（实际 ${l2.rows.length}）`);
const t1b = await api("GET", `/study-plans/today?childId=child-sp&date=${D}`);
assert(t1b.items.length === 2, `patch 后追加 today 2 项（实际 ${t1b.items.length}）`);

// patch：停用 → today 为空
await api("PATCH", `/study-plans/${c1.row.id}`, { active: false });
const t2 = await api("GET", `/study-plans/today?childId=child-sp&date=${D}`);
assert(t2.ok && t2.items.length === 0, `停用后 today 空（实际 ${t2.items.length}）`);

// carry：直连插一行 origin=carry 同日期 → 聚合出现 carry 标记
{
  const db = new DatabaseSync(dbPath);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO study_plan_items (id, parent_id, child_id, kind, date, content, origin, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)")
    .run("carry-1", "parent-sp", "child-sp", "date", D, JSON.stringify([{ text: "论语·先进篇 3 章（补昨日）" }]), "carry", now, now);
  db.close();
}
const t3 = await api("GET", `/study-plans/today?childId=child-sp&date=${D}`);
assert(t3.items.some((i) => i.carry === true && i.text.includes("补昨日")), "carry 行进入 today 并带 carry 标记");
assert(t3.items.length === 1, "carry 与停用行互不影响");

// delete：删 carry 行 → today 空
await api("DELETE", `/study-plans/carry-1`);
const t4 = await api("GET", `/study-plans/today?childId=child-sp&date=${D}`);
assert(t4.items.length === 0, "delete 后 today 空");

// 归属校验：别家家长访问 child-sp 数据 → 403
const rForbidden = await fetch(`${base}/api/v1/study-plans?childId=child-sp`, { headers: { Authorization: `Bearer ${badToken}` } });
assert(rForbidden.status === 403, `跨家长访问返回 403（实际 ${rForbidden.status}）`);

// 无 token → 401
const rNoAuth = await fetch(`${base}/api/v1/study-plans?childId=child-sp`);
assert(rNoAuth.status === 401, `无 token 返回 401（实际 ${rNoAuth.status}）`);

child.kill();
await new Promise((r) => child.on("exit", r));
await sleep(500);
try {
  fs.rmSync(dataDir, { recursive: true, force: true });
} catch {
  // Windows 下 sqlite 句柄释放有延迟，清不掉也不影响结果
}
log("全部通过 ✅");
