/**
 * agent 模型运行时（共享内核 · 服务端形态）。
 * 2026-09-12 P0：自 server/src/worker/runtime.ts 迁入（原「方案B 阶段②」），成为服务端
 * 唯一的模型运行时入口；P1 起交互会话与无头 worker 共用同一运行时（同进程内按 parentId 缓存）。
 * - 凭据：按家长从服务端密钥（settings "auth"，静态加密存储）解密后落盘临时 auth 文件，
 *   经 ModelRuntime.create({ authPath }) 注入（复用 SDK 的凭据读取路径，不走客户端 auth.json）。
 * - 模型：按渠道（app_settings.modelChannel：builtin=内置 TokenHub / custom=自定义 / off=停用）
 *   在渠道池内解析家长 defaultModel，否则兜底 tokenhub/deepseek/deepseek-flash（ISSUE-174）。
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import {
  registerProviders,
  WORKER_DEFAULT_PROVIDER,
  WORKER_DEFAULT_MODEL,
  TOKENHUB_PROVIDER_ID,
  PROVIDER_REGISTRATIONS,
  listProviderModels,
} from "./providers.js";

// 把 provider 表与模型枚举一并对外暴露（薄客户端「模型列表」路由用 listProviderModels）。
export * from "./providers.js";

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

/** 解析 "provider/modelId"（无 "/" 时整串视为 modelId、归默认 provider）。 */
function parseModelKey(key: string): { provider: string; modelId: string } | null {
  const sep = key.indexOf("/");
  return sep > 0
    ? { provider: key.slice(0, sep), modelId: key.slice(sep + 1) }
    : { provider: "", modelId: key };
}

function hasProviderKey(auth: Record<string, unknown> | undefined, provider: string): boolean {
  if (!auth) return false;
  const seg = (auth as Record<string, Record<string, unknown>>)?.[provider];
  return !!(seg && typeof seg === "object" && typeof seg.key === "string" && seg.key.trim());
}

/**
 * 模型渠道（家长三态开关，存 app_settings.modelChannel）：
 *  - "builtin"（默认）：只用内置 TokenHub 模型（每家长一把托管 Key，无需配置）；
 *  - "custom"：只用自定义 provider 模型（需已配 Key），内置模型停用；
 *  - "off"：AI 模型整体停用（内置/自定义都关）。
 * 两处设置页开关镜像同一状态：开内置 → 自动关自定义；开自定义 → 自动关内置（用户 2026-10-10 拍板）。
 */
export type ModelChannel = "builtin" | "custom" | "off";

export function resolveModelChannel(appSettings?: Record<string, unknown>): ModelChannel {
  const v = appSettings?.modelChannel;
  return v === "custom" || v === "off" ? v : "builtin";
}

/**
 * 解析用户配置的模型键（渠道感知版）：channel=builtin 时仅 tokenhub 生效；channel=custom 时
 * 仅「已配 Key 的自定义 provider」生效（tokenhub 视为已停用）；channel=off 一律 null。
 */
export function resolveConfiguredModelKey(
  key: string | undefined,
  auth?: Record<string, unknown>,
  channel: ModelChannel = "builtin"
): { provider: string; modelId: string } | null {
  if (!key || channel === "off") return null;
  const parsed = parseModelKey(key);
  if (!parsed?.provider || !parsed.modelId) return null;
  if (parsed.provider === TOKENHUB_PROVIDER_ID) {
    return channel === "builtin" ? parsed : null;
  }
  // 自定义模型仅在 custom 渠道生效（互斥：builtin/off 渠道一律忽略，即使 Key 已配置）
  return channel === "custom" && hasProviderKey(auth, parsed.provider) ? parsed : null;
}

/**
 * 自定义渠道兜底：按内置注册表顺序找第一个「已配 Key 且有可用模型」的自定义 provider，
 * 返回其第一个（可选按输入模态过滤，如 image=视觉）模型。找不到返回 null。
 */
export function firstCustomModelKey(
  auth?: Record<string, unknown>,
  opts?: { input?: string }
): { provider: string; modelId: string } | null {
  const models = listProviderModels();
  for (const [pid] of PROVIDER_REGISTRATIONS) {
    if (pid === TOKENHUB_PROVIDER_ID) continue;
    if (!hasProviderKey(auth, pid)) continue;
    const m = models.find(
      (mm) => mm.provider === pid && (!opts?.input || (mm.input || []).includes(opts.input))
    );
    if (m) return { provider: pid, modelId: m.id };
  }
  return null;
}

/**
 * 选择 worker 模型（渠道感知）：优先级 = 渠道池内的用户 defaultModel（tokenhub 恒可用 /
 * 自定义 provider 需已配 Key）→ 管理端系统默认 → 渠道兜底。
 * builtin：兜底 = 内置 TokenHub 常量；custom：兜底 = 第一个已配 Key 的自定义 provider 首模型；
 * off / custom 无可用模型：抛错（调用方按「本轮不可用」上抛，孩子端得到可读提示）。
 */
export function pickWorkerModel(
  runtime: ModelRuntime,
  appSettings?: Record<string, unknown>,
  auth?: Record<string, unknown>,
  systemDefault?: string
): any {
  const channel = resolveModelChannel(appSettings);
  if (channel === "off") {
    throw new Error("AI 模型已被停用（家长设置 → AI模型）：如需使用请重新启用内置 AI 模型。");
  }
  const key = typeof appSettings?.defaultModel === "string" ? appSettings.defaultModel : "";
  const user = resolveConfiguredModelKey(key, auth, channel);
  if (user) {
    const m = runtime.getModel(user.provider, user.modelId);
    if (m) return m;
  }
  const sys = resolveConfiguredModelKey(systemDefault, auth, channel);
  if (sys) {
    const m = runtime.getModel(sys.provider, sys.modelId);
    if (m) return m;
  }
  if (channel === "custom") {
    const fb = firstCustomModelKey(auth);
    if (fb) {
      const m = runtime.getModel(fb.provider, fb.modelId);
      if (m) return m;
    }
    throw new Error("自定义模型未配置可用模型（家长设置 → 自定义模型：录入 API Key 后启用）。");
  }
  return runtime.getModel(WORKER_DEFAULT_PROVIDER, WORKER_DEFAULT_MODEL);
}

/** 识图默认模型（家长 agent 读教材扫描页/截图用；ISSUE-174 起 = TokenHub 视觉模型）。 */
export const VISION_DEFAULT_MODEL = "deepseek/deepseek-v4-flash-vision-exp";

/**
 * 选择视觉模型（渠道感知，规则同 pickWorkerModel）：custom 渠道兜底找第一个支持 image 输入的
 * 自定义模型。off / custom 无可用视觉模型：抛错（识图请求按「本轮不可用」上抛）。
 */
export function pickVisionModel(
  runtime: ModelRuntime,
  appSettings?: Record<string, unknown>,
  auth?: Record<string, unknown>,
  systemDefault?: string
): any {
  const channel = resolveModelChannel(appSettings);
  if (channel === "off") {
    throw new Error("AI 模型已被停用（家长设置 → AI模型）：如需使用请重新启用内置 AI 模型。");
  }
  const key = typeof appSettings?.visionModel === "string" ? appSettings.visionModel : "";
  const user = resolveConfiguredModelKey(key, auth, channel);
  if (user) {
    const m = runtime.getModel(user.provider, user.modelId);
    if (m) return m;
  }
  const sys = resolveConfiguredModelKey(systemDefault, auth, channel);
  if (sys) {
    const m = runtime.getModel(sys.provider, sys.modelId);
    if (m) return m;
  }
  if (channel === "custom") {
    const fb = firstCustomModelKey(auth, { input: "image" });
    if (fb) {
      const m = runtime.getModel(fb.provider, fb.modelId);
      if (m) return m;
    }
    throw new Error("自定义模型未配置可用的视觉模型（家长设置 → 自定义模型 → 视觉）。");
  }
  return runtime.getModel(WORKER_DEFAULT_PROVIDER, VISION_DEFAULT_MODEL);
}
