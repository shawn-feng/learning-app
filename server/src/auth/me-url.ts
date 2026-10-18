/**
 * benefit-auth 个人中心地址（ISSUE-188）。
 *
 * VIP 到期时客户端要能直接打开该页完成任务，且**不重新扫码登录**——`?token=<benefit 用户 token>`
 * 让页面免登录（benefit-auth 的 /me 支持 token 查询参数）。纯函数，便于单测。
 */
export function buildMeUrl(
  upstreamBase: string,
  benefitUserToken: string | null | undefined
): string {
  const base = String(upstreamBase || "").replace(/\/+$/, "");
  const token = String(benefitUserToken || "").trim();
  return token ? `${base}/me?token=${encodeURIComponent(token)}` : `${base}/me`;
}
