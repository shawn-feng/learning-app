import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// 与 app.test.ts 一致的 electron mock：把 userData 指到 /tmp，避免污染真实数据。
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "/tmp/archive-limit-test-userData",
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
import * as config from "../electron/lib/config";
import * as piSession from "../electron/lib/pi-session";
import * as scheduler from "../electron/lib/scheduler";

const TMP = path.join(os.tmpdir(), `archive-limit-test-${Date.now()}`);

function makeJsonl(dir: string, name: string, ageSec: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(
    p,
    JSON.stringify({ type: "session", id: name, timestamp: new Date().toISOString() }) + "\n"
  );
  // 设成 N 秒前，制造不同的 mtime，便于验证「保留最近」
  const t = (Date.now() - ageSec * 1000) / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

describe("归档保留上限（archive limit）", () => {
  beforeAll(() => {
    fs.mkdirSync(TMP, { recursive: true });
  });

  afterAll(() => {
    // /tmp 下的临时目录可安全删除（非项目目录）
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync("/tmp/archive-limit-test-userData", { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("pruneArchivedSessions 只保留 limit 个最新的非活跃文件", () => {
    const dir = path.join(TMP, "prune1");
    fs.mkdirSync(dir, { recursive: true });
    const active = makeJsonl(dir, "active.jsonl", 0); // 最新
    makeJsonl(dir, "a.jsonl", 10);
    makeJsonl(dir, "b.jsonl", 20);
    makeJsonl(dir, "c.jsonl", 30);
    makeJsonl(dir, "d.jsonl", 40); // 最旧
    piSession.pruneArchivedSessions(dir, active, 2);
    const remaining = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    // 活跃文件 + 2 个最新的非活跃（a, b）
    expect(remaining).toEqual(["a.jsonl", "active.jsonl", "b.jsonl"]);
  });

  it("prune 上限为 0 时删除全部非活跃归档（仅留当前会话）", () => {
    const dir = path.join(TMP, "prune0");
    fs.mkdirSync(dir, { recursive: true });
    const active = makeJsonl(dir, "active.jsonl", 0);
    makeJsonl(dir, "a.jsonl", 10);
    makeJsonl(dir, "b.jsonl", 20);
    piSession.pruneArchivedSessions(dir, active, 0);
    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    expect(remaining).toEqual(["active.jsonl"]);
  });

  it("prune 用默认上限时，未超过上限则全部保留", () => {
    const dir = path.join(TMP, "pruneDef");
    fs.mkdirSync(dir, { recursive: true });
    const active = makeJsonl(dir, "active.jsonl", 0);
    makeJsonl(dir, "a.jsonl", 10);
    makeJsonl(dir, "b.jsonl", 20);
    piSession.pruneArchivedSessions(dir, active); // undefined -> 默认 20
    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    expect(remaining.length).toBe(3);
  });

  it("scheduler 配置能读写并合并 archiveLimit（默认值 20）", () => {
    const kid = "cfg-kid-1";
    scheduler.setChildSchedulerConfig(kid, {
      recording: { enabled: false, times: ["21:00"], onNewSession: false },
      sessionReset: { enabled: false, hour: 22, minute: 0 },
      archiveLimit: 7,
    });
    expect(scheduler.getChildSchedulerConfig(kid).archiveLimit).toBe(7);

    // 部分配置也能补全其他缺省字段，且 archiveLimit 持久化
    scheduler.setChildSchedulerConfig("cfg-kid-2", { archiveLimit: 3 } as any);
    const got2 = scheduler.getChildSchedulerConfig("cfg-kid-2");
    expect(got2.archiveLimit).toBe(3);
    expect(got2.recording.enabled).toBe(false); // 缺省补全
    expect(got2.sessionReset.hour).toBe(22); // 缺省补全
  });

  it("resetChildSession（冷路径）按 archiveLimit 清理归档（官方流程：不新建活跃文件）", async () => {
    const childId = `cold-${Date.now()}`;
    const childDir = config.getChildDir(childId);
    const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    // 预置 5 个旧归档
    for (let i = 0; i < 5; i++) makeJsonl(sessionsDir, `old-${i}.jsonl`, (i + 1) * 10);

    await piSession.resetChildSession(childId, 2);

    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    // 官方流程：冷路径（会话未加载）不新建/不写出任何 .jsonl，仅按 archiveLimit 保留
    // 最近 2 个归档（旧行为会额外写出 1 个新活跃 header 文件，已被移除）。因此剩 2 个。
    expect(files.length).toBe(2);

    // 清理该孩子的临时目录
    try {
      fs.rmSync(childDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});
