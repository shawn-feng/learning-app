/**
 * 迁移清扫（部署后一次性执行）：枚举全部家长/孩子库并打开（openParentLib/openKb
 * 内部幂等迁移），确保所有存量库完成库域分工/向量旁表等迁移，供漂移探针核验。
 * 运行：cd server && node scripts/migration-sweep.cjs（bundle 后）
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openParentLib } from "../src/db/parent-lib.js";
import { openKb } from "../src/db/kb.js";

const DATA = join(process.cwd(), "data");
let parents = 0;
let children = 0;
let errors = 0;

const parentsDir = join(DATA, "parents");
if (existsSync(parentsDir)) {
  for (const pid of readdirSync(parentsDir)) {
    const f = join(parentsDir, pid, "parent.sqlite");
    if (!existsSync(f)) continue;
    try {
      const db = openParentLib(DATA, pid);
      db.close();
      parents++;
    } catch (e) {
      errors++;
      console.error(`[FAIL] 家长库 ${pid}: ${(e as Error).message}`);
    }
  }
}

const kbDir = join(DATA, "kb");
if (existsSync(kbDir)) {
  for (const pid of readdirSync(kbDir)) {
    const cdir = join(kbDir, pid);
    if (!existsSync(cdir)) continue;
    for (const f of readdirSync(cdir)) {
      if (!f.endsWith(".sqlite")) continue;
      try {
        const db = openKb(DATA, pid, f.replace(/\.sqlite$/, ""));
        db.close();
        children++;
      } catch (e) {
        errors++;
        console.error(`[FAIL] 孩子库 ${pid}/${f}: ${(e as Error).message}`);
      }
    }
  }
}

console.log(`迁移清扫完成：家长库 ${parents} 个，孩子库 ${children} 个，失败 ${errors}`);
process.exit(errors ? 1 : 0);
