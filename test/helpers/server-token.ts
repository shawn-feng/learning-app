/**
 * SPLIT 测试基建：签发本地测试服务端（127.0.0.1:8788）可接受的有效 session token。
 *
 * 背景：SPLIT 后客户端数据读写走服务端 RPC（dbExec/dbQuery → serverFetch），
 * 服务端用 JWT（HS256，jwtSecret 落盘在 server/data/server-config.json）校验家长身份。
 * 测试临时数据目录里没有 license.json，client-data.currentSessionToken() 返回空串 → 401。
 * 本 helper 读服务端 jwtSecret 手写签发 token（零依赖，不引入 jsonwebtoken），
 * 供测试写入临时目录 license.json，使测试走真实本地服务端验证全链路。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** 本地测试服务端地址（与 config.DEFAULT_SERVER_URL 一致） */
export const TEST_SERVER_URL = "http://127.0.0.1:8788";

/** 服务端配置落盘位置（server/data/server-config.json） */
const SERVER_CONFIG_PATH = path.resolve(__dirname, "../../server/data/server-config.json");

/** 本地测试服务端已存在的测试家长（test@qq.com，其下挂 1f050a7f 等测试孩子） */
export const TEST_PARENT_ID = "86a84278-c8ae-415e-8fbc-6140b1b7c88e";

let cachedSecret: string | null = null;

/** 读服务端 jwtSecret（测试环境约定：server 包已在仓库内启动）。 */
export function getServerJwtSecret(): string {
  if (cachedSecret) return cachedSecret;
  const raw = fs.readFileSync(SERVER_CONFIG_PATH, "utf-8");
  const cfg = JSON.parse(raw) as { jwtSecret?: string };
  if (!cfg.jwtSecret) throw new Error(`server-config.json 缺少 jwtSecret: ${SERVER_CONFIG_PATH}`);
  cachedSecret = cfg.jwtSecret;
  return cachedSecret;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** 手写 HS256 JWT（签名载荷与服务端 signSession 一致：parent_id/email/plan）。 */
export function signSessionToken(parentId: string, email = "test@qq.com", plan = "pro"): string {
  const secret = getServerJwtSecret();
  const header = base64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        parent_id: parentId,
        email,
        plan,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 7 * 86400,
      })
    )
  );
  const signingInput = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", secret).update(signingInput).digest("base64");
  return `${signingInput}.${base64url(sig)}`;
}

/** 生成完整 License 结构（结构对齐 electron/lib/auth-manager.ts 的 License 接口）。 */
export function buildTestLicense(parentId: string = TEST_PARENT_ID): {
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
} {
  return {
    parent_id: parentId,
    email: "test@qq.com",
    plan: "pro",
    max_children: 3,
    features: "",
    starts_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    status: "active",
    is_expired: false,
    token: signSessionToken(parentId),
    cached_at: new Date().toISOString(),
  };
}

/** 把带有效 token 的 license.json 写入指定数据目录（供 getCachedLicense 读取）。 */
export function writeTestLicense(dataDir: string, parentId: string = TEST_PARENT_ID): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "license.json"),
    JSON.stringify(buildTestLicense(parentId), null, 2),
    "utf-8"
  );
}

/** 创建独立测试数据目录并写入 license，返回 dataDir（等价于各测试的 mkdtemp + 写 license）。 */
export function makeTestDataDir(prefix = "pi-rpc-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  writeTestLicense(dir);
  return dir;
}

/** 读取指定数据目录 license.json 中的 token。 */
export function readTestToken(dataDir: string): string {
  const raw = fs.readFileSync(path.join(dataDir, "license.json"), "utf-8");
  const lic = JSON.parse(raw) as { token?: string };
  if (!lic.token) throw new Error(`license.json 缺少 token: ${path.join(dataDir, "license.json")}`);
  return lic.token;
}

/**
 * 在本地测试服务端注册一个测试孩子（解决 assertChildOwned 403）。
 * 服务端 children 接口要求 id 为 UUID 格式，否则会重新生成随机 id 与测试常量对不上。
 * @returns 服务端实际创建的孩子 id
 */
export async function registerTestChild(
  dataDir: string,
  childId: string,
  name = "测试孩子",
  profile: Record<string, unknown> = {}
): Promise<string> {
  const token = readTestToken(dataDir);
  let res: Response;
  try {
    res = await fetch(`${TEST_SERVER_URL}/api/v1/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, id: childId, profile }),
    });
  } catch (err) {
    // 连不上 ≠ 断言失败：这类测试需要本地服务端在跑（调用方应先用 isTestServerUp 探一次并 skip）
    throw new Error(
      `注册测试孩子失败：连不上本地服务端 ${TEST_SERVER_URL}（${(err as Error).message}）。` +
        `这组是集成测试，请先启动服务端（server 目录 npm run dev / start），或让测试 skip。`
    );
  }
  if (!res.ok) {
    throw new Error(`注册测试孩子失败 (HTTP ${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { child?: { id?: string } };
  return data.child?.id ?? childId;
}

/** 列出测试家长名下的孩子（清理用）。 */
export async function listTestChildren(
  dataDir: string
): Promise<Array<{ id: string; name?: string }>> {
  const token = readTestToken(dataDir);
  const res = await fetch(`${TEST_SERVER_URL}/api/v1/children`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`列出测试孩子失败 (HTTP ${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { children?: Array<{ id: string; name?: string }> };
  return data.children ?? [];
}

/**
 * 删掉服务端上的测试孩子（**清理残留**用）。
 *
 * 为什么需要：`POST /children` 有数量上限（当前 4 个），集成测试每跑一次就注册一个
 * "sync-test"，跑几次就把名额占满 → 之后每次都以「孩子数量已达上限」失败（看起来像代码坏了）。
 * 调用方应在注册前按名字清掉上次的残留，让这组测试可反复跑。
 */
export async function deleteTestChild(dataDir: string, childId: string): Promise<boolean> {
  const token = readTestToken(dataDir);
  const res = await fetch(`${TEST_SERVER_URL}/api/v1/children/${encodeURIComponent(childId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}
