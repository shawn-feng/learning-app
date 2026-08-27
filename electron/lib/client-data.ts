/**
 * 客户端数据访问层（SPLIT M8-B）：对服务端 /db/query + /db/exec 的语义化封装。
 * 纯服务端模式：数据唯一真源在服务端，客户端不再读写本地业务 SQLite。
 */
import { serverFetch } from "./server-client";
import { getCachedLicense } from "./auth-manager";

/** 当前家长 session token（登录后由服务端签发；未登录为空串 → 服务端返回 401）。 */
export function currentSessionToken(): string {
  return getCachedLicense()?.token ?? "";
}

/**
 * 从 agent 会话工作目录推导 childId。
 * cwd 形如 <data>/children/<childId>（或子目录），取 "children" 后的第一段。
 */
export function childIdFromCwd(cwd: string): string {
  const segs = cwd.split(/[\\/]/).filter(Boolean);
  const idx = segs.lastIndexOf("children");
  return idx >= 0 && idx + 1 < segs.length ? segs[idx + 1] : "";
}

export interface DbQueryResult<T = unknown> {
  op: string;
  result: T;
}

/** 远程结构化查询（对应服务端 queryHandlers）。 */
export async function dbQuery<T = unknown>(
  op: string,
  args: Record<string, unknown>
): Promise<T> {
  const data = await serverFetch<DbQueryResult<T>>("/db/query", {
    method: "POST",
    body: { op, args },
    token: currentSessionToken(),
  });
  return data.result;
}

/** 远程结构化写入（对应服务端 execHandlers）。 */
export async function dbExec<T = unknown>(
  op: string,
  args: Record<string, unknown>
): Promise<T> {
  const data = await serverFetch<DbQueryResult<T>>("/db/exec", {
    method: "POST",
    body: { op, args },
    token: currentSessionToken(),
  });
  return data.result;
}
