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

interface LocalFileMeta {
  path: string;
  size: number;
  mtimeMs: number;
}

/** 每扫描多少个文件让出一次事件循环，避免长时间独占主进程（ISSUE-011） */
const SCAN_YIELD_EVERY = 20;
/** 流式哈希 / 上传的并发路数 */
const CONCURRENCY = 8;

/**
 * 递归扫描目录，返回所有文件的 {path, size, mtimeMs}（**不读内容、不哈希**）。
 *
 * ISSUE-011 修复要点：
 * - 全部走 `fs.promises` 异步 API，不再用 readFileSync/statSync 同步阻塞；
 * - 每 SCAN_YIELD_EVERY 个文件 `setImmediate` 让出事件循环，
 *   使 node-cron tick / IPC / 窗口事件能够插队执行；
 * - 哈希由调用方按需计算（见 syncChild 的 size 预过滤），避免全量读+哈希。
 *
 * @param rootDir 要扫描的根目录（生产为 getChildDir(childId)，测试可传临时目录）
 * @param excludeDirs 需跳过的子目录名（默认 .pi，不同步 agent 会话）
 */
export async function scanDirectory(
  rootDir: string,
  excludeDirs: string[] = [".pi"]
): Promise<LocalFileMeta[]> {
  const results: LocalFileMeta[] = [];
  const excluded = new Set(excludeDirs);

  async function walk(dir: string, relativeTo: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      // 目录不存在或不可读：整目录跳过（原同步版会抛错中断整个扫描，这里降级为跳过）
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") && excluded.has(entry.name)) continue;
        await walk(fullPath, relativeTo);
      } else {
        const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, "/");
        try {
          const stat = await fs.promises.stat(fullPath);
          if (!stat.isFile()) continue;
          results.push({ path: relPath, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // 单个文件 stat 失败（如被占用/已删除）：跳过，不影响其余文件
        }
      }
      if (results.length % SCAN_YIELD_EVERY === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
    }
  }

  await walk(rootDir, rootDir);
  return results;
}

/**
 * 扫描孩子数据目录（内部实现见 scanDirectory，生产入口保持同步返回 Promise）。
 */
function scanChildFiles(childId: string): Promise<LocalFileMeta[]> {
  return scanDirectory(getChildDir(childId));
}

/** 流式 sha256 哈希：createReadStream 管道，天然异步、大文件不整篇入内存 */
export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** 简易并发池：最多 limit 个任务同时执行，保持输入顺序 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
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

/** 云不可达时的降级：并发上传全部本地文件 */
async function uploadAllLocal(childId: string, localFiles: LocalFileMeta[]): Promise<number> {
  const childDir = getChildDir(childId);
  let uploaded = 0;
  await mapLimit(localFiles, CONCURRENCY, async (lf) => {
    try {
      const content = await fs.promises.readFile(path.join(childDir, lf.path));
      await uploadFile(childId, lf.path, content);
      uploaded++; // 单线程 JS，无 await 打断，自增安全
    } catch {
      /* skip failures */
    }
  });
  return uploaded;
}

/**
 * 同步单个孩子数据：双向同步 + last-write-wins 冲突处理
 *
 * - 本地较新 → 上传
 * - 云端较新 → 下载
 * - 仅本地有 → 上传
 * - 仅云端有 → 下载
 * - size 与 hash 均相同 → 跳过
 *
 * ISSUE-011 优化：本地扫描只取 size/mtime（不哈希）；
 * 只有「云端存在且 size 相同」的文件才需要流式哈希比对，
 * size 不同直接判定为变更走 last-write-wins，哈希次数大幅减少。
 */
export async function syncChild(childId: string): Promise<{ uploaded: number; downloaded: number; skipped: number }> {
  const license = getCachedLicense();
  if (!license) throw new Error("Not authenticated");

  let uploaded = 0;
  let downloaded = 0;
  let skipped = 0;

  const localFiles = await scanChildFiles(childId);
  let cloudFiles: SyncFileEntry[] = [];

  try {
    cloudFiles = await getCloudStatus(childId);
  } catch {
    // Cloud might be unreachable; just upload all local files
    uploaded = await uploadAllLocal(childId, localFiles);
    return { uploaded, downloaded, skipped };
  }

  const cloudMap = new Map(cloudFiles.map((f) => [f.path, f]));
  const childDir = getChildDir(childId);

  // 预过滤：只需对「云端存在且 size 相同」的本地文件算哈希
  const needHash: Array<{ lf: LocalFileMeta; cloud: SyncFileEntry }> = [];
  for (const lf of localFiles) {
    const cloud = cloudMap.get(lf.path);
    if (cloud && cloud.size === lf.size) needHash.push({ lf, cloud });
  }
  const localHashByPath = new Map<string, string>();
  if (needHash.length > 0) {
    const hashes = await mapLimit(needHash, CONCURRENCY, async ({ lf }) => {
      try {
        return { path: lf.path, hash: await hashFile(path.join(childDir, lf.path)) };
      } catch {
        return { path: lf.path, hash: "" }; // 哈希失败按「不同」处理，走 last-write-wins
      }
    });
    for (const h of hashes) localHashByPath.set(h.path, h.hash);
  }

  // Process local files
  for (const lf of localFiles) {
    const cloud = cloudMap.get(lf.path);
    const absPath = path.join(childDir, lf.path);
    if (!cloud) {
      // Only local: upload
      try {
        await uploadFile(childId, lf.path, await fs.promises.readFile(absPath));
        uploaded++;
      } catch { skipped++; }
    } else {
      const sameContent = cloud.size === lf.size && localHashByPath.get(lf.path) === cloud.hash;
      if (!sameContent) {
        // size/hash 不同：last-write-wins
        const cloudTime = new Date(cloud.updated_at).getTime();
        if (lf.mtimeMs > cloudTime) {
          // Local is newer: upload
          try {
            await uploadFile(childId, lf.path, await fs.promises.readFile(absPath));
            uploaded++;
          } catch { skipped++; }
        } else {
          // Cloud is newer: download
          try {
            const content = await downloadFile(childId, lf.path);
            await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
            await fs.promises.writeFile(absPath, content);
            downloaded++;
          } catch { skipped++; }
        }
      } else {
        skipped++;
      }
    }
    cloudMap.delete(lf.path);
  }

  // Remaining cloud files: only on cloud, download them
  for (const [fp] of cloudMap) {
    try {
      const content = await downloadFile(childId, fp);
      const destPath = path.join(childDir, fp);
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.writeFile(destPath, content);
      downloaded++;
    } catch { /* skip */ }
  }

  return { uploaded, downloaded, skipped };
}

/**
 * App 启动时：同步所有孩子数据（孩子间并行）
 */
export async function syncAllChildren(): Promise<Record<string, { uploaded: number; downloaded: number; skipped: number }>> {
  const { listChildren } = await import("./child-auth");
  const children = listChildren();
  const entries = await Promise.all(
    children.map(async (child) => {
      try {
        return [child.childId, await syncChild(child.childId)] as const;
      } catch (e) {
        return [child.childId, { error: (e as Error).message }] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}

/**
 * 学习会话结束后：上传单个孩子的变更文件
 */
export async function pushChildChanges(childId: string): Promise<{ uploaded: number }> {
  const result = await syncChild(childId);
  return { uploaded: result.uploaded };
}

/**
 * 制作全量快照（每天首次同步时调用）：并发上传全部本地文件
 */
export async function fullSnapshot(childId: string): Promise<{ uploaded: number }> {
  const localFiles = await scanChildFiles(childId);
  const uploaded = await uploadAllLocal(childId, localFiles);
  return { uploaded };
}
