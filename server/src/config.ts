import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface ServerConfig {
  port: number;
  /** 公网认证基址（暂接 www，benefit-auth 就绪后切换） */
  upstreamBase: string;
  jwtSecret: string;
  tokenTtlDays: number;
  /** 服务端数据目录：数据库 + materials + 大文件 */
  dataDir: string;
}

const DEFAULT_PORT = 8788;
const DEFAULT_UPSTREAM = "https://www.aixuexihao.top";
const DEFAULT_TTL_DAYS = 7;

/**
 * 加载服务端配置；首次启动生成 jwtSecret 并落盘。
 * 环境变量可覆盖：SERVER_PORT / SERVER_DATA_DIR / UPSTREAM_BASE / JWT_SECRET
 */
export function loadConfig(): ServerConfig {
  const dataDir =
    process.env.SERVER_DATA_DIR ?? path.resolve(process.cwd(), "data");
  const configPath = path.join(dataDir, "server-config.json");

  let cfg: Partial<ServerConfig> = {};
  if (fs.existsSync(configPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      cfg = {};
    }
  }

  const config: ServerConfig = {
    port: cfg.port ?? Number(process.env.SERVER_PORT ?? DEFAULT_PORT),
    upstreamBase: cfg.upstreamBase ?? process.env.UPSTREAM_BASE ?? DEFAULT_UPSTREAM,
    jwtSecret: cfg.jwtSecret ?? process.env.JWT_SECRET ?? crypto.randomBytes(32).toString("hex"),
    tokenTtlDays: cfg.tokenTtlDays ?? DEFAULT_TTL_DAYS,
    dataDir,
  };

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return config;
}
