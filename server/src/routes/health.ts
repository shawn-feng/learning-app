import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { db: DatabaseSync }
): void {
  app.get("/api/v1/health", async () => ({
    ok: true,
    uptime: Math.round(process.uptime()),
    db: deps.db ? "ok" : "error",
  }));
}
