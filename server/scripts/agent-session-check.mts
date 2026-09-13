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
import { createDisplayContentTool } from "../src/agent/display-tool.js";
import { createPageTools } from "../src/agent/page-tools.js";
import { hubFor, hubForChild } from "../src/agent/page-hub.js";
import { computeChildToolNames, sessionSlot } from "../src/agent/session-registry.js";
import { parseCaps, registerCaps, getCaps } from "../src/agent/caps.js";
import { buildServerChildPrompt, buildServerScenePrompt } from "../src/agent/prompt.js";
import { learningGuardExtension } from "@pi/agent-core";
import { createProgrammingTool } from "../src/agent/programming-agent.js";

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

    // 真 prompt（异步化语义）：POST 提交即返回 200，整轮结束/错误经 SSE 推送
    // （长工具轮实测 3 分钟+，同步等待会被客户端超时误判为断连）。
    const p = await app.inject({ method: "POST", url: "/api/v1/agent/c1/prompt", headers: auth, payload: { text: "你好" } });
    check("prompt 提交即返回（异步化）", p.statusCode === 200, `status=${p.statusCode} body=${p.body.slice(0, 120)}`);
    // 轮询事件流：无 key 环境数秒内会流出 error+turn_end；有 key 环境至少 user_message 已入流
    let streamed: string[] = [];
    for (let i = 0; i < 48; i++) {
      streamed = agentStreamHub.replayAfter(AgentStreamHub.key("p1", "c1"), 0).map((e) => e.type);
      if (streamed.includes("turn_end")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check("user_message 已入流", streamed.includes("user_message"), `events=${streamed.join(",")}`);
    check("error/turn_end 至少其一入流（无 key 环境干净报错；有 key 环境稍后到）",
      streamed.includes("error") || streamed.includes("turn_end"), `events=${streamed.join(",")}`);
    await app.close();
    db.close();
  }

  console.log("E. 版本协商");
  check("features 含 server_agent", (SERVER_FEATURES as readonly string[]).includes("server_agent"));

  console.log("F. P3：display_content 推送 / page_* 传输 / caps 装配 / guard / AGENTS");
  {
    // F 段自带内存库（D 段的 db 在其块作用域内）
    const fdb = new DatabaseSync(":memory:");
    fdb.exec(
      "CREATE TABLE materials (parent_id TEXT, id TEXT, path TEXT, type TEXT, size INTEGER, updated_at TEXT, PRIMARY KEY (parent_id,id));" +
        "CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT);"
    );
    fdb.prepare("INSERT INTO children (id,parent_id,name) VALUES (?,?,?)").run("c1", "p1", "珊珊");
    const db = fdb;
    const ctx = { db, dataDir: tmp, parentId: "p1", childId: "c1" };
    const streamKey = AgentStreamHub.key("p1", "c1");

    // F1. display_content：校验 + 推送事件（服务端不渲染，只登记并把展示动作推给客户端）
    const ws = createCorePaths(tmp).childWorkspaceDir("p1", "c1");
    fs.mkdirSync(path.join(ws, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "outputs", "demo.html"), "<html>demo</html>", "utf-8");
    const matDir = path.join(tmp, "materials", "p1", "lunyu");
    fs.mkdirSync(matDir, { recursive: true });
    fs.writeFileSync(path.join(matDir, "lesson.html"), "<html>lesson</html>", "utf-8");

    const seen: string[] = [];
    const off = agentStreamHub.subscribe(streamKey, (e) => seen.push(e.type));
    const display = createDisplayContentTool({ dataDir: tmp, parentId: "p1", childId: "c1", streamKey });
    const r1 = await display.execute("t", { path: "lunyu/lesson.html" }, undefined as any, undefined as any, { cwd: ws });
    check("display_content 展示资料库文件成功", String(r1.content[0].text).includes("已展示"));
    check("display_content 推了 display_content 事件", seen.includes("display_content"));
    const r2 = await display.execute("t", { path: "materials/lunyu/lesson.html" }, undefined as any, undefined as any, { cwd: ws });
    check("display_content 兼容旧 materials/ 前缀", String(r2.content[0].text).includes("已展示"));
    const rr = await display.execute("t", { path: "outputs/demo.html" }, undefined as any, undefined as any, { cwd: ws });
    check("display_content 支持孩子工作区 outputs/", String(rr.content[0].text).includes("已展示"));
    let notFound = false;
    try {
      await display.execute("t", { path: "lunyu/nope.html" }, undefined as any, undefined as any, { cwd: ws });
    } catch (err) {
      notFound = /资料不存在/.test(String((err as Error).message));
    }
    check("display_content 对不存在的资料给出可执行报错", notFound);
    let badExt = false;
    try {
      await display.execute("t", { path: "lunyu/x.mp4" }, undefined as any, undefined as any, { cwd: ws });
    } catch (err) {
      badExt = /只支持 \.html/.test(String((err as Error).message));
    }
    check("display_content 拒绝非 html", badExt);
    off();

    // F2. page_* 下行 → 回执上行（P3 的传输改造闭环）
    const tools = createPageTools({ db, dataDir: tmp, parentId: "p1", childId: "c1", streamKey });
    const cmds: Array<{ action: string; requestId: string }> = [];
    const off2 = agentStreamHub.subscribe(streamKey, (e) => {
      if (e.type === "page_cmd") {
        const d = e.data as { action: string; requestId: string };
        cmds.push(d);
        // 模拟客户端执行端点：拿到指令后立刻回执
        setTimeout(() => {
          hubForChild("c1")!.resolveAction(d.requestId, {
            ok: true,
            data: d.action === "read" ? { items: [{ i: 0, tag: "p", text: "页面里的文字" }] } : { done: 1 },
          });
        }, 0);
      }
    });
    const act = await tools.pageActionTool.execute("t", { action: "click", text: "下一步" } as any);
    check("page_action 经 SSE 下发并拿到回执", String(act.content[0].text).includes("页面操作完成"), cmds[0]?.action);
    const insp = await tools.pageInspectTool.execute("t", {});
    check("page_inspect 返回页面快照（来自设备回执）", String(insp.content[0].text).includes("页面里的文字"));
    off2();

    // F3. 场景指令走同一通道（scene.<command>）
    const sceneCmds: string[] = [];
    const off3 = agentStreamHub.subscribe(streamKey, (e) => {
      if (e.type === "page_cmd") {
        const d = e.data as { action: string; requestId: string };
        sceneCmds.push(d.action);
        setTimeout(() => hubForChild("c1")!.resolveAction(d.requestId, { ok: true }), 0);
      }
    });
    await tools.sceneCommandTool.execute("t", { command: "say", character: "steve", text: "Hello" } as any);
    check("scene_command 映射为 scene.say 下发", sceneCmds.includes("scene.say"));
    off3();

    // F4. 互动事件累积 → 下一轮消息附带（ISSUE-015 语义）
    const hub = hubFor(streamKey, "c1");
    hub.queueEvent("c1", { kind: "app", title: "论语", detail: { action: "submit-answer", payload: { q1: "B" } } });
    const pending = hub.takePending("c1");
    check("页面事件累积并可被下一轮取走", pending.includes("submit-answer") && hub.takePending("c1") === "");

    // F5. caps 装配：无面板不注册 page_*
    const noCaps = computeChildToolNames({ materialPanel: false });
    const withCaps = computeChildToolNames({ materialPanel: true });
    check("caps 缺失时不注册 page_*", !noCaps.includes("page_action") && !noCaps.includes("scene_command"));
    check("caps 含 material-panel 时注册 page_*", withCaps.includes("page_action") && withCaps.includes("page_inspect") && withCaps.includes("scene_command"));
    check("caps 解析：逗号串→布尔", (() => {
      const c = parseCaps("material-panel,mic,electron");
      return c.materialPanel && c.mic && c.electron;
    })());
    registerCaps("tmp:key", parseCaps("mic"));
    check("caps 登记/读取隔离", getCaps("tmp:key").mic === true && getCaps("tmp:key").materialPanel === false);

    // F6. guard 扩展：越界拦截 + 日期注入（与客户端同一份实现）
    const handlers: Record<string, Function> = {};
    (learningGuardExtension as any)({ on: (name: string, fn: Function) => (handlers[name] = fn) });
    const blocked = await handlers["tool_call"]({ toolName: "read", input: { path: "../../etc/passwd" } }, { cwd: ws });
    check("guard 拦截越界文件工具调用", blocked?.block === true);
    const allowed = await handlers["tool_call"]({ toolName: "read", input: { path: "outputs/demo.html" } }, { cwd: ws });
    check("guard 放行界内路径", allowed === undefined);
    const injected = await handlers["before_agent_start"]({ systemPrompt: "BASE" });
    check("guard 每轮注入当天日期（不含时分秒，保前缀缓存）", /当前日期/.test(injected.systemPrompt) && !/\d{2}:\d{2}/.test(injected.systemPrompt));

    // F7. AGENTS 真源注入 system prompt
    const promptWithRules = buildServerChildPrompt({
      paths: createCorePaths(tmp),
      parentId: "p1",
      childId: "c1",
      childName: "珊珊",
      today: "2026-09-12",
      now: "21:00",
      agentRules: "## 家长补充\n- 先复习再上新内容",
    });
    check("AGENTS 用户版本被注入 system prompt", promptWithRules.includes("先复习再上新内容"));
  }

  console.log("G. P3-3：会话类型 + 编程 agent 工具");
  {
    const gdb = new DatabaseSync(":memory:");
    gdb.exec("CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT);");
    gdb.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT);");
    // G1. 会话类型工具表
    const sceneTools = computeChildToolNames({ materialPanel: true }, "scene");
    check("场景会话只驱动演出（无 kb / 无 create_html_lesson）", sceneTools.includes("scene_command") && !sceneTools.includes("kb_insert") && !sceneTools.includes("create_html_lesson") && !sceneTools.includes("summarize_conversation"));
    check("场景会话无面板时不注册 scene_command", !computeChildToolNames({ materialPanel: false }, "scene").includes("scene_command"));
    const courseTools = computeChildToolNames({ materialPanel: false }, "course:论语学而篇第一章");
    check("课程会话保留记录与出题工具", courseTools.includes("kb_insert") && courseTools.includes("create_html_lesson"));
    check("sessionSlot 把冒号转成连字符（路径安全）", !sessionSlot("c1", "course:论语学而篇第一章").includes(":"));

    // G2. 场景 prompt
    const sp = buildServerScenePrompt({ childName: "珊珊", today: "2026-09-12" });
    check("场景 prompt 是「游戏主持人」口径", sp.includes("游戏主持人") && sp.includes("scene_command"));

    // G3. 编程 agent 工具：路径沙箱与扩展名校验先于模型检查
    const progChild = createProgrammingTool({ db: gdb, dataDir: tmp, parentId: "p1" }, { scope: "child", childId: "c1" });
    check("孩子侧编程工具名为 create_html_lesson", progChild.name === "create_html_lesson");
    let badExt = false;
    try {
      await progChild.execute("t", { title: "x", requirement: "y", path: "outputs/x.txt" });
    } catch (err) {
      badExt = /只产出 \.html/.test(String((err as Error).message));
    }
    check("编程工具拒绝非 html 输出", badExt);
    let traversal = false;
    try {
      await progChild.execute("t", { title: "x", requirement: "y", path: "outputs/../../escape.html" });
    } catch (err) {
      traversal = /输出路径超出允许范围/.test(String((err as Error).message));
    }
    check("编程工具拒绝越界输出", traversal);
    let noModel = false;
    try {
      await progChild.execute("t", { title: "x", requirement: "y", path: "outputs/ok.html" });
    } catch (err) {
      noModel = /编程 agent 未配置模型/.test(String((err as Error).message));
    }
    check("编程 agent 未配置模型时明确报错（不静默回退）", noModel);

    const progParent = createProgrammingTool({ db: gdb, dataDir: tmp, parentId: "p1" }, { scope: "parent" });
    check("家长侧编程工具名为 parent_build_material", progParent.name === "parent_build_material");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? "\n全部通过 ✅" : `\n失败 ${failed} 项 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
