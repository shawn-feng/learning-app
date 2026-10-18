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

// ==================== 抖音扫码登录（网页版，与 App 客户端同一 IdP 链路） ====================
// Electron：本地回调端口 17888 收 code；Web：learning-server 托管在局域网多变的 host:port，
// 无法注册固定本地回调 → redirect_uri 指向云端桥页 /oauth/web-callback，由它把 code 交还：
//   popup（桌面主流）：postMessage 回本页，体验与 App 内授权窗口一致；
//   同 tab（弹窗被拦截/移动端）：整页跳转，桥页按 state 里的回跳 origin 带回 code，
//     回跳后由 main.tsx 的 handleDouyinAuthRedirect 在启动时完成换会话。
const CLOUD_BASE = "https://www.aixuexihao.top";
const BENEFIT_CLIENT_ID = "app_2cd2b7263372a407"; // 公开 AK（SK 只在云端 benefit-auth）
const WEB_CALLBACK = `${CLOUD_BASE}/oauth/web-callback`;
const DOUYIN_STATE_KEY = "web.douyinState";

function randomHex(len = 16): string {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** state = base64url(JSON {r: 随机数, ret: 回跳 origin})；IdP 原样回传，桥页/本页各自解析 */
function packState(ret: string): string {
  const json = JSON.stringify({ r: randomHex(8), ret });
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  bytes.forEach((x) => (bin += String.fromCharCode(x)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 授权码 → 会话 + license 并缓存（对齐 electron douyinLoginFlow 的服务端交互部分） */
export async function exchangeDouyinCode(
  code: string
): Promise<{ license: WebLicense; benefit_user_token: string }> {
  const data = await http<{
    session_token: string;
    license: LicenseData;
    email: string;
    benefit_user_token: string;
  }>("/auth/douyin", { method: "POST", body: { code, redirect_uri: WEB_CALLBACK } });
  const licenseResp = await http<{ license: LicenseData }>("/auth/license", {
    token: data.session_token,
  });
  const license: WebLicense = {
    ...licenseResp.license,
    email: data.email,
    token: data.session_token,
    cached_at: new Date().toISOString(),
  };
  saveLicense(license);
  return { license, benefit_user_token: data.benefit_user_token };
}

/**
 * 同 tab 回跳处理（main.tsx 启动时调用）：桥页带 #auth-code 回来 → 校验 state → 换会话缓存。
 * 成功/失败都清掉 hash 与暂存 state；失败静默（启动后仍停在登录页）。
 */
export async function handleDouyinAuthRedirect(): Promise<void> {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(hash);
  const code = params.get("auth-code");
  if (!code) return;
  const incoming = params.get("state") || "";
  const stored = localStorage.getItem(DOUYIN_STATE_KEY) || "";
  history.replaceState(null, "", window.location.pathname + window.location.search);
  localStorage.removeItem(DOUYIN_STATE_KEY);
  if (!stored || incoming !== stored) return; // state 不符（CSRF/过期）→ 丢弃
  try {
    await exchangeDouyinCode(code);
  } catch {
    /* 换码失败 → 停在登录页，用户可重试 */
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
   * ISSUE-160 重写（刷新即注销修复）：不再凭本地缓存的 expires_at 硬登出——本地缓存可能
   * 滞后于云端续期（服务端连不上公网时 /auth/license 返回的也是降级旧缓存），曾造成
   * 「登录成功 → 刷新即被踢回登录页」死循环。以服务端 /auth/license 为权威：
   *   200 → 用返回的 license 续本地缓存并放行；license.is_expired=true → 清凭证登出；
   *   401（session token 失效 / 云端判定授权失效）→ 清凭证回登录页；
   *   网络错误/服务端不可达 → 离线降级放行（不把已登录用户踢出）。
   */
  authCheck: async (): Promise<{
    authenticated: boolean;
    license: WebLicense | null;
    /** ISSUE-188：VIP 到期时「去完成任务」的个人中心地址（服务端拼好，免扫码） */
    me_url?: string;
  }> => {
    const license = getStoredLicense();
    if (!license) return { authenticated: false, license: null };

    try {
      const data = await http<{ license: LicenseData; me_url?: string }>("/auth/license", {
        token: license.token,
      });
      const fresh: WebLicense = {
        ...data.license,
        email: license.email,
        // ISSUE-188：server-fetch 可能已采纳滑动续签的新 token，优先用本地最新值
        token: getStoredLicense()?.token ?? license.token,
        cached_at: new Date().toISOString(),
      };
      if (fresh.is_expired) {
        // 待解锁（任务门禁 TaskGate 轮询）是预期状态：保留本地凭证，权益到手后
        // 下一轮轮询即可自动放行。不能清凭证——清了门禁页没有 token 可查，
        // 会永远卡在「等待检测中」（2026-10-08 实测 bug，与 electron auth-manager 同步修复）。
        saveLicense(fresh);
        return { authenticated: false, license: fresh, me_url: data.me_url };
      }
      saveLicense(fresh);
      return { authenticated: true, license: fresh, me_url: data.me_url };
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

  /**
   * authDouyinLogin: 抖音扫码登录（网页版）。
   * 返回形状与 Electron douyinLoginFlow 一致：{success, needs_task, license, email,
   * benefit_user_token, me_url, error?}。popup 主路径经 postMessage 收 code；
   * 弹窗被拦截时整页跳转授权页（同 tab 路径，回跳后由启动钩子完成登录，本 Promise 不再 resolve）。
   */
  authDouyinLogin: async (): Promise<{
    success: boolean;
    needs_task: boolean;
    license: WebLicense | null;
    email: string;
    benefit_user_token: string;
    me_url: string;
    error?: string;
  }> => {
    const state = packState(window.location.origin);
    localStorage.setItem(DOUYIN_STATE_KEY, state);
    const authorizeUrl =
      `${CLOUD_BASE}/oauth/authorize?client_id=${encodeURIComponent(BENEFIT_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(WEB_CALLBACK)}&response_type=code&state=${encodeURIComponent(state)}`;

    const popup = window.open(authorizeUrl, "douyin-auth", "width=500,height=700");
    if (!popup) {
      // 弹窗被拦截 → 同 tab 跳转；授权后桥页带 #auth-code 跳回，启动钩子完成登录
      window.location.href = authorizeUrl;
      return new Promise(() => {}); // 页面即将离开，永不 resolve
    }

    try {
      const { code, msgState } = await new Promise<{ code: string; msgState: string }>(
        (resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            window.removeEventListener("message", onMsg);
            clearInterval(closedIv);
            clearTimeout(timeout);
          };
          const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn();
          };
          const onMsg = (e: MessageEvent) => {
            if (e.origin !== CLOUD_BASE && e.origin !== "https://auth.aixuexihao.top") return;
            const d = e.data as { source?: string; code?: string; state?: string };
            if (!d || d.source !== "benefit-auth-oauth") return;
            finish(() => resolve({ code: String(d.code || ""), msgState: String(d.state || "") }));
          };
          // 用户手关弹窗且无消息 → 视为取消（留 800ms 余量等 postMessage 先到）
          const closedIv = setInterval(() => {
            if (popup.closed) {
              setTimeout(() => finish(() => reject(new Error("授权窗口已关闭，请重试"))), 800);
            }
          }, 400);
          const timeout = setTimeout(
            () => finish(() => reject(new Error("授权超时（5 分钟），请重试"))),
            5 * 60 * 1000
          );
          window.addEventListener("message", onMsg);
        }
      );
      if (!code) throw new Error("授权未返回授权码");
      if (msgState !== state) throw new Error("state 校验失败，请重试");
      const { license, benefit_user_token } = await exchangeDouyinCode(code);
      return {
        success: true,
        needs_task: license.is_expired === true,
        license,
        email: license.email,
        benefit_user_token,
        me_url: `${CLOUD_BASE}/me?token=${encodeURIComponent(benefit_user_token)}`,
      };
    } catch (err) {
      return {
        success: false,
        needs_task: false,
        license: null,
        email: "",
        benefit_user_token: "",
        me_url: "",
        error: (err as Error).message,
      };
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
