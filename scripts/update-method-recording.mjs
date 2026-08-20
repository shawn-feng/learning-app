// 一次性脚本：把各主题 method.md 的「记录」段从 write/edit 改为 kb 工具指引
import fs from "fs";
import path from "path";

const childDir = process.argv[2] || "data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674/learning";
const changed = [];

for (const topic of fs.readdirSync(childDir)) {
  const p = path.join(childDir, topic, "method.md");
  if (!fs.existsSync(p)) continue;
  let text = fs.readFileSync(p, "utf-8");
  const before = text;

  // 步骤1：更新进度 → kb_patch
  text = text.replace(/1\. 更新进度 `learning\/[^`]+`：[^\n]*/, () => {
    return (
      `1. 更新进度 \`learning/${topic}/${topic}.md\` 用 \`kb_patch\`（禁止 write/edit 裸写）：` +
      `\`item:"<课程名>"\` 更新条目字段 \`状态\`→✅、\`掌握度\`、\`首次学习\`、\`最近复习\`（字段缺失自动追加）；` +
      `frontmatter 用 \`item:"frontmatter"\` + \`frontmatter:learned\`(+1)/\`frontmatter:next\`/\`frontmatter:updated\`。` +
      `示例：\`kb_patch {file:"learning/${topic}/${topic}.md", item:"<课程名>", fields:[{field:"状态",value:"✅"},{field:"掌握度",value:"熟练"},{field:"首次学习",value:"2026-08-20"},{field:"最近复习",value:"2026-08-20"}]}\`，` +
      `再 \`kb_patch {file:"learning/${topic}/${topic}.md", item:"frontmatter", fields:[{field:"frontmatter:learned",value:"283"},{field:"frontmatter:next",value:"下一课"},{field:"frontmatter:updated",value:"2026-08-20"}]}\``
    );
  });

  // 步骤2：写 daily → kb_append（保留各主题原「逐字段详写…」部分）
  text = text.replace(/2\. 写 `daily\/\{今天日期\}\.md` 的「学习」区块：([^\n]*)/, (_m, rest) => {
    return (
      `2. 写 \`daily/{今天日期}.md\` 的「学习」区块用 \`kb_append\`（文件不存在自动创建，禁止 write/edit）：` +
      `\`{file:"daily/2026-08-20.md", block:"学习", content:"### <课程名>\\n- 考核：…\\n- 孩子表现：…"}\`——` +
      `以 \`### <课程名>\` 为标题，` + rest
    );
  });

  if (text !== before) {
    fs.writeFileSync(p, text);
    changed.push(topic);
  }
}
console.log("已更新:", changed.join(", ") || "(无)");
