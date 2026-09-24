/**
 * ISSUE-143 回归（2026-09-24）：发音评测按 audioFileId 取音频必须认得 P2 归并后的新根。
 *
 * 为什么需要它：ISSUE-131 P2 把 files 通道落盘从旧根 `files/<pid>/<stored>` 切到
 * `workspaces/<pid>[/cid]/uploads/<stored>`，files.ts 的下载/删除、fs.ts、upload-ref.ts 都改了
 * 双根解析（resolveStoredFileAbs：新根优先、旧根兜底），**唯独 routes/assessment.ts 的
 * readAudioBytes 还在自己拼旧根路径** → 0.5.5（09-23 09:05）上 201 后，凡「上传录音 → 评测」
 * 全部 404「音频文件不存在」：家长端设置页「测试」报错、考核口语/背诵题全部没有发音评分
 * （201 实测：09-24 背诵考核 files 表 旧根=false 新根=true，评测请求几十毫秒内瞬时失败）。
 *
 * 覆盖（真 fastify + 真 sqlite + 真 JWT）：
 * ① 新根孩子区（考核口语题场景）能取到音频 → 评测走不到「音频文件不存在」；
 * ② 新根家长区（设置页「测试」场景，无 childId）同上；
 * ③ 旧根存量（P2 前的老录音，如重评旧考核原音）经兜底仍能取到；
 * ④ files 表有行但磁盘无文件 / ⑤ 未知 fileId → 明确报「音频文件不存在」；
 * ⑥ 缺 token → 401。
 * 判定口径：评测配置未启用时，音频取到后的下一处失败是「发音评测未启用」——
 * 用它证明 readAudioBytes 已通过（该报错 ≠ 音频文件不存在）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openDb } from "../server/src/db";
import { registerAssessmentRoutes } from "../server/src/routes/assessment";
import { signSession } from "../server/src/auth/jwt";
import type { ServerConfig } from "../server/src/config";
import type { FastifyInstance } from "fastify";

// fastify 只装在 server/node_modules；从 server 目录解析才能命中（根 node_modules 没有）。
const requireFromServer = createRequire(path.resolve("server/src/index.ts"));
const Fastify = requireFromServer("fastify") as (opts?: Record<string, unknown>) => FastifyInstance;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue143-assess-"));
const SECRET = "test-secret-143";
const parentId = "parent-r143";
const childId = "child-r143";

const mainDb = openDb(dataDir);
const config: ServerConfig = {
  port: 8788,
  upstreamBase: "",
  jwtSecret: SECRET,
  tokenTtlDays: 7,
  dataDir,
};

let app: FastifyInstance;
let token: string;

const AUDIO = Buffer.from("fake-webm-bytes-for-issue143");

/** 造一条 files 记录，并把字节写到指定物理位置（newRoot=null 表示不落盘，模拟「有记录无文件」）。 */
function seedFile(id: string, stored: string, childIdOrNull: string | null, physicalAbs: string | null): void {
  const now = new Date().toISOString();
  mainDb
    .prepare(
      "INSERT INTO files (id, parent_id, child_id, original_name, stored_path, mime, size, created_at) VALUES (?,?,?,?,?,?,?,?)"
    )
    .run(id, parentId, childIdOrNull, stored, stored, "audio/webm", AUDIO.length, now);
  if (physicalAbs) {
    fs.mkdirSync(path.dirname(physicalAbs), { recursive: true });
    fs.writeFileSync(physicalAbs, AUDIO);
  }
}

beforeAll(async () => {
  const now = new Date().toISOString();
  mainDb.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(parentId, "r143@test", now, now);
  mainDb
    .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(childId, parentId, "珊珊", now, now);

  // ① 新根孩子区：workspaces/<pid>/<cid>/uploads/<stored>（考核口语题实际落点）
  seedFile("file-new-child", "new-child.webm", childId, path.join(dataDir, "workspaces", parentId, childId, "uploads", "new-child.webm"));
  // ② 新根家长区：workspaces/<pid>/uploads/<stored>（设置页「测试」实际落点，child 为空）
  seedFile("file-new-parent", "assessment-test.webm", null, path.join(dataDir, "workspaces", parentId, "uploads", "assessment-test.webm"));
  // ③ 旧根存量：files/<pid>/<stored>（P2 前的老录音，只读兜底）
  seedFile("file-old", "old-recording.wav", childId, path.join(dataDir, "files", parentId, "old-recording.wav"));
  // ④ 有记录、磁盘无文件
  seedFile("file-missing", "gone.webm", childId, null);

  token = signSession({ parent_id: parentId, email: "r143@test", plan: "basic" }, SECRET, 7);
  app = Fastify();
  registerAssessmentRoutes(app, { config, db: mainDb });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  mainDb.close();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄可能延迟释放，忽略 */
  }
});

const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** 评测配置未启用：音频取到 → 下一处失败是「发音评测未启用」；音频取不到 → 「音频文件不存在」。 */
async function assess(fileId: string, withChild: boolean): Promise<{ status: number; error: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/assessment/assess",
    headers: auth(),
    payload: { childId: withChild ? childId : "", audioFileId: fileId, refText: "" },
  });
  return { status: res.statusCode, error: (res.json() as { error?: string }).error || "" };
}

describe("ISSUE-143 发音评测音频双根解析", () => {
  it("新根孩子区（考核口语题场景）→ 取到音频，失败点在评测配置而非找文件", async () => {
    const r = await assess("file-new-child", true);
    expect(r.status, r.error).toBe(502);
    expect(r.error).toContain("发音评测未启用");
    expect(r.error).not.toContain("音频文件不存在");
  });

  it("新根家长区（设置页「测试」场景，无 childId）→ 同上", async () => {
    const r = await assess("file-new-parent", false);
    expect(r.status, r.error).toBe(502);
    expect(r.error).toContain("发音评测未启用");
    expect(r.error).not.toContain("音频文件不存在");
  });

  it("旧根存量（P2 前老录音）→ 兜底仍可取到", async () => {
    const r = await assess("file-old", true);
    expect(r.status, r.error).toBe(502);
    expect(r.error).toContain("发音评测未启用");
    expect(r.error).not.toContain("音频文件不存在");
  });

  it("有记录但磁盘无文件 → 明确报「音频文件不存在」", async () => {
    const r = await assess("file-missing", true);
    expect(r.status, r.error).toBe(502);
    expect(r.error).toContain("音频文件不存在");
  });

  it("未知 fileId → 明确报「音频文件不存在」", async () => {
    const r = await assess("file-not-in-db", false);
    expect(r.status, r.error).toBe(502);
    expect(r.error).toContain("音频文件不存在");
  });

  it("缺 token → 401（不是 500）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/assessment/assess",
      payload: { audioFileId: "file-new-child" },
    });
    expect(res.statusCode).toBe(401);
  });
});
