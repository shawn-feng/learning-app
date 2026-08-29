/**
 * M6 服务端平台可执行打包（@yao-pkg/pkg，vercel/pkg 社区维护 fork）。
 * 先跑 scripts/build.mjs 得到 dist/server.js，再执行本脚本打 Windows exe 与 Linux 可执行。
 * 用法：node scripts/pkg.mjs [win|linux|all]（默认 all）
 *
 * ⚠️ --public-packages "*" --public：源码明文打包（不生成 V8 bytecode）。
 * 否则 pkg 会把 server.cjs 编译成 bytecode 缓存，跨机器运行报
 * "V8 rejected the bytecode cache"（2026-08-29 部署 192.168.1.201 实测踩坑）。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
const serverJs = path.join(root, "dist", "server.cjs");
if (!fs.existsSync(serverJs)) {
  console.error("未找到 dist/server.cjs，请先运行 node scripts/build.mjs");
  process.exit(1);
}

const targets = process.argv[2] === "win" ? ["node22-win-x64"] : process.argv[2] === "linux" ? ["node22-linux-x64"] : ["node22-win-x64", "node22-linux-x64"];

const cmd = [
  "npx pkg",
  `"${serverJs}"`,
  `--target ${targets.join(",")}`,
  `--output "${path.join(root, "dist", "learning-server")}"`,
  "--public-packages \"*\" --public",
  "--compress GZip",
].join(" ");

console.log(`pkg 打包 learning-server v${pkgJson.version}: ${targets.join(", ")}`);
execSync(cmd, { cwd: root, stdio: "inherit", shell: true });

console.log("✓ 平台可执行文件已输出到 dist/（Windows 为 learning-server.exe）");
