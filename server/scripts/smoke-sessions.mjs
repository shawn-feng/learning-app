/**
 * 冒烟测试（方案B 阶段①/⑤）：端到端验证会话同步 + 家长回顾 + auth 静态加密 + 能力标志。
 * 用法：node scripts/smoke-sessions.mjs
 * 起一个临时实例（SERVER_DATA_DIR=临时目录, SERVER_PORT=8877），直连 DB 造家长，
 * 用服务端签发的 JWT 调接口，最后自动清理。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-smoke-"));
const port = 8877;
const base = `http://127.0.0.1:${port}`;

function fail(msg) {
  console.error("✗ FAIL:", msg);
  process.exit(1);
}

function log(...a) {
  console.log("[smoke]", ...a);
}

// 1) 造数据：家长 + 孩子（直连 sqlite，绕过公网认证）
import { DatabaseSync } from "node:sqlite";
const dbPath = path.join(dataDir, "server.sqlite");
fs.mkdirSync(dataDir, { recursive: true });
{
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS parents (id TEXT PRIMARY KEY, email TEXT NOT NULL, plan TEXT, cloud_token TEXT, license_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, name TEXT NOT NULL, profile_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL DEFAULT '{}', updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_messages (child_id TEXT NOT NULL, file TEXT NOT NULL, line_index INTEGER NOT NULL, ts INTEGER NOT NULL, date TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', tool_calls TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (child_id, file, line_index));
    CREATE TABLE IF NOT EXISTS session_files (child_id TEXT NOT NULL, file TEXT NOT NULL, synced_bytes INTEGER NOT NULL DEFAULT 0, line_count INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL DEFAULT '', PRIMARY KEY (child_id, file));
    CREATE TABLE IF NOT EXISTS worker_state (child_id TEXT NOT NULL, task TEXT NOT NULL, last_run TEXT NOT NULL DEFAULT '', last_key TEXT NOT NULL DEFAULT '', PRIMARY KEY (child_id, task));`);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO parents (id, email, plan, created_at, updated_at) VALUES (?,?,?,?,?)").run("parent-smoke", "smoke@test.local", "pro", now, now);
  db.prepare("INSERT INTO children (id, parent_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("child-smoke", "parent-smoke", "测试娃", now, now);
  db.close();
}

// 2) 启动服务端
const child = spawn(process.execPath, [path.join(root, "dist", "server.cjs")], {
  env: { ...process.env, SERVER_DATA_DIR: dataDir, SERVER_PORT: String(port), JWT_SECRET: "smoke-secret" },
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

// 3) JWT
const token = jwt.sign({ parent_id: "parent-smoke", email: "smoke@test.local", plan: "pro" }, "smoke-secret", { expiresIn: "1d" });
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function api(method, p, body) {
  const r = await fetch(`${base}/api/v1${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) fail(`${method} ${p} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// 4) 测试序列
await waitHealth();
log("服务端就绪");

const v = await api("GET", "/version");
if (!Array.isArray(v.features) || !v.features.includes("session_sync") || !v.features.includes("worker")) {
  fail(`version.features 缺少能力标志: ${JSON.stringify(v.features)}`);
}
log("version.features 通过:", v.features.join(","), "| version:", v.version);

// 会话同步：3 行（header + 2 条消息）
const day = "2026-08-31";
const ts = new Date(2026, 7, 31, 10, 0).getTime();
const lines = [
  JSON.stringify({ type: "session", id: "sess-1", timestamp: new Date(ts).toISOString() }),
  JSON.stringify({ type: "message", id: "m1", parentId: "sess-1", timestamp: new Date(ts).toISOString(), message: { role: "user", content: [{ type: "text", text: "妈妈，今天想学论语" }] } }),
  JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: new Date(ts + 60000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "好的！我们先学先进篇。" }, { type: "toolCall", id: "t1", name: "kb_query", arguments: "{\"query\":\"topics\"}" }] } }),
];
const sync = await api("POST", "/sessions/child-smoke/sync", {
  files: [{ name: "sess-1.jsonl", fromOffset: 0, fromIndex: 0, lines }],
});
if (sync.files?.[0]?.lineCount !== 3) fail(`sync ack lineCount 应为 3: ${JSON.stringify(sync.files)}`);

// 幂等重放（同一批再发一次，lineCount 不增长）
const sync2 = await api("POST", "/sessions/child-smoke/sync", {
  files: [{ name: "sess-1.jsonl", fromOffset: 0, fromIndex: 0, lines }],
});
if (sync2.files?.[0]?.lineCount !== 3) fail(`幂等重放后 lineCount 应仍为 3: ${JSON.stringify(sync2.files)}`);
log("会话同步 + 幂等重放 通过");

const dates = await api("GET", "/sessions/child-smoke/dates");
if (!dates.dates?.some((d) => d.date === day)) fail(`dates 应包含 ${day}: ${JSON.stringify(dates)}`);
log("日期列表 通过:", JSON.stringify(dates.dates));

const msgs = await api("GET", `/sessions/child-smoke?date=${day}`);
if (msgs.messages?.length !== 2) fail(`messages 应为 2 条: ${JSON.stringify(msgs.messages)}`);
const ai = msgs.messages[1];
if (ai.role !== "assistant" || ai.toolCalls?.[0]?.name !== "kb_query") {
  fail(`assistant 消息应带工具调用: ${JSON.stringify(ai)}`);
}
log("家长回顾（逐字稿 + 工具调用） 通过");

// auth 静态加密
await api("POST", "/config/set", { key: "auth", value: { qwen: { type: "api_key", key: "sk-secret-test" } } });
{
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get("parent-smoke:auth");
  const stored = row?.value_json ?? "";
  if (!stored.startsWith('{"v":1,"iv":')) fail(`auth 应加密落盘: ${stored.slice(0, 60)}`);
  log("auth 静态加密落盘 通过");
  db.close();
}
const cfg = await api("GET", "/config");
const auth = cfg.config?.auth;
if (auth?.qwen?.key !== "sk-secret-test") fail(`GET /config 应解密回 auth: ${JSON.stringify(auth)}`);
log("auth 读取解密回环 通过");

log("\n✅ 全部冒烟用例通过");
child.kill("SIGTERM");
await sleep(500);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
