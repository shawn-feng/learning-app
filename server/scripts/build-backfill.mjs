/**
 * 向量回填脚本打包（ISSUE-111）：esbuild bundle → dist/backfill-embeddings.cjs
 * 单文件可拷到 201 用 node 直接跑（201 无需 tsx/源码）。
 * 用法：node scripts/build-backfill.mjs && node dist/backfill-embeddings.cjs [--parent <id>]
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(root, "..");
const outfile = path.join(root, "dist", "backfill-embeddings.cjs");

await build({
  entryPoints: [path.join(root, "scripts", "backfill-embeddings.mts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile,
  alias: {
    "@pi/agent-core": path.join(repoRoot, "packages", "agent-core", "src", "index.ts"),
    "@earendil-works/pi-coding-agent": path.join(root, "node_modules", "@earendil-works", "pi-coding-agent"),
  },
  external: ["node:sqlite"],
  legalComments: "none",
  logLevel: "info",
});

// import_meta.url 垫片（与 build.mjs 同款：pi-coding-agent 内部定位资源用）
{
  const out = fs.readFileSync(outfile, "utf-8");
  const patched = out.replace(
    /\bimport_meta\d*\.url\b/g,
    "require('url').pathToFileURL(__filename).href"
  );
  fs.writeFileSync(outfile, patched);
  console.log(`✓ import_meta.url 垫片已打补丁（${(out.match(/\bimport_meta\d*\.url\b/g) || []).length} 处）`);
}
console.log(`✓ 构建完成: ${outfile}`);
