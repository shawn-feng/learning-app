/**
 * ISSUE-160 回归：登录态持久化——刷新/重启不再因本地陈旧 expires_at 被踢出。
 *
 * 根因：checkAuth 原先在云端复核**之前**就按本地缓存的 expires_at 硬登出；服务端连不上
 * 公网时 /auth/license 返回的也是降级旧缓存（expires_at 停在旧续期日），造成
 * 「登录成功 → 刷新/重启即被踢回登录页」死循环。修复后以服务端 /auth/license 为权威：
 * 200 → 续缓存放行；401 → 清凭证；网络错误 → 离线降级放行。
 * （web shim authCheck 同语义同批修改，electron 侧可测故以它为准做回归。）
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue160-"));
const licensePath = path.join(tmpDir, "license.json");

vi.mock("../electron/lib/config", () => ({
  getServerUrl: () => "http://test-server",
  getLicensePath: () => licensePath,
  getDataDir: () => tmpDir,
  getSharedDir: () => tmpDir,
  getParentConfigDir: () => tmpDir,
  setCurrentParentId: () => {},
}));
vi.mock("../electron/lib/server-client", () => ({
  serverBase: "http://test-server",
  ServerError: class ServerError extends Error {
    status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.status = status;
    }
  },
  serverFetch: vi.fn(),
}));
import { serverFetch, ServerError } from "../electron/lib/server-client";
import { checkAuth, cacheLicense, getCachedLicense } from "../electron/lib/auth-manager";

const fetchMock = serverFetch as unknown as ReturnType<typeof vi.fn>;

function seedLicense(overrides: Record<string, unknown> = {}): void {
  cacheLicense({
    parent_id: "p1",
    email: "u@test",
    plan: "basic",
    max_children: 4,
    features: "[]",
    starts_at: "2026-08-25T00:00:00Z",
    expires_at: "2026-09-24T00:00:00Z", // 已过去（现势 09-27）——本地缓存陈旧场景
    status: "active",
    is_expired: false,
    token: "stale-or-valid-token",
    cached_at: "2026-09-20T00:00:00Z",
    ...overrides,
  } as any);
}

beforeEach(() => {
  fetchMock.mockReset();
  try {
    fs.rmSync(licensePath);
  } catch {
    /* 忽略 */
  }
});

describe("ISSUE-160 checkAuth 登录态持久化", () => {
  it("回归主案：本地 expires_at 已过期但服务端 200 → 放行并用服务端 license 续缓存", async () => {
    seedLicense();
    fetchMock.mockResolvedValue({
      license: { parent_id: "p1", plan: "basic", max_children: 4, features: "[]", starts_at: "2026-08-25T00:00:00Z", expires_at: "2026-09-24T00:00:00Z", status: "active", is_expired: false },
    });
    const r = await checkAuth();
    expect(r.authenticated).toBe(true);
    expect(r.license?.email).toBe("u@test"); // 本地 email 保留
    // 续缓存：cached_at 被服务端响应刷新
    expect(new Date(getCachedLicense()!.cached_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("服务端 401（token 失效/云端判定失效）→ 清凭证回登录页", async () => {
    seedLicense();
    fetchMock.mockRejectedValue(new ServerError("session 无效", 401));
    const r = await checkAuth();
    expect(r.authenticated).toBe(false);
    expect(getCachedLicense()).toBeNull();
  });

  it("网络错误 → 离线降级放行（保留登录态与缓存）", async () => {
    seedLicense();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const r = await checkAuth();
    expect(r.authenticated).toBe(true);
    expect(getCachedLicense()).not.toBeNull();
  });

  it("服务端 200 但 is_expired=true → 清凭证登出", async () => {
    seedLicense();
    fetchMock.mockResolvedValue({
      license: { parent_id: "p1", plan: "basic", max_children: 4, features: "[]", starts_at: "2026-08-25T00:00:00Z", expires_at: "2026-09-24T00:00:00Z", status: "expired", is_expired: true },
    });
    const r = await checkAuth();
    expect(r.authenticated).toBe(false);
    expect(getCachedLicense()).toBeNull();
  });
});
