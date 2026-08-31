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

// ⚠️ pi-coding-agent 内部用 import.meta.url 定位资源；esbuild 转 CJS 后变成
// `var import_meta = {}; fileURLToPath(import_meta.url)` → url 为 undefined，
// 启动即崩（2026-08-31 冒烟实测）。构建后正则把所有 `import_metaN.url` 替换为
// CJS 下的 __filename 等价物（数量不定，用正则一网打尽）。
{
  const out = fs.readFileSync(outfile, "utf-8");
  const patched = out.replace(
    /\bimport_meta\d*\.url\b/g,
    "require('url').pathToFileURL(__filename).href"
  );
  fs.writeFileSync(outfile, patched);
  console.log(`✓ import_meta.url 垫片已打补丁（${(out.match(/\bimport_meta\d*\.url\b/g) || []).length} 处）`);
}

// 版本标记（供 pkg/运行识别）
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
console.log(`\n✓ 构建完成: ${outfile} (learning-server v${pkg.version})`);
