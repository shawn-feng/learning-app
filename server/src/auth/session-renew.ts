/**
 * 会话 JWT 滑动续签（2026-10-18，ISSUE-188）。
 *
 * 背景：session JWT 由 learning-server 自己签发（`signSession`，TTL = `tokenTtlDays`，默认 7 天），
 * 只在登录/注册/扫码/家长密码验证时签发一次。桌面 app 长期开着（实测 10-10 登录 → 10-17 到期）后：
 * 所有请求 401、孩子端 SSE 重连也被 401（ISSUE-187 的死句柄），用户被迫重新扫码。
 *
 * 方案（用户拍板「A 方案」）：**任意已鉴权的 `/api/v1/*` 请求**，若当前 token 剩余寿命
 * ≤ TTL 的一半，就顺手再签一枚（iat=now、exp=now+TTL），通过响应头 `X-Session-Token` 带回；
 * 客户端 `serverFetch` 统一采纳并写回 `license.json`。桌面端 config-sync 每 2 分钟一条请求，
 * 因此只要 app 在运行，token 就一直是新鲜的（约每 3.5 天换一次，不会每请求都换）。
 *
 * 边界：
 * - 只处理**会话 JWT**（Bearer / `?token=`）；开放 API 的 `laxk_` Key、无 token 的请求一律跳过；
 * - 无效/过期 token 不续签（交给各路由正常 401，客户端走重新登录）；
 * - 续签不改变身份（parent_id/email/plan 原样），也不涉及账号权益（那是 benefit-auth 的 license）。
 */
import type { FastifyInstance } from "fastify";
import { signSession, verifySession } from "./jwt.js";

/** 响应头名（客户端 `serverFetch` 按小写读取，HTTP 头大小写不敏感） */
export const SESSION_TOKEN_HEADER = "x-session-token";

export interface RenewOptions {
  secret: string;
  /** 与签发时一致的 TTL（天） */
  ttlDays: number;
  /** 测试注入口（默认 Date.now） */
  nowMs?: number;
}

/** 从请求头/查询串取会话 token（SSE 走 `?token=`，其余走 Authorization）。 */
export function extractSessionToken(
  headers: Record<string, string | string[] | undefined>,
  query: unknown
): string {
  const header = headers.authorization;
  let token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) {
    const q = (query ?? {}) as { token?: unknown };
    token = typeof q.token === "string" ? q.token.trim() : "";
  }
  return token;
}

/**
 * 需要续签则返回新 token，否则 null。纯函数（时间可注入，便于测试）。
 * 判据：剩余寿命 ≤ TTL/2（7 天 TTL → 剩余 ≤ 3.5 天时换一次）。
 */
export function renewIfNeeded(token: string, opts: RenewOptions): string | null {
  if (!token || token.startsWith("laxk_")) return null; // 开放 API Key 不是会话 JWT
  let payload;
  try {
    payload = verifySession(token, opts.secret);
  } catch {
    return null; // 过期/伪造：不续签，走各路由 401
  }
  const expMs = (payload.exp ?? 0) * 1000;
  if (!expMs) return null;
  const ttlMs = opts.ttlDays * 86_400_000;
  const now = opts.nowMs ?? Date.now();
  if (expMs - now > ttlMs / 2) return null; // 还够久，不打扰
  return signSession(
    { parent_id: payload.parent_id, email: payload.email, plan: payload.plan },
    opts.secret,
    opts.ttlDays
  );
}

/** 从 URL 查询串取 token（Fastify 的 `req.query` 在 onRequest 阶段可能尚未解析，故直接读 url）。 */
function tokenFromUrl(url: string): string {
  const i = url.indexOf("?");
  if (i < 0) return "";
  try {
    return new URLSearchParams(url.slice(i + 1)).get("token") || "";
  } catch {
    return "";
  }
}

/** 注册全局 onRequest 钩子：命中续签条件时把新 token 写进响应头。 */
export function registerSessionRenewHook(
  app: FastifyInstance,
  opts: Omit<RenewOptions, "nowMs">
): void {
  app.addHook("onRequest", async (req, reply) => {
    // 只覆盖 API（静态资源/health/version 也在这个前缀下，但无 token 自然跳过）
    if (!req.url.startsWith("/api/v1/")) return;
    const token =
      extractSessionToken(
        req.headers as Record<string, string | string[] | undefined>,
        req.query
      ) || tokenFromUrl(req.url);
    if (!token) return;
    const fresh = renewIfNeeded(token, opts);
    if (fresh) reply.header(SESSION_TOKEN_HEADER, fresh);
  });
}
