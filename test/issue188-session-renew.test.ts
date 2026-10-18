/**
 * ISSUE-188 回归：会话 JWT 滑动续签（服务端半边）+ me_url 拼装。
 *
 * 背景：JWT 固定 7 天、只在登录时签发 → 桌面 app 长开 7 天后所有请求 401、SSE 也被 401
 * （ISSUE-187），用户被迫重新扫码。方案 A：任意已鉴权的 `/api/v1/*` 请求在
 * 「剩余寿命 ≤ TTL/2」时回签新 JWT，经 `X-Session-Token` 响应头下发，客户端采纳写回 license.json。
 */
import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "../server/src/auth/jwt";
import {
  extractSessionToken,
  registerSessionRenewHook,
  renewIfNeeded,
  SESSION_TOKEN_HEADER,
} from "../server/src/auth/session-renew";
import { buildMeUrl } from "../server/src/auth/me-url";

const SECRET = "test-secret";
const TTL_DAYS = 7;
const PAYLOAD = { parent_id: "p1", email: "u@test", plan: "basic" };

describe("ISSUE-188 renewIfNeeded（续签判据）", () => {
  it("剩余寿命 > TTL/2 → 不续签", () => {
    const token = signSession(PAYLOAD, SECRET, TTL_DAYS); // 刚签发，剩余 7 天
    expect(renewIfNeeded(token, { secret: SECRET, ttlDays: TTL_DAYS })).toBeNull();
  });

  it("剩余寿命 ≤ TTL/2 → 回签，身份原样、TTL 重置为完整 7 天", () => {
    // 用短 TTL 令牌模拟"快到期"（14.4 分钟）；真实场景是登录 4 天后剩 3 天
    const token = signSession(PAYLOAD, SECRET, 0.01);
    const fresh = renewIfNeeded(token, { secret: SECRET, ttlDays: TTL_DAYS });
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(token);
    const p = verifySession(fresh as string, SECRET);
    expect(p.parent_id).toBe("p1");
    expect(p.email).toBe("u@test");
    expect(p.plan).toBe("basic");
    // 新 token 的有效期 ≈ 7 天（从"现在"重算）
    const days = ((p.exp as number) * 1000 - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("伪造/过期 token 不续签（交给路由 401）", () => {
    expect(renewIfNeeded("not-a-jwt", { secret: SECRET, ttlDays: TTL_DAYS })).toBeNull();
    const expiredTtl = signSession(PAYLOAD, SECRET, -1); // 已过期
    expect(renewIfNeeded(expiredTtl, { secret: SECRET, ttlDays: TTL_DAYS })).toBeNull();
    // 另一个 secret 签的也不行
    const other = signSession(PAYLOAD, "other-secret", TTL_DAYS);
    expect(renewIfNeeded(other, { secret: SECRET, ttlDays: TTL_DAYS })).toBeNull();
  });

  it("开放 API Key（laxk_）不是会话 JWT，跳过", () => {
    expect(renewIfNeeded("laxk_abc", { secret: SECRET, ttlDays: TTL_DAYS })).toBeNull();
  });
});

describe("ISSUE-188 extractSessionToken / 全局钩子", () => {
  it("支持 Authorization: Bearer 与 SSE 的 ?token=", () => {
    expect(extractSessionToken({ authorization: "Bearer abc" }, {})).toBe("abc");
    expect(extractSessionToken({}, { token: "xyz" })).toBe("xyz");
    expect(extractSessionToken({}, {})).toBe("");
  });

  function makeHook() {
    const hooks: Array<(req: any, reply: any) => Promise<void>> = [];
    const fakeApp = { addHook: (_n: string, fn: any) => hooks.push(fn) } as any;
    registerSessionRenewHook(fakeApp, { secret: SECRET, ttlDays: TTL_DAYS });
    return hooks[0]!;
  }

  async function runHook(
    hook: (req: any, reply: any) => Promise<void>,
    req: any
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    await hook(req, { header: (k: string, v: string) => ((headers[k] = v), undefined) });
    return headers;
  }

  it("近到期（剩 ≤3.5 天）的 /api/v1 请求 → 带 X-Session-Token", async () => {
    const hook = makeHook();
    const nearExpiry = signSession(PAYLOAD, SECRET, 0.01); // 14.4 分钟
    const headers = await runHook(hook, {
      url: "/api/v1/config/revision",
      headers: { authorization: `Bearer ${nearExpiry}` },
      query: {},
    });
    const fresh = headers[SESSION_TOKEN_HEADER];
    expect(fresh).toBeTruthy();
    expect(verifySession(fresh!, SECRET).parent_id).toBe("p1");
  });

  it("新鲜 token → 不带续签头（不会每请求都换）", async () => {
    const hook = makeHook();
    const fresh = signSession(PAYLOAD, SECRET, TTL_DAYS);
    const headers = await runHook(hook, {
      url: "/api/v1/config/revision",
      headers: { authorization: `Bearer ${fresh}` },
      query: {},
    });
    expect(headers[SESSION_TOKEN_HEADER]).toBeUndefined();
  });

  it("非 /api/v1 路径、无 token、laxk_ Key → 一律不写头", async () => {
    const hook = makeHook();
    const near = signSession(PAYLOAD, SECRET, 0.01);
    expect(
      await runHook(hook, { url: "/health", headers: { authorization: `Bearer ${near}` }, query: {} })
    ).toEqual({});
    expect(await runHook(hook, { url: "/api/v1/version", headers: {}, query: {} })).toEqual({});
    expect(
      await runHook(hook, {
        url: "/api/v1/open/agent/status",
        headers: { authorization: "Bearer laxk_abc" },
        query: {},
      })
    ).toEqual({});
  });

  it("SSE 走 ?token= 时同样可续签（客户端下一次重连自动用新 token）", async () => {
    const hook = makeHook();
    const near = signSession(PAYLOAD, SECRET, 0.01);
    // Fastify 的 onRequest 阶段 req.query 可能尚未解析：直接放在 url 上也必须能取到
    const headers = await runHook(hook, {
      url: `/api/v1/agent/c1/stream?caps=material-panel&token=${encodeURIComponent(near)}`,
      headers: {},
      query: undefined,
    });
    expect(headers[SESSION_TOKEN_HEADER]).toBeTruthy();
    expect(verifySession(headers[SESSION_TOKEN_HEADER]!, SECRET).parent_id).toBe("p1");
  });
});

describe("ISSUE-188 buildMeUrl（VIP 到期去完成任务，免扫码）", () => {
  it("有 benefit 用户 token → 带 token 的 /me（页面免登录）", () => {
    expect(buildMeUrl("https://auth.test/", "tok/en+1")).toBe("https://auth.test/me?token=tok%2Fen%2B1");
  });
  it("无 token（老邮箱账号）→ 裸 /me", () => {
    expect(buildMeUrl("https://auth.test", "")).toBe("https://auth.test/me");
    expect(buildMeUrl("https://auth.test", null)).toBe("https://auth.test/me");
  });
});
