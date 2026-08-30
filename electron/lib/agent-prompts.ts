/**
 * AGENTS / 系统提示词「用户可编辑版本」存储（ISSUE-033 + SPLIT M8-B 纯服务端模式）。
 *
 * SPLIT 后唯一真源在**服务端 agents 库**（prompts / prompt_history），客户端不持有业务库：
 *   - `getAgentPrompt` **同步读本地缓存**（会话构建是同步链，不阻塞网络）；缓存缺失 → null（调用方回退代码默认）。
 *   - `saveAgentPrompt` / `listAgentPromptHistory` / `restoreAgentPromptVersion` **异步走服务端 RPC**，
 *     保存/回退成功后同步更新本地缓存（本设备立即生效）。
 *   - 跨设备一致性：家长在 A 设备编辑后，B 设备经配置轮询期内的保存操作或登录预热刷新缓存；
 *     首次会话（本地无缓存）回退代码默认——已知限制。
 * 缓存文件：data/cache/agents-cache.json（{ "<scope>:<ref>": { content, updated } }）。
 */
import fs from "fs";
import path from "path";
import { getDataDir, getCurrentParentId } from "./config";
import { dbExec, dbQuery } from "./client-data";

export interface PromptVersion {
  content: string;
  updated: string;
}

type AgentsCache = Record<string, { content: string; updated: string }>;

function cachePath(): string {
  return path.join(getDataDir(), "cache", "agents-cache.json");
}

function cacheKey(scope: string, ref: string): string {
  return `${scope}:${ref}`;
}

function readCache(): AgentsCache {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), "utf-8")) as AgentsCache;
  } catch {
    return {};
  }
}

function writeCache(cache: AgentsCache): void {
  fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
  fs.writeFileSync(cachePath(), JSON.stringify(cache, null, 2), "utf-8");
}

/** 读取当前用户版本（同步，读本地缓存）；无用户版本返回 null（调用方回退代码默认）。 */
export function getAgentPrompt(scope: string, ref: string): string | null {
  const v = readCache()[cacheKey(scope, ref)];
  return v && v.content.trim() ? v.content : null;
}

/**
 * 远程取用户版本（会话创建前预取 / 编辑器实时读）：先调服务端 agents.get，
 * 成功则更新本地缓存并返回内容；服务端不可达/未登录回退本地缓存（离线降级）。
 */
export async function fetchAgentPromptRemote(scope: string, ref: string): Promise<string | null> {
  try {
    const data = await dbQuery<{ content: string | null }>("agents.get", { scope, ref });
    const cache = readCache();
    if (data.content && data.content.trim()) {
      cache[cacheKey(scope, ref)] = { content: data.content, updated: new Date().toISOString() };
      writeCache(cache);
      return data.content;
    }
    delete cache[cacheKey(scope, ref)];
    writeCache(cache);
    return null;
  } catch {
    return getAgentPrompt(scope, ref);
  }
}

/**
 * 保存用户版本（整体替换）。空内容 = 恢复默认（服务端删当前行、保留历史）。
 * 成功后更新本地缓存（本设备立即生效）。
 */
export async function saveAgentPrompt(scope: string, ref: string, content: string): Promise<void> {
  await dbExec("agents.save", { scope, ref, content });
  const cache = readCache();
  const trimmed = content.trim();
  if (trimmed) {
    cache[cacheKey(scope, ref)] = { content, updated: new Date().toISOString() };
  } else {
    delete cache[cacheKey(scope, ref)];
  }
  writeCache(cache);
}

/** 恢复默认：删除当前用户版本（历史保留，可回退）。 */
export async function resetAgentPrompt(scope: string, ref: string): Promise<void> {
  await saveAgentPrompt(scope, ref, "");
}

/** 历史版本（服务端按时间倒序，最新在前，最多 50 条）。 */
export async function listAgentPromptHistory(scope: string, ref: string): Promise<PromptVersion[]> {
  return dbQuery<PromptVersion[]>("agents.history", { scope, ref });
}

/** 回退到指定历史版本（按 updated 定位）；成功后刷新本地缓存。 */
export async function restoreAgentPromptVersion(scope: string, ref: string, updated: string): Promise<boolean> {
  const r = await dbExec<{ ok: boolean }>("agents.restore", { scope, ref, updated });
  if (r.ok) {
    try {
      const data = await dbQuery<{ content: string | null }>("agents.get", { scope, ref });
      const cache = readCache();
      if (data.content && data.content.trim()) {
        cache[cacheKey(scope, ref)] = { content: data.content, updated: new Date().toISOString() };
      } else {
        delete cache[cacheKey(scope, ref)];
      }
      writeCache(cache);
    } catch {
      /* 缓存刷新失败不阻断回退结果 */
    }
  }
  return r.ok;
}

/** 登录成功后后台预热：家长侧用户版本拉取到本地缓存（child 版本经 save 时写入）。 */
export async function prefetchAgents(): Promise<void> {
  // 家长提示词按家长隔离（2026-08-30）：ref = 当前家长 id
  const parentRef = getCurrentParentId();
  for (const [scope, ref] of [
    ["parent", parentRef],
  ] as const) {
    try {
      const data = await dbQuery<{ content: string | null }>("agents.get", { scope, ref });
      const cache = readCache();
      if (data.content && data.content.trim()) {
        cache[cacheKey(scope, ref)] = { content: data.content, updated: new Date().toISOString() };
      } else {
        delete cache[cacheKey(scope, ref)];
      }
      writeCache(cache);
    } catch {
      /* 预热失败静默（下次编辑/保存时再更新） */
    }
  }
}
