// 一次性迁移：用源码里最新的 LEARNING_NAV_INSTRUCTIONS 重新生成所有孩子的 AGENTS.md。
// 直接读取 electron/lib/pi-session.ts 提取 LEARNING_NAV，避免与源码漂移；
// 保留每个孩子 AGENTS.md 中 custom 段内家长手动编辑的内容。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const childrenDir = path.join(root, "data", "children");

const src = fs.readFileSync(
  path.join(root, "electron", "lib", "pi-session.ts"),
  "utf-8"
);
// 提取 LEARNING_NAV_INSTRUCTIONS 模板（以 `; 结尾，内部 inline code 用 \` 转义）
const m = src.match(/const LEARNING_NAV_INSTRUCTIONS = `([\s\S]*?)`;/);
if (!m) {
  console.error("未能从源码提取 LEARNING_NAV_INSTRUCTIONS");
  process.exit(1);
}
const nav = m[1].replace(/\\`/g, "`");

const CUSTOM_START = "<!-- custom:start -->";
const CUSTOM_END = "<!-- custom:end -->";
function extractCustom(content) {
  const mm = content.match(
    /<!--\s*custom:start\s*-->([\s\S]*?)<!--\s*custom:end\s*-->/
  );
  return mm ? mm[1] : "";
}

function buildAgentsMd(profile, custom) {
  return `你是${profile.aiName}，${profile.name}的学习伙伴。

## 你的身份
- 名字：${profile.aiName}
- 图标：${profile.aiEmoji || "🤖"}
- 性格：${profile.aiPersonality}

## 你的学生
- 名字：${profile.name}
- 年龄：${profile.age}岁
- 年级：${profile.grade}
- 兴趣爱好：${profile.interests}

${nav}

${CUSTOM_START}
${custom}${CUSTOM_END}
`;
}

if (!fs.existsSync(childrenDir)) {
  console.error("未找到 data/children 目录");
  process.exit(1);
}

const dirs = fs
  .readdirSync(childrenDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

let count = 0;
for (const id of dirs) {
  const childDir = path.join(childrenDir, id);
  const profilePath = path.join(childDir, "profile.json");
  const agentsPath = path.join(childDir, "AGENTS.md");
  if (!fs.existsSync(profilePath)) continue;
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
  const custom = fs.existsSync(agentsPath)
    ? extractCustom(fs.readFileSync(agentsPath, "utf-8"))
    : "";
  fs.writeFileSync(agentsPath, buildAgentsMd(profile, custom), "utf-8");
  count++;
  console.log("regenerated:", id);
}
console.log(`完成：共重新生成 ${count} 个 AGENTS.md`);
