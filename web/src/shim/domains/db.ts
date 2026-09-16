/**
 * db 域：preload 未直接暴露 db 通道（Electron 端 db/query|exec 由主进程各 ipc-handler
 * 内部调用），Web 端同样作为**各域共用的 RPC 辅助**——语义逐行对齐
 * electron/lib/client-data.ts 的 dbQuery/dbExec：
 *   POST /api/v1/db/query|exec  body {op, args} → 服务端返回 {op, result} → 解包取 .result
 * （渲染层不直接消费 db 域，dbDomain 保持空；24 个 op 的清单见 server/src/routes/db.ts）。
 */
import { http } from "../core/server-fetch";

/** 服务端 RPC 返回封套（对齐 client-data.ts 的 DbQueryResult）。 */
export interface DbRpcResult<T = unknown> {
  op: string;
  result: T;
}

/** 远程结构化查询（对应服务端 queryHandlers；token 由 http() 自动携带）。 */
export async function dbQuery<T = unknown>(
  op: string,
  args: Record<string, unknown>
): Promise<T> {
  const data = await http<DbRpcResult<T>>("/db/query", {
    method: "POST",
    body: { op, args },
  });
  return data.result;
}

/** 远程结构化写入（对应服务端 execHandlers）。 */
export async function dbExec<T = unknown>(
  op: string,
  args: Record<string, unknown>
): Promise<T> {
  const data = await http<DbRpcResult<T>>("/db/exec", {
    method: "POST",
    body: { op, args },
  });
  return data.result;
}

/** window.api 上无 db 方法（preload 亦未暴露），保持空对象以维持 install.ts 组装面。 */
export const dbDomain = {};
