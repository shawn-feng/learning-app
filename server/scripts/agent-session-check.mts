/**
 * P1 冒烟：服务端 agent 交互链路（会话注册表 / SSE 事件中枢 / 服务端文件工具 / agent 路由）。
 * 用法：npx tsx scripts/agent-session-check.mts
 *
 * 覆盖：
 *  A. 事件中枢：publish/subscribe/replay(Last-Event-ID)/订阅退订
 *  B. 路径沙箱：workspace 内放行、`..` 与绝对路径拒绝、目录唯一拼装点
 *  C. 服务端文件工具：write/read/ls/edit 正常 + 越界拒绝
 *  D. agent 路由（fastify.inject，临时 sqlite）：401 无 token / 403 非本人孩子 /
 *     events 与 page-result 正常 / prompt 在「未配置模型 key」时干净报错而非崩溃
 *  E. 版本协商：features 含 server_agent
 *
 * 刻意不烧 token：prompt 只验证到「进入模型调用边界」；配置了真实 key 的环境会走通并输出回复。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { AgentStreamHub, agentStreamHub } from "../src/agent/stream-hub.js";
import { createCorePaths, resolveWithin } from "@pi/agent-core";
import { createServerFsTools } from "../src/agent/fs-tools.js";
import { registerAgentRoutes } from "../src/routes/agent.js";
import { SERVER_FEATURES } from "../src/routes/version.js";
import { signSession } from "../src/auth/jwt.js";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  const tag = cond ? "✓" : "✗";
  if (!cond) failed++;
  console.log(`  ${tag} ${name}${detail ? ` — ${detail}` : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-check-"));
const SECRET = "check-secret";

async function main() {
  console.log("A. 事件中枢");
  {
    const hub = new AgentStreamHub();
    const key = AgentStreamHub.key("p1", "c1");
    const got: number[] = [];
    const off = hub.subscribe(key, (e) => got.push(e.id));
    hub.publish(key, "text_delta", { delta: "你" });
    hub.publish(key, "text_delta", { delta: "好" });
    check("订阅者收到全部事件", got.length === 2, `got=${got.join(",")}`);
    check("事件 id 单调递增", hub.lastEventId(key) === 2);
    off();
    hub.publish(key, "text_delta", { delta: "!" });
    check("退订后不再收到", got.length === 2);
    const replay = hub.replayAfter(key, 1);
    check("Last-Event-ID 重放只回放增量", replay.length === 2 && replay[0].id === 2, `replay=${replay.map((e) => e.id).join(",")}`);
    check("隔离：不同 key 互不可见", hub.replayAfter(AgentStreamHub.key("p1", "c2"), 0).length === 0);
  }

  console.log("B. 路径沙箱");
  {
    const paths = createCorePaths(tmp);
    const ws = paths.childWorkspaceDir("p1", "c1");
    check("工作区与非工作区目录分离", ws.includes("workspaces") && paths.agentSessionsDir("p1", "c1").includes("agent-sessions"));
    check("作用域内相对路径放行", resolveWithin(ws, "outputs/a.html").startsWith(ws));
    let rejected = false;
    try {
      resolveWithin(ws, "../../../kb/p2/c2.sqlite");
    } catch {
      rejected = true;
    }
    check(".. 逃逸被拒绝", rejected);
    rejected = false;
    try {
      resolveWithin(ws, path.join(tmp, "kb", "p1", "c1.sqlite"));
    } catch {
      rejected = true;
    }
    check("绝对路径被拒绝", rejected);
    rejected = false;
    try {
      createCorePaths(tmp).childWorkspaceDir("p1", "../evil");
    } catch {
      rejected = true;
    }
    check("childId 含分隔符被拒绝", rejected);
  }

  console.log("C. 服务端文件工具（read/write/edit/ls）");
  {
    const paths = createCorePaths(tmp);
    const ws = paths.childWorkspaceDir("p1", "c1");
    const tools = createServerFsTools(ws);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    await byName.write.execute("t", { path: "outputs/note.md", content: "第一行\n第二行\n" });
    const r = await byName.read.execute("t", { path: "outputs/note.md" });
    check("write → read 往返", String(r.content[0].text).includes("第二行"));
    await byName.edit.execute("t", { path: "outputs/note.md", oldString: "第二行", newString: "改过的行" });
    const r2 = await byName.read.execute("t", { path: "outputs/note.md" });
    check("edit 生效", String(r2.content[0].text).includes("改过的行"));
    const l = await byName.ls.execute("t", {});
    check("ls 列出工作区文件", String(l.content[0].text).includes("outputs/note.md"));
    let denied = false;
    try {
      await byName.write.execute("t", { path: "../../outside.md", content: "x" });
    } catch {
      denied = true;
    }
    check("越界写入被拒绝", denied);
    denied = false;
    try {
      await byName.read.execute("t", { path: "/etc/passwd" });
    } catch {
      denied = true;
    }
    check("越界读取被拒绝", denied);
  }

  console.log("D. agent 路由（inject）");
  {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT);" +
        "CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT);"
    );
    db.prepare("INSERT INTO children (id,parent_id,name) VALUES (?,?,?)").run("c1", "p1", "珊珊");
    db.prepare("INSERT INTO children (id,parent_id,name) VALUES (?,?,?)").run("c2", "p2", "别人家孩子");

    const app = Fastify();
    registerAgentRoutes(app, { config: { dataDir: tmp, jwtSecret: SECRET } as any, db });
    const tokenP1 = signSession({ parent_id: "p1", email: "a@b.c", plan: "free" }, SECRET, 1);
    const auth = { authorization: `Bearer ${tokenP1}` };

    const noToken = await app.inject({ method: "POST", url: "/api/v1/agent/c1/events", payload: { events: [{ kind: "click" }] } });
    check("无 token → 401", noToken.statusCode === 401, `status=${noToken.statusCode}`);

    const foreign = await app.inject({ method: "POST", url: "/api/v1/agent/c2/events", headers: auth, payload: { events: [{ kind: "click" }] } });
    check("非本人孩子 → 403", foreign.statusCode === 403, `status=${foreign.statusCode}`);

    const ev = await app.inject({
      method: "POST",
      url: "/api/v1/agent/c1/events",
      headers: auth,
      payload: { events: [{ kind: "app", title: "论语", detail: { action: "submit-answer", payload: { q: 1 } } }] },
    });
    check("页面事件上行 200", ev.statusCode === 200, `status=${ev.statusCode} body=${ev.body}`);

    const pr = await app.inject({
      method: "POST",
      url: "/api/v1/agent/c1/page-result",
      headers: auth,
      payload: { requestId: "r1", ok: true, data: { items: [] } },
    });
    check("资料页操作回执 200", pr.statusCode === 200, `status=${pr.statusCode}`);

    const empty = await app.inject({ method: "POST", url: "/api/v1/agent/c1/prompt", headers: auth, payload: { text: "  " } });
    check("空消息 → 400", empty.statusCode === 400, `status=${empty.statusCode}`);

    // 真 prompt：无模型 key 时应「干净报错」（仍有完整错误信息），有 key 则走通
    const p = await app.inject({ method: "POST", url: "/api/v1/agent/c1/prompt", headers: auth, payload: { text: "你好" } });
    const streamed = agentStreamHub.replayAfter(AgentStreamHub.key("p1", "c1"), 0).map((e) => e.type);
    if (p.statusCode === 200) {
      check("prompt 走通（已配置模型 key）", true, `events=${streamed.join(",")}`);
    } else {
      check("prompt 无 key 时干净报错（非崩溃）", p.statusCode === 500 && /error/.test(p.body), `status=${p.statusCode} body=${p.body.slice(0, 160)}`);
      check("本轮事件已入流（user_message/turn_end 至少其一）", streamed.length > 0, `events=${streamed.join(",")}`);
    }
    await app.close();
    db.close();
  }

  console.log("E. 版本协商");
  check("features 含 server_agent", (SERVER_FEATURES as readonly string[]).includes("server_agent"));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? "\n全部通过 ✅" : `\n失败 ${failed} 项 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
