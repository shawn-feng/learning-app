import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import {
  ApiError,
  upstreamLicense,
  upstreamLogin,
  upstreamRegister,
  upstreamDouyinCodeLogin,
  upstreamDouyinResetPassword,
  upstreamParentStatus,
  upstreamSetPassword,
  type LicenseData,
} from "../auth/proxy.js";
import { signSession, verifySession } from "../auth/jwt.js";

interface AuthDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

function bearerToken(authHeader: string | undefined): string {
  return authHeader?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

interface LoginBody {
  email?: string;
  password?: string;
}

/** 登录/注册公共流程：公网认证 → license → upsert parents → 签 session */
async function authenticate(
  deps: AuthDeps,
  email: string,
  password: string,
  mode: "login" | "register"
): Promise<{ session_token: string; license: Omit<LicenseData, never> }> {
  const cloud =
    mode === "login"
      ? await upstreamLogin(deps.config.upstreamBase, email, password)
      : await upstreamRegister(deps.config.upstreamBase, email, password);
  const license = await upstreamLicense(deps.config.upstreamBase, cloud.token);

  const now = new Date().toISOString();
  deps.db
    .prepare(
      `INSERT INTO parents (id, email, plan, cloud_token, license_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         plan = excluded.plan,
         cloud_token = excluded.cloud_token,
         license_json = excluded.license_json,
         updated_at = excluded.updated_at`
    )
    .run(
      cloud.parent_id,
      email,
      license.plan ?? "",
      cloud.token,
      JSON.stringify(license),
      now,
      now
    );

  const session_token = signSession(
    { parent_id: cloud.parent_id, email, plan: license.plan ?? "" },
    deps.config.jwtSecret,
    deps.config.tokenTtlDays
  );
  // cloud token 只存服务端，不下发客户端
  return { session_token, license };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  app.post("/api/v1/auth/login", async (req, reply) => {
    const { email, password } = (req.body ?? {}) as LoginBody;
    if (!email || !password) {
      return reply.code(400).send({ error: "email 和 password 必填" });
    }
    try {
      return await authenticate(deps, email, password, "login");
    } catch (err) {
      if (err instanceof ApiError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post("/api/v1/auth/register", async (req, reply) => {
    const { email, password } = (req.body ?? {}) as LoginBody;
    if (!email || !password) {
      return reply.code(400).send({ error: "email 和 password 必填" });
    }
    try {
      return await authenticate(deps, email, password, "register");
    } catch (err) {
      if (err instanceof ApiError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });

  // 抖音扫码登录（benefit-auth IdP）：客户端本地回调拿到 code 后调这里。
  // 本端纯转发：code → 云端 /api/account/douyin-code-login 换身份（服务端不持
  // client_secret——本服务装在用户机器上）→ license → 签会话。
  // 抖音家长的初始订阅即时过期（待解锁）：完成任务获得权益后，云端在 /api/license
  // 查询时自动延长有效期（sync_benefit_entitlements），客户端轮询即自动放行。
  app.post("/api/v1/auth/douyin", async (req, reply) => {
    const { code, redirect_uri } = (req.body ?? {}) as { code?: string; redirect_uri?: string };
    if (!code || !redirect_uri) {
      return reply.code(400).send({ error: "code 和 redirect_uri 必填" });
    }
    try {
      const cloud = await upstreamDouyinCodeLogin(deps.config.upstreamBase, code, redirect_uri);
      const license = await upstreamLicense(deps.config.upstreamBase, cloud.token);

      const now = new Date().toISOString();
      deps.db
        .prepare(
          `INSERT INTO parents (id, email, plan, cloud_token, license_json, benefit_user_id, benefit_user_token, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             email = excluded.email,
             plan = excluded.plan,
             cloud_token = excluded.cloud_token,
             license_json = excluded.license_json,
             benefit_user_id = excluded.benefit_user_id,
             benefit_user_token = excluded.benefit_user_token,
             updated_at = excluded.updated_at`
        )
        .run(
          cloud.parent_id,
          cloud.email,
          license.plan ?? "",
          cloud.token,
          JSON.stringify(license),
          cloud.benefit_user_id,
          cloud.token,
          now,
          now
        );

      const session_token = signSession(
        { parent_id: cloud.parent_id, email: cloud.email, plan: license.plan ?? "" },
        deps.config.jwtSecret,
        deps.config.tokenTtlDays
      );
      return {
        session_token,
        license,
        email: cloud.email,
        is_new: cloud.is_new,
        benefit_user_token: cloud.token,
      };
    } catch (err) {
      if (err instanceof ApiError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });

  // 家长账号状态（是否已设密码）：抖音家长首次进家长中心时客户端据此走「设置密码」而非「验证密码」
  app.get("/api/v1/auth/parent-status", async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      return reply.code(401).send({ error: "缺少 session token" });
    }
    let payload;
    try {
      payload = verifySession(token, deps.config.jwtSecret);
    } catch {
      return reply.code(401).send({ error: "session 无效或已过期，请重新登录" });
    }
    const row = deps.db
      .prepare("SELECT cloud_token FROM parents WHERE id = ?")
      .get(payload.parent_id) as { cloud_token: string } | undefined;
    if (!row) {
      return reply.code(401).send({ error: "家长不存在，请重新登录" });
    }
    try {
      return await upstreamParentStatus(deps.config.upstreamBase, row.cloud_token);
    } catch (err) {
      if (err instanceof ApiError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });

  // 设置家长密码（抖音家长首次进家长中心；凭证为 LAN session，云端以 cloud token 落账）
  app.post("/api/v1/auth/set-password", async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    const { password } = (req.body ?? {}) as { password?: string };
    if (!token || !password) {
      return reply.code(400).send({ error: "session token 与 password 必填" });
    }
    let payload;
    try {
      payload = verifySession(token, deps.config.jwtSecret);
    } catch {
      return reply.code(401).send({ error: "session 无效或已过期，请重新登录" });
    }
    const row = deps.db
      .prepare("SELECT cloud_token FROM parents WHERE id = ?")
      .get(payload.parent_id) as { cloud_token: string } | undefined;
    if (!row) {
      return reply.code(401).send({ error: "家长不存在，请重新登录" });
    }
    try {
      await upstreamSetPassword(deps.config.upstreamBase, row.cloud_token, password);
      return { success: true };
    } catch (err) {
      if (err instanceof ApiError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });

  // 忘记家长中心密码：抖音重新扫码确认身份后重置（无需旧密码）。
  // 本端纯转发：code 由云端 benefit-auth 直接消费并改密（服务端不持 client_secret）。
  app.post("/api/v1/auth/douyin-reset-password", async (req, reply) => {
    const { code, redirect_uri, new_password } = (req.body ?? {}) as {
      code?: string;
      redirect_uri?: string;
      new_password?: string;
    };
    if (!code || !redirect_uri || !new_password) {
      return reply.code(400).send({ error: "code、redirect_uri、new_password 必填" });
    }
    if (new_password.length < 8 || new_password.length > 128) {
      return reply.code(400).send({ error: "密码需为 8-128 位" });
    }
    try {
      await upstreamDouyinResetPassword(deps.config.upstreamBase, code, redirect_uri, new_password);
      return { success: true };
    } catch (err) {
      if (err instanceof ApiError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get("/api/v1/auth/license", async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      return reply.code(401).send({ error: "缺少 session token" });
    }
    let payload;
    try {
      payload = verifySession(token, deps.config.jwtSecret);
    } catch {
      return reply.code(401).send({ error: "session 无效或已过期，请重新登录" });
    }

    const row = deps.db
      .prepare("SELECT cloud_token, license_json FROM parents WHERE id = ?")
      .get(payload.parent_id) as { cloud_token: string; license_json: string } | undefined;
    if (!row) {
      return reply.code(401).send({ error: "家长不存在，请重新登录" });
    }

    // 尝试向公网刷新授权；401 = 公网判定失效 → 强制重登；网络错误 → 用本地缓存降级
    try {
      const license: LicenseData = await upstreamLicense(
        deps.config.upstreamBase,
        row.cloud_token
      );
      deps.db
        .prepare("UPDATE parents SET license_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(license), new Date().toISOString(), payload.parent_id);
      return { license };
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          return reply.code(401).send({ error: "授权已失效，请重新登录" });
        }
        const cached = row.license_json ? (JSON.parse(row.license_json) as LicenseData) : null;
        if (cached) return { license: cached, degraded: true };
      }
      return reply.code(502).send({ error: "公网认证服务不可达且无本地缓存" });
    }
  });
}
