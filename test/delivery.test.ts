import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

// ISSUE-041 架构转向：云端只做消息交换（分配包 + 进度摘要），端到端 mock cloudFetch 验证。
vi.mock("../electron/lib/cloud-net", () => ({ cloudFetch: vi.fn() }));
// config 数据根指向临时目录（真实 token 经 license.json 落临时目录，服务端 RPC 复用）
vi.mock("../electron/lib/config", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../electron/lib/config")>();
  return {
    ...mod,
    getDataDir: () => DATA_DIR,
    getLicensePath: () => path.join(DATA_DIR, "license.json"),
    getChildrenDir: () => path.join(DATA_DIR, "children"),
    getChildDir: (id: string) => path.join(DATA_DIR, "children", id),
    getSharedDir: () => path.join(DATA_DIR, "shared"),
    getSkillsDir: () => path.join(DATA_DIR, "shared", "skills"),
  };
});

import { cloudFetch } from "../electron/lib/cloud-net";
import { DEFAULT_PARENT_ID, upsertParentTopic, allocateTopicToChild } from "../electron/lib/parent-library";
import { writeTestLicense, registerTestChild } from "./helpers/server-token";
import { dbExec, dbQuery } from "../electron/lib/client-data";
import {
  buildAllocPackage,
  uploadDelivery,
  pollDeliveries,
  applyAllocPackage,
  handleCloudInbox,
  fetchProgressSummary,
  buildProgressSummary,
} from "../electron/lib/delivery.ts";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-delivery-test-"));
const DATA_DIR = path.join(TEST_DIR, "data");
// children.id 全局主键：随机 UUID（每文件一次，与家长同 token 绑定注册）
const CHILD_ID = crypto.randomUUID();

// mock 云端：分配包表 + 进度摘要表（token 校验读测试 license 真实 token）
const deliveries: Array<{ id: string; childId: string; payload: any }> = [];
let progressRow: { summary: string; updated_at: string; requested_at: string | null } | null = null;

function jsonRes(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const cloudFetchMock = cloudFetch as unknown as ReturnType<typeof vi.fn>;

beforeAll(async () => {
  process.env.PI_TEST_DATA_DIR = DATA_DIR;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // SPLIT：家长库/孩子 kb 在服务端 → 签真实 token（写临时目录 license.json）+ 注册测试孩子
  const parentId = crypto.randomUUID();
  writeTestLicense(DATA_DIR, parentId);
  await registerTestChild(DATA_DIR, CHILD_ID, "投递测试孩子");
  const license = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "license.json"), "utf-8")) as { token: string };

  // 家长库：一个主题（含 method）+ 两门课（服务端 parent_lib RPC）
  await upsertParentTopic(
    DEFAULT_PARENT_ID,
    { name: "论语", topicKey: "lunyu", method: "# 三步吟诵法\n逐句跟读，反复三遍。" },
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

  // 孩子库：已存在「第一章」且有进度（✅），模拟孩子学过的进度（服务端 kb RPC）
  await dbExec("kb.topics.upsert", {
    child_id: CHILD_ID,
    name: "论语",
    topic_key: "lunyu",
    method: "",
    progress: "第一章",
    rules_json: "{}",
  });
  await dbExec("kb.courses.upsert", {
    child_id: CHILD_ID,
    topic: "lunyu",
    title: "学而篇第一章",
    sort_order: 1,
    status: "✅",
    mastery: "熟练",
    first_learned: "",
    last_review: "",
    review_count: 0,
    material: "",
    send_material: "0",
    tags: "",
    lesson_method: "",
    html_path: "",
    teaching_copy: "",
  });

  cloudFetchMock.mockImplementation(async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = (init?.method as string) || "GET";
    const p = url.pathname;
    const auth = (init?.headers as any)?.Authorization || "";
    if (!auth.startsWith(`Bearer ${license.token}`)) return jsonRes(401, { detail: "unauthorized" });

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
  it("buildAllocPackage：从家长库生成包（含 method/courses，不含文件）", async () => {
    const pkg = await buildAllocPackage("lunyu");
    expect(pkg.topicName).toBe("论语");
    expect(pkg.method).toContain("三步吟诵法");
    expect(pkg.courses.length).toBe(2);
    expect(pkg.courses[0].htmlPath).toContain("materials/lunyu");
    // 不含任何文件内容字段
    expect((pkg as any).files).toBeUndefined();
  });

  it("uploadDelivery → pollDeliveries 往返", async () => {
    const pkg = await buildAllocPackage("lunyu");
    await uploadDelivery(CHILD_ID, pkg);
    const list = await pollDeliveries(CHILD_ID);
    expect(list.length).toBe(1);
    expect(list[0].payload.topicDir).toBe("lunyu");
  });

  it("applyAllocPackage：写入家长库 + 孩子库合并，已有课程进度保留", async () => {
    // 预置孩子进度（第一章 ✅/熟练）——服务端 kb 已由 beforeAll 写入
    const before = (
      await dbQuery<any[]>("kb.courses.list", { child_id: CHILD_ID, topic: "lunyu" })
    ).find((c) => c.title === "学而篇第一章")!;
    expect(before.status).toBe("✅");
    expect(before.mastery).toBe("熟练");

    const pkg = await buildAllocPackage("lunyu");
    await applyAllocPackage(CHILD_ID, pkg);

    // ① 家长库 topics.method 已写入（parent_content 可读）
    const topics = await dbQuery<any[]>("parent_lib.topics.list", {});
    const topic = topics.find((t) => t.topic_key === "lunyu")!;
    expect(topic.method).toContain("三步吟诵法");
    // ② 孩子库：第一章进度保留（✅/熟练），material 被补齐，第二章新增
    const rows = await dbQuery<any[]>("kb.courses.list", { child_id: CHILD_ID, topic: "lunyu" });
    const row1 = rows.find((c) => c.title === "学而篇第一章")!;
    const row2 = rows.find((c) => c.title === "学而篇第二章")!;
    expect(row1.status).toBe("✅");
    expect(row1.mastery).toBe("熟练");
    expect(row1.material).toContain("学而时习之");
    expect(row2.status).toBe("⬜");
  });

  it("handleCloudInbox：拉取→应用→ack（云端包被删）", async () => {
    // 上一用例已上传过 1 个包（仍在 pending），先清掉
    deliveries.length = 0;
    const pkg = await buildAllocPackage("lunyu");
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

    // 孩子端轮询：响应请求 → 摘要上传（服务端 kb 汇总）
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
