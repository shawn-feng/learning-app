import type { FastifyInstance } from "fastify";

export const SERVER_VERSION = "0.1.2";
/** 服务端声明的最低支持客户端版本（客户端启动时比对，见 DESIGN-SPLIT §10） */
export const MIN_CLIENT_VERSION = "0.1.0";

export function registerVersionRoutes(app: FastifyInstance): void {
  app.get("/api/v1/version", async () => ({
    name: "learning-server",
    version: SERVER_VERSION,
    min_client_version: MIN_CLIENT_VERSION,
  }));
}
