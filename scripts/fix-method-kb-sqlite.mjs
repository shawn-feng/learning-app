// ISSUE-023 P2：method.md 中旧 kb 工具引用（kb_patch/kb_append）批量替换为 SQL 工具（kb_update/kb_insert）
// 用法：node --experimental-strip-types scripts/fix-method-kb-sqlite.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const childrenDir = path.join(root, "data", "children");

let changedFiles = 0;
for (const childId of fs.readdirSync(childrenDir)) {
  const learningDir = path.join(childrenDir, childId, "learning");
  if (!fs.existsSync(learningDir)) continue;
  for (const topic of fs.readdirSync(learningDir, { withFileTypes: true })) {
    if (!topic.isDirectory()) continue;
    const methodFile = path.join(learningDir, topic.name, "method.md");
    if (!fs.existsSync(methodFile)) continue;
    const text = fs.readFileSync(methodFile, "utf-8");
    const updated = replaceKbRefs(text, topic.name);
    if (updated !== text) {
      fs.writeFileSync(methodFile, updated, "utf-8");
      changedFiles++;
      console.log(`updated: ${childId}/learning/${topic.name}/method.md`);
    }
  }
}
console.log(`完成：共更新 ${changedFiles} 个 method.md`);

/** 把 kb_patch 进度更新行 + kb_append daily 写入行替换为 SQL 工具格式。 */
function replaceKbRefs(text, topic) {
  // 1) kb_patch 进度更新（条目 + frontmatter 两段，一个长行）
  const patchRe = /更新进度 `learning\/[^`]+\.md` 用 `kb_patch`（禁止 write\/edit 裸写）：`item:"<课程名>"` 更新条目字段 `状态`→✅、`掌握度`、`首次学习`、`最近复习`（字段缺失自动追加）；frontmatter 用 `item:"frontmatter"` \+ `frontmatter:learned`\(\+1\)\/`frontmatter:next`\/`frontmatter:updated`。示例：`kb_patch \{file:"learning\/[^"]+\.md", item:"<课程名>", fields:\[\{field:"状态",value:"✅"\},\{field:"掌握度",value:"熟练"\},\{field:"首次学习",value:"2026-08-20"\},\{field:"最近复习",value:"2026-08-20"\}\]\}`，再 `kb_patch \{file:"learning\/[^"]+\.md", item:"frontmatter", fields:\[\{field:"frontmatter:learned",value:"283"\},\{field:"frontmatter:next",value:"下一课"\},\{field:"frontmatter:updated",value:"2026-08-20"\}\]\}`/;
  const patchNew = `更新进度用 \`kb_update\`（禁止 write/edit 裸写）：\`{table:"progress", topic:"${topic}", item:"<课程名>", field:"状态", value:"✅"}\` 等——条目字段 \`状态\`→✅、\`掌握度\`、\`首次学习\`、\`最近复习\`（字段缺失自动追加）；frontmatter 用 \`{table:"progress", topic:"${topic}", item:"frontmatter", field:"learned"|"total"|"next"|"updated", value:…}\`（learned +1）。示例：\`kb_update {table:"progress", topic:"${topic}", item:"<课程名>", field:"掌握度", value:"熟练"}\`，再 \`kb_update {table:"progress", topic:"${topic}", item:"frontmatter", field:"learned", value:"283"}\``;
  text = text.replace(patchRe, patchNew);

  // 2) kb_append daily 写入
  const appendRe = /写 `daily\/\{今天日期\}\.md` 的「学习」区块用 `kb_append`（文件不存在自动创建，禁止 write\/edit）：`\{file:"daily\/[^"]+\.md", block:"学习", content:"### <课程名>\\n- 考核：…\\n- 孩子表现：…"\}`/;
  const appendNew = `写 daily「学习」记录用 \`kb_insert\`（禁止 write/edit）：\`{table:"daily", date:"{今天日期 YYYY-MM-DD}", block:"学习", content:"### <课程名>\\n- 考核：…\\n- 孩子表现：…"}\``;
  text = text.replace(appendRe, appendNew);

  // 兜底：残留的其它 kb_patch / kb_append 调用行（含 file 指向进度文件/daily 的）
  text = text.replace(/`kb_patch \{file:"learning\/[^"]+\.md", item:"<课程名>", fields:\[[^\]]*\]\}`/g, `\`kb_update {table:"progress", topic:"${topic}", item:"<课程名>", field, value}\``);
  text = text.replace(/`kb_patch \{file:"learning\/[^"]+\.md", item:"frontmatter", fields:\[[^\]]*\]\}`/g, `\`kb_update {table:"progress", topic:"${topic}", item:"frontmatter", field, value}\``);
  text = text.replace(/`kb_append \{file:"daily\/[^"]+\.md", block:"学习", content:"### <课程名>\\n- 考核：…\\n- 孩子表现：…"\}`/g, `\`kb_insert {table:"daily", date:"{今天日期 YYYY-MM-DD}", block:"学习", content:"### <课程名>\\n- 考核：…\\n- 孩子表现：…"}\``);
  return text;
}
