/**
 * 端到端冒烟（手动脚本，跑完可删）：驱动真实「数据管理 agent」验证通用工具链路。
 * T1 countOnly 读数 → T2 提交场景草案 → (REST 确认) → T3 写入 + 查询。
 * 运行：cd server && npx tsx ../test/e2e-data-agent.mts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8788";
const PARENT_ID = "86a84278-c8ae-415e-8fbc-6140b1b7c88e"; // 本地数据最全的测试家长
const KIND = "parent-data";
const CFG = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "server-config.json"), "utf-8")) as { jwtSecret: string };

function signToken(parentId: string): string {
  const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const h = b64(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const p = b64(Buffer.from(JSON.stringify({ parent_id: parentId, email: "e2e@test", plan: "pro", iat: now, exp: now + 7200 })));
  const sig = crypto.createHmac("sha256", CFG.jwtSecret).update(`${h}.${p}`).digest("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${h}.${p}.${sig}`;
}
const TOKEN = signToken(PARENT_ID);
const authHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

async function api(method: string, url: string, body?: unknown) {
  const r = await fetch(`${BASE}${url}`, { method, headers: authHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) as any };
  } catch {
    return { status: r.status, json: { raw: text.slice(0, 300) } as any };
  }
}

let out = "";
function log(s: string) {
  out += s + "\n";
  console.log(s);
}

/** 提交一轮并经 SSE 等到 turn_end；返回 [最终文本, 用过的工具名] */
async function turn(text: string): Promise<{ text: string; tools: string[] }> {
  const controller = new AbortController();
  const sse = fetch(`${BASE}/api/v1/parent-agent/stream?kind=${KIND}&token=${TOKEN}`, { signal: controller.signal });
  const readerPromise = sse.then((r) => r.body!.getReader());
  const submitted = api("POST", "/api/v1/parent-agent/prompt", { kind: KIND, text });
  const [sub] = await Promise.all([submitted]);
  if (sub.status !== 200) {
    controller.abort();
    throw new Error(`提交失败 ${sub.status}: ${JSON.stringify(sub.json)}`);
  }

  const reader = await readerPromise;
  const decoder = new TextDecoder();
  let buf = "";
  let finalText = "";
  const tools: string[] = [];
  const deadline = Date.now() + 240_000;
  let done = false;
  while (!done && Date.now() < deadline) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evLine = frame.split("\n").find((l) => l.startsWith("event: "));
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!evLine) continue;
      const type = evLine.slice(7).trim();
      let data: any = {};
      try {
        data = JSON.parse((dataLine ?? "").slice(6) || "{}");
      } catch {
        /* 忽略 */
      }
      if (type === "text_delta") finalText += String(data?.delta ?? "");
      else if (type === "tool_start") tools.push(String(data?.toolName ?? ""));
      else if (type === "error") {
        done = true;
        finalText += `\n[error] ${String(data?.message ?? "")}`;
      } else if (type === "turn_end") done = true;
    }
  }
  controller.abort();
  if (!done) throw new Error("等待回复超时（240s）");
  return { text: finalText.trim(), tools };
}

async function main() {
  log(`== E2E 数据管理 agent 冒烟（parent=${PARENT_ID.slice(0, 8)}…）==`);
  // 清掉可能卡住的上一轮
  await api("POST", "/api/v1/parent-agent/abort", { kind: KIND });
  await new Promise((r) => setTimeout(r, 2000));

  // T1：countOnly 读数
  const t1 = await turn("用 parent_db_read 的 countOnly 查一下家长库 question_bank 里有多少道题，只告诉我数字。");
  log(`\n[T1 countOnly 读题库] 工具：${t1.tools.join(", ") || "无"}\n回复：${t1.text}`);

  // T2：提交场景草案
  const t2 = await turn(
    "新建一个自定义数据场景：ns=reading_list，中文名「读书记录」，scope=parent；" +
      "字段：date(日期,文本,必填,可筛选)、title(书名,文本,必填)、pages(页数,数字)。设计好后提交草案，并告诉我下一步该做什么。"
  );
  log(`\n[T2 提交场景草案] 工具：${t2.tools.join(", ") || "无"}\n回复：${t2.text}`);

  // REST：家长确认（真实路由 + 真实 JWT）
  const list = await api("GET", "/api/v1/namespaces");
  const pending = (list.json.namespaces ?? []).find((n: any) => n.ns === "reading_list");
  log(`\n[REST 清单] reading_list 状态 = ${pending?.status ?? "未找到"}（字段 ${pending?.fields?.length ?? 0} 个）`);
  if (pending?.status !== "pending") throw new Error("草案未落库为 pending");
  const confirm = await api("POST", "/api/v1/namespaces/decide", { ns: "reading_list", action: "confirm" });
  log(`[REST 确认] ${confirm.status} ${JSON.stringify(confirm.json)}`);

  // T3：写入 + 查询
  const t3 = await turn("帮我记一条读书记录：2026-09-19 读了《论语》，30 页。记完后告诉我现在一共有几条记录。");
  log(`\n[T3 写入 + 查询] 工具：${t3.tools.join(", ") || "无"}\n回复：${t3.text}`);

  const final = await api("GET", "/api/v1/namespaces");
  const ns = (final.json.namespaces ?? []).find((n: any) => n.ns === "reading_list");
  log(`\n[最终状态] ns:reading_list status=${ns?.status} v${ns?.version}`);
  fs.writeFileSync(path.join(process.cwd(), "..", "e2e-data-agent-out.txt"), out, "utf-8");
}

main().catch((e) => {
  log(`\n[失败] ${(e as Error).message}`);
  fs.writeFileSync(path.join(process.cwd(), "..", "e2e-data-agent-out.txt"), out, "utf-8");
  process.exit(1);
});
