#!/usr/bin/env node
/**
 * 知识库全量迁移 CLI（ISSUE-023 P2：markdown → SQLite 唯一真源）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/migrate-kb-sqlite.mjs            # 全部孩子
 *   node --experimental-strip-types scripts/migrate-kb-sqlite.mjs <childId>  # 指定孩子
 *
 * 迁移范围：daily/ + learning 进度 + topics.md/rules.md + tags 倒排 → kb.sqlite。
 * 幂等：重复执行按主键 REPLACE，不会重复入库。markdown 保留为归档，不删除。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { hasAnyKbData, migrateAllToSqlite } from "../electron/lib/kb-sqlite.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = process.env.WORKBUDDY_DATA_DIR || path.join(root, "data");
const childrenDir = path.join(dataDir, "children");

function run(childId) {
  const childDir = path.join(childrenDir, childId);
  if (!fs.existsSync(childDir)) {
    console.error(`孩子目录不存在: ${childDir}`);
    process.exit(1);
  }
  if (!hasAnyKbData(childDir)) {
    console.log(`${childId}: 无可迁移数据，跳过`);
    return;
  }
  const r = migrateAllToSqlite(childDir);
  const dbPath = path.join(childDir, "kb.sqlite");
  console.log(
    `${childId}: daily ${r.daily} 条 / 进度 ${r.progress} 主题 / topics ${r.topics} / rules ${r.rules} / tags 倒排 ${r.tagLinks} 条 → ${dbPath}`
  );
}

const target = process.argv[2];
if (target) {
  run(target);
} else {
  const childIds = fs.existsSync(childrenDir) ? fs.readdirSync(childrenDir).filter((f) => fs.statSync(path.join(childrenDir, f)).isDirectory()) : [];
  if (childIds.length === 0) {
    console.error(`无孩子目录: ${childrenDir}`);
    process.exit(1);
  }
  for (const id of childIds) run(id);
  console.log(`\n完成：共处理 ${childIds.length} 个孩子。`);
}
