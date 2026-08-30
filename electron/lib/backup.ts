/**
 * 数据备份 / 恢复（ISSUE-003，SPLIT：备份的是**服务端用户数据**）。
 *
 * - createBackup(destDir)：向服务端 GET /api/v1/backup 拉取该家长的服务端数据 zip
 *   （家长库 + 每个孩子的学习库），保存到用户指定目录。
 * - restoreBackup(zipPath)：把本地 zip 上传到服务端 POST /api/v1/backup/restore，
 *   服务端会**先自动备份当前数据**，再校验并用 zip 覆盖其数据。
 *
 * 不含：账号/鉴权、模型 API key、登录凭证、材料大文件（zip 内清单 manifest.json 有说明）。
 * 注：旧版「本地 data/ 全量打包」已废弃（本地不再有业务数据，唯一真源在服务端）。
 */
import fs from "fs";
import path from "path";
import { serverFetchBinary, serverUploadFile, serverBase, ServerError } from "./server-client";
import { getCachedLicense } from "./auth-manager";

function backupTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface BackupResult {
  file: string;
  count: number;
  bytes: number;
}

/** 备份：从服务端下载该家长的数据 zip 到 destDir。 */
export async function createBackup(destDir: string): Promise<BackupResult> {
  await fs.promises.mkdir(destDir, { recursive: true });
  const token = getCachedLicense()?.token ?? "";
  const zip = await serverFetchBinary("/backup", { token });

  const stamp = backupTimestamp();
  const finalPath = path.join(destDir, `backup-${stamp}.zip`);
  const tmpPath = path.join(destDir, `.backup-${stamp}.tmp`);
  try {
    await fs.promises.writeFile(tmpPath, zip);
    await fs.promises.rename(tmpPath, finalPath);
  } catch (e) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw e;
  }
  // 文件数取 zip 内 manifest（解析失败回退 0，仅展示用）
  let count = 0;
  try {
    const text = zip.subarray(0, 64 * 1024).toString("utf-8");
    const m = text.match(/"fileCount"\s*:\s*(\d+)/);
    if (m) count = Number(m[1]);
  } catch {
    /* 仅展示，忽略 */
  }
  return { file: finalPath, count, bytes: zip.length };
}

export interface RestoreResult {
  restored: number;
  skipped: string[];
  preRestore?: string;
}

/** 恢复：上传 zip 给服务端覆盖其数据（服务端恢复前会先自动备份当前数据）。 */
export async function restoreBackup(zipPath: string): Promise<RestoreResult> {
  const token = getCachedLicense()?.token ?? "";
  const r = (await serverUploadFile("/backup/restore", zipPath, token)) as {
    ok?: boolean;
    restored?: number;
    skipped?: string[];
    preRestore?: string;
    error?: string;
  };
  if (!r || r.ok !== true) {
    throw new ServerError(0, r?.error || "恢复失败：服务端未确认");
  }
  return {
    restored: Number(r.restored ?? 0),
    skipped: Array.isArray(r.skipped) ? r.skipped : [],
    preRestore: r.preRestore,
  };
}

/** 兼容旧调用（scheduler 定时备份直接 import createBackup）：无需改动调用方。 */
export { serverBase };
