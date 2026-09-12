/**
 * 模型路由冒烟：模型列表 / 密钥（加密落盘） / app_settings 合并 / 脱敏读取。
 * 用法：npx tsx scripts/models-check.mts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { registerModelRoutes } from "../src/routes/models.js";
import { listProviderModels } from "@pi/agent-core";
import { signSession } from "../src/auth/jwt.js";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-models-check-"));
const SECRET = "check-secret";

async function main() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT, updated TEXT);");
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
  db.exec("INSERT INTO meta (key, value) VALUES ('config_revision', '0');");

  const app = Fastify();
  registerModelRoutes(app, { config: { dataDir: tmp, jwtSecret: SECRET } as any, db });
  const token = signSession({ parent_id: "p1", email: "a@b.c", plan: "free" }, SECRET, 1);
  const auth = { authorization: `Bearer ${token}` };

  // 列表
  const list = await app.inject({ method: "GET", url: "/api/v1/models", headers: auth });
  const models = JSON.parse(list.body).models as Array<{ provider: string; id: string; input: string[] }>;
  check("模型列表非空且含 qwen-tokenplan", list.statusCode === 200 && models.some((m) => m.provider === "qwen-tokenplan"), `count=${models.length}`);
  check("列表与静态枚举一致", models.length === listProviderModels().length);
  check("含视觉模型（input 含 image）", models.some((m) => m.input.includes("image")));

  const noToken = await app.inject({ method: "GET", url: "/api/v1/models" });
  check("无 token → 401", noToken.statusCode === 401);

  // 密钥（加密落盘，settings 表不存明文）
  const setKey = await app.inject({ method: "POST", url: "/api/v1/models/apikey", headers: auth, payload: { provider: "qwen", apiKey: "sk-secret-abc" } });
  check("设置 api key 200", setKey.statusCode === 200);
  const raw = db.prepare("SELECT value_json FROM settings WHERE key = ?").get("p1:auth") as { value_json: string };
  check("auth 落盘已加密（不存明文 key）", !raw.value_json.includes("sk-secret-abc"), raw.value_json.slice(0, 40));

  // app_settings 合并
  await app.inject({ method: "POST", url: "/api/v1/models/app_settings", headers: auth, payload: { defaultModel: "qwen-tokenplan/deepseek-v4-flash-0731" } });
  await app.inject({ method: "POST", url: "/api/v1/models/app_settings", headers: auth, payload: { visionModel: "qwen/qwen3-vl-flash" } });
  const st = await app.inject({ method: "GET", url: "/api/v1/models/settings", headers: auth });
  const settings = JSON.parse(st.body);
  check("app_settings 合并保留两个字段", settings.appSettings?.defaultModel && settings.appSettings?.visionModel);
  check("settings 脱敏：provider 有 hasKey、不回明文", settings.providers?.some((p: any) => p.provider === "qwen" && p.hasKey === true) && !st.body.includes("sk-secret-abc"));

  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? "\n全部通过 ✅" : `\n失败 ${failed} 项 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
