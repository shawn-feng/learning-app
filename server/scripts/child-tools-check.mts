/**
 * 孩子 agent（main 会话）全部 16 个工具的真实测试。
 * 真实 dataDir + 珊珊数据；写类工具用带标记的测试数据并在结束后清理；
 * LLM 类（summarize/create_html_lesson）真实调用（tokenplan 套餐 cost=0）；
 * page_* 无客户端在线 → 验证「可理解的超时报错」（预期行为）。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createCorePaths } from "@pi/agent-core";
import { createWorkerKbTools } from "../src/worker/kb-tools.js";
import { readParentSettings } from "../src/worker/scheduler.js";
import { openKb } from "../src/db/kb.js";
import { createServerFsTools } from "../src/agent/fs-tools.js";
import { createSummarizeConversationTool } from "../src/agent/kb-summary-tool.js";
import { createTodayPlanTool, createParentContentTool } from "../src/agent/plan-tools.js";
import { createDisplayContentTool } from "../src/agent/display-tool.js";
import { createPageTools } from "../src/agent/page-tools.js";
import { createProgrammingTool } from "../src/agent/programming-agent.js";

const dataDir = "./data";
const PID = "86a84278-c8ae-415e-8fbc-6140b1b7c88e";
const CID = "1f050a7f-df8a-45b0-925a-1ffe2aa35674";
const TODAY = (() => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

const db = new DatabaseSync(path.join(dataDir, "server.sqlite"));
const paths = createCorePaths(dataDir);
const workspace = paths.childWorkspaceDir(PID, CID);
const streamKey = `${PID}:${CID}`;

const kbTools = createWorkerKbTools({ dataDir, mainDb: db, parentId: PID, childId: CID } as any);
const fsTools = createServerFsTools(workspace);
const pageTools = createPageTools({ db, dataDir, parentId: PID, childId: CID, streamKey });
const tools: any[] = [
  ...kbTools,
  ...fsTools,
  createDisplayContentTool({ dataDir, parentId: PID, childId: CID, streamKey }),
  createProgrammingTool({ dataDir, db, parentId: PID }, { scope: "child", childId: CID }),
  createTodayPlanTool({ dataDir, parentId: PID, childId: CID }),
  createParentContentTool({ dataDir, parentId: PID, childId: CID }),
  createSummarizeConversationTool({ db, dataDir, parentId: PID, childId: CID }),
  pageTools.pageActionTool,
  pageTools.pageInspectTool,
  pageTools.sceneCommandTool,
];

const byName = new Map<string, any>(tools.map((t) => [t.name, t]));
console.log(`工具表共 ${byName.size} 个：${[...byName.keys()].join(", ")}\n`);

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
async function run(name: string, params: any, expect: (text: string, err?: Error) => boolean, label: string) {
  const tool = byName.get(name);
  if (!tool) {
    results.push({ name, pass: false, detail: "工具不存在于工具表" });
    return;
  }
  try {
    const r = await tool.execute("toolcheck", params);
    const text = r?.content?.map((c: any) => c.text).join("") ?? "";
    const pass = expect(text, undefined);
    results.push({ name, pass, detail: text.replace(/\n/g, " ").slice(0, 90) });
  } catch (err) {
    const e = err as Error;
    const pass = expect("", e);
    results.push({ name, pass, detail: `（异常）${e.message.slice(0, 90)}` });
  }
  const last = results[results.length - 1];
  console.log(`${last.pass ? "✓" : "✗"} ${name.padEnd(22)} ${last.detail}`);
}

console.log("== A. 只读 / 纯计算 ==");
await run("get_date", {}, (t) => t.includes("现在是"), "返回当前日期时间");
await run("kb_query", { query: "topics" }, (t) => t.includes("主题清单"), "主题清单");
await run("kb_query", { query: "progress", topic: "lunyu" }, (t) => t.includes("论语") || t.includes("进度"), "论语进度");
await run("kb_query", { query: "tags" }, (t) => t.length > 0, "标签定义");
await run("kb_query", { query: "daily", date: TODAY }, (t) => t.length > 0, "今天 daily");
await run("get_today_plan", {}, (t) => t.includes("计划"), "今日计划");
await run("parent_content", { type: "method", topic: "lunyu" }, (t) => t.includes("教学") || t.length > 50, "论语教学方法");

// htmlPath 拿真实资料路径 → display_content 用它
let htmlRel = "lunyu/论语子路篇第四章.html";
{
  const pc = byName.get("parent_content");
  try {
    const r = await pc.execute("toolcheck", { type: "htmlPath", topic: "lunyu", course: "论语子路篇第四章" });
    const t = r?.content?.[0]?.text ?? "";
    if (/^[\w-]+\/.+\.(html|htm)$/.test(t.trim())) htmlRel = t.trim();
  } catch { /* 用缺省路径 */ }
}
await run("display_content", { path: htmlRel, title: "工具测试" }, (t) => t.includes("已展示资料"), `展示 ${htmlRel}`);
await run("ls", {}, (t) => t.includes("内容："), "列工作区");

console.log("\n== A2. 沙箱拒绝（应报错） ==");
await run("read", { path: "../../server.sqlite" }, (_t, e) => !!e, "拒绝越界读");
await run("write", { path: "../escape.txt", content: "x" }, (_t, e) => !!e, "拒绝越界写");

console.log("\n== B. 写类（测试数据，结束清理） ==");
const tcFile = "outputs/_toolcheck.md";
await run("write", { path: tcFile, content: "第一行 HELLO\n第二行" }, (t) => t.includes("已写入"), "写入测试文件");
await run("read", { path: tcFile }, (t) => t.includes("HELLO"), "回读测试文件");
await run("edit", { path: tcFile, oldString: "HELLO", newString: "WORLD" }, (t) => t.includes("已更新"), "编辑测试文件");
{
  // 回读验证编辑生效
  const abs = path.join(workspace, "outputs/_toolcheck.md");
  const okEdit = fs.existsSync(abs) && fs.readFileSync(abs, "utf-8").includes("WORLD");
  results.push({ name: "edit(回读验证)", pass: okEdit, detail: okEdit ? "WORLD 已写入" : "编辑未生效" });
  console.log(`${okEdit ? "✓" : "✗"} edit(回读验证)`.padEnd(24));
}

const TCTITLE = "[TOOLCHECK] 工具测试条目";
await run("kb_insert", { table: "daily", date: TODAY, block: "问答", content: `### ${TCTITLE}\n- 内容：工具联调测试` }, (t) => t.length > 0 && !/错误|失败/.test(t), "插入 daily 测试条目");
await run("kb_query", { query: "daily", date: TODAY, title: TCTITLE }, (t) => t.includes("TOOLCHECK"), "查询验证插入");
await run("kb_update", { table: "daily", date: TODAY, block: "问答", title: TCTITLE, field: "状态", value: "已验证" }, (t) => t.includes("已更新"), "更新 daily 字段");
{
  // 清理：fs 测试文件 + kb 测试条目
  try { fs.unlinkSync(path.join(workspace, "outputs/_toolcheck.md")); } catch { /* 忽略 */ }
  try {
    const kb = openKb(dataDir, PID, CID);
    try { kb.prepare("DELETE FROM daily_entries WHERE title = ? AND date = ?").run(TCTITLE, TODAY); } finally { kb.close(); }
    console.log(`✓ 清理完成（测试文件 + 测试条目）`);
  } catch (e) {
    console.log(`⚠ 清理异常：${(e as Error).message}`);
  }
}

console.log("\n== C. LLM 类（真实调用，套餐零费用；较慢） ==");
await run("create_html_lesson", { title: "工具联调测试页", requirement: "一个极简 HTML 页面：标题写「工具联调OK」，正文一句话。不要任何复杂样式。", path: "outputs/_toolcheck-page.html" }, (t) => t.includes("已生成") || t.includes("已写入"), "编程 agent 生成页面");
{
  // 清理测试页面
  try { fs.unlinkSync(path.join(workspace, "outputs/_toolcheck-page.html")); } catch { /* 忽略 */ }
}
await run("summarize_conversation", { date: TODAY }, (t) => t.includes("已总结") || t.includes("已处理") || t.includes("跳过"), "汇总今天对话（完整链路）");

console.log("\n== D. page_*（无客户端面板在线 → 预期可理解的超时报错） ==");
await run("page_inspect", {}, (t) => t.includes("无响应") || t.includes("超时") || t.includes("未响应"), "快照（预期超时）");
await run("page_action", { action: "read" }, (t) => t.includes("无响应") || t.includes("超时") || t.includes("未响应"), "操作（预期超时）");
await run("scene_command", { command: "say", character: "steve", text: "test" }, (t) => t.includes("失败") || t.includes("无响应") || t.includes("超时"), "场景指令（预期超时）");

db.close();

const pass = results.filter((r) => r.pass).length;
console.log(`\n===== 结果：${pass}/${results.length} 通过 =====`);
for (const r of results.filter((x) => !x.pass)) {
  console.log(`  ✗ ${r.name}: ${r.detail}`);
}
process.exit(pass === results.length ? 0 : 1);
