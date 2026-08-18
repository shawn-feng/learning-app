const SDK = "file:///C:/Users/79734/Documents/pi/node_modules/@earendil-works/pi-coding-agent/dist/core";
import { buildSystemPrompt } from "file:///C:/Users/79734/Documents/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { loadSkills } from "file:///C:/Users/79734/Documents/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js";
import { loadProjectContextFiles } from "file:///C:/Users/79734/Documents/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js";
import { createReadToolDefinition } from "file:///C:/Users/79734/Documents/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js";
import { createWriteToolDefinition } from "file:///C:/Users/79734/Documents/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js";
import { createEditToolDefinition } from "file:///C:/Users/79734/Documents/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js";
import { Type } from "typebox";
import fs from "fs";
import path from "path";

const childId = "1f050a7f-df8a-45b0-925a-1ffe2aa35674";
const childDir = path.resolve("C:/Users/79734/Documents/pi/data/children/" + childId);
const agentDir = path.join(childDir, ".pi", "agent");

// ---- 1) 真实加载 contextFiles（AGENTS.md）与 skills ----
const contextFiles = loadProjectContextFiles({ cwd: childDir, agentDir });
const { skills } = loadSkills({ cwd: childDir, agentDir, skillPaths: [], includeDefaults: false });

// ---- 2) 工具一句话描述（promptSnippet），仅含 snippet 的工具出现在 system prompt 的 Available tools ----
const readDef = createReadToolDefinition(childDir, {});
const writeDef = createWriteToolDefinition(childDir, {});
const editDef = createEditToolDefinition(childDir, {});

// 自定义工具（与 electron/lib/custom-tools.ts 保持一致）
const displayContentDef = {
  name: "display_content",
  description:
    "在学习内容面板展示教学内容。支持 markdown 和 html 两种格式。html 格式在沙盒 iframe 中渲染，可运行内联 <script> 和 onclick 等交互逻辑，可播放 <audio>/<video>（src 用 media://local/ 开头的本地媒体地址）。\n\n两种用法：\n1. 直接传 content（现场拼内容）；\n2. 传 path 引用预生成的学习资料文件（推荐）：path 是相对当前学习目录的文件路径，如 `learning/lunyu/materials/论语先进篇第十三章.html`，格式按扩展名自动识别（.html→html，其余→markdown）。当孩子要学某一课时，优先用 path 引用该课预生成的 html 资料（含吟诵音频、翻译、道理讲解）。",
  parameters: Type.Object({
    format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("html")], { description: "内容格式：markdown 或 html（用 path 时可选，自动按扩展名识别）" })),
    content: Type.Optional(Type.String({ description: "要展示的内容（用 path 时可省略）" })),
    path: Type.Optional(Type.String({ description: "预生成资料文件路径，相对学习目录，如 learning/lunyu/materials/论语先进篇第十三章.html" })),
    title: Type.Optional(Type.String({ description: "内容标题" })),
  }),
};
const getDateDef = {
  name: "get_date",
  description:
    "返回当前的准确日期和时间（YYYY-MM-DD 星期几 HH:mm:ss）。当需要写 daily 日志文件、更新学习进度文件里的日期字段（如 updated、首次学习、最近复习），或回答\"今天几号\"\"星期几\"\"现在几点\"时，必须先调用本工具获取准确日期时间，不要自行猜测或从对话历史里推断（历史里的日期可能是过期的）。",
  promptSnippet: "get_date - 获取当前的准确日期和时间（YYYY-MM-DD 星期几 HH:mm:ss）",
  parameters: Type.Object({}),
};

const toolDefs = { read: readDef, write: writeDef, edit: editDef, display_content: displayContentDef, get_date: getDateDef };

// system prompt 中只会出现有 promptSnippet 的工具
const toolSnippets = {};
for (const [name, def] of Object.entries(toolDefs)) {
  if (def.promptSnippet) {
    toolSnippets[name] = def.promptSnippet.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  }
}

// ---- 3) 构建 system prompt（与 child session 一致：customPrompt=undefined 分支）----
const selectedTools = ["read", "write", "edit", "display_content", "get_date"];
const systemPrompt = buildSystemPrompt({
  cwd: childDir,
  skills,
  contextFiles,
  customPrompt: undefined,
  appendSystemPrompt: undefined,
  selectedTools,
  toolSnippets,
  promptGuidelines: [],
});

// ---- 4) 拆分 system prompt 文本 ----
function extractBlock(text, tag) {
  const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g");
  const m = text.match(re);
  return m ? m.join("\n") : "";
}
const projectCtxBlock = extractBlock(systemPrompt, "project_context");
const skillsBlock = extractBlock(systemPrompt, "available_skills");
const cwdLineMatch = systemPrompt.match(/\nCurrent working directory:.*$/);
const cwdLine = cwdLineMatch ? cwdLineMatch[0] : "";

// SDK 基础 = 总文本 - project_context - available_skills - cwd 行
const sdkBase = systemPrompt.length - projectCtxBlock.length - skillsBlock.length - cwdLine.length;

// ---- 5) 工具 function calling schemas（独立于 system prompt 另发）----
const toolSchemasWrapped = [];
const toolSchemasBody = [];
for (const [name, def] of Object.entries(toolDefs)) {
  const fn = { name: def.name, description: def.description, parameters: def.parameters };
  const wrapped = { type: "function", function: fn };
  toolSchemasWrapped.push(wrapped);
  toolSchemasBody.push(fn);
}
const toolsWrappedJson = JSON.stringify(toolSchemasWrapped, null, 0);
const toolsBodyJson = JSON.stringify(toolSchemasBody, null, 0);

const perTool = {};
for (const [name, def] of Object.entries(toolDefs)) {
  const fn = { name: def.name, description: def.description, parameters: def.parameters };
  const wrapped = { type: "function", function: fn };
  perTool[name] = {
    description: def.description.length,
    parameters: JSON.stringify(def.parameters).length,
    wrapped: JSON.stringify(wrapped).length,
  };
}

// ---- 输出 ----
const ctxContentChars = contextFiles.reduce((s, f) => s + f.content.length, 0);
console.log("==== SYSTEM PROMPT 文本（孩子会话，珊珊） ====");
console.log("system prompt 总字符:", systemPrompt.length);
console.log("  ├─ SDK 基础（含 Available tools 一句话描述 + guidelines + Pi 文档指引）:", sdkBase);
console.log("  ├─ 项目上下文 <project_context>（AGENTS.md 原文）:", projectCtxBlock.length, "（包裹标签含）| 内容纯文本:", ctxContentChars);
console.log("  ├─ 技能 <available_skills>（name+description+location 索引）:", skillsBlock.length);
console.log("  └─ cwd 行:", cwdLine.length);

console.log("\n==== 工具 function calling schemas（独立发送，不计入上方 system prompt） ====");
console.log("全部工具 wrapped JSON 总字符:", toolsWrappedJson.length);
console.log("全部工具 body(不含type包裹) 总字符:", toolsBodyJson.length);
console.log("逐项（wrapped 含 {type:function,...}）:");
for (const [name, v] of Object.entries(perTool)) {
  console.log(`  - ${name}: description=${v.description}, parameters=${v.parameters}, wrapped=${v.wrapped}`);
}

console.log("\n==== 合并口径（若此前 31,936 含工具 schema） ====");
const totalWithTools = systemPrompt.length + toolsWrappedJson.length;
console.log("system prompt + 工具 schemas 合计字符:", totalWithTools);
console.log("≈ token（中文按 ~1.6 字/token 粗估）:", Math.round(totalWithTools / 1.8));

// ---- 家长会话（systemPromptOverride = buildParentPrompt）----
const dataDir = path.resolve("C:/Users/79734/Documents/pi/data");
function buildParentPrompt() {
  return `你是家长工作台助手，帮助家长管理孩子的学习内容和教学技能。

你的工作目录是数据根目录（data/），用相对路径访问以下内容：

## 目录结构
\`\`\`
shared/skills/                 # 教学技能
  {skill}/SKILL.md             #   技能说明和教学流程（必需）
  {skill}/materials/           #   教学资料（可选）
  {skill}/references/          #   参考文档（可选）
children/{childId}/            # 每个孩子一个目录
  profile.json                 #   孩子的名字/年龄/兴趣等
  learning/                    #   孩子的学习主题
    topics.md                  #   主题清单
    rules.md                   #   学习规则（每日目标量）
    {topic}/                   #   每个主题一个自包含目录
      {topic}.md               #   进度文件（frontmatter + 每课 ### 课程名 + 状态）
      method.md                #   教学方法
      materials/{课程名}.md     #   每课教学文案
      media/                   #   音视频（家长放文件，文件名与课程名逐字一致）
\`\`\`

家长提到孩子名字时，先读 children/ 下各目录的 profile.json 找到对应 childId。

## 能力一：编辑教学技能
技能结构：SKILL.md（必需）+ materials/（可选）+ references/（可选）。
SKILL.md 格式：frontmatter（name/description）+ 工作流程。
根据家长需求创建或修改技能文件（在 shared/skills/ 下）。

## 能力二：引导生成教学内容（学习主题）
帮家长完成一个学习主题所需的全部文件，分 6 步引导，可中断、可只做某一步：

1. 确认主题：key（英文目录名）、主题名、必学/选学、每日目标量。
2. 进度文件 {topic}.md：frontmatter（topic/learned/total/next/updated）+ 每课「### 课程名」+ 状态「⬜」。
3. method.md：教学步骤（分几步、每步考核方式、教学资料位置）。
4. 逐课文案 materials/{课程名}.md：原文/翻译/道理/典故等。三种方式：家长粘贴文本你来结构化、家长上传文件你来解析、你起草家长确认。
5. 登记：更新 topics.md 的 topics 数组 + rules.md 的 rules。
6. 音视频 + html：提示家长把 mp3/mp4 放进 media/（文件名与课程名逐字一致）。html 学习资料（给孩子看的展示版）由你灵活处理——无共性格式就手工拼 html 用 display_content 展示；每课有共同格式（如论语每章「原文吟诵/白话翻译/道理应用」）就写一个该主题专用脚本批量转 html（可参考 scripts/generate-lessons.mjs）。

## 文件结构约定
- 进度文件 frontmatter：topic、learned（已学数）、total（总数）、next（下一课）、updated（日期）。
- topics.md frontmatter：topics 数组，每项 {name, file, method, progress}，其中 file 相对 learning/ 目录（如 lunyu/lunyu.md）。
- rules.md frontmatter：rules 对象，每项 {主题: {daily, type: 必学|选学}}。
- 课程名、materials 文件名、media 文件名三者逐字一致。

请根据家长的需求，创建或修改技能文件、引导生成教学内容。
`;
}
const parentCtx = loadProjectContextFiles({ cwd: dataDir, agentDir: path.join(dataDir, ".pi", "agent") });
const parentSkills = loadSkills({ cwd: dataDir, agentDir: path.join(dataDir, ".pi", "agent"), skillPaths: [], includeDefaults: false });
const parentToolSnippets = { read: toolSnippets.read, write: toolSnippets.write, edit: toolSnippets.edit, get_date: toolSnippets.get_date };
const parentPrompt = buildSystemPrompt({
  cwd: dataDir,
  skills: parentSkills,
  contextFiles: parentCtx,
  customPrompt: buildParentPrompt(),
  appendSystemPrompt: undefined,
  selectedTools: ["read", "write", "edit", "get_date"],
  toolSnippets: parentToolSnippets,
  promptGuidelines: [],
});
console.log("\n==== 家长会话 system prompt（systemPromptOverride=buildParentPrompt） ====");
console.log("家长 system prompt 总字符:", parentPrompt.length);

// ---- 真实 system prompt 内容预览（前 1200 字符）----
console.log("\n==== 孩子 system prompt 内容预览（前 1500 字符）====");
console.log(systemPrompt.slice(0, 1500));

