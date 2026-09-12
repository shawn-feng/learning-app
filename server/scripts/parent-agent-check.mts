/**
 * P2 冒烟：家长 agent 服务端形态（资料治理工具 + 路由 + 隔离）。
 * 用法：npx tsx scripts/parent-agent-check.mts
 *
 * 重点覆盖 ISSUE-079 场景：家长让 agent「整理课程资料」时所需的 list/read/move/delete 四个动作，
 * 以及删除的 dryRun→确认两步语义、跨家长隔离、路径穿越拒绝。
 * 刻意不烧 token：模型调用只验证到「进入模型边界」（无 key 时干净报错）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { registerParentAgentRoutes } from "../src/routes/parent-agent.js";
import { registerAgentRoutes } from "../src/routes/agent.js";
import {
  listMaterials,
  readMaterial,
  moveMaterial,
  deleteMaterial,
  putMaterial,
  normalizeMaterialPath,
  materialAbsPath,
  appendParentActivityLog,
} from "../src/agent/parent-materials.js";
import { openParentLib } from "../src/db/parent-lib.js";
import { createParentAgentTools } from "../src/agent/parent-tools.js";
import { signSession } from "../src/auth/jwt.js";
import { SERVER_FEATURES } from "../src/routes/version.js";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-agent-check-"));
const SECRET = "check-secret";
const P1 = "parent-a";
const P2 = "parent-b";

function writeMaterialFile(parentId: string, rel: string, content: string) {
  const abs = path.join(tmp, "materials", parentId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

async function main() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE materials (parent_id TEXT, id TEXT, path TEXT, type TEXT, size INTEGER, updated_at TEXT, PRIMARY KEY (parent_id, id));`);
  db.exec(`CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT);`);
  db.prepare("INSERT INTO children (id,parent_id,name) VALUES (?,?,?)").run("c-a", P1, "珊珊");

  console.log("A. 材料域操作（ISSUE-079 四动作）");
  {
    // 造素材：lunyu 下散落 html + 一份 media 图片 + 另一个家长的同名文件（隔离用）
    writeMaterialFile(P1, "lunyu/lesson-01.html", "<html>第一课</html>");
    writeMaterialFile(P1, "lunyu/old/lesson-01-copy.html", "<html>第一课</html>");
    writeMaterialFile(P1, "lunyu/media/page1.png", "not-a-real-png");
    writeMaterialFile(P2, "lunyu/lesson-01.html", "<html>别家孩子</html>");

    const ctx = { db, dataDir: tmp, parentId: P1 };
    const list = listMaterials(ctx, { topic: "lunyu" });
    check("list 只看本家长材料（不含他人）", list.length === 3, `count=${list.length}`);
    check("list 可按前缀过滤", listMaterials(ctx, { relPrefix: "lunyu/old" }).length === 1);

    const r = readMaterial(ctx, "lunyu/lesson-01.html");
    check("read 文本类返回正文", r.text?.includes("第一课") === true);
    const rImg = readMaterial(ctx, "lunyu/media/page1.png");
    check("read 二进制只回元数据（不灌上下文）", rImg.text === undefined && rImg.size > 0);

    // move：把副本归并到 materials/ 子目录并改名
    const mv = moveMaterial(ctx, "lunyu/old/lesson-01-copy.html", "lunyu/materials/lesson-01.html");
    check("move 归并+改名成功", mv.to === "lunyu/materials/lesson-01.html");
    check("move 后旧路径消失", !fs.existsSync(path.join(tmp, "materials", P1, "lunyu/old/lesson-01-copy.html")));
    check("move 后索引含新路径", listMaterials(ctx, {}).some((m) => m.path === "lunyu/materials/lesson-01.html"));

    // delete：dryRun 不应删（工具层语义由 parent-tools 负责，这里验证域函数确实只删指定的）
    check("delete 前确认文件存在", fs.existsSync(path.join(tmp, "materials", P1, "lunyu/materials/lesson-01.html")));
    const del = deleteMaterial(ctx, "lunyu/materials/lesson-01.html");
    check("delete 真删文件+索引", del.deleted === "lunyu/materials/lesson-01.html" && !fs.existsSync(path.join(tmp, "materials", P1, "lunyu/materials/lesson-01.html")));
    let gone = false;
    try {
      readMaterial(ctx, "lunyu/materials/lesson-01.html");
    } catch {
      gone = true;
    }
    check("delete 后 read 报不存在", gone);

    // put：发布新资料
    const meta = putMaterial(ctx, "lunyu/materials/new.html", "<html>新</html>");
    check("put 写入真源并可被 list 看到", meta.size > 0 && listMaterials(ctx, {}).some((m) => m.path === "lunyu/materials/new.html"));

    // 隔离与穿越
    let cross = false;
    try {
      readMaterial({ ...ctx, parentId: P2 }, "../../materials/" + P1 + "/lunyu/lesson-01.html");
    } catch {
      cross = true;
    }
    check("跨家长/穿越路径被拒绝", cross);
    let bad = false;
    try {
      normalizeMaterialPath("lunyu/../../escape.html");
    } catch {
      bad = true;
    }
    check("路径含 .. 段被拒绝", bad);
    let badTopic = false;
    try {
      materialAbsPath(ctx, "bad topic!/x.html");
    } catch {
      badTopic = true;
    }
    check("topic 非法字符被拒绝", badTopic);

    const logFile = appendParentActivityLog(ctx, "测试记录");
    check("activity-log 落盘", fs.readFileSync(logFile, "utf-8").includes("测试记录"));
  }

  console.log("A2. 工具层：删除必须先演练后确认（ISSUE-079 约定）");
  {
    const ctx = { db, dataDir: tmp, parentId: P1 };
    putMaterial(ctx, "lunyu/materials/todelete.html", "<html>x</html>");
    const tools = createParentAgentTools({
      db,
      dataDir: tmp,
      parentId: P1,
      workspaceDir: path.join(tmp, "workspaces", P1, "parent"),
      agentDir: path.join(tmp, "workspaces", P1, "parent", ".pi"),
      auth: {},
    });
    const del = tools.find((t) => t.name === "parent_delete_material")!;
    const dry = await del.execute("t", { path: "lunyu/materials/todelete.html" });
    const dryText = String(dry.content[0].text);
    check("confirm 缺省 = 演练（回报将删除清单）", dryText.includes("演练") && dryText.includes("todelete.html"));
    check("演练阶段文件仍在", fs.existsSync(path.join(tmp, "materials", P1, "lunyu/materials/todelete.html")));
    const real = await del.execute("t", { path: "lunyu/materials/todelete.html", confirm: true });
    check("confirm=true 才真正删除", String(real.content[0].text).includes("已删除") && !fs.existsSync(path.join(tmp, "materials", P1, "lunyu/materials/todelete.html")));
    const listTool = tools.find((t) => t.name === "parent_list_materials")!;
    const listed = await listTool.execute("t", { topic: "lunyu" });
    check("list 工具（tool 层）可用", String(listed.content[0].text).includes("lunyu/lesson-01.html"));
    const imgTool = tools.find((t) => t.name === "parent_read_image")!;
    let rejected = false;
    try {
      await imgTool.execute("t", { path: "lunyu/lesson-01.html" });
    } catch (err) {
      rejected = /不是图片/.test(String((err as Error).message));
    }
    check("read_image 拒绝非图片路径", rejected);
  }

  console.log("B. 家长库只读查询");
  {
    const lib = openParentLib(tmp, P1);
    lib.prepare("INSERT INTO topics (name,topic_key,method) VALUES (?,?,?)").run("论语", "lunyu", "吟诵+讲解");
    lib.prepare("INSERT INTO courses (topic,title,sort_order) VALUES (?,?,?)").run("lunyu", "论语学而篇第一章", 1);
    const topics = lib.prepare("SELECT name, topic_key FROM topics").all() as Array<{ name: string; topic_key: string }>;
    check("家长库 topics 可读", topics.length === 1 && topics[0].topic_key === "lunyu");
    const courses = lib.prepare("SELECT title FROM courses WHERE topic=?").all("lunyu") as Array<{ title: string }>;
    check("家长库 courses 可读", courses.length === 1);
    lib.close();
  }

  console.log("C. 家长 agent 路由");
  {
    const app = Fastify();
    registerParentAgentRoutes(app, { config: { dataDir: tmp, jwtSecret: SECRET } as any, db });
    registerAgentRoutes(app, { config: { dataDir: tmp, jwtSecret: SECRET } as any, db });
    const token = signSession({ parent_id: P1, email: "a@b.c", plan: "free" }, SECRET, 1);
    const auth = { authorization: `Bearer ${token}` };

    const noToken = await app.inject({ method: "POST", url: "/api/v1/parent-agent/prompt", payload: { text: "hi" } });
    check("无 token → 401", noToken.statusCode === 401, `status=${noToken.statusCode}`);

    const empty = await app.inject({ method: "POST", url: "/api/v1/parent-agent/prompt", headers: auth, payload: { text: " " } });
    check("空消息 → 400", empty.statusCode === 400, `status=${empty.statusCode}`);

    const badKind = await app.inject({ method: "POST", url: "/api/v1/parent-agent/prompt", headers: auth, payload: { text: "hi", kind: "child" } });
    check("非法 kind → 400", badKind.statusCode === 400, `status=${badKind.statusCode}`);

    // 真 prompt：无 key 时干净报错（不烧 token）
    const p = await app.inject({ method: "POST", url: "/api/v1/parent-agent/prompt", headers: auth, payload: { text: "帮我整理论语资料" } });
    if (p.statusCode === 200) {
      check("prompt 走通（已配置模型 key）", true);
    } else {
      check("prompt 无 key 时干净报错（非崩溃）", p.statusCode === 500 && /error/.test(p.body), `status=${p.statusCode}`);
    }
    await app.close();
  }

  console.log("D. 版本协商");
  check("features 含 parent_agent", (SERVER_FEATURES as readonly string[]).includes("parent_agent"));

  fs.rmSync(tmp, { recursive: true, force: true });
  db.close();
  console.log(failed === 0 ? "\n全部通过 ✅" : `\n失败 ${failed} 项 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
