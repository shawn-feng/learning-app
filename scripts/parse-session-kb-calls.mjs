// 解析孩子会话 jsonl，提取 kb_insert/kb_update/kb_query 调用与结果
import fs from "fs";

const f = process.argv[2];
const lines = fs.readFileSync(f, "utf-8").split("\n");
const calls = [];

for (const line of lines) {
  if (!line.trim()) continue;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const msg = obj?.message;
  if (!msg) continue;
  const toolName = msg.toolName;
  if (!toolName || !["kb_insert", "kb_update", "kb_query", "get_progress", "get_date"].includes(toolName)) continue;

  const entry = { ts: obj.timestamp, role: msg.role, tool: toolName };
  if (msg.role === "toolCall" || msg.role === "assistant") {
    entry.params = msg.input ?? msg.arguments ?? msg.content;
    if (typeof entry.params === "string") {
      try {
        entry.params = JSON.parse(entry.params);
      } catch {
        /* keep string */
      }
    }
    // toolCall 有时用结构化 content
    if (Array.isArray(entry.params)) {
      const call = entry.params.find((c) => c?.type === "toolCall");
      if (call) entry.params = call.arguments ?? call.input;
    }
  }
  if (msg.role === "toolResult") {
    const content = msg.content;
    if (Array.isArray(content)) {
      entry.result = content
        .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
        .join(" ")
        .slice(0, 300);
    } else {
      entry.result = String(content ?? "").slice(0, 300);
    }
  }
  calls.push(entry);
}

// 按时间排序输出
calls.sort((a, b) => (a.ts < b.ts ? -1 : 1));
for (const c of calls) {
  console.log(`\n=== [${c.ts}] ${c.role} ${c.tool}`);
  if (c.params) console.log("  参数:", JSON.stringify(c.params, null, 1).slice(0, 900));
  if (c.result) console.log("  结果:", c.result);
}
