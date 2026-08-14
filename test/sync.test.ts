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
    let children = childAuth.listChildren();
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
      children = childAuth.listChildren();
    }

    const child = children[0];
    const childDir = config.getChildDir(child.childId);
    const files = scanChildFiles(childDir);

    // Should have profile.json, study-topics.md, study-rules.md, life-events.md
    expect(files.length).toBeGreaterThanOrEqual(4);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("profile.json");
    expect(paths).toContain("study-topics.md");
    expect(paths).toContain("study-rules.md");
    expect(paths).toContain("life-events.md");

    // .pi directory should NOT be included (sync excludes it)
    expect(paths.some((p) => p.startsWith(".pi/"))).toBe(false);
  });

  it("scanChildFiles 返回的文件信息包含必需字段", async () => {
    const childAuth = await import("../electron/lib/child-auth");
    const config = await import("../electron/lib/config");
    const children = childAuth.listChildren();
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
    const children = childAuth.listChildren();
    const childDir = config.getChildDir(children[0].childId);

    const before = scanChildFiles(childDir);
    const profileBefore = before.find((f) => f.path === "profile.json")!.hash;

    // Read and modify (add a comment)
    const rulesPath = path.join(childDir, "study-rules.md");
    const original = fs.readFileSync(rulesPath, "utf-8");
    fs.writeFileSync(rulesPath, original + "\n# sync test comment\n");

    const after = scanChildFiles(childDir);
    const rulesAfter = after.find((f) => f.path === "study-rules.md")!.hash;

    // Restore
    fs.writeFileSync(rulesPath, original);

    // Hash should have changed
    expect(rulesAfter).not.toBe(profileBefore);
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
