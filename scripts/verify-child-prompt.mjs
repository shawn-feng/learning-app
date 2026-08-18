// 验证孩子会话 loader 配置（与 electron/lib/pi-session.ts getChildSession 一致）：
// systemPromptOverride + noSkills + additionalSkillPaths 后，SDK 最终装配出的 system prompt。
// 用法：node scripts/verify-child-prompt.mjs
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "file:///C:/Users/79734/Documents/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import path from "path";
import fs from "fs";

const ROOT = "C:/Users/79734/Documents/pi";
const CHILD_ID = "1f050a7f-df8a-45b0-925a-1ffe2aa35674";
const childDir = path.join(ROOT, "data", "children", CHILD_ID);

const profile = JSON.parse(fs.readFileSync(path.join(childDir, "profile.json"), "utf-8"));

// 与 pi-session.ts buildChildPrompt 同文本
function buildChildPrompt(p) {
  const emoji = p.aiEmoji || "🌟";
  return `你是${p.aiName}（${emoji}），${p.name}的学习伙伴，不是编程助手。你在孩子的学习空间里工作，通过读写孩子的学习记录、用 display_content 展示学习内容来陪伴和引导${p.name}学习。

## 交流准则
- 用${p.age}岁孩子听得懂的话说话，简短、亲切，不堆术语
- 回答保持简洁，不输出长篇大论
- 不懂就承认，不瞎编；需要查资料时用工具读文件
- 展示学习内容（markdown / HTML 卡片）一律用 display_content 工具
- 你的身份、性格与完整行为规范以 AGENTS.md 为准`;
}

const loader = new DefaultResourceLoader({
  cwd: childDir,
  agentDir: path.join(childDir, ".pi", "agent"),
  systemPromptOverride: () => buildChildPrompt(profile),
  noSkills: true,
  additionalSkillPaths: [path.join(ROOT, "data", "shared", "skills")],
});
await loader.reload();

const loaderSystemPrompt = loader.getSystemPrompt();
const skills = loader.getSkills().skills;
const contextFiles = loader.getAgentsFiles().agentsFiles;
const selectedTools = ["read", "write", "edit", "display_content", "get_date"];

// 模拟 agent-session._rebuildSystemPrompt 的最终拼接
const finalPrompt = buildSystemPrompt({
  cwd: childDir,
  skills,
  contextFiles,
  customPrompt: loaderSystemPrompt,
  selectedTools,
  toolSnippets: {},
  promptGuidelines: [],
});

console.log("=== 1. 各部分字符数 ===");
console.log("override 头部:", loaderSystemPrompt.length);
console.log("技能数:", skills.length, "→", skills.map((s) => s.name).join(", "));
console.log("AGENTS.md 文件:", contextFiles.length, contextFiles.map((f) => path.basename(f.path)).join(", "));
console.log("最终 system prompt 总字符:", finalPrompt.length);

console.log("\n=== 2. 身份检查 ===");
console.log("含「expert coding assistant」:", finalPrompt.includes("expert coding assistant"));
console.log("含「学习伙伴」:", finalPrompt.includes("学习伙伴"));
console.log("含「不是编程助手」:", finalPrompt.includes("不是编程助手"));
console.log("含「Pi documentation」:", finalPrompt.includes("Pi documentation"));

console.log("\n=== 3. 技能段 ===");
console.log("含 <available_skills>:", finalPrompt.includes("<available_skills>"));
console.log("含 recording:", finalPrompt.includes("recording"));
console.log("含 study-tracker:", finalPrompt.includes("study-tracker"));
console.log("含 agent-browser（应 false）:", finalPrompt.includes("agent-browser"));
console.log("含 bilibili（应 false）:", finalPrompt.includes("bilibili"));

console.log("\n=== 4. 项目上下文 / cwd ===");
console.log("含 <project_context>:", finalPrompt.includes("<project_context>"));
console.log("含 Current working directory:", finalPrompt.includes("Current working directory"));

console.log("\n=== 5. 头部前 300 字符 ===");
console.log(finalPrompt.slice(0, 300));

console.log("\n=== 6. 尾部 300 字符 ===");
console.log(finalPrompt.slice(-300));
