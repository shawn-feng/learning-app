import jwt from "jsonwebtoken";

/** 服务端 session 载荷（不携带 cloud token，公网凭证只存服务端磁盘） */
export interface SessionPayload {
  parent_id: string;
  email: string;
  plan: string;
}

export function signSession(
  payload: SessionPayload,
  secret: string,
  ttlDays: number
): string {
  return jwt.sign(payload, secret, { expiresIn: `${ttlDays}d` });
}

export function verifySession(token: string, secret: string): SessionPayload {
  const decoded = jwt.verify(token, secret) as jwt.JwtPayload;
  if (!decoded.parent_id) {
    throw new Error("session 缺少 parent_id");
  }
  return {
    parent_id: String(decoded.parent_id),
    email: String(decoded.email ?? ""),
    plan: String(decoded.plan ?? ""),
  };
}
