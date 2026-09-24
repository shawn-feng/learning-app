/**
 * 测量家长/孩子 agent 初始会话 system prompt 的字符数与 token 估算。
 * 用真实数据（闻闻）走真实构建函数，跑法：cd server && npx tsx _prompt_size.mts
 */
import { DatabaseSync } from "node:sqlite";
import { createCorePaths } from "@pi/agent-core";
import { buildServerChildPrompt } from "./src/agent/prompt.js";
import { buildServerParentPrompt } from "./src/agent/parent-registry.js";
import { buildDataChannelBlocks, buildChildSelfBlock } from "./src/agent/registry-prompt.js";
import { getAgentPrompt } from "./src/db/agents.js";

const dataDir = "data";
const paths = createCorePaths(dataDir);

const meta = new DatabaseSync("data/server.sqlite", { readOnly: true });
const kid = meta.prepare("SELECT id, name, parent_id FROM children WHERE name = '闻闻' LIMIT 1").get() as
  | { id: string; name: string; parent_id: string }
  | undefined;
if (!kid) throw new Error("找不到孩子「闻闻」");
const { id: childId, name: childName, parent_id: parentId } = kid;

const pad = (n: number) => String(n).padStart(2, "0");
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

function count(label: string, text: string) {
  const chars = text.length;
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length;
  const ascii = chars - cjk;
  // 低估：国产中文优化 tokenizer（GLM/Qwen/DeepSeek 量级）≈0.6 token/汉字，ASCII ≈4 字符/token
  const low = Math.round(cjk * 0.6 + ascii / 4);
  // 高估：GPT 系旧口径 ≈1 token/汉字，ASCII ≈3.5 字符/token
  const high = Math.round(cjk * 1.0 + ascii / 3.5);
  console.log(
    `${label}\n  字符 ${chars}（汉字/全角 ${cjk}，ASCII ${ascii}）→ token 估 ${low} ~ ${high}（中点 ≈${Math.round((low + high) / 2)}）`
  );
  return { chars, low, high };
}

// —— 家长 agent ——
const blocks = buildDataChannelBlocks(dataDir, parentId);
const parentPrompt = buildServerParentPrompt({
  parentId,
  workspace: paths.childWorkspaceDir(parentId, "parent"),
  today,
  tablesBlock: `${blocks.parentBlock}\n\n${blocks.childBlock}`,
});

// —— 孩子 agent（主会话）——
const agentRules = getAgentPrompt(dataDir, "child", childId) ?? "";
const childPrompt = buildServerChildPrompt({
  paths,
  parentId,
  childId,
  childName,
  today,
  now: time,
  agentRules,
  courseBlock: "",
  dbTablesBlock: buildChildSelfBlock(dataDir, parentId, childId),
});

console.log(`样本：家长 ${parentId}，孩子 ${childName}(${childId})，agentRules=${agentRules ? `${agentRules.length} 字符` : "无"}\n`);
const p = count("【家长 agent·完整】", parentPrompt);
count("  ├ 模板部分（不含库元数据）", buildServerParentPrompt({ parentId, workspace: "W", today, tablesBlock: "" }));
count(`  └ 库元数据块 tablesBlock`, `${blocks.parentBlock}\n\n${blocks.childBlock}`);

console.log();
const c = count("【孩子 agent·主会话完整】", childPrompt);
count("  ├ 模板部分（不含自库块/自定义规范）",
  buildServerChildPrompt({ paths, parentId, childId, childName, today, now: time, agentRules: "", courseBlock: "", dbTablesBlock: "" }));
count(`  ├ 我的数据表块（含错题本）`, buildChildSelfBlock(dataDir, parentId, childId));
if (agentRules) count("  └ 家长自定义规范 agentRules", agentRules);

console.log(
  `\n合计（家长 + 孩子两条初始 system prompt）：字符 ${p.chars + c.chars}，token 估 ${p.low + c.low} ~ ${p.high + c.high}`
);
