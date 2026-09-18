/**
 * 一次性：量化「注册表元数据进 prompt」的成本（设计稿用数据）。
 * 对比：① 现状（逐表 describe 全量，按需拉取）；② 提议（紧凑清单常驻）。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parentLibTableRegistry,
  childKbReadableRegistry,
  describeTables,
  describeChildTables,
  childKbWritableRegistry,
} from "./src/agent/db-channel.js";

const out: string[] = [];

// ① 现状：逐表 describe 全量
const parentFull = parentLibTableRegistry()
  .map((s) => describeTables(parentLibTableRegistry(), s.table))
  .join("\n\n");
const childFull =
  childKbReadableRegistry().map((s) => describeChildTables(childKbReadableRegistry(), childKbWritableRegistry(), s.table)).join("\n\n");

// ② 提议：紧凑清单（表名 + 列名:一句话，无 flag/长度/枚举展开）
const parentCompact = parentLibTableRegistry()
  .map((s) => {
    const cols = Object.entries(s.columns)
      .map(([c, spec]) => {
        const brief = spec.desc.split("（")[0].split("；")[0].slice(0, 24);
        return `${c}(${brief})`;
      })
      .join(" ");
    return `${s.table} ${s.label}｜${s.ops.join("/")}｜pk=${s.pk.join("+")}｜${cols}`;
  })
  .join("\n");
const childCompact = childKbReadableRegistry()
  .map((s) => {
    const cols = Object.entries(s.columns)
      .map(([c, d]) => `${c}(${d.split("（")[0].slice(0, 18)})`)
      .join(" ");
    return `${s.table} ${s.label}｜${cols}`;
  })
  .join("\n");

const est = (s: string) => `字符 ${s.length} ≈ token ${Math.round(s.length / 1.48)}`;

out.push("【① 现状：逐表 describe 全量（按需拉取）】");
out.push(`  家长库 6 表：${est(parentFull)}`);
out.push(`  孩子库 14 表：${est(childFull)}`);
out.push("");
out.push("【② 提议：紧凑清单常驻 prompt】");
out.push(`  家长库：${est(parentCompact)}`);
out.push(`  孩子库：${est(childCompact)}`);
out.push(`  合计：${est(parentCompact + "\n" + childCompact)}`);
out.push("");
out.push("【③ 对照：本次事故那一次查询返回体】");
out.push(`  364180 字符 ≈ 246474 token（实测 usage.totalTokens 跳变）`);
out.push("");
out.push("【④ parent_db_describe 不传 table 时实际返回（= 工具里那段拼接）】");
const parentSpecs = parentLibTableRegistry();
const parentList = parentSpecs.map((s) => `- ${s.table}（${s.label}）：${s.desc}（允许 ${s.ops.join("/")}）`).join("\n");
const childList = childKbReadableRegistry().map((s) => `- ${s.table}（${s.label}）：${s.desc}`).join("\n");
const listOut =
  `【家长库 parent.sqlite】用 parent_db_read / parent_db_write（不传 child）操作：\n${parentList}\n\n` +
  `【孩子库 kb（每个孩子一个库）】用 parent_db_read / parent_db_write 传 child=孩子名 操作；` +
  `除 daily_entries、redemption_requests 可写外，其余只读：\n${childList}\n\n` +
  `传 table 查某表列结构；例如 parent_db_read({table:'study_plans', child:'孩子名'}) 查某孩子学习计划。`;
out.push(`  长度：${listOut.length} 字符 ≈ ${Math.round(listOut.length / 1.48)} token（只含表名+一句话，无任何列名）`);

writeFileSync(join(process.cwd(), "registry-size.out.txt"), out.join("\n"), "utf8");
console.log(out.join("\n"));
