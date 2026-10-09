/**
 * 公网认证代理：转发到 www.aixuexihao.top（暂接现有接口，格式与
 * electron/lib/auth-manager.ts 保持一致；benefit-auth 就绪后改基址）。
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export interface CloudAuthResult {
  token: string; // cloud token（仅服务端持有）
  parent_id: string;
}

export interface LicenseData {
  parent_id: string;
  email: string;
  plan: string;
  max_children: number;
  features: string;
  starts_at: string;
  expires_at: string;
  status: string;
  is_expired: boolean;
}

async function upstreamRequest(
  base: string,
  p: string,
  init?: RequestInit
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${base}${p}`, init);
  } catch {
    throw new ApiError(502, "无法连接公网认证服务，请稍后再试");
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object") {
        const b = body as { detail?: unknown };
        if (Array.isArray(b.detail)) {
          detail = String((b.detail[0] as { msg?: string })?.msg ?? detail);
        } else if (typeof b.detail === "string") {
          detail = b.detail;
        }
      }
    } catch {
      /* 保留默认 detail */
    }
    throw new ApiError(res.status, detail);
  }
  return res;
}

export async function upstreamLogin(
  base: string,
  email: string,
  password: string
): Promise<CloudAuthResult> {
  const res = await upstreamRequest(base, "/api/account/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { token: string; user_id: string; parent_id?: string; nickname?: string };
  // benefit-auth 返回映射后的 parent_id（旧 cloud 身份，保数据空间连续）；老形状回退 user_id
  return { token: body.token, parent_id: body.parent_id ?? body.user_id };
}

export async function upstreamRegister(
  base: string,
  email: string,
  password: string
): Promise<CloudAuthResult> {
  const res = await upstreamRequest(base, "/api/account/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { token: string; user_id: string; parent_id?: string; nickname?: string };
  return { token: body.token, parent_id: body.parent_id ?? body.user_id };
}

export async function upstreamLicense(
  base: string,
  cloudToken: string
): Promise<LicenseData> {
  const res = await upstreamRequest(base, "/api/account/license", {
    headers: { Authorization: `Bearer ${cloudToken}` },
  });
  return (await res.json()) as LicenseData;
}

// ==================== benefit-auth（权益认证中台）接入（2026-09-21） ====================

export interface DouyinLoginResult extends CloudAuthResult {
  email: string;
  benefit_user_id: string;
  is_new: boolean;
}

/**
 * 第一方免 secret 换码登录：IdP 授权码 → benefit 身份。
 * learning-server 装在用户机器上不能存 client_secret，换码由 benefit-auth
 * 服务端直接消费授权码（/api/account/douyin-code-login），本端纯转发。
 */
export async function upstreamDouyinCodeLogin(
  base: string,
  code: string,
  redirectUri: string
): Promise<DouyinLoginResult> {
  const res = await upstreamRequest(base, "/api/account/douyin-code-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });
  return (await res.json()) as DouyinLoginResult;
}

/** 第一方免 secret 换码重置密码：IdP 授权码确认身份后由云端直接改密，本端纯转发 */
export async function upstreamDouyinResetPassword(
  base: string,
  code: string,
  redirectUri: string,
  newPassword: string
): Promise<void> {
  await upstreamRequest(base, "/api/account/douyin-reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirect_uri: redirectUri, new_password: newPassword }),
  });
}

/** 家长账号状态（是否已设置密码；抖音家长首次为否） */
export async function upstreamParentStatus(
  base: string,
  cloudToken: string
): Promise<{ has_password: boolean; email: string }> {
  const res = await upstreamRequest(base, "/api/account/parent-status", {
    headers: { Authorization: `Bearer ${cloudToken}` },
  });
  return (await res.json()) as { has_password: boolean; email: string };
}

/** 设置家长密码（云端以 cloud token 鉴权） */
export async function upstreamSetPassword(
  base: string,
  cloudToken: string,
  newPassword: string
): Promise<void> {
  await upstreamRequest(base, "/api/account/set-password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cloudToken}` },
    body: JSON.stringify({ new_password: newPassword }),
  });
}
