import type { FastifyInstance } from "fastify";

export const SERVER_VERSION = "0.3.1";
/** 服务端声明的最低支持客户端版本（客户端启动时比对，见 DESIGN-SPLIT §10） */
export const MIN_CLIENT_VERSION = "0.1.0";
/**
 * 服务端能力标志（方案B）：客户端据此做特性切换。
 * - session_sync：支持 /api/v1/sessions/*（会话增量同步 + 家长回顾）
 * - worker：支持服务端无头 worker（recording/todo 由服务端执行，客户端应关闭本地对应调度避免双跑）
 * - exam：支持学习考核（EXAM-REQUIREMENTS.md）——考核配置下发 / 结果上报 / 家长查询
 */
export const SERVER_FEATURES = ["session_sync", "worker", "exam"] as const;

export function registerVersionRoutes(app: FastifyInstance): void {
  app.get("/api/v1/version", async () => ({
    name: "learning-server",
    version: SERVER_VERSION,
    min_client_version: MIN_CLIENT_VERSION,
    features: SERVER_FEATURES,
  }));
}
