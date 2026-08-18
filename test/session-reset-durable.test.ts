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
import { SessionManager, CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
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

// 生成一个 cwd 与测试 childDir 匹配的合法会话文件（避免 continueRecent 的 cwd 过滤把复制的真实文件排除）
function makeSessionFile(sessionsDir: string, cwd: string, label: string): string {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const id = `sess-${label}-${Date.now()}`;
  const file = path.join(sessionsDir, `${label}.jsonl`);
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp: new Date().toISOString(),
    cwd,
  };
  const userMsg = {
    type: "message",
    id: "u1",
    parentId: id,
    role: "user",
    message: { role: "user", content: "你好" },
    timestamp: new Date().toISOString(),
  };
  const asstMsg = {
    type: "message",
    id: "a1",
    parentId: "u1",
    role: "assistant",
    message: { role: "assistant", content: "你好呀" },
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(file, [header, userMsg, asstMsg].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path.basename(file);
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

  it("冷路径 reset 后不在磁盘写出新会话文件（官方流程：空会话不落盘）", async () => {
    const childId = `reset-${Date.now()}`;
    const childDir = config.getChildDir(childId);
    const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
    copyRealSessions(sessionsDir);
    const before = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));

    await piSession.resetChildSession(childId, 20);

    const after = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    // 官方流程：空会话不在 SDK 之外写盘 → 磁盘文件数不变（reset 不主动清空当前会话）
    expect(after.length).toBe(before.length);
  });

  it("冷路径 reset 后 continueRecent 仍选中旧会话（官方语义：不主动清空当前会话）", async () => {
    const childId = `cont-${Date.now()}`;
    const childDir = config.getChildDir(childId);
    const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
    const oldName = makeSessionFile(sessionsDir, childDir, "old");
    const beforeSet = new Set([oldName]);

    await piSession.resetChildSession(childId, 20);

    // 模拟「用户退出再进入」：重新从磁盘 continueRecent
    const mgr = SessionManager.continueRecent(childDir, sessionsDir);
    const picked = mgr.getSessionFile()!;
    // 选中的应仍是 reset 前就存在的旧文件（不是新创建的空文件）
    expect(beforeSet.has(path.basename(picked))).toBe(true);
    // 该文件是旧会话（多行，非仅 header）
    const lines = fs
      .readFileSync(picked, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(1); // 旧会话有内容，不是空白
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

  it("热路径 reset 按官方流程不写盘：若重载前未发消息，continueRecent 仍选中旧会话（已接受的边界）", () => {
    const childId = `hot-${Date.now()}`;
    const childDir = config.getChildDir(childId);
    const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
    const oldName = makeSessionFile(sessionsDir, childDir, "old");
    const beforeSet = new Set([oldName]);

    // 复刻 resetChildSession 热路径的关键动作：仅 newSession()（内存），不写盘
    const mgr = SessionManager.create(childDir, sessionsDir);
    mgr.newSession();

    // 模拟「reset 后、发消息前就重载」：continueRecent 选中仍是旧会话
    // （reset 不跨重载持久化——这是按官方流程接受下来的边界）
    const reloaded = SessionManager.continueRecent(childDir, sessionsDir);
    const picked = reloaded.getSessionFile()!;
    expect(beforeSet.has(path.basename(picked))).toBe(true);
  });
});
