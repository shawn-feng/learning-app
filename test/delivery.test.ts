import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// ISSUE-041 架构转向：云端只做消息交换（分配包 + 进度摘要），端到端 mock cloudFetch 验证。
vi.mock("../electron/lib/cloud-net", () => ({ cloudFetch: vi.fn() }));

import { cloudFetch } from "../electron/lib/cloud-net";
import { openParentDb, DEFAULT_PARENT_ID, getParentDir, upsertParentTopic, allocateTopicToChild } from "../electron/lib/parent-library";
import { openKbDb } from "../electron/lib/kb-sqlite";
import {
  buildAllocPackage,
  uploadDelivery,
  pollDeliveries,
  applyAllocPackage,
  handleCloudInbox,
  fetchProgressSummary,
} from "../electron/lib/delivery.ts";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delivery-test-"));
const DATA_DIR = path.join(TEST_DIR, "data");
const CHILD_ID = "child-delivery-1";

// mock 云端：分配包表 + 进度摘要表
const deliveries: Array<{ id: string; childId: string; payload: any }> = [];
let progressRow: { summary: string; updated_at: string; requested_at: string | null } | null = null;

function jsonRes(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const cloudFetchMock = cloudFetch as unknown as ReturnType<typeof vi.fn>;

beforeAll(() => {
  process.env.PI_TEST_DATA_DIR = DATA_DIR;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 假 license（apiCall 需要）
  fs.writeFileSync(
    path.join(DATA_DIR, "license.json"),
    JSON.stringify({
      parent_id: "p1",
      token: "test-token",
      expires_at: "2099-01-01T00:00:00.000Z",
      is_expired: false,
    })
  );
  // 家长库：一个主题（含 method）+ 两门课
  upsertParentTopic(
    DEFAULT_PARENT_ID,
    { name: "论语", topicKey: "lunyu", method: "# 三步吟诵法\n逐句跟读，反复三遍。", rules: { daily: "每天一课" } },
    [
      {
        title: "学而篇第一章",
        sortOrder: 1,
        material: "学而时习之，不亦说乎",
        tags: "基础",
        lessonMethod: "先读后讲",
        htmlPath: "materials/lunyu/学而篇第一章.html",
      },
      {
        title: "学而篇第二章",
        sortOrder: 2,
        material: "有朋自远方来，不亦乐乎",
        tags: "基础",
        lessonMethod: "先读后讲",
        htmlPath: "materials/lunyu/学而篇第二章.html",
      },
    ]
  );

  // 孩子库：已存在「第一章」且有进度（✅），模拟孩子学过的进度
  const childDir = path.join(DATA_DIR, "children", CHILD_ID);
  fs.mkdirSync(childDir, { recursive: true });
  const kb = openKbDb(childDir);
  kb.prepare(
    "INSERT INTO topics (name, topic_key, method, progress, rules_json) VALUES ('论语', 'lunyu', '', '第一章', '{}') " +
      "ON CONFLICT(name) DO NOTHING"
  ).run();
  kb.prepare(
    "INSERT INTO courses (topic, title, sort_order, status, mastery, material, send_material, tags, lesson_method, html_path) " +
      "VALUES ('lunyu', '学而篇第一章', 1, '✅', '熟练', '', 0, '', '', '') " +
      "ON CONFLICT(topic, title) DO NOTHING"
  ).run();
  kb.close();

  cloudFetchMock.mockImplementation(async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = (init?.method as string) || "GET";
    const p = url.pathname;
    const auth = (init?.headers as any)?.Authorization || "";
    if (!auth.startsWith("Bearer test-token")) return jsonRes(401, { detail: "unauthorized" });

    // 分配包：上传 / 拉取 / ack
    let m = p.match(/^\/api\/sync\/deliver\/([^/]+)$/);
    if (m && method === "POST") {
      const body = JSON.parse(String(init?.body));
      deliveries.push({ id: `dl-${deliveries.length + 1}`, childId: m[1], payload: body.payload });
      return jsonRes(200, { ok: true });
    }
    if (m && method === "GET") {
      const list = deliveries
        .filter((d) => d.childId === m[1])
        .map((d) => ({ id: d.id, payload: d.payload, created_at: "2026-08-25T00:00:00Z" }));
      return jsonRes(200, { deliveries: list });
    }
    m = p.match(/^\/api\/sync\/deliver\/([^/]+)\/ack$/);
    if (m && method === "POST") {
      const ids = JSON.parse(String(init?.body)).ids as string[];
      for (let i = deliveries.length - 1; i >= 0; i--) {
        if (deliveries[i].childId === m[1] && ids.includes(deliveries[i].id)) deliveries.splice(i, 1);
      }
      return jsonRes(200, { acked: ids.length });
    }
    // 进度摘要：PUT 上传 / GET 读取（request=1 打标记）
    m = p.match(/^\/api\/sync\/progress\/([^/]+)$/);
    if (m && method === "PUT") {
      const body = JSON.parse(String(init?.body));
      progressRow = { summary: JSON.stringify(body.summary), updated_at: "2026-08-25T10:00:00Z", requested_at: null };
      return jsonRes(200, { ok: true });
    }
    if (m && method === "GET") {
      const wantRequest = url.searchParams.get("request") === "1";
      if (wantRequest) {
        const now = "2026-08-25T11:00:00Z";
        progressRow = progressRow
          ? { ...progressRow, requested_at: now }
          : { summary: "{}", updated_at: "", requested_at: now };
      }
      if (!progressRow) return jsonRes(200, { summary: null, updated_at: null, requested_at: null, note: "无摘要" });
      return jsonRes(200, {
        summary: JSON.parse(progressRow.summary || "{}"),
        updated_at: progressRow.updated_at,
        requested_at: progressRow.requested_at,
        note: null,
      });
    }
    return jsonRes(404, { detail: `no route ${method} ${p}` });
  });
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.PI_TEST_DATA_DIR;
});

describe("分配包（跨机课程分发，只传数据）", () => {
  it("buildAllocPackage：从家长库生成包（含 method/courses，不含文件）", () => {
    const pkg = buildAllocPackage("lunyu");
    expect(pkg.topicName).toBe("论语");
    expect(pkg.method).toContain("三步吟诵法");
    expect(pkg.courses.length).toBe(2);
    expect(pkg.courses[0].htmlPath).toContain("materials/lunyu");
    // 不含任何文件内容字段
    expect((pkg as any).files).toBeUndefined();
  });

  it("uploadDelivery → pollDeliveries 往返", async () => {
    const pkg = buildAllocPackage("lunyu");
    await uploadDelivery(CHILD_ID, pkg);
    const list = await pollDeliveries(CHILD_ID);
    expect(list.length).toBe(1);
    expect(list[0].payload.topicDir).toBe("lunyu");
  });

  it("applyAllocPackage：写入本地家长库 + 孩子库合并，已有课程进度保留", () => {
    const childDir = path.join(DATA_DIR, "children", CHILD_ID);
    const kb = openKbDb(childDir);
    const before = kb.prepare("SELECT status, mastery FROM courses WHERE topic='lunyu' AND title='学而篇第一章'").get() as any;
    kb.close();
    expect(before.status).toBe("✅");
    expect(before.mastery).toBe("熟练");

    const pkg = buildAllocPackage("lunyu");
    applyAllocPackage(CHILD_ID, pkg);

    // ① 家长库 topics.method 已写入（parent_content 可读）
    const parentDb = openParentDb(DEFAULT_PARENT_ID);
    const topic = parentDb.prepare("SELECT method FROM topics WHERE topic_key LIKE '%lunyu%'").get() as any;
    parentDb.close();
    expect(topic.method).toContain("三步吟诵法");
    // ② 孩子库：第一章进度保留（✅/熟练），material 被补齐，第二章新增
    const kb2 = openKbDb(childDir);
    const row1 = kb2.prepare("SELECT status, mastery, material FROM courses WHERE topic='lunyu' AND title='学而篇第一章'").get() as any;
    const row2 = kb2.prepare("SELECT status FROM courses WHERE topic='lunyu' AND title='学而篇第二章'").get() as any;
    kb2.close();
    expect(row1.status).toBe("✅");
    expect(row1.mastery).toBe("熟练");
    expect(row1.material).toContain("学而时习之");
    expect(row2.status).toBe("⬜");
  });

  it("handleCloudInbox：拉取→应用→ack（云端包被删）", async () => {
    // 上一用例已上传过 1 个包（仍在 pending），先清掉
    deliveries.length = 0;
    const pkg = buildAllocPackage("lunyu");
    await uploadDelivery(CHILD_ID, pkg);
    expect((await pollDeliveries(CHILD_ID)).length).toBe(1);

    const r = await handleCloudInbox(CHILD_ID);
    expect(r.applied).toBe(1);
    // ack 后云端无 pending
    expect((await pollDeliveries(CHILD_ID)).length).toBe(0);
  });
});

describe("进度摘要（仅被请求时上传）", () => {
  it("家长 request=1 打标记 → 孩子端 pushProgressIfRequested 生成并上传摘要 → 家长可读", async () => {
    progressRow = null;
    // 家长查进度（打请求标记）
    const req = await fetchProgressSummary(CHILD_ID, true);
    expect(req.requested_at).toBeTruthy();
    expect(req.summary?.topics).toBeUndefined(); // 尚无摘要

    // 孩子端轮询：响应请求 → 摘要上传
    const r = await handleCloudInbox(CHILD_ID);
    expect(r.pushed).toBe(true);

    // 家长再次读取：摘要已就绪（含主题完成数）
    const data = await fetchProgressSummary(CHILD_ID, false);
    expect(data.summary.topics.length).toBe(1);
    const t = data.summary.topics[0];
    expect(t.name).toBe("论语");
    expect(t.courses).toBe(2);
    expect(t.done).toBe(1); // 第一章 ✅
    expect(Array.isArray(data.summary.daily)).toBe(true);

    // 幂等：requested_at 未变时不再上传
    const r2 = await handleCloudInbox(CHILD_ID);
    expect(r2.pushed).toBe(false);
  });
});
