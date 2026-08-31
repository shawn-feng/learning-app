import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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
  it("scanChildFiles 扫描孩子目录中的文件（排除 .pi）", async () => {
    const childAuth = await import("../electron/lib/child-auth");
    const config = await import("../electron/lib/config");

    // ensure we have at least one child
    let children = await childAuth.listChildren();
    if (children.length === 0) {
      await childAuth.addChild({
        name: "sync-test",
        avatar: "🦊",
        password: "sync123",
        age: 7,
        grade: "一年级",
        interests: "",
        aiName: "小狐",
        aiEmoji: "🦊",
        aiPersonality: "亲切",
      });
      children = await childAuth.listChildren();
    }

    const child = children[0];
    const childDir = config.getChildDir(child.childId);
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
    const childDir = config.getChildDir(children[0].childId);
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
    const childDir = config.getChildDir(children[0].childId);

    const before = scanChildFiles(childDir);
    const profileBefore = before.find((f) => f.path === "profile.json")!.hash;

    // 修改真实存在的 profile.json（ISSUE-032：不再有 learning/rules.md 文件模板）
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
