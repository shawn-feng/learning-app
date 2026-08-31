vi.mock("electron", () => ({ app: undefined }));

// 私有临时数据目录（独立 mkdtemp，不共享 PI_TEST_DATA_DIR）：sync 用例会读写孩子
// profile.json，必须完全隔离。
// ⚠️ 2026-08-31 事故教训：本测试曾不隔离（走共享测试目录 + 真实服务端），listChildren
// 的「本地有详情、服务端无 → 自动上传」分支用本地旧/种子哈希 PATCH 覆盖了珊珊/闻闻的
// 服务端密码哈希，导致两个孩子登录失败。现在 mock 到私有目录 + 随机 UUID 测试孩子，
// 绝不碰真实孩子数据；且 child-auth 上传分支已加「本地有哈希不自动上传」保护。
const mockTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sync-test-"));
vi.mock("../electron/lib/config", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../electron/lib/config")>();
  return {
    ...mod,
    getDataDir: () => mockTmpRoot,
    getLicensePath: () => path.join(mockTmpRoot, "license.json"),
    getChildrenDir: () => path.join(mockTmpRoot, "children"),
    getChildDir: (id: string) => path.join(mockTmpRoot, "children", id),
    getSharedDir: () => path.join(mockTmpRoot, "shared"),
    getSkillsDir: () => path.join(mockTmpRoot, "shared", "skills"),
  };
});

import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

// Simulate scanChildFiles logic for unit testing
function scanChildFiles(dir: string): Array<{ path: string; hash: string; mtimeMs: number; size: number }> {
  const results: Array<{ path: string; hash: string; mtimeMs: number; size: number }> = [];
  const excludeDirs = [".pi"];
  function walk(d: string, relativeTo: string) {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && excludeDirs.includes(entry.name)) continue;
      const fullPath = path.join(d, entry.name);
      const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        walk(fullPath, relativeTo);
      } else {
        const content = fs.readFileSync(fullPath);
        results.push({
          path: relPath,
          hash: crypto.createHash("sha256").update(content).digest("hex"),
          mtimeMs: fs.statSync(fullPath).mtimeMs,
          size: content.length,
        });
      }
    }
  }
  walk(dir, dir);
  return results;
}

describe("Phase 9: 同步管理器", () => {
  const TEST_CHILD = {
    name: "sync-test",
    avatar: "🦊",
    password: "sync123",
    age: 7,
    grade: "一年级",
    interests: "",
    aiName: "小狐",
    aiEmoji: "🦊",
    aiPersonality: "亲切",
  };
  // 本次运行的测试孩子 id（listChildren 会返回 TEST_PARENT 名下所有孩子含真实孩子，
  // 必须按 id 精确找到自己注册的测试孩子，不能依赖 children[0]）
  const TEST_CHILD_ID = crypto.randomUUID();

  beforeAll(async () => {
    const { writeTestLicense, registerTestChild, TEST_PARENT_ID } = await import("./helpers/server-token");
    const { initChildDirectory } = await import("../electron/lib/user-init");
    fs.mkdirSync(mockTmpRoot, { recursive: true });
    writeTestLicense(mockTmpRoot, TEST_PARENT_ID);
    // 服务端注册测试孩子（assertChildOwned 要求归属 TEST_PARENT）；本地建 profile.json + kb.sqlite
    await registerTestChild(mockTmpRoot, TEST_CHILD_ID, TEST_CHILD.name);
    await initChildDirectory(TEST_CHILD_ID, {
      childId: TEST_CHILD_ID,
      name: TEST_CHILD.name,
      avatar: TEST_CHILD.avatar,
      passwordHash: await bcrypt.hash(TEST_CHILD.password, 10),
      age: TEST_CHILD.age,
      grade: TEST_CHILD.grade,
      interests: TEST_CHILD.interests,
      aiName: TEST_CHILD.aiName,
      aiEmoji: TEST_CHILD.aiEmoji,
      aiPersonality: TEST_CHILD.aiPersonality,
      createdAt: new Date().toISOString(),
    });
  });

  it("scanChildFiles 扫描孩子目录中的文件（排除 .pi）", async () => {
    const childAuth = await import("../electron/lib/child-auth");
    const config = await import("../electron/lib/config");

    // ensure we have at least one child
    let children = await childAuth.listChildren();
    if (children.length === 0) {
      await childAuth.addChild({
        name: TEST_CHILD.name,
        avatar: TEST_CHILD.avatar,
        password: TEST_CHILD.password,
        age: TEST_CHILD.age,
        grade: TEST_CHILD.grade,
        interests: TEST_CHILD.interests,
        aiName: TEST_CHILD.aiName,
        aiEmoji: TEST_CHILD.aiEmoji,
        aiPersonality: TEST_CHILD.aiPersonality,
      });
      children = await childAuth.listChildren();
    }

    const child = children.find((c) => c.childId === TEST_CHILD_ID);
    expect(child).toBeTruthy();
    const childDir = config.getChildDir(child!.childId);
    const files = scanChildFiles(childDir);

    // Should have profile.json、kb.sqlite 等（ISSUE-032：SQLite 唯一真源，不再建 learning/*.md；
    // ISSUE-033 修订：AGENTS.md 不再存在于孩子目录——AGENTS 归家长目录，孩子只读、不参与同步）
    expect(files.length).toBeGreaterThanOrEqual(2);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("profile.json");
    expect(paths).not.toContain("AGENTS.md");
    expect(paths).toContain("kb.sqlite");

    // .pi directory should NOT be included (sync excludes it)
    expect(paths.some((p) => p.startsWith(".pi/"))).toBe(false);
  });

  it("scanChildFiles 返回的文件信息包含必需字段", async () => {
    const childAuth = await import("../electron/lib/child-auth");
    const config = await import("../electron/lib/config");
    const children = await childAuth.listChildren();
    const child = children.find((c) => c.childId === TEST_CHILD_ID);
    expect(child).toBeTruthy();
    const childDir = config.getChildDir(child!.childId);
    const files = scanChildFiles(childDir);

    const profile = files.find((f) => f.path === "profile.json");
    expect(profile).toBeTruthy();
    expect(profile!.hash).toBeTruthy();
    expect(profile!.hash.length).toBe(64); // sha256 hex
    expect(profile!.size).toBeGreaterThan(0);
    expect(profile!.mtimeMs).toBeGreaterThan(0);
  });

  it("文件内容变更会导致 hash 不同", async () => {
    const childAuth = await import("../electron/lib/child-auth");
    const config = await import("../electron/lib/config");
    const children = await childAuth.listChildren();
    const child = children.find((c) => c.childId === TEST_CHILD_ID);
    expect(child).toBeTruthy();
    const childDir = config.getChildDir(child!.childId);

    const before = scanChildFiles(childDir);
    const profileBefore = before.find((f) => f.path === "profile.json")!.hash;

    // 修改 mock 目录下的 profile.json（ISSUE-032：不再有 learning/rules.md 文件模板）
    const profilePath = path.join(childDir, "profile.json");
    const original = fs.readFileSync(profilePath, "utf-8");
    fs.writeFileSync(profilePath, original + "\n");

    const after = scanChildFiles(childDir);
    const profileAfter = after.find((f) => f.path === "profile.json")!.hash;

    // Restore
    fs.writeFileSync(profilePath, original);

    // Hash should have changed
    expect(profileAfter).not.toBe(profileBefore);
  });

  it("last-write-wins: 本地较新的文件应标记为上传", () => {
    // Simulate last-write-wins logic
    const local = { path: "test.md", hash: "abc", mtimeMs: 2000, size: 100 };
    const cloud = { path: "test.md", hash: "def", updated_at: new Date(1000).toISOString(), size: 50 };

    const cloudTime = new Date(cloud.updated_at).getTime();
    const shouldUpload = local.mtimeMs > cloudTime;

    expect(shouldUpload).toBe(true);
  });

  it("last-write-wins: 云端较新的文件应标记为下载", () => {
    const local = { path: "test.md", hash: "abc", mtimeMs: 1000, size: 100 };
    const cloud = { path: "test.md", hash: "def", updated_at: new Date(2000).toISOString(), size: 50 };

    const cloudTime = new Date(cloud.updated_at).getTime();
    const shouldDownload = local.mtimeMs < cloudTime;

    expect(shouldDownload).toBe(true);
  });

  it("hash 相同时跳过同步", () => {
    const hash = crypto.createHash("sha256").update("same content").digest("hex");
    const local = { path: "test.md", hash, mtimeMs: 1000, size: 100 };
    const cloud = { path: "test.md", hash, updated_at: new Date(500).toISOString(), size: 100 };

    const needsSync = local.hash !== cloud.hash;
    expect(needsSync).toBe(false);
  });

  it("仅本地有文件时应上传", () => {
    const localFiles = [
      { path: "new-file.md", hash: "abc", mtimeMs: 1000, size: 50 },
    ];
    const cloudMap = new Map<string, any>(); // empty

    const toUpload = localFiles.filter((lf) => !cloudMap.has(lf.path));
    expect(toUpload.length).toBe(1);
    expect(toUpload[0].path).toBe("new-file.md");
  });

  it("仅云端有文件时应下载", () => {
    const cloudFiles = [
      { path: "only-on-cloud.md", hash: "def", updated_at: "2026-08-12T00:00:00Z", size: 200 },
    ];
    const localMap = new Map<string, any>(); // empty

    const toDownload = cloudFiles.filter((cf) => !localMap.has(cf.path));
    expect(toDownload.length).toBe(1);
    expect(toDownload[0].path).toBe("only-on-cloud.md");
  });
});
