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

export function getAuthPath(): string {
  return path.join(getSharedDir(), "auth.json");
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
  return path.join(getDataDir(), "scheduler-config.json");
}

export function getAppSettingsPath(): string {
  return path.join(getDataDir(), "app-settings.json");
}

export function getCloudApiBase(): string {
  if (process.env["CLOUD_API_URL"]) return process.env["CLOUD_API_URL"];
  // 生产打包默认走公网云服务，开发环境走本地联调
  return app?.isPackaged ? "https://www.aixuexihao.top" : "http://localhost:8000";
}
