/**
 * agent 模型运行时（共享内核 · 服务端形态）。
 * 2026-09-12 P0：自 server/src/worker/runtime.ts 迁入（原「方案B 阶段②」），成为服务端
 * 唯一的模型运行时入口；P1 起交互会话与无头 worker 共用同一运行时（同进程内按 parentId 缓存）。
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

/** 识图默认模型（家长 agent 读教材扫描页/截图用；与 provider 表里的 VL 模型一致）。 */
export const VISION_DEFAULT_MODEL = "qwen3-vl-flash";

/**
 * 选择视觉模型：优先 app_settings.visionModel（"provider/modelId"），否则默认 provider + VL 默认模型。
 * 独立于 pickWorkerModel 的原因：家长主会话可能用文本模型，识图要走带 image 输入的模型；
 * 混用会让「描述这张图」这类请求落到不支持图片的模型上而报错。
 */
export function pickVisionModel(
  runtime: ModelRuntime,
  appSettings?: Record<string, unknown>
): any {
  const key = typeof appSettings?.visionModel === "string" ? appSettings.visionModel : "";
  let provider = WORKER_DEFAULT_PROVIDER;
  let modelId = VISION_DEFAULT_MODEL;
  if (key) {
    const sep = key.indexOf("/");
    if (sep > 0) {
      provider = key.slice(0, sep);
      modelId = key.slice(sep + 1);
    } else {
      modelId = key;
    }
  }
  return runtime.getModel(provider, modelId) ?? runtime.getModel(WORKER_DEFAULT_PROVIDER, VISION_DEFAULT_MODEL);
}
