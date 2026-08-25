import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// backup.ts 走 getDataDir()（config.ts），用 PI_TEST_DATA_DIR 隔离真实 data/。
import {
  createBackup,
  restoreBackup,
  zipUnpack,
  zipPack,
  isBackupExcluded,
} from "../electron/lib/backup.ts";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-backup-test-"));
const DATA_DIR = path.join(TEST_DIR, "data");
const DEST_DIR = path.join(TEST_DIR, "dest");

beforeAll(() => {
  process.env.PI_TEST_DATA_DIR = DATA_DIR;
  // 构造一份含敏感数据/正常数据的真实目录结构
  const childDir = path.join(DATA_DIR, "children", "child-1");
  fs.mkdirSync(path.join(childDir, "learning", "lunyu", "media"), { recursive: true });
  fs.mkdirSync(path.join(childDir, ".pi", "agent", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(childDir, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "parents", "default", "materials"), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "shared", "skills"), { recursive: true });

  fs.writeFileSync(
    path.join(childDir, "profile.json"),
    JSON.stringify({ childId: "child-1", name: "珊珊", passwordHash: "$2a$10$secret-hash" }, null, 2)
  );
  fs.writeFileSync(path.join(childDir, "learning", "lunyu", "method.md"), "# 三步吟诵法");
  fs.writeFileSync(path.join(childDir, "learning", "lunyu", "media", "a.mp3"), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(childDir, "kb.sqlite"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  fs.writeFileSync(path.join(childDir, "uploads", "x.png"), Buffer.from([9, 9, 9]));
  fs.writeFileSync(path.join(childDir, ".pi", "agent", "sessions", "s.jsonl"), "# 会话历史，不应备份");
  fs.writeFileSync(path.join(DATA_DIR, "parents", "default", "parent.sqlite"), Buffer.from([5, 5, 5]));
  fs.writeFileSync(path.join(DATA_DIR, "parents", "default", "materials", "a.html"), "<html>资料</html>");
  fs.writeFileSync(path.join(DATA_DIR, "agents.sqlite"), Buffer.from([1, 1, 1]));
  fs.writeFileSync(path.join(DATA_DIR, "scheduler-config.json"), '{"children":{}}');
  fs.writeFileSync(path.join(DATA_DIR, "app-settings.json"), '{"defaultModel":"qwen/qwen-max"}');
  fs.writeFileSync(path.join(DATA_DIR, "app-settings.json.bak-20260824"), "old");
  // 敏感数据（必须被排除）
  fs.writeFileSync(path.join(DATA_DIR, "shared", "auth.json"), '{"deepseek":{"type":"api_key","key":"sk-secret"}}');
  fs.writeFileSync(path.join(DATA_DIR, "license.json"), '{"token":"jwt-secret"}');
  fs.writeFileSync(path.join(DATA_DIR, "task-state.json"), '{"children":{}}');
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.PI_TEST_DATA_DIR;
});

describe("isBackupExcluded（denylist）", () => {
  it("排除敏感/内部/会话/临时文件，保留使用数据", () => {
    expect(isBackupExcluded("shared/auth.json")).toBe(true);
    expect(isBackupExcluded("license.json")).toBe(true);
    expect(isBackupExcluded("task-state.json")).toBe(true);
    expect(isBackupExcluded("children/c1/.pi/agent/sessions/a.jsonl")).toBe(true);
    expect(isBackupExcluded("app-settings.json.bak-20260824")).toBe(true);
    expect(isBackupExcluded("backup-20260825-123456.zip")).toBe(true);
    expect(isBackupExcluded("children/c1/profile.json")).toBe(false);
    expect(isBackupExcluded("parents/default/parent.sqlite")).toBe(false);
    expect(isBackupExcluded("agents.sqlite")).toBe(false);
    expect(isBackupExcluded("scheduler-config.json")).toBe(false);
  });
});

describe("createBackup + zipUnpack", () => {
  it("产出 zip：含使用数据、剥离 passwordHash、不含敏感与会话", async () => {
    const r = await createBackup(DEST_DIR);
    expect(fs.existsSync(r.file)).toBe(true);
    expect(r.file).toMatch(/backup-\d{8}-\d{6}\.zip$/);
    expect(r.count).toBeGreaterThan(0);

    const buf = fs.readFileSync(r.file);
    const entries = zipUnpack(buf);
    const byPath = new Map(entries.map((e) => [e.path, e.data]));

    expect(byPath.has("manifest.json")).toBe(true);
    // 使用数据都在
    expect(byPath.has("children/child-1/learning/lunyu/method.md")).toBe(true);
    expect(byPath.has("children/child-1/learning/lunyu/media/a.mp3")).toBe(true);
    expect(byPath.has("children/child-1/kb.sqlite")).toBe(true);
    expect(byPath.has("children/child-1/uploads/x.png")).toBe(true);
    expect(byPath.has("parents/default/parent.sqlite")).toBe(true);
    expect(byPath.has("parents/default/materials/a.html")).toBe(true);
    expect(byPath.has("agents.sqlite")).toBe(true);
    expect(byPath.has("scheduler-config.json")).toBe(true);
    expect(byPath.has("app-settings.json")).toBe(true);
    // 敏感/内部/会话/临时必须不在
    expect(byPath.has("shared/auth.json")).toBe(false);
    expect(byPath.has("license.json")).toBe(false);
    expect(byPath.has("task-state.json")).toBe(false);
    expect(byPath.has("children/child-1/.pi/agent/sessions/s.jsonl")).toBe(false);
    expect(byPath.has("app-settings.json.bak-20260824")).toBe(false);

    // profile.json 已剥离 passwordHash，且源文件未被改动
    const profile = JSON.parse(byPath.get("children/child-1/profile.json")!.toString("utf-8"));
    expect(profile.name).toBe("珊珊");
    expect("passwordHash" in profile).toBe(false);
    const srcProfile = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, "children", "child-1", "profile.json"), "utf-8")
    );
    expect(srcProfile.passwordHash).toBe("$2a$10$secret-hash");
  });
});

describe("restoreBackup", () => {
  it("keepAuth 默认保护本机 auth/license；其余文件恢复到 data/", async () => {
    const r = await createBackup(DEST_DIR);
    // 预置本机敏感数据（恢复后必须保留）
    fs.writeFileSync(path.join(DATA_DIR, "shared", "auth.json"), '{"local":"key"}');
    fs.writeFileSync(path.join(DATA_DIR, "license.json"), '{"local":"license"}');
    // 删除一个使用数据文件，模拟新机缺文件
    fs.rmSync(path.join(DATA_DIR, "parents", "default", "materials", "a.html"), { force: true });

    const res = await restoreBackup(r.file);
    expect(res.restored).toBeGreaterThan(0);
    // 本机敏感数据未被覆盖
    expect(fs.readFileSync(path.join(DATA_DIR, "shared", "auth.json"), "utf-8")).toBe('{"local":"key"}');
    expect(fs.readFileSync(path.join(DATA_DIR, "license.json"), "utf-8")).toBe('{"local":"license"}');
    // 缺的使用数据被恢复
    expect(fs.readFileSync(path.join(DATA_DIR, "parents", "default", "materials", "a.html"), "utf-8")).toBe("<html>资料</html>");
  });

  it("keepAuth 拦截：zip 内含敏感条目时默认跳过，keepAuth:false 则覆盖", async () => {
    // 构造一个「其他工具导出、包含敏感文件」的 zip
    const buf = await zipPack([
      { path: "shared/auth.json", data: Buffer.from('{"evil":"key"}') },
      { path: "license.json", data: Buffer.from('{"evil":"license"}') },
      { path: "agents.sqlite", data: Buffer.from([7, 7, 7]) },
    ]);
    const zipPath = path.join(TEST_DIR, "with-sensitive.zip");
    fs.writeFileSync(zipPath, buf);

    const keep = await restoreBackup(zipPath, { keepAuth: true });
    expect(keep.skipped).toContain("shared/auth.json");
    expect(keep.skipped).toContain("license.json");
    expect(fs.readFileSync(path.join(DATA_DIR, "shared", "auth.json"), "utf-8")).toBe('{"local":"key"}');
    expect(fs.readFileSync(path.join(DATA_DIR, "license.json"), "utf-8")).toBe('{"local":"license"}');

    const force = await restoreBackup(zipPath, { keepAuth: false });
    expect(force.skipped).not.toContain("shared/auth.json");
    expect(fs.readFileSync(path.join(DATA_DIR, "shared", "auth.json"), "utf-8")).toBe('{"evil":"key"}');
  });
});
