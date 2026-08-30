import fs from "fs";
import path from "path";
import { getLicensePath, getServerUrl, getDataDir, getSharedDir, getParentConfigDir, setCurrentParentId } from "./config";
import { serverFetch, ServerError } from "./server-client";

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
  /** 服务端签发的 session token（SPLIT：cloud token 只存服务端，客户端不再持有） */
  token: string;
  cached_at: string;
}

export async function register(
  email: string,
  password: string
): Promise<{ token: string; parent_id: string }> {
  const data = await serverFetch<{ session_token: string; license: License }>("/auth/register", {
    method: "POST",
    body: { email, password },
  });
  return { token: data.session_token, parent_id: data.license.parent_id };
}

export async function login(
  email: string,
  password: string
): Promise<{ token: string; parent_id: string }> {
  const data = await serverFetch<{ session_token: string; license: License }>("/auth/login", {
    method: "POST",
    body: { email, password },
  });
  return { token: data.session_token, parent_id: data.license.parent_id };
}

export async function fetchLicense(
  sessionToken: string
): Promise<Omit<License, "token" | "cached_at">> {
  const data = await serverFetch<{ license: Omit<License, "token" | "cached_at"> }>("/auth/license", {
    token: sessionToken,
  });
  return data.license;
}

// 向服务端校验 session / 授权有效期（服务端内部向公网刷新），返回权威结果。
// 返回 null 表示网络错误（连不上服务端，无法判断），由调用方决定降级策略。
export async function verifyLicenseWithCloud(
  token: string
): Promise<{ valid: boolean; max_children: number } | null> {
  try {
    const data = await serverFetch<{ license: License }>("/auth/license", { token });
    return {
      valid: data.license.is_expired !== true,
      max_children: typeof data.license.max_children === "number" ? data.license.max_children : 0,
    };
  } catch (err) {
    if (err instanceof ServerError && err.status === 401) {
      return { valid: false, max_children: 0 };
    }
    return null; // 网络错误 / 服务端不可达
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
  // 登出同时清当前家长会话（本地配置回到 default 隔离区）
  try {
    setCurrentParentId("default");
  } catch {
    // 忽略
  }
}

/** 登录成功后：记录当前家长 id（本地配置按家长分区）+ 迁移旧全局配置到家长目录。 */
function activateParentSession(parentId: string): void {
  try {
    setCurrentParentId(parentId);
    migrateLegacyConfigToParent(parentId);
  } catch {
    // 迁移失败不阻塞登录
  }
}

/**
 * 把旧全局位置的配置（shared/auth.json、根 app-settings.json / scheduler-config.json）
 * 复制到家长目录（仅当家长目录还没有对应文件；default → 真实家长 首次登录时执行）。
 */
function migrateLegacyConfigToParent(parentId: string): void {
  const parentDir = getParentConfigDir(parentId);
  const legacy: Array<{ src: string; name: string }> = [
    { src: path.join(getSharedDir(), "auth.json"), name: "auth.json" },
    { src: path.join(getDataDir(), "app-settings.json"), name: "app-settings.json" },
    { src: path.join(getDataDir(), "scheduler-config.json"), name: "scheduler-config.json" },
  ];
  for (const { src, name } of legacy) {
    if (!fs.existsSync(src)) continue;
    const dst = path.join(parentDir, name);
    if (fs.existsSync(dst)) continue;
    try {
      fs.copyFileSync(src, dst);
    } catch {
      // 复制失败跳过（读旧位置逻辑已由新路径接管）
    }
  }
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
  activateParentSession(parent_id);
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
  activateParentSession(parent_id);
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

  // SPLIT：未配置服务端地址 → 一律视为未登录（回到带配置区的登录页）。
  // 否则用户被旧凭证直接带进主页，而主页/家长中心又依赖服务端验证，形成死循环。
  // 本地凭证不删除，配置好服务端地址后重新登录即恢复。
  if (!getServerUrl()) {
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
