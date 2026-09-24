/**
 * 服务端无头 worker 的模型 provider 配置（方案B 阶段②）。
 * 平移自 electron/lib/pi-runtime.ts（保持模型清单/端点/兼容参数一致；改动时两端同步）。
 * 凭据不走 auth.json：由 worker/runtime.ts 按家长从服务端密钥落盘临时 auth 文件注入。
 */
import type { ModelRuntime, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const QWEN_MODELS: ProviderModelConfig[] = [
  {
    id: "qwen-max",
    name: "通义千问 Max",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 65536,
    compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
    thinkingLevelMap: { off: null },
  },
  {
    id: "qwen-plus",
    name: "通义千问 Plus",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 32768,
    compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
    thinkingLevelMap: { off: null },
  },
  {
    id: "qwen-flash",
    name: "通义千问 Flash",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 16384,
    compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
    thinkingLevelMap: { off: null },
  },
];

const QWEN_DEEPSEEK_MODELS: ProviderModelConfig[] = [
  {
    id: "deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash 0731 (百炼)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: {
      thinkingFormat: "deepseek",
      supportsDeveloperRole: false,
      requiresReasoningContentOnAssistantMessages: true,
    },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro (百炼)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: {
      thinkingFormat: "deepseek",
      supportsDeveloperRole: false,
      requiresReasoningContentOnAssistantMessages: true,
    },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
  {
    id: "deepseek-v4-pro-0813",
    name: "DeepSeek V4 Pro 0813 (百炼)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: {
      thinkingFormat: "deepseek",
      supportsDeveloperRole: false,
      requiresReasoningContentOnAssistantMessages: true,
    },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
];

// ==================== DeepSeek 官方平台（platform.deepseek.com）====================
// 注意与上面「百炼渠道的 DeepSeek V4 系」区分：百炼模型用阿里云 key（qwen/qwen-tokenplan），
// 本 provider 用 DeepSeek 官方平台的 key（auth.deepseek）。

const DEEPSEEK_OFFICIAL_MODELS: ProviderModelConfig[] = [
  {
    id: "deepseek-flash",
    name: "DeepSeek Flash (官方)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: {
      thinkingFormat: "deepseek",
      supportsDeveloperRole: false,
      requiresReasoningContentOnAssistantMessages: true,
    },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro (官方)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 65536,
    compat: {
      thinkingFormat: "deepseek",
      supportsDeveloperRole: false,
      requiresReasoningContentOnAssistantMessages: true,
    },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
];

const DEEPSEEK_PROVIDER: ProviderConfig = {
  name: "DeepSeek · 官方平台",
  baseUrl: "https://api.deepseek.com/v1",
  api: "openai-completions",
  models: DEEPSEEK_OFFICIAL_MODELS,
};

const QWEN_VL_MODELS: ProviderModelConfig[] = [
  {
    id: "qwen3-vl-flash",
    name: "通义千问 VL Flash (视觉)",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256000,
    maxTokens: 8192,
    compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
    thinkingLevelMap: { off: null },
  },
  {
    id: "qwen3-vl-plus",
    name: "通义千问 VL Plus (视觉)",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256000,
    maxTokens: 8192,
    compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
    thinkingLevelMap: { off: null },
  },
];

const QWEN_PROVIDER: ProviderConfig & { embedding?: ProviderEmbeddingCapability } = {
  name: "通义千问 (Qwen) · 按量付费",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  api: "openai-completions",
  models: [...QWEN_MODELS, ...QWEN_VL_MODELS, ...QWEN_DEEPSEEK_MODELS],
  // 内置向量化模型（ISSUE-111）：端点 = baseUrl + /embeddings（OpenAI 兼容），用户零配置
  embedding: { model: "text-embedding-v4", dimensions: 1024 },
};

const QWEN_TOKENPLAN_PROVIDER: ProviderConfig = {
  name: "通义千问 (Qwen) · token-plan 套餐",
  baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  api: "openai-completions",
  models: [...QWEN_DEEPSEEK_MODELS, ...QWEN_VL_MODELS],
};

const MINIMAX_MODELS: ProviderModelConfig[] = [
  { id: "MiniMax-M3", name: "MiniMax M3 (1M 上下文)", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 16384 },
  { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 HighSpeed", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204800, maxTokens: 8192 },
  { id: "MiniMax-M2.7", name: "MiniMax M2.7", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204800, maxTokens: 8192 },
  { id: "MiniMax-M2.5-highspeed", name: "MiniMax M2.5 HighSpeed", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204800, maxTokens: 8192 },
  { id: "MiniMax-M2.5", name: "MiniMax M2.5", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204800, maxTokens: 8192 },
  { id: "MiniMax-M2.1-highspeed", name: "MiniMax M2.1 HighSpeed", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204800, maxTokens: 8192 },
  { id: "MiniMax-M2.1", name: "MiniMax M2.1", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204800, maxTokens: 8192 },
];

const MINIMAX_PROVIDER: ProviderConfig = {
  name: "MiniMax (国内)",
  baseUrl: "https://api.minimaxi.com/v1",
  api: "openai-completions",
  models: MINIMAX_MODELS,
};

// ==================== 魔芋AI（大模型聚合平台，OpenAI 兼容中转） ====================
// 接入要点：控制台「令牌管理」创建 sk- 令牌；Base URL 为 https://www.moyu.info/v1
// （官网 www.moyu.cn 的 /docs 页需登录后才可见，公开教程均以 moyu.info/v1 为准）。
// 平台聚合 200+ 模型，此处只登记已确认的常用起步清单；模型 ID 以平台「模型广场」为准，
// 后续要加新模型直接往 MOYU_MODELS 里补即可（同渠道不同模型 ID 大小写敏感）。

const MOYU_MODELS: ProviderModelConfig[] = [
  {
    id: "DeepSeek-V4.1-flash",
    name: "DeepSeek V4.1 Flash (魔芋)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: {
      thinkingFormat: "deepseek",
      supportsDeveloperRole: false,
      requiresReasoningContentOnAssistantMessages: true,
    },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
  {
    id: "glm-5.3",
    name: "GLM-5.3 (魔芋)",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "gpt-4o",
    name: "GPT-4o (魔芋)",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  },
];

const MOYU_PROVIDER: ProviderConfig = {
  name: "魔芋AI (聚合平台)",
  baseUrl: "https://www.moyu.info/v1",
  api: "openai-completions",
  models: MOYU_MODELS,
};

const MIMO_MODELS: ProviderModelConfig[] = [
  {
    id: "mimo-v2.5-pro",
    name: "小米 MiMo V2.5 Pro (旗舰)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 65536,
    compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
  {
    id: "mimo-v2.5",
    name: "小米 MiMo V2.5 (全模态)",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 65536,
    compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
];

const MIMO_PROVIDER: ProviderConfig = {
  name: "小米 MiMo (按量付费)",
  baseUrl: "https://api.xiaomimimo.com/v1",
  api: "openai-completions",
  models: MIMO_MODELS,
};

const MIMO_TOKENPLAN_PROVIDER: ProviderConfig = {
  name: "小米 MiMo · token-plan 套餐",
  baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
  api: "openai-completions",
  models: MIMO_MODELS,
};

/** 服务端 provider 注册表（国内 provider；与客户端白名单一致，无国外 provider）。 */
/** provider 内置向量化能力声明（ISSUE-111）：声明的厂商由数据通道自动用于「精确匹配落空 → 向量检索兜底」，
 *  用户零配置（复用该 provider 已配置的 API key）；未声明的厂商 = 不支持，设置页据此提示。 */
export interface ProviderEmbeddingCapability {
  /** 内置 embedding 模型名（如 text-embedding-v4） */
  model: string;
  /** 向量维度（缺省 1024）；实际以 API 返回为准并记入旁表 */
  dimensions?: number;
}

type AugProviderConfig = ProviderConfig & { embedding?: ProviderEmbeddingCapability };

export const PROVIDER_REGISTRATIONS: Array<[string, AugProviderConfig]> = [
  ["qwen", QWEN_PROVIDER],
  ["qwen-tokenplan", QWEN_TOKENPLAN_PROVIDER],
  ["deepseek", DEEPSEEK_PROVIDER],
  ["moyu", MOYU_PROVIDER],
  ["minimax", MINIMAX_PROVIDER],
  ["mimo", MIMO_PROVIDER],
  ["mimo-tokenplan", MIMO_TOKENPLAN_PROVIDER],
];

export function registerProviders(runtime: ModelRuntime): void {
  for (const [id, cfg] of PROVIDER_REGISTRATIONS) {
    try {
      runtime.registerProvider(id, cfg);
    } catch (err) {
      console.error(`[worker] register provider ${id} failed:`, (err as Error).message);
    }
  }
}

/**
 * 静态枚举可用模型（薄客户端「模型列表」用）：不依赖 ModelRuntime（无需 auth），
 * 直接从 provider 配置表展开——与客户端 getAvailableModels 的输出形状一致
 * （{ provider, id, name, input }），供设置页下拉与视觉模型过滤。
 */
export function listProviderModels(): Array<{ provider: string; id: string; name: string; input: string[] }> {
  const out: Array<{ provider: string; id: string; name: string; input: string[] }> = [];
  for (const [pid, cfg] of PROVIDER_REGISTRATIONS) {
    for (const m of cfg.models ?? []) {
      out.push({ provider: pid, id: m.id, name: m.name || m.id, input: m.input ?? [] });
    }
  }
  return out;
}

/** 读取某 provider 的内置向量化能力；未声明 = 不支持（undefined）。 */
export function getProviderEmbedding(providerId: string): ProviderEmbeddingCapability | undefined {
  return PROVIDER_REGISTRATIONS.find(([pid]) => pid === providerId)?.[1]?.embedding;
}

/** 支持 embedding 的 provider id（按解析优先级排序）。 */
export const EMBEDDING_PROVIDER_PRIORITY = ["qwen"];

/** 兜底默认模型（与客户端一致：token-plan 套餐内的 deepseek flash 定点快照）。 */
export const WORKER_DEFAULT_PROVIDER = "qwen-tokenplan";
export const WORKER_DEFAULT_MODEL = "deepseek-v4-flash-0731";
