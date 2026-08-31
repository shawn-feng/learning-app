/**
 * 服务端无头 worker 的模型运行时（方案B 阶段②）。
 * - 凭据：按家长从服务端密钥（settings "auth"，静态加密存储）解密后落盘临时 auth 文件，
 *   经 ModelRuntime.create({ authPath }) 注入（复用 SDK 的凭据读取路径，不走客户端 auth.json）。
 * - 模型：优先家长 app_settings.defaultModel（"provider/modelId"），否则兜底 qwen-tokenplan/deepseek-v4-flash-0731。
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { registerProviders, WORKER_DEFAULT_PROVIDER, WORKER_DEFAULT_MODEL } from "./providers.js";

const cacheKey = "__learningServerWorkerRuntime";

/** 按家长写临时 auth 文件（返回路径）。 */
export function writeParentAuthFile(
  dataDir: string,
  parentId: string,
  auth: Record<string, unknown>
): string {
  const dir = path.join(dataDir, ".worker", "auth");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${parentId}.json`);
  fs.writeFileSync(p, JSON.stringify(auth ?? {}, null, 2), "utf-8");
  return p;
}

export async function getWorkerRuntime(
  dataDir: string,
  parentId: string,
  auth: Record<string, unknown>
): Promise<ModelRuntime> {
  const authPath = writeParentAuthFile(dataDir, parentId, auth);
  const g = globalThis as any;
  const key = `${cacheKey}:${parentId}`;
  const existing = g[key];
  if (existing && existing.authPath === authPath) return existing.runtime;
  if (existing?.runtime?.dispose) {
    try {
      existing.runtime.dispose();
    } catch {
      /* 忽略 */
    }
  }
  const runtime = await ModelRuntime.create({ authPath });
  registerProviders(runtime);
  g[key] = { runtime, authPath };
  return runtime;
}

/** 选择 worker 模型：优先 app_settings.defaultModel，否则兜底默认。 */
export function pickWorkerModel(
  runtime: ModelRuntime,
  appSettings?: Record<string, unknown>
): any {
  const key = typeof appSettings?.defaultModel === "string" ? appSettings.defaultModel : "";
  if (key) {
    const sep = key.indexOf("/");
    const provider = sep > 0 ? key.slice(0, sep) : key;
    const modelId = sep > 0 ? key.slice(sep + 1) : "";
    if (provider && modelId) {
      const m = runtime.getModel(provider, modelId);
      if (m) return m;
    }
  }
  return runtime.getModel(WORKER_DEFAULT_PROVIDER, WORKER_DEFAULT_MODEL);
}
