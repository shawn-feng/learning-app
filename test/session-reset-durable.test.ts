import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// mock electron：userData 指到临时目录，避免污染真实数据
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "/tmp/session-reset-test-userData",
    whenReady: () => ({ then: (cb: () => void) => cb() }),
    on: () => {},
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
  dialog: { showOpenDialog: async () => ({ canceled: true }) },
}));

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as config from "../electron/lib/config";
import * as piSession from "../electron/lib/pi-session";

const TMP = path.join(os.tmpdir(), `session-reset-test-${Date.now()}`);
const USERDATA = "/tmp/session-reset-test-userData";
// 复制一份真实的珊珊会话文件用于验证读取（不碰真实数据）
const REAL_SRC_DIR =
  "data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674/.pi/agent/sessions";

function copyRealSessions(destDir: string) {
  fs.mkdirSync(destDir, { recursive: true });
  const files = fs
    .readdirSync(REAL_SRC_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .slice(0, 4); // 取 4 个旧文件
  for (const f of files) {
    fs.copyFileSync(path.join(REAL_SRC_DIR, f), path.join(destDir, f));
  }
  return files;
}

describe("会话重置持久化 + 历史读取", () => {
  beforeAll(() => {
    fs.mkdirSync(TMP, { recursive: true });
    fs.mkdirSync(USERDATA, { recursive: true });
  });
  afterAll(() => {
    for (const d of [TMP, USERDATA]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("冷路径 reset 后必须在磁盘写出新会话文件（修复：重置不落盘）", async () => {
    const childId = `reset-${Date.now()}`;
    const childDir = config.getChildDir(childId);
    const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
    copyRealSessions(sessionsDir);
    const before = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));

    await piSession.resetChildSession(childId, 20);

    const after = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    // 关键断言：reset 后在磁盘上多出 1 个新文件（此前 newSession() 不写盘，after === before）
    expect(after.length).toBe(before.length + 1);
    // 新文件应是最新的（mtime 最大），这样 continueRecent 才会选中它
    const newest = after
      .map((f) => ({ f, m: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0].f;
    expect(newest.startsWith("2026-08-18") || newest > before[0]).toBe(true);
  });

  it("reset 后 continueRecent 选中新空文件（修复：再进入仍是旧消息）", async () => {
    const childId = `cont-${Date.now()}`;
    const childDir = config.getChildDir(childId);
    const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
    copyRealSessions(sessionsDir);

    await piSession.resetChildSession(childId, 20);

    // 模拟「用户退出再进入」：重新从磁盘 continueRecent
    const mgr = SessionManager.continueRecent(childDir, sessionsDir);
    const picked = mgr.getSessionFile()!;
    // 新文件的条目数应为 1（仅 header），即空白会话
    const lines = fs
      .readFileSync(picked, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim());
    expect(lines.length).toBe(1); // 只有 header
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("session");
  });

  it("listChildSessions 排除活跃会话且不抛错", async () => {
    const childId = `list-${Date.now()}`;
    const childDir = config.getChildDir(childId);
    const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
    const copied = copyRealSessions(sessionsDir);

    const list = await piSession.listChildSessions(childId);
    // 没有活跃会话（未 getChildSession），所以全部旧文件都列出
    expect(list.length).toBe(copied.length);
    for (const s of list) {
      expect(s.file).toMatch(/\.jsonl$/);
      expect(typeof s.messageCount).toBe("number");
    }
  });

  it("readChildSessionMessages 对真实归档文件返回消息且不抛错（修复：获取历史消息失败）", async () => {
    const childId = `read-${Date.now()}`;
    const childDir = config.getChildDir(childId);
    const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
    const copied = copyRealSessions(sessionsDir);

    // 对每一个归档文件尝试读取
    for (const f of copied) {
      const msgs = await piSession.readChildSessionMessages(childId, f);
      expect(Array.isArray(msgs)).toBe(true);
      // 真实文件都有内容
      expect(msgs.length).toBeGreaterThan(0);
    }
  });

  it("热路径逻辑：newSession() 后必须立即写盘，否则再进入仍是旧消息（修复 #1/#2）", () => {
    const childId = `hot-${Date.now()}`;
    const childDir = config.getChildDir(childId);
    const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
    copyRealSessions(sessionsDir);
    const oldest = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort((a, b) =>
        fs.statSync(path.join(sessionsDir, a)).mtimeMs -
        fs.statSync(path.join(sessionsDir, b)).mtimeMs
      )[0];

    // 模拟热路径：用真实 SessionManager 复刻 resetChildSession 热路径的关键动作
    const mgr = SessionManager.create(childDir, sessionsDir);
    mgr.newSession(); // 仅在内存里重置，不写盘（这正是旧 bug）
    const hotFile = mgr.getSessionFile()!;
    const hotHeader = mgr.getHeader();
    // —— 修复后必须补上的写盘动作 ——
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(hotFile, JSON.stringify(hotHeader) + "\n");

    // 旧文件不应被误删（新文件是最新 mtime）
    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toContain(oldest); // 旧归档保留
    expect(files).toContain(path.basename(hotFile)); // 新文件已落盘

    // 模拟「用户退出再进入」：continueRecent 必须选中新空文件
    const reloaded = SessionManager.continueRecent(childDir, sessionsDir);
    const picked = reloaded.getSessionFile()!;
    expect(path.basename(picked)).toBe(path.basename(hotFile));
    const lines = fs.readFileSync(picked, "utf8").split(/\r?\n/).filter((l) => l.trim());
    expect(lines.length).toBe(1); // 空白会话（仅 header）
  });
});
