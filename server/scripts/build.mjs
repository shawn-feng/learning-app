/**
 * M6 服务端构建：esbuild bundle → dist/server.js（单文件，含 fastify/jsonwebtoken）。
 * 之后可继续用 pkg 打平台可执行（见 scripts/pkg.mjs）。
 * 用法：node scripts/build.mjs
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// package.json 为 "type":"module"，esbuild CJS 产物必须用 .cjs 扩展名避免被当 ESM 解析
const outfile = path.join(root, "dist", "server.cjs");

await build({
  entryPoints: [path.join(root, "src", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile,
  // node: 内置模块不打包（node:sqlite 为 Node 内置实验模块，运行时有）
  external: ["node:sqlite"],
  legalComments: "none",
  logLevel: "info",
});

// 版本标记（供 pkg/运行识别）
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
console.log(`\n✓ 构建完成: ${outfile} (learning-server v${pkg.version})`);
