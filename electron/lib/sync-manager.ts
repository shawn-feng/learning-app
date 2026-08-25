import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getCloudApiBase } from "./config";
import { getCachedLicense } from "./auth-manager";
import { cloudFetch } from "./cloud-net";

// ISSUE-041 架构转向（2026-08-25）：云端不再做整库同步/数据存储，
// 只做「消息交换」（sync_deliveries 分配包 + sync_progress 进度摘要，见 delivery.ts）。
// 本文件保留纯工具函数（扫描/哈希/并发池/云端 HTTP 封装），供 delivery.ts 与单测复用。

export interface LocalFileMeta {
  path: string;
  size: number;
  mtimeMs: number;
}

/** 每扫描多少个文件让出一次事件循环，避免长时间独占主进程（ISSUE-011） */
const SCAN_YIELD_EVERY = 20;

/**
 * 递归扫描目录，返回所有文件的 {path, size, mtimeMs}（**不读内容、不哈希**）。
 *
 * ISSUE-011 修复要点：
 * - 全部走 `fs.promises` 异步 API，不再用 readFileSync/statSync 同步阻塞；
 * - 每 SCAN_YIELD_EVERY 个文件 `setImmediate` 让出事件循环；
 * - 哈希由调用方按需计算（size 预过滤），避免全量读+哈希。
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
      return; // 目录不存在或不可读：整目录跳过
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
          // 单个文件 stat 失败：跳过，不影响其余文件
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

/** 流式 sha256 哈希（大文件不占内存）。 */
export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** 简易并发池：最多 limit 个任务同时执行，保持输入顺序。 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

/** 云端 HTTP 调用（统一走 Chromium 网络栈 + 家长 token；未登录抛错）。 */
export async function apiCall(endpoint: string, options: RequestInit = {}): Promise<any> {
  const license = getCachedLicense();
  if (!license) throw new Error("Not authenticated");
  const url = `${getCloudApiBase()}${endpoint}`;
  const res = await cloudFetch(url, {
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
