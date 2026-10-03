/**
 * ISSUE-167 回归：失联降级可见化的状态记账与上云守卫。
 *
 * 1. 连接状态记账：任意 HTTP 响应=可达、网络抛错=断连（serverFetch 真身记账，此处直调
 *    connection-state 模拟等价翻转）；未配置服务端地址不记断连（纯本地模式无横幅）。
 * 2. recentlyDegraded：断连窗口内 true，窗口外（>10min）false——「刚恢复不自动上云」守卫。
 * 3. listChildren 降级回退：服务端不可达 → 静默回退本地扫描（设计保留，可见化在横幅层）。
 * 4. 自动上云 PATCH 守卫：刚断连恢复（10 分钟内）本地无密码孩子【不】自动 PATCH 上云；
 *    窗口外恢复常规同步；成功拉取后 lastServerChildCount 记账。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

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
    dialog: {},
  };
});

// server-client mock：行为由用例注入（mocks.impl），并记录调用供断言
const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method?: string }>,
  impl: null as null | ((path: string, opts?: any) => Promise<any>),
}));

vi.mock("../electron/lib/server-client", () => {
  class ServerError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ServerError,
    serverFetch: (path: string, opts?: any) => {
      mocks.calls.push({ path, method: opts?.method });
      if (!mocks.impl) throw new Error("serverFetchImpl 未注入");
      return mocks.impl(path, opts);
    },
  };
});

import fs from "node:fs";
import path from "node:path";
import * as config from "../electron/lib/config";
import * as connState from "../electron/lib/connection-state";
import * as childAuth from "../electron/lib/child-auth";
import * as userInit from "../electron/lib/user-init";
import * as authManager from "../electron/lib/auth-manager";

const SERVER_201 = "http://192.168.1.201:8788";
let localChildId = "";

function seedLocalChild(id: string, withPassword: boolean): void {
  const profile = {
    childId: id,
    name: "本地孩子",
    avatar: "🦊",
    passwordHash: withPassword ? "hash-xxx" : "",
    age: 8,
    grade: "二年级",
    interests: "",
    aiName: "知识狐",
    aiEmoji: "🦊",
    aiPersonality: "温和",
    createdAt: new Date().toISOString(),
  };
  const dir = path.join(config.getChildrenDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(profile, null, 2), "utf-8");
}

beforeAll(async () => {
  // 清空测试数据目录（PI_TEST_DATA_DIR 在系统 tmp；与 app.test.ts 同口径，串行执行互不影响）
  const dir = process.env.PI_TEST_DATA_DIR;
  if (dir && fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不阻塞 */
    }
  }
  config.setServerUrl(SERVER_201);
  seedLocalChild("local-child-1", true);
  localChildId = "local-child-1";
  // 登录态（currentSessionToken 从缓存 license 读）：mock 云端两跳
  mocks.impl = (p) => {
    if (p === "/auth/login") {
      return Promise.resolve({
        session_token: "tok-167",
        license: { parent_id: "parent-167", plan: "family", max_children: 10, status: "active" },
      });
    }
    if (p === "/auth/license") {
      return Promise.resolve({
        license: { parent_id: "parent-167", plan: "family", max_children: 10, status: "active" },
      });
    }
    throw new Error("unexpected serverFetch: " + p);
  };
  await authManager.loginAndCache("p167@test.com", "pass123");
});

afterEach(() => {
  vi.useRealTimers();
  mocks.calls.length = 0;
});

describe("ISSUE-167 连接状态记账", () => {
  it("断连/可达翻转并通知监听者（只在翻转时通知）；url 如实回显", () => {
    const flips: boolean[] = [];
    const off = connState.onConnectionChange((s) => flips.push(s.connected));

    connState.noteServerUnreachable();
    let snap = connState.getConnectionSnapshot();
    expect(snap.connected).toBe(false);
    expect(snap.lastErrorAt).toBeTruthy();

    connState.noteServerReachable();
    snap = connState.getConnectionSnapshot();
    expect(snap.connected).toBe(true);
    expect(snap.recoveredAt).toBeTruthy();
    expect(snap.url).toBe(SERVER_201);
    expect(flips).toEqual([false, true]); // 只在翻转时通知

    off();
  });

  it("recentlyDegraded：断连窗口内 true、窗口外 false（fake timers 推进时钟）", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-28T10:00:00Z") });
    connState.noteServerUnreachable();
    expect(connState.recentlyDegraded(10 * 60_000)).toBe(true);

    connState.noteServerReachable(); // 立即恢复：recoveredAt=T0
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(connState.recentlyDegraded(10 * 60_000)).toBe(false);
  });
});

describe("ISSUE-167 listChildren 降级与上云守卫", () => {
  it("服务端不可达 → 静默回退本地扫描（离线可用设计保留）", async () => {
    mocks.impl = () => Promise.reject(new Error("网络不可达"));
    const list = await childAuth.listChildren();
    expect(list.some((c) => c.childId === localChildId)).toBe(true);
  });

  it("刚断连恢复（10min 内）不自动上云；窗口外恢复常规同步；孩子数记账", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-28T11:00:00Z") });
    // 本地无密码孩子 + 服务端有账户无详情 → 命中「本地有→自动 PATCH」分支
    seedLocalChild("nopw-child-1", false);
    mocks.impl = (p, opts) => {
      if (p === "/children" && (!opts?.method || opts.method === "GET")) {
        return Promise.resolve({ children: [{ id: "nopw-child-1", name: "本地孩子" }] });
      }
      if (p === "/children/nopw-child-1" && opts?.method === "PATCH") {
        return Promise.resolve({ ok: true });
      }
      throw new Error("unexpected serverFetch: " + p);
    };

    // 模拟一次断连后立即恢复（serverFetch 真身在失败/成功时会做的记账）
    connState.noteServerUnreachable();
    connState.noteServerReachable();
    await childAuth.listChildren();
    const patchDuringGrace = mocks.calls.filter((c) => c.method === "PATCH");
    expect(patchDuringGrace).toHaveLength(0); // 守卫生效：刚恢复不自动上云

    // 窗口外（>10min）：常规同步恢复
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await childAuth.listChildren();
    expect(mocks.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);

    // 成功从服务端拉取 → 数量记账（横幅「服务器上次同步 N 个孩子」数据源）
    expect(connState.getConnectionSnapshot().lastServerChildCount).toBe(1);
  });
});
