import Fastify from "fastify";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { openDb, dbHealth } from "./db.js";
import { registerVersionRoutes } from "./routes/version.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDbRoutes } from "./routes/db.js";
import { registerChildrenRoutes } from "./routes/children.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerMaterialsRoutes } from "./routes/materials.js";
import { registerMaterialDocRoutes } from "./routes/materials-doc.js";
import { registerFilesRoutes } from "./routes/files.js";
import { registerBackupRoutes } from "./routes/backup.js";
import { registerSessionsRoutes } from "./routes/sessions.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerParentAgentRoutes } from "./routes/parent-agent.js";
import { registerExamRoutes } from "./routes/exam.js";
import { registerExamAgentRoutes } from "./routes/exam-agent.js";
import { registerAssessmentRoutes } from "./routes/assessment.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerSchedulerRoutes } from "./routes/scheduler.js";
import { registerStudyPlanRoutes } from "./routes/study-plans.js";
import { registerPlanRewardRoutes } from "./routes/plans-rewards.js";
import { registerWechatRoutes } from "./routes/wechat.js";
import { registerNamespaceRoutes } from "./routes/namespaces.js";
import { startWorkerScheduler } from "./worker/scheduler.js";
import { initServerLog, logInfo, logError, installServerConsoleRedirect } from "./log.js";

const config = loadConfig();
initServerLog(config.dataDir);
installServerConsoleRedirect(); // worker/routes 的裸 console.* 统一落盘（仍回显 stdout）
const db = openDb(config.dataDir);

// maxParamLength：默认 100 会把携带 JWT 的长路径参数（/materials/p/:token/*，Web 资料文档网关）
// 直接 414；放宽到 1024（业务层参数校验不受影响）
const app = Fastify({ logger: true, maxParamLength: 1024 });

// ISSUE-044: 访问日志落盘（method/path/status/durMs/reqId/ip），供 tail -f server-log.jsonl 排查
app.addHook("onResponse", async (req, reply) => {
  try {
    logInfo("http", "request", {
      method: req.method,
      path: req.url,
      status: reply.statusCode,
      durMs: reply.elapsedTime,
      reqId: (req.id as string) ?? undefined,
      ip: req.ip,
      parentId: ((req as { parentId?: string }).parentId as string) ?? undefined,
    });
  } catch {
    /* ignore */
  }
});

void app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

registerVersionRoutes(app);
registerHealthRoutes(app, { db });
registerAuthRoutes(app, { config, db });
registerDbRoutes(app, { config, db });
registerChildrenRoutes(app, { config, db });
registerConfigRoutes(app, { config, db });
registerMaterialsRoutes(app, { config, db });
registerMaterialDocRoutes(app, { config, db }); // Web 前端 Phase 0：文档网关（附加式）
registerFilesRoutes(app, { config, db });
registerBackupRoutes(app, { config, db });
registerSessionsRoutes(app, { config, db });
registerAgentRoutes(app, { config, db });
registerParentAgentRoutes(app, { config, db });
registerExamRoutes(app, { config, db });
registerExamAgentRoutes(app, { config, db });
registerAssessmentRoutes(app, { config, db });
registerModelRoutes(app, { config, db });
registerSchedulerRoutes(app, { config, db });
registerStudyPlanRoutes(app, { config, db });
registerPlanRewardRoutes(app, { config, db });
registerWechatRoutes(app, { config, db });
registerNamespaceRoutes(app, { config, db });
// 飞书渠道：设置页保存的配置（settings 表）优先，未配置时回退环境变量（长连接，进程内直调会话）
{
  void import("./channels/feishu.js")
    .then(({ applyFeishuChannel }) => applyFeishuChannel({ db, dataDir: config.dataDir }))
    .catch((err) => console.error("[feishu] 渠道启动失败:", (err as Error)?.message || err));
}
startWorkerScheduler({ dataDir: config.dataDir, db });

// ── Web 前端静态托管（部署形态，2026-09-16）────────────────────────────────
// `web/dist` 存在时（`npm --prefix web run build` 产物），由本服务同源托管网页：
// 单端口同时服务 UI 与 /api，规避服务端无 CORS 的同源约束。
// - 路由优先级：/api/* 为精确/参数路由，恒优先于 @fastify/static 的通配，互不影响；
// - 渲染层是无路由状态机（所有界面都在 / 下），无需 SPA fallback；
// - 目录不存在（纯 Electron 开发场景）时完全跳过，零影响。
// web/dist 多候选探测：
// 1. WEB_DIST_DIR 环境变量（显式覆盖）；
// 2. 本文件位置上两级（仓库开发形态：server/src 或 server/dist 上两级 → 仓库根/web/dist）；
// 3. 进程 cwd 下的 web/dist 与 同目录 web/dist（201 部署形态：/opt/learning-server/server.cjs → /opt/learning-server/web/dist）。
// esbuild bundle 后 import.meta.url 已替换为 __filename，候选 2/3 分别覆盖两种落位。
const __dirnameHere = path.dirname(fileURLToPath(import.meta.url));
const webDistCandidates = [
  process.env.WEB_DIST_DIR,
  path.resolve(__dirnameHere, "..", "..", "web", "dist"),
  path.resolve(process.cwd(), "web", "dist"),
  path.resolve(__dirnameHere, "web", "dist"),
].filter((p): p is string => !!p);
const webDist = webDistCandidates.find((p) => fs.existsSync(path.join(p, "index.html"))) ?? "";
const webDistDir = webDist; // 命中的候选（空串 = 未找到，跳过托管）
if (webDistDir) {
  // register 返回 promise，fastify 在 listen/ready 时统一串行加载（顶层不能 await：CJS bundle）
  void app.register(staticFiles, { root: webDistDir, prefix: "/", decorateReply: false });
  logInfo("boot", "web frontend hosting enabled", { webDist: webDistDir });
}

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    app.log.info(`learning-server 已启动: :${config.port} (data: ${config.dataDir})`);
    app.log.info(`健康检查: /api/v1/health  版本协商: /api/v1/version`);
    logInfo("boot", "learning-server started", { port: config.port, dataDir: config.dataDir });
    if (!dbHealth(db)) {
      logError("db", "database health check failed");
      app.log.error("数据库健康检查失败");
      process.exit(1);
    }
  } catch (err) {
    logError("boot", "listen failed", { err: (err as Error)?.stack ?? String(err) });
    app.log.error(err);
    process.exit(1);
  }
};

void start();
