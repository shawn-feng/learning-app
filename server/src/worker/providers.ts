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

const QWEN_PROVIDER: ProviderConfig = {
  name: "通义千问 (Qwen) · 按量付费",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  api: "openai-completions",
  models: [...QWEN_MODELS, ...QWEN_VL_MODELS, ...QWEN_DEEPSEEK_MODELS],
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

export function registerProviders(runtime: ModelRuntime): void {
  const registrations: Array<[string, ProviderConfig]> = [
    ["qwen", QWEN_PROVIDER],
    ["qwen-tokenplan", QWEN_TOKENPLAN_PROVIDER],
    ["minimax", MINIMAX_PROVIDER],
    ["mimo", MIMO_PROVIDER],
    ["mimo-tokenplan", MIMO_TOKENPLAN_PROVIDER],
  ];
  for (const [id, cfg] of registrations) {
    try {
      runtime.registerProvider(id, cfg);
    } catch (err) {
      console.error(`[worker] register provider ${id} failed:`, (err as Error).message);
    }
  }
}

/** 兜底默认模型（与客户端一致：token-plan 套餐内的 deepseek flash 定点快照）。 */
export const WORKER_DEFAULT_PROVIDER = "qwen-tokenplan";
export const WORKER_DEFAULT_MODEL = "deepseek-v4-flash-0731";
