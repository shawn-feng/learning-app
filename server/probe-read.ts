import { openParentLib } from "./src/db/parent-lib.js";
import { parentReadableRegistry, executeRead } from "./src/agent/db-channel.js";

const dataDir = "C:\\Users\\79734\\Documents\\pi\\server\\data";
const parentId = "86a84278-c8ae-415e-8fbc-6140b1b7c88e";

const db = openParentLib(dataDir, parentId);
const specs = parentReadableRegistry();

const out: string[] = [];
out.push("=== 统一数据 API 覆盖的「可读登记表」（parent_db_read 无需为每张表写专用工具）===");
for (const s of specs) {
  let n = "?";
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${s.table}`).get() as any;
    n = String(row?.n ?? 0);
  } catch (e: any) {
    n = `表不存在(${e.message.split("\n")[0]})`;
  }
  out.push(`- ${s.table}（${s.label}）：${n} 行`);
}

out.push("\n=== 演示① parent_db_read 读 topics（前 3 行，无专用工具）===");
out.push(executeRead(db, specs, { table: "topics", limit: 3 }).text);

out.push("\n=== 演示② parent_db_read 读 courses（前 3 行，无专用工具）===");
out.push(executeRead(db, specs, { table: "courses", limit: 3 }).text);

out.push("\n=== 演示③ 过滤查询：question_bank 里 behavior='generic' 的题（等值 where，SQL 在库内执行）===");
out.push(executeRead(db, specs, { table: "question_bank", where: { behavior: "generic" }, limit: 3 }).text);

db.close();
console.log(out.join("\n"));
