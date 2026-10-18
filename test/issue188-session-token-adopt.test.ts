/**
 * ISSUE-188 回归（客户端半边）：`X-Session-Token` 采纳——续签后的新 JWT 写回 license.json。
 *
 * 为什么关键：`serverFetch` 收到响应头后必须落盘，否则下一次请求/SSE 重连用的还是旧 token
 * （滑动续签等于白做）；同时不能影响未登录状态（没有 license.json 时不写）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue188-"));
const licensePath = path.join(tmpDir, "license.json");

vi.mock("../electron/lib/config", () => ({
  getLicensePath: () => licensePath,
  getServerUrl: () => "http://test-server",
  getDataDir: () => tmpDir,
  getSharedDir: () => tmpDir,
  getParentConfigDir: () => tmpDir,
  setCurrentParentId: () => {},
}));

import { adoptSessionToken } from "../electron/lib/session-token-store";

function seed(token = "old-token"): void {
  fs.writeFileSync(
    licensePath,
    JSON.stringify(
      {
        parent_id: "p1",
        email: "u@test",
        plan: "basic",
        max_children: 4,
        features: "[]",
        starts_at: "2026-01-01T00:00:00Z",
        expires_at: "2099-01-01T00:00:00Z",
        status: "active",
        is_expired: false,
        token,
        cached_at: "2026-10-18T00:00:00Z",
      },
      null,
      2
    ),
    "utf-8"
  );
}

beforeEach(() => {
  try {
    fs.rmSync(licensePath);
  } catch {
    /* ignore */
  }
});

describe("ISSUE-188 adoptSessionToken", () => {
  it("有新 token → 写回 license.json，其余字段原样保留", () => {
    seed("old-token");
    expect(adoptSessionToken("new-token")).toBe(true);
    const lic = JSON.parse(fs.readFileSync(licensePath, "utf-8"));
    expect(lic.token).toBe("new-token");
    expect(lic.parent_id).toBe("p1");
    expect(lic.email).toBe("u@test");
    expect(lic.expires_at).toBe("2099-01-01T00:00:00Z");
  });

  it("同值 → 不写（幂等，避免无谓磁盘写）", () => {
    seed("same-token");
    expect(adoptSessionToken("same-token")).toBe(false);
    expect(JSON.parse(fs.readFileSync(licensePath, "utf-8")).token).toBe("same-token");
  });

  it("空 token / 未登录（无 license.json）→ 不写、不炸", () => {
    seed("old-token");
    expect(adoptSessionToken("")).toBe(false);
    expect(JSON.parse(fs.readFileSync(licensePath, "utf-8")).token).toBe("old-token");
    fs.rmSync(licensePath);
    expect(adoptSessionToken("new-token")).toBe(false);
    expect(fs.existsSync(licensePath)).toBe(false);
  });

  it("坏文件（非 JSON）→ 返回 false，不覆盖", () => {
    fs.writeFileSync(licensePath, "not-json", "utf-8");
    expect(adoptSessionToken("new-token")).toBe(false);
    expect(fs.readFileSync(licensePath, "utf-8")).toBe("not-json");
  });
});
