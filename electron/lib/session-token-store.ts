/**
 * 会话 token 落盘/采纳（ISSUE-188 滑动续签的客户端半边）。
 *
 * 服务端在请求响应头 `X-Session-Token` 里下发"续签后的新 JWT"（见 server/src/auth/session-renew.ts）。
 * 主进程 `serverFetch` 收到后调用本模块写回 `license.json`——之后：
 * - 下一次 HTTP 请求自动带新 token；
 * - SSE 重连的 `sessionToken()`（每次连接都重读 license.json）也自动用新 token。
 *
 * 为什么单独成文件（而不是放 auth-manager）：`server-client.ts` 已被 `auth-manager.ts` 依赖，
 * 反过来 import 会形成循环。本模块只依赖 `config`（路径），零业务依赖。
 */
import fs from "fs";
import { getLicensePath } from "./config";

/**
 * 采纳服务端下发的新会话 token（写回 license.json）。
 * @returns 是否真的更新了（无本地凭证 / 同值 / 解析失败 → false）
 */
export function adoptSessionToken(token: string): boolean {
  const fresh = String(token || "").trim();
  if (!fresh) return false;
  const p = getLicensePath();
  if (!fs.existsSync(p)) return false; // 未登录：忽略（避免把 token 写到不存在的凭证里）
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as { token?: string };
    if (!raw || typeof raw !== "object") return false;
    if (raw.token === fresh) return false;
    raw.token = fresh;
    fs.writeFileSync(p, JSON.stringify(raw, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}
