/**
 * 开放 API 密钥客户端 API（2026-09-28；2026-10-04 起多键制）：列表 / 生成 / 按 id 吊销，全部走家长 JWT。
 * 服务端设计：docs/开放API-设计方案-2026-09-28.md（完整 Key 仅生成时返回一次，库里只有 hash）。
 */
import { currentSessionToken } from "./client-data";
import { serverFetch } from "./server-client";

export interface OpenApiKeyInfo {
  id: string;
  prefix: string;
  child_id: string;
  label: string;
  last_used_at: string | null;
  request_count: number;
  created_at: string;
}

export async function getOpenApiKeys(): Promise<{ keys: OpenApiKeyInfo[] }> {
  return serverFetch<{ keys: OpenApiKeyInfo[] }>("/apikeys", {
    method: "GET",
    token: currentSessionToken(),
    timeoutMs: 15000,
  });
}

export async function createOpenApiKey(payload: {
  child_id?: string;
  label?: string;
}): Promise<{ key: OpenApiKeyInfo; secret: string }> {
  return serverFetch<{ key: OpenApiKeyInfo; secret: string }>("/apikeys", {
    method: "POST",
    token: currentSessionToken(),
    body: payload,
    timeoutMs: 15000,
  });
}

export async function revokeOpenApiKey(id: string): Promise<{ ok: boolean; revoked: string }> {
  const keyId = String(id ?? "").trim();
  if (!keyId) throw new Error("缺少要吊销的 Key id");
  return serverFetch<{ ok: boolean; revoked: string }>(`/apikeys?id=${encodeURIComponent(keyId)}`, {
    method: "DELETE",
    token: currentSessionToken(),
    timeoutMs: 15000,
  });
}
