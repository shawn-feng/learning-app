/**
 * 工具效果演示（手动脚本）：让数据管理 agent「只列出论语的课程名」，
 * 抓取 tool_start / tool_end（含工具原始返回）与最终回复。
 * 运行：cd server && npx tsx ../test/tool-echo.mts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8788";
const PARENT_ID = "86a84278-c8ae-415e-8fbc-6140b1b7c88e";
const KIND = "parent-data";
const CFG = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "server-config.json"), "utf-8")) as { jwtSecret: string };

const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function signToken(parentId: string): string {
  const h = b64(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const p = b64(Buffer.from(JSON.stringify({ parent_id: parentId, email: "e2e@test", plan: "pro", iat: now, exp: now + 7200 })));
  const sig = crypto.createHmac("sha256", CFG.jwtSecret).update(`${h}.${p}`).digest("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${h}.${p}.${sig}`;
}
const TOKEN = signToken(PARENT_ID);

async function main() {
  const controller = new AbortController();
  const sse = fetch(`${BASE}/api/v1/parent-agent/stream?kind=${KIND}&token=${TOKEN}`, { signal: controller.signal });
  const prompt = api("POST", "/api/v1/parent-agent/prompt", {
    kind: KIND,
    text: "用 parent_db_read 查询 courses 表里 title='论语·学而第一' 的课程（columns 只要 title），把工具的原始返回一字不差地告诉我，不要自己加工。",
  });
  const [sub, r] = await Promise.all([prompt, sse]);
  if (sub.status !== 200) throw new Error(`提交失败 ${sub.status}: ${JSON.stringify(sub.json)}`);

  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finalText = "";
  let done = false;
  let callSeq = 0;
  let lastStart = "";
  const deadline = Date.now() + 240_000;

  while (!done && Date.now() < deadline) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = frame.split("\n");
      const type = (lines.find((l) => l.startsWith("event: ")) ?? "").slice(7).trim();
      let data: any = {};
      try {
        data = JSON.parse((lines.find((l) => l.startsWith("data: ")) ?? "").slice(6) || "{}");
      } catch {
        continue;
      }
      if (type === "tool_start") {
        callSeq += 1;
        lastStart = String(data?.toolName ?? "");
        console.log(`\n—— 工具调用 #${callSeq}: ${lastStart}`);
        console.log(`   入参: ${JSON.stringify(data?.args ?? {}).slice(0, 400)}`);
      } else if (type === "tool_end") {
        const raw = JSON.stringify(data?.result ?? "");
        console.log(`   返回: ${raw.length > 1500 ? `${raw.slice(0, 1500)}…〔共 ${raw.length} 字符，截断展示〕` : raw}`);
      } else if (type === "text_delta") {
        finalText += String(data?.delta ?? "");
      } else if (type === "error") {
        done = true;
        console.log(`[error] ${String(data?.message ?? "")}`);
      } else if (type === "turn_end") {
        done = true;
      }
    }
  }
  controller.abort();
  console.log(`\n—— agent 最终回复 ——\n${finalText.trim()}`);
}

async function api(method: string, url: string, body?: unknown) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signToken(PARENT_ID)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

main().catch((e) => {
  console.error(`[失败] ${(e as Error).message}`);
  process.exit(1);
});
