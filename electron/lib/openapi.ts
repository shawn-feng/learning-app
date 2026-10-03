/**
 * 开放 API 密钥客户端 API（2026-09-28）：查询 / 生成 / 吊销，全部走家长 JWT。
 * 服务端设计：docs/开放API-设计方案-2026-09-28.md（一账号一有效键，完整 Key 仅生成时返回一次）。
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

export async function getOpenApiKey(): Promise<{ key: OpenApiKeyInfo | null }> {
  return serverFetch<{ key: OpenApiKeyInfo | null }>("/apikeys", {
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

export async function revokeOpenApiKey(): Promise<{ ok: boolean }> {
  return serverFetch<{ ok: boolean }>("/apikeys", {
    method: "DELETE",
    token: currentSessionToken(),
    timeoutMs: 15000,
  });
}
