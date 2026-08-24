import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("electron", () => {
  return {
    app: {
      isPackaged: false,
      getPath: () => "/tmp/test-userData",
      whenReady: () => ({ then: (cb: () => void) => cb() }),
      on: () => {},
    },
    ipcMain: { handle: vi.fn() },
    BrowserWindow: class {},
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
  };
});

import path from "node:path";
import fs from "node:fs";
import * as config from "../electron/lib/config";
import * as userInit from "../electron/lib/user-init";
import * as childAuth from "../electron/lib/child-auth";
import * as authManager from "../electron/lib/auth-manager";
import * as piSession from "../electron/lib/pi-session";

describe("Electron app modules", () => {
  let createdChildId: string;

  beforeAll(() => {
    // data cleanup skipped: sandbox restricts rmSync on project dirs
    process.env.CLOUD_API_URL = "http://localhost:8005";
  });

  afterAll(() => {
    delete process.env.CLOUD_API_URL;
    // data cleanup skipped: sandbox restricts rmSync on project dirs
  });

  it("creates data dir and initializes shared skills", () => {
    config.getDataDir();
    userInit.initSharedSkills();
    const skillsDir = config.getSkillsDir();
    expect(fs.existsSync(skillsDir)).toBe(true);
    const skills = fs
      .readdirSync(skillsDir)
      .filter((d) => fs.statSync(path.join(skillsDir, d)).isDirectory());
    // recording / study-tracker 均已改为定时任务，共享技能目录应为空
    expect(skills).toEqual([]);
  });

  it("initializes child directory with all required files", async () => {
    const childId = "test-child-1";
    const profile: childAuth.ChildProfile = {
      childId,
      name: "小明",
      avatar: "🦊",
      passwordHash: "hash",
      age: 8,
      grade: "二年级",
      interests: "恐龙",
      aiName: "知识狐",
      aiEmoji: "🦊",
      aiPersonality: "温和",
      createdAt: new Date().toISOString(),
    };
    await userInit.initChildDirectory(childId, profile);
    const childDir = config.getChildDir(childId);
    const files = fs.readdirSync(childDir);
    expect(files).toContain("profile.json");
    expect(files).toContain("kb.sqlite");
    // ISSUE-033：AGENTS 纯 SQLite（data/agents.sqlite）——孩子目录不落盘（孩子只读、不可写），
    // 家长目录也无 agents 物理文件（SQLite 为唯一真源，查看/编辑在家长页面）
    expect(files).not.toContain("AGENTS.md");
    const { getDataDir } = await import("../electron/lib/config");
    expect(fs.existsSync(path.join(getDataDir(), "parents", "default", "agents"))).toBe(false);
    const settingsPath = path.join(childDir, ".pi", "agent", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.skills[0]).toBe(config.getSkillsDir());
  });

  it("adds child, authenticates with local password, and creates pi session", { timeout: 30000 }, async () => {
    const added = await childAuth.addChild({
      name: "小红",
      avatar: "🐰",
      password: "secret123",
      age: 7,
      grade: "一年级",
      interests: "画画",
      aiName: "小画家",
      aiEmoji: "🎨",
      aiPersonality: "活泼",
    });
    createdChildId = added.childId;
    expect(added.name).toBe("小红");

    const ok = await childAuth.authChild(createdChildId, "secret123");
    const bad = await childAuth.authChild(createdChildId, "wrong");
    expect(ok).toBe(true);
    expect(bad).toBe(false);

    const list = childAuth.listChildren();
    expect(list.some((c) => c.childId === createdChildId)).toBe(true);

    // Create pi session for this child
    const session = await piSession.getChildSession(createdChildId);
    expect(session).toBeTruthy();
    await piSession.disposeChildSession(createdChildId);
  });

  it("registers parent with cloud service and caches license", async () => {
    const email = `itest-${Date.now()}@test.com`;
    const license = await authManager.registerAndCache(email, "pass123");
    expect(license.parent_id).toBeTruthy();
    expect(license.max_children).toBeGreaterThan(0);
    expect((await authManager.checkAuth()).authenticated).toBe(true);
  });
});
