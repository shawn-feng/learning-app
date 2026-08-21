// 常驻化「method.md kb 工具引用修复」（ISSUE-022 修复脚本）。
// 把各主题 method.md 里对数据文件写法的陈旧/错误 kb 工具引用，改写为规范写法。
// 覆盖：
//   ① update-method-recording.mjs 的已知句式（进度→kb_patch、daily→kb_append）；
//   ② 过时工具名映射（kb_get→kb_read、kb_update→kb_patch）。
// 幂等、可重复跑；默认不自动执行（ISSUE-022 决策：避免误改家长自定义内容，需人确认后手动跑）。
// 用法：node scripts/fix-method-kb.mjs <learning 目录>
import fs from "fs";
import path from "path";

const learningDir =
  process.argv[2] || "data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674/learning";
const changed = [];

// 过时工具名映射（独立词边界，避免误改如 kb_get_date 之类；不在白名单的 kb_ 工具）
const TOOL_RENAMES = [
  [/\bkb_get\b/g, "kb_read"],
  [/\bkb_update\b/g, "kb_patch"],
];

if (!fs.existsSync(learningDir)) {
  console.error("learning 目录不存在:", learningDir);
  process.exit(1);
}

for (const topic of fs.readdirSync(learningDir)) {
  const p = path.join(learningDir, topic, "method.md");
  if (!fs.existsSync(p)) continue;
  let text = fs.readFileSync(p, "utf-8");
  const before = text;

  // 步骤1：更新进度 → kb_patch（复用 update-method-recording.mjs 句式，带 topic）
  text = text.replace(/1\. 更新进度 `learning\/[^`]+`：[^\n]*/, () => {
    return (
      `1. 更新进度 \`learning/${topic}/${topic}.md\` 用 \`kb_patch\`（禁止 write/edit 裸写）：` +
      `\`item:"<课程名>"\` 更新条目字段 \`状态\`→✅、\`掌握度\`、\`首次学习\`、\`最近复习\`（字段缺失自动追加）；` +
      `frontmatter 用 \`item:"frontmatter"\` + \`frontmatter:learned\`(+1)/\`frontmatter:next\`/\`frontmatter:updated\`。` +
      `示例：\`kb_patch {file:"learning/${topic}/${topic}.md", item:"<课程名>", fields:[{field:"状态",value:"✅"},{field:"掌握度",value:"熟练"},{field:"首次学习",value:"2026-08-20"},{field:"最近复习",value:"2026-08-20"}]}\`，` +
      `再 \`kb_patch {file:"learning/${topic}/${topic}.md", item:"frontmatter", fields:[{field:"frontmatter:learned",value:"283"},{field:"frontmatter:next",value:"下一课"},{field:"frontmatter:updated",value:"2026-08-20"}]}\``
    );
  });

  // 步骤2：写 daily → kb_append
  text = text.replace(/2\. 写 `daily\/\{今天日期\}\.md` 的「学习」区块：([^\n]*)/, (_m, rest) => {
    return (
      `2. 写 \`daily/{今天日期}.md\` 的「学习」区块用 \`kb_append\`（文件不存在自动创建，禁止 write/edit）：` +
      `\`{file:"daily/2026-08-20.md", block:"学习", content:"### <课程名>\\n- 考核：…\\n- 孩子表现：…"}\`——` +
      `以 \`### <课程名>\` 为标题，` + rest
    );
  });

  // 步骤3：过时工具名映射
  for (const [re, rep] of TOOL_RENAMES) {
    text = text.replace(re, rep);
  }

  if (text !== before) {
    fs.writeFileSync(p, text);
    changed.push(topic);
  }
}
console.log("已更新:", changed.join(", ") || "(无)");
