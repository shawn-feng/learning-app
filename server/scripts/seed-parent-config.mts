// 一次性开发助手：把客户端本地家长配置（auth 密钥 + app_settings 默认模型）播种到服务端 settings。
// 等价于客户端「保存 key/模型」时经 /config/set 的推送（auth 走加密落盘）。仅开发/自愈用。
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getServerSecret, encryptJson } from "../src/crypto.js";

const dataDir = process.argv[2] ?? "data"; // server/data
const parentId = process.argv[3];
const localConfigDir = process.argv[4]; // 客户端 parents/<pid>

if (!parentId || !localConfigDir) {
  console.error("用法: node scripts/seed-parent-config.mjs <dataDir> <parentId> <localConfigDir>");
  process.exit(1);
}
const db = new DatabaseSync(`${dataDir}/server.sqlite`);
const secret = getServerSecret(dataDir);

const set = (key, value) => {
  db.prepare(
    "INSERT INTO settings (key, value_json, updated) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated = excluded.updated"
  ).run(`${parentId}:${key}`, value, new Date().toISOString());
};

// auth（加密）
const authPath = `${localConfigDir}/auth.json`;
if (fs.existsSync(authPath)) {
  const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  const keys = Object.keys(auth).filter((k) => auth[k]?.key);
  set("auth", encryptJson(secret, auth));
  console.log("auth 已播种:", keys.join(", "));
} else {
  console.log("(本地 auth.json 不存在，跳过)");
}

// app_settings
const asPath = `${localConfigDir}/app-settings.json`;
if (fs.existsSync(asPath)) {
  const as = JSON.parse(fs.readFileSync(asPath, "utf-8"));
  set("app_settings", JSON.stringify(as));
  console.log("app_settings 已播种: defaultModel =", as.defaultModel ?? "(未设置)");
}

db.close();
console.log("完成。");
