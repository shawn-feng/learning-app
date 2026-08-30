import { app } from "electron";
import path from "path";
import fs from "fs";

let dataDir: string;

export function getDataDir(): string {
  if (!dataDir) {
    // 测试隔离：显式设置 PI_TEST_DATA_DIR 时（仅 vitest 设置），所有数据落到临时目录，
    // 避免测试读写污染真实的 data/（例如 app-settings.json 被清空导致用户编程模型配置丢失）。
    const testDir = process.env["PI_TEST_DATA_DIR"];
    if (testDir) {
      dataDir = testDir;
    } else if (app?.isPackaged) {
      dataDir = path.join(app.getPath("userData"), "app-data");
    } else {
      dataDir = path.join(process.cwd(), "data");
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, "shared", "skills"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "children"), { recursive: true });
  }
  return dataDir;
}

export function getSharedDir(): string {
  return path.join(getDataDir(), "shared");
}

export function getSkillsDir(): string {
  return path.join(getSharedDir(), "skills");
}

// ==================== 按家长分区（2026-08-30 用户决策） ====================
// 客户端本地配置（模型 key/模型选择/定时任务等）存到家长目录 parents/<parentId>/，
// 多个家长登录同一 app 互不干扰。当前家长 id 记在 <data>/.session.json（登录写、登出清）。
// **未登录 = 无任何家长数据**（家长库/孩子/kb 都在服务端按 token 鉴权）：getCurrentParentId()
// 返回 ""，配置读取函数落到 parents/ 根下的空位 → 读默认值（不创建 default 目录，default 已废弃）。

const SESSION_FILE = ".session.json";

export function getCurrentParentId(): string {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(getDataDir(), SESSION_FILE), "utf-8")) as { parentId?: string };
    return s?.parentId || "";
  } catch {
    return "";
  }
}

export function setCurrentParentId(parentId: string): void {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(path.join(getDataDir(), SESSION_FILE), JSON.stringify({ parentId: parentId || "" }, null, 2), "utf-8");
}

/** 当前家长配置目录。仅登录（parentId 非空）时自动创建；未登录返回空位路径（不建目录）。 */
export function getParentConfigDir(parentId: string = getCurrentParentId()): string {
  const dir = path.join(getDataDir(), "parents", parentId || "_guest");
  if (parentId) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getAuthPath(): string {
  return path.join(getParentConfigDir(), "auth.json");
}

export function getChildrenDir(): string {
  return path.join(getDataDir(), "children");
}

export function getChildDir(childId: string): string {
  return path.join(getChildrenDir(), childId);
}

/** 孩子上传文件的落盘目录（按 childId 隔离，见 ISSUE-008 落盘方案） */
export function getUploadsDir(childId: string): string {
  return path.join(getChildDir(childId), "uploads");
}

/** 上传文件扩展名白名单（与前端格式路由一致；gif 模型不支持但允许落盘留存） */
export const UPLOAD_EXT_WHITELIST = [
  ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".heic", ".tif", ".tiff",
  ".txt", ".md",
  ".webm", ".mp3", ".wav", ".m4a", ".ogg",
];

/** 上传目录保留上限：超出后按 mtime 清理最旧文件，避免无限膨胀（默认 200 个） */
export const DEFAULT_UPLOAD_LIMIT = 200;

/**
 * 清理上传目录：只保留最近 limit 个文件，更早的删除。
 * 每个文件独立 try/catch，删除失败不影响其它文件。
 */
export function pruneUploads(uploadsDir: string, limit: number = DEFAULT_UPLOAD_LIMIT): void {
  if (!fs.existsSync(uploadsDir)) return;
  const keep = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_UPLOAD_LIMIT;
  const files = fs
    .readdirSync(uploadsDir)
    .map((f) => path.join(uploadsDir, f))
    .filter((f) => fs.statSync(f).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const f of files.slice(keep)) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 忽略单文件删除失败 */
    }
  }
}

export function getLicensePath(): string {
  return path.join(getDataDir(), "license.json");
}

export function getTaskStatePath(): string {
  return path.join(getDataDir(), "task-state.json");
}

export function getSchedulerConfigPath(): string {
  return path.join(getParentConfigDir(), "scheduler-config.json");
}

export function getAppSettingsPath(): string {
  return path.join(getParentConfigDir(), "app-settings.json");
}

export function getCloudApiBase(): string {
  if (process.env["CLOUD_API_URL"]) return process.env["CLOUD_API_URL"];
  // 所有认证统一走公网云端；不连接任何本地地址。云端域名变动可通过 CLOUD_API_URL 环境变量覆盖。
  return "https://www.aixuexihao.top";
}

// ==================== SPLIT：服务端连接配置（纯服务端模式） ====================

export function getServerConnectionPath(): string {
  return path.join(getDataDir(), "server-connection.json");
}

export interface ServerConnection {
  /** 服务端地址（如 http://192.168.1.200:8788，去尾斜杠） */
  url: string;
}

/** 服务端地址默认值（SPLIT 默认单机部署：本机服务端 8788；未配置时使用） */
export const DEFAULT_SERVER_URL = "http://127.0.0.1:8788";

/** 读取已配置的服务端地址；未配置时默认返回本机服务端地址。 */
export function getServerUrl(): string {
  const p = getServerConnectionPath();
  if (fs.existsSync(p)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf-8")) as ServerConnection;
      const url = (cfg.url ?? "").trim().replace(/\/+$/, "");
      if (url) return url;
    } catch {
      /* 解析失败走默认 */
    }
  }
  return DEFAULT_SERVER_URL;
}

/** 保存服务端地址（空串 = 清除配置）。 */
export function setServerUrl(url: string): void {
  const clean = (url ?? "").trim().replace(/\/+$/, "");
  fs.writeFileSync(
    getServerConnectionPath(),
    JSON.stringify({ url: clean } satisfies ServerConnection, null, 2),
    "utf-8"
  );
}

/**
 * ISSUE-040: 自动更新 feed 地址（latest.yml + 安装包托管目录）。
 * 原定阿里云 OSS 公共读被阿里云 2024 新规禁止（bucket ACL / policy 均不允许公开，需控制台申请），
 * 降级为自有服务器 Nginx 静态目录 /download/（与认证同域名）。环境变量可覆盖。
 */
export function getUpdateFeedUrl(): string {
  if (process.env["UPDATE_FEED_URL"]) return process.env["UPDATE_FEED_URL"];
  // 统一走公网（开发/打包一致）；本地联调可用 UPDATE_FEED_URL 覆盖
  return "https://www.aixuexihao.top/download/";
}
