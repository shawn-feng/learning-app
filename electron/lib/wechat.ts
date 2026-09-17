/**
 * 微信桥客户端 API（2026-09-17）：绑定请求列表 / 确认 / 拒绝 + 已绑定管理。
 * 全部走家长 JWT（currentSessionToken），与 exam.ts 同一 serverFetch 形态。
 */
import { currentSessionToken } from "./client-data";
import { serverFetch } from "./server-client";

export interface WechatBindRequest {
  id: string;
  wechat_id: string;
  sample_text: string;
  first_seen: string;
  last_seen: string;
}

export interface WechatBinding {
  wechat_id: string;
  role: "parent" | "child";
  child_id: string;
  label: string;
  created_at: string;
}

export async function listWechatBindRequests(): Promise<{ requests?: WechatBindRequest[] }> {
  return serverFetch<{ requests?: WechatBindRequest[] }>("/wechat/bind-requests", {
    method: "GET",
    token: currentSessionToken(),
    timeoutMs: 15000,
  });
}

export async function decideWechatBindRequest(payload: {
  id: string;
  action: "confirm" | "reject";
  role?: "parent" | "child";
  childId?: string;
  label?: string;
}): Promise<{ ok?: boolean; error?: string; wechatId?: string }> {
  return serverFetch("/wechat/bind-requests/decide", {
    method: "POST",
    token: currentSessionToken(),
    body: payload,
    timeoutMs: 15000,
  });
}

export async function listWechatBindings(): Promise<{ bindings?: WechatBinding[] }> {
  return serverFetch("/wechat/bindings", {
    method: "POST",
    token: currentSessionToken(),
    body: { action: "list" },
    timeoutMs: 15000,
  });
}

export async function addWechatBinding(payload: {
  wechatId: string;
  role: "parent" | "child";
  childId?: string;
  label?: string;
}): Promise<{ ok?: boolean; error?: string }> {
  return serverFetch("/wechat/bindings", {
    method: "POST",
    token: currentSessionToken(),
    body: { action: "add", ...payload },
    timeoutMs: 15000,
  });
}

export async function getFeishuConfig(): Promise<{
  enabled: boolean;
  appId: string;
  hasSecret: boolean;
  running: boolean;
  status: string;
  envFallback: boolean;
}> {
  return serverFetch("/wechat/feishu-config", {
    method: "GET",
    token: currentSessionToken(),
    timeoutMs: 15000,
  });
}

export async function saveFeishuConfig(payload: {
  appId: string;
  appSecret?: string;
  enabled: boolean;
}): Promise<{ ok?: boolean; started?: boolean; status?: string; error?: string }> {
  return serverFetch("/wechat/feishu-config", {
    method: "PUT",
    token: currentSessionToken(),
    body: payload,
    timeoutMs: 20000,
  });
}

export async function removeWechatBinding(wechatId: string): Promise<{ ok?: boolean; error?: string }> {
  return serverFetch("/wechat/bindings", {
    method: "POST",
    token: currentSessionToken(),
    body: { action: "remove", wechatId },
    timeoutMs: 15000,
  });
}
