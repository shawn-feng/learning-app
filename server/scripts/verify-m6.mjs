// M8-B 服务端新增 op 验证（kb.daily_entries.query/insertMany/updateField、kb.courses.insert/updateField）
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";

const BASE = "http://127.0.0.1:8788/api/v1";
const cfg = JSON.parse(fs.readFileSync(path.resolve("data/server-config.json"), "utf-8"));
const SECRET = cfg.jwtSecret;
const token = jwt.sign({ parent_id: "test-parent", email: "t@t", plan: "pro" }, SECRET, { expiresIn: "1h" });
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

async function call(method, p, body, headers = H) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json };
}

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + JSON.stringify(detail) : ""}`);
  if (!cond) failed++;
}

const child = await call("POST", "/children", { name: "测试娃" });
const cid = child.json.child.id;
check("创建孩子", child.status === 200 && !!cid);

// 1. insertMany 批量（含标签提取）
{
  const r = await call("POST", "/db/exec", {
    op: "kb.daily_entries.insertMany",
    args: {
      child_id: cid,
      date: "2026-08-27",
      entries: [
        { block: "学习", content: "### 论语先进篇\n- 状态：✅\n- 掌握度：良好" },
        { block: "生活", content: "### 帮妈妈洗碗\n- 标签：勤劳,亲情" },
        { block: "生活", content: "### 帮妈妈洗碗\n- 标签：勤劳" }, // 重复 → skipped
      ],
    },
  });
  check("insertMany 新增2跳过1", r.status === 200 && r.json.result.inserted === 2 && r.json.result.skipped === 1, r.json.result);
}

// 2. query：date 精确 + block 过滤
{
  const r = await call("POST", "/db/query", { op: "kb.daily_entries.query", args: { child_id: cid, date: "2026-08-27" } });
  check("query date 返回2条", r.status === 200 && r.json.result.length === 2, r.json.result?.length);
  const r2 = await call("POST", "/db/query", { op: "kb.daily_entries.query", args: { child_id: cid, month: "2026-08", block: "生活" } });
  check("query month+block 返回1条", r2.status === 200 && r2.json.result.length === 1, r2.json.result?.map(e => e.title));
  const r3 = await call("POST", "/db/query", { op: "kb.daily_entries.query", args: { child_id: cid, tag: "勤劳" } });
  check("query tag 过滤返回1条", r3.status === 200 && r3.json.result.length === 1, r3.json.result?.map(e => e.tags));
}

// 3. updateField：改字段行 + 标签同步
{
  const r = await call("POST", "/db/exec", {
    op: "kb.daily_entries.updateField",
    args: { child_id: cid, date: "2026-08-27", block: "学习", title: "论语先进篇", field: "掌握度", value: "优秀" },
  });
  check("updateField 掌握度", r.status === 200 && r.json.result.ok === true, r.json);
  const r2 = await call("POST", "/db/exec", {
    op: "kb.daily_entries.updateField",
    args: { child_id: cid, date: "2026-08-27", block: "生活", title: "帮妈妈洗碗", field: "标签", value: "勤劳,爱心" },
  });
  check("updateField 标签", r2.status === 200 && r2.json.result.ok === true, r2.json);
  const r3 = await call("POST", "/db/query", { op: "kb.daily_entries.query", args: { child_id: cid, title: "帮妈妈洗碗" } });
  check("标签同步到 tags 列", r3.json.result?.[0]?.tags === "勤劳,爱心", r3.json.result?.[0]?.tags);
  const r4 = await call("POST", "/db/query", { op: "kb.daily_entries.query", args: { child_id: cid, title: "论语先进篇" } });
  check("raw 字段行已更新", r4.json.result?.[0]?.raw?.includes("掌握度：优秀"), r4.json.result?.[0]?.raw);
}

// 4. courses.insert：新课程 + 重复返回 ok:false
{
  const r = await call("POST", "/db/exec", { op: "kb.courses.insert", args: { child_id: cid, topic: "lunyu", title: "先进篇第二十一章", status: "⬜" } });
  check("courses.insert 新增", r.status === 200 && r.json.result.ok === true, r.json.result);
  const r2 = await call("POST", "/db/exec", { op: "kb.courses.insert", args: { child_id: cid, topic: "lunyu", title: "先进篇第二十一章" } });
  check("courses.insert 重复 ok:false", r2.status === 200 && r2.json.result.ok === false, r2.json.result);
}

// 5. courses.updateField：状态 + 复习次数 +1
{
  const r = await call("POST", "/db/exec", { op: "kb.courses.updateField", args: { child_id: cid, topic: "lunyu", title: "先进篇第二十一章", field: "状态", value: "✅" } });
  check("updateField 状态✅", r.status === 200 && r.json.result.ok === true, r.json);
  const r2 = await call("POST", "/db/exec", { op: "kb.courses.updateField", args: { child_id: cid, topic: "lunyu", title: "先进篇第二十一章", field: "复习次数", value: "+1" } });
  check("复习次数 +1", r2.status === 200 && r2.json.result.ok === true, r2.json);
  const r3 = await call("POST", "/db/query", { op: "kb.progress.list", args: { child_id: cid } });
  const row = r3.json.result?.find(p => p.topic === "lunyu");
  check("进度视图 learned=1", r3.status === 200 && row?.learned === 1, row);
  const r4 = await call("POST", "/db/exec", { op: "kb.courses.updateField", args: { child_id: cid, topic: "lunyu", title: "先进篇第二十一章", field: "不存在的字段", value: "x" } });
  check("非法字段 400", r4.status === 400, r4.json);
}

// 6. 鉴权与越权
{
  const r = await call("POST", "/db/query", { op: "kb.daily_entries.query", args: { child_id: cid, date: "2026-08-27" } }, { "Content-Type": "application/json" });
  check("无 token 401", r.status === 401, r.json);
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
