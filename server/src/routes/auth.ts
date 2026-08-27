import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import {
  ApiError,
  upstreamLicense,
  upstreamLogin,
  upstreamRegister,
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
