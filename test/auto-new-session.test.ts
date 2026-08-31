import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { getChildDir, getSchedulerConfigPath } from "../electron/lib/config";
import { getLastMessageTimestamp, shouldAutoNewSession } from "../electron/lib/pi-session";

const SESSIONS_SUB = path.join(".pi", "agent", "sessions");
const SCHEDULER_PATH = getSchedulerConfigPath();
let backup: string | null = null;

function writeSession(childId: string, entries: any[]): string {
  const dir = path.join(getChildDir(childId), SESSIONS_SUB);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "sess-test.jsonl");
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

function setAutoNewSessionConfig(childId: string, cfg: { enabled: boolean; hour: number; minute: number }) {
  let raw: any = {};
  if (fs.existsSync(SCHEDULER_PATH)) {
    try { raw = JSON.parse(fs.readFileSync(SCHEDULER_PATH, "utf-8")); } catch { raw = {}; }
  }
  raw.children = raw.children || {};
  raw.children[childId] = { autoNewSession: cfg };
  // 未登录时 parents/_guest 目录不建（getParentConfigDir 设计如此），写前先建父目录
  fs.mkdirSync(path.dirname(SCHEDULER_PATH), { recursive: true });
  fs.writeFileSync(SCHEDULER_PATH, JSON.stringify(raw));
}

function cleanup(childId: string) {
  const dir = getChildDir(childId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

const header = { type: "session", version: 1, id: "s", timestamp: "2026-01-01T00:00:00.000Z" };
function msg(role: string, ts: Date) {
  return { type: "message", id: `m-${Math.random()}`, parentId: "s", message: { role }, timestamp: ts.toISOString() };
}

beforeAll(() => {
  if (fs.existsSync(SCHEDULER_PATH)) backup = fs.readFileSync(SCHEDULER_PATH, "utf-8");
});
afterAll(() => {
  if (backup !== null) fs.writeFileSync(SCHEDULER_PATH, backup);
  else if (fs.existsSync(SCHEDULER_PATH)) fs.rmSync(SCHEDULER_PATH, { force: true });
});

describe("getLastMessageTimestamp", () => {
  it("无会话目录时返回 null", () => {
    const childId = `ts-none-${Date.now()}`;
    expect(getLastMessageTimestamp(childId)).toBeNull();
    cleanup(childId);
  });

  it("返回所有会话文件中最后一条消息的最大时间戳", () => {
    const childId = `ts-max-${Date.now()}`;
    const t1 = new Date(Date.now() - 2 * 3600 * 1000);
    const t2 = new Date(Date.now() - 1 * 3600 * 1000);
    writeSession(childId, [header, msg("user", t1), msg("assistant", t2)]);
    const ts = getLastMessageTimestamp(childId);
    expect(ts).not.toBeNull();
    expect(Math.abs((ts as number) - t2.getTime())).toBeLessThan(2000);
    cleanup(childId);
  });
});

describe("shouldAutoNewSession", () => {
  it("开关关闭时始终返回 false", () => {
    const childId = `ans-off-${Date.now()}`;
    const t = new Date(Date.now() - 24 * 3600 * 1000); // 昨天
    writeSession(childId, [header, msg("user", t)]);
    setAutoNewSessionConfig(childId, { enabled: false, hour: 0, minute: 0 });
    expect(shouldAutoNewSession(childId)).toBe(false);
    cleanup(childId);
  });

  it("无历史消息时返回 false（不强行开新）", () => {
    const childId = `ans-empty-${Date.now()}`;
    setAutoNewSessionConfig(childId, { enabled: true, hour: 0, minute: 0 });
    expect(shouldAutoNewSession(childId)).toBe(false);
    cleanup(childId);
  });

  it("行为1：最后一条消息不是今天 → true（跨天自动开新）", () => {
    const childId = `ans-stale-${Date.now()}`;
    const t = new Date(Date.now() - 26 * 3600 * 1000); // 26 小时前（昨天）
    writeSession(childId, [header, msg("user", t)]);
    setAutoNewSessionConfig(childId, { enabled: true, hour: 0, minute: 0 });
    expect(shouldAutoNewSession(childId)).toBe(true);
    cleanup(childId);
  });

  it("今天、尚未到设定时间节点、最后消息在节点前 → false（当天对话保留到节点）", () => {
    const childId = `ans-before-${Date.now()}`;
    const now = new Date();
    // 设定节点为「1 小时后」，最后消息为 2 小时前（今天，节点前），但当前未到节点
    const hour = (now.getHours() + 1) % 24;
    const last = new Date(Date.now() - 2 * 3600 * 1000);
    writeSession(childId, [header, msg("user", last)]);
    setAutoNewSessionConfig(childId, { enabled: true, hour, minute: now.getMinutes() });
    expect(shouldAutoNewSession(childId)).toBe(false);
    cleanup(childId);
  });

  it("行为2：今天、已过设定时间节点、最后消息在节点前 → true（定点开新）", () => {
    const childId = `ans-after-${Date.now()}`;
    const now = new Date();
    // 设定节点为「1 小时前」，最后消息为「2 小时前」（节点前），当前已过节点
    const pastHour = (now.getHours() + 23) % 24; // 等价于 now-1h 的小时
    const last = new Date(Date.now() - 2 * 3600 * 1000);
    writeSession(childId, [header, msg("user", last)]);
    setAutoNewSessionConfig(childId, { enabled: true, hour: pastHour, minute: now.getMinutes() });
    expect(shouldAutoNewSession(childId)).toBe(true);
    cleanup(childId);
  });

  it("行为2 边界：今天、已过节点、但最后消息在节点之后（已聊过）→ false", () => {
    const childId = `ans-after2-${Date.now()}`;
    const now = new Date();
    const pastHour = (now.getHours() + 23) % 24; // now-1h
    const last = new Date(Date.now() - 0.5 * 3600 * 1000); // 半小时前（节点之后）
    writeSession(childId, [header, msg("user", last)]);
    setAutoNewSessionConfig(childId, { enabled: true, hour: pastHour, minute: now.getMinutes() });
    expect(shouldAutoNewSession(childId)).toBe(false);
    cleanup(childId);
  });
});
