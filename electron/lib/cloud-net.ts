/**
 * 云端 HTTP 封装。
 * 优先使用 electron.net.fetch（Chromium 网络栈）：与浏览器行为一致，
 * 会遵循系统代理设置并读取系统证书库，因此"本机浏览器能访问的地址"
 * 在应用内也能访问——可避免 Node 全局 fetch 在企业代理 / 自签证书
 * （MITM）环境下报 "fetch failed" 的问题。
 * 仅当 electron.net.fetch 不可用时（理论不会）才降级到 Node 全局 fetch。
 */
import { net } from "electron";

export async function cloudFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url = typeof input === "string" ? input : String(input);

  const doNodeFetch = async (): Promise<Response> => {
    try {
      return await fetch(input, init);
    } catch (e) {
      throw new Error(`无法连接云端服务（${url}）：${(e as Error).message}`);
    }
  };

  if (net && typeof net.fetch === "function") {
    try {
      // 与浏览器同栈：系统代理 + 系统证书库，本机能访问的云端这里也能访问
      return (await net.fetch(input as any, init as any)) as unknown as Response;
    } catch (e) {
      console.warn("[cloudFetch] electron.net.fetch 失败，降级到 Node fetch：", e);
    }
  }
  return doNodeFetch();
}
