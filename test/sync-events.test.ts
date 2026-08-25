import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// ISSUE-041 层 C：事件信箱端到端（mock cloudFetch，验证 写事件→轮询→处理触发同步→ack）
vi.mock("../electron/lib/cloud-net", () => ({
  cloudFetch: vi.fn(),
}));

import { cloudFetch } from "../electron/lib/cloud-net";
import {
  writeEvent,
  pollEvents,
  handleChildEvents,
  requestAndQueryProgress,
} from "../electron/lib/sync-events.ts";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-events-test-"));
const DATA_DIR = path.join(TEST_DIR, "data");
const CHILD_ID = "child-events-1";

// mock 云端：内存事件表 + 文件表
const events: Array<{ id: string; type: string; payload: any; status: string }> = [];
const files = new Map<string, Buffer>(); // `${childId}:${path}`
const parentFiles = new Map<string, Buffer>();

function jsonRes(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const cloudFetchMock = cloudFetch as unknown as ReturnType<typeof vi.fn>;

beforeAll(() => {
  process.env.PI_TEST_DATA_DIR = DATA_DIR;
  // 假 license（getCachedLicense 读取）
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, "license.json"),
    JSON.stringify({
      parent_id: "p1",
      email: "t@t.com",
      plan: "basic",
      max_children: 2,
      expires_at: "2099-01-01T00:00:00.000Z",
      is_expired: false,
      token: "test-token",
    })
  );
  // 孩子目录 + 数据（syncChild 会把它推上云端）
  const childDir = path.join(DATA_DIR, "children", CHILD_ID);
  fs.mkdirSync(path.join(childDir, "learning", "lunyu"), { recursive: true });
  fs.writeFileSync(path.join(childDir, "profile.json"), JSON.stringify({ childId: CHILD_ID, name: "测试娃" }));
  fs.writeFileSync(path.join(childDir, "learning", "lunyu", "method.md"), "# 方法");
  fs.writeFileSync(path.join(childDir, "kb.sqlite"), Buffer.from([1, 2, 3, 4, 5]));
  // 家长库（syncParentLibrary 会推上云端）
  fs.mkdirSync(path.join(DATA_DIR, "parents", "default", "materials"), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "parents", "default", "parent.sqlite"), Buffer.from([9, 9]));
  fs.writeFileSync(path.join(DATA_DIR, "parents", "default", "materials", "a.html"), "<html>a</html>");
  fs.writeFileSync(path.join(DATA_DIR, "agents.sqlite"), Buffer.from([1]));
  fs.writeFileSync(path.join(DATA_DIR, "scheduler-config.json"), "{}");

  cloudFetchMock.mockImplementation(async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = (init?.method as string) || "GET";
    const p = url.pathname;
    const auth = (init?.headers as any)?.Authorization || "";
    if (!auth.startsWith("Bearer test-token")) return jsonRes(401, { detail: "unauthorized" });

    // 事件写
    let m = p.match(/^\/api\/sync\/events\/([^/]+)$/);
    if (m && method === "POST") {
      const body = JSON.parse(String(init?.body));
      events.push({ id: `ev-${events.length + 1}`, type: body.type, payload: body.payload, status: "pending" });
      return jsonRes(200, { ok: true });
    }
    // 事件轮询
    if (m && method === "GET") {
      const evs = events
        .filter((e) => e.status === "pending")
        .map((e) => ({ id: e.id, type: e.type, payload: e.payload, created_at: "2026-08-25T00:00:00Z" }));
      return jsonRes(200, { events: evs });
    }
    // 事件 ack
    m = p.match(/^\/api\/sync\/events\/([^/]+)\/ack$/);
    if (m && method === "POST") {
      const ids = JSON.parse(String(init?.body));
      for (const e of events) if (ids.includes(e.id)) e.status = "done";
      return jsonRes(200, { acked: ids.length });
    }
    // 云端查进度
    m = p.match(/^\/api\/sync\/progress\/([^/]+)$/);
    if (m && method === "GET") {
      return jsonRes(200, { topics: [{ name: "论语", file: "lunyu", courses: 3, done: 1 }], daily: [] });
    }
    // 孩子文件 status/upload/download
    m = p.match(/^\/api\/sync\/status\/([^/]+)$/);
    if (m && method === "GET") {
      const cid = m[1];
      const list = [...files.entries()]
        .filter(([k]) => k.startsWith(`${cid}:`))
        .map(([k, buf]) => ({ path: k.slice(cid.length + 1), hash: "", size: buf.length, updated_at: "2026-08-25T00:00:00Z" }));
      return jsonRes(200, { files: list });
    }
    m = p.match(/^\/api\/sync\/upload\/([^/]+)$/);
    if (m && method === "POST") {
      const fd = init?.body as FormData;
      const fp = String(fd.get("file_path"));
      const file = fd.get("file") as File;
      files.set(`${m[1]}:${fp}`, Buffer.from(await file.arrayBuffer()));
      return jsonRes(200, { uploaded: true });
    }
    m = p.match(/^\/api\/sync\/download\/([^/]+)$/);
    if (m && method === "POST") {
      const fd = init?.body as FormData;
      const fp = String(fd.get("file_path"));
      const buf = files.get(`${m[1]}:${fp}`);
      if (!buf) return jsonRes(404, { detail: "not found" });
      return jsonRes(200, { content_base64: buf.toString("base64"), size: buf.length });
    }
    // 家长空间 status/upload/download
    if (p === "/api/sync/parent/status" && method === "GET") {
      const list = [...parentFiles.entries()].map(([fp, buf]) => ({
        path: fp,
        hash: "",
        size: buf.length,
        updated_at: "2026-08-25T00:00:00Z",
      }));
      return jsonRes(200, { files: list });
    }
    if (p === "/api/sync/parent/upload" && method === "POST") {
      const fd = init?.body as FormData;
      const fp = String(fd.get("file_path"));
      const file = fd.get("file") as File;
      parentFiles.set(fp, Buffer.from(await file.arrayBuffer()));
      return jsonRes(200, { uploaded: true });
    }
    if (p === "/api/sync/parent/download" && method === "POST") {
      const fd = init?.body as FormData;
      const fp = String(fd.get("file_path"));
      const buf = parentFiles.get(fp);
      if (!buf) return jsonRes(404, { detail: "not found" });
      return jsonRes(200, { content_base64: buf.toString("base64"), size: buf.length });
    }
    return jsonRes(404, { detail: `no route ${method} ${p}` });
  });
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.PI_TEST_DATA_DIR;
});

describe("ISSUE-041 层 C 事件信箱", () => {
  it("writeEvent → pollEvents 可取回 pending 事件", async () => {
    await writeEvent(CHILD_ID, "send_materials", { at: "t1" });
    const evs = await pollEvents(CHILD_ID);
    expect(evs.length).toBe(1);
    expect(evs[0].type).toBe("send_materials");
  });

  it("handleChildEvents：处理事件触发同步（孩子+家长库上传）并 ack", async () => {
    events.length = 0;
    await writeEvent(CHILD_ID, "assign_topic", { topicDir: "lunyu" });
    const r = await handleChildEvents(CHILD_ID);
    expect(r.handled).toBe(1);
    // 同步发生：孩子文件 + 家长文件都已上传到云端
    expect(files.has(`${CHILD_ID}:profile.json`)).toBe(true);
    expect(files.has(`${CHILD_ID}:learning/lunyu/method.md`)).toBe(true);
    expect(files.has(`${CHILD_ID}:kb.sqlite`)).toBe(true);
    expect(parentFiles.has("parents/default/parent.sqlite")).toBe(true);
    expect(parentFiles.has("parents/default/materials/a.html")).toBe(true);
    expect(parentFiles.has("agents.sqlite")).toBe(true);
    // 已 ack：再轮询为空
    const evs = await pollEvents(CHILD_ID);
    expect(evs.length).toBe(0);
  });

  it("requestAndQueryProgress：写请求事件并返回云端进度", async () => {
    const data = await requestAndQueryProgress(CHILD_ID);
    expect(data.topics).toBeDefined();
    expect(data.topics[0].name).toBe("论语");
    // 事件已写入（pending）
    const evs = await pollEvents(CHILD_ID);
    expect(evs.some((e) => e.type === "request_progress")).toBe(true);
  });
});
