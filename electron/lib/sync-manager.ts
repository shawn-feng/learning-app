import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getChildDir, getCloudApiBase } from "./config";
import { getCachedLicense } from "./auth-manager";

interface SyncFileEntry {
  path: string;
  hash: string;
  size: number;
  updated_at: string;
}

interface SyncStatus {
  files: SyncFileEntry[];
}

/**
 * 扫描孩子数据目录，返回所有文件的 {path, hash, mtime}
 */
function scanChildFiles(childId: string): Array<{ path: string; hash: string; mtimeMs: number; size: number }> {
  const childDir = getChildDir(childId);
  const results: Array<{ path: string; hash: string; mtimeMs: number; size: number }> = [];
  const excludeDirs = [".pi"]; // don't sync agent sessions

  function walk(dir: string, relativeTo: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && excludeDirs.includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        walk(fullPath, relativeTo);
      } else {
        const content = fs.readFileSync(fullPath);
        results.push({
          path: relPath,
          hash: crypto.createHash("sha256").update(content).digest("hex"),
          mtimeMs: fs.statSync(fullPath).mtimeMs,
          size: content.length,
        });
      }
    }
  }

  walk(childDir, childDir);
  return results;
}

async function apiCall(endpoint: string, options: RequestInit = {}): Promise<any> {
  const license = getCachedLicense();
  if (!license) throw new Error("Not authenticated");

  const url = `${getCloudApiBase()}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${license.token}`,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(`Sync API error ${res.status}: ${err.detail}`);
  }
  return res.json();
}

/**
 * 获取云端文件同步状态
 */
async function getCloudStatus(childId: string): Promise<SyncFileEntry[]> {
  const resp: SyncStatus = await apiCall(`/api/sync/status/${childId}`);
  return resp.files;
}

/**
 * 上传单个文件到云端
 */
async function uploadFile(childId: string, filePath: string, content: Buffer): Promise<void> {
  const formData = new FormData();
  formData.append("file_path", filePath);
  formData.append("file", new Blob([content]), path.basename(filePath));
  await apiCall(`/api/sync/upload/${childId}`, {
    method: "POST",
    body: formData,
  });
}

/**
 * 从云端下载文件内容
 */
async function downloadFile(childId: string, filePath: string): Promise<Buffer> {
  const formData = new FormData();
  formData.append("file_path", filePath);
  const resp = await apiCall(`/api/sync/download/${childId}`, {
    method: "POST",
    body: formData,
  });
  return Buffer.from(resp.content_base64, "base64");
}

/**
 * 同步单个孩子数据：双向同步 + last-write-wins 冲突处理
 *
 * - 本地较新 → 上传
 * - 云端较新 → 下载
 * - 仅本地有 → 上传
 * - 仅云端有 → 下载
 * - hash 相同 → 跳过
 */
export async function syncChild(childId: string): Promise<{ uploaded: number; downloaded: number; skipped: number }> {
  const license = getCachedLicense();
  if (!license) throw new Error("Not authenticated");

  let uploaded = 0;
  let downloaded = 0;
  let skipped = 0;

  const localFiles = scanChildFiles(childId);
  let cloudFiles: SyncFileEntry[] = [];

  try {
    cloudFiles = await getCloudStatus(childId);
  } catch {
    // Cloud might be unreachable; just upload all local files
    for (const lf of localFiles) {
      try {
        await uploadFile(childId, lf.path, fs.readFileSync(path.join(getChildDir(childId), lf.path)));
        uploaded++;
      } catch { /* skip failures */ }
    }
    return { uploaded, downloaded, skipped };
  }

  const cloudMap = new Map(cloudFiles.map((f) => [f.path, f]));

  // Process local files
  for (const lf of localFiles) {
    const cloud = cloudMap.get(lf.path);
    if (!cloud) {
      // Only local: upload
      try {
        await uploadFile(childId, lf.path, fs.readFileSync(path.join(getChildDir(childId), lf.path)));
        uploaded++;
      } catch { skipped++; }
    } else if (lf.hash !== cloud.hash) {
      // Hash differs: last-write-wins
      const cloudTime = new Date(cloud.updated_at).getTime();
      if (lf.mtimeMs > cloudTime) {
        // Local is newer: upload
        try {
          await uploadFile(childId, lf.path, fs.readFileSync(path.join(getChildDir(childId), lf.path)));
          uploaded++;
        } catch { skipped++; }
      } else {
        // Cloud is newer: download
        try {
          const content = await downloadFile(childId, lf.path);
          const destPath = path.join(getChildDir(childId), lf.path);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.writeFileSync(destPath, content);
          downloaded++;
        } catch { skipped++; }
      }
    } else {
      skipped++;
    }
    cloudMap.delete(lf.path);
  }

  // Remaining cloud files: only on cloud, download them
  for (const [fp] of cloudMap) {
    try {
      const content = await downloadFile(childId, fp);
      const destPath = path.join(getChildDir(childId), fp);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, content);
      downloaded++;
    } catch { /* skip */ }
  }

  return { uploaded, downloaded, skipped };
}

/**
 * App 启动时：同步所有孩子数据
 */
export async function syncAllChildren(): Promise<Record<string, { uploaded: number; downloaded: number; skipped: number }>> {
  const { listChildren } = await import("./child-auth");
  const children = listChildren();
  const results: Record<string, any> = {};

  for (const child of children) {
    try {
      results[child.childId] = await syncChild(child.childId);
    } catch (e) {
      results[child.childId] = { error: (e as Error).message };
    }
  }
  return results;
}

/**
 * 学习会话结束后：上传单个孩子的变更文件
 */
export async function pushChildChanges(childId: string): Promise<{ uploaded: number }> {
  const result = await syncChild(childId);
  return { uploaded: result.uploaded };
}

/**
 * 制作全量快照（每天首次同步时调用）
 */
export async function fullSnapshot(childId: string): Promise<{ uploaded: number }> {
  const localFiles = scanChildFiles(childId);
  let uploaded = 0;

  for (const lf of localFiles) {
    try {
      await uploadFile(childId, lf.path, fs.readFileSync(path.join(getChildDir(childId), lf.path)));
      uploaded++;
    } catch { /* skip */ }
  }
  return { uploaded };
}
