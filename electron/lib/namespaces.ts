/**
 * Tier 2 自定义数据场景客户端 API（F15b，2026-09-19）：
 * 场景清单（含待确认草案）+ 确认/拒绝 + 停用/启用。走家长 JWT，与 wechat.ts 同一 serverFetch 形态。
 */
import { currentSessionToken } from "./client-data";
import { serverFetch } from "./server-client";

export interface NamespaceField {
  name: string;
  kind: "string" | "number" | "enum";
  desc: string;
  required: boolean;
  filterable: boolean;
  enumValues: string[];
  /** 引用目标（如 courses.uuid），null=无 */
  ref: string | null;
}

export interface NamespaceInfo {
  ns: string;
  scope: "parent" | "child";
  label: string;
  version: number;
  status: "active" | "pending" | "disabled";
  fields: NamespaceField[];
}

export async function listNamespaces(): Promise<{ namespaces?: NamespaceInfo[] }> {
  return serverFetch<{ namespaces?: NamespaceInfo[] }>("/namespaces", {
    method: "GET",
    token: currentSessionToken(),
    timeoutMs: 15000,
  });
}

export async function decideNamespace(payload: { ns: string; action: "confirm" | "reject" }): Promise<{ ok?: boolean; text?: string; error?: string }> {
  return serverFetch("/namespaces/decide", {
    method: "POST",
    token: currentSessionToken(),
    body: payload,
    timeoutMs: 15000,
  });
}

export async function setNamespaceStatus(payload: { ns: string; action: "disable" | "enable" }): Promise<{ ok?: boolean; text?: string; error?: string }> {
  return serverFetch("/namespaces/status", {
    method: "POST",
    token: currentSessionToken(),
    body: payload,
    timeoutMs: 15000,
  });
}
