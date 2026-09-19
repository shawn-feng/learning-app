/**
 * 向量回填脚本（ISSUE-111）：为家长库登记列（courses.title / topics.name）补齐向量。
 * - 增量幂等：source_hash + model 一致的行跳过；
 * - 未配置可用 embedding provider 时直接退出提示；
 * - 分批 10 条/次调用；失败的重试留到下次运行。
 *
 * 运行：cd server && npx tsx scripts/backfill-embeddings.mts [--parent <parentId>]
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openParentLib } from "../src/db/parent-lib.js";
import { readParentSettings } from "../src/worker/scheduler.js";
import {
  resolveEmbedding,
  embedTexts,
  ensureEmbeddingsSchema,
  hashText,
  vectorToBlob,
  type ResolvedEmbedding,
} from "../src/agent/embeddings.js";
import { DatabaseSync } from "node:sqlite";

const DATA = join(process.cwd(), "data");
const argParent = process.argv.find((a) => a.startsWith("--parent"))?.split("=")[1]
  ?? process.argv[process.argv.indexOf("--parent") + 1]
  ?? null;

const mainDb = new DatabaseSync(join(DATA, "server.sqlite"));

const parents: string[] = [];
if (argParent) {
  parents.push(argParent);
} else if (existsSync(join(DATA, "parents"))) {
  for (const pid of readdirSync(join(DATA, "parents"))) {
    if (existsSync(join(DATA, "parents", pid, "parent.sqlite"))) parents.push(pid);
  }
}

let totalEmbedded = 0;
let totalSkipped = 0;

for (const parentId of parents) {
  let settings: { auth: Record<string, unknown> };
  try {
    settings = readParentSettings(mainDb, DATA, parentId);
  } catch {
    continue;
  }
  const resolved: ResolvedEmbedding | null = resolveEmbedding(settings.auth);
  if (!resolved) {
    console.log(`[${parentId.slice(0, 8)}] 未配置支持 embedding 的 provider key，跳过`);
    continue;
  }
  const db = openParentLib(DATA, parentId);
  ensureEmbeddingsSchema(db);
  for (const [table, pkCols, column] of [
    ["courses", ["topic", "title"], "title"],
    ["topics", ["name"], "name"],
  ] as Array<[string, string[], string]>) {
    const rows = db.prepare(`SELECT ${pkCols.join(", ")}, ${column} FROM ${table}`).all() as Array<Record<string, unknown>>;
    const todo: Array<{ rowPk: string; text: string }> = [];
    for (const row of rows) {
      const text = String(row[column] ?? "");
      if (!text.trim()) continue;
      const rowPk = JSON.stringify(pkCols.map((c) => row[c]));
      const hash = hashText(text);
      const exist = db
        .prepare("SELECT source_hash, model FROM embeddings WHERE table_name = ? AND row_pk = ? AND column_name = ?")
        .get(table, rowPk, column) as { source_hash: string; model: string } | undefined;
      if (exist && exist.source_hash === hash && exist.model === resolved.model) {
        totalSkipped++;
        continue;
      }
      todo.push({ rowPk, text });
    }
    console.log(`[${parentId.slice(0, 8)}] ${table}.${column}: 共 ${rows.length} 行，待嵌入 ${todo.length} 行`);
    for (let i = 0; i < todo.length; i += 10) {
      const batch = todo.slice(i, i + 10);
      try {
        const vecs = await embedTexts(resolved, batch.map((b) => b.text));
        batch.forEach((b, j) => {
          const vec = vecs[j];
          db.prepare(
            `INSERT INTO embeddings (table_name, row_pk, column_name, model, dim, vector, source_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(table_name, row_pk, column_name) DO UPDATE SET
               model = excluded.model, dim = excluded.dim, vector = excluded.vector,
               source_hash = excluded.source_hash, updated_at = datetime('now','localtime')`
          ).run(table, b.rowPk, column, resolved.model, vec.length, vectorToBlob(vec), hashText(b.text));
          totalEmbedded++;
        });
        process.stdout.write(`  进度 ${Math.min(i + 10, todo.length)}/${todo.length}\r`);
      } catch (e) {
        console.error(`\n  批次失败（${(e as Error).message.slice(0, 120)}），余下批次中止，可重跑本脚本续填`);
        i = todo.length;
      }
    }
    console.log("");
  }
  db.close();
}
mainDb.close();
console.log(`\n完成：新嵌入 ${totalEmbedded} 行，跳过（已最新）${totalSkipped} 行`);
