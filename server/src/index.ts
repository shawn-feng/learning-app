import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { loadConfig } from "./config.js";
import { openDb, dbHealth } from "./db.js";
import { registerVersionRoutes } from "./routes/version.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDbRoutes } from "./routes/db.js";
import { registerChildrenRoutes } from "./routes/children.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerMaterialsRoutes } from "./routes/materials.js";
import { registerFilesRoutes } from "./routes/files.js";
import { registerBackupRoutes } from "./routes/backup.js";
import { registerSessionsRoutes } from "./routes/sessions.js";
import { startWorkerScheduler } from "./worker/scheduler.js";

const config = loadConfig();
const db = openDb(config.dataDir);

const app = Fastify({ logger: true });

void app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

registerVersionRoutes(app);
registerHealthRoutes(app, { db });
registerAuthRoutes(app, { config, db });
registerDbRoutes(app, { config, db });
registerChildrenRoutes(app, { config, db });
registerConfigRoutes(app, { config, db });
registerMaterialsRoutes(app, { config, db });
registerFilesRoutes(app, { config, db });
registerBackupRoutes(app, { config, db });
registerSessionsRoutes(app, { config, db });
startWorkerScheduler({ dataDir: config.dataDir, db });

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    app.log.info(`learning-server 已启动: :${config.port} (data: ${config.dataDir})`);
    app.log.info(`健康检查: /api/v1/health  版本协商: /api/v1/version`);
    if (!dbHealth(db)) {
      app.log.error("数据库健康检查失败");
      process.exit(1);
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
