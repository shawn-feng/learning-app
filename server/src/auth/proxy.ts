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
  const res = await upstreamRequest(base, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return (await res.json()) as CloudAuthResult;
}

export async function upstreamRegister(
  base: string,
  email: string,
  password: string
): Promise<CloudAuthResult> {
  const res = await upstreamRequest(base, "/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return (await res.json()) as CloudAuthResult;
}

export async function upstreamLicense(
  base: string,
  cloudToken: string
): Promise<LicenseData> {
  const res = await upstreamRequest(base, "/api/license", {
    headers: { Authorization: `Bearer ${cloudToken}` },
  });
  return (await res.json()) as LicenseData;
}
