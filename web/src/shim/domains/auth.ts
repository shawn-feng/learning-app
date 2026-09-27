/**
 * auth 域（Phase 1 真实现）——移植 electron/lib/auth-manager.ts + ipc-handlers.ts 的 auth:* 通道：
 *   - authLogin/authRegister：POST /auth/login|register → GET /auth/license → 凭证入 localStorage
 *     （对齐 loginAndCache/registerAndCache：license = 云端数据 + email + token + cached_at）
 *   - authCheck：本地过期判断 + GET /auth/license 复核 + 云端不可达降级放行（auth-manager.ts:176-205）
 *   - authLogout：清凭证（对齐 clearCachedLicense，parentId 回 default）
 *   - authVerify：复用 login 语义仅校验（对齐 verifyParentPassword：ipc-handlers auth:verify）
 *   - getSessionParentId：读当前登录家长 id（对齐 session:get_parent_id）
 * 与 Electron 的差异仅是存储介质（data/license.json → localStorage），字段语义一致。
 */
import {
  http,
  WebServerError,
  getStoredLicense,
  saveLicense,
  clearStoredLicense,
  getStoredParentId,
  type WebLicense,
} from "../core/server-fetch";

type LicenseData = Omit<WebLicense, "token" | "cached_at">;

/** 登录/注册 + 拉取许可并缓存（对齐 loginAndCache / registerAndCache）。 */
async function loginAndCache(
  endpoint: "/auth/login" | "/auth/register",
  email: string,
  password: string
): Promise<WebLicense> {
  const data = await http<{ session_token: string; license: LicenseData }>(endpoint, {
    method: "POST",
    body: { email, password },
  });
  const token = data.session_token;
  const licenseResp = await http<{ license: LicenseData }>("/auth/license", { token });
  const license: WebLicense = {
    ...licenseResp.license,
    email,
    token,
    cached_at: new Date().toISOString(),
  };
  saveLicense(license);
  return license;
}

export const authDomain = {
  /** authLogin: (email: string, password: string) => Promise<{ success: boolean; license?: WebLicense; error?: string }> */
  authLogin: async (email: string, password: string) => {
    try {
      const license = await loginAndCache("/auth/login", email, password);
      return { success: true as const, license };
    } catch (err) {
      return { success: false as const, error: (err as Error).message };
    }
  },

  /** authRegister: (email: string, password: string) => Promise<{ success: boolean; license?: WebLicense; error?: string }> */
  authRegister: async (email: string, password: string) => {
    try {
      const license = await loginAndCache("/auth/register", email, password);
      return { success: true as const, license };
    } catch (err) {
      return { success: false as const, error: (err as Error).message };
    }
  },

  /**
   * authCheck: () => Promise<{ authenticated: boolean; license: WebLicense | null }>
   * ISSUE-160 重写（刷新即注销修复）：不再凭本地缓存的 expires_at 硬登出——本地缓存可能
   * 滞后于云端续期（服务端连不上公网时 /auth/license 返回的也是降级旧缓存），曾造成
   * 「登录成功 → 刷新即被踢回登录页」死循环。以服务端 /auth/license 为权威：
   *   200 → 用返回的 license 续本地缓存并放行；license.is_expired=true → 清凭证登出；
   *   401（session token 失效 / 云端判定授权失效）→ 清凭证回登录页；
   *   网络错误/服务端不可达 → 离线降级放行（不把已登录用户踢出）。
   */
  authCheck: async (): Promise<{ authenticated: boolean; license: WebLicense | null }> => {
    const license = getStoredLicense();
    if (!license) return { authenticated: false, license: null };

    try {
      const data = await http<{ license: LicenseData }>("/auth/license", { token: license.token });
      const fresh: WebLicense = {
        ...data.license,
        email: license.email,
        token: license.token,
        cached_at: new Date().toISOString(),
      };
      if (fresh.is_expired) {
        clearStoredLicense();
        return { authenticated: false, license: null };
      }
      saveLicense(fresh);
      return { authenticated: true, license: fresh };
    } catch (err) {
      if (err instanceof WebServerError && err.status === 401) {
        // session token 失效，或服务端能连上公网且公网判定授权失效 → 重新登录
        clearStoredLicense();
        return { authenticated: false, license: null };
      }
      // 网络错误 / 服务端不可达：离线降级，保留登录态
      return { authenticated: true, license };
    }
  },

  /** authLogout: () => Promise<{ success: boolean }>（清凭证 + parentId 回 default） */
  authLogout: async () => {
    clearStoredLicense();
    return { success: true as const };
  },

  /** authVerify: (email: string, password: string) => Promise<{ success: boolean; license?: WebLicense; error?: string }>（进入家长中心时验密，走登录链路刷新凭证） */
  authVerify: async (email: string, password: string) => {
    try {
      const license = await loginAndCache("/auth/login", email, password);
      return { success: true as const, license };
    } catch (err) {
      return { success: false as const, error: (err as Error).message };
    }
  },

  /** getSessionParentId: () => Promise<string>（当前登录家长 id，缺省 default） */
  getSessionParentId: async (): Promise<string> => {
    return getStoredParentId();
  },
};
