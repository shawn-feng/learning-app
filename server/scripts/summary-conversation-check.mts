/**
 * summarize_conversation「无会话，跳过」修复的冒烟验证。
 * 覆盖 readServerDailyConversation 的两个来源合并：
 *   1. 旧客户端镜像 sessions/<pid>/<cid>/；
 *   2. 服务端 agent 会话 agent-sessions/<pid>/<cid>-<slot>/（P4 后孩子对话真实落盘处）。
 * 用临时目录构造 mock jsonl，不依赖真实数据。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readServerDailyConversation } from "../src/db/sessions.js";

const PID = "p1";
const CID = "c1";
// 本地时区明确的一天（无 Z 后缀，Date.parse 按本地解析，与 readServerDailyConversation 的 new Date(y,m-1,d) 同基准）
const DAY = "2026-09-13";
const NEXT = "2026-09-14";

function msgLine(tsLocal: string, role: string, text: string): string {
  return JSON.stringify({
    type: "message",
    timestamp: tsLocal,
    message: { role, content: [{ type: "text", text }] },
  });
}

function writeJsonl(file: string, lines: string[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-summary-"));

console.log("A. 仅旧镜像 sessions/（向后兼容）");
{
  const dir = path.join(tmp, "sessions", PID, CID);
  writeJsonl(path.join(dir, "a.jsonl"), [
    msgLine(`${DAY}T09:00:00`, "user", "旧镜像孩子消息"),
    msgLine(`${DAY}T09:00:05`, "assistant", "旧镜像助手回复"),
  ]);
  const s = readServerDailyConversation(tmp, PID, CID, DAY);
  check("读到旧镜像当天对话", s.includes("旧镜像孩子消息") && s.includes("旧镜像助手回复"));
}

console.log("B. 仅 agent-sessions/<cid>-main/（修复核心）");
{
  const dir = path.join(tmp, "agent-sessions", PID, `${CID}-main`);
  writeJsonl(path.join(dir, "b.jsonl"), [
    msgLine(`${DAY}T10:00:00`, "user", "服务端agent孩子消息"),
    msgLine(`${DAY}T10:00:05`, "assistant", "服务端agent助手回复"),
  ]);
  const s = readServerDailyConversation(tmp, PID, CID, DAY);
  check("读到 agent-sessions 当天对话（此前为空 → 误报无会话）", s.includes("服务端agent孩子消息"));
}

console.log("C. 两者都有 → 合并（按时间排序）");
{
  const s = readServerDailyConversation(tmp, PID, CID, DAY);
  const idxA = s.indexOf("旧镜像孩子消息");
  const idxB = s.indexOf("服务端agent孩子消息");
  check("合并两个来源的对话", idxA >= 0 && idxB >= 0);
  check("按时间升序（旧镜像 09:00 在 agent 10:00 前）", idxA < idxB);
}

console.log("D. 日期过滤：跨天不串");
{
  const s = readServerDailyConversation(tmp, PID, CID, NEXT);
  check("次日无会话返回空串", s === "");
}

console.log("E. 非 message 行与 toolResult 被过滤");
{
  const dir = path.join(tmp, "agent-sessions", PID, `${CID}-main`);
  fs.appendFileSync(
    path.join(dir, "b.jsonl"),
    [
      JSON.stringify({ type: "session", timestamp: `${DAY}T10:00:00`, id: "x" }),
      msgLine(`${DAY}T10:01:00`, "toolResult", "工具结果应被忽略"),
      msgLine(`${DAY}T10:02:00`, "user", "追加的有效孩子消息"),
    ].join("\n") + "\n",
    "utf-8"
  );
  const s = readServerDailyConversation(tmp, PID, CID, DAY);
  check("追加的有效消息被读到", s.includes("追加的有效孩子消息"));
  check("toolResult 文本未混入", !s.includes("工具结果应被忽略"));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
