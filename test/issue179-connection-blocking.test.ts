/**
 * ISSUE-179 回归：断连「阻断等待重连」（推翻 ISSUE-167 的离线兜底决策）。
 *
 * 1. F4 超时≠断连：serverFetch 捕获 TimeoutError/AbortError（服务端慢，长任务仍在跑）
 *    不得记断连账——阻断式 UX 下误判一次 = 全 app 阻断 30s；只有真网络错误
 *    （fetch failed / ECONNREFUSED）才翻转 connected=false 触发阻断。
 * 2. F2 阻断态渲染：ConnectionBlocking（双端共用组件）静态渲染含「等待重新链接」+「立即重试」，
 *    不含任何孩子入口（本地孩子永不出现）。
 * 3. F5 web shim 对齐：children 域 childList 失败不回退本地数据，返回 { children: [], degraded: true }。
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

import * as config from "../electron/lib/config";
import * as connState from "../electron/lib/connection-state";
import * as sc from "../electron/lib/server-client";
import React from "react";
import ReactDOMServer from "react-dom/server";
import ConnectionBlocking from "../src/components/ConnectionBlocking";

beforeAll(() => {
  config.setServerUrl("http://192.168.1.201:8788");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ISSUE-179 F4：超时≠断连（server-client 断连记账分类）", () => {
  it("AbortSignal 超时（TimeoutError）不记断连：connected 保持 true，报「响应超时」", async () => {
    connState.noteServerReachable(); // 基线：健康态
    vi.stubGlobal("fetch", async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    });
    await expect(sc.serverFetch("/agent/1/prompt", { method: "POST", body: {}, timeoutMs: 15000 })).rejects.toBeInstanceOf(
      sc.ServerError
    );
    const snap = connState.getConnectionSnapshot();
    expect(snap.connected).toBe(true); // 关键断言：不触发阻断
  });

  it("AbortError 同样不记断连（web shim AbortController 中止同源场景）", async () => {
    connState.noteServerReachable(); // 基线：健康态
    vi.stubGlobal("fetch", async () => {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      throw e;
    });
    await expect(sc.serverFetch("/health")).rejects.toBeInstanceOf(sc.ServerError);
    expect(connState.getConnectionSnapshot().connected).toBe(true);
  });

  it("真网络错误（fetch failed）才记断连：connected 翻 false（阻断触发）", async () => {
    connState.noteServerReachable();
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch failed");
    });
    await expect(sc.serverFetch("/children")).rejects.toBeInstanceOf(sc.ServerError);
    expect(connState.getConnectionSnapshot().connected).toBe(false);
  });
});

describe("ISSUE-179 F2：阻断态渲染（ConnectionBlocking 双端共用）", () => {
  it("渲染「等待重新链接 + 已等待 Ns + 立即重试」，不含任何孩子入口", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(ConnectionBlocking, {
        url: "http://192.168.1.201:8788",
        startedAt: Date.now() - 65_000,
        onRetry: () => {},
      })
    );
    expect(html).toContain("与服务端断开连接");
    expect(html).toContain("等待重新链接");
    expect(html).toContain("已等待");
    expect(html).toContain("立即重试");
    expect(html).toContain("192.168.1.201:8788");
    // 老三样回归：阻断层里不允许出现孩子列表/添加入口/本机数据字样
    expect(html).not.toContain("孩子列表");
    expect(html).not.toContain("添加孩子");
    expect(html).not.toContain("本机数据");
  });
});

describe("ISSUE-179 F5：web shim childList 不回退本地数据", () => {
  it("children 域 childList 失败 → { children: [], degraded: true }（恒不抛错）", async () => {
    const { childrenDomain } = await import("../web/src/shim/domains/children");
    const res = await childrenDomain.childList();
    expect(res.degraded).toBe(true);
    expect(res.children).toEqual([]);
  });
});
