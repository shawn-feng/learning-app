/**
 * ISSUE-187 回归：SSE 句柄的「终态」判据（StreamHandle.closed）。
 *
 * 现场（2026-10-17，Mac 客户端 0.1.30 + 201 服务端）：
 * - 12:39 session JWT 到期（7 天 TTL，app 从 10-10 起一直开着）；
 * - 13:07 SSE 重连带过期 token → 服务端 401；
 * - 旧 openSse 在 401 时把自己置为终态（不重连、不报错），但 `StreamHandle` 只暴露 close()，
 *   ipc-handlers 的 ensure*Stream 只能看 `agentStreams.has(key)` ⇒ 死句柄永久占位；
 * - 用户 17:28 重新登录后（新 token），珊珊会话的 /prompt 全部 200、服务端正常落盘，
 *   客户端却一条事件都收不到 → 永远「等待模型返回…」；退出重进走 /open 拿历史 → 「消息又出来了」。
 *
 * 修复契约：401/403 或 close() 后 `handle.closed === true`，ipc-handlers 据此重建流。
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../electron/lib/auth-manager", () => ({ getCachedLicense: () => ({ token: "test-token" }) }));
vi.mock("../electron/lib/server-client", () => ({
  serverBase: () => "http://test",
  ServerError: class ServerError extends Error {},
  serverFetch: vi.fn(),
}));

import { streamChildAgent, streamParentAgent } from "../electron/lib/server-agent-client";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("ISSUE-187：SSE 流终态判据", () => {
  it("401 → onError 一次，且 handle.closed 变 true（死句柄可被上层识别并重建）", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    const onError = vi.fn();
    const onEvent = vi.fn();
    const h = streamChildAgent({ childId: "c1", onEvent, onError });
    expect(h.closed).toBe(false); // 建连后才置位（异步）
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]![0]).toContain("401");
    expect(h.closed).toBe(true);
    expect(onEvent).not.toHaveBeenCalled();
    h.close(); // 终态后 close 不炸
    expect(h.closed).toBe(true);
  });

  it("403（家长流）同样置终态", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    const onError = vi.fn();
    const h = streamParentAgent({ kind: "parent", onEvent: vi.fn(), onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(h.closed).toBe(true);
    h.close();
  });

  it("正常建连的流 closed=false；close() 后为 true（避免上层误判活句柄）", async () => {
    // 一个「建连成功但一直没数据」的 body：模拟真实长连接（读循环挂起）
    const pending = new Promise<never>(() => {});
    globalThis.fetch = vi.fn(async () => {
      const body = {
        getReader: () => ({ read: () => pending }),
      } as unknown as ReadableStream<Uint8Array>;
      return { ok: true, status: 200, body } as unknown as Response;
    }) as unknown as typeof fetch;
    const h = streamChildAgent({ childId: "c2", onEvent: vi.fn(), onError: vi.fn() });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(h.closed).toBe(false);
    h.close();
    expect(h.closed).toBe(true);
  });

  it("事件帧照常回调（id/event/data 解析），close() 后不再重连", async () => {
    const chunk = new TextEncoder().encode('id: 7\nevent: thinking_delta\ndata: {"delta":"想"}\n\n');
    let sent = false;
    globalThis.fetch = vi.fn(async () => {
      const body = {
        getReader: () => ({
          read: async () => {
            if (sent) return new Promise<never>(() => {});
            sent = true;
            return { value: chunk, done: false };
          },
        }),
      } as unknown as ReadableStream<Uint8Array>;
      return { ok: true, status: 200, body } as unknown as Response;
    }) as unknown as typeof fetch;
    const events: any[] = [];
    const h = streamChildAgent({ childId: "c3", onEvent: (e) => events.push(e) });
    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0]).toMatchObject({ id: 7, type: "thinking_delta", data: { delta: "想" } });
    h.close();
    expect(h.closed).toBe(true);
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });
});
