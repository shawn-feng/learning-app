/**
 * 测量家长/孩子 agent 发给模型的工具 schema（name+description+parameters）体积。
 * 按两条 registry 的实际组装方式构建，序列化成 OpenAI 风格 tools 载荷后统计。
 * 跑法：cd server && npx tsx _tools_size.mts
 */
import { DatabaseSync } from "node:sqlite";
import { createCorePaths } from "@pi/agent-core";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createServerFsTools } from "./src/agent/fs-tools.js";
import { createParentAgentTools } from "./src/agent/parent-tools.js";
import { createPlanDomainTools } from "./src/agent/parent-plans.js";
import { createParentReportTool } from "./src/agent/parent-report-tool.js";
import { createWorkerKbTools } from "./src/worker/kb-tools.js";
import { createChildDbTools } from "./src/agent/child-db-tools.js";
import { createDisplayContentTool } from "./src/agent/display-tool.js";
import { createProgrammingTool } from "./src/agent/programming-agent.js";
import { createPageTools, PAGE_TOOL_NAMES } from "./src/agent/page-tools.js";
import { createSummarizeConversationTool } from "./src/agent/kb-summary-tool.js";
import {
  createParentContentTool,
  createChildStudyPlanCreateTool,
  createChildStudyPlanListTool,
  createChildStudyPlanUpdateTool,
  createChildExamPlanCreateTool,
  createChildExamPlanListTool,
  createChildExamPlanUpdateTool,
  createChildLifePlanCreateTool,
  createChildLifePlanListTool,
  createChildLifePlanUpdateTool,
} from "./src/agent/plan-tools.js";

const dataDir = "data";
const paths = createCorePaths(dataDir);
const meta = new DatabaseSync("data/server.sqlite", { readOnly: true });
const kid = meta.prepare("SELECT id, name, parent_id FROM children WHERE name = '闻闻' LIMIT 1").get() as
  | { id: string; name: string; parent_id: string }
  | undefined;
if (!kid) throw new Error("找不到孩子「闻闻」");
const { id: childId, parent_id: parentId } = kid;
const db = new DatabaseSync("data/server.sqlite", { readOnly: true });
const workspace = paths.childWorkspaceDir(parentId, childId);
const parentWorkspace = paths.childWorkspaceDir(parentId, "parent");
const streamKey = `${parentId}:${childId}:main`;

function createGetDateTool() {
  return defineTool({
    name: "get_date",
    label: "获取当前日期时间",
    description: "返回服务端当前日期与时间（YYYY-MM-DD HH:mm）。用于判断'今天''现在'这类时间指代。",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: {} }),
  });
}

/** 与 registry 同构组装，返回按名字去重后的工具定义表 */
function collect(tools: any[]): Map<string, any> {
  const byName = new Map<string, any>();
  for (const t of tools) if (t?.name && !byName.has(t.name)) byName.set(t.name, t);
  return byName;
}

function estimate(text: string) {
  const chars = text.length;
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length;
  const ascii = chars - cjk;
  return { chars, low: Math.round(cjk * 0.6 + ascii / 4), high: Math.round(cjk * 1.0 + ascii / 3.5) };
}

function report(label: string, byName: Map<string, any>) {
  let payload = "";
  const rows: { name: string; chars: number; low: number; high: number }[] = [];
  for (const [name, t] of byName) {
    const wire = JSON.stringify({
      type: "function",
      function: { name, description: t.description ?? "", parameters: t.parameters ?? {} },
    });
    payload += wire + "\n";
    const e = estimate(wire);
    rows.push({ name, ...e });
  }
  const total = estimate(payload);
  rows.sort((a, b) => b.chars - a.chars);
  console.log(`\n【${label}】工具数 ${byName.size}，tools 载荷合计：字符 ${total.chars}，token 估 ${total.low} ~ ${total.high}（中点 ≈${Math.round((total.low + total.high) / 2)}）`);
  console.log("  最大的 8 个：");
  for (const r of rows.slice(0, 8)) console.log(`    ${r.name.padEnd(36)} ${String(r.chars).padStart(6)} 字符  ~${r.low}-${r.high} tok`);
  return total;
}

// —— 家长 agent 工具（parent-registry.ts 同构）——
const parentTools = collect([
  ...createServerFsTools(parentWorkspace),
  ...createParentAgentTools({
    db, dataDir, parentId,
    workspaceDir: parentWorkspace,
    agentDir: `${parentWorkspace}/.pi`,
    auth: {} as any,
    appSettings: {} as any,
  }),
  ...createPlanDomainTools({ db, dataDir, parentId }),
  createParentReportTool({ db, parentId, streamKey: `${parentId}:parent` }),
  createGetDateTool(),
]);
const pt = report("家长 agent", parentTools);

// —— 孩子 agent 工具（session-registry.ts 同构，默认能力=无资料面板）——
const childTools = collect([
  ...createWorkerKbTools({ dataDir, mainDb: db, parentId, childId } as any),
  ...createServerFsTools(workspace),
  createDisplayContentTool({ dataDir, parentId, childId, streamKey, sessionKey: "main" }),
  createProgrammingTool({ dataDir, db, parentId }, { scope: "child", childId }),
  createParentContentTool({ dataDir, parentId, childId }),
  createChildStudyPlanCreateTool({ dataDir, parentId, childId }),
  createChildStudyPlanListTool({ dataDir, parentId, childId }),
  createChildStudyPlanUpdateTool({ dataDir, parentId, childId }),
  createChildExamPlanCreateTool({ dataDir, parentId, childId }),
  createChildExamPlanListTool({ dataDir, parentId, childId }),
  createChildExamPlanUpdateTool({ dataDir, parentId, childId }),
  createChildLifePlanCreateTool({ dataDir, parentId, childId }),
  createChildLifePlanListTool({ dataDir, parentId, childId }),
  createChildLifePlanUpdateTool({ dataDir, parentId, childId }),
  ...createChildDbTools({ dataDir, parentId, childId }),
  createGetDateTool(),
  createSummarizeConversationTool({ db, dataDir, parentId, childId }),
]);
const ct = report("孩子 agent（无资料面板）", childTools);

// 资料面板在时追加 page 工具
const pageTools = createPageTools({ db, dataDir, parentId, childId, streamKey });
const childToolsP = collect([...childTools.values(), pageTools.pageActionTool, pageTools.pageInspectTool, pageTools.sceneCommandTool]);
const ctp = report("孩子 agent（有资料面板）", childToolsP);

console.log(`\n【对比基线】上一轮实测 system prompt：家长 8804 字符 / 孩子(主会话) 4383 字符`);
console.log(`家长：工具载荷 ${pt.chars} 字符 ≈ system prompt 的 ${(pt.chars / 8804).toFixed(1)} 倍`);
console.log(`孩子：工具载荷 ${ct.chars} 字符 ≈ system prompt 的 ${(ct.chars / 4383).toFixed(1)} 倍；面板开启再 +${ctp.chars - ct.chars} 字符`);
