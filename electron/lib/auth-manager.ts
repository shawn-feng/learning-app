import fs from "fs";
import path from "path";
import { getLicensePath, getCloudApiBase } from "./config";

export interface License {
  parent_id: string;
  email: string;
  plan: string;
  max_children: number;
  features: string;
  starts_at: string;
  expires_at: string;
  status: string;
  is_expired: boolean;
  token: string;
  cached_at: string;
}

export async function register(
  email: string,
  password: string
): Promise<{ token: string; parent_id: string }> {
  const res = await fetch(`${getCloudApiBase()}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail?.[0]?.msg || err.detail || "Registration failed");
  }
  return res.json();
}

export async function login(
  email: string,
  password: string
): Promise<{ token: string; parent_id: string }> {
  const res = await fetch(`${getCloudApiBase()}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail?.[0]?.msg || err.detail || "Login failed");
  }
  return res.json();
}

export async function fetchLicense(token: string): Promise<Omit<License, "token" | "cached_at">> {
  const res = await fetch(`${getCloudApiBase()}/api/license`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error("Failed to fetch license");
  }
  return res.json();
}

// 向云端校验 token / 订阅有效期，返回权威结果。
// 返回 null 表示网络错误（连不上云端，无法判断），由调用方决定降级策略。
export async function verifyLicenseWithCloud(
  token: string
): Promise<{ valid: boolean; max_children: number } | null> {
  try {
    const res = await fetch(`${getCloudApiBase()}/api/license/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    // 401 = token 失效/过期；其它非 2xx 也视为无效
    if (res.status === 401 || !res.ok) {
      return { valid: false, max_children: 0 };
    }
    const data = await res.json();
    return {
      valid: data.valid === true,
      max_children: typeof data.max_children === "number" ? data.max_children : 0,
    };
  } catch {
    return null; // 网络错误
  }
}

export function getCachedLicense(): License | null {
  const licensePath = getLicensePath();
  if (!fs.existsSync(licensePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(licensePath, "utf-8"));
  } catch {
    return null;
  }
}

export function cacheLicense(license: License): void {
  fs.writeFileSync(getLicensePath(), JSON.stringify(license, null, 2), "utf-8");
}

export function clearCachedLicense(): void {
  const p = getLicensePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export async function loginAndCache(
  email: string,
  password: string
): Promise<License> {
  const { token, parent_id } = await login(email, password);
  const licenseData = await fetchLicense(token);
  const license: License = {
    ...licenseData,
    email,
    token,
    cached_at: new Date().toISOString(),
  };
  cacheLicense(license);
  return license;
}

export async function registerAndCache(
  email: string,
  password: string
): Promise<License> {
  const { token, parent_id } = await register(email, password);
  const licenseData = await fetchLicense(token);
  const license: License = {
    ...licenseData,
    email,
    token,
    cached_at: new Date().toISOString(),
  };
  cacheLicense(license);
  return license;
}

// 进入家长中心时验证家长密码（走公网，以云端为准），同时刷新 token/license
export async function verifyParentPassword(
  email: string,
  password: string
): Promise<{ success: boolean; license?: License; error?: string }> {
  try {
    const license = await loginAndCache(email, password);
    return { success: true, license };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function checkAuth(): Promise<{ authenticated: boolean; license: License | null }> {
  const license = getCachedLicense();
  if (!license) return { authenticated: false, license: null };
  // 凭证在有效期内才视为已登录，过期则清除并回到登录页
  const expired =
    license.is_expired ||
    (license.expires_at && new Date(license.expires_at).getTime() < Date.now());
  if (expired) {
    clearCachedLicense();
    return { authenticated: false, license: null };
  }

  // 本地判断没过期，仍向云端确认一次，防止改本地 license.json 绕过
  const cloud = await verifyLicenseWithCloud(license.token);
  if (cloud !== null && !cloud.valid) {
    // 云端明确判定过期 / token 失效 → 强制登出
    clearCachedLicense();
    return { authenticated: false, license: null };
  }
  // cloud === null 表示云端连不上，离线降级：信任本地判断，放行

  return { authenticated: true, license };
}
