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

/** 云端复核（对齐 verifyLicenseWithCloud）：401 → 无效；网络错误 → null（降级）。 */
async function verifyLicenseWithCloud(
  token: string
): Promise<{ valid: boolean; max_children: number } | null> {
  try {
    const data = await http<{ license: WebLicense }>("/auth/license", { token });
    return {
      valid: data.license.is_expired !== true,
      max_children: typeof data.license.max_children === "number" ? data.license.max_children : 0,
    };
  } catch (err) {
    if (err instanceof WebServerError && err.status === 401) {
      return { valid: false, max_children: 0 };
    }
    return null; // 网络错误 / 服务端不可达 → 由调用方降级
  }
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
   * 对齐 checkAuth（auth-manager.ts:176-205）：
   * 无凭证 → 未登录；本地过期 → 清凭证未登录；本地有效 → 云端复核，
   * 云端明确无效 → 强制登出，云端不可达 → 降级放行（信任本地）。
   * 差异：Web 无「未配置服务端地址」分支（同源是合法默认，dev 经 Vite proxy）。
   */
  authCheck: async (): Promise<{ authenticated: boolean; license: WebLicense | null }> => {
    const license = getStoredLicense();
    if (!license) return { authenticated: false, license: null };

    const expired =
      license.is_expired ||
      (license.expires_at && new Date(license.expires_at).getTime() < Date.now());
    if (expired) {
      clearStoredLicense();
      return { authenticated: false, license: null };
    }

    const cloud = await verifyLicenseWithCloud(license.token);
    if (cloud !== null && !cloud.valid) {
      clearStoredLicense();
      return { authenticated: false, license: null };
    }
    // cloud === null：云端连不上，离线降级放行

    return { authenticated: true, license };
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
