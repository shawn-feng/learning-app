/**
 * 云端 HTTP 封装：统一走 Electron 的 Chromium 网络栈。
 *
 * 为什么不用全局 fetch？
 * Electron 主进程里的全局 fetch 是 Node 的 undici 实现，**不会自动应用系统代理**。
 * 在需要代理上网的环境（企业网络 / VPN / 加速器）下，直连云端会失败，
 * 表现为登录/注册等报 "fetch failed"。Electron 的 net.fetch 走 Chromium 网络栈，
 * 自动使用系统代理设置，与渲染进程行为一致。
 *
 * 兼容性：非 Electron 环境（vitest 单测等）或 electron mock 无 net 导出时，
 * 安全回退到全局 fetch，保持可测试性。
 */
type NetFetchFn = (input: any, init?: any) => Promise<Response>;

function resolveNetFetch(): NetFetchFn | null {
  try {
    // 运行时动态获取，避免静态 import { net } 在无 net 导出的 mock 环境下抛错
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as { net?: { fetch?: NetFetchFn } };
    const f = electron?.net?.fetch;
    return typeof f === "function" ? f : null;
  } catch {
    return null; // 非 Electron 环境：require("electron") 失败
  }
}

const _netFetch = resolveNetFetch();

export function cloudFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  if (_netFetch) {
    return _netFetch(input, init);
  }
  return fetch(input, init);
}
