import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// ISSUE-041 层 B：家长空间扫描 + profile.json 去敏/合并（无网络依赖，纯本地）
import {
  sanitizeUploadContent,
  mergeDownloadContent,
  scanParentSpaceFiles,
} from "../electron/lib/sync-manager.ts";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-sync-test-"));
const DATA_DIR = path.join(TEST_DIR, "data");

beforeAll(() => {
  process.env.PI_TEST_DATA_DIR = DATA_DIR;
  fs.mkdirSync(path.join(DATA_DIR, "parents", "default", "materials", "lunyu", "media"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(DATA_DIR, "parents", "default", "uploads"), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "shared", "skills"), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "shared", "skills", "x"), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "parents", "default", "parent.sqlite"), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(DATA_DIR, "parents", "default", "materials", "lunyu", "a.html"), "<html>a</html>");
  fs.writeFileSync(path.join(DATA_DIR, "parents", "default", "materials", "lunyu", "media", "b.mp3"), Buffer.from([9, 9]));
  fs.writeFileSync(path.join(DATA_DIR, "parents", "default", "activity-log.md"), "# log");
  fs.writeFileSync(path.join(DATA_DIR, "parents", "default", "uploads", "u.png"), Buffer.from([1]));
  fs.writeFileSync(path.join(DATA_DIR, "parents", "default", "parent.sqlite.bak-dedup"), "dup");
  fs.writeFileSync(path.join(DATA_DIR, "agents.sqlite"), Buffer.from([2]));
  fs.writeFileSync(path.join(DATA_DIR, "scheduler-config.json"), '{"children":{}}');
  fs.writeFileSync(path.join(DATA_DIR, "app-settings.json"), "{}");
  fs.writeFileSync(path.join(DATA_DIR, "token-log.jsonl"), "{}");
  fs.writeFileSync(path.join(DATA_DIR, "shared", "skills", "x", "SKILL.md"), "# skill");
  fs.writeFileSync(path.join(DATA_DIR, "shared", "skills", "x", "ref.md"), "ref");
  // 不应进入家长空间的敏感/无关文件
  fs.writeFileSync(path.join(DATA_DIR, "shared", "auth.json"), '{"key":"secret"}');
  fs.writeFileSync(path.join(DATA_DIR, "license.json"), '{"token":"x"}');
  fs.writeFileSync(path.join(DATA_DIR, "task-state.json"), "{}");
  // 孩子目录不该出现在家长空间（它走孩子同步）
  fs.mkdirSync(path.join(DATA_DIR, "children", "c1"), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "children", "c1", "profile.json"), "{}");
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.PI_TEST_DATA_DIR;
});

describe("sanitizeUploadContent / mergeDownloadContent（profile 去敏）", () => {
  const profile = Buffer.from(
    JSON.stringify({ childId: "c1", name: "珊珊", passwordHash: "$2a$10$hash" }),
    "utf-8"
  );

  it("上传前剥离 passwordHash（仅孩子 profile.json，其它文件不动）", () => {
    const out = sanitizeUploadContent("children/c1/profile.json", profile);
    const obj = JSON.parse(out.toString("utf-8"));
    expect(obj.name).toBe("珊珊");
    expect("passwordHash" in obj).toBe(false);
    // 非 profile.json 原样
    expect(sanitizeUploadContent("children/c1/kb.sqlite", Buffer.from([1])).length).toBe(1);
    // 相对路径不是 children/ 前缀的原样
    expect(sanitizeUploadContent("parents/default/parent.sqlite", Buffer.from([1])).length).toBe(1);
  });

  it("下载后保留本机已有 passwordHash；本机无文件则原样透传", () => {
    const destAbs = path.join(DATA_DIR, "children", "c1", "profile.json");
    // 本机已有含 hash 的 profile（模拟旧机）
    fs.writeFileSync(destAbs, JSON.stringify({ childId: "c1", name: "珊珊", passwordHash: "$2a$10$hash" }));
    // 云端内容（已去敏，无 hash）→ 合并保留本机 hash
    const cloudNoHash = Buffer.from(
      JSON.stringify({ childId: "c1", name: "珊珊", age: 7 }),
      "utf-8"
    );
    const merged = mergeDownloadContent("children/c1/profile.json", destAbs, cloudNoHash);
    const m = JSON.parse(merged.toString("utf-8"));
    expect(m.name).toBe("珊珊");
    expect(m.age).toBe(7);
    expect(m.passwordHash).toBe("$2a$10$hash");
    // 本机不存在（新机）→ 原样透传云端内容（不含 hash，需重置解锁）
    const fresh = mergeDownloadContent(
      "children/c1/profile.json",
      path.join(DATA_DIR, "children", "c2", "profile.json"),
      cloudNoHash
    );
    expect(fresh.toString("utf-8")).toBe(cloudNoHash.toString("utf-8"));
    expect("passwordHash" in JSON.parse(fresh.toString("utf-8"))).toBe(false);
  });
});

describe("scanParentSpaceFiles（家长空间清单）", () => {
  it("包含家长库/全局配置/技能，排除敏感与临时文件，不含孩子目录", async () => {
    const files = await scanParentSpaceFiles();
    const rels = files.map((f) => f.path.replace(/\\/g, "/")).sort();

    expect(rels).toContain("parents/default/parent.sqlite");
    expect(rels).toContain("parents/default/materials/lunyu/a.html");
    expect(rels).toContain("parents/default/materials/lunyu/media/b.mp3");
    expect(rels).toContain("parents/default/activity-log.md");
    expect(rels).toContain("parents/default/uploads/u.png");
    expect(rels).toContain("agents.sqlite");
    expect(rels).toContain("scheduler-config.json");
    expect(rels).toContain("app-settings.json");
    expect(rels).toContain("token-log.jsonl");
    expect(rels).toContain("shared/skills/x/SKILL.md");
    expect(rels).toContain("shared/skills/x/ref.md");

    // 排除项
    expect(rels).not.toContain("shared/auth.json");
    expect(rels).not.toContain("license.json");
    expect(rels).not.toContain("task-state.json");
    expect(rels).not.toContain("parents/default/parent.sqlite.bak-dedup");
    // 孩子目录走孩子同步，不在此清单
    expect(rels.some((r) => r.startsWith("children/"))).toBe(false);
  });
});
