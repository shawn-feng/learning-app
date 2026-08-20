#!/usr/bin/env node
/**
 * 知识库数据格式校验 CLI（确定性脚本，SPEC 5.5）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/kb-lint.mjs            # 检查 data/children 下所有孩子
 *   node --experimental-strip-types scripts/kb-lint.mjs <childId>  # 只检查指定孩子
 *
 * 报告写入各孩子目录 lint-report.md；终端输出汇总。只报告，不修改任何数据。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { lintChildDir, lintAllChildren } from "../electron/lib/kb-lint.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = process.env.WORKBUDDY_DATA_DIR || path.join(root, "data");

const target = process.argv[2];

if (target) {
  const childDir = path.join(dataDir, "children", target);
  if (!fs.existsSync(childDir)) {
    console.error(`孩子目录不存在: ${childDir}`);
    process.exit(1);
  }
  const issues = lintChildDir(childDir);
  printSummary(target, issues);
} else {
  const results = lintAllChildren(dataDir);
  let total = 0;
  for (const r of results) {
    total += r.issues.length;
    printSummary(r.childId, r.issues);
  }
  console.log(`\n完成：共检查 ${results.length} 个孩子，违规 ${total} 条。报告已写入各孩子目录 lint-report.md`);
  if (total > 0) process.exitCode = 2;
}

function printSummary(childId, issues) {
  const errors = issues.filter((i) => (i.severity ?? "error") === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  console.log(`\n=== ${childId}：error ${errors.length} / warning ${warnings.length} ===`);
  for (const it of errors.slice(0, 50)) {
    console.log(`  [${it.kind}] ${it.file}${it.line ? `:${it.line}` : ""} — ${it.message}`);
  }
  if (errors.length > 50) console.log(`  … 另有 ${errors.length - 50} 条 error`);
  if (warnings.length > 0) console.log(`  （${warnings.length} 条 warning 为字段不在白名单，见 lint-report.md）`);
}
